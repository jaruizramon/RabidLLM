#!/usr/bin/env python3
"""V100 model manager — the one thing to start; it owns the model server.

The GPU side is one `llama-server` in *router mode* (started with --models-preset
models.ini).  The router owns loading and unloading: it spawns a child process per
model, and `POST /models/unload` frees that child's VRAM again.  This process starts
that router itself before it announces its URL (--no-start-router opts out), then
serves the UI, proxies those calls, and reports what nvidia-smi sees.

Nothing enters VRAM on its own.  Three separate defaults would each load a model
unasked, and all three are off: `load-on-startup = false` in models.ini (no preload
when the router starts), `--no-models-autoload` on the router command line (a
request naming an unloaded model is refused instead of served by loading it), and
this file never calling /models/load by itself.  `POST /models/load` — what the page
sends when a card is dropped — is the only thing that puts weights on the V100.

This process also owns the server's lifetime: it starts the router, and on
SIGINT/SIGTERM/SIGHUP or exit stops that router again with the INT-first wind-down
this build needs, so a closed terminal frees both the port and the V100.

Nothing here is specific to a model: the presets file is the source of truth for
what can be loaded, and the VRAM cost per model is measured (peak used while it was
the only loaded model) rather than hardcoded.

It also keeps the one thing a prefill cannot replace: a model's context.  A long prompt
costs minutes of wall clock to prefill and is thrown away whenever the weights leave
VRAM, so a slot's KV state is snapshotted to `contexts/` (llama.cpp's own slot
serialisation, enabled by `slot-save-path` in models.ini) whenever a model goes quiet or
an unload is about to happen, and read back the next time that model is loaded.  See the
"context parking" section; policy is in parking.json.
"""

from __future__ import annotations

import argparse
import configparser
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
PRESET = APP_DIR / "models.ini"
CAT_PRESET = APP_DIR / "models-1cat.ini"
STOCK_PRESET = APP_DIR / "models-stock.ini"
LOGS = APP_DIR / "logs"
LOG = LOGS / "router.log"  # llama-server's output, its model children included
STATE = APP_DIR / "state.json"
PIDFILE = APP_DIR / "server.pid"  # the llama-server this manager started

# ~/.local/bin/llama-server pins CUDA_DEVICE_ORDER=PCI_BUS_ID + CUDA_VISIBLE_DEVICES=0
# (the V100) and points LD_LIBRARY_PATH at the prebuilt CUDA 12.8 build.  It is the one
# place GPU policy lives, so drive it rather than the binary directly.
SERVER_WRAPPER = Path.home() / ".local" / "bin" / "llama-server"
SERVER_BINARY = Path.home() / ".local" / "opt" / "llama.cpp" / "llama-server"

# The second engine: 1CatAI's V100 fork of vLLM (github.com/1CatAI/1Cat-vLLM).  A preset
# served by it runs `vllm serve` as a child of this manager instead of as a router child.
# Only one engine owns the front-door port at a time — this is one card, and both engines
# keep weights in VRAM for as long as their process lives — so a preset's `backend` key
# decides which engine the port is handed to.  Clients keep one URL and one model id.
CAT_HOME = Path.home() / ".local" / "opt" / "1cat-vllm"
CAT_VLLM = CAT_HOME / "venv" / "bin" / "vllm"
CAT_LOG = LOGS / "1cat.log"
CAT_PIDFILE = APP_DIR / "1cat.pid"
CAT_MODELFILE = APP_DIR / "1cat.model"  # which preset this engine was asked for
# Same GPU policy as ~/.local/bin/llama-server: PCI ordering makes visible device 0 the
# V100 (01:00.0) rather than the 3070 the default CUDA ordering would pick first.
CAT_ENV = {"CUDA_DEVICE_ORDER": "PCI_BUS_ID", "CUDA_VISIBLE_DEVICES": "0"}

# The third engine: the stock (mainline) llama.cpp build, for architectures the PrismML
# fork predates — spark2_5 today (needs upstream b10828+; the fork is b10709, §27).  A
# preset with `backend = stock` runs llama-server-stock as a single-model server on the
# front-door port instead of as a router child.  Like 1cat, only one engine owns the
# port at a time, and `~/.local/bin/llama-server-stock` pins the V100 the same way
# `~/.local/bin/llama-server` does.
STOCK_WRAPPER = Path.home() / ".local" / "bin" / "llama-server-stock"
STOCK_LOG = LOGS / "stock.log"
STOCK_PIDFILE = APP_DIR / "stock.pid"
STOCK_MODELFILE = APP_DIR / "stock.model"  # which preset this engine was asked for

ACTIVE_STATES = ("loading", "loaded", "sleeping")
_STATE_LOCK = threading.Lock()


# --------------------------------------------------------------------------- utils

def server_cmd() -> str:
    return str(SERVER_WRAPPER if os.access(SERVER_WRAPPER, os.X_OK) else SERVER_BINARY)


def read_state() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {}


def write_state(state: dict) -> None:
    try:
        STATE.write_text(json.dumps(state, indent=2, sort_keys=True))
    except OSError:
        pass


def cmdline(pid: int) -> list[str]:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return []
    return [a for a in raw.decode("utf-8", "replace").split("\0") if a]


def port_pids(port: int) -> list[int]:
    """PIDs owning a LISTEN socket on `port`, via /proc (no lsof/netstat needed)."""
    inodes = set()
    for proc_net in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = Path(proc_net).read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            cols = line.split()
            if len(cols) < 10 or cols[3] != "0A":  # 0A = TCP_LISTEN
                continue
            _, _, local_port = cols[1].partition(":")
            if local_port and int(local_port, 16) == port:
                inodes.add(cols[9])
    if not inodes:
        return []

    pids = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        fd_dir = f"/proc/{entry}/fd"
        try:
            fds = os.listdir(fd_dir)
        except OSError:
            continue
        for fd in fds:
            try:
                link = os.readlink(f"{fd_dir}/{fd}")
            except OSError:
                continue
            if link.startswith("socket:[") and link[8:-1] in inodes:
                pids.append(int(entry))
                break
    return pids


def child_pids(pid: int) -> list[int]:
    kids = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            stat = Path(f"/proc/{entry}/stat").read_text()
        except OSError:
            continue
        # comm may contain spaces/parens; ppid is field 4 after the last ')'
        try:
            ppid = int(stat[stat.rindex(")") + 2:].split()[1])
        except (ValueError, IndexError):
            continue
        if ppid == pid:
            kids.append(int(entry))
    return kids


def signal_tree(pid: int, sig: int) -> None:
    """Signal a process and its direct children (the router's model servers)."""
    for child in child_pids(pid):
        try:
            os.kill(child, sig)
        except OSError:
            pass
    try:
        os.kill(pid, sig)
    except OSError:
        pass


def llama_servers_on(port: int) -> list[tuple[int, list[str]]]:
    out = []
    for pid in port_pids(port):
        argv = cmdline(pid)
        if argv and Path(argv[0]).name.startswith("llama-server"):
            out.append((pid, argv))
    return out


# ----------------------------------------------------------------------- router api

def router_get(path: str, router_port: int, timeout: float = 5.0):
    url = f"http://127.0.0.1:{router_port}{path}"
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.load(resp)


def router_post(path: str, payload: dict, router_port: int, timeout: float = 60.0):
    url = f"http://127.0.0.1:{router_port}{path}"
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"router said {exc.code}: {body[:400]}") from exc


def router_port_open(port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.4)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def router_up(router_port: int) -> bool:
    """True when the port is held by a llama.cpp router — the only mode we run.

    The discriminator is the owning process's argv (only a router is started with
    --models-preset/--models-dir); when /proc gives nothing back, fall back to the
    router-only `status` field on /models.
    """
    if not router_port_open(router_port):
        return False

    servers = llama_servers_on(router_port)
    if servers:
        return any(
            a.split("=", 1)[0] in ("--models-preset", "--models-dir")
            for _, argv in servers
            for a in argv
        )

    try:
        entries = router_get("/models", router_port, timeout=3.0).get("data") or []
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return False
    return bool(entries) and all("status" in entry for entry in entries)


# ------------------------------------------------------------------------ presets

