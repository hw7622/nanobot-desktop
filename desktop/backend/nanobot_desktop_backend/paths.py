"""Desktop app paths rooted under the official nanobot data directory."""

from __future__ import annotations

from pathlib import Path

from nanobot.config.loader import get_config_path as get_core_config_path, load_config
from nanobot.config.paths import get_workspace_path as get_core_workspace_path


def _ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def get_data_dir() -> Path:
    """Return the shared nanobot data root (config parent)."""
    return _ensure_dir(get_config_path().parent)


def get_desktop_dir() -> Path:
    """Return the desktop-shell dedicated data directory."""
    return _ensure_dir(get_data_dir() / "desktop")


def get_desktop_state_path() -> Path:
    return get_desktop_dir() / "state.json"


def get_config_path() -> Path:
    """Return the official nanobot core config path."""
    return get_core_config_path()


def get_workspace_dir() -> Path:
    """Return the configured workspace path from the core config."""
    config_path = get_config_path()
    if config_path.exists():
        try:
            return _ensure_dir(load_config(config_path).workspace_path)
        except Exception:
            pass
    return get_core_workspace_path()


def get_logs_dir() -> Path:
    """Return the desktop-shell logs directory."""
    return _ensure_dir(get_desktop_dir() / "logs")


def ensure_dirs() -> None:
    """Ensure all required shared and desktop-specific directories exist."""
    _ensure_dir(get_data_dir())
    _ensure_dir(get_desktop_dir())
    _ensure_dir(get_logs_dir())
    _ensure_dir(get_workspace_dir())
