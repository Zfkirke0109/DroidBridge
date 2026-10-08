"""Serve the local-only practice page after an explicit --serve opt-in."""

from __future__ import annotations

import argparse
import socket
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


DEFAULT_PORT = 18439
MCP_PORTS = {18765, 18766}


class FixtureHandler(BaseHTTPRequestHandler):
    server_version = "DroidBridgeFixture/1"
    sys_version = ""

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(2.0)

    def handle(self) -> None:
        try:
            super().handle()
        except (socket.timeout, ConnectionError):
            # Idle or disconnected clients must not hold a request thread open.
            return

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if urlsplit(self.path).path not in ("/", "/index.html"):
            self.send_error(404)
            return
        body = self.server.fixture_body
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        # Keep the local log small and avoid writing client addresses or headers.
        print("fixture request:", fmt % args)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serve", action="store_true", help="explicitly start the bounded local server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--max-seconds", type=int, default=120)
    parser.add_argument("--file", type=Path, required=True, help="the one static fixture file to serve")
    args = parser.parse_args()

    if not args.serve:
        print("PREPARED_NOT_EXECUTED: pass --serve only during an authorized test.")
        return 0
    if not args.file.is_file() or not 0 < args.file.stat().st_size <= 16384:
        parser.error("fixture file must exist and contain at most 16 KiB")
    if not (1025 <= args.port <= 65535) or args.port in MCP_PORTS:
        parser.error("port must be an unprivileged port outside the MCP ports")
    if not (1 <= args.max_seconds <= 180):
        parser.error("max-seconds must be between 1 and 180")

    server = ThreadingHTTPServer(("127.0.0.1", args.port), FixtureHandler)
    server.fixture_body = args.file.read_bytes()
    server.daemon_threads = True
    server.block_on_close = False
    server.timeout = 0.25
    deadline = time.monotonic() + args.max_seconds
    print(f"Serving only {args.file.name} at http://127.0.0.1:{args.port}/ for at most {args.max_seconds}s.")
    print("Press Ctrl+C to stop earlier; the hard time limit closes the listener.")
    try:
        while time.monotonic() < deadline:
            server.handle_request()
    except KeyboardInterrupt:
        print("Fixture server stopped by operator.")
    finally:
        server.server_close()
    print("Fixture server closed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
