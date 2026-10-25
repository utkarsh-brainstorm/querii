/* ═══════════════════════════════════════════════════════════════════════════
   csv_editor.js — Querii v4.1
   ───────────────────────────
   • Spreadsheet-style CSV editor (create new / edit existing tables)
   • Direct copy-paste of CSV/TSV clipboard data into spreadsheet cells
   • Tab to next column, Enter to next row, Double-Enter to column 1 of next row
   • First row is locked as header row
   • "Edit" button for CSV files in file list
   • Custom PDF Styles: save, apply, and delete user presets across Settings,
     Ultra Dev Mode, and Export Modal
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

/* ── CSV Editor state ────────────────────────────────────────────────────── */
var _csvEd = {
  tableName:     '',        // table name
  isNew:         true,
  cols:          [],        // ['col1', 'col2', ...]
  rows:          [],        // [['v1','v2',...], ...]
  activeRow:     -1,        // last active/focused row
  activeCol:     -1,        // last active/focused col
  lastEnterC:    -1,        // column index of last Enter press
  lastEnterTime: 0,         // timestamp of last Enter press (for double-Enter)
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function _ceApi(method) {
  var args = Array.prototype.slice.call(arguments, 1);
  return (typeof apiCall === 'function')
    ? apiCall.apply(null, [method].concat(args))
    : Promise.reject(new Error('apiCall not available'));
}

function _ceEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ─── Open for NEW table (prompts for name upfront) ───────────────────────── */
function openNewCsvEditor() {
  var defaultName = 'new_table_' + Math.floor(Date.now() / 1000).toString().slice(-4);
  var name = prompt('Enter a name for the new CSV table:', defaultName);
  if (!name || !name.trim()) return;
  name = name.trim().replace(/\.csv$/i, '').replace(/[^a-zA-Z0-9_]/g, '_');
  if (!name) name = 'new_table';

  _csvEd.tableName     = name;
  _csvEd.isNew         = true;
  _csvEd.cols          = ['Column1', 'Column2', 'Column3'];
  _csvEd.rows          = [['', '', '']];
  _csvEd.activeRow     = 0;
  _csvEd.activeCol     = 0;
  _csvEd.lastEnterC    = -1;
  _csvEd.lastEnterTime = 0;

  _csvEdRender();
  var titleEl = document.getElementById('csv-editor-title');
  if (titleEl) titleEl.textContent = '📝 New CSV: ' + name;
  var infoEl = document.getElementById('csv-editor-info');
  if (infoEl) infoEl.textContent = 'First row = headers · Paste CSV text directly to populate';
  _openModal('modal-csv-editor');

  /* Focus first header */
  setTimeout(function() {
    var firstHdr = document.querySelector('[data-ce-col="0"]');
    if (firstHdr) { firstHdr.focus(); firstHdr.select(); }
  }, 50);
}

/* ─── Open for EDITING an existing table ─────────────────────────────────── */
function openCsvEditorForTable(tableName) {
  var titleEl = document.getElementById('csv-editor-title');
  if (titleEl) titleEl.textContent = '📝 Editing: ' + tableName;
  var infoEl = document.getElementById('csv-editor-info');
  if (infoEl) infoEl.textContent = 'Loading…';
  _openModal('modal-csv-editor');

  _ceApi('get_table_as_csv', tableName).then(function(data) {
    _csvEd.tableName     = tableName;
    _csvEd.isNew         = false;
    _csvEd.cols          = (data.columns && data.columns.length) ? data.columns.slice() : ['Column1'];
    _csvEd.rows          = (data.rows && data.rows.length) ? data.rows.map(function(r) { return r.slice(); }) : [['']];
    _csvEd.activeRow     = 0;
    _csvEd.activeCol     = 0;
    _csvEd.lastEnterC    = -1;
    _csvEd.lastEnterTime = 0;

    if (infoEl) {
      infoEl.textContent = _csvEd.rows.length.toLocaleString() + ' rows · ' + _csvEd.cols.length + ' cols · First row = headers';
    }
    _csvEdRender();
  }).catch(function(e) {
    if (typeof toast === 'function') toast('Error loading table: ' + e.message, 'error');
  });
}

/* ─── Render the spreadsheet table ──────────────────────────────────────── */
function _csvEdRender() {
  var thead = document.getElementById('csv-editor-thead');
  var tbody = document.getElementById('csv-editor-tbody');
  if (!thead || !tbody) return;

  /* Header row — locked/sticky, editable column name cells */
  var htr = '<tr>';
  htr += '<th style="' + _ceThStyle(true) + 'width:44px;color:#94a3b8;font-weight:400;text-align:center;user-select:none">#</th>';
  _csvEd.cols.forEach(function(col, ci) {
    htr += '<th style="' + _ceThStyle(false) + ';position:relative;cursor:grab" ' +
      'draggable="true" data-ce-col-drag="' + ci + '" ' +
      'ondragstart="_csvEdColDragStart(event,' + ci + ')" ' +
      'ondragover="_csvEdColDragOver(event,' + ci + ')" ' +
      'ondragleave="_csvEdColDragLeave(event)" ' +
      'ondrop="_csvEdColDrop(event,' + ci + ')" ' +
      'title="Header: Column name (drag to reorder)">' +
      '<div style="display:flex;align-items:center;gap:4px">' +
        '<span style="font-size:10px;opacity:0.4;cursor:grab;user-select:none" title="Drag to reorder column">⠿</span>' +
        '<input type="text" value="' + _ceEsc(col) + '" ' +
        'data-ce-col="' + ci + '" ' +
        'onfocus="_csvEd.activeCol=' + ci + '" ' +
        'onchange="_csvEdColRename(this,' + ci + ')" ' +
        'oncontextmenu="_csvEdDelCol(event,' + ci + ')" ' +
        'onpaste="_csvEdHandlePaste(event, null, ' + ci + ')" ' +
        'style="border:none;background:transparent;width:100%;font-weight:700;font-size:11px;' +
        'color:#f8fafc;outline:none;cursor:text;font-family:inherit;min-width:70px;" />' +
        '<button type="button" onclick="_csvEdDelColDirect(' + ci + ')" title="Delete column ' + _ceEsc(col) + '" ' +
        'style="border:none;background:none;color:#94a3b8;cursor:pointer;font-size:13px;font-weight:bold;padding:0 3px;line-height:1;transition:color .15s" ' +
        'onmouseover="this.style.color=\'#ef4444\'" onmouseout="this.style.color=\'#94a3b8\'">×</button>' +
      '</div>' +
      '</th>';
  });
  htr += '</tr>';
  thead.innerHTML = htr;

  /* Data rows */
  var html = '';
  _csvEd.rows.forEach(function(row, ri) {
    html += '<tr data-ce-row-idx="' + ri + '" ' +
      'ondragover="_csvEdRowDragOver(event,' + ri + ')" ' +
      'ondragleave="_csvEdRowDragLeave(event)" ' +
      'ondrop="_csvEdRowDrop(event,' + ri + ')">';
    html += '<td style="' + _ceTdStyle(true) + 'color:#94a3b8;text-align:center;user-select:none;position:relative;cursor:grab" ' +
      'draggable="true" ' +
      'ondragstart="_csvEdRowDragStart(event,' + ri + ')" ' +
      'onmouseenter="var b=this.querySelector(\'.ce-row-del\');if(b)b.style.opacity=\'1\';" ' +
      'onmouseleave="var b=this.querySelector(\'.ce-row-del\');if(b)b.style.opacity=\'0\';">' +
      '<span style="font-size:10px;display:inline-flex;align-items:center;gap:3px"><span style="font-size:9px;opacity:0.4;cursor:grab" title="Drag to reorder row">⠿</span>' + (ri + 1) + '</span>' +
      '<button type="button" class="ce-row-del" onclick="_csvEdDelRow(' + ri + ')" title="Delete row ' + (ri + 1) + '" ' +
      'style="opacity:0;border:none;background:none;color:#ef4444;cursor:pointer;font-size:12px;font-weight:bold;line-height:1;padding:0 2px;margin-left:2px;transition:opacity .15s">×</button>' +
      '</td>';
    _csvEd.cols.forEach(function(_, ci) {
      var val = (row[ci] !== undefined) ? row[ci] : '';
      html += '<td style="' + _ceTdStyle(false) + '">' +
        '<input type="text" value="' + _ceEsc(val) + '" ' +
        'data-ce-row="' + ri + '" data-ce-col-i="' + ci + '" ' +
        'onfocus="_csvEd.activeRow=' + ri + ';_csvEd.activeCol=' + ci + '" ' +
        'onchange="_csvEdCellChange(this,' + ri + ',' + ci + ')" ' +
        'onkeydown="_csvEdKey(event,' + ri + ',' + ci + ')" ' +
        'onpaste="_csvEdHandlePaste(event,' + ri + ',' + ci + ')" ' +
        'style="border:none;background:transparent;width:100%;font-size:11.5px;' +
        'color:#111827;outline:none;font-family:monospace;min-width:80px;padding:5px 8px;box-sizing:border-box;" />' +
        '</td>';
    });
    html += '</tr>';
  });
  tbody.innerHTML = html;
}

function _ceThStyle(isNum) {
  return 'background:#0f172a;color:#fff;padding:6px 10px;text-align:left;' +
    'white-space:nowrap;border-right:1px solid #334155;border-bottom:2px solid #3b82f6;font-size:11px;' +
    (isNum ? 'min-width:38px;' : 'min-width:100px;');
}

function _ceTdStyle(isNum) {
  return 'padding:0;border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;' +
    (isNum ? 'min-width:38px;background:#f8fafc;' : 'min-width:100px;');
}

/* ─── Cell / column name change ─────────────────────────────────────────── */
function _csvEdCellChange(inp, ri, ci) {
  if (!_csvEd.rows[ri]) _csvEd.rows[ri] = [];
  _csvEd.rows[ri][ci] = inp.value;
}

function _csvEdColRename(inp, ci) {
  var val = inp.value.trim();
  _csvEd.cols[ci] = val || ('col_' + (ci + 1));
}

/* ─── Direct Copy-Paste CSV text into spreadsheet cells ─────────────────── */
function _csvEdHandlePaste(e, ri, ci) {
  var clipData = e.clipboardData || window.clipboardData;
  if (!clipData) return;
  var clipText = clipData.getData('text');
  if (!clipText || !clipText.trim()) return;

  /* Check if text contains CSV/TSV content (newlines, tabs, commas) */
  var rawLines = clipText.split(/\r?\n/).filter(function(l) { return l.length > 0; });
  if (!rawLines.length) return;

  var hasTabs = rawLines.some(function(l) { return l.indexOf('\t') !== -1; });
  var delim = hasTabs ? '\t' : ',';

  /* Parse tabular rows */
  var parsed = rawLines.map(function(line) {
    if (delim === '\t') {
      return line.split('\t').map(function(c) { return c.trim(); });
    }
    /* CSV parser respecting quotes */
    var cells = [], cur = '', inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes) {
        cells.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  });

  if (!parsed.length) return;
  e.preventDefault();
  _csvEdSyncAll();

  var isBlankTable = (_csvEd.rows.length <= 1 && _csvEd.rows[0].every(function(v) { return !v; }));

  if (ri === null || ri === undefined || (isBlankTable && ri === 0)) {
    /* Pasted on header row or into blank table: line 0 becomes headers! */
    if (parsed.length > 1) {
      _csvEd.cols = parsed[0].map(function(c, idx) { return c || ('col_' + (idx + 1)); });
      _csvEd.rows = parsed.slice(1);
    } else {
      /* Single line pasted into headers */
      _csvEd.cols = parsed[0].map(function(c, idx) { return c || ('col_' + (idx + 1)); });
      if (!_csvEd.rows.length) _csvEd.rows = [_csvEd.cols.map(function() { return ''; })];
    }
  } else {
    /* Pasted into specific data cell (ri, ci) */
    ci = (ci !== undefined && ci !== null) ? ci : 0;
    for (var r = 0; r < parsed.length; r++) {
      var targetR = ri + r;
      while (_csvEd.rows.length <= targetR) {
        _csvEd.rows.push(_csvEd.cols.map(function() { return ''; }));
      }
      for (var c = 0; c < parsed[r].length; c++) {
        var targetC = ci + c;
        while (_csvEd.cols.length <= targetC) {
          _csvEd.cols.push('Column' + (_csvEd.cols.length + 1));
          _csvEd.rows.forEach(function(rw) { rw.push(''); });
        }
        _csvEd.rows[targetR][targetC] = parsed[r][c];
      }
    }
  }

  _csvEdRender();
  if (typeof toast === 'function') {
    toast('✓ Pasted ' + parsed.length + ' rows into spreadsheet', 'success');
  }
  var info = document.getElementById('csv-editor-info');
  if (info) info.textContent = _csvEd.rows.length.toLocaleString() + ' rows · ' + _csvEd.cols.length + ' cols';
}

/* ─── Keyboard navigation (Tab, Enter, Double-Enter) ─────────────────────── */
function _csvEdKey(e, ri, ci) {
  var key = e.key;

  if (key === 'Tab') {
    e.preventDefault();
    _csvEdSyncCell(ri, ci);
    var nextCi = ci + (e.shiftKey ? -1 : 1);
    if (nextCi >= _csvEd.cols.length) {
      nextCi = 0;
      ri = ri + 1;
      if (ri >= _csvEd.rows.length) { csvEditorAddRow(); return; }
    } else if (nextCi < 0) {
      nextCi = _csvEd.cols.length - 1;
      ri = Math.max(0, ri - 1);
    }
    _csvEdFocus(ri, nextCi);
    return;
  }

  if (key === 'Enter') {
    e.preventDefault();
    _csvEdSyncCell(ri, ci);

    var now = Date.now();
    /* Double-Enter detection: two Enter presses within 600ms on the same column */
    var isDoubleEnter = (_csvEd.lastEnterC === ci && (now - _csvEd.lastEnterTime) < 600);
    _csvEd.lastEnterC    = ci;
    _csvEd.lastEnterTime = now;

    var nextR = ri + 1;
    if (nextR >= _csvEd.rows.length) {
      _csvEd.rows.push(_csvEd.cols.map(function() { return ''; }));
      _csvEdRender();
    }

    if (isDoubleEnter) {
      /* Double Enter: jump to column 0 of next row */
      setTimeout(function() { _csvEdFocus(nextR, 0); }, 30);
    } else {
      /* Single Enter: move down to same column */
      setTimeout(function() { _csvEdFocus(nextR, ci); }, 30);
    }
    return;
  }

  if (key === 'ArrowUp') {
    if (ri > 0) { e.preventDefault(); _csvEdSyncCell(ri, ci); _csvEdFocus(ri - 1, ci); }
  } else if (key === 'ArrowDown') {
    if (ri < _csvEd.rows.length - 1) { e.preventDefault(); _csvEdSyncCell(ri, ci); _csvEdFocus(ri + 1, ci); }
  } else if (key === 'ArrowLeft' && e.target.selectionStart === 0 && ci > 0) {
    e.preventDefault(); _csvEdSyncCell(ri, ci); _csvEdFocus(ri, ci - 1);
  } else if (key === 'ArrowRight' && e.target.selectionStart === e.target.value.length && ci < _csvEd.cols.length - 1) {
    e.preventDefault(); _csvEdSyncCell(ri, ci); _csvEdFocus(ri, ci + 1);
  }

  if (key !== 'Enter') {
    _csvEd.lastEnterC = -1;
  }
}

function _csvEdSyncCell(ri, ci) {
  var inp = document.querySelector('[data-ce-row="' + ri + '"][data-ce-col-i="' + ci + '"]');
  if (inp) {
    if (!_csvEd.rows[ri]) _csvEd.rows[ri] = [];
    _csvEd.rows[ri][ci] = inp.value;
  }
}

function _csvEdFocus(ri, ci) {
  var inp = document.querySelector('[data-ce-row="' + ri + '"][data-ce-col-i="' + ci + '"]');
  if (inp) { inp.focus(); inp.select(); }
}

/* ─── Add row / column (with N input & active cursor position support) ──── */
function csvEditorAddRowsN() {
  _csvEdSyncAll();
  var countEl = document.getElementById('csv-add-rows-count');
  var n = Math.max(1, Math.min(500, parseInt(countEl ? countEl.value : 1, 10) || 1));
  var insertAt = (_csvEd.activeRow >= 0 && _csvEd.activeRow < _csvEd.rows.length)
    ? _csvEd.activeRow + 1
    : _csvEd.rows.length;

  var newRows = [];
  for (var i = 0; i < n; i++) {
    newRows.push(_csvEd.cols.map(function() { return ''; }));
  }
  _csvEd.rows.splice.apply(_csvEd.rows, [insertAt, 0].concat(newRows));
  _csvEd.activeRow = insertAt;
  _csvEdRender();
  setTimeout(function() { _csvEdFocus(insertAt, Math.max(0, _csvEd.activeCol)); }, 30);
  var info = document.getElementById('csv-editor-info');
  if (info) info.textContent = _csvEd.rows.length.toLocaleString() + ' rows · ' + _csvEd.cols.length + ' cols';
}

function csvEditorAddColsN() {
  _csvEdSyncAll();
  var countEl = document.getElementById('csv-add-cols-count');
  var n = Math.max(1, Math.min(50, parseInt(countEl ? countEl.value : 1, 10) || 1));
  var insertAt = (_csvEd.activeCol >= 0 && _csvEd.activeCol < _csvEd.cols.length)
    ? _csvEd.activeCol + 1
    : _csvEd.cols.length;

  var newCols = [];
  for (var i = 0; i < n; i++) {
    var colNum = _csvEd.cols.length + 1 + i;
    var colName = 'Column' + colNum;
    while (_csvEd.cols.indexOf(colName) !== -1 || newCols.indexOf(colName) !== -1) {
      colNum++;
      colName = 'Column' + colNum;
    }
    newCols.push(colName);
  }
  _csvEd.cols.splice.apply(_csvEd.cols, [insertAt, 0].concat(newCols));
  _csvEd.rows.forEach(function(r) {
    for (var k = 0; k < n; k++) {
      r.splice(insertAt + k, 0, '');
    }
  });
  _csvEd.activeCol = insertAt;
  _csvEdRender();
  setTimeout(function() {
    var inp = document.querySelector('[data-ce-col="' + insertAt + '"]');
    if (inp) { inp.focus(); inp.select(); }
  }, 30);
  var info = document.getElementById('csv-editor-info');
  if (info) info.textContent = _csvEd.rows.length.toLocaleString() + ' rows · ' + _csvEd.cols.length + ' cols';
}

/* ─── Drag & Drop Reordering for Rows and Columns ──────────────────────── */
var _csvEdDragRowIdx = -1;
var _csvEdDragColIdx = -1;

function _csvEdRowDragStart(e, ri) {
  _csvEdSyncAll();
  _csvEdDragRowIdx = ri;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'row:' + ri);
  var tr = e.target.closest('tr');
  if (tr) tr.classList.add('ce-row-dragging');
}

