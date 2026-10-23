#!/usr/bin/python3
"""
main.py  — Querii
=================
Launches Querii in a native OS WebView window.
  • Linux   → GTK3 + WebKit2GTK
  • macOS   → WKWebView
  • Windows → Edge WebView2

Data is stored in the OS user-data directory so it persists
across app updates and works correctly in packaged executables:
  • Linux   → ~/.local/share/querii/
  • macOS   → ~/Library/Application Support/Querii/
  • Windows → %APPDATA%\\Querii\\
"""

from __future__ import annotations

import os
import sys

if getattr(sys, "frozen", False):
    ROOT = sys._MEIPASS
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (
    "--proxy-server=direct:// --proxy-bypass-list=*"
)

# ── Linux platform fixes (X11/XWayland + Full GPU Acceleration) ─────────────
if sys.platform == "linux":
    if os.environ.get("DISPLAY"):
        os.environ["GDK_BACKEND"] = "x11"
    # Remove any software-fallback flags so WebKitGTK uses full GPU acceleration
    os.environ.pop("WEBKIT_DISABLE_COMPOSITING_MODE", None)
    os.environ.pop("WEBKIT_DISABLE_DMABUF_RENDERER", None)
    os.environ.pop("WEBKIT_DMABUF_RENDERER_FORCE_SHM", None)

if getattr(sys, "frozen", False) and sys.platform == "linux":
    os.environ.setdefault("PYWEBVIEW_GUI", "qt")
    os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")


def _get_user_data_dir() -> str:
    """
    Return a persistent, writable directory for Querii's data.
    This works both in development and in packaged executables.
    """
    if sys.platform == "win32":
        # %APPDATA%\Querii
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        return os.path.join(base, "Querii")
    elif sys.platform == "darwin":
        # ~/Library/Application Support/Querii
        return os.path.join(os.path.expanduser("~"), "Library", "Application Support", "Querii")
    else:
        # Linux / other: follow XDG spec → ~/.local/share/querii
        xdg = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
        return os.path.join(xdg, "querii")


import webview          # noqa: E402
import core.db as db   # noqa: E402
from api import Api     # noqa: E402


def _run_app() -> None:
    # ── Set persistent user-data directory before init_db ──────────────
    data_dir = _get_user_data_dir()
    os.makedirs(data_dir, exist_ok=True)
    db_path = os.path.join(data_dir, "querii.db")
    db.set_db_path(db_path)

    db.init_db()
    api = Api()

    # ── Resolve frontend HTML path ──────────────────────────────────────────
    html_path = os.path.join(ROOT, "web", "index.html")
    if not os.path.isfile(html_path):
        raise FileNotFoundError(
            f"Frontend not found at {html_path}\n"
            "Ensure the 'web/' directory is present alongside main.py."
        )

    # ── Resolve Icon (.ico on Windows, .png on Linux/macOS) ──────────────────
    if sys.platform == "win32":
        icon_path = os.path.join(ROOT, "app_icon.ico")
        if not os.path.exists(icon_path):
            icon_path = os.path.join(ROOT, "web", "app_icon.ico")
        if not os.path.exists(icon_path):
            icon_path = os.path.join(ROOT, "web", "favicon.ico")
    else:
        icon_path = os.path.join(ROOT, "app_icon.png")
        if not os.path.exists(icon_path):
            icon_path = os.path.join(ROOT, "web", "app_icon.png")
        if not os.path.exists(icon_path):
            icon_path = os.path.join(ROOT, "app_icon.ico")
        if not os.path.exists(icon_path):
            icon_path = os.path.join(ROOT, "web", "app_icon.ico")

    window = webview.create_window(
        title            = "Querii Version 4.3 — Sheet to SQL",
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

    # ── Start the event loop (picks best available native renderer) ─────────
    start_kwargs: dict = {
        "debug": "--debug" in sys.argv,
    }
    # On Windows, pywebview strictly requires .ico file format for WinForms Icon
    if icon_path and os.path.exists(icon_path):
        if sys.platform == "win32":
            if icon_path.lower().endswith(".ico"):
                start_kwargs["icon"] = icon_path
        else:
            start_kwargs["icon"] = icon_path

    def _on_started() -> None:
        if sys.platform == "linux":
            # Qt icon & desktop setup
            try:
                from PyQt6.QtGui import QIcon
                from PyQt6.QtWidgets import QApplication
                qapp = QApplication.instance()
                if qapp:
                    qapp.setDesktopFileName("querii")
                    if icon_path and os.path.exists(icon_path):
                        qapp.setWindowIcon(QIcon(icon_path))
            except Exception:
                pass

            # WebKitGTK full GPU hardware acceleration enforcement
            try:
                import webview.platforms.gtk as wv_gtk
                from gi.repository import WebKit2
                for uid, bv in getattr(wv_gtk.BrowserView, 'instances', {}).items():
                    if hasattr(bv, 'webview'):
                        ws = bv.webview.get_settings()
                        ws.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.ALWAYS)
            except Exception:
                pass

    webview.start(_on_started, **start_kwargs)


def main() -> None:
    try:
        _run_app()
    except Exception as exc:
        import traceback
        from datetime import datetime
        err_msg = traceback.format_exc()

        try:
            data_dir = _get_user_data_dir()
            os.makedirs(data_dir, exist_ok=True)
            crash_path = os.path.join(data_dir, "crash.log")
            with open(crash_path, "a", encoding="utf-8") as f:
                f.write(f"\n--- Crash on {datetime.now().isoformat()} ---\n{err_msg}\n")
        except Exception:
            pass

        if sys.platform == "win32":
            try:
                import ctypes
                ctypes.windll.user32.MessageBoxW(
                    0,
                    f"Querii failed to start:\n\n{exc}\n\n"
                    f"A crash log has been saved to:\n%APPDATA%\\Querii\\crash.log",
                    "Querii - Startup Error",
                    0x10,  # MB_ICONERROR
                )
            except Exception:
                pass
        print(err_msg, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
