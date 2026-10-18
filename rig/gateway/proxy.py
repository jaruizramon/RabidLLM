#!/usr/bin/env python3
"""llama-proxy — the tailnet front door to the V100 router.

The router that `llama-manager` starts (llama-server in router mode, §14/§17 of
~/Desktop/local-qwen-on-v100.md) listens on 127.0.0.1:8080 and carries no API key:
loopback is the entire access-control story.  This is the one surface that leaves the
box.  It binds the Tailscale address and relays to that loopback router unchanged, so
a laptop on the tailnet speaks the same paths, the same model ids and the same
streaming protocol the box itself uses:

    laptop   http://<tailnet-ip>:8080/v1/chat/completions
    router   127.0.0.1:8080/v1/chat/completions

Method, path, query, body, status and headers cross in both directions; the only
things not passed on are the hop-by-hop framing headers, which are re-derived here.
A streaming completion is relayed with `read1()` and re-framed chunk by chunk — never
buffered to EOF — so tokens leave the moment the V100 emits them.  (`resp.read(n)`
would be the bug: it blocks until n bytes or EOF, turning a token stream into one
lump delivered when the answer ends.)

Invoked through ~/.local/bin/llama-proxy:

    llama-proxy                 bind the tailnet address, relay to the router
    llama-proxy stop            INT first, as this build needs
    llama-proxy status          what is bound, and what the upstream answers
    llama-proxy logs            follow the access log

Policy, deliberately:
  * the bind address is the tailnet IPv4, never 0.0.0.0 — the tailnet is the
    boundary, so nothing is reachable from the LAN or the WAN even while this runs;
  * no token by default (Tailscale already authenticates the device); `--token`
    adds a bearer check for a tailnet you share, and is then consumed here rather
    than forwarded;
  * the manager's UI on 8090 is *not* exposed — this proxy serves the model API only.
"""

from __future__ import annotations

import argparse
import hmac
import http.client
import http.server
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

APP_DIR = Path(__file__).resolve().parent
LOGS = APP_DIR / "logs"
LOG = LOGS / "proxy.log"
STATE = APP_DIR / "proxy.json"

DEFAULT_PORT = 8080  # the router's own port; a tailnet address does not collide with its loopback one
DEFAULT_UPSTREAM = "http://127.0.0.1:8080"  # the manager's SERVER_PORT
MAX_BODY = 64 * 1024 * 1024  # a 256K-token prompt is ~1-2 MiB; this is a guard, not a budget
HOP_BY_HOP = frozenset(
    "connection keep-alive proxy-authenticate proxy-authorization te trailer "
    "transfer-encoding upgrade".split()
)

CFG: argparse.Namespace  # built in main(), read by the request handler
_log_lock = threading.Lock()


# --------------------------------------------------------------------------- output

def log(line: str) -> None:
    text = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n"
    with _log_lock:
        try:
            LOGS.mkdir(parents=True, exist_ok=True)
            with LOG.open("a", encoding="utf-8") as fh:
                fh.write(text)
        except OSError:
            pass
        sys.stderr.write(text)


def say(line: str) -> None:
    print(f"llama-proxy: {line}")


def die(message: str) -> None:
    sys.stderr.write(f"llama-proxy: {message}\n")
    raise SystemExit(1)


def _terminate(*_: object) -> None:
    """SIGTERM → the same clean unwind Ctrl-C gets (state file removed, port released)."""
    raise SystemExit(0)


# ---------------------------------------------------------------------------- state

def read_state() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {}


def write_state(state: dict) -> None:
    try:
        STATE.write_text(json.dumps(state, indent=2) + "\n")
    except OSError:
        pass


