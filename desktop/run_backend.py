from __future__ import annotations

import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = Path(__file__).resolve().parent / "backend"
for path in (ROOT_DIR, BACKEND_DIR):
    text = str(path)
    if text not in sys.path:
        sys.path.insert(0, text)

from nanobot_desktop_backend.app import main


if __name__ == "__main__":
    main()
