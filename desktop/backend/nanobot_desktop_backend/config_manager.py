"""Config helpers for the desktop backend."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path
from typing import Any

from nanobot_desktop_backend.paths import ensure_dirs, get_config_path, get_workspace_dir
from nanobot_desktop_backend.schemas import default_config_payload


def _repo_root() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(getattr(sys, "_MEIPASS"))
    return Path(__file__).resolve().parents[3]


def _templates_dir() -> Path:
    return _repo_root() / "nanobot" / "templates"


def _skills_dir() -> Path:
    return _repo_root() / "nanobot" / "skills"


def _sync_workspace_templates(workspace: Path) -> None:
    templates = _templates_dir()
    if not templates.exists():
        return
    workspace.mkdir(parents=True, exist_ok=True)
    memory_dir = workspace / "memory"
    skills_dir = workspace / "skills"
    memory_dir.mkdir(parents=True, exist_ok=True)
    skills_dir.mkdir(parents=True, exist_ok=True)

    for source in templates.glob("*.md"):
        target = workspace / source.name
        if not target.exists():
            shutil.copyfile(source, target)

    memory_source = templates / "memory" / "MEMORY.md"
    if memory_source.exists() and not (memory_dir / "MEMORY.md").exists():
        shutil.copyfile(memory_source, memory_dir / "MEMORY.md")
    history = memory_dir / "HISTORY.md"
    if not history.exists():
        history.write_text("", encoding="utf-8")


def ensure_default_config() -> dict[str, Any]:
    ensure_dirs()
    config_path = get_config_path()
    workspace = get_workspace_dir()
    if config_path.exists():
        payload = load_runtime_config()
        payload.setdefault("agents", {}).setdefault("defaults", {}).setdefault("workspace", str(workspace))
    else:
        payload = default_config_payload(str(workspace))
        config_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    _sync_workspace_templates(Path(payload["agents"]["defaults"]["workspace"]).expanduser())
    return payload


def load_runtime_config() -> dict[str, Any]:
    config_path = get_config_path()
    if not config_path.exists():
        return ensure_default_config()
    return json.loads(config_path.read_text(encoding="utf-8"))


def dump_runtime_config() -> dict[str, Any]:
    return load_runtime_config()


def save_runtime_config(payload: dict[str, Any]) -> dict[str, Any]:
    config_path = get_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    workspace = payload.setdefault("agents", {}).setdefault("defaults", {}).setdefault("workspace", str(get_workspace_dir()))
    config_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    _sync_workspace_templates(Path(workspace).expanduser())
    return payload


def get_skill_inventory() -> dict[str, Any]:
    cfg = load_runtime_config()
    workspace = Path(cfg["agents"]["defaults"]["workspace"]).expanduser()
    builtin_root = _skills_dir()
    workspace_root = workspace / "skills"
    items: list[dict[str, Any]] = []

    for source_root, source_name in ((builtin_root, "builtin"), (workspace_root, "workspace")):
        if not source_root.exists():
            continue
        for skill_dir in sorted(source_root.iterdir()):
            if not skill_dir.is_dir():
                continue
            skill_file = skill_dir / "SKILL.md"
            if not skill_file.exists():
                continue
            metadata = parse_skill_metadata(skill_file)
            items.append(
                {
                    "name": skill_dir.name,
                    "source": source_name,
                    "path": str(skill_file),
                    "available": True,
                    "always": metadata.get("always") in (True, "true"),
                    "metadata": metadata,
                }
            )

    return {
        "workspace": str(workspace),
        "skillsDirectory": str(workspace_root),
        "items": items,
    }


def parse_skill_metadata(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8", errors="replace")
    if not text.startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}
    metadata: dict[str, Any] = {}
    for line in parts[1].splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        metadata[key.strip()] = value.strip().strip('"\'')
    return metadata
