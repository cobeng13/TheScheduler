from __future__ import annotations

import sys
import threading
import webbrowser
from pathlib import Path

import uvicorn


def main() -> None:
    root = Path(__file__).resolve().parent
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    def open_browser() -> None:
        webbrowser.open("http://127.0.0.1:8000")

    threading.Timer(1.0, open_browser).start()
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, log_level="info")


if __name__ == "__main__":
    main()
