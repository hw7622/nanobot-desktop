from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "desktop" / "dist"
BUILD = ROOT / "desktop" / "build"

hidden_imports = [
    "nanobot.channels.telegram",
    "nanobot.channels.feishu",
    "nanobot.channels.dingtalk",
    "nanobot.channels.email",
    "nanobot.channels.qq",
    "nanobot.channels.wecom",
    "nanobot.providers.litellm_provider",
    "nanobot.providers.custom_provider",
    "nanobot.providers.azure_openai_provider",
    "nanobot.providers.openai_codex_provider",
]

command = [
    sys.executable,
    "-m",
    "PyInstaller",
    str(ROOT / "desktop" / "run_runtime.py"),
    "--name",
    "nanobot-runtime",
    "--onedir",
    "--clean",
    "--noconfirm",
    "--distpath",
    str(DIST / "runtime"),
    "--workpath",
    str(BUILD / "runtime"),
    "--specpath",
    str(BUILD / "runtime-spec"),
    "--add-data",
    f"{ROOT / 'nanobot' / 'templates'};nanobot/templates",
    "--add-data",
    f"{ROOT / 'nanobot' / 'skills'};nanobot/skills",
    "--add-data",
    f"{ROOT / 'nanobot' / '__init__.py'};nanobot",
    "--collect-data",
    "tiktoken",
]

for hidden in hidden_imports:
    command.extend(["--hidden-import", hidden])

raise SystemExit(subprocess.call(command, cwd=ROOT))