function _csvEdRowDragOver(e, ri) {
  if (_csvEdDragRowIdx < 0) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  var tr = e.currentTarget;
  if (tr) {
    tr.classList.add('ce-drag-over-top');
  }
}

function _csvEdRowDragLeave(e) {
  var tr = e.currentTarget;
  if (tr) tr.classList.remove('ce-drag-over-top');
}

function _csvEdRowDrop(e, targetRi) {
  e.preventDefault();
  var fromRi = _csvEdDragRowIdx;
  _csvEdDragRowIdx = -1;
  document.querySelectorAll('.ce-drag-over-top, .ce-row-dragging').forEach(function(el) {
    el.classList.remove('ce-drag-over-top', 'ce-row-dragging');
  });
  if (fromRi < 0 || fromRi === targetRi || fromRi >= _csvEd.rows.length || targetRi >= _csvEd.rows.length) return;

  _csvEdSyncAll();
  var moved = _csvEd.rows.splice(fromRi, 1)[0];
  _csvEd.rows.splice(targetRi, 0, moved);
  _csvEd.activeRow = targetRi;
  _csvEdRender();
}

function _csvEdColDragStart(e, ci) {
  _csvEdSyncAll();
  _csvEdDragColIdx = ci;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'col:' + ci);
  var th = e.currentTarget;
  if (th) th.classList.add('ce-col-dragging');
}

