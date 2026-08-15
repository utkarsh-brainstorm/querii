#!/usr/bin/python3
"""
main.py  — Querii
=================
Launches Querii in a native OS WebView window.
  • Linux   → GTK3 + WebKit2GTK
  • macOS   → WKWebView
  • Windows → Edge WebView2
"""

from __future__ import annotations

import os
import sys

if getattr(sys, "frozen", False):
    ROOT = sys._MEIPASS
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

os.environ["GDK_BACKEND"] = "x11"
os.environ["WEBKIT2_DISABLE_HW_ACCELERATION"] = "1"
os.environ["WEBKIT_DISABLE_COMPOSITING_MODE"] = "1"
os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (
    "--proxy-server='direct://' --proxy-bypass-list=*"
)


def _check_linux_backend() -> None:
    if sys.platform != "linux":
        return
    try:
        import gi
        gi.require_version("WebKit2", "4.1")
        from gi.repository import WebKit2  # noqa: F401
    except Exception:
        try:
            import gi
            gi.require_version("WebKit2", "4.0")
            from gi.repository import WebKit2  # noqa: F401
        except Exception:
            print(
                "\n[ERROR] WebKit2GTK not found.\n"
                "Install it with:\n"
                "  sudo apt install python3-gi python3-gi-cairo gir1.2-webkit2-4.1\n"
                "Then re-run the app.\n"
            )
            sys.exit(1)


_check_linux_backend()

import webview          # noqa: E402
import core.db as db   # noqa: E402
from api import Api     # noqa: E402


def main() -> None:
    db.init_db()
    api = Api()

    html_path = os.path.join(ROOT, "web", "index.html")
    if not os.path.isfile(html_path):
        raise FileNotFoundError(
            f"Frontend not found at {html_path}\n"
            "Ensure the 'web/' directory is present alongside main.py."
        )

    window = webview.create_window(
        title            = "Querii — Sheet to SQL",
        url              = f"file://{html_path}",
        js_api           = api,
        width            = 1024,
        height           = 768,
        min_size         = (800, 600),
        easy_drag        = False,
        background_color = "#F7F7F8",
    )

    api.set_window(window)
    window.events.closed += lambda: os._exit(0)

    webview.start(debug="--debug" in sys.argv)


if __name__ == "__main__":
    main()