def clear_state() -> None:
    STATE.unlink(missing_ok=True)


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def tailnet_ipv4() -> str | None:
    """The box's own Tailscale address, or None when there is no tailnet here."""
    exe = shutil.which("tailscale")
    if exe is None:
        return None
    try:
        out = subprocess.run(
            [exe, "ip", "-4"], capture_output=True, text=True, timeout=5, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    for word in out.stdout.split():
        if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", word):
            return word
    return None


# ---------------------------------------------------------------------------- proxy

class BadRequest(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class Proxy(http.server.BaseHTTPRequestHandler):
    """One request in, one request out — nothing rewritten but the framing."""

    protocol_version = "HTTP/1.1"
    server_version = "llama-proxy"
    sys_version = ""

    wrote_headers = False

    def forward(self) -> None:
        start = time.monotonic()
        status = 0
        size = 0
        note = ""
        conn = None
        # One handler instance serves every request on a keep-alive connection, so this
        # must be per-request: a stale True would make the *next* request's upstream
        # failure skip its 502 and hang the client instead.
        self.wrote_headers = False
        try:
            if not self.authorized():
                status = 401
                self.fail(401, "missing or wrong bearer token")
                return
            body = self.read_body()
            conn = http.client.HTTPConnection(
                CFG.upstream_host, CFG.upstream_port, timeout=CFG.timeout
            )
            conn.request(
                self.command,
                self.upstream_target(),
                body=body,
                headers=self.upstream_headers(),
            )
            resp = conn.getresponse()
            status = resp.status
            size = self.relay(resp)
        except BadRequest as exc:
            status = exc.status
            self.fail(exc.status, str(exc))
        except (BrokenPipeError, ConnectionResetError):
            note = "client hung up mid-relay"
        except (OSError, http.client.HTTPException) as exc:
            note = f"upstream: {exc}"
            if not self.wrote_headers:
                status = 502
                self.fail(502, f"upstream {CFG.upstream} unreachable: {exc}")
            else:
                note += " (after headers were sent)"
        finally:
            if conn is not None:
                conn.close()
            log(
                f"{self.peer():>21}  {self.command:<7} {self.path}  {status}  "
                f"{size:>8} B  {time.monotonic() - start:6.2f}s"
                + (f"  [{note}]" if note else "")
            )

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = forward

    # ------------------------------------------------------------------ request side

    def authorized(self) -> bool:
        if CFG.token is None:
            return True
        header = self.headers.get("Authorization") or ""
        given = header[7:].strip() if header[:7].lower() == "bearer " else ""
        if not given:
            given = (self.headers.get("X-Api-Key") or "").strip()
        return hmac.compare_digest(given, CFG.token)

    def upstream_target(self) -> str:
        target = self.path
        if target[:7] in ("http://", "https://"):  # absolute-form request target
            split = urlsplit(target)
            target = split.path + (f"?{split.query}" if split.query else "")
        return target or "/"

    def upstream_headers(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for name, value in self.headers.items():
            low = name.lower()
            if low in HOP_BY_HOP or low in ("host", "content-length"):
                continue  # framing and routing are re-derived below / by http.client
            if CFG.token is not None and low in ("authorization", "x-api-key"):
                continue  # consumed here; the router has no key of its own
            out[name] = value
        out["Host"] = CFG.upstream_netloc
        return out

    def read_body(self) -> bytes | None:
        """The request body whole, so it can be re-sent with its own framing."""
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            return self.read_chunked()
        raw = self.headers.get("Content-Length")
        if raw is None:
            # GET/HEAD/DELETE carry none; an empty POST should still say so upstream.
            return b"" if self.command in ("POST", "PUT", "PATCH") else None
        try:
            length = int(raw)
        except ValueError:
            raise BadRequest(400, f"bad Content-Length: {raw!r}") from None
        if length < 0:
            raise BadRequest(400, f"bad Content-Length: {raw!r}")
        if length > MAX_BODY:
            raise BadRequest(413, f"request body over {MAX_BODY} bytes")
        return self.rfile.read(length) if length else b""

    def read_chunked(self) -> bytes:
        out = bytearray()
        while True:
            line = self.rfile.readline(128)
            if not line:
                raise BadRequest(400, "truncated chunked body")
            field = line.split(b";", 1)[0].strip()
            try:
                size = int(field, 16)
            except ValueError:
                raise BadRequest(400, f"bad chunk size: {field!r}") from None
            if size == 0:
                while self.rfile.readline(4096) not in (b"", b"\r\n", b"\n"):
                    pass  # trailers
                return bytes(out)
            if len(out) + size > MAX_BODY:
                raise BadRequest(413, f"request body over {MAX_BODY} bytes")
            out += self.rfile.read(size)
            self.rfile.read(2)  # the CRLF that closes the chunk

    # ----------------------------------------------------------------- response side

    def relay(self, resp: http.client.HTTPResponse) -> int:
        length = resp.getheader("Content-Length")
        # An HTTP/1.1 client can take a chunked reply; an HTTP/1.0 one cannot, and gets
        # the stream close-delimited instead.  Either way the body is re-framed here,
        # because upstream's own framing (llama.cpp streams SSE chunked) stops being
        # valid the moment bytes are relayed rather than copied.
        chunked = length is None and self.request_version >= "HTTP/1.1"

        self.send_response_only(resp.status, resp.reason)
        for name, value in resp.getheaders():
            low = name.lower()
            if low in HOP_BY_HOP or low == "content-length":
                continue
            self.send_header(name, value)
        if length is not None:
            self.send_header("Content-Length", length)
        elif chunked:
            self.send_header("Transfer-Encoding", "chunked")
        else:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wrote_headers = True

        if self.command == "HEAD" or resp.status in (204, 304):
            return 0
        total = 0
        while True:
            piece = resp.read1(65536)  # returns what has arrived; read() would wait for 64 KiB
            if not piece:
                break
            total += len(piece)
            if chunked:
                self.wfile.write(b"%x\r\n" % len(piece) + piece + b"\r\n")
            else:
                self.wfile.write(piece)
            self.wfile.flush()
        if chunked:
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        return total

    def fail(self, status: int, message: str) -> None:
        payload = json.dumps(
            {"error": {"message": message, "type": "proxy_error", "code": status}}
        ).encode()
        try:
            self.send_response_only(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wrote_headers = True
            if self.command != "HEAD":
                self.wfile.write(payload)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def peer(self) -> str:
        return f"{self.client_address[0]}:{self.client_address[1]}"

    def log_message(self, fmt: str, *args) -> None:
        log("http   " + fmt % args)  # malformed requests and other stdlib complaints


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True  # a live stream must not hold Ctrl-C hostage
    allow_reuse_address = True


# ------------------------------------------------------------------------ commands

def router_health(upstream: str) -> str:
    split = urlsplit(upstream)
    conn = None
    try:
        conn = http.client.HTTPConnection(split.hostname, split.port or 80, timeout=3)
        conn.request("GET", "/health")
        resp = conn.getresponse()
        resp.read()
        return f"router answering ({resp.status})"
    except (OSError, http.client.HTTPException) as exc:
        return f"router not answering ({exc})"
    finally:
        if conn is not None:
            conn.close()


def cmd_start() -> int:
    state = read_state()
    pid = state.get("pid")
    if isinstance(pid, int) and alive(pid):
        say(f"already running (pid {pid}) — http://{state.get('listen')}:{state.get('port')}")
        return 0

    if CFG.listen == "auto":
        addr = tailnet_ipv4()
        if addr is None:
            die(
                "no Tailscale address — this box is not on a tailnet.\n"
                "  join one once (needs root):\n"
                "      sudo apt-get install -y tailscale && sudo tailscale up\n"
                "  or bind deliberately somewhere else:\n"
                "      llama-proxy --listen 127.0.0.1     (then: tailscale serve)\n"
                "      llama-proxy --listen 0.0.0.0       (LAN, no key — not recommended)"
            )
        CFG.listen = addr
    if CFG.listen == "0.0.0.0":
        say("warning: binding every interface; the router carries no key of its own")

    try:
        server = Server((CFG.listen, CFG.port), Proxy)
    except OSError as exc:
        die(f"cannot bind {CFG.listen}:{CFG.port}: {exc}")

    where = f"http://{CFG.listen}:{CFG.port}"
    write_state(
        {
            "pid": os.getpid(),
            "listen": CFG.listen,
            "port": CFG.port,
            "upstream": CFG.upstream,
            "token": CFG.token is not None,
            "started": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
    )
    say(f"upstream    {CFG.upstream}   {router_health(CFG.upstream)}")
    say(f"listening   {where}   pid {os.getpid()}")
    say(f"laptop      baseUrl {where}/v1")
    say("no token — tailnet membership is the only gate" if CFG.token is None else "bearer token required")
    say(f"log         {LOG}")
    print("Ctrl-C stops it.", file=sys.stderr)

    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print(file=sys.stderr)
    finally:
        server.server_close()
        clear_state()
        say("stopped")
    return 0


def wait_for_exit(pid: int, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not alive(pid):
            return True
        time.sleep(0.1)
    return not alive(pid)


def cmd_stop() -> int:
    pid = read_state().get("pid")
    if not (isinstance(pid, int) and alive(pid)):
        clear_state()
        say("not running")
        return 0
    # INT first for the same reason the manager does it: this rig's threads wind down on
    # KeyboardInterrupt, and SIGTERM's default disposition would cut a live stream instead.
    for sig, patience in (
        (signal.SIGINT, 5.0),
        (signal.SIGTERM, 5.0),
        (signal.SIGKILL, 2.0),
    ):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            break
        if wait_for_exit(pid, patience):
            break
    clear_state()
    if alive(pid):
        die(f"pid {pid} survived SIGKILL")
    say(f"stopped (pid {pid})")
    return 0


def cmd_status() -> int:
    state = read_state()
    pid = state.get("pid")
    if not (isinstance(pid, int) and alive(pid)):
        print("proxy          down")
        print("                start it with: llama-proxy    (after llama-manager)")
        return 0
    where = f"http://{state.get('listen')}:{state.get('port')}"
    print(f"proxy          {where}   up (pid {pid})")
    print(f"upstream       {state.get('upstream')}   {router_health(state.get('upstream'))}")
    print(f"laptop         baseUrl {where}/v1   auth: {'token' if state.get('token') else 'none'}")
    if tailnet_ipv4() is None:
        print("tailnet        not joined — nothing outside this box can reach it yet")
    return 0


def cmd_logs() -> int:
    LOGS.mkdir(parents=True, exist_ok=True)
    LOG.touch()
    os.execvp("tail", ["tail", "-n", "40", "-f", str(LOG)])
    return 0


# ---------------------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    global CFG
    ap = argparse.ArgumentParser(
        prog="llama-proxy",
        description="Relay the loopback llama.cpp router onto the tailnet.",
        epilog="The router stays on 127.0.0.1: start it with llama-manager.",
    )
    ap.add_argument(
        "command", nargs="?", default="start", choices=("start", "stop", "status", "logs")
    )
    ap.add_argument(
        "--listen",
        default="auto",
        metavar="ADDR",
        help="address to bind (default: this box's Tailscale IPv4)",
    )
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port to bind (default {DEFAULT_PORT})")
    ap.add_argument(
        "--upstream",
        default=os.environ.get("LLAMA_PROXY_UPSTREAM", DEFAULT_UPSTREAM),
        metavar="URL",
        help=f"loopback router to relay to (default {DEFAULT_UPSTREAM})",
    )
    ap.add_argument(
        "--token",
        default=os.environ.get("LLAMA_PROXY_TOKEN"),
        metavar="SECRET",
        help="require this bearer token (env LLAMA_PROXY_TOKEN); default: none",
    )
    ap.add_argument(
        "--timeout",
        type=float,
        default=0.0,
        metavar="SECONDS",
        help="upstream socket timeout; 0 waits as long as the V100 takes (default)",
    )
    args = ap.parse_args(argv)

    split = urlsplit(args.upstream)
    if split.scheme != "http" or not split.hostname:
        ap.error(f"--upstream must be an http:// URL with a host: {args.upstream!r}")
    if not 1 <= args.port <= 65535:
        ap.error(f"--port out of range: {args.port}")

    CFG = argparse.Namespace(
        listen=args.listen,
        port=args.port,
        upstream=args.upstream,
        upstream_host=split.hostname,
        upstream_port=split.port or 80,
        upstream_netloc=split.netloc,
        token=args.token,
        timeout=args.timeout or None,
    )
    signal.signal(signal.SIGTERM, _terminate)
    return {"start": cmd_start, "stop": cmd_stop, "status": cmd_status, "logs": cmd_logs}[
        args.command
    ]()


if __name__ == "__main__":
    raise SystemExit(main())