function _csvEdColDragOver(e, ci) {
  if (_csvEdDragColIdx < 0) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  var th = e.currentTarget;
  if (th) th.classList.add('ce-drag-over-left');
}

function _csvEdColDragLeave(e) {
  var th = e.currentTarget;
  if (th) th.classList.remove('ce-drag-over-left');
}

function _csvEdColDrop(e, targetCi) {
  e.preventDefault();
  var fromCi = _csvEdDragColIdx;
  _csvEdDragColIdx = -1;
  document.querySelectorAll('.ce-drag-over-left, .ce-col-dragging').forEach(function(el) {
    el.classList.remove('ce-drag-over-left', 'ce-col-dragging');
  });
  if (fromCi < 0 || fromCi === targetCi || fromCi >= _csvEd.cols.length || targetCi >= _csvEd.cols.length) return;

  _csvEdSyncAll();
  var movedCol = _csvEd.cols.splice(fromCi, 1)[0];
  _csvEd.cols.splice(targetCi, 0, movedCol);
  _csvEd.rows.forEach(function(r) {
    var movedVal = r.splice(fromCi, 1)[0];
    r.splice(targetCi, 0, movedVal);
  });
  _csvEd.activeCol = targetCi;
  _csvEdRender();
}

window._csvEdRowDragStart = _csvEdRowDragStart;
window._csvEdRowDragOver  = _csvEdRowDragOver;
window._csvEdRowDragLeave = _csvEdRowDragLeave;
window._csvEdRowDrop      = _csvEdRowDrop;
window._csvEdColDragStart = _csvEdColDragStart;
window._csvEdColDragOver  = _csvEdColDragOver;
window._csvEdColDragLeave = _csvEdColDragLeave;
window._csvEdColDrop      = _csvEdColDrop;

