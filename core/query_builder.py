"""
core/query_builder.py
=====================
Builds parameterised SQLite WHERE / SELECT / GROUP BY clauses
dynamically from runtime column metadata.

v2: Supports nested FilterGroups for complex WHERE trees like:
    (A AND B) OR ((C AND D) OR E)
    Groups can contain conditions AND sub-groups (unlimited nesting).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Any


# ---------------------------------------------------------------------------
# Operator sets by category
# ---------------------------------------------------------------------------

TEXT_OPS   = ["contains", "equals", "starts with", "ends with",
               "not contains", "not equals", "is empty", "is not empty"]
DATE_OPS   = ["on", "before", "after", "between", "on or before", "on or after", "is empty", "is not empty"]
TIME_OPS   = ["before", "after", "equals", "is empty", "is not empty"]
NUMBER_OPS = ["equals", "greater than", "less than", "greater or equal",
              "less or equal", "not equals", "between"]


def sql_type_to_category(sql_type: str) -> str:
    t = sql_type.upper()
    if t in ("INTEGER", "REAL", "NUMERIC", "FLOAT", "INT"):
        return "number"
    if t == "DATE":
        return "date"
    if t == "TIME":
        return "time"
    return "text"


def get_operators_for_category(cat: str) -> List[str]:
    return {
        "text":   TEXT_OPS,
        "date":   DATE_OPS,
        "time":   TIME_OPS,
        "number": NUMBER_OPS,
    }.get(cat, TEXT_OPS)


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class FilterRow:
    field:    str   # sqlite column name
    operator: str
    value:    str
    value2:   str  = ""
    joiner:   str  = "AND"   # how this row connects to the PREVIOUS item in its group
    category: str  = "text"  # text | date | time | number
    table_prefix: str = ""   # for multi-table queries: "tablename."


@dataclass
class FilterGroup:
    """
    A group of conditions (and optionally nested sub-groups).
    joiner = how THIS group connects to the previous sibling group.
    items  = list of FilterRow OR FilterGroup objects (mixed).
    """
    joiner: str = "AND"
    items: List[Any] = field(default_factory=list)   # FilterRow | FilterGroup


@dataclass
class QuerySpec:
    table:           str
    filters:         List[FilterRow] = field(default_factory=list)   # legacy flat mode
    filter_groups:   List[FilterGroup] = field(default_factory=list) # new grouped mode
    order_by:        str = ""
    order_dir:       str = "ASC"
    limit:           int = 5000
    select_exprs:    List[str] = field(default_factory=list)
    select_labels:   List[str] = field(default_factory=list)
    group_by_exprs:  List[str] = field(default_factory=list)
    having:          str = ""
    # Multi-table support
    join_tables:     List[str] = field(default_factory=list)  # additional tables
    join_clauses:    List[str] = field(default_factory=list)  # raw JOIN ... ON ... strings


# ---------------------------------------------------------------------------
# Clause builder (single condition)
# ---------------------------------------------------------------------------

def _build_clause(col: str, cat: str, op: str, val: str, val2: str) -> Tuple[str, str, list]:
    """Returns (parameterized_sql, display_sql, params_list)."""
    val  = val.strip()  if val  else ""
    val2 = val2.strip() if val2 else ""

    if not val and op not in ("between", "is empty", "is not empty"):
        return "", "", []

    def esc(v: str) -> str:
        return v.replace("'", "''")

    # Universal ops
    if op == "is empty":
        s = f"({col} IS NULL OR {col} = '')"
        return s, s, []
    if op == "is not empty":
        s = f"({col} IS NOT NULL AND {col} != '')"
        return s, s, []

    if cat == "text":
        mapping = {
            "contains":     (f"LOWER({col}) LIKE LOWER(?)",  f"LOWER({col}) LIKE LOWER('%{esc(val)}%')", [f"%{val}%"]),
            "not contains": (f"LOWER({col}) NOT LIKE LOWER(?)", f"LOWER({col}) NOT LIKE LOWER('%{esc(val)}%')", [f"%{val}%"]),
            "equals":       (f"LOWER({col}) = LOWER(?)",     f"LOWER({col}) = LOWER('{esc(val)}')",       [val]),
            "starts with":  (f"LOWER({col}) LIKE LOWER(?)",  f"LOWER({col}) LIKE LOWER('{esc(val)}%')",  [f"{val}%"]),
            "ends with":    (f"LOWER({col}) LIKE LOWER(?)",  f"LOWER({col}) LIKE LOWER('%{esc(val)}')",  [f"%{val}"]),
            "not equals":   (f"LOWER({col}) != LOWER(?)",    f"LOWER({col}) != LOWER('{esc(val)}')",     [val]),
        }
        if op in mapping:
            p, d, prm = mapping[op]
            return p, d, prm

    elif cat in ("date", "time"):
        if op == "between" and val and val2:
            return (f"{col} BETWEEN ? AND ?",
                    f"{col} BETWEEN '{esc(val)}' AND '{esc(val2)}'",
                    [val, val2])
        mapping = {
            "on":           (f"{col} = ?",  f"{col} = '{esc(val)}'"),
            "before":       (f"{col} < ?",  f"{col} < '{esc(val)}'"),
            "after":        (f"{col} > ?",  f"{col} > '{esc(val)}'"),
            "on or before": (f"{col} <= ?", f"{col} <= '{esc(val)}'"),
            "on or after":  (f"{col} >= ?", f"{col} >= '{esc(val)}'"),
            "equals":       (f"{col} = ?",  f"{col} = '{esc(val)}'"),
        }
        if op in mapping:
            p, d = mapping[op]
            return p, d, [val]

    elif cat == "number":
        if op == "between":
            try:
                float(val); float(val2)
                return (f"{col} BETWEEN ? AND ?",
                        f"{col} BETWEEN {val} AND {val2}",
                        [val, val2])
            except ValueError:
                return "", "", []
        try:
            float(val)
        except ValueError:
            return "", "", []
        mapping = {
            "equals":          (f"{col} = ?",  f"{col} = {val}"),
            "greater than":    (f"{col} > ?",  f"{col} > {val}"),
            "less than":       (f"{col} < ?",  f"{col} < {val}"),
            "greater or equal":(f"{col} >= ?", f"{col} >= {val}"),
            "less or equal":   (f"{col} <= ?", f"{col} <= {val}"),
            "not equals":      (f"{col} != ?", f"{col} != {val}"),
        }
        if op in mapping:
            p, d = mapping[op]
            return p, d, [val]

    return "", "", []


# ---------------------------------------------------------------------------
# Nested group WHERE builder
# ---------------------------------------------------------------------------

def _build_item(item: Any, first: bool) -> Tuple[str, str, list]:
    """
    Recursively builds (parameterized, display, params) for either a
    FilterRow or a FilterGroup.
    Returns empty strings if the item produces no SQL.
    """
    if isinstance(item, FilterRow):
        prefix = "" if first else f"{item.joiner} "
        col = f'"{item.table_prefix}{item.field}"' if item.table_prefix else f'"{item.field}"'
        p, d, params = _build_clause(col, item.category, item.operator, item.value, item.value2)
        if not p:
            return "", "", []
        return prefix + p, prefix + d, params

    elif isinstance(item, FilterGroup):
        # Recurse into sub-group
        inner_p, inner_d, params = _build_group_inner(item.items)
        if not inner_p:
            return "", "", []
        prefix = "" if first else f"{item.joiner} "
        return prefix + f"({inner_p})", prefix + f"({inner_d})", params

    return "", "", []


def _build_group_inner(items: list) -> Tuple[str, str, list]:
    """Build the SQL for all items inside a group (no outer parens)."""
    parts_p = []
    parts_d = []
    all_params = []
    for i, item in enumerate(items):
        p, d, params = _build_item(item, first=(len(parts_p) == 0))
        if p:
            parts_p.append(p)
            parts_d.append(d)
            all_params.extend(params)
    return " ".join(parts_p), " ".join(parts_d), all_params


def build_where_tree(groups: List[FilterGroup]) -> Tuple[str, tuple, str]:
    """
    Build a WHERE clause from a list of top-level FilterGroups.
    Each group becomes a ( ... ) block joined by the group's joiner.
    """
    if not groups:
        return "", tuple(), ""

    all_p = []
    all_d = []
    all_params = []

    for i, grp in enumerate(groups):
        inner_p, inner_d, params = _build_group_inner(grp.items)
        if not inner_p:
            continue
        prefix = "" if not all_p else f"{grp.joiner} "
        # Wrap in parens only if there's more than one item or it's nested
        needs_wrap = len(grp.items) > 1 or any(isinstance(x, FilterGroup) for x in grp.items)
        if needs_wrap:
            all_p.append(prefix + f"({inner_p})")
            all_d.append(prefix + f"({inner_d})")
        else:
            all_p.append(prefix + inner_p)
            all_d.append(prefix + inner_d)
        all_params.extend(params)

    if not all_p:
        return "", tuple(), ""

    where_p = "WHERE " + " ".join(all_p)
    where_d = "WHERE " + " ".join(all_d)
    return where_p, tuple(all_params), where_d


# ---------------------------------------------------------------------------
# Legacy flat WHERE builder (kept for backward compat)
# ---------------------------------------------------------------------------

def _build_where(filters: List[FilterRow]) -> Tuple[str, tuple, str]:
    clauses_p = []
    clauses_d = []
    params = []

    for i, f in enumerate(filters):
        col = f'"{f.field}"'
        clause_p, clause_d, p = _build_clause(col, f.category, f.operator, f.value, f.value2)
        if not clause_p:
            continue
        joiner = filters[i - 1].joiner if i > 0 else "AND"
        prefix = (joiner + " ") if clauses_p else ""
        clauses_p.append(prefix + clause_p)
        clauses_d.append(prefix + clause_d)
        params.extend(p)

    if not clauses_p:
        return "", tuple(), ""

    where_p = "WHERE " + " ".join(clauses_p)
    where_d = "WHERE " + " ".join(clauses_d)
    return where_p, tuple(params), where_d


# ---------------------------------------------------------------------------
# Main build_sql
# ---------------------------------------------------------------------------

def build_sql(spec: QuerySpec) -> Tuple[str, tuple, str]:
    """
    Build a full SELECT SQL for a dynamic table.
    Returns (sql_parameterized, params, sql_display).
    Supports:
      - single table or multi-table JOIN
      - flat filters (legacy) or nested filter_groups (v2)
    """
    # FROM clause (single or multi-table)
    if spec.join_tables and spec.join_clauses:
        from_clause = f'"{spec.table}"'
        for jt, jc in zip(spec.join_tables, spec.join_clauses):
            from_clause += f'\n  LEFT JOIN "{jt}" ON {jc}'
    else:
        from_clause = f'"{spec.table}"'

    # WHERE clause — prefer grouped mode
    if spec.filter_groups:
        where_p, params, where_d = build_where_tree(spec.filter_groups)
    elif spec.filters:
        where_p, params, where_d = _build_where(spec.filters)
    else:
        where_p, params, where_d = "", tuple(), ""

    # SELECT clause
    if spec.select_exprs:
        select_clause = ",\n    ".join(
            f'{expr} AS "{lbl}"'
            for expr, lbl in zip(spec.select_exprs, spec.select_labels)
        )
    else:
        select_clause = "*"

    base_p = f"SELECT\n    {select_clause}\nFROM {from_clause}\n{where_p}".strip()
    base_d = f"SELECT\n    {select_clause}\nFROM {from_clause}\n{where_d}".strip()

    # GROUP BY
    group_sql = ""
    if spec.group_by_exprs:
        group_sql = "GROUP BY " + ", ".join(spec.group_by_exprs)

    # HAVING
    having_sql = ""
    if spec.having and spec.group_by_exprs:
        having_sql = "HAVING " + spec.having

    # ORDER BY
    order_sql = ""
    if spec.order_by and not spec.group_by_exprs:
        od = "DESC" if spec.order_dir.upper() == "DESC" else "ASC"
        order_sql = f'ORDER BY "{spec.order_by}" {od}'

    # LIMIT
    limit_sql = f"LIMIT {int(spec.limit)}" if spec.limit > 0 else ""

    parts_p = [p for p in [base_p, group_sql, having_sql, order_sql, limit_sql] if p]
    parts_d = [p for p in [base_d, group_sql, having_sql, order_sql, limit_sql] if p]

    return "\n".join(parts_p), params, "\n".join(parts_d)


def format_sql_readable(sql: str) -> str:
    """Basic SQL pretty-printer."""
    for kw in ["SELECT", "FROM", "WHERE", "AND", "OR", "ORDER BY",
               "GROUP BY", "HAVING", "LIMIT", "LEFT JOIN", "INNER JOIN"]:
        sql = re.sub(rf"(?<![A-Z])\b{kw}\b(?![A-Z])", f"\n{kw}", sql, flags=re.IGNORECASE)
    sql = re.sub(r"\n{3,}", "\n\n", sql)
    return sql.strip()
