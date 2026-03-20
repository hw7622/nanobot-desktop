"""HTTP API and static host for the desktop control panel."""

from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from nanobot_desktop_backend.config_manager import dump_runtime_config, ensure_default_config, get_skill_inventory, save_runtime_config
from nanobot_desktop_backend.gateway_manager import GatewayManager
from nanobot_desktop_backend.paths import ensure_dirs, get_config_path, get_data_dir, get_logs_dir
from nanobot_desktop_backend.schemas import build_schema


class DesktopState:
    def __init__(self) -> None:
        ensure_dirs()
        ensure_default_config()
        self.gateway = GatewayManager()
        self.schema = build_schema()

    def bootstrap(self) -> dict[str, Any]:
        return {
            "meta": {
                "appName": "Nanobot Desktop",
                "desktopVersion": "0.1.0",
                "nanobotVersion": read_nanobot_version(),
                "configPath": str(get_config_path()),
                "dataDir": str(get_data_dir()),
                "logsDir": str(get_logs_dir()),
            },
            "schema": self.schema,
            "config": dump_runtime_config(),
            "skills": get_skill_inventory(),
            "status": self.gateway.status(),
        }


class DesktopRequestHandler(BaseHTTPRequestHandler):
    state: DesktopState
    ui_root = Path(__file__).resolve().parents[2] / "ui"

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self._json({"ok": True})
            return
        if parsed.path == "/api/bootstrap":
            self._json(self.state.bootstrap())
            return
        if parsed.path == "/api/logs":
            self._json(self._read_logs(parsed.query))
            return
        self._serve_static(parsed.path)

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/config":
            self._json({"error": "not_found"}, status=HTTPStatus.NOT_FOUND)
            return
        payload = self._read_json_body()
        if payload is None:
            return
        saved = save_runtime_config(payload)
        self._json({"ok": True, "config": saved, "skills": get_skill_inventory()})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/gateway/start":
            self._json({"ok": True, "status": self.state.gateway.start()})
            return
        if parsed.path == "/api/gateway/stop":
            self._json({"ok": True, "status": self.state.gateway.stop()})
            return
        if parsed.path == "/api/gateway/restart":
            self._json({"ok": True, "status": self.state.gateway.restart()})
            return
        self._json({"error": "not_found"}, status=HTTPStatus.NOT_FOUND)

    def log_message(self, format: str, *args: Any) -> None:
        logging.getLogger("nanobot_desktop.http").info("%s - %s", self.address_string(), format % args)

    def _serve_static(self, request_path: str) -> None:
        relative = "index.html" if request_path in ("", "/") else request_path.lstrip("/")
        target = (self.ui_root / relative).resolve()
        if not str(target).startswith(str(self.ui_root.resolve())) or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data = target.read_bytes()
        content_type, _ = mimetypes.guess_type(target.name)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json_body(self) -> dict[str, Any] | None:
        content_length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = self.rfile.read(content_length) if content_length else b"{}"
            return json.loads(payload.decode("utf-8"))
        except json.JSONDecodeError:
            self._json({"error": "invalid_json"}, status=HTTPStatus.BAD_REQUEST)
            return None

    def _read_logs(self, raw_query: str) -> dict[str, Any]:
        query = parse_qs(raw_query)
        name = query.get("name", ["gateway"])[0]
        lines = max(10, min(int(query.get("lines", ["200"])[0]), 1000))
        log_path = get_logs_dir() / f"{name}.log"
        if not log_path.exists():
            return {"name": name, "lines": [], "path": str(log_path)}
        text = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        return {"name": name, "lines": text[-lines:], "path": str(log_path)}

    def _json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def read_nanobot_version() -> str:
    init_path = Path(__file__).resolve().parents[3] / "nanobot" / "__init__.py"
    if not init_path.exists():
        return "unknown"
    match = re.search(r'__version__\s*=\s*"([^"]+)"', init_path.read_text(encoding="utf-8", errors="replace"))
    return match.group(1) if match else "unknown"


def build_server(host: str, port: int) -> ThreadingHTTPServer:
    state = DesktopState()

    class Handler(DesktopRequestHandler):
        pass

    Handler.state = state
    return ThreadingHTTPServer((host, port), Handler)


def configure_logging() -> None:
    ensure_dirs()
    log_file = get_logs_dir() / "desktop.log"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=[logging.FileHandler(log_file, encoding="utf-8"), logging.StreamHandler()],
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Nanobot desktop backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18791)
    args = parser.parse_args()

    configure_logging()
    server = build_server(args.host, args.port)
    logging.getLogger("nanobot_desktop").info("Starting Nanobot Desktop backend on http://%s:%s", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
