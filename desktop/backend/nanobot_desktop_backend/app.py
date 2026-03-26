"""HTTP API and static host for the desktop control panel."""

from __future__ import annotations

import argparse
import ctypes
import json
import logging
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from datetime import datetime
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
    load_core_runtime_config,
    load_runtime_config,
    save_runtime_config,
)
from nanobot_desktop_backend.gateway_manager import GatewayManager
from nanobot_desktop_backend.paths import (
    ensure_dirs,
    get_config_path,
    get_data_dir,
    get_desktop_plugins_dir,
    get_logs_dir,
    get_workspace_dir,
)
from nanobot_desktop_backend.schemas import build_schema
from nanobot_desktop_backend.weixin_manager import WeixinPluginManager


CHANNEL_DISPLAY_NAMES = {
    "desktop": "桌面测试聊天",
    "telegram": "Telegram",
    "weixin": "微信",
    "wecom": "企业微信",
    "feishu": "飞书",
    "dingtalk": "钉钉",
    "email": "Email",
    "qq": "QQ",
}

ANSI_ESCAPE_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
LOG_LINE_TS_RE = re.compile(
    r"^(?:\[(?P<iso>\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?)\]|(?P<plain>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}))"
)
DESKTOP_NOISE_MARKERS = (
    '"GET / HTTP/1.1"',
    '"GET /styles.css HTTP/1.1"',
    '"GET /app.js HTTP/1.1"',
    '"GET /favicon.ico HTTP/1.1"',
    '"GET /api/bootstrap HTTP/1.1"',
    '"GET /api/logs',
    '"GET /api/health HTTP/1.1"',
    '"GET /api/sessions HTTP/1.1"',
    '"GET /api/session?',
)


