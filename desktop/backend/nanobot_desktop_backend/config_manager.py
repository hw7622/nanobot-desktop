"""Config helpers for the desktop backend."""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any

from nanobot.config.schema import Config
from nanobot.providers.registry import find_by_name
from nanobot.config.paths import get_workspace_path as get_core_workspace_path

from nanobot_desktop_backend.paths import (
    ensure_dirs,
    get_config_path,
    get_desktop_state_path,
    get_workspace_dir,
)
from nanobot_desktop_backend.schemas import default_config_payload


SKILL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def _read_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        if not path.exists():
            return fallback
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else fallback
    except Exception:
        return fallback


def _merge_desktop_defaults(payload: dict[str, Any]) -> dict[str, Any]:
    desktop = payload.setdefault("desktop", {})
    gateway = desktop.setdefault("gateway", {})
    gateway.setdefault("autoStart", True)
    app = desktop.setdefault("app", {})
    app.setdefault("autoLaunch", False)
    chat = desktop.setdefault("chat", {})
    chat.setdefault("refreshIntervalSeconds", 3)
    return payload


def _default_desktop_state() -> dict[str, Any]:
    return _merge_desktop_defaults({})["desktop"]


def load_desktop_state() -> dict[str, Any]:
    payload = _merge_desktop_defaults({"desktop": _read_json(get_desktop_state_path(), {})})
    return payload["desktop"]


def save_desktop_state(payload: dict[str, Any] | None) -> dict[str, Any]:
    state = _merge_desktop_defaults({"desktop": payload or {}})["desktop"]
    path = get_desktop_state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    return state


