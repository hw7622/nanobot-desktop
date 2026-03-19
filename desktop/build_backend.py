from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "desktop" / "dist"
BUILD = ROOT / "desktop" / "build"

command = [
    sys.executable,
    "-m",
    "PyInstaller",
    str(ROOT / "desktop" / "run_backend.py"),
    "--name",
    "nanobot-desktop-backend",
    "--onedir",
    "--clean",
    "--noconfirm",
    "--distpath",
    str(DIST / "backend"),
    "--workpath",
    str(BUILD / "backend"),
    "--specpath",
    str(BUILD / "backend-spec"),
    "--paths",
    str(ROOT / "desktop" / "backend"),
    "--hidden-import",
    "nanobot_desktop_backend.app",
    "--hidden-import",
    "nanobot_desktop_backend.config_manager",
    "--hidden-import",
    "nanobot_desktop_backend.gateway_manager",
    "--hidden-import",
    "nanobot_desktop_backend.paths",
    "--hidden-import",
    "nanobot_desktop_backend.schemas",
    "--add-data",
    f"{ROOT / 'nanobot' / 'templates'};nanobot/templates",
    "--add-data",
    f"{ROOT / 'nanobot' / 'skills'};nanobot/skills",
    "--add-data",
    f"{ROOT / 'nanobot' / '__init__.py'};nanobot",
]

raise SystemExit(subprocess.call(command, cwd=ROOT))
