"""Gateway process manager for the desktop backend."""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from nanobot_desktop_backend.paths import get_config_path, get_logs_dir


class GatewayManager:
    """Manages the nanobot gateway child process."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._process: subprocess.Popen[str] | None = None
        self._gateway_log = get_logs_dir() / "gateway.log"
        self._last_exit_code: int | None = None
        self._log_handle = None

    @property
    def log_path(self) -> Path:
        return self._gateway_log

    def start(self) -> dict[str, Any]:
        with self._lock:
            if self._is_running():
                return self._status_unlocked()

            self._gateway_log.parent.mkdir(parents=True, exist_ok=True)
            self._log_handle = open(self._gateway_log, "a", encoding="utf-8")
            command = self._resolve_gateway_command()
            creationflags = 0
            if sys.platform == "win32":
                creationflags = (
                    getattr(subprocess, "CREATE_NO_WINDOW", 0)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                )

            repo_root = Path(__file__).resolve().parents[3]
            self._process = subprocess.Popen(
                command,
                cwd=repo_root,
                stdout=self._log_handle,
                stderr=subprocess.STDOUT,
                text=True,
                creationflags=creationflags,
            )
            self._last_exit_code = None

            time.sleep(0.8)
            if not self._is_running() and self._process is not None:
                self._last_exit_code = self._process.returncode
                self._process = None
                self._close_log_unlocked()

            return self._status_unlocked()

    def stop(self) -> dict[str, Any]:
        with self._lock:
            if not self._is_running():
                self._close_log_unlocked()
                return self._status_unlocked()

            assert self._process is not None
            self._process.terminate()
            try:
                self._process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=5)
            self._last_exit_code = self._process.returncode
            self._process = None
            self._close_log_unlocked()
            return self._status_unlocked()

    def restart(self) -> dict[str, Any]:
        self.stop()
        return self.start()

    def status(self) -> dict[str, Any]:
        with self._lock:
            if self._process is not None and self._process.poll() is not None:
                self._last_exit_code = self._process.returncode
                self._process = None
                self._close_log_unlocked()
            return self._status_unlocked()

    def _status_unlocked(self) -> dict[str, Any]:
        running = self._is_running()
        pid = self._process.pid if running and self._process else None
        return {
            "running": running,
            "pid": pid,
            "logPath": str(self._gateway_log),
            "lastExitCode": self._last_exit_code,
        }

    def _is_running(self) -> bool:
        if self._process is None:
            return False
        return self._process.poll() is None

    def _close_log_unlocked(self) -> None:
        if self._log_handle is not None:
            try:
                self._log_handle.close()
            except Exception:
                pass
            self._log_handle = None

    def _resolve_gateway_command(self) -> list[str]:
        override = os.environ.get("NANOBOT_DESKTOP_GATEWAY_BIN")
        if override:
            return [override, "gateway", "--config", str(get_config_path())]

        if getattr(sys, "frozen", False):
            candidate = Path(sys.executable).resolve().with_name("nanobot-runtime.exe")
            if candidate.exists():
                return [str(candidate), "gateway", "--config", str(get_config_path())]

        return [sys.executable, "-m", "nanobot", "gateway", "--config", str(get_config_path())]