def _parse_preset_file(path: Path, default_backend: str, preserve_case: bool = False) -> dict[str, dict]:
    """One preset file → id -> {path, mmproj, tags, backend, args}."""
    try:
        text = path.read_text()
    except OSError:
        return {}
    # configparser needs the first line to be a section header; the file starts
    # with comments and a bare `version = 1`.
    lines = text.splitlines()
    start = next((i for i, ln in enumerate(lines) if ln.lstrip().startswith("[")), None)
    if start is None:
        return {}
    cfg = configparser.RawConfigParser(strict=False)
    if preserve_case:
        # `env-VLLM_SM70_QUANT_BACKEND = turbomind` is an environment variable name,
        # and environment variables are case-sensitive: keep every key as written.
        cfg.optionxform = str
    try:
        cfg.read_string("\n".join(lines[start:]))
    except configparser.Error:
        return {}
    presets = {}
    for name in cfg.sections():
        if name == "*":
            continue
        args = {k: v for k, v in cfg.items(name)
                if k not in ("model", "mmproj", "tags", "backend")}
        presets[name] = {
            "path": cfg.get(name, "model", fallback=""),
            "mmproj": cfg.get(name, "mmproj", fallback=""),
            "tags": [t.strip() for t in cfg.get(name, "tags", fallback="").split(",") if t.strip()],
            "backend": cfg.get(name, "backend", fallback=default_backend).strip().lower(),
            "args": args,
        }
    return presets


def parse_presets() -> dict[str, dict]:
    """Every preset on the rig, whichever engine serves it.

    Three files: models.ini is what the llama.cpp router reads, and llama.cpp refuses a
    preset containing a key it does not know — so vLLM's flags live in models-1cat.ini
    and the stock-only cards (spark2_5) live in models-stock.ini, neither of which
    reaches the router.  Merged here, they are one list of ids to clients.
    """
    presets = _parse_preset_file(PRESET, "llama")
    for mid, meta in _parse_preset_file(CAT_PRESET, "1cat", preserve_case=True).items():
        presets.setdefault(mid, meta)
    for mid, meta in _parse_preset_file(STOCK_PRESET, "stock").items():
        presets.setdefault(mid, meta)
    return presets


def file_size(path: str) -> int | None:
    try:
        return os.path.getsize(path)
    except OSError:
        return None


# ---------------------------------------------------------------------------- gpu

