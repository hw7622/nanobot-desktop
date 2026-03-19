"""Desktop app paths."""

from __future__ import annotations

import os
import sys
from pathlib import Path


APP_DIRNAME = "NanobotDesktop"
OVERRIDE_ENV = "NANOBOT_DESKTOP_DATA_DIR"


def get_data_dir() -> Path:
    """Return the user data directory for the desktop app."""
    override = os.environ.get(OVERRIDE_ENV)
    if override:
        return Path(override).expanduser()
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / APP_DIRNAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_DIRNAME
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "nanobot-desktop"


def get_config_path() -> Path:
    return get_data_dir() / "config.json"


def get_workspace_dir() -> Path:
    return get_data_dir() / "workspace"


def get_logs_dir() -> Path:
    return get_data_dir() / "logs"


def ensure_dirs() -> None:
    """Ensure all required app directories exist."""
    get_data_dir().mkdir(parents=True, exist_ok=True)
    get_workspace_dir().mkdir(parents=True, exist_ok=True)
    get_logs_dir().mkdir(parents=True, exist_ok=True)
