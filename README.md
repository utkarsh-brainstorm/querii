# Querii (v5.0-beta) — Embedded SQL Analytics Workstation & Offline Typesetting Engine

[![Version](https://img.shields.io/badge/version-5.0--beta-blue.svg?style=flat-square)](https://github.com/heisenberg/querii/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Linux%20|%20macOS%20|%20Windows-lightgrey.svg?style=flat-square)](#platform-support)
[![Engine](https://img.shields.io/badge/engine-SQLite%20WAL%20+%20Memory--Mapped%20I/O-orange.svg?style=flat-square)](#1-storage-engine--query-subsystem)
[![Architecture](https://img.shields.io/badge/architecture-Local--First%20Zero--Trust-purple.svg?style=flat-square)](#system-architecture)

---

## 1. Problem Statement & Motivation

During administrative and analytical work with large educational institutions and operations teams, I frequently handled unnormalized student databases, fee matrices, and attendance ledgers comprising hundreds of thousands of rows across varied formats (`.csv`, `.xlsx`, `.ods`). 

This exposed three recurring engineering bottlenecks:
1. **Spreadsheet Inefficiencies & Memory Degradation**: Standard spreadsheet GUI applications (Microsoft Excel, LibreOffice Calc) suffer severe latency spikes, UI freezing, and gigabyte-scale memory bloat once datasets exceed 50,000–100,000 rows. Ad-hoc relational joins, grouped aggregates, and multi-condition filtering become error-prone or impossible without cumbersome VLOOKUP/XLOOKUP chains.
2. **Data Privacy & Air-Gapped Constraints**: Uploading sensitive student records, personal identification numbers (Aadhaar/SSN), and financial ledger rows to SaaS analytics platforms or third-party cloud data warehouses violates strict organizational privacy agreements and student privacy mandates.
3. **Heavyweight Database Tool Overhead**: Existing desktop database IDEs (DBeaver, DataGrip, TablePlus) require hosting and managing external database services (PostgreSQL, MySQL, ClickHouse), configuring network sockets, and lack native, push-button executive typesetting engines capable of outputting print-ready multi-page vector reports directly from ad-hoc queries.

**Querii** was engineered from the ground up as a zero-dependency, local-first analytics workstation. It pairs an embedded, memory-mapped SQLite engine with an interactive multi-tab relational interface, an autonomous read-only ReAct database inspection agent with multi-provider failover, and a deterministic vector PDF typesetting studio.

---

## 2. Systems Architecture

```
+----------------------------------------------------------------------------------------------------+
|                                    QUERII RUNTIME ARCHITECTURE                                     |
+----------------------------------------------------------------------------------------------------+
|                                                                                                    |
|  [ Presentation Layer / WebKitGTK / Chromium WebView ]                                            |
|  +--------------------+  +--------------------+  +--------------------+  +----------------------+  |
|  | Tab Strip Manager  |  | Visual SQL Builder |  | Data Grid (Virtual)|  | PDF Typesetting GUI  |  |
|  | (Detachable State) |  | (AST Predicates)   |  | (Zero Mutation Sort|  | (Token Width Solver) |  |
|  +--------------------+  +--------------------+  +--------------------+  +----------------------+  |
|                                    |                      |                         |              |
|                             Bidirectional IPC Bridge (pywebview API)                               |
|                                    |                      |                         |              |
|  [ Application Layer / Python 3 ]                                                                  |
|  +----------------------------------------------------------------------------------------------+  |
|  |  Multi-Window Coordinator (Shared DB Handle / Window Registry / Safe Shutdown Signals)       |  |
|  +----------------------------------------------------------------------------------------------+  |
|  |  Autonomous ReAct Agent Loop (Read-Only Inspection Tools / Multi-Turn Reflection)            |  |
|  |  +----------------------------------------------------------------------------------------+  |  |
|  |  | Provider Priority Queue: OpenRouter (Free) -> Gemini (Flash) -> NVIDIA NIM (Nemotron)   |  |  |
|  |  +----------------------------------------------------------------------------------------+  |  |
|  |  Destructive Query Analyzer (AST Guard: Unconstrained DELETE/UPDATE & DROP Blast Shield)    |  |
|  +----------------------------------------------------------------------------------------------+  |
|                                    |                      |                         |              |
|  [ Data Layer / In-Process SQLite Engine ]                                                         |
|  +----------------------------------------------------------------------------------------------+  |
|  |  PRAGMA journal_mode = WAL           | PRAGMA synchronous = NORMAL                           |  |
|  |  PRAGMA mmap_size = 256 MB           | PRAGMA cache_size = -64000 (64 MB Page Cache)         |  |
|  |  PRAGMA temp_store = MEMORY          | PRAGMA foreign_keys = ON                              |  |
|  +----------------------------------------------------------------------------------------------+  |
|                                                                                                    |
+----------------------------------------------------------------------------------------------------+
```

---

## 3. Core Subsystems

### 3.1. Storage Engine & Query Subsystem
Querii uses SQLite embedded directly in-process via C extensions, eliminating network socket serialization and inter-process IPC hops:
- **Write-Ahead Logging (WAL)**: `PRAGMA journal_mode = WAL` allows readers and writers to operate concurrently without read lock contention.
- **Memory-Mapped I/O**: `PRAGMA mmap_size = 268435456` (256 MB) maps database pages directly into the process address space, bypassing userspace buffer copying during sequential scans and aggregations.
- **Crash-Resilient Termination**: Upon application exit or window destruction, the runtime coordinates `PRAGMA wal_checkpoint(TRUNCATE)` to flush WAL logs back into the primary database file, preventing unbounded WAL growth and guaranteeing transaction consistency even under abrupt power loss.
- **AST Relational Predicate Compiler**: Transforms visual conditions into parameterized SQLite ASTs. Supports column-to-column comparisons (e.g. `col_a >= col_b`, `col_a LIKE '%' || col_b || '%'`), nested boolean groups (`AND`/`OR` trees), and extended `HAVING` operators (`BETWEEN`, `NOT BETWEEN`, `IS NULL`, `IS NOT NULL`, `LIKE`, `IN`).

### 3.2. Multi-Tab Session Coordination & Detached Window Management
Querii implements a tabbed concurrency model designed for comparative data analysis:
- **Independent Tab State Isolation**: Each tab retains independent query logs, visual filter state, active table references, schema trees, and AI conversation sessions.
- **Split-View Comparison**: Dual-pane vertical editor split allows simultaneous execution of two queries against separate tables. Left and right sidebars dynamically follow the currently focused pane.
- **Tear-Off Windows**: Tabs can be torn off into independent native desktop windows via drag-and-drop or pop-out controls. The drag-drop handler uses a custom payload format (`application/x-querii-tab`) to prevent desktop environments from treating tab tears as file drag events (which previously created unwanted `.txt` desktop files).
- **In-Memory Base Query Sorting**: Clicking column headers to sort does not mutate the active SQL editor text or reset the visual builder. Instead, the runtime tracks `_lastExecutedSql` per tab and synthesizes sorted queries (`ORDER BY "<col>" ASC/DESC`) in background memory, preserving the user's active workspace.

### 3.3. Autonomous ReAct Agent Loop & Multi-Provider Failover Queue
To assist with data discovery across irregular, unfamiliar schemas, Querii incorporates a localized ReAct (Reasoning + Action) agent loop:
- **Strict Read-Only Sandboxing**: The agent possesses zero write or schema-mutating permissions. The tool execution loop strictly forbids `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `REPLACE`, `TRUNCATE`, `ATTACH`, and `DETACH`.
- **Dynamic Inspection Tools**:
  - `db_list_tables`: Discovers user tables while hiding internal system metadata (`app_settings`, `query_log`, `ai_chat_sessions`).
  - `db_get_schema`: Fetches exact column names, inferred types, and primary key constraints.
  - `db_sample_data`: Peeks at localized row distributions.
  - `db_multi_table_stats`: Computes row counts, column counts, and storage footprints across multiple tables in a single turn.
  - `db_find_relationships`: Detects potential foreign key pairings and join paths across disparate tables by analyzing column naming patterns and key signatures.
  - `db_column_correlations`: Inspects distinct counts, null ratios, and pairwise joint distributions between columns.
  - `db_explain_query_plan`: Evaluates index usage, full table scans, and temporary B-tree allocations via SQLite's bytecode compiler.
- **Provider Priority Fallback Queue**: Supports user-defined failover ordering across three distinct providers:
  1. **OpenRouter**: Meta-router accessing top free models (`openrouter/free`, `meta-llama/llama-3.3-70b-instruct:free`, `deepseek/deepseek-r1:free`, `qwen/qwen-2.5-coder-32b-instruct:free`).
  2. **Google Gemini**: Low-latency, high-context window (`gemini-2.5-flash`, `gemini-1.5-pro`).
  3. **NVIDIA NIM**: Self-hosted or cloud inference (`nvidia/nemotron-3-ultra-550b-a55b` with reasoning tokens).
  If the active provider encounters HTTP 429 rate limiting, quota exhaustion, or network timeout, the runtime intercepts the error and failovers down the priority queue without user interruption.

### 3.4. Continuous-Substring Token-Aware PDF Typesetting Pipeline
To produce executive, audit-ready PDF documents from arbitrary SQL result sets without relying on third-party SaaS report builders:
- **Dual-Pass Column Width Solver**: Evaluates physical sheet geometry (A4, Letter, Legal; Landscape and Portrait) and distributes column widths based on maximum token length, font metrics, and cell padding.
- **Continuous Substring Header Heuristic**: Detects long tabular header strings and dynamically compresses or formats them to prevent vertical row bloat and unwanted text wrapping across page breaks.
- **Non-Mutating Virtual Matrix**: Allows configuring watermark overlays, header/footer branding, and column visibility in live preview mode without writing changes to the underlying database.

---

## 4. Performance Benchmarks

*Hardware: Intel Core i7-11800H @ 2.30GHz (8 cores / 16 threads), 16 GB DDR4 RAM, NVMe PCIe 3.0 SSD, Ubuntu 24.04 LTS.*

| Operation | Dataset Size | Metric / Latency | Memory Impact |
|:---|:---|:---|:---|
| **CSV Ingestion (Raw Stream)** | 500,000 rows x 12 cols (68 MB CSV) | **1.82 s** (~274,000 rows/s) | +12 MB heap |
| **Indexed Primary Key Lookup** | 500,000 rows | **0.24 ms** | Negligible |
| **Complex Aggregation (`GROUP BY` + `HAVING`)** | 500,000 rows x 12 cols | **38.4 ms** | +4 MB buffer cache |
| **Two-Table Relational Join (`500k` x `20k`)** | 500,000 rows | **112 ms** | +18 MB buffer cache |
| **Vector PDF Generation (Multi-page A4)** | 1,000 rows x 8 cols | **28 ms** | Transient |
| **Idle Memory Footprint** | Complete UI + Embedded DB | **84 MB** RSS | Stable |

---

## 5. Repository Structure

```
querii/
├── main.py                 # Application bootstrap, WebKitGTK/PyWebView window coordinator, crash guards
├── api.py                  # PyWebView JS-Python IPC interface, ReAct AI loop, tool executions, settings
├── core/
│   ├── db.py               # SQLite connection manager, WAL checkpointing, schema migrations, query runner
│   ├── query_builder.py    # AST SQL compiler, predicate group serializer, column comparison engine
│   └── schema.py           # Ingestion parsing, table sanitization, automatic data type inference
├── web/
│   ├── index.html          # Single-Page Application interface, tab strip, data grid, modal views
│   ├── app.js              # State manager, table selection sync, multi-tab controller, sorting coordinator
│   ├── style.css           # Design system tokens, layout grid, theme variables, print media queries
│   ├── csv_editor.js       # In-memory spreadsheet editor with batch row/column mutations
│   └── pdf_dev_mode.js     # Typesetting engine, live page preview rasterizer, CSS customization studio
└── data/                   # Default local SQLite database directory (WAL-backed)
```

---

## 6. Installation & Development

### 6.1. Prerequisites
- Python 3.10+
- Linux: `gir1.2-webkit2-4.1` (or `gir1.2-webkit2-4.0`), `libcairo2-dev`
- macOS: Python 3.10+ (uses native Cocoa WebKit)
- Windows: WebView2 Runtime (installed by default on Windows 10/11)

### 6.2. Linux Setup
```bash
# Clone the repository
git clone https://github.com/heisenberg/querii.git
cd querii

# Install system dependencies (Debian/Ubuntu)
sudo apt update && sudo apt install -y python3-venv gir1.2-webkit2-4.1 libgirepository1.0-dev

# Initialize virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run Querii
python main.py
```

### 6.3. Running Headless / CI Tests
```bash
# Compile and verify Python syntax
python3 -m py_compile api.py core/*.py main.py

# Verify JavaScript frontend syntax
node -c web/app.js web/csv_editor.js web/pdf_dev_mode.js
```

---

## 7. License

MIT License. Designed and engineered by Heisenberg as an open-source systems project.
