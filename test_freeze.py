import webview
import time
import os
import sys

sys.path.insert(0, '/home/heisenberg/BuilderValley/querii')
import core.db as db
from api import Api

db.init_db()
api = Api()

def custom_logic(window):
    print("Waiting for JS ready...")
    time.sleep(2)
    # Check if api is there
    html = window.evaluate_js('document.documentElement.outerHTML')
    with open('debug_dom.html', 'w') as f:
        f.write(html)
    print("Saved DOM to debug_dom.html")
    window.destroy()

if __name__ == '__main__':
    window = webview.create_window(
        title="Test",
        url="web/index.html",
        js_api=api
    )
    api.set_window(window)
    webview.start(custom_logic, window)
