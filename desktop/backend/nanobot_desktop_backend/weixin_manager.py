"""Desktop-side manager for the standalone Weixin plugin."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from nanobot_desktop_backend.paths import get_config_path, get_logs_dir, get_workspace_dir


class WeixinPluginManager:
    """Manages the standalone weixin plugin API process and proxy calls."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._process: subprocess.Popen[str] | None = None
        self._log_handle = None
        self._api_log = get_logs_dir() / "weixin-api.log"

    @property
    def plugin_dir(self) -> Path:
        return get_workspace_dir() / "nanobot-weixin-plugin"

    @property
    def manifest_path(self) -> Path:
        return self.plugin_dir / "manifest.json"

    @property
    def state_dir(self) -> Path:
        return self.plugin_dir / "state"

    def status(self) -> dict[str, Any]:
        with self._lock:
            self._refresh_process_unlocked()
            return self._status_unlocked()

    def start_api(self) -> dict[str, Any]:
        with self._lock:
            self._refresh_process_unlocked()
            status = self._status_unlocked()
            if status["apiRunning"]:
                return status
            if not status["installed"]:
                status["note"] = "未找到微信插件目录。"
                return status

            self._api_log.parent.mkdir(parents=True, exist_ok=True)
            self._close_log_unlocked()
            self._log_handle = open(self._api_log, "a", encoding="utf-8")
            env = os.environ.copy()
            env["NANOBOT_CONFIG"] = str(get_config_path())
            env["NANOBOT_WORKSPACE"] = str(get_workspace_dir())
            env.setdefault("NANOBOT_WEIXIN_API_PORT", str(status["apiPort"]))
            creationflags = 0
            if sys.platform == "win32":
                creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

            try:
                self._process = subprocess.Popen(
                    ["node", "src/index.js", "api"],
                    cwd=self.plugin_dir,
                    stdout=self._log_handle,
                    stderr=subprocess.STDOUT,
                    text=True,
                    creationflags=creationflags,
                    env=env,
                )
            except OSError as error:
                self._close_log_unlocked()
                status = self._status_unlocked()
                status["note"] = str(error)
                return status
            time.sleep(0.8)
            self._refresh_process_unlocked()
            return self._status_unlocked()

    def stop_api(self) -> dict[str, Any]:
        with self._lock:
            self._refresh_process_unlocked()
            if self._process is None:
                status = self._status_unlocked()
                if status["apiRunning"]:
                    status["note"] = "微信 API 正在运行，但不是由桌面端当前进程拉起，未执行停止。"
                return status

            self._process.terminate()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=5)
            self._process = None
            self._close_log_unlocked()
            return self._status_unlocked()

    def proxy_get(self, path: str, query: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            status = self._status_unlocked()
        if not status["apiRunning"]:
            raise RuntimeError("微信插件 API 未运行，请先启动接口。")
        return self._http_json("GET", path, port=int(status["apiPort"]), query=query)

    def proxy_post(self, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            status = self._status_unlocked()
        if not status["apiRunning"]:
            raise RuntimeError("微信插件 API 未运行，请先启动接口。")
        return self._http_json("POST", path, port=int(status["apiPort"]), payload=payload)

    def _status_unlocked(self) -> dict[str, Any]:
        manifest = self._read_json(self.manifest_path, {})
        installed = self.manifest_path.exists()
        api_port = self._api_port_from_manifest(manifest)
        local_account = self._read_json(self.state_dir / "account.json", None)
        local_bridge = self._read_json(self.state_dir / "bridge-status.json", {"running": False})
        local_context = self._read_json(self.state_dir / "context.json", {})
        api_running = False
        remote_account = None
        remote_bridge = None
        note = ""
        try:
            remote_manifest = self._http_json("GET", "/manifest", port=api_port)
            api_running = bool(remote_manifest.get("ok", True))
            remote_account = self._http_json("GET", "/api/weixin/account", port=api_port)
            remote_bridge = self._http_json("GET", "/api/weixin/bridge/status", port=api_port)
        except Exception as error:
            note = str(error)

        account = (remote_account or {}).get("account") or local_account
        bridge = (remote_bridge or {}).get("status") or local_bridge or {"running": False}
        return {
            "installed": installed,
            "pluginDir": str(self.plugin_dir),
            "manifest": manifest or None,
            "displayName": manifest.get("displayName") or "微信",
            "apiPort": api_port,
            "apiUrl": f"http://127.0.0.1:{api_port}",
            "apiRunning": api_running,
            "pid": self._process.pid if self._process and self._process.poll() is None else None,
            "loggedIn": bool((account or {}).get("token")),
            "account": account,
            "bridge": bridge,
            "contextCount": len(local_context) if isinstance(local_context, dict) else 0,
            "note": "" if api_running else note,
            "apiLogPath": str(self._api_log),
        }

    def _refresh_process_unlocked(self) -> None:
        if self._process is not None and self._process.poll() is not None:
            self._process = None
            self._close_log_unlocked()

    def _close_log_unlocked(self) -> None:
        if self._log_handle is not None:
            try:
                self._log_handle.close()
            except Exception:
                pass
            self._log_handle = None

    @staticmethod
    def _read_json(path: Path, fallback: Any) -> Any:
        try:
            if not path.exists():
                return fallback
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return fallback

    @staticmethod
    def _api_port_from_manifest(manifest: dict[str, Any]) -> int:
        api = manifest.get("api") if isinstance(manifest, dict) else {}
        try:
            return int((api or {}).get("defaultPort") or 31966)
        except (TypeError, ValueError):
            return 31966

    @staticmethod
    def _http_json(
        method: str,
        path: str,
        *,
        port: int,
        payload: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"http://127.0.0.1:{port}{path}"
        if query:
            url = f"{url}?{urlencode({key: value for key, value in query.items() if value is not None})}"
        data = None
        headers = {"Content-Type": "application/json; charset=utf-8"}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = Request(url, data=data, headers=headers, method=method.upper())
        try:
            with urlopen(request, timeout=5) as response:
                raw = response.read().decode("utf-8")
        except HTTPError as error:
            raw = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(raw or f"HTTP {error.code}") from error
        except URLError as error:
            raise RuntimeError("微信插件 API 未响应") from error
        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError as error:
            raise RuntimeError("微信插件 API 返回了无效响应") from error
