"""
api.py
======
Python API exposed to the webview frontend via window.pywebview.api.
Every public method returns { ok: bool, data: any, error: str | None }
"""

from __future__ import annotations

import json
import os
import threading
import traceback
from typing import Any, Dict, List, Optional

import webview

import core.db as db
from core import exporter
from core.exporter import (
    export_pdf_html, get_pdf_html_preview,
    write_dev_files, read_dev_file, write_dev_file_content,
)
from core.importer import preview_file, ImportPreview
from core.query_builder import (
    FilterRow, FilterGroup, QuerySpec,
    build_sql, build_where_tree,
    get_operators_for_category, sql_type_to_category,
    format_sql_readable,
)


def _ok(data: Any = None) -> dict:
    return {"ok": True, "data": data, "error": None}


def _err(msg: Any) -> dict:
    return {"ok": False, "data": None, "error": str(msg)}


def _parse_filter_groups(groups_raw: list) -> List[FilterGroup]:
    """
    Recursively parse the JS FilterGroup tree into Python FilterGroup objects.
    Each item in a group can be a condition (FilterRow) or a nested group.
    """
    result = []
    for g in groups_raw:
        grp = FilterGroup(joiner=g.get("joiner", "AND"), items=[])
        for item in g.get("items", []):
            if item.get("_type") == "group":
                # Nested group — recurse
                sub_groups = _parse_filter_groups([item])
                if sub_groups:
                    nested = sub_groups[0]
                    nested.joiner = item.get("joiner", "AND")
                    grp.items.append(nested)
            else:
                # Leaf condition
                grp.items.append(FilterRow(
                    field    = item.get("field", ""),
                    operator = item.get("operator", "equals"),
                    value    = item.get("value", ""),
                    value2   = item.get("value2", ""),
                    joiner   = item.get("joiner", "AND"),
                    category = item.get("category", "text"),
                    table_prefix = item.get("table_prefix", ""),
                    rhs_type = item.get("rhs_type", "value"),
                ))
        if grp.items:
            result.append(grp)
    return result