def _split_runtime_payload(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    core = dict(payload)
    desktop = core.pop("desktop", {})
    if not isinstance(desktop, dict):
        desktop = {}
    return core, _merge_desktop_defaults({"desktop": desktop})["desktop"]


def _load_core_config_payload() -> dict[str, Any]:
    config_path = get_config_path()
    if not config_path.exists():
        for legacy_path in _legacy_config_candidates():
            payload = _read_json(legacy_path, {})
            if not payload:
                continue
            core_payload, desktop_state = _split_runtime_payload(payload)
            core_payload = _normalize_workspace(core_payload)
            config_path.parent.mkdir(parents=True, exist_ok=True)
            config_path.write_text(json.dumps(core_payload, indent=2, ensure_ascii=False), encoding="utf-8")
            save_desktop_state(desktop_state)
            return core_payload
        workspace = str(get_workspace_dir())
        payload = default_config_payload(workspace)
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        if not get_desktop_state_path().exists():
            save_desktop_state(_default_desktop_state())
        return payload

    payload = _read_json(config_path, {})
    if not payload:
        payload = default_config_payload(str(get_workspace_dir()))
        config_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        if not get_desktop_state_path().exists():
            save_desktop_state(_default_desktop_state())
        return payload

    migrated = False
    if "desktop" in payload:
        desktop_state = save_desktop_state(payload.get("desktop", {}))
        payload = {key: value for key, value in payload.items() if key != "desktop"}
        migrated = True
    else:
        desktop_state = load_desktop_state()

    payload = _normalize_workspace(payload)

    if migrated:
        config_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    elif not get_desktop_state_path().exists():
        save_desktop_state(desktop_state)

    return payload


def _repo_root() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(getattr(sys, "_MEIPASS"))
    return Path(__file__).resolve().parents[3]


def _templates_dir() -> Path:
    return _repo_root() / "nanobot" / "templates"


def _skills_dir() -> Path:
    return _repo_root() / "nanobot" / "skills"


def _legacy_config_candidates() -> list[Path]:
    return [
        Path.home() / "AppData" / "Roaming" / "com.nanobot.desktop" / "config.json",
        Path.home() / "AppData" / "Local" / "NanobotDesktop" / "config.json",
        _repo_root() / ".desktop-data" / "config.json",
    ]


def _legacy_workspace_candidates() -> list[Path]:
    return [
        Path.home() / "AppData" / "Roaming" / "com.nanobot.desktop" / "workspace",
        Path.home() / "AppData" / "Local" / "NanobotDesktop" / "workspace",
        _repo_root() / ".desktop-data" / "workspace",
    ]


def _normalize_workspace(payload: dict[str, Any]) -> dict[str, Any]:
    defaults = payload.setdefault("agents", {}).setdefault("defaults", {})
    raw = str(defaults.get("workspace") or "").strip()
    default_workspace = str(get_core_workspace_path())
    if not raw:
        defaults["workspace"] = default_workspace
        return payload

    workspace = Path(raw).expanduser()
    for legacy_root in _legacy_workspace_candidates():
        if workspace == legacy_root:
            defaults["workspace"] = default_workspace
            break
    return payload


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
    payload = load_runtime_config()
    _sync_workspace_templates(Path(payload["agents"]["defaults"]["workspace"]).expanduser())
    return payload


def load_runtime_config() -> dict[str, Any]:
    ensure_dirs()
    payload = _load_core_config_payload()
    payload["desktop"] = load_desktop_state()
    return payload


def dump_runtime_config() -> dict[str, Any]:
    return load_runtime_config()


def load_core_runtime_config() -> dict[str, Any]:
    payload = load_runtime_config()
    return {key: value for key, value in payload.items() if key != "desktop"}


def gateway_start_preflight() -> dict[str, Any]:
    payload = load_core_runtime_config()
    config = Config.model_validate(payload)
    model = config.agents.defaults.model
    provider_name = config.get_provider_name(model) or config.agents.defaults.provider or "auto"
    provider = config.get_provider(model)
    spec = find_by_name(provider_name) if provider_name else None

    if provider_name == "custom":
        if not provider or not (provider.api_key or "").strip() or not (provider.api_base or "").strip():
            return {
                "ok": False,
                "code": "missing_custom_provider_config",
                "message": "未配置可用 AI：Custom 需要同时填写 API Base 和 API Key。",
                "provider": provider_name,
                "model": model,
            }
        return {"ok": True, "provider": provider_name, "model": model}

    if provider_name == "azure_openai":
        if not provider or not (provider.api_key or "").strip() or not (provider.api_base or "").strip():
            return {
                "ok": False,
                "code": "missing_azure_openai_config",
                "message": "未配置可用 AI：Azure OpenAI 需要同时填写 API Base 和 API Key。",
                "provider": provider_name,
                "model": model,
            }
        return {"ok": True, "provider": provider_name, "model": model}

    if spec and (spec.is_local or spec.is_oauth):
        return {"ok": True, "provider": provider_name, "model": model}

    if provider and (provider.api_key or "").strip():
        return {"ok": True, "provider": provider_name, "model": model}

    if provider_name and provider_name != "auto":
        message = f"未配置可用 AI：当前 {provider_name} 缺少 API Key。请先在 AI 配置里填写后再启动 Gateway。"
    else:
        message = "未配置可用 AI：请先在 AI 配置里填写模型和 API Key。"
    return {
        "ok": False,
        "code": "missing_provider_api_key",
        "message": message,
        "provider": provider_name,
        "model": model,
    }


def save_runtime_config(payload: dict[str, Any]) -> dict[str, Any]:
    config_path = get_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    payload = _merge_desktop_defaults(payload)
    workspace = payload.setdefault("agents", {}).setdefault("defaults", {}).setdefault("workspace", str(get_workspace_dir()))
    core_payload, desktop_state = _split_runtime_payload(payload)
    config_path.write_text(json.dumps(core_payload, indent=2, ensure_ascii=False), encoding="utf-8")
    save_desktop_state(desktop_state)
    _sync_workspace_templates(Path(workspace).expanduser())
    return payload


def get_workspace_skills_dir() -> Path:
    cfg = load_runtime_config()
    workspace = Path(cfg["agents"]["defaults"]["workspace"]).expanduser()
    skills_dir = workspace / "skills"
    skills_dir.mkdir(parents=True, exist_ok=True)
    return skills_dir


def get_skill_inventory() -> dict[str, Any]:
    cfg = load_runtime_config()
    workspace = Path(cfg["agents"]["defaults"]["workspace"]).expanduser()
    builtin_root = _skills_dir()
    workspace_root = workspace / "skills"
    legacy_roots = [
        _repo_root() / ".desktop-data" / "workspace" / "skills",
        Path.home() / "AppData" / "Roaming" / "com.nanobot.desktop" / "workspace" / "skills",
        Path.home() / "AppData" / "Local" / "NanobotDesktop" / "workspace" / "skills",
    ]
    items: list[dict[str, Any]] = []
    seen_files: set[str] = set()

    roots: list[tuple[Path, str]] = [(builtin_root, "builtin"), (workspace_root, "workspace")]
    for legacy_root in legacy_roots:
        if legacy_root not in (builtin_root, workspace_root):
            roots.append((legacy_root, "workspace"))

    for source_root, source_name in roots:
        if not source_root.exists():
            continue
        for skill_dir in sorted(source_root.iterdir()):
            if not skill_dir.is_dir():
                continue
            skill_file = skill_dir / "SKILL.md"
            if not skill_file.exists():
                continue
            skill_key = str(skill_file.resolve())
            if skill_key in seen_files:
                continue
            seen_files.add(skill_key)
            metadata = parse_skill_metadata(skill_file)
            items.append(
                {
                    "name": skill_dir.name,
                    "source": source_name,
                    "path": str(skill_file),
                    "available": True,
                    "always": metadata.get("always") in (True, "true"),
                    "metadata": metadata,
                    "editable": source_name == "workspace",
                }
            )

    return {
        "workspace": str(workspace),
        "skillsDirectory": str(workspace_root),
        "items": items,
    }


def create_workspace_skill(name: str) -> dict[str, Any]:
    skill_name = normalize_skill_name(name)
    skill_dir = get_workspace_skills_dir() / skill_name
    if skill_dir.exists():
        raise ValueError(f"Skill '{skill_name}' 已存在")
    skill_dir.mkdir(parents=True, exist_ok=False)
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text(
        f"---\nname: {skill_name}\ndescription: TODO\nalways: false\n---\n\n# {skill_name}\n\n在这里描述这个 skill 的用途、触发条件和执行规则。\n",
        encoding="utf-8",
    )
    return {"name": skill_name, "path": str(skill_file)}


def delete_workspace_skill(name: str) -> None:
    skill_name = normalize_skill_name(name)
    skill_dir = get_workspace_skills_dir() / skill_name
    if not skill_dir.exists():
        raise ValueError(f"Skill '{skill_name}' 不存在")
    shutil.rmtree(skill_dir)


def normalize_skill_name(value: str) -> str:
    skill_name = (value or "").strip()
    if not SKILL_NAME_RE.fullmatch(skill_name):
        raise ValueError("Skill 名称只支持字母、数字、点、下划线和短横线，且必须以字母或数字开头")
    return skill_name


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
