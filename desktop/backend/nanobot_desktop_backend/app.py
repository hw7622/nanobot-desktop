"""HTTP API and static host for the desktop control panel."""

from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import os
import re
import subprocess
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from nanobot.config.schema import Config
from nanobot.session.manager import SessionManager
from nanobot_desktop_backend.chat_manager import ChatManager
from nanobot_desktop_backend.config_manager import (
    create_workspace_skill,
    delete_workspace_skill,
    dump_runtime_config,
    ensure_default_config,
    get_skill_inventory,
    get_workspace_skills_dir,
    load_runtime_config,
    save_runtime_config,
)
from nanobot_desktop_backend.gateway_manager import GatewayManager
from nanobot_desktop_backend.paths import ensure_dirs, get_config_path, get_data_dir, get_logs_dir, get_workspace_dir
from nanobot_desktop_backend.schemas import build_schema


class DesktopState:
    def __init__(self) -> None:
        ensure_dirs()
        ensure_default_config()
        self.gateway = GatewayManager()
        self.chat = ChatManager()
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
                "workspaceDir": str(get_workspace_dir()),
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
        if parsed.path == "/api/chat/history":
            self._json({"ok": True, "items": self.state.chat.history()})
            return
        if parsed.path == "/api/sessions":
            self._json({"ok": True, "items": list_sessions()})
            return
        if parsed.path == "/api/session":
            key = parse_qs(parsed.query).get("key", [""])[0]
            self._json({"ok": True, **load_session_payload(key)})
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
        if parsed.path == "/api/chat/send":
            payload = self._read_json_body()
            if payload is None:
                return
            try:
                result = self.state.chat.send(str(payload.get("content") or ""))
            except ValueError as error:
                self._json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
                return
            except Exception as error:
                logging.getLogger("nanobot_desktop.chat").exception("Desktop chat failed")
                self._json({"error": str(error)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
                return
            self._json({"ok": True, **result})
            return
        if parsed.path == "/api/chat/clear":
            self._json({"ok": True, "items": self.state.chat.clear()})
            return
        if parsed.path == "/api/skill/create":
            payload = self._read_json_body()
            if payload is None:
                return
            try:
                created = create_workspace_skill(str(payload.get("name") or ""))
            except ValueError as error:
                self._json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
                return
            self._json({"ok": True, "created": created, "skills": get_skill_inventory()})
            return
        if parsed.path == "/api/skill/delete":
            payload = self._read_json_body()
            if payload is None:
                return
            try:
                delete_workspace_skill(str(payload.get("name") or ""))
            except ValueError as error:
                self._json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
                return
            self._json({"ok": True, "skills": get_skill_inventory()})
            return
        if parsed.path == "/api/open":
            payload = self._read_json_body()
            if payload is None:
                return
            target_name = str(payload.get("target") or "")
            target = {
                "config": get_config_path(),
                "logs": get_logs_dir(),
                "workspace": get_workspace_dir(),
                "skills": get_workspace_skills_dir(),
            }.get(target_name)
            if not target:
                self._json({"error": "unsupported_target"}, status=HTTPStatus.BAD_REQUEST)
                return
            try:
                open_path(target)
            except Exception as error:
                self._json({"error": str(error)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
                return
            self._json({"ok": True, "path": str(target)})
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
        archives = sorted(str(path) for path in get_logs_dir().glob(f"{name}.*.log"))
        return {"name": name, "lines": text[-lines:], "path": str(log_path), "archives": archives}

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
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    rotating = RotatingFileHandler(log_file, maxBytes=500_000, backupCount=3, encoding="utf-8")
    rotating.setFormatter(formatter)
    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    root.addHandler(rotating)
    root.addHandler(stream)


def list_sessions() -> list[dict[str, Any]]:
    cfg = Config.model_validate(load_runtime_config())
    manager = SessionManager(cfg.workspace_path)
    sessions = [serialize_session_summary(item) for item in manager.list_sessions()]
    if not any(item["key"] == ChatManager.SESSION_KEY for item in sessions):
        sessions.insert(0, {
            "key": ChatManager.SESSION_KEY,
            "channel": "desktop",
            "chatId": "console",
            "title": "桌面测试聊天",
            "subtitle": "本地测试会话",
            "updatedAt": None,
            "path": str(cfg.workspace_path / "sessions"),
            "readonly": False,
        })
    return sessions


def load_session_payload(key: str) -> dict[str, Any]:
    session_key = (key or "").strip() or ChatManager.SESSION_KEY
    cfg = Config.model_validate(load_runtime_config())
    manager = SessionManager(cfg.workspace_path)
    session = manager.get_or_create(session_key)
    return {
        "session": serialize_session_summary({"key": session_key, "updated_at": session.updated_at.isoformat() if session.messages else None, "path": str(cfg.workspace_path / "sessions")}),
        "items": [serialize_session_message(message) for message in session.messages],
    }


def serialize_session_summary(item: dict[str, Any]) -> dict[str, Any]:
    key = str(item.get("key") or "")
    channel, _, chat_id = key.partition(":")
    title, subtitle = session_title(channel, chat_id)
    return {
        "key": key,
        "channel": channel or "unknown",
        "chatId": chat_id,
        "title": title,
        "subtitle": subtitle,
        "updatedAt": item.get("updated_at") or item.get("updatedAt"),
        "path": item.get("path", ""),
        "readonly": key != ChatManager.SESSION_KEY,
    }


def session_title(channel: str, chat_id: str) -> tuple[str, str]:
    if channel == "desktop":
        return "桌面测试聊天", "本地测试会话"
    if not chat_id:
        return channel or "会话", ""
    if "|" in chat_id:
        primary, _, alias = chat_id.partition("|")
        return f"{channel} · {alias or primary}", primary
    return f"{channel} · {chat_id}", chat_id


def serialize_session_message(message: dict[str, Any]) -> dict[str, Any]:
    content = message.get("content", "")
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if text:
                    parts.append(str(text))
            elif item:
                parts.append(str(item))
        text = "\n".join(parts)
    elif isinstance(content, dict):
        text = json.dumps(content, ensure_ascii=False, indent=2)
    else:
        text = str(content)
    return {
        "role": str(message.get("role") or "assistant"),
        "content": text,
        "timestamp": message.get("timestamp", ""),
        "name": message.get("name", ""),
    }


def open_path(target: Path) -> None:
    target = target.resolve()
    if sys.platform == "win32":
        os.startfile(target)  # type: ignore[attr-defined]
        return
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(target)])
        return
    subprocess.Popen(["xdg-open", str(target)])


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