function csvEditorAddRow() { csvEditorAddRowsN(); }
function csvEditorAddCol() { csvEditorAddColsN(); }
window.csvEditorAddRow = csvEditorAddRow;
window.csvEditorAddCol = csvEditorAddCol;
window.csvEditorAddRowsN = csvEditorAddRowsN;
window.csvEditorAddColsN = csvEditorAddColsN;

/* ─── Delete row / column with smooth fast reddish vanishing animation ───── */
var _csvEdDeleting = false;

function _csvEdDelRow(ri) {
  if (_csvEdDeleting) return;
  if (_csvEd.rows.length <= 1) {
    _csvEd.rows = [_csvEd.cols.map(function() { return ''; })];
    _csvEdRender();
    if (typeof toast === 'function') toast('Row cleared (table must have at least 1 row).', 'info');
    return;
  }
  _csvEdSyncAll();

  var tbody = document.getElementById('csv-editor-tbody');
  var tr = tbody && tbody.children[ri];
  if (tr) {
    _csvEdDeleting = true;
    tr.classList.add('ce-row-vanishing');
    setTimeout(function() {
      _csvEd.rows.splice(ri, 1);
      if (_csvEd.activeRow >= _csvEd.rows.length) _csvEd.activeRow = _csvEd.rows.length - 1;
      _csvEdDeleting = false;
      _csvEdRender();
      var info = document.getElementById('csv-editor-info');
      if (info) info.textContent = _csvEd.rows.length.toLocaleString() + ' rows · ' + _csvEd.cols.length + ' cols';
    }, 160);
  } else {
    _csvEd.rows.splice(ri, 1);
    if (_csvEd.activeRow >= _csvEd.rows.length) _csvEd.activeRow = _csvEd.rows.length - 1;
    _csvEdRender();
    var info = document.getElementById('csv-editor-info');
    if (info) info.textContent = _csvEd.rows.length.toLocaleString() + ' rows · ' + _csvEd.cols.length + ' cols';
  }
}
window._csvEdDelRow = _csvEdDelRow;

