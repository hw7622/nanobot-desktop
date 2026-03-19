from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

DEFAULT_ENDPOINT = "https://github.com/hw7622/nanobot-desktop/releases/latest/download/latest.json"
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "desktop" / "src-tauri" / "tauri.conf.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare tauri.conf.json for a signed desktop release build."
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG,
        help="Path to tauri.conf.json",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config_path = args.config.resolve()

    endpoint = os.environ.get("NANOBOT_DESKTOP_UPDATER_ENDPOINT", DEFAULT_ENDPOINT).strip()
    pubkey = os.environ.get("NANOBOT_DESKTOP_UPDATER_PUBKEY", "").strip()

    if not pubkey or "PLACEHOLDER" in pubkey:
        raise SystemExit(
            "Missing NANOBOT_DESKTOP_UPDATER_PUBKEY. "
            "Set the real updater public key before building a release."
        )

    config = json.loads(config_path.read_text(encoding="utf-8"))
    config.setdefault("bundle", {})["createUpdaterArtifacts"] = True
    config.setdefault("plugins", {})["updater"] = {
        "endpoints": [endpoint],
        "pubkey": pubkey,
    }

    config_path.write_text(
        json.dumps(config, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    print(f"Prepared updater config: {config_path}")
    print(f"Endpoint: {endpoint}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
