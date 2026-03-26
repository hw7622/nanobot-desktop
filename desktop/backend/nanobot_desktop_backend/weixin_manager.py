"""Desktop-side manager for the standalone Weixin plugin."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from nanobot_desktop_backend.config_manager import load_runtime_config
from nanobot_desktop_backend.paths import get_config_path, get_desktop_plugins_dir, get_logs_dir, get_workspace_dir
from nanobot_desktop_backend.paths import get_weixin_plugin_dir


class WeixinPluginManager:
    """Manages the standalone weixin plugin API process and proxy calls."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._process: subprocess.Popen[str] | None = None
        self._log_handle = None
        self._api_log = get_logs_dir() / "weixin-api.log"

    @property
    def plugin_dir(self) -> Path:
        try:
            raw = str(load_runtime_config().get("channels", {}).get("weixin", {}).get("pluginDir") or "").strip()
        except Exception:
            raw = ""
        if raw:
            return Path(raw).expanduser()
        return self._discover_plugin_dir()

    def _discover_plugin_dir(self) -> Path:
        root = get_desktop_plugins_dir()
        preferred = [
            root / "nanobot-weixin-plugin",
            root / "weixin",
            get_weixin_plugin_dir(),
        ]
        for candidate in preferred:
            if self._looks_like_weixin_plugin(candidate):
                return candidate

        try:
            for child in sorted(root.iterdir()):
                if child.is_dir() and self._looks_like_weixin_plugin(child):
                    return child
        except OSError:
            pass

        return root / "nanobot-weixin-plugin"

    @staticmethod
    def _looks_like_weixin_plugin(path: Path) -> bool:
        manifest_path = path / "manifest.json"
        if not manifest_path.exists():
            return False
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            return False

        values = [
            str(manifest.get("id") or "").lower(),
            str(manifest.get("name") or "").lower(),
            str(manifest.get("displayName") or "").lower(),
        ]
        return "weixin" in values or "微信" in "".join(values)

    @property
    def manifest_path(self) -> Path:
        return self.plugin_dir / "manifest.json"

    @property
    def state_dir(self) -> Path:
        return self.plugin_dir / "state"

    @property
    def package_json_path(self) -> Path:
        return self.plugin_dir / "package.json"

    def status(self) -> dict[str, Any]:
        with self._lock:
            self._refresh_process_unlocked()
            return self._status_unlocked()

    def start_api(self) -> dict[str, Any]:
        with self._lock:
            self._refresh_process_unlocked()
            status = self._status_unlocked()
            api_port = int(status["apiPort"])
            managed_pid = self._managed_pid_unlocked()
            if status["apiRunning"]:
                foreign_pids = [pid for pid in self._list_port_pids_unlocked(api_port) if pid != managed_pid]
                if not foreign_pids:
                    return status
                self._terminate_pids_unlocked(foreign_pids)
                time.sleep(0.8)
                self._refresh_process_unlocked()
                status = self._status_unlocked()
                if status["apiRunning"]:
                    status["note"] = status.get("note") or f"微信插件 API 端口 {api_port} 仍被其他进程占用。"
                    return status
            if not status["installed"]:
                status["note"] = "未找到微信插件目录。"
                return status
            if not status["packageReady"] or not status["nodeAvailable"] or not status["dependenciesOk"]:
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
                    [str(status["nodePath"] or "node"), "src/index.js", "api"],
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
            managed_pid = self._managed_pid_unlocked()
            if self._process is None:
                status = self._status_unlocked()
                if status["apiRunning"]:
                    foreign_pids = [pid for pid in self._list_port_pids_unlocked(int(status["apiPort"])) if pid != managed_pid]
                    if foreign_pids:
                        self._terminate_pids_unlocked(foreign_pids)
                        time.sleep(0.5)
                        return self._status_unlocked()
                    status["note"] = "微信 API 正在运行，但未定位到可停止的外部进程。"
                return status

            self._process.terminate()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=5)
            self._process = None
            self._close_log_unlocked()
            foreign_pids = [pid for pid in self._list_port_pids_unlocked(int(self._api_port_from_manifest(self._read_json(self.manifest_path, {})))) if pid != managed_pid]
            if foreign_pids:
                self._terminate_pids_unlocked(foreign_pids)
                time.sleep(0.5)
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
        package_data = self._read_json(self.package_json_path, {})
        api_port = self._api_port_from_manifest(manifest)
        local_account = self._read_json(self.state_dir / "account.json", None)
        local_bridge = self._read_json(self.state_dir / "bridge-status.json", {"running": False})
        local_context = self._read_json(self.state_dir / "context.json", {})
        node_path = shutil.which("node") or ""
        dependencies = self._dependency_names(package_data)
        missing_dependencies = [
            name for name in dependencies if not (self.plugin_dir / "node_modules" / name).exists()
        ]
        api_running = False
        remote_account = None
        remote_bridge = None
        note = ""
        validation_note = self._validation_note(
            installed=installed,
            package_ready=self.package_json_path.exists(),
            node_path=node_path,
            missing_dependencies=missing_dependencies,
        )
        try:
            remote_manifest = self._http_json("GET", "/manifest", port=api_port)
            api_running = bool(remote_manifest.get("ok", True))
            remote_account = self._http_json("GET", "/api/weixin/account", port=api_port)
            remote_bridge = self._http_json("GET", "/api/weixin/bridge/status", port=api_port)
        except Exception as error:
            note = str(error)

        account = (remote_account or {}).get("account") or local_account
        bridge = (remote_bridge or {}).get("status") or local_bridge or {"running": False}
        if not api_running:
            note = validation_note or self._recent_log_hint() or note
        return {
            "installed": installed,
            "pluginDir": str(self.plugin_dir),
            "manifest": manifest or None,
            "packageReady": self.package_json_path.exists(),
            "nodeAvailable": bool(node_path),
            "nodePath": node_path or None,
            "dependenciesOk": not missing_dependencies,
            "missingDependencies": missing_dependencies,
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

    def _managed_pid_unlocked(self) -> int | None:
        if self._process is not None and self._process.poll() is None:
            return self._process.pid
        return None

    @staticmethod
    def _list_port_pids_unlocked(port: int) -> list[int]:
        if sys.platform != "win32":
            return []

        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            result = subprocess.run(
                ["netstat", "-ano", "-p", "tcp"],
                capture_output=True,
                text=True,
                check=False,
                creationflags=creationflags,
            )
        except OSError:
            return []

        suffix = f":{port}"
        listen_states = {"LISTENING", "侦听"}
        pids: set[int] = set()
        for raw in result.stdout.splitlines():
            parts = raw.split()
            if len(parts) < 5:
                continue
            proto, local_addr, _remote_addr, state, pid_raw = parts[:5]
            if proto.upper() != "TCP":
                continue
            if not local_addr.endswith(suffix):
                continue
            if state.upper() not in listen_states and state not in listen_states:
                continue
            try:
                pids.add(int(pid_raw))
            except (TypeError, ValueError):
                continue
        return sorted(pids)

    @staticmethod
    def _terminate_pids_unlocked(pids: list[int]) -> None:
        if sys.platform != "win32":
            return

        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        for pid in sorted({int(pid) for pid in pids if int(pid) > 0}):
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    capture_output=True,
                    text=True,
                    check=False,
                    creationflags=creationflags,
                )
            except OSError:
                continue

    @staticmethod
    def _read_json(path: Path, fallback: Any) -> Any:
        try:
            if not path.exists():
                return fallback
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return fallback

    @staticmethod
    def _dependency_names(package_data: dict[str, Any]) -> list[str]:
        dependencies = package_data.get("dependencies") if isinstance(package_data, dict) else {}
        if not isinstance(dependencies, dict):
            return []
        return sorted(str(name).strip() for name in dependencies.keys() if str(name).strip())

    @staticmethod
    def _validation_note(
        *,
        installed: bool,
        package_ready: bool,
        node_path: str,
        missing_dependencies: list[str],
    ) -> str:
        if not installed:
            return "未找到微信插件目录。"
        if not package_ready:
            return "微信插件目录缺少 package.json，请重新解压完整插件包。"
        if not node_path:
            return "未检测到 Node.js，请先安装 Node.js 22+，或提供内置 node 运行时。"
        if missing_dependencies:
            joined = ", ".join(missing_dependencies)
            return f"微信插件依赖缺失：{joined}。请重新解压带 node_modules 的插件包。"
        return ""

    def _recent_log_hint(self) -> str:
        try:
            if not self._api_log.exists():
                return ""
            lines = self._api_log.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:
            return ""
        for raw in reversed(lines):
            line = raw.strip()
            if not line or line.startswith("Node.js v"):
                continue
            return f"最近日志：{line}"
        return ""

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