if sys.platform == "win32":
    _KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
    from ctypes import wintypes

    _USER32 = ctypes.WinDLL("user32", use_last_error=True)
    _HWND_TOPMOST = -1
    _HWND_NOTOPMOST = -2
    _SW_SHOWNORMAL = 1
    _SW_RESTORE = 9
    _EXPLORER_WINDOW_CLASSES = {"CabinetWClass", "ExploreWClass"}
    _SWP_NOSIZE = 0x0001
    _SWP_NOMOVE = 0x0002
    _SWP_NOACTIVATE = 0x0010
    _SWP_SHOWWINDOW = 0x0040


    class _POINT(ctypes.Structure):
        _fields_ = [
            ("x", wintypes.LONG),
            ("y", wintypes.LONG),
        ]


    class _RECT(ctypes.Structure):
        _fields_ = [
            ("left", wintypes.LONG),
            ("top", wintypes.LONG),
            ("right", wintypes.LONG),
            ("bottom", wintypes.LONG),
        ]


    class _WINDOWPLACEMENT(ctypes.Structure):
        _fields_ = [
            ("length", wintypes.UINT),
            ("flags", wintypes.UINT),
            ("showCmd", wintypes.UINT),
            ("ptMinPosition", _POINT),
            ("ptMaxPosition", _POINT),
            ("rcNormalPosition", _RECT),
        ]


    def _iter_visible_windows() -> list[int]:
        handles: list[int] = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def callback(hwnd: int, _lparam: int) -> bool:
            if _USER32.IsWindowVisible(hwnd):
                handles.append(int(hwnd))
            return True

        _USER32.EnumWindows(callback, 0)
        return handles


    def _get_window_process_id(hwnd: int) -> int:
        process_id = wintypes.DWORD()
        _USER32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
        return int(process_id.value)


    def _get_window_class_name(hwnd: int) -> str:
        buffer = ctypes.create_unicode_buffer(256)
        _USER32.GetClassNameW(hwnd, buffer, len(buffer))
        return buffer.value


    def _focus_window(hwnd: int, *, width: int, height: int) -> None:
        screen_width = int(_USER32.GetSystemMetrics(0) or width)
        screen_height = int(_USER32.GetSystemMetrics(1) or height)
        window_width = min(width, max(860, screen_width - 160))
        window_height = min(height, max(640, screen_height - 140))
        left = max(32, (screen_width - window_width) // 2)
        top = max(32, (screen_height - window_height) // 3)
        placement = _WINDOWPLACEMENT()
        placement.length = ctypes.sizeof(_WINDOWPLACEMENT)
        if _USER32.GetWindowPlacement(hwnd, ctypes.byref(placement)):
            placement.showCmd = _SW_SHOWNORMAL
            placement.rcNormalPosition = _RECT(
                left=left,
                top=top,
                right=left + window_width,
                bottom=top + window_height,
            )
            _USER32.SetWindowPlacement(hwnd, ctypes.byref(placement))

        foreground_hwnd = int(_USER32.GetForegroundWindow() or 0)
        current_thread_id = _KERNEL32.GetCurrentThreadId()
        foreground_thread_id = _USER32.GetWindowThreadProcessId(foreground_hwnd, None) if foreground_hwnd else 0

        _USER32.AllowSetForegroundWindow(-1)
        if foreground_thread_id and foreground_thread_id != current_thread_id:
            _USER32.AttachThreadInput(foreground_thread_id, current_thread_id, True)
        try:
            _USER32.ShowWindowAsync(hwnd, _SW_RESTORE)
            _USER32.ShowWindowAsync(hwnd, _SW_SHOWNORMAL)
            _USER32.MoveWindow(hwnd, left, top, window_width, window_height, True)
            _USER32.SetWindowPos(
                hwnd,
                _HWND_TOPMOST,
                0,
                0,
                0,
                0,
                _SWP_NOMOVE | _SWP_NOSIZE | _SWP_SHOWWINDOW,
            )
            _USER32.SetWindowPos(
                hwnd,
                _HWND_NOTOPMOST,
                0,
                0,
                0,
                0,
                _SWP_NOMOVE | _SWP_NOSIZE | _SWP_SHOWWINDOW,
            )
            _USER32.BringWindowToTop(hwnd)
            _USER32.SetForegroundWindow(hwnd)
            _USER32.SetActiveWindow(hwnd)
            _USER32.SetFocus(hwnd)
        finally:
            if foreground_thread_id and foreground_thread_id != current_thread_id:
                _USER32.AttachThreadInput(foreground_thread_id, current_thread_id, False)


    def _wait_for_window(predicate: Any, timeout_s: float = 3.0) -> int | None:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            for hwnd in _iter_visible_windows():
                if predicate(hwnd):
                    return hwnd
            time.sleep(0.1)
        return None


    def _open_path_windows(target: Path) -> None:
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        existing_windows = set(_iter_visible_windows())

        if target.is_file():
            process = subprocess.Popen(
                ["notepad.exe", str(target)],
                creationflags=creationflags,
            )
            hwnd = _wait_for_window(
                lambda candidate: candidate not in existing_windows
                and _get_window_process_id(candidate) == process.pid,
                timeout_s=4.0,
            )
            if hwnd is not None:
                _focus_window(hwnd, width=1120, height=820)
            return

        os.startfile(str(target))
        hwnd = _wait_for_window(
            lambda candidate: candidate not in existing_windows
            and _get_window_class_name(candidate) in _EXPLORER_WINDOW_CLASSES,
            timeout_s=2.5,
        )
        if hwnd is None:
            hwnd = _wait_for_window(
                lambda candidate: candidate == int(_USER32.GetForegroundWindow())
                and _get_window_class_name(candidate) in _EXPLORER_WINDOW_CLASSES,
                timeout_s=1.5,
            )
        if hwnd is not None:
            _focus_window(hwnd, width=1180, height=820)


class DesktopState:
    def __init__(self) -> None:
        ensure_dirs()
        ensure_default_config()
        self.gateway = GatewayManager()
        self.weixin = WeixinPluginManager()
        self.chat = ChatManager()
        self.schema = build_schema()
        self._maybe_start_gateway()
        self._maybe_start_weixin()

    def bootstrap(self) -> dict[str, Any]:
        return {
            "meta": {
                "appName": "Nanobot Desktop",
                "desktopVersion": read_desktop_version(),
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
            "weixin": self.weixin.status(),
        }

    def _maybe_start_gateway(self) -> None:
        try:
            cfg = load_runtime_config()
            auto_start = bool(cfg.get("desktop", {}).get("gateway", {}).get("autoStart", True))
            if auto_start:
                status = self.gateway.start()
                if not status.get("running"):
                    if status.get("note"):
                        logging.getLogger("nanobot_desktop").info(
                            "Gateway auto-start skipped: %s",
                            status.get("note"),
                        )
                    else:
                        logging.getLogger("nanobot_desktop").warning(
                            "Gateway auto-start did not stay running; lastExitCode=%s",
                            status.get("lastExitCode"),
                        )
        except Exception:
            logging.getLogger("nanobot_desktop").exception("Failed to auto-start gateway during desktop bootstrap")

    def _maybe_start_weixin(self) -> None:
        try:
            cfg = load_runtime_config()
            weixin_cfg = cfg.get("channels", {}).get("weixin", {})
            if not isinstance(weixin_cfg, dict):
                return
            if weixin_cfg.get("enabled"):
                status = self.weixin.start_api()
                if status.get("apiRunning") and status.get("loggedIn"):
                    try:
                        self.weixin.proxy_post("/api/weixin/bridge/start")
                    except Exception:
                        logging.getLogger("nanobot_desktop").exception("Failed to auto-start weixin bridge")
        except Exception:
            logging.getLogger("nanobot_desktop").exception("Failed to auto-start weixin plugin during desktop bootstrap")

    def shutdown(self) -> None:
        logger = logging.getLogger("nanobot_desktop")
        try:
            weixin_status = self.weixin.status()
            if weixin_status.get("apiRunning"):
                try:
                    self.weixin.proxy_post("/api/weixin/bridge/stop")
                except Exception:
                    logger.exception("Failed to stop weixin bridge during desktop shutdown")
        except Exception:
            logger.exception("Failed to inspect weixin status during desktop shutdown")

        try:
            self.weixin.stop_api()
        except Exception:
            logger.exception("Failed to stop weixin api during desktop shutdown")

        try:
            self.gateway.stop()
        except Exception:
            logger.exception("Failed to stop gateway during desktop shutdown")


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
        if parsed.path == "/favicon.ico":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
            return
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
        if parsed.path == "/api/weixin/status":
            self._json({"ok": True, "status": self.state.weixin.status()})
            return
        if parsed.path == "/api/weixin/account":
            self._weixin_proxy_get("/api/weixin/account")
            return
        if parsed.path == "/api/weixin/login/status":
            login_id = parse_qs(parsed.query).get("loginId", [""])[0]
            self._weixin_proxy_get("/api/weixin/login/status", {"loginId": login_id})
            return
        if parsed.path == "/api/weixin/bridge/status":
            self._weixin_proxy_get("/api/weixin/bridge/status")
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
        if parsed.path == "/api/shutdown":
            self._json({"ok": True})
            threading.Thread(target=self._shutdown_server, daemon=True).start()
            return
        if parsed.path == "/api/weixin/api/start":
            self._json({"ok": True, "status": self.state.weixin.start_api()})
            return
        if parsed.path == "/api/weixin/api/stop":
            self._json({"ok": True, "status": self.state.weixin.stop_api()})
            return
        if parsed.path == "/api/weixin/login/start":
            self._weixin_proxy_post("/api/weixin/login/start")
            return
        if parsed.path == "/api/weixin/login/confirm":
            payload = self._read_json_body()
            if payload is None:
                return
            self._weixin_proxy_post("/api/weixin/login/confirm", payload)
            return
        if parsed.path == "/api/weixin/bridge/start":
            self._weixin_proxy_post("/api/weixin/bridge/start")
            return
        if parsed.path == "/api/weixin/bridge/stop":
            self._weixin_proxy_post("/api/weixin/bridge/stop")
            return
        if parsed.path == "/api/weixin/bridge/restart":
            self._weixin_proxy_post("/api/weixin/bridge/restart")
            return
        if parsed.path == "/api/weixin/logout":
            self._weixin_proxy_post("/api/weixin/logout")
            return
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
                result = self.state.chat.send(
                    str(payload.get("content") or ""),
                    session_key=str(payload.get("sessionKey") or "").strip() or None,
                    channel=str(payload.get("channel") or ChatManager.CHANNEL_NAME).strip() or ChatManager.CHANNEL_NAME,
                    chat_id=str(payload.get("chatId") or ChatManager.CHAT_ID).strip() or ChatManager.CHAT_ID,
                )
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
        if parsed.path == "/api/session/clear":
            payload = self._read_json_body()
            if payload is None:
                return
            session_key = str(payload.get("key") or "").strip()
            if not session_key:
                self._json({"error": "missing session key"}, status=HTTPStatus.BAD_REQUEST)
                return
            if session_key == ChatManager.SESSION_KEY:
                items = self.state.chat.clear()
                self._json({"ok": True, "session": load_session_payload(session_key)["session"], "items": items})
                return
            self._json({"ok": True, **clear_session_payload(session_key)})
            return
        if parsed.path == "/api/session/delete":
            payload = self._read_json_body()
            if payload is None:
                return
            session_key = str(payload.get("key") or "").strip()
            if not session_key:
                self._json({"error": "missing session key"}, status=HTTPStatus.BAD_REQUEST)
                return
            if session_key == ChatManager.SESSION_KEY:
                self.state.chat.clear()
                self._json({"ok": True, "deleted": False, "reset": True})
                return
            self._json({"ok": True, **delete_session_payload(session_key)})
            return
        if parsed.path == "/api/logs/clear":
            payload = self._read_json_body()
            if payload is None:
                return
            name = str(payload.get("name") or "gateway").strip() or "gateway"
            try:
                self._json({"ok": True, **self._clear_logs(name)})
            except ValueError as error:
                self._json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            except Exception as error:
                self._json({"error": str(error)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
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
                "weixinPlugin": get_desktop_plugins_dir(),
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
        message = format % args
        if any(marker in message for marker in DESKTOP_NOISE_MARKERS):
            return
        logging.getLogger("nanobot_desktop.http").info("%s - %s", self.address_string(), message)

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

    def _weixin_proxy_get(self, path: str, query: dict[str, Any] | None = None) -> None:
        try:
            self._json(self.state.weixin.proxy_get(path, query))
        except RuntimeError as error:
            self._json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
        except Exception as error:
            self._json({"error": str(error)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def _weixin_proxy_post(self, path: str, payload: dict[str, Any] | None = None) -> None:
        try:
            self._json(self.state.weixin.proxy_post(path, payload))
        except RuntimeError as error:
            self._json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
        except Exception as error:
            self._json({"error": str(error)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def _read_logs(self, raw_query: str) -> dict[str, Any]:
        query = parse_qs(raw_query)
        name = query.get("name", ["all"])[0]
        lines = max(10, min(int(query.get("lines", ["200"])[0]), 1000))
        entries = self._resolve_log_entries(name)
        if not entries:
            log_path = get_logs_dir() / f"{name}.log"
            return {"name": name, "lines": [], "path": str(log_path), "lineCount": 0, "updatedAt": None}

        if name == "all":
            merged = self._merge_log_entries(entries, lines)
            return {
                "name": name,
                "lines": merged["lines"],
                "path": " | ".join(str(item["path"]) for item in entries),
                "paths": [str(item["path"]) for item in entries],
                "archives": [],
                "lineCount": merged["lineCount"],
                "updatedAt": merged["updatedAt"],
            }

        log_path = entries[0]["path"]
        text = [self._strip_ansi(line) for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines()]
        archives = sorted(str(path) for path in get_logs_dir().glob(f"{name}.*.log"))
        updated_at = self._safe_mtime(log_path)
        return {
            "name": name,
            "lines": text[-lines:],
            "path": str(log_path),
            "archives": archives,
            "lineCount": len(text),
            "updatedAt": updated_at,
        }

    def _resolve_log_entries(self, name: str) -> list[dict[str, Any]]:
        logs_dir = get_logs_dir()
        explicit_entries = {
            "desktop": {"name": "desktop", "label": "Desktop", "path": logs_dir / "desktop.log"},
            "gateway": {"name": "gateway", "label": "Gateway", "path": logs_dir / "gateway.log"},
            "weixin-api": {"name": "weixin-api", "label": "Weixin API", "path": logs_dir / "weixin-api.log"},
            "weixin-runtime": {"name": "weixin-runtime", "label": "Weixin Runtime", "path": self.state.weixin.plugin_dir / "state" / "runtime.log"},
        }
        if name == "all":
            entries = list(explicit_entries.values())
            return [item for item in entries if item["path"].exists()]

        if name in explicit_entries:
            entry = explicit_entries[name]
            return [entry] if entry["path"].exists() else []

        log_path = logs_dir / f"{name}.log"
        if log_path.exists():
            return [{"name": name, "label": name, "path": log_path}]
        return []

    def _merge_log_entries(self, entries: list[dict[str, Any]], lines: int) -> dict[str, Any]:
        merged: list[tuple[float, int, str]] = []
        sequence = 0
        updated_at = None
        per_entry_limit = max(20, lines // max(1, len(entries)))
        for entry in entries:
            path = entry["path"]
            try:
                raw_lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            updated_at = max(filter(None, [updated_at, self._safe_mtime(path)]), default=updated_at)
            start_index = max(0, len(raw_lines) - per_entry_limit)
            for raw in raw_lines[start_index:]:
                cleaned = self._strip_ansi(raw)
                if not cleaned.strip():
                    continue
                if self._should_skip_log_line(entry["name"], cleaned):
                    continue
                merged.append((self._line_sort_key(cleaned, sequence), sequence, f"[{entry['label']}] {cleaned}"))
                sequence += 1
        merged.sort(key=lambda item: (item[0], item[1]))
        return {
            "lines": [item[2] for item in merged[-lines:]],
            "lineCount": len(merged),
            "updatedAt": updated_at,
        }

    def _line_sort_key(self, text: str, fallback: int) -> float:
        match = LOG_LINE_TS_RE.match(text.strip())
        if not match:
            return float(fallback)
        iso_value = match.group("iso")
        plain_value = match.group("plain")
        try:
            if iso_value:
                normalized = iso_value.replace("Z", "+00:00")
                return datetime.fromisoformat(normalized).timestamp()
            if plain_value:
                return datetime.strptime(plain_value, "%Y-%m-%d %H:%M:%S,%f").timestamp()
        except ValueError:
            return float(fallback)
        return float(fallback)

    def _safe_mtime(self, path: Path) -> float | None:
        try:
            return path.stat().st_mtime
        except OSError:
            return None

    def _strip_ansi(self, text: str) -> str:
        return ANSI_ESCAPE_RE.sub("", text).replace("\r", "")

    def _should_skip_log_line(self, entry_name: str, text: str) -> bool:
        if entry_name != "desktop":
            return False
        return any(marker in text for marker in DESKTOP_NOISE_MARKERS)

    def _clear_logs(self, name: str) -> dict[str, Any]:
        safe_name = re.sub(r"[^a-zA-Z0-9_.-]", "", name)
        if not safe_name:
            raise ValueError("invalid_log_name")
        if safe_name == "all":
            cleared: list[str] = []
            targets = self._resolve_log_entries("all")
            for entry in targets:
                path = entry["path"]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("", encoding="utf-8")
                cleared.append(str(path))
            for item in ("desktop", "gateway", "weixin-api"):
                for archive in get_logs_dir().glob(f"{item}.*.log"):
                    archive.unlink(missing_ok=True)
                    cleared.append(str(archive))
            return {"name": safe_name, "path": "", "cleared": sorted(cleared)}
        logs_dir = get_logs_dir()
        log_path = logs_dir / f"{safe_name}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text("", encoding="utf-8")
        cleared = [str(log_path)]
        for archive in logs_dir.glob(f"{safe_name}.*.log"):
            archive.unlink(missing_ok=True)
            cleared.append(str(archive))
        return {"name": safe_name, "path": str(log_path), "cleared": sorted(cleared)}

    def _json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError):
            logging.getLogger("nanobot_desktop.http").warning("Client disconnected before response body was fully written")

    def _shutdown_server(self) -> None:
        try:
            self.state.shutdown()
        finally:
            self.server.shutdown()


def read_nanobot_version() -> str:
    init_path = Path(__file__).resolve().parents[3] / "nanobot" / "__init__.py"
    if not init_path.exists():
        return "unknown"
    match = re.search(r'__version__\s*=\s*"([^"]+)"', init_path.read_text(encoding="utf-8", errors="replace"))
    return match.group(1) if match else "unknown"


def read_desktop_version() -> str:
    cargo_toml = Path(__file__).resolve().parents[2] / "src-tauri" / "Cargo.toml"
    if not cargo_toml.exists():
        return "unknown"
    match = re.search(r'^\s*version\s*=\s*"([^"]+)"', cargo_toml.read_text(encoding="utf-8", errors="replace"), re.MULTILINE)
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
    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    root.addHandler(stream)
    try:
        rotating = RotatingFileHandler(log_file, maxBytes=500_000, backupCount=3, encoding="utf-8")
    except PermissionError:
        fallback_dir = Path(tempfile.gettempdir()) / "nanobot-desktop-logs"
        fallback_dir.mkdir(parents=True, exist_ok=True)
        fallback = fallback_dir / f"desktop-recovery-{os.getpid()}.log"
        rotating = RotatingFileHandler(fallback, maxBytes=500_000, backupCount=1, encoding="utf-8")
        stream.handle(
            logging.makeLogRecord({
                "levelno": logging.WARNING,
                "levelname": "WARNING",
                "name": "nanobot_desktop",
                "msg": "desktop.log 被占用，已切换到 %s",
                "args": (str(fallback),),
            })
        )
    rotating.setFormatter(formatter)
    root.addHandler(rotating)


def list_sessions() -> list[dict[str, Any]]:
    cfg = Config.model_validate(load_core_runtime_config())
    manager = SessionManager(cfg.workspace_path)
    sessions = [serialize_session_summary(item) for item in manager.list_sessions()]
    if not any(item["key"] == ChatManager.SESSION_KEY for item in sessions):
        sessions.append({
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
    cfg = Config.model_validate(load_core_runtime_config())
    manager = SessionManager(cfg.workspace_path)
    session = manager.get_or_create(session_key)
    return {
        "session": serialize_session_summary({
            "key": session_key,
            "updated_at": session.updated_at.isoformat() if session.messages else None,
            "path": str(cfg.workspace_path / "sessions"),
        }),
        "items": [serialize_session_message(message) for message in session.messages],
    }


def clear_session_payload(key: str) -> dict[str, Any]:
    session_key = (key or "").strip()
    if not session_key:
        raise ValueError("missing session key")
    cfg = Config.model_validate(load_core_runtime_config())
    manager = SessionManager(cfg.workspace_path)
    manager.clear_session(session_key)
    return load_session_payload(session_key)


def delete_session_payload(key: str) -> dict[str, Any]:
    session_key = (key or "").strip()
    if not session_key:
        raise ValueError("missing session key")
    cfg = Config.model_validate(load_core_runtime_config())
    manager = SessionManager(cfg.workspace_path)
    deleted = manager.delete_session(session_key)
    return {"deleted": deleted}


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
        return CHANNEL_DISPLAY_NAMES.get(channel, channel or "会话"), ""
    if "|" in chat_id:
        primary, _, alias = chat_id.partition("|")
        return f"{CHANNEL_DISPLAY_NAMES.get(channel, channel)} · {alias or primary}", primary
    return f"{CHANNEL_DISPLAY_NAMES.get(channel, channel)} · {chat_id}", chat_id


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
        "toolCalls": list(message.get("tool_calls") or []),
        "metadata": dict(message.get("metadata") or {}),
    }


def open_path(target: Path) -> None:
    target = target.resolve()
    if sys.platform == "win32":
        _open_path_windows(target)
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
        try:
            server.RequestHandlerClass.state.shutdown()
        except Exception:
            logging.getLogger("nanobot_desktop").exception("Failed during desktop shutdown cleanup")
        server.server_close()