class Api:
    _pending_tab_states: Dict[str, str] = {}
    _window_creator_fn = None
    _transferred_tab_ids = set()
    _active_drag_tab: Optional[str] = None
    _main_tab_queue: List[str] = []

    @classmethod
    def set_window_creator(cls, fn):
        cls._window_creator_fn = fn

    @classmethod
    def set_active_drag_tab(cls, tab_json: str) -> dict:
        cls._active_drag_tab = tab_json
        return _ok(True)

    @classmethod
    def get_active_drag_tab(cls) -> dict:
        return _ok(cls._active_drag_tab)

    @classmethod
    def clear_active_drag_tab(cls) -> dict:
        cls._active_drag_tab = None
        return _ok(True)

    @classmethod
    def queue_tab_for_main(cls, tab_json: str) -> dict:
        cls._main_tab_queue.append(tab_json)
        return _ok(True)

    @classmethod
    def pop_queued_main_tabs(cls) -> dict:
        tabs = list(cls._main_tab_queue)
        cls._main_tab_queue.clear()
        return _ok(tabs)

    def __init__(self):
        self._window: Optional[webview.Window] = None
        self._import_lock = threading.Lock()
        self._pending_preview: Optional[ImportPreview] = None
        self._pending_filepath: Optional[str] = None
        self._last_result_cols: List[str] = []
        self._last_result_rows: List[dict] = []

    def set_window(self, window: webview.Window):
        self._window = window

    def get_table_row_count(self, table_name: str) -> dict:
        """Fetch row count of a table quickly for safety inspection dialogs."""
        try:
            sanitized = table_name.replace('"', '""').strip()
            cols, rows = db.execute_query(f'SELECT COUNT(*) as cnt FROM "{sanitized}"')
            cnt = rows[0]["cnt"] if rows else 0
            return _ok(cnt)
        except Exception as e:
            return _err(str(e))

    def create_new_window(self, tab_state_json: str = "", title: str = "Query") -> dict:
        """Spawn a new OS application window hosting the detached tab."""
        import uuid
        try:
            if not Api._window_creator_fn:
                return _err("Window creator not initialized")
            new_id = f"win_{uuid.uuid4().hex[:8]}"
            if tab_state_json:
                Api._pending_tab_states[new_id] = tab_state_json
            Api._window_creator_fn(new_id, title)
            return _ok({"window_id": new_id})
        except Exception as e:
            return _err(str(e))

    def get_initial_tab_state(self, window_id: str) -> dict:
        """Retrieve initial tab state when opening a detached window."""
        try:
            state = Api._pending_tab_states.pop(window_id, None)
            return _ok(state)
        except Exception as e:
            return _err(str(e))

    def notify_tab_transferred(self, tab_id: str) -> dict:
        """Mark a tab as transferred to another window so source window can close it."""
        try:
            Api._transferred_tab_ids.add(str(tab_id))
            return _ok(True)
        except Exception as e:
            return _err(str(e))

    def is_tab_transferred(self, tab_id: str) -> dict:
        """Check if a tab was transferred to another window."""
        try:
            tid = str(tab_id)
            if tid in Api._transferred_tab_ids:
                Api._transferred_tab_ids.discard(tid)
                return _ok(True)
            return _ok(False)
        except Exception as e:
            return _err(str(e))

    def save_ai_chat_session(self, session_id: str, title: str, provider: str, model: str, messages_json: str) -> dict:
        try:
            db.save_ai_session(session_id, title, provider, model, messages_json)
            return _ok(True)
        except Exception as e:
            return _err(str(e))

    def get_ai_chat_sessions(self, limit: int = 50) -> dict:
        try:
            sessions = db.get_ai_sessions(int(limit))
            return _ok(sessions)
        except Exception as e:
            return _err(str(e))

    def delete_ai_chat_session(self, session_id: str) -> dict:
        try:
            res = db.delete_ai_session(session_id)
            return _ok(res)
        except Exception as e:
            return _err(str(e))

    def save_persisted_tabs(self, tabs_json: str) -> dict:
        try:
            db.save_persisted_tabs(tabs_json)
            return _ok(True)
        except Exception as e:
            return _err(str(e))

    def get_persisted_tabs(self) -> dict:
        try:
            data = db.get_persisted_tabs()
            return _ok(data)
        except Exception as e:
            return _err(str(e))

    def _execute_readonly_db_tool(self, tool_name: str, args: dict) -> str:
        """Execute dynamic read-only database inspections for agentic AI."""
        import json
        import re
        try:
            if tool_name == "db_list_tables":
                schema = db.get_schema()
                res = []
                for s in schema:
                    t = s.get("table", "")
                    try:
                        _, r = db.execute_query(f'SELECT COUNT(*) as c FROM "{t}"')
                        cnt = r[0]["c"] if r else 0
                    except Exception:
                        cnt = 0
                    res.append({"table": t, "columns_count": len(s.get("columns", [])), "rows": cnt})
                return json.dumps(res, indent=2)

            elif tool_name == "db_get_schema":
                tbls = args.get("tables", [])
                if isinstance(tbls, str):
                    tbls = [tbls]
                schema = db.get_schema()
                simplified = []
                for s in schema:
                    t = s.get("table", "")
                    if tbls and t not in tbls:
                        continue
                    cols = [f"{c['name']} ({c['type']})" + (" PK" if c.get("pk") else "") for c in s.get("columns", []) if not c.get("name", "").startswith("_")]
                    simplified.append(f"Table '{t}': {', '.join(cols)}")
                return "\n".join(simplified) if simplified else "No matching tables found."

            elif tool_name == "db_sample_data":
                tbl = str(args.get("table", "")).strip().replace('"', '""')
                limit = min(int(args.get("limit", 5)), 20)
                if not tbl:
                    return "Error: 'table' parameter required."
                cols, rows = db.execute_query(f'SELECT * FROM "{tbl}" LIMIT {limit}')
                return json.dumps(rows, indent=2, default=str)

            elif tool_name == "db_multi_table_stats":
                tbls = args.get("tables", [])
                if isinstance(tbls, str):
                    tbls = [t.strip() for t in tbls.split(",") if t.strip()]
                all_schema = db.get_schema()
                summary = []
                for s in all_schema:
                    t = s.get("table", "")
                    if tbls and t not in tbls:
                        continue
                    try:
                        _, rc = db.execute_query(f'SELECT COUNT(*) as cnt FROM "{t}"')
                        row_count = rc[0]["cnt"] if rc else 0
                    except Exception:
                        row_count = "unknown"
                    user_cols = [c["name"] for c in s.get("columns", []) if not c.get("name", "").startswith("_")]
                    summary.append({
                        "table": t,
                        "row_count": row_count,
                        "column_count": len(user_cols),
                        "columns": user_cols[:12]
                    })
                return json.dumps(summary, indent=2, default=str)

            elif tool_name == "db_find_relationships":
                all_schema = db.get_schema()
                tables = [s for s in all_schema if s.get("table")]
                target_table = args.get("table", "").strip()
                matches = []
                for i, s1 in enumerate(tables):
                    t1 = s1["table"]
                    if target_table and t1 != target_table:
                        continue
                    cols1 = {c["name"].lower(): c["name"] for c in s1.get("columns", []) if not c["name"].startswith("_")}
                    for j, s2 in enumerate(tables):
                        t2 = s2["table"]
                        if t1 == t2:
                            continue
                        cols2 = {c["name"].lower(): c["name"] for c in s2.get("columns", []) if not c["name"].startswith("_")}
                        common = set(cols1.keys()).intersection(set(cols2.keys()))
                        for col_key in common:
                            matches.append({
                                "table1": t1,
                                "column1": cols1[col_key],
                                "table2": t2,
                                "column2": cols2[col_key],
                                "suggested_join": f'"{t1}"."{cols1[col_key]}" = "{t2}"."{cols2[col_key]}"'
                            })
                return json.dumps(matches[:25], indent=2, default=str) if matches else "No obvious common join columns detected across tables."

            elif tool_name == "db_column_correlations":
                tbl = str(args.get("table", "")).strip().replace('"', '""')
                col1 = str(args.get("col1", "")).strip().replace('"', '""')
                col2 = str(args.get("col2", "")).strip().replace('"', '""')
                if not tbl or not col1 or not col2:
                    return "Error: 'table', 'col1', and 'col2' required."
                q = f"""
                SELECT
                    COUNT(*) as total_rows,
                    COUNT("{col1}") as col1_non_null,
                    COUNT("{col2}") as col2_non_null,
                    COUNT(DISTINCT "{col1}") as col1_distinct,
                    COUNT(DISTINCT "{col2}") as col2_distinct
                FROM "{tbl}"
                """
                _, base_stats = db.execute_query(q)
                overlap_q = f"""
                SELECT "{col1}", "{col2}", COUNT(*) as frequency
                FROM "{tbl}"
                WHERE "{col1}" IS NOT NULL AND "{col2}" IS NOT NULL
                GROUP BY "{col1}", "{col2}"
                ORDER BY frequency DESC
                LIMIT 10
                """
                _, pair_freq = db.execute_query(overlap_q)
                res = {
                    "base_stats": dict(base_stats[0]) if base_stats else {},
                    "top_pairs": pair_freq
                }
                return json.dumps(res, indent=2, default=str)

            elif tool_name == "db_explain_query_plan":
                sql = str(args.get("sql", "")).strip()
                if not sql:
                    return "Error: 'sql' required."
                upper_sql = sql.upper().strip()
                if not (upper_sql.startswith("SELECT") or upper_sql.startswith("WITH")):
                    return "Error: Only SELECT or WITH queries can be explained."
                cols, rows = db.execute_query(f"EXPLAIN QUERY PLAN {sql}")
                return json.dumps(rows, indent=2, default=str)

            elif tool_name == "db_inspect_column":
                tbl = str(args.get("table", "")).strip().replace('"', '""')
                col = str(args.get("column", "")).strip().replace('"', '""')
                if not tbl or not col:
                    return "Error: 'table' and 'column' required."
                q = f"""
                SELECT
                    COUNT(*) as total_rows,
                    COUNT("{col}") as non_null_count,
                    COUNT(DISTINCT "{col}") as distinct_count,
                    MIN("{col}") as min_val,
                    MAX("{col}") as max_val
                FROM "{tbl}"
                """
                _, stats = db.execute_query(q)
                stat_obj = dict(stats[0]) if stats else {}
                top_q = f"""
                SELECT "{col}" as val, COUNT(*) as cnt
                FROM "{tbl}"
                WHERE "{col}" IS NOT NULL
                GROUP BY "{col}"
                ORDER BY cnt DESC
                LIMIT 5
                """
                _, top_rows = db.execute_query(top_q)
                stat_obj["top_values"] = top_rows
                return json.dumps(stat_obj, indent=2, default=str)

            elif tool_name == "db_readonly_query":
                sql = str(args.get("sql", "")).strip()
                if not sql:
                    return "Error: 'sql' required."
                upper_sql = sql.upper().strip()
                if not (upper_sql.startswith("SELECT") or upper_sql.startswith("WITH") or upper_sql.startswith("EXPLAIN") or upper_sql.startswith("PRAGMA")):
                    return "Forbidden: Only read-only queries (SELECT, WITH, EXPLAIN) are permitted during inspection. Write and schema mutations are forbidden."
                forbidden = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "REPLACE", "TRUNCATE", "ATTACH", "DETACH"]
                tokens = re.findall(r'\b[A-Z]+\b', upper_sql)
                for f in forbidden:
                    if f in tokens:
                        return f"Forbidden: Mutating keyword '{f}' is not allowed in dynamic inspection."
                cols, rows = db.execute_query(sql)
                return json.dumps({
                    "columns": cols,
                    "rows": rows[:50],
                    "total_returned": len(rows)
                }, indent=2, default=str)

            elif tool_name == "pdf_read_dev_file":
                fname = str(args.get("filename", "") or args.get("file", "") or args.get("name", "")).strip()
                clean_name = os.path.basename(fname)
                allowed_dev_files = {"data.csv", "style.css", "render.py"}
                if clean_name not in allowed_dev_files or fname != clean_name:
                    return (
                        "Permission Denied: Access to application source code (main.py, api.py, core, web) "
                        "or any system files is strictly prohibited by application security policy. "
                        "Only 'style.css', 'data.csv', and 'render.py' within the temporary dev directory may be accessed."
                    )
                try:
                    content = read_dev_file(clean_name)
                    return content[:4000] if content else "(dev file empty or not generated yet)"
                except Exception as e:
                    return f"Error reading dev file: {e}"

            elif tool_name == "pdf_list_dev_files":
                return json.dumps(["style.css", "data.csv", "render.py"])

            elif any(k in tool_name.lower() for k in ["file", "disk", "shell", "exec", "eval", "code", "system", "os", "run", "process", "cmd"]):
                return "Permission Denied: System commands and arbitrary file system access outside dev files are strictly blocked by application security sandbox."

            else:
                return f"Error: Tool '{tool_name}' is not recognized or not authorized in read-only inspection mode."
        except Exception as e:
            return f"Tool Execution Error: {str(e)}"

    def send_ai_chat(
        self,
        provider: str,
        model: str,
        api_key: str,
        messages_json: str,
        system_prompt: str,
        enable_agent: bool = True,
        fallback_chain: list = None,
    ) -> dict:
        """Call OpenRouter, Google Gemini, or NVIDIA NIM with ReAct agent loop and automatic provider fallback priority queue."""
        import urllib.request
        import urllib.error
        import json
        import re
        import ssl

        try:
            messages = json.loads(messages_json) if isinstance(messages_json, str) else messages_json
            if not isinstance(messages, list):
                messages = []

            # Determine candidate provider priority queue
            saved_chain_raw = db.get_setting("ai_fallback_chain", "")
            saved_chain = []
            if saved_chain_raw:
                try:
                    saved_chain = json.loads(saved_chain_raw) if saved_chain_raw.startswith("[") else [p.strip() for p in saved_chain_raw.split(",") if p.strip()]
                except Exception:
                    saved_chain = []

            # Combine requested chain, saved chain, and active provider
            candidate_list = []
            if fallback_chain and isinstance(fallback_chain, list):
                candidate_list.extend([p.lower() for p in fallback_chain if p])
            if provider and provider.lower() not in candidate_list:
                candidate_list.insert(0, provider.lower())
            for p in saved_chain:
                p_norm = p.lower()
                if p_norm not in candidate_list:
                    candidate_list.append(p_norm)
            for default_p in ["openrouter", "gemini", "nvidia"]:
                if default_p not in candidate_list:
                    candidate_list.append(default_p)

            # SSL context for cross-platform network compatibility
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

            agent_system_addon = (
                "\n\n--- DYNAMIC INSPECTION TOOLS (AGENTIC CAPABILITY) ---\n"
                "You are an advanced agentic database intelligence engine. If the user's question requires deeper schema inspection, checking sample values, discovering relationships, column stats, or validating complex queries, you have read-only tools to execute inspection actions before giving your final answer.\n"
                "To call a tool, respond with:\n"
                "Thought: <your reasoning for why this inspection is needed>\n"
                "Action: <tool_name>\n"
                "Action Input: <json_formatted_arguments>\n\n"
                "Available tools:\n"
                "- db_list_tables: List all user tables in DB. Input: {}\n"
                "- db_get_schema: Get column info for tables. Input: {\"tables\": [\"tbl1\", ...]}\n"
                "- db_sample_data: Peek at rows. Input: {\"table\": \"tbl\", \"limit\": 5}\n"
                "- db_multi_table_stats: Summarize row counts and columns across tables. Input: {\"tables\": [\"tbl1\", ...]}\n"
                "- db_find_relationships: Detect potential foreign key / JOIN column matches across tables. Input: {\"table\": \"tbl\"}\n"
                "- db_column_correlations: Check distinct, nulls & pairwise frequency distribution between two columns. Input: {\"table\": \"tbl\", \"col1\": \"colA\", \"col2\": \"colB\"}\n"
                "- db_inspect_column: Check nulls, distinct, min/max & top values for a single column. Input: {\"table\": \"tbl\", \"column\": \"col\"}\n"
                "- db_explain_query_plan: Inspect SQLite index usage and scan cost of a query. Input: {\"sql\": \"SELECT ...\"}\n"
                "- db_readonly_query: Run exploratory SELECT query. Input: {\"sql\": \"SELECT ... LIMIT 20\"}\n"
                "- pdf_read_dev_file: Read temporary PDF dev file. Input: {\"filename\": \"style.css\" (or \"data.csv\", \"render.py\")}\n"
                "- pdf_list_dev_files: List available PDF dev files. Input: {}\n\n"
                "CRITICAL SECURITY RESTRICTION: You are strictly sandboxed. You have ZERO access to application source code (main.py, api.py, core, web) or system files. Only the 3 whitelisted PDF dev files (style.css, data.csv, render.py) can be read. Any out-of-bounds request is blocked by software runtime security.\n"
                "CRITICAL: Do NOT call a tool for straightforward queries where table context is already sufficient. Only use tools when specific stats, distinct values, relationships, or missing schema details are necessary. Mutating operations (INSERT, UPDATE, DELETE, DROP, ALTER) are strictly forbidden in dynamic inspection.\n"
                "When you have the required information, output your final answer directly following the standard 2-part format (explanation + code block)."
            )

            effective_system = system_prompt + (agent_system_addon if enable_agent else "")
            max_agent_iterations = 5 if enable_agent else 1

            failover_log = []

            # Try candidate providers in priority sequence
            for candidate_p in candidate_list:
                p_key = ""
                if candidate_p == provider and api_key:
                    p_key = api_key.strip()
                elif candidate_p == "openrouter":
                    p_key = db.get_setting("ai_openrouter_key", "").strip()
                elif candidate_p == "gemini":
                    p_key = db.get_setting("ai_gemini_key", "").strip()
                elif candidate_p == "nvidia":
                    p_key = db.get_setting("ai_nvidia_key", "").strip()

                if not p_key:
                    failover_log.append(f"{candidate_p.upper()}: No API key configured")
                    continue

                p_model = ""
                if candidate_p == provider and model:
                    p_model = model.strip()
                elif candidate_p == "openrouter":
                    p_model = db.get_setting("ai_openrouter_model", "openrouter/free").strip() or "openrouter/free"
                elif candidate_p == "gemini":
                    p_model = db.get_setting("ai_gemini_model", "gemini-2.5-flash").strip() or "gemini-2.5-flash"
                elif candidate_p == "nvidia":
                    p_model = db.get_setting("ai_nvidia_model", "nvidia/nemotron-3-ultra-550b-a55b").strip() or "nvidia/nemotron-3-ultra-550b-a55b"

                # Run conversation / agent loop with this provider
                agent_steps = []
                current_messages = [dict(m) for m in messages]
                overall_reasoning = ""
                candidate_success = False
                last_reply = ""

                try:
                    for step_idx in range(max_agent_iterations):
                        raw_reply = ""
                        step_thought = ""

                        if candidate_p == "openrouter":
                            url = "https://openrouter.ai/api/v1/chat/completions"
                            api_msgs = [{"role": "system", "content": effective_system}]
                            for m in current_messages:
                                api_msgs.append({
                                    "role": m.get("role", "user"),
                                    "content": str(m.get("content", ""))
                                })

                            req_body = {
                                "model": p_model,
                                "messages": api_msgs,
                                "temperature": 0.2,
                                "max_tokens": 8192
                            }

                            req = urllib.request.Request(
                                url,
                                data=json.dumps(req_body).encode("utf-8"),
                                headers={
                                    "Content-Type": "application/json",
                                    "Authorization": f"Bearer {p_key}",
                                    "HTTP-Referer": "https://querii.desktop",
                                    "X-Title": "Querii Analytics",
                                },
                                method="POST"
                            )

                            with urllib.request.urlopen(req, timeout=50, context=ctx) as resp:
                                res_json = json.loads(resp.read().decode("utf-8"))
                                choices = res_json.get("choices", [])
                                if not choices:
                                    raise RuntimeError("OpenRouter returned no response choices.")
                                msg_obj = choices[0].get("message", {})
                                raw_reply = msg_obj.get("content", "") or ""
                                r_content = msg_obj.get("reasoning_content", "") or ""
                                if r_content:
                                    overall_reasoning = (overall_reasoning + "\n" + r_content).strip()

                        elif candidate_p == "gemini":
                            url = f"https://generativelanguage.googleapis.com/v1beta/models/{p_model}:generateContent?key={p_key}"
                            contents = []
                            for m in current_messages:
                                role = "user" if m.get("role") == "user" else "model"
                                contents.append({
                                    "role": role,
                                    "parts": [{"text": str(m.get("content", ""))}]
                                })

                            req_body = {
                                "contents": contents,
                                "systemInstruction": {
                                    "parts": [{"text": effective_system}]
                                },
                                "generationConfig": {
                                    "temperature": 0.2,
                                    "maxOutputTokens": 8192
                                }
                            }

                            req = urllib.request.Request(
                                url,
                                data=json.dumps(req_body).encode("utf-8"),
                                headers={"Content-Type": "application/json"},
                                method="POST"
                            )

                            with urllib.request.urlopen(req, timeout=50, context=ctx) as resp:
                                res_json = json.loads(resp.read().decode("utf-8"))
                                candidates = res_json.get("candidates", [])
                                if not candidates:
                                    raise RuntimeError("Gemini returned no candidates.")
                                parts = candidates[0].get("content", {}).get("parts", [])
                                thought_parts = [p.get("text", "") for p in parts if p.get("thought")]
                                if thought_parts:
                                    step_thought = "".join(thought_parts).strip()
                                    overall_reasoning = (overall_reasoning + "\n" + step_thought).strip()
                                raw_reply = "".join(p.get("text", "") for p in parts if not p.get("thought"))

                        elif candidate_p == "nvidia":
                            url = "https://integrate.api.nvidia.com/v1/chat/completions"
                            api_msgs = [{"role": "system", "content": effective_system}]
                            for m in current_messages:
                                api_msgs.append({
                                    "role": m.get("role", "user"),
                                    "content": str(m.get("content", ""))
                                })

                            req_body = {
                                "model": p_model,
                                "messages": api_msgs,
                                "temperature": 0.2,
                                "max_tokens": 8192
                            }

                            if "nemotron" in p_model.lower():
                                req_body["extra_body"] = {
                                    "chat_template_kwargs": {"enable_thinking": True}
                                }

                            req = urllib.request.Request(
                                url,
                                data=json.dumps(req_body).encode("utf-8"),
                                headers={
                                    "Content-Type": "application/json",
                                    "Authorization": f"Bearer {p_key}"
                                },
                                method="POST"
                            )

                            with urllib.request.urlopen(req, timeout=50, context=ctx) as resp:
                                res_json = json.loads(resp.read().decode("utf-8"))
                                choices = res_json.get("choices", [])
                                if not choices:
                                    raise RuntimeError("NVIDIA API returned no response choices.")
                                msg_obj = choices[0].get("message", {})
                                raw_reply = msg_obj.get("content", "") or ""
                                r_content = msg_obj.get("reasoning_content", "") or ""
                                if r_content:
                                    overall_reasoning = (overall_reasoning + "\n" + r_content).strip()

                        # Extract <think> if present in raw content
                        if "<think>" in raw_reply and "</think>" in raw_reply:
                            m_think = re.search(r"<think>([\s\S]*?)</think>", raw_reply)
                            if m_think:
                                extracted_think = m_think.group(1).strip()
                                overall_reasoning = (overall_reasoning + "\n" + extracted_think).strip()
                                raw_reply = re.sub(r"<think>[\s\S]*?</think>", "", raw_reply).strip()

                        last_reply = raw_reply

                        # Check if model requested a tool Action
                        action_match = re.search(r"Action:\s*([a-zA-Z0-9_]+)", raw_reply)
                        input_match = re.search(r"Action Input:\s*(\{[\s\S]*?\}|\[[\s\S]*?\]|[^\n]+)", raw_reply)
                        thought_match = re.search(r"Thought:\s*([\s\S]*?)(?=\nAction:|$)", raw_reply)

                        if action_match and enable_agent and step_idx < (max_agent_iterations - 1):
                            tool_act = action_match.group(1).strip()
                            raw_input_str = input_match.group(1).strip() if input_match else "{}"
                            thought_text = thought_match.group(1).strip() if thought_match else ""

                            try:
                                tool_args = json.loads(raw_input_str) if (raw_input_str.startswith("{") or raw_input_str.startswith("[")) else {}
                            except Exception:
                                tool_args = {"param": raw_input_str}

                            obs_result = self._execute_readonly_db_tool(tool_act, tool_args)
                            agent_steps.append({
                                "thought": thought_text,
                                "action": tool_act,
                                "input": tool_args,
                                "observation": obs_result[:1000]
                            })

                            # Feed observation back to model
                            current_messages.append({"role": "model", "content": raw_reply})
                            current_messages.append({"role": "user", "content": f"Observation from {tool_act}:\n{obs_result}"})
                            continue
                        else:
                            # Final direct answer reached
                            final_text = raw_reply
                            if "Final Answer:" in final_text:
                                final_text = final_text.split("Final Answer:", 1)[1].strip()

                            fallback_occurred = (candidate_p != provider)
                            fallback_note = ""
                            if fallback_occurred:
                                fallback_note = f"Automatic failover: {provider.upper()} failed ({failover_log[-1] if failover_log else 'error'}); successfully served by {candidate_p.upper()} ({p_model})."

                            return _ok({
                                "text": final_text,
                                "reasoning": overall_reasoning.strip(),
                                "agent_steps": agent_steps,
                                "model": p_model,
                                "provider": candidate_p,
                                "fallback_occurred": fallback_occurred,
                                "fallback_note": fallback_note,
                                "failover_log": failover_log,
                            })

                    # If loop finished all iterations
                    final_text = last_reply
                    if "Final Answer:" in final_text:
                        final_text = final_text.split("Final Answer:", 1)[1].strip()

                    fallback_occurred = (candidate_p != provider)
                    fallback_note = f"Served by {candidate_p.upper()} ({p_model})"
                    if fallback_occurred:
                        fallback_note = f"Automatic failover: {provider.upper()} failed; served by {candidate_p.upper()} ({p_model})."

                    return _ok({
                        "text": final_text,
                        "reasoning": overall_reasoning.strip(),
                        "agent_steps": agent_steps,
                        "model": p_model,
                        "provider": candidate_p,
                        "fallback_occurred": fallback_occurred,
                        "fallback_note": fallback_note,
                        "failover_log": failover_log,
                    })

                except urllib.error.HTTPError as he:
                    err_body = he.read().decode("utf-8", errors="replace")
                    try:
                        err_parsed = json.loads(err_body)
                        msg = err_parsed.get("error", {}).get("message", err_body)
                    except Exception:
                        msg = err_body or str(he)
                    failover_log.append(f"{candidate_p.upper()} HTTP {he.code}: {msg[:200]}")
                    continue
                except Exception as pe:
                    failover_log.append(f"{candidate_p.upper()}: {str(pe)[:200]}")
                    continue

            # If all candidates failed
            return _err("All AI providers in fallback chain failed.\n" + "\n".join(f"• {item}" for item in failover_log))

        except Exception as e:
            return _err(str(e))

        except Exception as e:
            return _err(str(e))

    # ----------------------------------------------------------------
    # Settings
    # ----------------------------------------------------------------

    def get_settings(self) -> dict:
        try:
            keys = [
                "org_name", "org_logo_b64", "org_logo_sq_b64",
                "ap_theme", "ap_zoom", "ap_custom_reports", "ap_pdf_dir",
                "pdf_custom_css", "pdf_dev_mode",
                "ai_provider", "ai_gemini_key", "ai_gemini_model",
                "ai_nvidia_key", "ai_nvidia_model",
                "ai_openrouter_key", "ai_openrouter_model", "ai_fallback_chain",
            ]
            return _ok({k: db.get_setting(k) for k in keys})
        except Exception as e:
            return _err(e)

    def save_settings(self, settings: dict) -> dict:
        try:
            for k, v in settings.items():
                db.set_setting(str(k), str(v) if v is not None else "")
            return _ok("Saved.")
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # File dialogs
    # ----------------------------------------------------------------

    def open_file_dialog(self) -> dict:
        try:
            if self._window is None:
                return _err("Window not ready.")
            result = self._window.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=(
                    "Supported Files (*.xls;*.xlsx;*.xlsm;*.ods;*.csv)",
                    "Excel Files (*.xls;*.xlsx;*.xlsm)",
                    "ODS Files (*.ods)",
                    "CSV Files (*.csv)",
                    "All files (*.*)",
                ),
            )
            if result:
                return _ok(result[0])
            return _ok(None)
        except Exception as e:
            return _err(e)

    def open_file_dialog_type(self, file_type: str = "image") -> dict:
        try:
            if self._window is None:
                return _err("Window not ready.")
            if file_type == "image":
                types = ("PNG Images (*.png)", "All files (*.*)")
            else:
                types = ("All files (*.*)",)
            result = self._window.create_file_dialog(
                webview.OPEN_DIALOG, allow_multiple=False, file_types=types
            )
            if result:
                return _ok(result[0])
            return _ok(None)
        except Exception as e:
            return _err(e)

    def save_file_dialog(self, default_name: str = "export", ext: str = "csv") -> dict:
        try:
            if self._window is None:
                return _err("Window not ready.")
            if ext == "pdf":
                types = ("PDF Files (*.pdf)",)
                default = default_name + ".pdf"
            else:
                types = ("CSV Files (*.csv)",)
                default = default_name + ".csv"
            result = self._window.create_file_dialog(
                webview.SAVE_DIALOG, save_filename=default, file_types=types
            )
            if result:
                path = result if isinstance(result, str) else result[0]
                return _ok(path)
            return _ok(None)
        except Exception as e:
            return _err(e)

    def get_default_downloads_dir(self) -> dict:
        """Return the platform-default Downloads folder."""
        try:
            home = os.path.expanduser("~")
            # Try XDG user dirs on Linux first
            downloads = os.path.join(home, "Downloads")
            xdg_dirs = os.path.join(home, ".config", "user-dirs.dirs")
            if os.path.isfile(xdg_dirs):
                with open(xdg_dirs) as f:
                    for line in f:
                        if line.startswith("XDG_DOWNLOAD_DIR"):
                            val = line.split("=", 1)[1].strip().strip('"').replace("$HOME", home)
                            if os.path.isdir(val):
                                downloads = val
            if not os.path.isdir(downloads):
                downloads = home
            return _ok(downloads)
        except Exception as e:
            return _err(e)

    def choose_folder_dialog(self) -> dict:
        """Open a native folder picker and return selected path."""
        try:
            if self._window is None:
                return _err("Window not ready.")
            result = self._window.create_file_dialog(
                webview.FOLDER_DIALOG,
            )
            if result:
                path = result if isinstance(result, str) else result[0]
                return _ok(path)
            return _ok(None)
        except Exception as e:
            return _err(e)

    def read_file_as_b64(self, filepath: str) -> dict:
        try:
            import base64
            if not os.path.isfile(filepath):
                return _err(f"File not found: {filepath}")
            size = os.path.getsize(filepath)
            if size > 5 * 1024 * 1024:
                return _err("File too large (max 5 MB for logo).")
            with open(filepath, "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")
            return _ok(data)
        except Exception as e:
            return _err(e)

    def check_filepath_exists(self, filepath: str) -> dict:
        try:
            return _ok(os.path.isfile(filepath))
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Import — two-phase: preview then confirm
    # ----------------------------------------------------------------

    def preview_import(self, filepath: str, header_row_index: int = 0) -> dict:
        try:
            if not os.path.isfile(filepath):
                return _err(f"File not found: {filepath}")

            prev = preview_file(filepath, header_row_index=header_row_index)
            self._pending_preview = prev
            self._pending_filepath = filepath

            return _ok({
                "filename":   prev.filename,
                "row_count":  prev.row_count,
                "warnings":   prev.warnings,
                "columns": [c.to_dict() for c in prev.columns],
                "sample_rows": prev.sample_rows,
            })
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(f"Preview failed: {traceback.format_exc()}")

    def confirm_import(
        self,
        overwrite: bool = False,
        custom_table_name: str = "",
        header_row_index: int = 0,
    ) -> dict:
        try:
            if self._pending_preview is None or self._pending_filepath is None:
                return _err("No pending import. Call preview_import first.")

            prev  = self._pending_preview
            fpath = self._pending_filepath

            tname, inserted, skipped = db.import_sheet(
                preview=prev,
                filepath=fpath,
                header_row_index=header_row_index,
                overwrite=overwrite,
                custom_table_name=custom_table_name or None,
            )

            self._pending_preview  = None
            self._pending_filepath = None

            return _ok({
                "table_name": tname,
                "filename":   prev.filename,
                "inserted":   inserted,
                "skipped":    skipped,
                "col_count":  len(prev.columns),
            })
        except Exception as e:
            return _err(f"Import failed: {traceback.format_exc()}")

    def check_already_imported(self, filename: str) -> dict:
        try:
            row = db.check_already_imported(filename)
            return _ok(row)
        except Exception as e:
            return _err(e)

    def get_import_history(self) -> dict:
        try:
            return _ok(db.get_import_history())
        except Exception as e:
            return _err(e)

    def get_last_import(self) -> dict:
        try:
            return _ok(db.get_last_import())
        except Exception as e:
            return _err(e)

    def drop_table(self, table_name: str) -> dict:
        try:
            db.drop_table(table_name)
            return _ok(f"Table '{table_name}' dropped.")
        except Exception as e:
            return _err(e)

    def get_app_data_path(self) -> dict:
        try:
            return _ok(os.path.dirname(db.get_db_path()))
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Schema
    # ----------------------------------------------------------------

    def get_schema(self) -> dict:
        """Return full schema: [{table, columns}]"""
        try:
            return _ok(db.get_schema())
        except Exception as e:
            return _err(e)

    def get_table_columns(self, table_name: str) -> dict:
        """Return column metadata for a specific table."""
        try:
            cols = db.get_table_column_meta(table_name)
            result = []
            for c in cols:
                if c["name"].startswith("_"):
                    continue
                cat = sql_type_to_category(c["type"])
                result.append({
                    "name":      c["name"],
                    "type":      c["type"],
                    "category":  cat,
                    "operators": get_operators_for_category(cat),
                })
            return _ok(result)
        except Exception as e:
            return _err(e)

    def get_column_stats(self, table_name: str, col_name: str) -> dict:
        """
        Return quick stats for a single column:
        count_total, count_distinct, count_null, min_val, max_val, sample_values
        """
        try:
            safe_t = table_name.replace('"', '""')
            safe_c = col_name.replace('"', '""')
            sql = f'''
                SELECT
                    COUNT(*)                         AS count_total,
                    COUNT(DISTINCT "{safe_c}")        AS count_distinct,
                    SUM(CASE WHEN "{safe_c}" IS NULL OR "{safe_c}" = '' THEN 1 ELSE 0 END) AS count_null,
                    MIN("{safe_c}")                   AS min_val,
                    MAX("{safe_c}")                   AS max_val
                FROM "{safe_t}"
            '''
            _, rows = db.execute_query(sql)
            stats = rows[0] if rows else {}

            # Sample top 5 distinct non-null values
            sample_sql = f'''
                SELECT DISTINCT "{safe_c}" AS v
                FROM "{safe_t}"
                WHERE "{safe_c}" IS NOT NULL AND "{safe_c}" != ''
                LIMIT 5
            '''
            _, srows = db.execute_query(sample_sql)
            samples = [r.get("v", "") for r in srows]

            return _ok({
                "count_total":    stats.get("count_total", 0),
                "count_distinct": stats.get("count_distinct", 0),
                "count_null":     stats.get("count_null", 0),
                "min_val":        stats.get("min_val"),
                "max_val":        stats.get("max_val"),
                "sample_values":  samples,
            })
        except Exception as e:
            return _err(str(e))

    # ----------------------------------------------------------------
    # Query
    # ----------------------------------------------------------------

    def run_filter(
        self,
        table: str,
        filter_groups_json: str = "[]",
        sort_col: str = "",
        sort_dir: str = "ASC",
        limit: int = 5000,
        select_exprs_json: str = "[]",
        select_labels_json: str = "[]",
        group_by_exprs_json: str = "[]",
        having: str = "",
        join_tables_json: str = "[]",
        join_clauses_json: str = "[]",
    ) -> dict:
        try:
            groups_raw = json.loads(filter_groups_json) if isinstance(filter_groups_json, str) else filter_groups_json
            sel_e      = json.loads(select_exprs_json)  if isinstance(select_exprs_json, str)  else select_exprs_json
            sel_l      = json.loads(select_labels_json) if isinstance(select_labels_json, str) else select_labels_json
            grp_e      = json.loads(group_by_exprs_json) if isinstance(group_by_exprs_json, str) else group_by_exprs_json
            join_t     = json.loads(join_tables_json)   if isinstance(join_tables_json, str)   else join_tables_json
            join_c     = json.loads(join_clauses_json)  if isinstance(join_clauses_json, str)  else join_clauses_json

            filter_groups = _parse_filter_groups(groups_raw)

            spec = QuerySpec(
                table          = table,
                filter_groups  = filter_groups,
                order_by       = sort_col,
                order_dir      = sort_dir,
                limit          = limit,
                select_exprs   = sel_e,
                select_labels  = sel_l,
                group_by_exprs = grp_e,
                having         = having,
                join_tables    = join_t,
                join_clauses   = join_c,
            )
            sql, params, sql_display = build_sql(spec)
            cols, data = db.execute_query(sql, params)

            self._last_result_cols = cols
            self._last_result_rows = data

            # Log the READABLE (display) SQL, and save builder state for rehydration
            builder_state_dict = {
                "table": table,
                "groups": groups_raw,
                "sort_col": sort_col,
                "sort_dir": sort_dir,
                "limit": limit,
                "select_exprs": sel_e,
                "select_labels": sel_l,
                "group_by_exprs": grp_e,
                "having": having,
                "join_tables": join_t,
                "join_clauses": join_c,
            }
            db.log_query(sql_display, len(data), source="filter", builder_state=json.dumps(builder_state_dict))

            return _ok({
                "columns": cols,
                "rows":    data[:200], # Send only first page to prevent IPC lag!
                "sql":     sql_display,
                "count":   len(data),
            })
        except Exception as e:
            return _err(str(e))

    def run_sql(self, sql: str) -> dict:
        try:
            cols, data, affected = db.execute_query_full(sql)
            self._last_result_cols = cols
            self._last_result_rows = data
            db.log_query(sql.strip(), len(data) if cols else max(0, affected), source="manual")
            if not cols:
                msg = f"Query OK — {affected} row(s) affected." if affected >= 0 else "Query executed successfully."
                return _ok({
                    "columns": [],
                    "rows": [],
                    "count": max(0, affected),
                    "message": msg,
                    "is_mutation": True,
                })
            return _ok({"columns": cols, "rows": data[:200], "count": len(data)})
        except ValueError as e:
            return _err(str(e))
        except Exception as e:
            return _err(str(e))

    def get_result_page(self, page_index: int, page_size: int = 200) -> dict:
        try:
            start = page_index * page_size
            end = start + page_size
            return _ok(self._last_result_rows[start:end])
        except Exception as e:
            return _err(str(e))

    # ----------------------------------------------------------------
    # Query log
    # ----------------------------------------------------------------

    def get_query_log(self) -> dict:
        try:
            return _ok(db.get_query_log())
        except Exception as e:
            return _err(e)

    def clear_query_log(self) -> dict:
        try:
            db.clear_query_log()
            return _ok("Cleared.")
        except Exception as e:
            return _err(e)

    # ----------------------------------------------------------------
    # Export
    # ----------------------------------------------------------------

    def export_csv(self, columns: list, rows: list, filepath: str) -> dict:
        try:
            # Ignore frontend rows, use backend memory to prevent huge IPC overhead
            exporter.export_csv(self._last_result_cols, self._last_result_rows, filepath)
            return _ok(filepath)
        except Exception as e:
            return _err(e)

    def export_pdf(
        self,
        *args,
        **kwargs,
    ) -> dict:
        """
        Export results to PDF using the high-speed native Rust engine with ReportLab fallback.
        Accepts either (filepath, title, ...) or (columns, rows, filepath, title, ...).
        """
        try:
            # Parse arguments flexibly
            cols = self._last_result_cols
            rows = self._last_result_rows
            filepath = ""
            title = kwargs.get("title", "Query Results")
            org_name = kwargs.get("org_name", "")
            logo_b64 = kwargs.get("logo_b64", "")
            sql_display = kwargs.get("sql_display", "")
            theme_colors = kwargs.get("theme_colors", None)
            page_size = kwargs.get("page_size", "A4")
            orientation = kwargs.get("orientation", "portrait")
            scale = kwargs.get("scale", 1.0)
            continuous = kwargs.get("continuous", False)
            source_label = kwargs.get("source_label", "")
            col_widths = kwargs.get("col_widths", None)
            col_headers = kwargs.get("col_headers", None)
            col_visible = kwargs.get("col_visible", None)
            extra_blank_rows = kwargs.get("extra_blank_rows", 0)
            extra_cols = kwargs.get("extra_cols", None)
            watermark_enabled = kwargs.get("watermark_enabled", True)

            if args:
                if isinstance(args[0], str):
                    # Signature: (filepath, title, subtitle, org, logo, sql, ...)
                    filepath = args[0]
                    if len(args) > 1 and args[1]: title = args[1]
                    if len(args) > 3 and args[3]: org_name = args[3]
                    if len(args) > 4 and args[4]: logo_b64 = args[4]
                    if len(args) > 5 and args[5]: sql_display = args[5]
                    if len(args) > 6 and args[6]: theme_colors = args[6]
                    if len(args) > 7 and args[7]: page_size = args[7]
                    if len(args) > 8 and args[8]: orientation = args[8]
                    if len(args) > 9 and args[9]: scale = float(args[9])
                    if len(args) > 10 and args[10] is not None: continuous = bool(args[10])
                    if len(args) > 11 and args[11]: source_label = args[11]
                    if len(args) > 12 and args[12]: col_widths = args[12]
                    if len(args) > 13 and args[13]: col_headers = args[13]
                    if len(args) > 14 and args[14]: col_visible = args[14]
                    if len(args) > 15 and args[15] is not None: extra_blank_rows = args[15]
                    if len(args) > 16 and args[16]: extra_cols = args[16]
                    if len(args) > 17 and args[17] is not None: watermark_enabled = bool(args[17])
                elif isinstance(args[0], (list, tuple)) and len(args) >= 3:
                    # Signature: (columns, rows, filepath, ...)
                    cols = args[0] or cols
                    rows = args[1] or rows
                    filepath = args[2]
                    if len(args) > 3 and args[3]: title = args[3]
                    if len(args) > 4 and args[4]: org_name = args[4]

            if not filepath:
                filepath = kwargs.get("filepath", "")

            if not filepath:
                return _err("No output filepath provided")

            cols = list(cols or [])
            rows = [dict(r) for r in (rows or [])]

            if extra_cols:
                for ec in extra_cols:
                    ec_name = str(ec).strip()
                    if ec_name and ec_name not in cols:
                        cols.append(ec_name)
                        for r in rows:
                            r[ec_name] = ""

            if extra_blank_rows and int(extra_blank_rows) > 0:
                for _ in range(int(extra_blank_rows)):
                    rows.append({c: "" for c in cols})

            exporter.export_pdf(
                columns=cols,
                rows=rows,
                filepath=filepath,
                title=title,
                subtitle="",
                org_name=org_name,
                logo_b64=logo_b64,
                sql_display=sql_display,
                theme_colors=theme_colors,
                page_size=page_size,
                orientation=orientation,
                scale=scale,
                continuous=continuous,
                source_label=source_label,
                col_widths=col_widths,
                col_headers=col_headers,
                col_visible=col_visible,
                watermark_enabled=watermark_enabled,
            )
            return _ok(filepath)
        except Exception as e:
            return _err(e)

    def export_pdf_html(
        self,
        filepath: str,
        title: str = "Query Results",
        org_name: str = "",
        logo_b64: str = "",
        sql_display: str = "",
        source_label: str = "",
        custom_css: str = "",
        page_size: str = "A4",
        orientation: str = "portrait",
        scale: float = 1.0,
        col_widths: dict = None,
        col_headers: dict = None,
        col_visible: list = None,
        full_override: bool = False,
        bold_data: bool = False,
        show_grid_lines: bool = False,
        extra_blank_rows: int = 0,
        extra_cols: list = None,
        watermark_enabled: bool = True,
        custom_csv: str = "",
    ) -> dict:
        """Render PDF using custom HTML/CSS template via headless Chromium."""
        try:
            if custom_csv and custom_csv.strip():
                import io, csv
                f = io.StringIO(custom_csv.strip())
                reader = csv.reader(f)
                header = next(reader, None)
                if header:
                    cols = [str(h).strip() for h in header]
                    rows = []
                    for r in reader:
                        row_dict = {}
                        for idx, col_name in enumerate(cols):
                            row_dict[col_name] = r[idx] if idx < len(r) else ""
                        rows.append(row_dict)
                else:
                    cols = list(self._last_result_cols or [])
                    rows = [dict(r) for r in (self._last_result_rows or [])]
            else:
                cols = list(self._last_result_cols or [])
                rows = [dict(r) for r in (self._last_result_rows or [])]

            if extra_cols:
                for ec in extra_cols:
                    ec_name = str(ec).strip()
                    if ec_name and ec_name not in cols:
                        cols.append(ec_name)
                        for r in rows:
                            r[ec_name] = ""

            if extra_blank_rows and int(extra_blank_rows) > 0:
                for _ in range(int(extra_blank_rows)):
                    rows.append({c: "" for c in cols})

            export_pdf_html(
                cols, rows, filepath,
                title=title,
                org_name=org_name,
                logo_b64=logo_b64,
                sql_display=sql_display,
                source_label=source_label,
                custom_css=custom_css,
                page_size=page_size,
                orientation=orientation,
                scale=scale,
                col_widths=col_widths,
                col_headers=col_headers,
                col_visible=col_visible,
                full_override=full_override,
                bold_data=bold_data,
                show_grid_lines=show_grid_lines,
                watermark_enabled=watermark_enabled,
            )
            return _ok(filepath)
        except Exception as e:
            return _err(e)

    def get_pdf_html_preview(
        self,
        title: str = "Preview",
        org_name: str = "",
        logo_b64: str = "",
        custom_css: str = "",
        page_size: str = "A4",
        orientation: str = "portrait",
        scale: float = 1.0,
        col_widths: dict = None,
        col_headers: dict = None,
        col_visible: list = None,
        full_override: bool = False,
        bold_data: bool = False,
        show_grid_lines: bool = False,
        extra_blank_rows: int = 0,
        extra_cols: list = None,
        watermark_enabled: bool = True,
        custom_csv: str = "",
    ) -> dict:
        """Return HTML string for the live iframe preview (ultra dev mode)."""
        try:
            if custom_csv and custom_csv.strip():
                import io, csv
                f = io.StringIO(custom_csv.strip())
                reader = csv.reader(f)
                header = next(reader, None)
                if header:
                    cols = [str(h).strip() for h in header]
                    rows = []
                    for r in reader:
                        row_dict = {}
                        for idx, col_name in enumerate(cols):
                            row_dict[col_name] = r[idx] if idx < len(r) else ""
                        rows.append(row_dict)
                else:
                    cols = list(self._last_result_cols or [])
                    rows = [dict(r) for r in (self._last_result_rows or [])]
            else:
                cols = list(self._last_result_cols or [])
                rows = [dict(r) for r in (self._last_result_rows or [])]

            if extra_cols:
                for ec in extra_cols:
                    ec_name = str(ec).strip()
                    if ec_name and ec_name not in cols:
                        cols.append(ec_name)
                        for r in rows:
                            r[ec_name] = ""

            if extra_blank_rows and int(extra_blank_rows) > 0:
                for _ in range(int(extra_blank_rows)):
                    rows.append({c: "" for c in cols})

            html = get_pdf_html_preview(
                columns=cols, rows=rows,
                title=title, org_name=org_name, logo_b64=logo_b64,
                custom_css=custom_css, page_size=page_size, orientation=orientation,
                scale=scale,
                col_widths=col_widths or {}, col_headers=col_headers or {},
                col_visible=col_visible, full_override=full_override,
                bold_data=bold_data, show_grid_lines=show_grid_lines,
                watermark_enabled=watermark_enabled,
            )
            return _ok(html)
        except Exception as e:
            return _err(e)

    def get_default_col_specs(self, shorten_headers: bool = True) -> dict:
        """Compute default column widths and header labels from backend query results."""
        try:
            from core.exporter import compute_default_col_specs
            cols = list(self._last_result_cols or [])
            rows = self._last_result_rows or []
            widths, headers = compute_default_col_specs(cols, rows, shorten_headers=shorten_headers)
            return _ok({"widths": widths, "headers": headers, "cols": cols})
        except Exception as e:
            return _err(e)

    # ── Ultra Dev Mode ────────────────────────────────────────────────────────

    def open_dev_files(
        self,
        custom_css: str = "",
        title: str = "Query Results",
        org_name: str = "",
        page_size: str = "A4",
        orientation: str = "portrait",
        full_override: bool = False,
    ) -> dict:
        """Write the three dev files and return their paths."""
        try:
            import os
            cols = self._last_result_cols or []
            rows = self._last_result_rows or []
            paths = write_dev_files(
                columns=cols, rows=rows,
                custom_css=custom_css, title=title, org_name=org_name,
                page_size=page_size, orientation=orientation,
                querii_path=os.path.dirname(os.path.abspath(__file__)),
                full_override=full_override,
            )
            return _ok(paths)
        except Exception as e:
            return _err(e)

    def read_dev_file(self, name: str) -> dict:
        """Read a dev file by name (data.csv / style.css / render.py) with strict security sandboxing."""
        try:
            clean_name = os.path.basename(str(name).strip())
            if clean_name not in {"data.csv", "style.css", "render.py"} or str(name).strip() != clean_name:
                return _err("Permission Denied: Access forbidden. Only style.css, data.csv, and render.py can be accessed.")
            return _ok(read_dev_file(clean_name))
        except Exception as e:
            return _err(e)

    def write_dev_file(self, name: str, content: str) -> dict:
        """Save updated content to a dev file with strict security sandboxing."""
        try:
            clean_name = os.path.basename(str(name).strip())
            if clean_name not in {"data.csv", "style.css", "render.py"} or str(name).strip() != clean_name:
                return _err("Permission Denied: Access forbidden. Only style.css, data.csv, and render.py can be modified.")
            write_dev_file_content(clean_name, content)
            return _ok(True)
        except Exception as e:
            return _err(e)

    def open_path(self, path: str) -> dict:
        """Open a file or directory in the system default application."""
        try:
            import subprocess, sys as _sys, shlex
            if _sys.platform.startswith("linux"):
                subprocess.Popen(["xdg-open", path])
            elif _sys.platform == "darwin":
                subprocess.Popen(["open", path])
            else:
                subprocess.Popen(["explorer", path])
            return _ok(True)
        except Exception as e:
            return _err(e)

    # ── Database Admin ────────────────────────────────────────────────────────

    def execute_raw_sql(self, sql: str) -> dict:
        """Execute arbitrary SQL against the app database. Returns rows or affected count."""
        try:
            conn = db._connect()
            cur = conn.cursor()
            cur.execute(sql)
            if cur.description:
                cols = [d[0] for d in cur.description]
                rows = [dict(zip(cols, r)) for r in cur.fetchmany(500)]
                conn.commit()
                return _ok({"columns": cols, "rows": rows, "affected": cur.rowcount})
            else:
                conn.commit()
                return _ok({"columns": [], "rows": [], "affected": cur.rowcount,
                            "message": f"Query OK — {cur.rowcount} row(s) affected"})
        except Exception as e:
            return _err(e)

    def drop_all_tables(self) -> dict:
        """Drop all user-imported tables from the database."""
        try:
            conn = db._connect()
            cur = conn.cursor()
            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_querii_%'")
            tables = [r[0] for r in cur.fetchall()]
            for t in tables:
                cur.execute(f'DROP TABLE IF EXISTS "{t}"')
            conn.commit()
            return _ok(f"Dropped {len(tables)} table(s): {', '.join(tables) or 'none'}")
        except Exception as e:
            return _err(e)

    def vacuum_database(self) -> dict:
        """Run VACUUM to reclaim disk space."""
        try:
            conn = db._connect()
            conn.execute("VACUUM")
            return _ok("VACUUM complete")
        except Exception as e:
            return _err(e)

    def delete_database(self) -> dict:
        """Delete the entire SQLite database file (irreversible)."""
        try:
            import os
            db_path = db.get_db_path()
            if os.path.exists(db_path):
                os.unlink(db_path)
            return _ok("Database deleted. Restart Querii to create a fresh one.")
        except Exception as e:
            return _err(e)

    def copy_to_clipboard(self, text: str) -> dict:
        """Copy text to system clipboard with multiple robust fallbacks."""
        text = str(text or "")
        # 1. Try pyperclip
        try:
            import pyperclip
            pyperclip.copy(text)
            return _ok("Copied to clipboard")
        except Exception:
            pass

        # 2. Try PyQt6 clipboard
        try:
            from PyQt6.QtWidgets import QApplication
            cb = QApplication.clipboard()
            if cb:
                cb.setText(text)
                return _ok("Copied to clipboard")
        except Exception:
            pass

        # 3. Try Linux command-line utilities
        try:
            import shutil, subprocess
            if shutil.which("wl-copy"):
                subprocess.run(["wl-copy"], input=text.encode("utf-8"), check=True, timeout=2)
                return _ok("Copied to clipboard")
            if shutil.which("xclip"):
                subprocess.run(["xclip", "-selection", "clipboard"], input=text.encode("utf-8"), check=True, timeout=2)
                return _ok("Copied to clipboard")
        except Exception:
            pass

        return _err("Could not access system clipboard")

    # ----------------------------------------------------------------
    # CSV Editor
    # ----------------------------------------------------------------

    def get_table_as_csv(self, table_name: str) -> dict:
        """Return full table data as {columns: [], rows: [[values]]} for the CSV editor."""
        try:
            cols_meta = db.get_table_column_meta(table_name)
            cols = [c["name"] for c in cols_meta if not c["name"].startswith("_")]
            if not cols:
                return _err("No columns found")
            col_list = ", ".join(f'"{c}"' for c in cols)
            sql = f'SELECT {col_list} FROM "{table_name}"'
            _, rows = db.execute_query(sql)
            row_data = [[str(r.get(c, "") or "") for c in cols] for r in rows]
            return _ok({"columns": cols, "rows": row_data})
        except Exception as e:
            return _err(str(e))

    def save_csv_table(self, table_name: str, columns: list, rows: list) -> dict:
        """Overwrite an existing table with the edited CSV data."""
        try:
            from core.schema import sanitise_identifier, sanitise_table_name, infer_type
            from core.importer import ImportPreview
            import core.schema as sch

            if not table_name or not columns:
                return _err("table_name and columns are required")

            # Build ColumnInfo list
            seen: set = set()
            col_infos = []
            for i, raw in enumerate(columns):
                samples = [str(rows[r][i]) for r in range(min(200, len(rows))) if i < len(rows[r]) and rows[r][i]]
                sql_type = infer_type(samples)
                sqlite_name = sanitise_identifier(raw or f"col_{i+1}", existing=seen)
                col_infos.append(sch.ColumnInfo(raw_name=raw, sqlite_name=sqlite_name, sql_type=sql_type, samples=samples[:5]))

            preview = ImportPreview(
                filename=f"{table_name}.csv",
                columns=col_infos,
                row_count=len(rows),
                sample_rows=[r[:5] for r in rows[:5]],
            )
            # Pad/trim rows
            ncols = len(columns)
            cleaned = []
            for r in rows:
                padded = (list(r) + [""] * ncols)[:ncols]
                cleaned.append(padded)

            tname, inserted, skipped = db.import_sheet(
                preview=preview,
                filepath=None,
                header_row_index=0,
                overwrite=True,
                custom_table_name=table_name,
                raw_rows=cleaned,
            )
            return _ok({"table_name": tname, "inserted": inserted})
        except Exception as e:
            import traceback
            return _err(traceback.format_exc())

    def create_csv_table(self, table_name: str, columns: list, rows: list) -> dict:
        """Create a new table from CSV editor data."""
        try:
            from core.schema import sanitise_table_name
            safe_name = sanitise_table_name(table_name)
            return self.save_csv_table(safe_name, columns, rows)
        except Exception as e:
            return _err(str(e))

    # ----------------------------------------------------------------
    # Custom PDF Styles (named user presets)
    # ----------------------------------------------------------------

    def get_pdf_styles(self) -> dict:
        """Return all custom user-saved PDF styles: [{name, css}]"""
        try:
            import json
            raw = db.get_setting("pdf_custom_styles", "[]")
            styles = json.loads(raw) if raw else []
            return _ok(styles)
        except Exception as e:
            return _err(str(e))

    def save_pdf_style(self, name: str, css: str) -> dict:
        """Save or update a named custom PDF style."""
        try:
            import json
            name = str(name).strip()
            if not name:
                return _err("Style name cannot be empty")
            raw = db.get_setting("pdf_custom_styles", "[]")
            styles = json.loads(raw) if raw else []
            # Update existing or append
            found = False
            for s in styles:
                if s.get("name") == name:
                    s["css"] = css
                    found = True
                    break
            if not found:
                styles.append({"name": name, "css": css})
            db.set_setting("pdf_custom_styles", json.dumps(styles))
            return _ok("Saved")
        except Exception as e:
            return _err(str(e))

    def delete_pdf_style(self, name: str) -> dict:
        """Delete a named custom PDF style."""
        try:
            import json
            raw = db.get_setting("pdf_custom_styles", "[]")
            styles = json.loads(raw) if raw else []
            styles = [s for s in styles if s.get("name") != name]
            db.set_setting("pdf_custom_styles", json.dumps(styles))
            return _ok("Deleted")
        except Exception as e:
            return _err(str(e))

    def rename_pdf_style(self, old_name: str, new_name: str) -> dict:
        """Rename a saved custom PDF style."""
        try:
            import json
            new_name = str(new_name).strip()
            if not new_name:
                return _err("New name cannot be empty")
            raw = db.get_setting("pdf_custom_styles", "[]")
            styles = json.loads(raw) if raw else []
            for s in styles:
                if s.get("name") == old_name:
                    s["name"] = new_name
                    break
            db.set_setting("pdf_custom_styles", json.dumps(styles))
            return _ok("Renamed")
        except Exception as e:
            return _err(str(e))