def gpu_stats() -> dict:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return {"error": "nvidia-smi not on PATH", "devices": []}
    try:
        out = subprocess.run(
            [exe, "--query-gpu=index,name,memory.used,memory.total,utilization.gpu,uuid",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout
    except (subprocess.SubprocessError, OSError) as exc:
        return {"error": f"nvidia-smi failed: {exc}", "devices": []}

    devices = []
    for line in out.splitlines():
        cols = [c.strip() for c in line.split(",")]
        if len(cols) < 6:
            continue
        devices.append({
            "index": int(cols[0]),
            "name": cols[1],
            "used_mib": int(cols[2]),
            "total_mib": int(cols[3]),
            "util": int(cols[4]),
            "uuid": cols[5],  # attributes nvidia-smi compute apps to this card
        })
    target = next((d for d in devices if "V100" in d["name"]), devices[0] if devices else None)
    return {"devices": devices, "target": target}


# ------------------------------------------------------------------- SLM worker
# The handoff worker (omp's `slm` compaction method) is a *plain* llama-server, not a
# router child: the router admits one resident model, so loading a 3-4B worker through
# it would evict whatever the session is using. It distils each completed turn into a
# rolling handoff document; compaction reads that document instead of re-summarizing a
# saturated context. This panel owns that process and shows what it costs.

SLM_ALIAS = "slm-worker"
SLM_PIDFILE = APP_DIR / "slm.pid"
SLM_METAFILE = APP_DIR / "slm.json"
SLM_LOG = LOGS / "slm.log"
SLM_MODELS = {
    "Spark-X2.5-4B-Q4_0": Path.home() / "models" / "Spark-X2.5-4B-Q4_0.gguf",
    "SmolLM3-3B-Q4_K_M": Path.home() / "models" / "SmolLM3-Q4_K_M.gguf",
    "Qwen2.5-0.5B-Instruct-Q4_K_M": Path.home() / "models" / "qwen2.5-0.5b-instruct-q4_k_m.gguf",
}
_SLM_SAMPLE: dict = {"pid": None, "at": 0.0, "ticks": 0}
_CPU_SAMPLE: dict = {"at": 0.0, "busy": 0, "total": 0}


def slm_choices() -> list[dict]:
    return [
        {"id": name, "path": str(path), "exists": path.exists(), "size_bytes": file_size(str(path))}
        for name, path in SLM_MODELS.items()
    ]


def _slm_meta() -> dict:
    try:
        return json.loads(SLM_METAFILE.read_text())
    except (OSError, ValueError):
        return {}


def _slm_pid() -> int | None:
    try:
        pid = int(SLM_PIDFILE.read_text().strip())
    except (OSError, ValueError):
        return None
    return pid if pid > 0 and Path(f"/proc/{pid}").exists() else None


def _proc_alive(pid: int) -> bool:
    return Path(f"/proc/{pid}").exists()


def _slm_cpu_ticks(pid: int) -> int | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        fields = stat.rsplit(")", 1)[1].split()
        return int(fields[11]) + int(fields[12])  # utime + stime
    except (OSError, IndexError, ValueError):
        return None


def _proc_rss_mib(pid: int) -> int | None:
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def _slm_healthy(port: int | None) -> bool:
    if not port:
        return False
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=0.6) as resp:
            return 200 <= resp.status < 300
    except (urllib.error.URLError, OSError, ValueError):
        return False


def slm_status() -> dict:
    pid = _slm_pid()
    meta = _slm_meta()
    base = {
        "choices": slm_choices(),
        "log": str(SLM_LOG) if SLM_LOG.exists() else None,
        "choices_file": str(SLM_METAFILE),
    }
    if pid is None:
        return {**base, "running": False, "loaded": False}
    now = time.time()
    ticks = _slm_cpu_ticks(pid)
    cpu_pct = None
    if ticks is not None:
        if _SLM_SAMPLE["pid"] == pid and now > _SLM_SAMPLE["at"]:
            elapsed = now - _SLM_SAMPLE["at"]
            cpu_pct = round(((ticks - _SLM_SAMPLE["ticks"]) / os.sysconf("SC_CLK_TCK")) / elapsed * 100, 1)
        _SLM_SAMPLE.update(pid=pid, ticks=ticks, at=now)
    port = meta.get("port")
    return {
        **base,
        "running": True,
        "loaded": _slm_healthy(port),
        "pid": pid,
        "port": port,
        "model": meta.get("model"),
        "file": os.path.basename(meta.get("model") or ""),
        "device": meta.get("device"),
        "ctx": meta.get("ctx"),
        "threads": meta.get("threads"),
        "gpu_free_mib": meta.get("gpu_free_mib"),
        "cpu_pct": cpu_pct,
        "rss_mib": _proc_rss_mib(pid),
        "uptime_s": int(now - float(meta.get("started_at") or now)),
    }


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def slm_load(model: str, device: str = "cuda:1", ctx: int = 8192,
             gpu_free_mib: int = 2048, threads: int = 4) -> dict:
    """Start (or restart) the worker. Returns before the weights are up; /api/state polls health."""
    if _slm_pid() is not None:
        slm_unload()
    choice = SLM_MODELS.get(model)
    model_path = Path(choice) if choice else Path(model).expanduser()
    if not model_path.exists():
        raise RuntimeError(f"model not found: {model_path}")
    device = (device or "cpu").strip().lower()
    if device.startswith("cuda"):
        cuda_index: int | None = int(device.split(":", 1)[1]) if ":" in device else 0
    elif device == "cpu":
        cuda_index = None
    else:
        raise RuntimeError('device must be "cpu", "cuda", or "cuda:N"')
    server = str(STOCK_WRAPPER) if STOCK_WRAPPER.exists() else shutil.which("llama-server")
    if not server:
        raise RuntimeError("llama-server not found")
    ctx = max(2048, int(ctx))
    threads = max(1, int(threads))
    port = _free_port()
    args = [server, "--model", str(model_path), "--alias", SLM_ALIAS,
            "--host", "127.0.0.1", "--port", str(port), "--ctx-size", str(ctx)]
    if cuda_index is None:
        args += ["--n-gpu-layers", "0"]
    elif int(gpu_free_mib) >= 0:
        # Let llama.cpp pick the layer count that keeps this much VRAM free, instead of
        # filling a card that may also be driving the desktop.
        args += ["--n-gpu-layers", "auto", "--fit", "on",
                 "--fit-target", str(int(gpu_free_mib)), "--fit-ctx", str(ctx)]
    else:
        args += ["--n-gpu-layers", "999"]
    args += ["--threads", str(threads), "--threads-batch", str(threads), "--parallel", "1",
             "--cache-type-k", "q8_0", "--cache-type-v", "q8_0", "--load-mode", "none",
             "--jinja", "--no-webui", "--reasoning-format", "auto",
             "--reasoning-budget", "0", "--log-colors", "off"]
    env = dict(os.environ)
    env.update({
        "CUDA_DEVICE_ORDER": "PCI_BUS_ID",
        "CUDA_VISIBLE_DEVICES": "" if cuda_index is None else str(cuda_index),
        "HIP_VISIBLE_DEVICES": "",
        "ROCR_VISIBLE_DEVICES": "",
    })
    LOGS.mkdir(parents=True, exist_ok=True)
    with open(SLM_LOG, "ab", buffering=0) as log:
        log.write(f"\n=== {time.strftime('%F %T')} {device} {model_path.name} ctx={ctx} free={gpu_free_mib} ===".encode() + b"\n")
        proc = subprocess.Popen(args, stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                                env=env, start_new_session=True)
    SLM_PIDFILE.write_text(str(proc.pid))
    SLM_METAFILE.write_text(json.dumps({
        "model": str(model_path), "device": device, "ctx": ctx, "threads": threads,
        "port": port, "gpu_free_mib": int(gpu_free_mib), "started_at": time.time(),
    }, indent=2))
    return {"ok": True, "pid": proc.pid, "port": port,
            "detail": f"starting {model_path.name} on {device}"}


def slm_unload() -> dict:
    pid = _slm_pid()
    if pid is None:
        SLM_PIDFILE.unlink(missing_ok=True)
        SLM_METAFILE.unlink(missing_ok=True)
        return {"ok": True, "detail": "SLM worker was not running"}

    def group(sig: int) -> None:
        try:
            os.killpg(os.getpgid(pid), sig)
        except OSError:
            signal_tree(pid, sig)

    group(signal.SIGINT)
    deadline = time.time() + 5
    while time.time() < deadline and _proc_alive(pid):
        time.sleep(0.2)
    if _proc_alive(pid):
        group(signal.SIGKILL)
        time.sleep(0.5)
    SLM_PIDFILE.unlink(missing_ok=True)
    SLM_METAFILE.unlink(missing_ok=True)
    return {"ok": True, "detail": f"stopped SLM worker (pid {pid})"}


def cpu_stats() -> dict:
    try:
        loadavg = list(os.getloadavg())
    except OSError:
        loadavg = [None, None, None]
    busy = total = 0
    try:
        with open("/proc/stat") as fh:
            fields = [int(v) for v in fh.readline().split()[1:]]
        idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
        total = sum(fields)
        busy = total - idle
    except (OSError, ValueError, IndexError):
        pass
    now = time.time()
    pct = None
    if total and _CPU_SAMPLE["total"] and now > _CPU_SAMPLE["at"]:
        span = total - _CPU_SAMPLE["total"]
        work = busy - _CPU_SAMPLE["busy"]
        if span > 0:
            pct = round(work / span * 100, 1)
    _CPU_SAMPLE.update(at=now, busy=busy, total=total)
    return {"loadavg": loadavg, "cores": os.cpu_count(), "busy_pct": pct}


# -------------------------------------------------------------------------- state

def snapshot(router_port: int, ui_port: int) -> dict:
    presets = parse_presets()
    engine = engine_on(router_port)
    up = engine is not None

    router_models: dict[str, dict] = {}
    router_error = None
    if up:
        try:
            for m in router_get("/models", router_port)["data"]:
                router_models[m["id"]] = m
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI verbatim
            router_error = str(exc)

    state = read_state()
    peaks: dict[str, int] = state.get("peak", {})
    gpu = gpu_stats()
    target = gpu.get("target") or {}

    models = []
    for mid, meta in presets.items():
        backend = meta.get("backend", "llama")
        if backend == "1cat":
            # vLLM has no router to ask: its state is the process it runs in, and
            # /health is what "loaded" means (it answers only after the weights are up).
            # One vLLM serves one model, so presets other than the requested one are
            # unloaded unless they are the model this process was started for.
            if cat_requested_model() in (None, mid):
                status, failed = cat_status(router_port)
            else:
                status, failed = "unloaded", False
            exists = not os.path.isabs(meta["path"]) or os.path.exists(meta["path"])
            models.append({
                "id": mid,
                "engine": "1cat",
                "path": meta["path"],
                "file": os.path.basename(meta["path"].rstrip("/")) or meta["path"],
                "exists": exists,
                "size_bytes": file_size(meta["path"]) if os.path.isabs(meta["path"]) else None,
                "mmproj": None,
                "tags": meta["tags"],
                "status": status,
                "failed": failed,
                "active": status in ACTIVE_STATES,
                "context": int(meta["args"]["ctx-size"]) if str(meta["args"].get("ctx-size", "")).isdigit() else None,
                "arch": None,
            })
            continue
        if backend == "stock":
            # Same as 1cat: the stock build has no router to ask — its state is the
            # process it runs in, and /health is what "loaded" means.  One stock
            # server serves one model, so presets other than the requested one are
            # unloaded unless they are the model this process was started for.
            if stock_requested_model() in (None, mid):
                status, failed = stock_status(router_port)
            else:
                status, failed = "unloaded", False
            exists = not os.path.isabs(meta["path"]) or os.path.exists(meta["path"])
            models.append({
                "id": mid,
                "engine": "stock",
                "path": meta["path"],
                "file": os.path.basename(meta["path"]),
                "exists": exists,
                "size_bytes": file_size(meta["path"]) if os.path.isabs(meta["path"]) else None,
                "mmproj": meta["mmproj"] or None,
                "tags": meta["tags"],
                "status": status,
                "failed": failed,
                "active": status in ACTIVE_STATES,
                "context": int(meta["args"]["ctx-size"]) if str(meta["args"].get("ctx-size", "")).isdigit() else None,
                "arch": None,
            })
            continue

        rm = router_models.get(mid, {})
        status = (rm.get("status") or {}).get("value", "unloaded")
        models.append({
            "id": mid,
            "engine": "llama",
            "path": meta["path"],
            "file": os.path.basename(meta["path"]),
            "exists": os.path.exists(meta["path"]),
            "size_bytes": file_size(meta["path"]),
            "mmproj": meta["mmproj"] or None,
            "tags": meta["tags"] or rm.get("tags") or [],
            "status": status,
            "failed": bool((rm.get("status") or {}).get("failed")),
            "active": status in ACTIVE_STATES,
            "context": ((rm.get("meta") or {}).get("n_ctx")),
            "arch": (rm.get("architecture") or {}).get("input_modalities"),
        })

    active_ids = [m["id"] for m in models if m["active"]]
    used = target.get("used_mib")
    if used is not None and up:
        with _STATE_LOCK:
            # One model at a time by construction, so a reading is attributable.
            if len(active_ids) == 1:
                mid = active_ids[0]
                if used > peaks.get(mid, 0):
                    peaks[mid] = used
                    state["peak"] = peaks
                    write_state(state)
            elif not active_ids:
                base = state.get("baseline_mib")
                if base is None or used < base:
                    state["baseline_mib"] = used
                    write_state(state)

    for m in models:
        m["vram_peak_mib"] = peaks.get(m["id"])

    return {
        "server": {
            "up": up,
            "engine": engine,
            "router_port": router_port,
            "ui_port": ui_port,
            "log_file": str(LOG) if LOG.exists() else None,
            "cat_log_file": str(CAT_LOG) if CAT_LOG.exists() else None,
            "error": router_error,
        },
        "gpu": gpu,
        "models": models,
        "active": active_ids[0] if len(active_ids) == 1 else None,
        "baseline_mib": state.get("baseline_mib"),
        "parking": read_parking(),
        "contexts": contexts_listing(),
        "slm": slm_status(),
        "cpu": cpu_stats(),
    }


# ------------------------------------------------------------------ server control

def start_router(router_port: int) -> dict:
    if router_up(router_port):
        return {"ok": True, "detail": "router already running", "started": False}
    if router_port_open(router_port):
        held = ", ".join(str(p) for p in port_pids(router_port)) or "?"
        raise RuntimeError(
            f"port {router_port} is held by pid {held}, which is not a llama.cpp "
            "router — stop it first (llama-manager stop)"
        )
    if not os.path.exists(server_cmd()):
        raise RuntimeError(f"no llama-server at {server_cmd()}")

    # --no-models-autoload is the contract, not a nicety: without it the router
    # serves a request naming an unloaded model by quietly loading it, which is
    # exactly the unasked-for VRAM the manager exists to prevent.  With it, VRAM
    # changes only on an explicit POST /models/load — the card being dropped.
    argv = [
        server_cmd(),
        "--models-preset", str(PRESET),
        "--models-max", "1",
        "--no-models-autoload",
        "--host", "127.0.0.1",
        "--port", str(router_port),
    ]
    LOG.parent.mkdir(parents=True, exist_ok=True)
    log = LOG.open("ab", buffering=0)
    log.write(f"\n=== llama-server (router mode) start {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n".encode())
    proc = subprocess.Popen(
        argv, cwd=str(APP_DIR), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    PIDFILE.write_text(str(proc.pid))

    deadline = time.time() + 60
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"router exited with code {proc.returncode}; see {LOG}")
        if router_port_open(router_port):
            return {"ok": True, "detail": f"router started (pid {proc.pid})", "started": True}
        time.sleep(0.3)
    raise RuntimeError("router did not open its port within 60s; see " + str(LOG))


def stop_router(router_port: int, force: bool = False) -> dict:
    victims = llama_servers_on(router_port)
    if not victims:
        PIDFILE.unlink(missing_ok=True)
        return {"ok": True, "detail": "nothing was listening"}

    for pid, argv in victims:
        # SIGINT first: this build winds down on INT but sits on TERM for far longer
        # (local-qwen-on-v100.md §10).
        signal_tree(pid, signal.SIGINT)

    int_grace, term_grace = (5.0, 3.0) if force else (20.0, 10.0)
    deadline = time.time() + int_grace
    while time.time() < deadline and llama_servers_on(router_port):
        time.sleep(0.3)
    if llama_servers_on(router_port):
        for pid, _ in victims:
            signal_tree(pid, signal.SIGTERM)
        deadline = time.time() + term_grace
        while time.time() < deadline and llama_servers_on(router_port):
            time.sleep(0.3)
    if llama_servers_on(router_port):
        for pid, _ in victims:
            signal_tree(pid, signal.SIGKILL)  # the driver reclaims VRAM either way
        time.sleep(1.0)

    still = llama_servers_on(router_port)
    PIDFILE.unlink(missing_ok=True)
    if still:
        raise RuntimeError("still holding the port: " + repr([p for p, _ in still]))
    return {"ok": True, "detail": f"stopped {len(victims)} llama-server process(es)"}


def ensure_only(model_id: str, router_port: int) -> None:
    """Unload every other model, then load `model_id`."""
    presets = parse_presets()
    if model_id not in presets:
        raise RuntimeError(f"unknown model {model_id!r} (not a section in models.ini)")
    if not os.path.exists(presets[model_id]["path"]):
        raise RuntimeError(f"missing file: {presets[model_id]['path']}")

    data = router_get("/models", router_port)["data"]
    target = next((m for m in data if m["id"] == model_id), {})
    if (target.get("status") or {}).get("value") in ACTIVE_STATES:
        return  # already loaded: dropping the same card twice is a no-op, not an error

    others = [
        m["id"] for m in data
        if m["id"] != model_id and (m.get("status") or {}).get("value") in ACTIVE_STATES
    ]
    for mid in others:
        router_post("/models/unload", {"model": mid}, router_port)

    deadline = time.time() + 60
    while others and time.time() < deadline:
        data = router_get("/models", router_port)["data"]
        still = [
            m["id"] for m in data
            if m["id"] in others and (m.get("status") or {}).get("value") in ACTIVE_STATES
        ]
        others = still
        if others:
            time.sleep(0.5)

    router_post("/models/load", {"model": model_id}, router_port)


def unload(model_id: str, router_port: int) -> None:
    router_post("/models/unload", {"model": model_id}, router_port)


# ------------------------------------------------------------- 1cat-vllm engine

def _proc_state(pid: int) -> str | None:
    """/proc state letter, or None when there is no such process.

    A zombie counts as gone: this manager spawns vllm but does not keep the Popen
    handle, so an exited child stays visible to kill(pid, 0) until it is reaped.
    """
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    return stat[stat.rindex(")") + 2:].split()[0]


def _reap(pid: int) -> None:
    try:
        os.waitpid(pid, os.WNOHANG)
    except (ChildProcessError, OSError):
        pass


def cat_pid() -> int | None:
    try:
        pid = int(CAT_PIDFILE.read_text().strip())
    except (OSError, ValueError):
        return None
    state = _proc_state(pid)
    if state is None or state in ("Z", "X"):
        _reap(pid)
        CAT_PIDFILE.unlink(missing_ok=True)
        return None
    return pid


def cat_get(path: str, port: int, timeout: float = 3.0):
    url = f"http://127.0.0.1:{port}{path}"
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.load(resp)


def cat_up(port: int) -> bool:
    """True once vLLM's /health answers 200 — its readiness signal, and "loaded".

    The body is empty, so this checks the status code only: JSON-parsing it (as the
    router probes do) would report a healthy server as down.
    """
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2.0) as resp:
            return resp.status == 200
    except Exception:  # noqa: BLE001 - any failure means "not serving yet"
        return False


