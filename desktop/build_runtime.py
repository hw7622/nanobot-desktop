from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "desktop" / "dist"
BUILD = ROOT / "desktop" / "build"
CHANNELS_DIR = ROOT / "nanobot" / "channels"

_CHANNEL_INTERNALS = {"__init__", "base", "manager", "registry"}


def built_in_channel_imports() -> list[str]:
    imports: list[str] = []
    for path in sorted(CHANNELS_DIR.glob("*.py")):
        name = path.stem
        if name in _CHANNEL_INTERNALS:
            continue
        imports.append(f"nanobot.channels.{name}")
    return imports


hidden_imports = built_in_channel_imports() + [
    "nanobot.providers.anthropic_provider",
    "nanobot.providers.azure_openai_provider",
    "nanobot.providers.openai_compat_provider",
    "nanobot.providers.openai_codex_provider",
]

def build_command() -> list[str]:
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        str(ROOT / "desktop" / "run_runtime.py"),
        "--name",
        "nanobot-runtime",
        "--onedir",
        "--noconsole",
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
    return command


def main() -> int:
    return subprocess.call(build_command(), cwd=ROOT)


if __name__ == "__main__":
    raise SystemExit(main())

