# Querii

**Querii** is an ultra-fast, local-first SQL database tool built specifically for complex data manipulation and rapid exporting. It combines a seamless, modern web UI (via `pywebview`) with robust local database connections (SQLite, MySQL, PostgreSQL) and high-fidelity PDF/CSV exports.

## 🚀 Features
- **Lightning Fast Filtering:** Filter millions of rows on the client-side without touching the database. Includes Global Find with match highlighting.
- **Ultra Dev Mode (PDF):** A live-preview PDF studio. Manipulate document settings, column widths, header titles, and inject custom CSS on-the-fly using a headless Chromium renderer.
- **Advanced SQL Mode:** Write your own complex queries, joins, inserts, drops, or alters and execute them instantly.
- **Smart Schema Explorer:** Click columns in the sidebar to auto-inject them into the editor with intelligent comma handling.
- **Theme Engine:** Fully adaptive modern themes (Light/Dark/Auto) across the UI.

## 🛠️ Tech Stack
- **Backend:** Python 3, `pywebview`
- **Database:** `sqlite3`, `mysql-connector-python`, `psycopg2`
- **Frontend:** Vanilla JS, HTML, Tailwind-inspired custom CSS
- **PDF Export:** Headless Chromium/Chrome for HTML/CSS rendering with a `reportlab` fallback.

## 📦 Developer Info

### Running the App
```bash
python main.py
```

### Ultra Dev Mode Architecture
When you click **Ultra Dev Mode** in the export panel:
1. `pdf_dev_mode.js` is dynamically injected into the main document.
2. A frosted glass UI is overlaid, rendering the settings panel.
3. The preview uses an iframe with `srcdoc` to render a miniature version of the exact HTML/CSS that headless Chromium will receive.
4. Saving delegates to Python (`api.py`) which builds the HTML via `_build_pdf_html` (in `core/exporter.py`) and pipes it into Chrome via subprocess.

### Project Structure
- `main.py` - Entry point, sets up the window.
- `api.py` - Bridge between the JS frontend and Python backend.
- `core/db.py` - Database connection and query execution.
- `core/exporter.py` - CSV & PDF rendering (ReportLab & HTML/Chromium).
- `web/` - Frontend assets (`index.html`, `app.js`, `style.css`, `pdf_dev_mode.js`).

## 🛡️ Requirements
- Python 3.8+
- Chromium or Google Chrome (for high-fidelity PDF HTML export)

## 🔖 Version
**v4.0 Final Beta**