function _csvEdDelColDirect(ci) {
  if (_csvEdDeleting) return;
  if (_csvEd.cols.length <= 1) {
    if (typeof toast === 'function') toast('Must have at least 1 column.', 'warn');
    return;
  }
  _csvEdSyncAll();

  var thead = document.getElementById('csv-editor-thead');
  var tbody = document.getElementById('csv-editor-tbody');
  var th = thead ? thead.querySelectorAll('th')[ci + 1] : null;
  var tds = tbody ? tbody.querySelectorAll('[data-ce-col-i="' + ci + '"]') : [];

  _csvEdDeleting = true;
  if (th) th.classList.add('ce-col-vanishing');
  for (var i = 0; i < tds.length; i++) {
    var parentTd = tds[i].closest('td');
    if (parentTd) parentTd.classList.add('ce-col-vanishing');
  }

  setTimeout(function() {
    _csvEd.cols.splice(ci, 1);
    _csvEd.rows.forEach(function(r) { r.splice(ci, 1); });
    if (_csvEd.activeCol >= _csvEd.cols.length) _csvEd.activeCol = _csvEd.cols.length - 1;
    _csvEdDeleting = false;
    _csvEdRender();
    var info = document.getElementById('csv-editor-info');
    if (info) info.textContent = _csvEd.rows.length.toLocaleString() + ' rows · ' + _csvEd.cols.length + ' cols';
  }, 160);
}
window._csvEdDelColDirect = _csvEdDelColDirect;