def cat_requested_model() -> str | None:
    """The preset id this engine was asked to serve (recorded at spawn, cleared on stop)."""
    try:
        return CAT_MODELFILE.read_text().strip() or None
    except OSError:
        return None


def cat_model(port: int) -> str | None:
    """The served-model-name of the running vLLM, or None when it is not answering."""
    try:
        data = cat_get("/v1/models", port, timeout=3.0).get("data") or []
    except Exception:  # noqa: BLE001
        return None
    return data[0].get("id") if data else None


def cat_status(port: int) -> tuple[str, bool]:
    """(status, failed) in the router's own vocabulary, so the page needs one code path."""
    pid = cat_pid()
    if pid is None:
        return "unloaded", False
    if cat_up(port):
        return "loaded", False
    if _proc_state(pid) not in (None, "Z", "X"):
        return "loading", False
    return "failed", True


def cat_argv(model_id: str, preset: dict, port: int) -> list[str]:
    """`vllm serve` argv for one preset.

    `ctx-size` and `dtype` are shared keys — they mean the same thing to both engines —
    while anything vLLM-specific is written `vllm-<flag>` and passed through with that
    prefix stripped (vllm-gpu-memory-utilization → --gpu-memory-utilization).  Bare
    flags take an empty value or `true`; `false` omits the flag entirely.
    """
    args = preset["args"]
    # float16 is the only fast path on Volta: bf16 exists in the ISA-checked sense but
    # runs through fp32 emulation at ~9 TFLOP/s against fp16's ~92 (measured on this card).
    argv = [str(CAT_VLLM), "serve", preset["path"],
            "--served-model-name", model_id,
            "--port", str(port),
            "--dtype", args.get("dtype", "float16")]
    if args.get("ctx-size"):
        argv += ["--max-model-len", str(args["ctx-size"])]
    for key in sorted(args):
        if key.startswith("env-") and len(key) > 4:
            continue  # environment, not a flag — shipped by cat_env()
        if not key.startswith("vllm-") or key == "vllm-":
            continue
        flag = "--" + key[len("vllm-"):].replace("_", "-")
        val = str(args[key]).strip()
        if val.lower() in ("", "true", "on", "yes"):
            argv.append(flag)
        elif val.lower() in ("false", "off", "no"):
            continue
        else:
            argv += [flag, val]
    return argv


def cat_env(preset: dict) -> dict:
    """The spawn environment: the V100 pinning plus any `env-NAME = value` in the preset.

    Some of what makes a quantised checkpoint loadable on Volta is a switch, not a flag:
    the fork keeps its 4-bit/8-bit gates at sm_75/89 unless its SM70 software backend is
    selected, which is `VLLM_SM70_QUANT_BACKEND=turbomind` (or the per-format
    VLLM_SM70_*_TURBOMIND flags).  Those belong to the preset that needs them.
    """
    env = dict(os.environ, **CAT_ENV)
    for key, value in preset.get("args", {}).items():
        if key.startswith("env-") and len(key) > 4:
            env[key[4:]] = str(value)
    return env


def cat_start(model_id: str, preset: dict, port: int) -> dict:
    """Spawn `vllm serve` and return at once — loading is minutes for a large model, and
    the page polls /api/state the same way it does while the router loads a child."""
    if cat_pid() is not None:
        raise RuntimeError("a 1cat-vllm server is already running; unload it first")
    if router_up(port) or router_port_open(port):
        raise RuntimeError(f"port {port} is not free; stop the other engine first")
    if not CAT_VLLM.exists():
        raise RuntimeError(f"no 1cat-vllm at {CAT_VLLM}")

    argv = cat_argv(model_id, preset, port)
    LOGS.mkdir(parents=True, exist_ok=True)
    log = CAT_LOG.open("ab", buffering=0)
    log.write(("\n=== 1cat-vllm start %s ===\n%s\n"
               % (time.strftime("%Y-%m-%d %H:%M:%S"), " ".join(argv))).encode())
    proc = subprocess.Popen(
        argv, cwd=str(CAT_HOME), stdin=subprocess.DEVNULL, stdout=log,
        stderr=subprocess.STDOUT, start_new_session=True, env=cat_env(preset),
    )
    CAT_PIDFILE.write_text(str(proc.pid))
    CAT_MODELFILE.write_text(model_id)
    time.sleep(0.5)
    if proc.poll() is not None:
        CAT_PIDFILE.unlink(missing_ok=True)
        CAT_MODELFILE.unlink(missing_ok=True)
        raise RuntimeError(f"1cat-vllm exited immediately (code {proc.returncode}); see {CAT_LOG}")
    return {"ok": True, "detail": f"1cat-vllm loading {model_id} (pid {proc.pid})", "pid": proc.pid}


