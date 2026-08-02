# Querii — Sheet to SQL

**Querii** is a general-purpose desktop tool that reads any flat tabular file (XLS, XLSX, CSV) and converts it into a queryable SQLite database — with a full SQL editor, visual filter builder, schema help panel, and export to CSV/PDF.

Forked from [AttendanceProcessor](../Atndnc_prcs) — all attendance-specific logic has been stripped out.

---

## Features

| Feature | Description |
|---|---|
| 📂 **Universal import** | Drop any `.xls`, `.xlsx`, `.xlsm`, or `.csv` file |
| 🔍 **Schema preview** | See detected columns, inferred types, and sample values before committing |
| 📐 **Type inference** | Auto-detects INTEGER / REAL / DATE / TIME / TEXT from sample values |
| 🗂 **Multi-table** | Each file gets its own SQLite table; supports JOIN across tables in SQL |
| 🔧 **Visual filter builder** | Dynamic dropdowns built from the active table's actual columns |
| 📊 **Aggregate & Group** | SELECT, GROUP BY, HAVING builder |
| ✏️ **Raw SQL editor** | Full SELECT query support with line numbers and Ctrl+Enter |
| 📋 **Schema panel** | Right-sidebar shows all tables, column types, and copyable SQL templates |
| 💾 **Saved Reports** | Save any SQL query as a named one-click shortcut |
| ⬇️ **Export** | CSV and PDF (themed, includes SQL query at bottom) |
| 🎨 **Themes** | Multiple dark/light themes |

## Installation

```bash
cd querii
pip install -r requirements.txt
python3 main.py
```

### Linux requirements
```bash
sudo apt install python3-gi python3-gi-cairo gir1.2-webkit2-4.1
```

## How to use

1. **Drop a file** — Drag-and-drop or click Browse. Supported: `.xls`, `.xlsx`, `.xlsm`, `.csv`
2. **Preview** — Querii shows detected columns with inferred types and sample values. Adjust the header row number if your sheet has title rows above the actual column headers.
3. **Confirm** — Click Import. The sheet becomes a SQLite table (`my_file_name`).
4. **Select table** — Pick the active table from the dropdown in the Search panel.
5. **Filter** — Add filter rows. Field dropdowns are automatically populated from the table's columns.
6. **SQL** — The SQL editor auto-fills from the filter builder. Write any `SELECT` query manually. Hit `Ctrl+Enter` to run.
7. **Schema** — The right panel's Schema tab shows all tables, column types, and clickable SQL templates.
8. **Export** — Click `⬇ CSV` or `📄 PDF` in the Results panel.

## Type inference rules

| Condition | SQLite type |
|---|---|
| All values are whole numbers | `INTEGER` |
| All values are decimal numbers | `REAL` |
| All values match date patterns (YYYY-MM-DD, DD/MM/YY, etc.) | `DATE` |
| All values match time patterns (HH:MM, HH:MM:SS) | `TIME` |
| Everything else | `TEXT` |

## Project structure

```
querii/
├── main.py             — App launcher (pywebview)
├── api.py              — Python↔JS API bridge
├── requirements.txt
├── core/
│   ├── schema.py       — Type inference & schema introspection
│   ├── importer.py     — Generic XLS/XLSX/CSV reader
│   ├── db.py           — Dynamic SQLite table management
│   ├── query_builder.py— Dynamic WHERE/SELECT/GROUP builder
│   └── exporter.py     — CSV + PDF export
├── web/
│   ├── index.html      — Main UI (3-panel layout)
│   ├── app.js          — Frontend logic
│   ├── style.css       — Styles + themes
│   └── themes.js       — Theme definitions
└── data/               — SQLite DB stored here
```