function _csvEdDelCol(e, ci) {
  e.preventDefault();
  _csvEdDelColDirect(ci);
}

function csvEditorDelActiveRow() {
  var ri = (_csvEd.activeRow >= 0 && _csvEd.activeRow < _csvEd.rows.length) ? _csvEd.activeRow : (_csvEd.rows.length - 1);
  _csvEdDelRow(ri);
}
window.csvEditorDelActiveRow = csvEditorDelActiveRow;

function csvEditorDelActiveCol() {
  var ci = (_csvEd.activeCol >= 0 && _csvEd.activeCol < _csvEd.cols.length) ? _csvEd.activeCol : (_csvEd.cols.length - 1);
  _csvEdDelColDirect(ci);
}
window.csvEditorDelActiveCol = csvEditorDelActiveCol;

function _csvEdSyncAll() {
  document.querySelectorAll('[data-ce-row]').forEach(function(inp) {
    var ri = parseInt(inp.getAttribute('data-ce-row'), 10);
    var ci = parseInt(inp.getAttribute('data-ce-col-i'), 10);
    if (!isNaN(ri) && !isNaN(ci)) {
      if (!_csvEd.rows[ri]) _csvEd.rows[ri] = [];
      _csvEd.rows[ri][ci] = inp.value;
    }
  });
  document.querySelectorAll('[data-ce-col]').forEach(function(inp) {
    var ci = parseInt(inp.getAttribute('data-ce-col'), 10);
    if (!isNaN(ci)) _csvEd.cols[ci] = inp.value.trim() || ('col_' + (ci + 1));
  });
}

/* ─── Save ──────────────────────────────────────────────────────────────── */
function csvEditorSave() {
  _csvEdSyncAll();

  var cols = _csvEd.cols.map(function(c, i) { return (c && c.trim()) ? c.trim() : ('col_' + (i + 1)); });

  /* Filter out entirely empty rows */
  var rows = _csvEd.rows.filter(function(r) {
    return r.some(function(v) { return v && String(v).trim() !== ''; });
  });

  if (!rows.length) {
    rows = [cols.map(function() { return ''; })];
  }

  var tableName = _csvEd.tableName || 'my_table';
  var method = _csvEd.isNew ? 'create_csv_table' : 'save_csv_table';

  _ceApi(method, tableName, cols, rows).then(function(res) {
    if (typeof toast === 'function') {
      toast('✓ Saved table "' + res.table_name + '" (' + res.inserted + ' rows)', 'success');
    }
    if (typeof closeModal === 'function') closeModal();
    if (typeof refreshSchema === 'function') refreshSchema();
  }).catch(function(e) {
    if (typeof toast === 'function') toast('Save failed: ' + e.message, 'error');
  });
}

