#!/usr/bin/env python3
"""llama-toolfilter — remove named tools from requests before the router sees them.

The router has no tool deny-list.  It renders the `tools` array the client sent,
and (for the Qwen3-Coder parser) it generates the tool-call grammar from that same
array — so a tool that is absent from `tools` is both invisible in the prompt and
unrepresentable in the grammar.  That is the only hard, server-side enforcement
point: filter the request body.  A chat-template filter would hide the tool from the
prompt but leave it in the grammar.

This relay sits on loopback in front of the router and deletes `tools[]` entries
whose `function.name` is in the strip set.  Everything else — paths, headers,
status, streaming framing — is passed through exactly.  Point a harness's baseUrl at
it (see toolfilter.json) and the model can no longer call those tools, including
from subagents, because every request takes this path.

    llama-toolfilter                 start (foreground)
    llama-toolfilter --strip task    override the strip set
    llama-toolfilter --port N        override the port

Config: ~/.local/share/llama-v100/toolfilter.json.  Defaults: 127.0.0.1:8101 ->
http://127.0.0.1:8080, strip `task`.
"""

from __future__ import annotations

import argparse
import http.client
import http.server
import json
import os
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

APP_DIR = Path(__file__).resolve().parent
CONFIG = APP_DIR / "toolfilter.json"
DEFAULT_LOG = APP_DIR / "logs" / "toolfilter.log"
MAX_BODY = 64 * 1024 * 1024
HOP_BY_HOP = frozenset(
    "connection keep-alive proxy-authenticate proxy-authorization te trailer "
    "transfer-encoding upgrade".split()
)

CFG: argparse.Namespace
_log_lock = threading.Lock()


def log(line: str) -> None:
    text = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n"
    with _log_lock:
        try:
            CFG.log.parent.mkdir(parents=True, exist_ok=True)
            with CFG.log.open("a", encoding="utf-8") as fh:
                fh.write(text)
        except OSError:
            pass
    print(text, end="", file=sys.stderr, flush=True)


class BadRequest(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def strip_tools(payload: bytes) -> tuple[bytes, list[str]]:
    """Return (possibly rewritten body, names removed).

    Only a JSON object carrying a `tools` array is touched.  A body that does not
    parse, or a request with no tools, is forwarded byte-for-byte.
    """
    try:
        body = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        return payload, []
    if not isinstance(body, dict):
        return payload, []
    tools = body.get("tools")
    if not isinstance(tools, list):
        return payload, []

    kept, removed = [], []
    for entry in tools:
        name = ""
        if isinstance(entry, dict):
            fn = entry.get("function")
            if isinstance(fn, dict):
                name = fn.get("name") or ""
            if not name:
                name = entry.get("name") or ""
        if name in CFG.strip:
            removed.append(str(name))
        else:
            kept.append(entry)

    if not removed:
        return payload, []

    if kept:
        body["tools"] = kept
    else:
        body.pop("tools", None)
        # A forced call to a tool that no longer exists would 400 or invent arguments.
        if body.get("tool_choice") not in (None, "none", "auto"):
            body["tool_choice"] = "none"

    choice = body.get("tool_choice")
    if isinstance(choice, dict):
        fn = choice.get("function")
        if isinstance(fn, dict) and fn.get("name") in CFG.strip:
            body["tool_choice"] = "none"
    elif isinstance(choice, str) and choice in CFG.strip:
        body["tool_choice"] = "none"

    return json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode(), removed


class Filter(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "llama-toolfilter"
    sys_version = ""

    wrote_headers = False

    def forward(self) -> None:
        start = time.monotonic()
        status = 0
        size = 0
        note = ""
        removed: list[str] = []
        conn = None
        self.wrote_headers = False
        try:
            body = self.read_body()
            if body and self.path.startswith("/v1/") and "json" in (
                self.headers.get("Content-Type") or ""
            ).lower():
                body, removed = strip_tools(body)
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
            mark = f"  [stripped {','.join(removed)}]" if removed else ""
            log(
                f"{self.client_address[0]}:{self.client_address[1]:<5} {self.command:<7} "
                f"{self.path}  {status}  {size:>8} B  {time.monotonic() - start:6.2f}s"
                + mark + (f"  [{note}]" if note else "")
            )

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = forward

    # ------------------------------------------------------------------ request side

    def upstream_target(self) -> str:
        target = self.path
        if target[:7] in ("http://", "https://"):
            split = urlsplit(target)
            target = split.path + (f"?{split.query}" if split.query else "")
        return target or "/"

    def upstream_headers(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for name, value in self.headers.items():
            low = name.lower()
            if low in HOP_BY_HOP or low in ("host", "content-length"):
                continue
            out[name] = value
        out["Host"] = CFG.upstream_netloc
        return out

    def read_body(self) -> bytes | None:
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            return self.read_chunked()
        raw = self.headers.get("Content-Length")
        if raw is None:
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
                    pass
                return bytes(out)
            if len(out) + size > MAX_BODY:
                raise BadRequest(413, f"request body over {MAX_BODY} bytes")
            out += self.rfile.read(size)
            self.rfile.read(2)

    # ----------------------------------------------------------------- response side

    def relay(self, resp: http.client.HTTPResponse) -> int:
        length = resp.getheader("Content-Length")
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
            piece = resp.read1(65536)
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
            {"error": {"message": message, "type": "toolfilter_error", "code": status}}
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

    def log_message(self, fmt: str, *args) -> None:
        pass  # the one line in forward() is the access log


def load_config() -> dict:
    defaults = {
        "listen": "127.0.0.1",
        "port": 8101,
        "upstream": "http://127.0.0.1:8080",
        "strip": ["task"],
        "log": str(DEFAULT_LOG),
        "timeout": 3600,
    }
    try:
        defaults.update(json.loads(CONFIG.read_text()))
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as exc:
        raise SystemExit(f"toolfilter: cannot read {CONFIG}: {exc}")
    return defaults


def main(argv: list[str] | None = None) -> int:
    global CFG
    conf = load_config()
    ap = argparse.ArgumentParser(description="Strip named tools from llama.cpp requests.")
    ap.add_argument("--listen", default=conf["listen"])
    ap.add_argument("--port", type=int, default=conf["port"])
    ap.add_argument("--upstream", default=conf["upstream"])
    ap.add_argument("--strip", default=",".join(conf["strip"]),
                    help="comma-separated tool names to remove (default: task)")
    ap.add_argument("--log", default=conf["log"])
    ap.add_argument("--timeout", type=int, default=conf["timeout"],
                    help="upstream socket timeout seconds; 0 waits forever")
    args = ap.parse_args(argv)

    split = urlsplit(args.upstream)
    if split.scheme != "http" or not split.hostname:
        raise SystemExit(f"toolfilter: --upstream must be an http:// URL, got {args.upstream!r}")
    CFG = argparse.Namespace(
        listen=args.listen,
        port=args.port,
        upstream=args.upstream,
        upstream_host=split.hostname,
        upstream_port=split.port or 80,
        upstream_netloc=split.netloc,
        strip={name.strip() for name in args.strip.split(",") if name.strip()},
        log=Path(args.log),
        timeout=args.timeout or None,
    )
    if not CFG.strip:
        raise SystemExit("toolfilter: empty --strip set")

    server = http.server.ThreadingHTTPServer((CFG.listen, CFG.port), Filter)
    server.daemon_threads = True
    log(
        f"listening http://{CFG.listen}:{CFG.port} -> {CFG.upstream}  "
        f"strip={sorted(CFG.strip)}"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
