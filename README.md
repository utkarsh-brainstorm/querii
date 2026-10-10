# Querii

**Querii** is a lightning-fast, local-first SQL analytics and reporting workstation built specifically for rapid data manipulation, query analysis, and executive-grade PDF/CSV exports. It pairs a polished desktop web UI (powered by `pywebview`) with high-performance local database drivers and a hybrid **dual-engine PDF export pipeline** (native Rust vector engine + Headless Chrome HTML/CSS studio).

---

## ⚡ Key Highlights

- **⚡ Native Rust PDF Engine:** Custom Rust vector generator (`printpdf`) rendering 1,000+ rows across dozens of pages in **under 35 ms** — a 350x speedup over traditional tools.
- **🎨 Ultra Dev Mode & PDF Studio:** Fullscreen interactive PDF studio with live preview, preserved scroll offsets, column width sliders, custom headers, and 1-click styling presets.
- **🏢 Executive-Grade Templates:** Modern corporate styling inspired by Stripe & Linear — clean sans-serif typography, dark slate headers, tabular numbers, subtle row zebra accents, and multi-page repeating table headers.
- **🔍 Client-Side Global Search:** Fast client-side global find across millions of cells with dynamic text highlighting and keyboard navigation.
- **🛠️ Advanced SQL Workspace:** Execute ad-hoc queries, joins, mutations, and table schema management across SQLite, MySQL, and PostgreSQL.
- **📋 Smart Schema Explorer:** Quick-insert columns with intelligent comma management directly into the SQL query builder.
- **🌓 Adaptive Theme Engine:** Auto, Light, and Dark themes with customizable accent colors and custom typography.

---

## 🚀 Dual-Engine PDF Export Architecture

Querii provides two complementary PDF generation engines to balance extreme velocity with rich design flexibility:

```
                          ┌──────────────────────────┐
                          │  Frontend Export Action   │
                          └─────────────┬────────────┘
                                        │
                 ┌──────────────────────┴──────────────────────┐
                 ▼                                             ▼
   ⚡ Native Rust Engine (<35ms)                🎨 Headless Chrome Engine (<1.5s)
   • Binary: core/querii-pdf                     • Uses local Google Chrome / Chromium
   • Zero dependency, pure vector graphics        • Full HTML5, CSS3, Flexbox & Print CSS
   • Instant multi-page pagination               • 1-Click Executive Style Presets
   • Auto-scaling column widths                  • Custom CSS injection & Live Iframe Preview
   • Fallback: ReportLab Python library          • Dev workspace (data.csv, style.css, render.py)
```

### 1. ⚡ Native Rust Vector Engine (`core/querii-pdf`)
- Written in Rust using `printpdf` and `serde_json`.
- Accepts structured JSON payloads via `--stdin` or file arguments.
- Generates standards-compliant, compact vector PDFs with deterministic pagination and header repetition.
- **Benchmark:** 1,000 records × 7 columns renders in **33.36 ms** (350x faster than WeasyPrint).

### 2. 🎨 Executive HTML/CSS Engine (`Headless Chromium`)
- Automatically locates the system's Google Chrome or Chromium binary.
- Renders executive-grade reports with modern typography (`Plus Jakarta Sans`), subtle borders, status badges, and optional SQL code blocks.
- Seamlessly injects user-defined CSS without blocking the desktop event loop.

---

## 🛠️ Project Structure

```
querii/
├── api.py                    # Bridge between JavaScript UI and Python backend
├── main.py                   # Desktop application launcher (pywebview initialization)
├── core/
│   ├── db.py                 # SQLite, MySQL, and PostgreSQL database connections
│   ├── exporter.py           # Orchestrates Rust, Chromium, and ReportLab PDF/CSV exports
│   ├── importer.py           # CSV/Excel data ingestion and preview logic
│   ├── query_builder.py      # Visual SQL query generation and AST building
│   ├── querii-pdf            # Pre-compiled high-performance Rust PDF binary (Linux)
│   └── rust_engine/          # Rust engine source code
│       ├── Cargo.toml
│       └── src/
│           └── main.rs       # Vector PDF renderer implementation
└── web/
    ├── index.html            # Main application UI and modal dialogs
    ├── app.js                # Core frontend state, search, query runner, and handlers
    ├── pdf_dev_mode.js       # Ultra Dev Mode PDF Studio (live preview & presets)
    ├── themes.js             # Theme switcher and style palette definitions
    └── style.css             # Base application stylesheet
```

---

## 💻 Developer Guide

### Prerequisites
- **Python:** 3.8 or higher
- **Browser (for HTML PDF mode):** Google Chrome or Chromium (`google-chrome` / `chromium-browser`)
- **Rust (optional, to rebuild native engine):** Cargo 1.70+

### Setup & Run
```bash
# Clone the repository
git clone https://github.com/your-username/querii.git
cd querii

# Install Python dependencies
pip install pywebview reportlab

# Launch Querii
python main.py
```

### Rebuilding the Rust PDF Engine
If you modify `core/rust_engine/src/main.rs`:
```bash
cd core/rust_engine
cargo build --release
cp target/release/rust_engine ../querii-pdf
chmod +x ../querii-pdf
```

### Ultra Dev Mode Workflow
1. Run any query in the app.
2. Click **Export → Ultra Dev Mode** (or click the 🎨 palette icon).
3. The editor opens with live data pre-populated.
4. Try the 1-click style presets:
   - **🏢 Slate:** Clean corporate palette with deep navy accents.
   - **📰 Minimal:** Financial monospace layout with high data density.
   - **🌲 Emerald:** Elegant corporate green styling.
   - **🟣 Tech:** Indigo and violet modern aesthetic.
   - **📏 Compact:** Ultra-dense layout for wide tables.
5. Adjust column widths with sliders or click **⚖ Equal Widths**.
6. Press `Ctrl+S` anytime to instantly refresh the preview without losing scroll position.
7. Click **🖨 Export PDF** to generate the final document.

---

## 🔖 Version
**v4.0 Final Beta**