function closeCsvEditor() {
  var el = document.getElementById('modal-csv-editor');
  if (el) el.classList.add('hidden');
  var bd = document.getElementById('modal-backdrop');
  if (bd) bd.classList.add('hidden');
  if (typeof closeModal === 'function') closeModal();
}
window.closeCsvEditor = closeCsvEditor;

/* ─── Helper: open modal ────────────────────────────────────────────────── */
function _openModal(id) {
  if (typeof openModal === 'function') { openModal(id); return; }
  document.querySelectorAll('.modal').forEach(function(m) { m.classList.add('hidden'); });
  var overlay = document.getElementById('modal-backdrop');
  if (overlay) overlay.classList.remove('hidden');
  var el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

/* ═══════════════════════════════════════════════════════════════════════════
   CUSTOM PDF STYLES  — save / load / delete across all UI locations
   ═══════════════════════════════════════════════════════════════════════════ */

/* Settings -> PDF Style tab */
function loadCustomStylePills() {
  _ceApi('get_pdf_styles').then(function(styles) {
    var container = document.getElementById('custom-style-pills');
    if (!container) return;
    container.innerHTML = '';
    if (!styles || !styles.length) {
      container.innerHTML = '<span style="font-size:10px;color:#94a3b8;font-style:italic">No saved custom styles yet</span>';
      return;
    }
    styles.forEach(function(s) {
      var pill = document.createElement('span');
      pill.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:var(--bg-muted);border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-size:10px;';
      var nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.textContent = '⭐ ' + s.name;
      nameBtn.title = 'Apply this custom style';
      nameBtn.style.cssText = 'background:none;border:none;color:var(--accent);cursor:pointer;font-size:10px;font-weight:600;padding:0;';
      nameBtn.onclick = function() {
        var ta = document.getElementById('s-pdf-custom-css');
        if (ta) { ta.value = s.css; ta.dispatchEvent(new Event('input')); }
      };
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '×';
      delBtn.title = 'Delete style "' + s.name + '"';
      delBtn.style.cssText = 'background:none;border:none;color:var(--danger);cursor:pointer;font-size:12px;font-weight:bold;line-height:1;padding:0 0 0 2px;';
      delBtn.onclick = function() { _deleteCustomStyle(s.name); };
      pill.appendChild(nameBtn);
      pill.appendChild(delBtn);
      container.appendChild(pill);
    });
  }).catch(function() {});
}

function _deleteCustomStyle(name) {
  if (!confirm('Delete custom style "' + name + '"?')) return;
  _ceApi('delete_pdf_style', name).then(function() {
    if (typeof toast === 'function') toast('Style deleted.', 'success');
    loadCustomStylePills();
    loadExportModalCustomStyles();
    loadCustomStylesForDevMode();
  }).catch(function(e) {
    if (typeof toast === 'function') toast('Delete failed: ' + e.message, 'error');
  });
}

function saveCustomPdfStyle() {
  var nameInput = document.getElementById('s-style-name');
  var cssInput  = document.getElementById('s-pdf-custom-css');
  if (!nameInput || !cssInput) return;
  var name = nameInput.value.trim();
  var css  = cssInput.value.trim();
  if (!name) { if (typeof toast === 'function') toast('Enter a name for the style.', 'warn'); return; }
  if (!css)  { if (typeof toast === 'function') toast('CSS is empty.', 'warn'); return; }
  _ceApi('save_pdf_style', name, css).then(function() {
    if (typeof toast === 'function') toast('✓ Style "' + name + '" saved.', 'success');
    nameInput.value = '';
    loadCustomStylePills();
    loadExportModalCustomStyles();
    loadCustomStylesForDevMode();
  }).catch(function(e) {
    if (typeof toast === 'function') toast('Save failed: ' + e.message, 'error');
  });
}

/* Export Modal custom styles */
function loadExportModalCustomStyles() {
  _ceApi('get_pdf_styles').then(function(styles) {
    var container = document.getElementById('export-custom-style-pills');
    if (!container) return;
    container.innerHTML = '';
    if (!styles || !styles.length) {
      container.innerHTML = '<span style="font-size:10px;color:var(--text-dim);font-style:italic">None</span>';
      return;
    }
    styles.forEach(function(s) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-ghost text-[10px] h-6 px-2';
      btn.textContent = '⭐ ' + s.name;
      btn.title = 'Apply saved style: ' + s.name;
      btn.onclick = function() {
        var ta = document.getElementById('pdf-custom-css');
        if (ta) { ta.value = s.css; ta.dispatchEvent(new Event('input')); }
        if (typeof toast === 'function') toast('Applied custom style: ' + s.name);
      };
      container.appendChild(btn);
    });
  }).catch(function() {});
}