def cat_stop(force: bool = False) -> dict:
    """Stop vLLM and its engine child, and only then claim the card is free.

    vLLM spawns an engine process of its own, so the signal goes to the process group
    the spawn created (`start_new_session=True`) — SIGINT first, because that is what
    vLLM winds down cleanly on.
    """
    pid = cat_pid()
    if pid is None:
        return {"ok": True, "detail": "no 1cat-vllm server was running"}

    def group(sig: int) -> None:
        try:
            os.killpg(os.getpgid(pid), sig)
        except OSError:
            signal_tree(pid, sig)

    group(signal.SIGINT)
    deadline = time.time() + (10 if force else 60)
    while time.time() < deadline and cat_pid() is not None:
        time.sleep(0.3)
    if cat_pid() is not None:
        group(signal.SIGTERM)
        deadline = time.time() + (5 if force else 30)
        while time.time() < deadline and cat_pid() is not None:
            time.sleep(0.3)
    if cat_pid() is not None:
        group(signal.SIGKILL)
        time.sleep(1.0)
    CAT_PIDFILE.unlink(missing_ok=True)
    CAT_MODELFILE.unlink(missing_ok=True)
    return {"ok": True, "detail": f"stopped 1cat-vllm (pid {pid})"}


# -------------------------------------------------------------- stock engine

def stock_pid() -> int | None:
    try:
        pid = int(STOCK_PIDFILE.read_text().strip())
    except (OSError, ValueError):
        return None
    state = _proc_state(pid)
    if state is None or state in ("Z", "X"):
        _reap(pid)
        STOCK_PIDFILE.unlink(missing_ok=True)
        return None
    return pid