function saveExportCssAsNewStyle() {
  var ta = document.getElementById('pdf-custom-css');
  var css = ta ? ta.value.trim() : '';
  if (!css) { if (typeof toast === 'function') toast('CSS is empty.', 'warn'); return; }
  var name = prompt('Name for this new custom PDF style:');
  if (!name || !name.trim()) return;
  _ceApi('save_pdf_style', name.trim(), css).then(function() {
    if (typeof toast === 'function') toast('✓ Style "' + name + '" saved.', 'success');
    loadExportModalCustomStyles();
    loadCustomStylesForDevMode();
    loadCustomStylePills();
  }).catch(function(e) {
    if (typeof toast === 'function') toast('Save failed: ' + e.message, 'error');
  });
}

/* Ultra Dev Mode custom styles */
function loadCustomStylesForDevMode() {
  _ceApi('get_pdf_styles').then(function(styles) {
    var container = document.getElementById('dev-custom-style-pills');
    if (!container) return;
    container.innerHTML = '';
    if (!styles || !styles.length) {
      container.innerHTML = '<span style="font-size:10px;color:#94a3b8;font-style:italic">No custom styles yet. Click "Save as Style" above to create one.</span>';
      return;
    }
    styles.forEach(function(s) {
      var pill = document.createElement('span');
      pill.style.cssText = 'display:inline-flex;align-items:center;gap:3px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:4px;padding:2px 6px;font-size:10px;';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '⭐ ' + s.name;
      btn.title = 'Apply style: ' + s.name;
      btn.style.cssText = 'background:none;border:none;color:#4338ca;font-weight:700;cursor:pointer;font-size:10px;padding:0;';
      btn.onclick = function() {
        if (typeof _dev !== 'undefined') _dev.css = s.css;
        var ed = document.getElementById('dev-css-editor');
        if (ed) ed.value = s.css;
        if (typeof _devRefreshPreviewDebounced === 'function') _devRefreshPreviewDebounced(50);
        if (typeof toast === 'function') toast('Applied custom style: ' + s.name);
      };
      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.title = 'Delete style';
      del.style.cssText = 'background:none;border:none;color:#ef4444;font-size:12px;cursor:pointer;line-height:1;padding:0;';
      del.onclick = function() { _deleteCustomStyle(s.name); };
      pill.appendChild(btn);
      pill.appendChild(del);
      container.appendChild(pill);
    });
  }).catch(function() {});
}

window._devSaveAsNewStyle = function() {
  var css = '';
  if (typeof _dev !== 'undefined' && _dev.css) {
    css = _dev.css;
  } else {
    var ed = document.getElementById('dev-css-editor');
    if (ed) css = ed.value;
  }
  if (!css || !css.trim()) {
    if (typeof toast === 'function') toast('No CSS to save.', 'warn');
    return;
  }
  var name = prompt('Name for this new custom PDF style:');
  if (!name || !name.trim()) return;
  _ceApi('save_pdf_style', name.trim(), css).then(function() {
    if (typeof toast === 'function') toast('✓ Custom style "' + name + '" saved.', 'success');
    loadCustomStylesForDevMode();
    loadExportModalCustomStyles();
    loadCustomStylePills();
  }).catch(function(e) {
    if (typeof toast === 'function') toast('Save failed: ' + e.message, 'error');
  });
};

/* ─── Lifecycle hooks ────────────────────────────────────────────────────── */
(function() {
  /* Settings open hook */
  if (typeof openSettings === 'function') {
    var _origSettings = openSettings;
    window.openSettings = function() {
      _origSettings.apply(this, arguments);
      setTimeout(loadCustomStylePills, 120);
    };
  }
  /* Settings tab switch hook */
  if (typeof switchSettingsTab === 'function') {
    var _origTab = switchSettingsTab;
    window.switchSettingsTab = function(btn, tab) {
      _origTab.apply(this, arguments);
      if (tab === 'pdfstyle') setTimeout(loadCustomStylePills, 80);
    };
  }
  /* Ultra Dev Mode open hook */
  if (typeof openUltraDevMode === 'function') {
    var _origDevMode = openUltraDevMode;
    window.openUltraDevMode = function() {
      _origDevMode.apply(this, arguments);
      setTimeout(loadCustomStylesForDevMode, 150);
    };
  }
  /* Export PDF modal open hook */
  if (typeof exportPdf === 'function') {
    var _origExportPdf = exportPdf;
    window.exportPdf = function() {
      _origExportPdf.apply(this, arguments);
      setTimeout(loadExportModalCustomStyles, 100);
    };
  }
})();

/* ─── Global Table Paste listener for whole modal ────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
  var wrap = document.getElementById('csv-editor-wrap');
  if (wrap) {
    wrap.addEventListener('paste', function(e) {
      /* If focus is not on an input, paste into top-left or active row */
      if (!e.target || e.target.tagName !== 'INPUT') {
        _csvEdHandlePaste(e, 0, 0);
      }
    });
  }
});