def stock_up(port: int) -> bool:
    """True once llama-server-stock's /health answers 200 — the same readiness signal
    as vLLM, and what "loaded" means (the weights are up once it answers)."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2.0) as resp:
            return resp.status == 200
    except Exception:  # noqa: BLE001 - any failure means "not serving yet"
        return False


def stock_requested_model() -> str | None:
    try:
        return STOCK_MODELFILE.read_text().strip() or None
    except OSError:
        return None


def stock_model(port: int) -> str | None:
    """The served model id of the running stock server, or None when not answering."""
    try:
        data = cat_get("/v1/models", port, timeout=3.0).get("data") or []
    except Exception:  # noqa: BLE001
        return None
    return data[0].get("id") if data else None


def stock_status(port: int) -> tuple[str, bool]:
    pid = stock_pid()
    if pid is None:
        return "unloaded", False
    if stock_up(port):
        return "loaded", False
    if _proc_state(pid) not in (None, "Z", "X"):
        return "loading", False
    return "failed", True


def stock_argv(model_id: str, preset: dict, port: int) -> list[str]:
    """`llama-server` argv for one preset, on the stock build.

    The preset's args are the same llama.cpp flag names models.ini uses (minus the
    leading dashes) — the stock build speaks the same CLI as the fork.  `model`,
    `mmproj`, `backend` and `tags` are already stripped out of `args` by the parser.
    """
    argv = [str(STOCK_WRAPPER), "--model", preset["path"],
            "--alias", model_id, "--host", "127.0.0.1", "--port", str(port)]
    if preset.get("mmproj"):
        argv += ["--mmproj", preset["mmproj"]]
    for key in sorted(preset["args"]):
        val = str(preset["args"][key]).strip()
        # llama.cpp flags take explicit values — "on"/"off"/"auto" are values, not
        # bare booleans (is_truthy("") is false, so a bare `--flash-attn` would error).
        # Emit `--key value` always; omit a flag entirely to mean "default".
        if val:
            argv += ["--" + key, val]
        else:
            argv.append("--" + key)
    return argv


def stock_start(model_id: str, preset: dict, port: int) -> dict:
    """Spawn llama-server-stock and return at once; the page polls /api/state as with
    the router and 1cat.  Single process — llama.cpp does not fork an engine child."""
    if stock_pid() is not None:
        raise RuntimeError("a stock llama-server is already running; unload it first")
    if router_up(port) or router_port_open(port):
        raise RuntimeError(f"port {port} is not free; stop the other engine first")
    if not STOCK_WRAPPER.exists():
        raise RuntimeError(f"no stock llama-server at {STOCK_WRAPPER}")

    argv = stock_argv(model_id, preset, port)
    LOGS.mkdir(parents=True, exist_ok=True)
    log = STOCK_LOG.open("ab", buffering=0)
    log.write(("\n=== llama-server-stock start %s ===\n%s\n"
               % (time.strftime("%Y-%m-%d %H:%M:%S"), " ".join(argv))).encode())
    proc = subprocess.Popen(
        argv, cwd=str(APP_DIR), stdin=subprocess.DEVNULL, stdout=log,
        stderr=subprocess.STDOUT, start_new_session=True,
    )
    STOCK_PIDFILE.write_text(str(proc.pid))
    STOCK_MODELFILE.write_text(model_id)
    time.sleep(0.5)
    if proc.poll() is not None:
        STOCK_PIDFILE.unlink(missing_ok=True)
        STOCK_MODELFILE.unlink(missing_ok=True)
        raise RuntimeError(f"llama-server-stock exited immediately (code {proc.returncode}); see {STOCK_LOG}")
    return {"ok": True, "detail": f"stock loading {model_id} (pid {proc.pid})", "pid": proc.pid}


def stock_stop(force: bool = False) -> dict:
    """Stop llama-server-stock.  Single process, no engine child, and llama.cpp sits on
    SIGTERM but winds down on SIGINT (§10) — so INT first, exactly like stop_router."""
    pid = stock_pid()
    if pid is None:
        return {"ok": True, "detail": "no stock llama-server was running"}

    def group(sig: int) -> None:
        try:
            os.killpg(os.getpgid(pid), sig)
        except OSError:
            signal_tree(pid, sig)

    group(signal.SIGINT)
    deadline = time.time() + (10 if force else 60)
    while time.time() < deadline and stock_pid() is not None:
        time.sleep(0.3)
    if stock_pid() is not None:
        group(signal.SIGTERM)
        deadline = time.time() + (5 if force else 30)
        while time.time() < deadline and stock_pid() is not None:
            time.sleep(0.3)
    if stock_pid() is not None:
        group(signal.SIGKILL)
        time.sleep(1.0)
    STOCK_PIDFILE.unlink(missing_ok=True)
    STOCK_MODELFILE.unlink(missing_ok=True)
    return {"ok": True, "detail": f"stopped stock llama-server (pid {pid})"}


def stock_log_tail(lines: int) -> str:
    return _tail(STOCK_LOG, lines)


def engine_on(port: int) -> str | None:
    """Which engine is answering on the front-door port right now."""
    if cat_pid() is not None and cat_up(port):
        return "1cat"
    if stock_pid() is not None and stock_up(port):
        return "stock"
    if router_up(port):
        return "llama"
    return None


def load_model(model_id: str, router_port: int, resume: bool = True) -> dict:
    """Put `model_id` on the V100, whichever engine serves it.

    The port moves with the engine: one card cannot hold an 8-bit-quantised 30B from
    llama.cpp and a vLLM at the same time, so loading across a backend boundary stops
    the other engine first and starts this one on the same port.  Clients therefore keep
    one URL and address the model by id; the engine behind that id is a preset detail.
    """
    presets = parse_presets()
    if model_id not in presets:
        raise RuntimeError(f"unknown model {model_id!r} (not a section in models.ini)")
    preset = presets[model_id]

    if preset["backend"] == "1cat":
        path = preset["path"]
        if not path:
            raise RuntimeError(f"{model_id}: 'model' must be a Hub repo id or a local directory")
        # A Hub id is fetched on first use; only a path we were pointed at can be missing.
        if os.path.isabs(path) and not os.path.exists(path):
            raise RuntimeError(f"missing path: {path}")
        resident = cat_model(router_port) if cat_pid() is not None else None
        if resident == model_id:
            return {"ok": True, "detail": f"{model_id} is already loaded", "started": False}
        if cat_pid() is not None:
            cat_stop()
        if stock_pid() is not None:
            stock_stop()
        if router_up(router_port) or router_port_open(router_port):
            stop_router(router_port)
        return {**cat_start(model_id, preset, router_port), "started": True}

    if preset["backend"] == "stock":
        path = preset["path"]
        if not path or not os.path.exists(path):
            raise RuntimeError(f"missing path: {path}")
        resident = stock_model(router_port) if stock_pid() is not None else None
        if resident == model_id:
            return {"ok": True, "detail": f"{model_id} is already loaded", "started": False}
        if stock_pid() is not None:
            stock_stop()
        if cat_pid() is not None:
            cat_stop()
        if router_up(router_port) or router_port_open(router_port):
            stop_router(router_port)
        return {**stock_start(model_id, preset, router_port), "started": True}

    # llama.cpp. Its router only speaks for models in models.ini, so an unloaded model
    # is loaded through POST /models/load and nothing else in this file calls that.
    if cat_pid() is not None:
        cat_stop()
    if stock_pid() is not None:
        stock_stop()
    if not router_up(router_port):
        start_router(router_port)
    ensure_only(model_id, router_port)
    detail = f"loading {model_id}"
    # Read the parked context back once the child is up, unless the caller asked for a
    # clean slate.  Off-thread because /models/load returns long before the weights land.
    if resume and read_parking().get("resume") and parked_name(model_id) in read_contexts():
        threading.Thread(
            target=_resume_when_ready, args=(model_id, router_port), daemon=True
        ).start()
        detail += "; parked context queued for resume"
    return {"ok": True, "detail": detail, "started": True}


def unload_model(model_id: str, router_port: int) -> dict:
    preset = parse_presets().get(model_id, {})
    if preset.get("backend") == "1cat":
        resident = cat_model(router_port) if cat_pid() is not None else None
        if resident is not None and resident != model_id:
            raise RuntimeError(f"1cat-vllm is serving {resident}, not {model_id}")
        detail = cat_stop()["detail"]
        # Hand the port back to the llama.cpp engine, which is the rig's resting state:
        # the router loads nothing by itself, so restarting it costs no VRAM, and leaving
        # the port for nobody would break the llama.cpp provider until something noticed.
        if not router_up(router_port):
            try:
                start_router(router_port)
                detail += "; llama router back up"
            except Exception as exc:  # noqa: BLE001 - unload itself succeeded
                detail += f"; could not restart the llama router: {exc}"
        return {"ok": True, "detail": detail}
    if preset.get("backend") == "stock":
        resident = stock_model(router_port) if stock_pid() is not None else None
        if resident is not None and resident != model_id:
            raise RuntimeError(f"stock llama-server is serving {resident}, not {model_id}")
        detail = stock_stop()["detail"]
        # Hand the port back to the llama.cpp engine — the rig's resting state — same
        # reasoning as the 1cat branch: the router loads nothing by itself.
        if not router_up(router_port):
            try:
                start_router(router_port)
                detail += "; llama router back up"
            except Exception as exc:  # noqa: BLE001 - unload itself succeeded
                detail += f"; could not restart the llama router: {exc}"
        return {"ok": True, "detail": detail}
    # Snapshot before the weights go: this is the one unload path the manager controls,
    # and without it the next load pays a full re-prefill for the whole context.
    parked = None
    try:
        if _llama_child(model_id, router_port):
            parked = park_context(router_port, model_id)
    except Exception:  # noqa: BLE001 - a failed snapshot must never block the unload
        parked = None
    unload(model_id, router_port)
    detail = f"unloaded {model_id}"
    if parked and parked.get("tokens"):
        detail += f"; parked {parked['tokens']} tokens ({parked['name']})"
    return {"ok": True, "detail": detail}


# ------------------------------------------------------------- force clear VRAM

def _vram_holders() -> list[dict]:
    """Every process nvidia-smi attributes to the target card, as {pid, mib, name}."""
    target = gpu_stats().get("target") or {}
    uuid = target.get("uuid")
    exe = shutil.which("nvidia-smi")
    if not uuid or not exe:
        return []
    try:
        out = subprocess.run(
            [exe, "--query-compute-apps=gpu_uuid,pid,used_memory,process_name",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return []
    holders = []
    for line in out.splitlines():
        cols = [c.strip() for c in line.split(",", 3)]  # process_name may hold commas
        if len(cols) < 4 or cols[0] != uuid:
            continue
        try:
            holders.append({"pid": int(cols[1]), "mib": int(cols[2]), "name": cols[3]})
        except ValueError:
            continue
    return holders


def _is_model_engine(pid: int) -> bool:
    """True for llama.cpp / vLLM processes — the family this manager owns.

    A stray holds the card with no pidfile to ask, so the only handle is its argv: a
    `llama-server`-family binary, or anything (vLLM's CLI, a python under the
    1cat-vllm install) whose command line names vLLM.  Everything else on the V100
    is somebody else's process — reported, never killed.
    """
    if pid == os.getpid():
        return False
    argv = cmdline(pid)
    if not argv:
        return False
    return Path(argv[0]).name.startswith("llama-") or "vllm" in " ".join(argv).lower()


def _stop_process(pid: int) -> None:
    """INT → TERM → KILL one process, its group when it has a group of its own."""
    def send(sig: int) -> None:
        try:
            pgid = os.getpgid(pid)
            if pgid != os.getpgid(0):  # never signal the manager's own group
                os.killpg(pgid, sig)
            else:
                signal_tree(pid, sig)
        except OSError:
            signal_tree(pid, sig)

    def gone() -> bool:
        return _proc_state(pid) in (None, "Z", "X")

    for sig, grace in ((signal.SIGINT, 3.0), (signal.SIGTERM, 3.0)):
        if gone():
            return
        send(sig)
        deadline = time.time() + grace
        while time.time() < deadline and not gone():
            time.sleep(0.2)
    if not gone():
        send(signal.SIGKILL)
        deadline = time.time() + 2.0
        while time.time() < deadline and not gone():
            time.sleep(0.2)


def force_clear_vram(router_port: int) -> dict:
    """Free the V100 of every model engine — loaded, loading, sleeping, or stray.

    Unload is graceful and Stop server only reaches what this manager started on the
    front-door port; this is the hammer: 1cat-vllm first, then the router with its
    children, then any llama.cpp/vLLM process still holding the card that nobody here
    spawned (a stray keeps its VRAM until it dies).  Every step escalates INT → TERM →
    KILL.  A process that is not a model engine — a desktop app, say — is left alone
    and named in the result instead.  The router comes back up empty (it holds no
    VRAM of its own), so the port stays usable.
    """
    before = (gpu_stats().get("target") or {}).get("used_mib")
    router_was_up = router_up(router_port)
    notes = []

    if cat_pid() is not None:
        notes.append(cat_stop(force=True)["detail"])
    if stock_pid() is not None:
        notes.append(stock_stop(force=True)["detail"])
    if router_was_up or llama_servers_on(router_port):
        try:
            notes.append(stop_router(router_port, force=True)["detail"])
        except RuntimeError as exc:  # the sweep below still runs; the port is rechecked at the end
            notes.append(str(exc))

    strays = []
    for holder in _vram_holders():
        if _is_model_engine(holder["pid"]):
            _stop_process(holder["pid"])
            strays.append(f"{holder['name']} ({holder['mib']} MiB, pid {holder['pid']})")
    if strays:
        notes.append("killed stray " + ", ".join(strays))

    time.sleep(0.5)  # let the driver reclaim what the dead contexts held
    after = (gpu_stats().get("target") or {}).get("used_mib")
    holders = _vram_holders()
    left = [h for h in holders if _is_model_engine(h["pid"])]
    if left:
        notes.append("STILL on the V100: " + ", ".join(f"{h['name']} (pid {h['pid']})" for h in left))
    others = [h for h in holders if not _is_model_engine(h["pid"])]
    if others:
        notes.append("not a model engine, left alone: "
                     + ", ".join(f"{h['name']} ({h['mib']} MiB, pid {h['pid']})" for h in others))

    if router_was_up and not router_up(router_port):
        try:
            start_router(router_port)
            notes.append("router back up")
        except Exception as exc:  # noqa: BLE001 - the card is clear; the port is what failed
            notes.append(f"router did not come back: {exc}")

    detail = f"V100 {before} → {after} MiB" + (" — " + "; ".join(notes) if notes else "")
    return {"ok": True, "detail": detail, "before_mib": before, "after_mib": after}




# ------------------------------------------------------------------ context parking
#
# A long prefill is the most expensive thing this rig does — a 236k-token prompt on the
# 27B is ~985 s of wall clock — and the rig discards that work every time a model leaves
# VRAM: the router's own sleep-idle timeout, an engine switch, a manual unload.  llama.cpp
# can serialise a slot's KV state to a file (`--slot-save-path`, threaded through
# models.ini and visible on the model child's argv) and read it back exactly, so the cost
# is avoidable.  Measured on this box, save and restore both run at ~1.8 GB/s whatever
# the backing store is — ~4.4 s each way for a 236k 27B context, against ~985 s to
# recompute, and 112x was measured end to end at 29k tokens.
#
# Parking is a *snapshot*, never an erase: the live slot keeps its cache, so a client
# that returns before the weights go still hits it.  The file only matters once the model
# has been unloaded, and that is exactly when `resume` reads it back.
#
# Policy lives in parking.json rather than models.ini on purpose: llama.cpp refuses a
# preset containing a key it does not know, and every key in those files becomes a
# command-line flag on the model child.
#
# MEASURED LIMIT (2026-10-16, prism-b10709): a restore only produces a cache hit for
# *pure-attention* models.  Qwen3-Coder-30B-A3B resumes perfectly (prompt_n 3984 -> 1,
# cache_n 3983), while Qwen3.8-27B and Qwopus3.5-9B-Coder — both hybrids that carry
# recurrent state beside their attention layers — restore the slot (n_restored matches
# n_saved) and then re-prefill the whole prompt anyway.  Speculative decoding is not the
# cause: an A/B on the same model with `--spec-type none` vs `draft-mtp` behaves
# identically, and neither is `--parallel` nor the KV dtype.  Parking those models is
# harmless but pointless — the snapshot is written and read back, and the prefill
# happens regardless — so do not count on this for the 27B's long contexts.

CONTEXT_INDEX = APP_DIR / "contexts.json"
PARKING = APP_DIR / "parking.json"
PARK_POLL_SECONDS = 10.0  # how often the watcher reads the slot list (a few hundred bytes)
PARK_DEFAULTS = {"resume": True, "park_on_idle": True, "quiet_seconds": 120}


def slot_save_dir() -> Path:
    """Where llama.cpp actually writes slot files.

    That is `slot-save-path` in models.ini's `[*]` section — the same line the model child
    receives on its argv — so read it rather than assuming a directory.  The two drifting
    apart is silent in the worst way: saves and restores keep working, because the child
    resolves filenames against its own path, while this file's index, disk accounting and
    delete all quietly point somewhere else.
    """
    raw = ""
    try:
        lines = PRESET.read_text().splitlines()
        start = next((i for i, ln in enumerate(lines) if ln.lstrip().startswith("[")), None)
        if start is not None:
            cfg = configparser.RawConfigParser(strict=False)
            cfg.read_string("\n".join(lines[start:]))
            raw = cfg.get("*", "slot-save-path", fallback="").strip()
    except (OSError, configparser.Error):
        raw = ""
    return Path(os.path.expanduser(raw)) if raw else APP_DIR / "slots"


def read_parking() -> dict:
    try:
        loaded = json.loads(PARKING.read_text())
    except (OSError, ValueError):
        loaded = {}
    return {**PARK_DEFAULTS, **loaded} if isinstance(loaded, dict) else dict(PARK_DEFAULTS)


def read_contexts() -> dict:
    try:
        loaded = json.loads(CONTEXT_INDEX.read_text())
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def write_contexts(index: dict) -> None:
    tmp = CONTEXT_INDEX.with_name(CONTEXT_INDEX.name + ".tmp")
    try:
        tmp.write_text(json.dumps(index, indent=1, sort_keys=True))
        tmp.replace(CONTEXT_INDEX)
    except OSError:
        pass


def parked_name(model_id: str) -> str:
    """The one snapshot a model resumes from, named after the model so no client has to
    know it exists."""
    return f"{model_id}.auto"


def _active_llama_models(router_port: int) -> set[str]:
    """Ids the router currently holds in VRAM (loading, loaded or sleeping)."""
    try:
        return {
            entry["id"]
            for entry in router_get("/models", router_port)["data"]
            if (entry.get("status") or {}).get("value") in ACTIVE_STATES
        }
    except Exception:  # noqa: BLE001 - an unreachable router holds nothing
        return set()


def _llama_child(model_id: str, router_port: int) -> bool:
    return model_id in _active_llama_models(router_port)


def slot_list(model_id: str, router_port: int) -> list | None:
    """The child's slot list, or None while it is not answering yet.

    `/slots` is one of the endpoints that takes the model in the *query string*; save,
    restore, erase and /tokenize take it in the JSON body instead.  Mixing the two up
    reads as "model name is missing from the request", which looks like a malformed call
    rather than a misplaced one.
    """
    try:
        return router_get(f"/slots?model={urllib.parse.quote(model_id)}", router_port, timeout=5.0)
    except Exception:  # noqa: BLE001 - the caller reads None as "not ready"
        return None


def _slot_action(model_id: str, slot: int, action: str, router_port: int, filename: str | None = None) -> dict:
    payload: dict = {"model": model_id}
    if filename is not None:
        payload["filename"] = filename
    return router_post(f"/slots/{int(slot)}?action={action}", payload, router_port, timeout=600.0)


def park_context(router_port: int, model_id: str, name: str | None = None, slot: int = 0) -> dict:
    """Write a slot's KV state under llama.cpp's slot-save-path; the live cache is left alone.

    The child's reply is the receipt — `n_saved` is the context length actually written
    and `save_ms` the serialisation time — so the index records what was parked instead
    of what we assumed was parked.
    """
    slot_save_dir().mkdir(parents=True, exist_ok=True)
    name = name or parked_name(model_id)
    reply = _slot_action(model_id, slot, "save", router_port, name)
    meta = {
        "name": name,
        "model": model_id,
        "slot": int(slot),
        "tokens": int(reply.get("n_saved") or 0),
        "bytes": int(reply.get("n_written") or 0),
        "save_ms": (reply.get("timings") or {}).get("save_ms"),
        "saved_at": time.time(),
    }
    index = read_contexts()
    index[name] = meta
    write_contexts(index)
    return meta


def park_active(router_port: int) -> list[dict]:
    """Snapshot every llama.cpp model the router is holding.  Best effort by design —
    this runs on shutdown, where losing a context costs a full re-prefill."""
    parked = []
    for mid in sorted(_active_llama_models(router_port)):
        try:
            parked.append(park_context(router_port, mid))
        except Exception:  # noqa: BLE001 - one model failing must not stop the others
            continue
    return parked


def restore_context(router_port: int, name: str, slot: int | None = None) -> dict:
    """Read `contexts/<name>` back into a slot of its model's server.

    The model has to be loaded already: the file holds a slot's memory, not the weights.
    """
    index = read_contexts()
    meta = index.get(name)
    if not meta:
        raise RuntimeError(f"no parked context named {name!r}")
    model_id = meta.get("model", "")
    if not _llama_child(model_id, router_port):
        raise RuntimeError(f"{model_id} is not loaded, so {name!r} cannot be restored yet")
    target = int(meta.get("slot", 0) if slot is None else slot)
    reply = _slot_action(model_id, target, "restore", router_port, name)
    meta = {
        **meta,
        "slot": target,
        "restored_at": time.time(),
        "restore_ms": (reply.get("timings") or {}).get("restore_ms"),
    }
    index[name] = meta
    write_contexts(index)
    return meta


def drop_context(name: str) -> dict:
    index = read_contexts()
    meta = index.pop(name, None)
    if meta is None:
        raise RuntimeError(f"no parked context named {name!r}")
    try:
        (slot_save_dir() / name).unlink()
    except OSError:
        pass
    write_contexts(index)
    return {"ok": True, "detail": f"dropped {name}", "context": meta}


def contexts_listing() -> list[dict]:
    """Parked contexts, newest first, each carrying the file's own size so a stale index
    is visible rather than believed."""
    out = []
    directory = slot_save_dir()
    for name, meta in read_contexts().items():
        path = directory / name
        out.append({**meta, "on_disk": path.exists(), "disk_bytes": file_size(str(path))})
    out.sort(key=lambda m: m.get("saved_at") or 0, reverse=True)
    return out


def _resume_when_ready(model_id: str, router_port: int) -> None:
    """Read the parked context back once the child answers.

    Off the request path: POST /models/load returns while the weights are still coming
    up, so the slot API refuses everything until the child is ready — and /slots is the
    cheapest call that says it is.
    """
    name = parked_name(model_id)
    if name not in read_contexts():
        return
    deadline = time.time() + 900
    while time.time() < deadline:
        time.sleep(2.0)
        if _llama_child(model_id, router_port) and slot_list(model_id, router_port) is not None:
            try:
                restore_context(router_port, name)
            except Exception:  # noqa: BLE001 - resuming is an optimisation, never a failure
                pass
            return


def _slot_tokens(slots: list) -> int:
    """How many tokens the busiest slot is holding.

    `n_prompt_tokens` is what the child reports as the slot's context length, and it is
    the only reliable signal here: `is_processing` misses short requests, the log grows
    continuously whether or not anyone is talking, and /metrics is 501 in this build.
    """
    return max((int(s.get("n_prompt_tokens") or 0) for s in slots), default=0)


def _park_watcher(router_port: int) -> None:
    """Snapshot a conversation once it has gone quiet.

    Watches the slot's token count rather than activity: a request that finishes in
    300 ms lands entirely between two polls, so anything transient is invisible, and a
    counter that has stopped moving is the same evidence without the race.  A snapshot
    is taken when the count has been unchanged for `quiet_seconds` and differs from the
    last one written — so a model nobody is talking to is never re-serialised, and a
    conversation that grew is always captured.
    """
    seen: dict[str, int] = {}
    stable_since: dict[str, float] = {}
    while True:
        try:
            time.sleep(PARK_POLL_SECONDS)
            policy = read_parking()
            if not policy.get("park_on_idle"):
                continue
            quiet = float(policy.get("quiet_seconds") or 120)
            active = _active_llama_models(router_port)

            for mid in list(seen):
                if mid not in active:  # unloaded: forget the history with it
                    seen.pop(mid, None)
                    stable_since.pop(mid, None)

            parked = read_contexts()
            for mid in sorted(active):
                slots = slot_list(mid, router_port)
                if slots is None or any(s.get("is_processing") for s in slots):
                    continue
                count = _slot_tokens(slots)
                if count != seen.get(mid):
                    seen[mid] = count
                    stable_since[mid] = time.time()
                    continue
                if count <= 0 or time.time() - stable_since.get(mid, 0.0) < quiet:
                    continue
                if (parked.get(parked_name(mid)) or {}).get("tokens") == count:
                    continue  # already have exactly this context
                try:
                    park_context(router_port, mid)
                except Exception:  # noqa: BLE001 - retried at the next quiet point
                    pass
        except Exception:  # noqa: BLE001 - the watcher has to outlive any single failure
            pass


# ------------------------------------------------------------------------ logging

def _tail(path: Path, lines: int) -> str:
    try:
        with path.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - 65536))
            chunk = fh.read().decode("utf-8", "replace")
    except OSError:
        return ""
    return "\n".join(chunk.splitlines()[-lines:])


def log_tail(lines: int) -> str:
    return _tail(LOG, lines)


def cat_log_tail(lines: int) -> str:
    return _tail(CAT_LOG, lines)


# ---------------------------------------------------------------------------- http

class Handler(BaseHTTPRequestHandler):
    server_version = "llama-vram-manager"
    protocol_version = "HTTP/1.1"
    router_port = 8080
    ui_port = 8090

    def log_message(self, fmt, *args):  # keep the terminal quiet
        pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload, code: int = 200) -> None:
        self._send(code, json.dumps(payload).encode(), "application/json")

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except ValueError:
            return {}

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            try:
                html = (APP_DIR / "index.html").read_bytes()
            except OSError:
                self._send(500, b"index.html missing", "text/plain")
                return
            self._send(200, html, "text/html; charset=utf-8")
        elif path == "/api/state":
            self._json(snapshot(self.router_port, self.ui_port))
        elif path == "/api/contexts":
            self._json({"parking": read_parking(), "contexts": contexts_listing()})
        elif path == "/api/slm":
            self._json(slm_status())
        elif path == "/api/log":
            engine = (self.path.split("engine=", 1)[1].split("&")[0] if "engine=" in self.path else "llama")
            if engine == "slm":
                self._json({"log": _tail(SLM_LOG, 200)})
            elif engine == "1cat":
                self._json({"log": cat_log_tail(200)})
            elif engine == "stock":
                self._json({"log": stock_log_tail(200)})
            else:
                self._json({"log": log_tail(200)})
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        body = self._body()
        try:
            if path == "/api/load":
                result = load_model(
                    body.get("model", ""), self.router_port, resume=bool(body.get("resume", True))
                )
                self._json({"ok": True, "detail": result.get("detail", "loading")})
            elif path == "/api/unload":
                result = unload_model(body.get("model", ""), self.router_port)
                self._json({"ok": True, "detail": result.get("detail", "unloaded")})
            elif path == "/api/context/park":
                meta = park_context(
                    self.router_port,
                    body.get("model", ""),
                    body.get("name") or None,
                    int(body.get("slot", 0)),
                )
                self._json({"ok": True, "detail": f"parked {meta['tokens']} tokens", "context": meta})
            elif path == "/api/context/restore":
                meta = restore_context(
                    self.router_port, body.get("name", ""), body.get("slot")
                )
                self._json({"ok": True, "detail": f"restored {meta['tokens']} tokens", "context": meta})
            elif path == "/api/context/drop":
                self._json(drop_context(body.get("name", "")))
            elif path == "/api/server/start":
                # "start the server" means the llama.cpp engine owns the port again.
                if cat_pid() is not None:
                    cat_stop()
                if stock_pid() is not None:
                    stock_stop()
                self._json(start_router(self.router_port))
            elif path == "/api/server/stop":
                detail = stop_router(self.router_port).get("detail", "stopped")
                if cat_pid() is not None:
                    detail += "; " + cat_stop().get("detail", "")
                if stock_pid() is not None:
                    detail += "; " + stock_stop().get("detail", "")
                self._json({"ok": True, "detail": detail})
            elif path == "/api/slm/load":
                self._json(slm_load(
                    body.get("model", ""),
                    body.get("device") or "cuda:1",
                    int(body.get("ctx") or 8192),
                    int(body.get("gpuFreeMiB", 2048)),
                    int(body.get("threads") or 4),
                ))
            elif path == "/api/slm/unload":
                self._json(slm_unload())
            elif path == "/api/vram/force-clear":
                # The hammer: empty the V100 of every model engine, strays included.
                self._json(force_clear_vram(self.router_port))
            else:
                self._send(404, b"not found", "text/plain")
        except Exception as exc:  # noqa: BLE001 - the UI displays this text
            self._json({"ok": False, "error": str(exc)}, 502)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ui-port", type=int, default=8090)
    ap.add_argument("--router-port", type=int, default=8080)
    ap.add_argument(
        "--no-start-router",
        action="store_true",
        help="serve the UI only; do not start llama-server",
    )
    args = ap.parse_args()

    if not PRESET.exists():
        print(f"missing preset file: {PRESET}", file=sys.stderr)
        return 1

    Handler.router_port = args.router_port
    Handler.ui_port = args.ui_port
    httpd = ThreadingHTTPServer(("127.0.0.1", args.ui_port), Handler)

    def sampler() -> None:
        """Keep measuring peaks even with no page open; one nvidia-smi per 5 s."""
        while True:
            try:
                snapshot(args.router_port, args.ui_port)
            except Exception:  # noqa: BLE001 - a failed sample must not kill the loop
                pass
            time.sleep(5)

    threading.Thread(target=sampler, daemon=True).start()
    # Off the request path, like the sampler: this never loads anything, it only watches
    # what is already resident and writes a context down once it has gone quiet.
    threading.Thread(target=_park_watcher, args=(args.router_port,), daemon=True).start()

    # The manager owns the server it manages: bring llama-server up before announcing
    # the URL, so the address printed below is always a page that can load a model.
    # Bringing the router up loads nothing — see the module docstring.
    started_by_us = False
    if args.no_start_router:
        detail = "not started (--no-start-router)"
    else:
        try:
            result = start_router(args.router_port)
            detail = result["detail"]
            started_by_us = bool(result.get("started"))
        except Exception as exc:  # noqa: BLE001 - reported to the terminal, never fatal
            detail = f"not started: {exc}"

    def shutdown(_signum, _frame):
        raise SystemExit(0)

    # Ctrl-C, `kill`, or the terminal window closing: all three take the model server
    # down with the page, so neither the port nor the V100 outlives the window it was
    # started from.  A router this process did not start is left alone.
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, shutdown)

    print(f"llama server   http://localhost:{args.router_port}   {detail}")
    print(f"model manager  http://localhost:{args.ui_port}")
    print(f"1cat-vllm      {CAT_VLLM}  (presets with `backend = 1cat` take the port over)")
    print(f"stock llama    {STOCK_WRAPPER}  (presets with `backend = stock` take the port over)")
    print("nothing loads by itself — drop a card on the page to put a model on the V100")
    print(f"logs           {LOG}  |  {CAT_LOG}")
    try:
        httpd.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        print("\nstopping…", flush=True)
    finally:
        httpd.server_close()
        if cat_pid() is not None:
            try:
                print("  " + cat_stop()["detail"], flush=True)
            except Exception as exc:  # noqa: BLE001 - best effort on the way out
                print(f"  could not stop 1cat-vllm: {exc}", file=sys.stderr)
        if stock_pid() is not None:
            try:
                print("  " + stock_stop()["detail"], flush=True)
            except Exception as exc:  # noqa: BLE001 - best effort on the way out
                print(f"  could not stop the stock llama-server: {exc}", file=sys.stderr)
        if started_by_us:
            # Last chance for the context: Ctrl-C during an active session would otherwise
            # throw away every token of prefill the V100 is holding.
            try:
                parked = park_active(args.router_port)
                for meta in parked:
                    if meta.get("tokens"):
                        print(f"  parked {meta['tokens']} tokens ({meta['name']})", flush=True)
            except Exception as exc:  # noqa: BLE001 - best effort on the way out
                print(f"  could not park the context: {exc}", file=sys.stderr)
            try:
                print("  " + stop_router(args.router_port)["detail"], flush=True)
            except Exception as exc:  # noqa: BLE001 - best effort on the way out
                print(f"  could not stop the router: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
