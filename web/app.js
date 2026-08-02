/**
 * app.js — Querii v2.0
 * =====================
 * Major upgrade:
 *  - Nested group visual filter builder (unlimited depth)
 *  - Multi-table / JOIN mode
 *  - Copy-able schema
 *  - SQL Explainer
 *  - SQL Templates
 *  - Column stats popup
 *  - Fixed query log
 *  - Smooth resize (requestAnimationFrame)
 */

'use strict';

/* ── In-memory store (replaces localStorage — not available in WebKit) ── */
window._apMem = window._apMem || {};
function memGet(k, d) { var v = window._apMem[k]; return (v !== undefined && v !== null) ? v : (d !== undefined ? d : null); }
function memSet(k, v) { window._apMem[k] = v; }

/* ── API bridge ─────────────────────────────────────────────────────── */
function waitForApi() {
  return new Promise(function(res) {
    if (window.pywebview && window.pywebview.api) return res();
    var t = setInterval(function() {
      if (window.pywebview && window.pywebview.api) { clearInterval(t); res(); }
    }, 60);
  });
}

function apiCall(method) {
  var args = Array.prototype.slice.call(arguments, 1);
  return waitForApi().then(function() {
    return window.pywebview.api[method].apply(window.pywebview.api, args);
  }).then(function(r) {
    if (!r.ok) throw new Error(r.error || 'API error');
    return r.data;
  });
}

/* ── Global state ───────────────────────────────────────────────────── */
var _currentFile     = null;
var _pendingPreview  = null;
var _activeTable     = '';
var _selectedTables  = [];      // for multi-table / JOIN mode
var _joinClauses     = [];      // [{table1, col1, table2, col2, id}]
var _tableColumns    = [];      // [{name, type, category, operators}]
var _lastResults     = null;
var _filterGroups    = [];      // [{id, joiner, items:[{_type,id,joiner,field,...}|{_type:'group',...}]}]
var _groupCounter    = 0;
var _itemCounter     = 0;
var _selectPills     = [];
var _groupByPills    = [];
var _customReports   = [];
var _allSchemaData   = [];
var _csCurrentTable  = '';
var _csCurrentCol    = '';
/* Pagination */
var PAGE_SIZE        = 200;     // rows per page
var _currentPage     = 0;       // 0-indexed
var _colSearch       = '';      // current column search term in results

/* ── Utilities ──────────────────────────────────────────────────────── */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function on(id, ev, fn) {
  var el = document.getElementById(id);
  if (el) el.addEventListener(ev, fn);
}

/* ── Toast ──────────────────────────────────────────────────────────── */
var _toastTimer = null;
function toast(msg, type) {
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  var bg = type === 'error' ? 'var(--danger)' : type === 'warn' ? '#d97706' : 'var(--accent)';
  // NOTE: set properties individually — setting style.cssText then classList.add('hidden')
  // fails because inline display:block beats the hidden class. Always use style.display.
  el.style.position   = 'fixed';
  el.style.bottom     = '16px';
  el.style.right      = '16px';
  el.style.zIndex     = '9999';
  el.style.fontSize   = '12px';
  el.style.fontWeight = '500';
  el.style.padding    = '10px 16px';
  el.style.borderRadius = '6px';
  el.style.boxShadow  = '0 4px 20px rgba(0,0,0,0.2)';
  el.style.maxWidth   = '340px';
  el.style.background = bg;
  el.style.color      = '#fff';
  el.style.display    = 'block';
  el.style.opacity    = '1';
  el.classList.remove('hidden', 'fade-out');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function() {
    el.classList.add('fade-out');
    setTimeout(function() {
      el.style.display = 'none';
      el.classList.remove('fade-out');
    }, 260);
  }, 3000);
}

/* ── Modal ──────────────────────────────────────────────────────────── */
var _activeModal = null;
function openModal(id) {
  closeModal();
  _activeModal = id;
  var bd = document.getElementById('modal-backdrop');
  var m  = document.getElementById(id);
  if (bd) bd.classList.remove('hidden');
  if (m)  m.classList.remove('hidden');
}
function closeModal() {
  if (_activeModal) {
    var m = document.getElementById(_activeModal);
    if (m) m.classList.add('hidden');
    _activeModal = null;
  }
  var bd = document.getElementById('modal-backdrop');
  if (bd) bd.classList.add('hidden');
}

/* ── Zoom ───────────────────────────────────────────────────────────── */
var ZOOM_DEFAULT = 1.0, ZOOM_MIN = 0.6, ZOOM_MAX = 1.6;
var _zoom = ZOOM_DEFAULT;
function setZoom(z) {
  _zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  document.documentElement.style.zoom = String(_zoom);
  var lbl = document.getElementById('zoom-label');
  if (lbl) lbl.textContent = Math.round(_zoom * 100) + '%';
  memSet('ap_zoom', _zoom);
  apiCall('save_settings', { ap_zoom: String(_zoom) }).catch(function() {});
}
function adjustZoom(d) { setZoom(_zoom + d); }
function resetZoom()   { setZoom(ZOOM_DEFAULT); }

/* ── Theme ──────────────────────────────────────────────────────────── */
function currentTheme() { return memGet('ap_theme', 'mono'); }
function renderThemeGrid() { if (typeof buildThemeGrid === 'function') buildThemeGrid(); }

/* ── Settings modal ─────────────────────────────────────────────────── */
function openSettings() {
  renderThemeGrid();
  openModal('modal-settings');
  switchSettingsTab(document.querySelector('.settings-tab'), 'organisation');
  loadQueryLog();
}
function switchSettingsTab(btn, tab) {
  document.querySelectorAll('.settings-tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.settings-tab-body').forEach(function(t) { t.classList.add('hidden'); });
  if (btn) btn.classList.add('active');
  var el = document.getElementById('tab-' + tab);
  if (el) el.classList.remove('hidden');
  if (tab === 'theme')    renderThemeGrid();
  if (tab === 'querylog') loadQueryLog();
}
function saveSettings() {
  var orgName = (document.getElementById('s-org-name') || {}).value || '';
  var payload = {
    org_name:  orgName,
    ap_theme:  currentTheme(),
    ap_zoom:   String(_zoom),
    ap_custom_reports: JSON.stringify(_customReports),
  };
  var imgEl = document.getElementById('logo-img');
  if (imgEl && imgEl.src && imgEl.src.indexOf('base64,') !== -1) {
    payload.org_logo_b64 = imgEl.src.replace(/^data:[^;]+;base64,/, '');
  }
  apiCall('save_settings', payload)
    .then(function() {
      var el = document.getElementById('org-name-display');
      if (el) { el.textContent = orgName; el.classList.toggle('hidden', !orgName); }
      closeModal();
      toast('Settings saved.');
    })
    .catch(function(e) { toast('Save failed: ' + e.message, 'error'); });
}

/* ── Query Log ──────────────────────────────────────────────────────── */
function loadQueryLog() {
  var c = document.getElementById('query-log-list');
  if (!c) return;
  c.innerHTML = '<div style="padding:12px;text-align:center;font-size:11px;color:var(--text-dim)">Loading…</div>';
  apiCall('get_query_log')
    .then(function(logs) {
      if (!logs || !logs.length) {
        c.innerHTML = '<div style="padding:20px;text-align:center;font-size:11px;color:var(--text-dim)">No queries logged yet. Run a search or SQL query to start.</div>';
        return;
      }
      c.innerHTML = '';
      logs.forEach(function(q) {
        var d = document.createElement('div');
        d.className = 'qlog-row';
        var srcTag = q.source === 'filter' ? '<span style="font-size:9px;padding:1px 4px;border-radius:3px;background:var(--accent-bg);color:var(--accent);margin-right:4px">filter</span>' :
                     '<span style="font-size:9px;padding:1px 4px;border-radius:3px;background:var(--bg-muted);color:var(--text-dim);margin-right:4px">sql</span>';
        d.innerHTML = '<div class="qlog-sql">' + srcTag + esc(q.sql_text) + '</div>' +
          '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">' +
          '<span class="qlog-meta">' + esc((q.ran_at || '').slice(0, 16)) + '<br>' + (q.row_count || 0) + ' rows</span>' +
          '<button class="qlog-copy" onclick="useQueryLog(' + JSON.stringify(q.sql_text) + ')">Use</button></div>';
        c.appendChild(d);
      });
    }).catch(function(e) {
      c.innerHTML = '<div style="padding:20px;text-align:center;font-size:11px;color:var(--danger)">Error loading log: ' + esc(e.message) + '</div>';
    });
}
function useQueryLog(sql) {
  var ed = document.getElementById('sql-editor');
  if (ed) { ed.value = sql; syncSqlLines(); }
  closeModal();
}
function clearQueryLog() {
  apiCall('clear_query_log')
    .then(function() { loadQueryLog(); toast('Query log cleared.'); })
    .catch(function(e) { toast(e.message, 'error'); });
}
function pickLogo() {
  apiCall('open_file_dialog_type', 'image')
    .then(function(path) { if (!path) return null; return apiCall('read_file_as_b64', path); })
    .then(function(b64) { if (!b64) return; setLogoPreview(b64); })
    .catch(function(e) { toast('Could not load logo: ' + e.message, 'error'); });
}
function setLogoPreview(b64) {
  var img  = document.getElementById('logo-img');
  var prev = document.getElementById('logo-preview');
  if (img)  img.src = 'data:image/png;base64,' + b64;
  if (prev) prev.classList.remove('hidden');
}
function clearLogo() {
  var img  = document.getElementById('logo-img');
  var prev = document.getElementById('logo-preview');
  if (img)  img.src = '';
  if (prev) prev.classList.add('hidden');
  apiCall('save_settings', { org_logo_b64: '' }).catch(function() {});
}

/* ── File import ────────────────────────────────────────────────────── */
function browseFile() {
  apiCall('open_file_dialog')
    .then(function(path) { if (path) setFile(path); })
    .catch(function(e) { toast('File picker error: ' + e.message, 'error'); });
}
function setFile(path) {
  _currentFile = path;
  var name = path.replace(/\\/g, '/').split('/').pop();
  var fn = document.getElementById('import-filename');
  if (fn) fn.textContent = name;
  var btn = document.getElementById('btn-import');
  if (btn) btn.disabled = false;
  setImportStatus('');
}
function handleDragOver(e) {
  e.preventDefault();
  var dz = document.getElementById('drop-zone');
  if (dz) dz.classList.add('drag-over');
}
function handleDragLeave() {
  var dz = document.getElementById('drop-zone');
  if (dz) dz.classList.remove('drag-over');
}
function handleDrop(e) {
  e.preventDefault();
  var dz = document.getElementById('drop-zone');
  if (dz) dz.classList.remove('drag-over');
  var files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length > 0) {
    var f = files[0];
    setFile(f.path || f.name);
  }
}
function startImport() {
  if (!_currentFile) return;
  showProgress(true);
  setImportStatus('Reading file…');
  apiCall('preview_import', _currentFile, 0)
    .then(function(data) {
      showProgress(false);
      _pendingPreview = data;
      openPreviewModal(data);
    })
    .catch(function(e) {
      showProgress(false);
      setImportStatus('⚠ ' + e.message);
      toast('Import error: ' + e.message, 'error');
    });
}

function openPreviewModal(data) {
  var fn = document.getElementById('prev-filename');
  if (fn) fn.textContent = data.filename;
  var st = document.getElementById('prev-stats');
  if (st) st.textContent = data.row_count.toLocaleString() + ' data rows · ' + data.columns.length + ' columns detected';
  var hr = document.getElementById('prev-header-row');
  if (hr) hr.value = 1;
  var autoName = data.filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  var tn = document.getElementById('prev-table-name');
  if (tn) tn.value = autoName;

  var tbody = document.getElementById('prev-cols-body');
  if (tbody) {
    tbody.innerHTML = '';
    data.columns.forEach(function(col, i) {
      var colors = { INTEGER: '#3b82f6', REAL: '#8b5cf6', DATE: '#10b981', TIME: '#f59e0b', TEXT: '#6b7280' };
      var color = colors[col.sql_type] || '#6b7280';
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="tbl-cell" style="color:var(--text-dim)">' + (i + 1) + '</td>' +
        '<td class="tbl-cell" style="font-weight:500">' + esc(col.raw_name) + '</td>' +
        '<td class="tbl-cell" style="font-family:monospace;font-size:10px">' + esc(col.sqlite_name) + '</td>' +
        '<td class="tbl-cell" style="text-align:center"><span style="background:' + color + ';color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;font-family:monospace;font-weight:600">' + col.sql_type + '</span></td>' +
        '<td class="tbl-cell" style="color:var(--text-dim);font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis">' + esc(col.samples.slice(0, 3).join(', ')) + '</td>';
      tbody.appendChild(tr);
    });
  }

  var head  = document.getElementById('prev-sample-head');
  var sbody = document.getElementById('prev-sample-body');
  if (head) head.innerHTML = '<tr>' + data.columns.map(function(c) { return '<th class="tbl-head">' + esc(c.raw_name) + '</th>'; }).join('') + '</tr>';
  if (sbody) {
    sbody.innerHTML = '';
    (data.sample_rows || []).slice(0, 5).forEach(function(row) {
      var tr = document.createElement('tr');
      tr.innerHTML = row.map(function(v) { return '<td class="tbl-cell" style="font-size:10px;color:var(--text-dim);max-width:80px;overflow:hidden;text-overflow:ellipsis">' + esc(String(v == null ? '' : v)) + '</td>'; }).join('');
      sbody.appendChild(tr);
    });
  }

  var warnEl = document.getElementById('prev-warnings');
  if (warnEl) {
    warnEl.textContent = (data.warnings || []).join(' | ');
    warnEl.classList.toggle('hidden', !(data.warnings && data.warnings.length));
  }

  var existing = _allSchemaData.map(function(t) { return t.table; });
  var tableName = autoName;
  var overwriteNotice = document.getElementById('prev-overwrite-notice');
  var mergBtn   = document.getElementById('prev-btn-merge');
  var overwBtn  = document.getElementById('prev-btn-overwrite');
  var importBtn = document.getElementById('prev-btn-import');
  var exists = existing.indexOf(tableName) !== -1;
  if (overwriteNotice) overwriteNotice.classList.toggle('hidden', !exists);
  if (mergBtn)   mergBtn.classList.toggle('hidden', !exists);
  if (overwBtn)  overwBtn.classList.toggle('hidden', !exists);
  if (importBtn) importBtn.classList.toggle('hidden', exists);
  openModal('modal-preview');
}

function rePreview() {
  if (!_currentFile) return;
  var headerRow = parseInt((document.getElementById('prev-header-row') || {}).value || '1');
  showProgress(true);
  apiCall('preview_import', _currentFile, headerRow - 1)
    .then(function(data) {
      showProgress(false);
      _pendingPreview = data;
      openPreviewModal(data);
    })
    .catch(function(e) { showProgress(false); toast('Preview error: ' + e.message, 'error'); });
}

function confirmImport(overwrite) {
  if (!_pendingPreview) return;
  var headerRow  = parseInt((document.getElementById('prev-header-row') || {}).value || '1');
  var customName = ((document.getElementById('prev-table-name') || {}).value || '').trim();
  closeModal();
  showProgress(true);
  setImportStatus('Importing…');
  apiCall('confirm_import', overwrite, customName, headerRow - 1)
    .then(function(d) {
      showProgress(false);
      setImportStatus('✓ ' + d.inserted.toLocaleString() + ' rows → ' + d.table_name);
      toast('Imported ' + d.inserted.toLocaleString() + ' rows into "' + d.table_name + '".');
      _pendingPreview = null;
      var ri = document.getElementById('btn-reimport');
      if (ri) ri.classList.remove('hidden');
      refreshSchema(d.table_name);
    })
    .catch(function(e) {
      showProgress(false);
      setImportStatus('⚠ ' + e.message);
      toast('Import failed: ' + e.message, 'error');
    });
}

/* ── Schema ─────────────────────────────────────────────────────────── */
function refreshSchema(selectTable) {
  apiCall('get_schema')
    .then(function(schema) {
      _allSchemaData = schema || [];
      var sel  = document.getElementById('table-select');
      var prev = sel ? sel.value : '';
      if (sel) sel.innerHTML = '';

      if (_allSchemaData.length === 0) {
        if (sel) sel.innerHTML = '<option value="">— no tables yet —</option>';
        var btd = document.getElementById('btn-drop-table');
        if (btd) btd.classList.add('hidden');
        var atb = document.getElementById('active-table-badge');
        if (atb) atb.classList.add('hidden');
        var feh = document.getElementById('filter-empty-hint');
        if (feh) feh.classList.remove('hidden');
        renderSchemaTree([]);
        return;
      }

      _allSchemaData.forEach(function(t) {
        var opt = document.createElement('option');
        opt.value = t.table;
        opt.textContent = t.table + '  (' + t.columns.filter(function(c) { return !c.name.startsWith('_'); }).length + ' cols)';
        if (sel) sel.appendChild(opt);
      });

      var target = selectTable || prev;
      var found  = _allSchemaData.find(function(t) { return t.table === target; });
      if (sel) sel.value = found ? target : _allSchemaData[0].table;
      onTableChange();
      renderSchemaTree(_allSchemaData);
    })
    .catch(function(e) { console.error('refreshSchema error:', e); });
}

function onTableChange() {
  var sel = document.getElementById('table-select');
  var val = sel ? sel.value : '';

  if (val === 'JOIN_MODE') return;

  var joinBar = document.getElementById('join-bar');
  if (joinBar && !joinBar.classList.contains('hidden')) {
    exitJoinMode();
  }

  _activeTable = val;

  var btd = document.getElementById('btn-drop-table');
  var atb = document.getElementById('active-table-badge');
  var atn = document.getElementById('active-table-name');
  var feh = document.getElementById('filter-empty-hint');

  if (!_activeTable) {
    _tableColumns = [];
    if (btd) btd.classList.add('hidden');
    if (atb) atb.classList.add('hidden');
    if (feh) feh.classList.remove('hidden');
    return;
  }

  if (atn) atn.textContent = _activeTable;
  if (atb) atb.classList.remove('hidden');
  if (btd) btd.classList.remove('hidden');
  if (feh) feh.classList.add('hidden');

  apiCall('get_table_columns', _activeTable)
    .then(function(cols) {
      _tableColumns = cols;
      _selectedTables = [_activeTable];
      rebuildSortDropdown();
      buildAggDropdowns();
      clearFilterGroups();
    })
    .catch(function(e) { console.error('get_table_columns error:', e); });
}

function rebuildSortDropdown() {
  var sortSel = document.getElementById('sort-col');
  if (!sortSel) return;
  sortSel.innerHTML = '<option value="">— none —</option>';
  _tableColumns.forEach(function(c) {
    sortSel.appendChild(new Option(c.name, c.name));
  });

  // Show column search bar in filter panel when there are many columns
  var searchBar = document.getElementById('col-filter-search-bar');
  if (searchBar) {
    searchBar.classList.toggle('hidden', _tableColumns.length <= 15);
  }
}

/* ── Column search for filter dropdowns ─────────────────────────────── */
/* Filters the field <select> inside every open condition row and aggregate/sort selects */
function filterColumnDropdowns(term) {
  term = (term || '').toLowerCase();
  
  // Find all condition field selects, plus the select/groupby/sort selects
  var selects = Array.prototype.slice.call(document.querySelectorAll('[id^="ff-"]'));
  var selectAdd = document.getElementById('select-add');
  var groupbyAdd = document.getElementById('groupby-add');
  var sortCol = document.getElementById('sort-col');
  
  if (selectAdd) selects.push(selectAdd);
  if (groupbyAdd) selects.push(groupbyAdd);
  if (sortCol) selects.push(sortCol);

  selects.forEach(function(sel) {
    Array.prototype.forEach.call(sel.options, function(opt) {
      if (!opt.value) return; // skip placeholder
      opt.style.display = (!term || opt.text.toLowerCase().indexOf(term) !== -1) ? '' : 'none';
    });
    // If current value is hidden, pick first visible
    var cur = sel.value;
    if (cur) {
      var curOpt = sel.querySelector('option[value="' + cur.replace(/"/g, '\\"') + '"]');
      if (curOpt && curOpt.style.display === 'none') {
        var first = sel.querySelector('option:not([style*="none"]):not([value=""])');
        if (first) { sel.value = first.value; sel.dispatchEvent(new Event('change')); }
      }
    }
  });
}



/* ── Schema tree render ─────────────────────────────────────────────── */
function renderSchemaTree(schema) {
  var el = document.getElementById('schema-tree');
  var cr = document.getElementById('cr-schema-ref');
  if (!el) return;
  if (!schema || schema.length === 0) {
    var empty = '<div style="color:var(--text-dim);text-align:center;padding:32px 8px;font-size:11px">Import a file to see schema</div>';
    el.innerHTML = empty;
    if (cr) cr.innerHTML = empty;
    return;
  }
  var html = '';
  schema.forEach(function(t) {
    var userCols = t.columns.filter(function(c) { return !c.name.startsWith('_'); });
    var colNames = userCols.map(function(c) { return '"' + c.name + '"'; }).join(', ');
    var sampleSql = 'SELECT ' + colNames + '\nFROM "' + t.table + '"\nLIMIT 100';
    html += '<div class="schema-table" style="margin-bottom:10px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 8px;background:var(--bg-muted);border-radius:4px 4px 0 0;border:1px solid var(--border);border-bottom:0">' +
      '<span style="font-weight:600;font-size:11px;color:var(--text-head);font-family:monospace">📋 ' + esc(t.table) + '</span>' +
      '<span style="font-size:10px;color:var(--text-dim)">' + userCols.length + ' cols</span></div>' +
      '<div style="border:1px solid var(--border);border-radius:0 0 4px 4px;overflow:hidden">';
    userCols.forEach(function(c) {
      var colors = { INTEGER: '#3b82f6', REAL: '#8b5cf6', DATE: '#10b981', TIME: '#f59e0b', TEXT: '#6b7280' };
      var color  = colors[c.type] || '#6b7280';
      html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 8px;border-bottom:1px solid var(--border-light);cursor:pointer;transition:background 80ms" ' +
        'onmouseover="this.style.background=\'var(--bg-muted)\'" onmouseout="this.style.background=\'\'" ' +
        'onclick="showColStats(' + JSON.stringify(t.table) + ',' + JSON.stringify(c.name) + ')" title="Click for column stats">' +
        '<span style="font-family:monospace;font-size:10px;color:var(--text-body)">' + esc(c.name) + '</span>' +
        '<span style="background:' + color + ';color:#fff;font-size:9px;font-family:monospace;font-weight:600;padding:0 4px;border-radius:2px">' + c.type + '</span></div>';
    });
    html += '</div>';
    html += '<div style="margin-top:2px;padding:0 2px"><button style="width:100%;text-align:left;font-size:9px;font-family:monospace;color:var(--text-dim);background:var(--bg-muted);border:1px solid var(--border);border-radius:3px;padding:3px 6px;cursor:pointer;line-height:1.4;transition:background 100ms" onclick="copySql(' + JSON.stringify(sampleSql) + ')" title="Click to copy SELECT template">' + esc(sampleSql.replace(/\n/g, ' ')) + '</button></div></div>';
  });
  el.innerHTML = html;
  if (cr) cr.innerHTML = html;
}

function copySql(sql) {
  var ta = document.createElement('textarea');
  ta.value = sql; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  var ed = document.getElementById('sql-editor');
  if (ed) { ed.value = sql; syncSqlLines(); }
  toast('SQL copied to editor.');
}

/* ── Copy Schema Text ────────────────────────────────────────────────── */
function copySchemaText() {
  if (!_allSchemaData.length) { toast('No tables imported yet.', 'warn'); return; }
  var lines = ['# Database Schema — Querii\n'];
  _allSchemaData.forEach(function(t) {
    var userCols = t.columns.filter(function(c) { return !c.name.startsWith('_'); });
    lines.push('## Table: ' + t.table);
    userCols.forEach(function(c) {
      lines.push('  - ' + c.name + '  (' + c.type + ')');
    });
    lines.push('');
  });
  var text = lines.join('\n');
  var ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  toast('Schema copied to clipboard! Paste it into ChatGPT or any AI to get custom queries.');
}

/* ── Column Stats ────────────────────────────────────────────────────── */
function showColStats(tableName, colName) {
  _csCurrentTable = tableName;
  _csCurrentCol   = colName;
  document.getElementById('colstats-name').textContent = colName;
  ['cs-total','cs-distinct','cs-null','cs-min','cs-max'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.textContent = '…';
  });
  var sEl = document.getElementById('cs-samples');
  if (sEl) sEl.innerHTML = '';
  openModal('modal-colstats');

  apiCall('get_column_stats', tableName, colName)
    .then(function(d) {
      var set = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = (v == null ? '—' : String(v)); };
      set('cs-total',    d.count_total);
      set('cs-distinct', d.count_distinct);
      set('cs-null',     d.count_null);
      set('cs-min',      d.min_val);
      set('cs-max',      d.max_val);
      var sEl = document.getElementById('cs-samples');
      if (sEl) {
        sEl.innerHTML = (d.sample_values || []).map(function(v) {
          return '<span style="background:var(--bg-muted);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-family:monospace;font-size:10px;cursor:pointer" ' +
            'onclick="addStatsValueToFilter(' + JSON.stringify(String(v)) + ')" title="Click to use in filter">' + esc(String(v)) + '</span>';
        }).join('');
      }
    })
    .catch(function(e) { toast('Stats error: ' + e.message, 'error'); });
}

var _statsFilterValue = '';
function addStatsValueToFilter(val) {
  _statsFilterValue = val;
  toast('Value "' + val + '" ready — click "Add to Filter" to use it.');
}
function addFilterFromStats() {
  closeModal();
  if (_tableColumns.length === 0) { toast('No table selected.', 'warn'); return; }
  addFilterGroup();
  // After group is added, inject value into last condition
  setTimeout(function() {
    var rows = document.querySelectorAll('[id^="fi-"]');
    if (rows.length === 0) return;
    var lastRow = rows[rows.length - 1];
    var fid = lastRow.id.replace('fi-', '');
    // Try to find the field select and set to our column
    var fieldSel = document.getElementById('ff-' + fid);
    if (fieldSel) {
      fieldSel.value = _csCurrentCol;
      updateFilterOps(_csCurrentCol.split('.').pop(), fid);
    }
    var valInp = document.getElementById('fv1-' + fid);
    if (valInp) valInp.value = _statsFilterValue;
  }, 100);
}

/* ── Right panel tabs ───────────────────────────────────────────────── */
function switchRightTab(tab) {
  ['schema', 'reports'].forEach(function(t) {
    var btn = document.getElementById('rt-' + t);
    var pnl = document.getElementById('right-tab-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
    if (pnl) pnl.classList.toggle('hidden', t !== tab);
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   FILTER GROUP BUILDER  (v2 — nested groups with unlimited depth)
   ═══════════════════════════════════════════════════════════════════════ */

function clearFilterGroups() {
  _filterGroups = [];
  _groupCounter = 0;
  _itemCounter  = 0;
  var el = document.getElementById('filter-groups');
  if (el) el.innerHTML = '';
  var feh = document.getElementById('filter-empty-hint');
  if (_activeTable) {
    if (feh) feh.classList.add('hidden');
  } else {
    if (feh) feh.classList.remove('hidden');
  }
}

/* Add a TOP-LEVEL group */
function addFilterGroup() {
  if (_tableColumns.length === 0) { toast('Select a table first.', 'warn'); return; }
  _groupCounter++;
  var gid = 'g' + _groupCounter;
  var group = { id: gid, joiner: 'OR', _type: 'group', items: [] };
  _filterGroups.push(group);
  renderFilterGroups();
  // Auto-add one condition to the new group
  addConditionToGroup(gid);
}

/* Add a FLAT CONDITION to the top (no group) — shortcut */
function addTopLevelCondition() {
  if (_tableColumns.length === 0) { toast('Select a table first.', 'warn'); return; }
  // If no groups exist, create one to hold it
  if (_filterGroups.length === 0) {
    _groupCounter++;
    var gid = 'g' + _groupCounter;
    _filterGroups.push({ id: gid, joiner: 'AND', _type: 'group', items: [] });
  }
  addConditionToGroup(_filterGroups[_filterGroups.length - 1].id);
}

/* Add a CONDITION to an existing group */
function addConditionToGroup(gid) {
  var group = findGroup(_filterGroups, gid);
  if (!group) return;
  _itemCounter++;
  var iid = 'i' + _itemCounter;
  var col = _tableColumns[0];
  group.items.push({
    _type: 'condition',
    id: iid,
    gid: gid,
    joiner: group.items.length === 0 ? '' : 'AND',
    field: col ? col.name : '',
    operator: col ? col.operators[0] : 'equals',
    value: '', value2: '',
    category: col ? col.category : 'text',
    table_prefix: (_selectedTables.length > 1) ? _activeTable + '.' : '',
  });
  renderFilterGroups();
}

/* Add a NESTED GROUP inside an existing group */
function addNestedGroup(gid) {
  var parentGroup = findGroup(_filterGroups, gid);
  if (!parentGroup) return;
  _groupCounter++;
  var ngid = 'g' + _groupCounter;
  var nestedGroup = { _type: 'group', id: ngid, joiner: parentGroup.items.length === 0 ? '' : 'OR', items: [] };
  parentGroup.items.push(nestedGroup);
  renderFilterGroups();
  addConditionToGroup(ngid);
}

/* Find a group anywhere in the tree */
function findGroup(groups, gid) {
  for (var i = 0; i < groups.length; i++) {
    if (groups[i].id === gid) return groups[i];
    if (groups[i]._type === 'group') {
      var found = findGroupInItems(groups[i].items, gid);
      if (found) return found;
    }
  }
  return null;
}
function findGroupInItems(items, gid) {
  for (var i = 0; i < items.length; i++) {
    if (items[i]._type === 'group') {
      if (items[i].id === gid) return items[i];
      var found = findGroupInItems(items[i].items, gid);
      if (found) return found;
    }
  }
  return null;
}

/* Remove a top-level group */
function removeTopGroup(gid) {
  _filterGroups = _filterGroups.filter(function(g) { return g.id !== gid; });
  renderFilterGroups();
}

/* Remove any item (condition or nested group) from its parent group */
function removeGroupItem(gid, iid) {
  var group = findGroup(_filterGroups, gid);
  if (!group) return;
  group.items = group.items.filter(function(it) { return it.id !== iid; });
  if (group.items.length === 0) {
    // Auto-remove empty groups unless it's the only one
    if (_filterGroups.length > 1 || findGroup(_filterGroups, gid) !== _filterGroups[0]) {
      _filterGroups = _filterGroups.filter(function(g) { return g.id !== gid; });
    }
  }
  renderFilterGroups();
}

/* Toggle joiner of top-level group */
function toggleGroupJoiner(gid) {
  var group = findGroup(_filterGroups, gid);
  if (!group) return;
  group.joiner = group.joiner === 'AND' ? 'OR' : 'AND';
  renderFilterGroups();
}
/* Toggle joiner of any item */
function toggleItemJoiner(parentGid, iid) {
  var group = findGroup(_filterGroups, parentGid);
  if (!group) return;
  var item = group.items.find(function(it) { return it.id === iid; });
  if (!item) return;
  item.joiner = item.joiner === 'AND' ? 'OR' : 'AND';
  renderFilterGroups();
}

/* ── Render the full filter tree ─────────────────────────────────── */
function renderFilterGroups() {
  var container = document.getElementById('filter-groups');
  if (!container) return;
  container.innerHTML = '';

  _filterGroups.forEach(function(group, gi) {
    container.appendChild(buildGroupEl(group, gi, true, null));
  });

  // Re-read DOM values into state
  syncFilterState();
}

function buildGroupEl(group, gi, isTopLevel, parentGid) {
  var wrapper = document.createElement('div');
  wrapper.className = 'filter-group-box';
  wrapper.id = 'fgbox-' + group.id;

  // Group header
  var header = document.createElement('div');
  header.className = 'filter-group-header';

  var leftSide = document.createElement('div');
  leftSide.style.cssText = 'display:flex;align-items:center;gap:4px;flex:1;min-width:0';

  // Joiner pill (shown for non-first groups / nested)
  if (gi > 0 || !isTopLevel) {
    var joinPill = document.createElement('button');
    joinPill.className = 'joiner-pill' + (group.joiner === 'AND' ? ' active' : '');
    joinPill.textContent = group.joiner || 'OR';
    joinPill.title = 'Click to toggle AND/OR';
    if (isTopLevel) {
      joinPill.onclick = (function(gid) { return function() { toggleGroupJoiner(gid); }; })(group.id);
    } else {
      joinPill.onclick = (function(pgid, iid) { return function() { toggleItemJoiner(pgid, iid); }; })(parentGid, group.id);
    }
    leftSide.appendChild(joinPill);
  }

  var groupLabel = document.createElement('span');
  groupLabel.style.cssText = 'font-size:10px;font-weight:600;color:var(--text-dim);letter-spacing:.04em';
  groupLabel.textContent = 'GROUP';
  leftSide.appendChild(groupLabel);

  var rightSide = document.createElement('div');
  rightSide.style.cssText = 'display:flex;align-items:center;gap:4px;shrink:0';

  // + Condition button
  var addCondBtn = document.createElement('button');
  addCondBtn.style.cssText = 'font-size:10px;color:var(--accent);background:none;border:none;cursor:pointer;padding:0 2px;white-space:nowrap';
  addCondBtn.textContent = '+ Condition';
  addCondBtn.onclick = (function(gid) { return function(e) { e.stopPropagation(); addConditionToGroup(gid); }; })(group.id);
  rightSide.appendChild(addCondBtn);

  // + Sub-group button
  var addSubBtn = document.createElement('button');
  addSubBtn.style.cssText = 'font-size:10px;color:#8b5cf6;background:none;border:none;cursor:pointer;padding:0 2px;white-space:nowrap';
  addSubBtn.textContent = '⊞ Sub-group';
  addSubBtn.onclick = (function(gid) { return function(e) { e.stopPropagation(); addNestedGroup(gid); }; })(group.id);
  rightSide.appendChild(addSubBtn);

  // Remove group button
  var removeBtn = document.createElement('button');
  removeBtn.style.cssText = 'font-size:11px;color:var(--danger);background:none;border:none;cursor:pointer;padding:0 2px;margin-left:2px';
  removeBtn.textContent = '✕';
  removeBtn.title = 'Remove group';
  if (isTopLevel) {
    removeBtn.onclick = (function(gid) { return function(e) { e.stopPropagation(); removeTopGroup(gid); }; })(group.id);
  } else {
    removeBtn.onclick = (function(pgid, iid) { return function(e) { e.stopPropagation(); removeGroupItem(pgid, iid); }; })(parentGid, group.id);
  }
  rightSide.appendChild(removeBtn);

  header.appendChild(leftSide);
  header.appendChild(rightSide);
  wrapper.appendChild(header);

  // Items container
  var itemsEl = document.createElement('div');
  itemsEl.className = 'filter-group-items';

  group.items.forEach(function(item, ii) {
    if (item._type === 'group') {
      itemsEl.appendChild(buildGroupEl(item, ii, false, group.id));
    } else {
      itemsEl.appendChild(buildConditionEl(item, ii, group.id));
    }
  });

  wrapper.appendChild(itemsEl);
  return wrapper;
}

function buildConditionEl(cond, ci, gid) {
  var row = document.createElement('div');
  row.className = 'filter-row-v2';
  row.id = 'fi-' + cond.id;

  var html = '';

  // Joiner pill (AND/OR) — only for non-first items
  if (ci > 0) {
    html += '<button class="joiner-pill' + (cond.joiner === 'AND' ? ' active' : '') + '" ' +
      'onclick="toggleItemJoiner(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ')" ' +
      'title="Toggle AND / OR" style="align-self:flex-start;margin-top:2px">' + (cond.joiner || 'AND') + '</button>';
  }

  // Field select
  var fieldOpts = _tableColumns.map(function(c) {
    var label = (_selectedTables.length > 1) ? _activeTable + '.' + c.name : c.name;
    var val   = (_selectedTables.length > 1) ? _activeTable + '.' + c.name : c.name;
    return '<option value="' + esc(val) + '"' + (val === cond.field ? ' selected' : '') + '>' + esc(label) + '</option>';
  }).join('');

  html += '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">';
  html += '<select class="select-sm" style="font-family:monospace;font-size:11px" id="ff-' + cond.id + '" ' +
    'onchange="onCondFieldChange(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ',this.value)">' + fieldOpts + '</select>';

  // Op select (populated by updateFilterOps)
  html += '<div style="display:flex;gap:3px">';
  html += '<select class="select-sm" style="flex:1" id="fo-' + cond.id + '" ' +
    'onchange="onCondOpChange(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ',this.value)"></select>';
  html += '</div>';
  html += '<div id="fv-' + cond.id + '" style="margin-top:2px"></div>';
  html += '</div>';

  // Remove
  html += '<button onclick="removeGroupItem(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ')" ' +
    'style="font-size:11px;color:var(--danger);background:none;border:none;cursor:pointer;padding:0 2px;align-self:flex-start;margin-top:2px">✕</button>';

  row.innerHTML = html;

  // Populate ops after inserting into DOM
  setTimeout(function() {
    populateCondOps(cond, gid);
  }, 0);

  return row;
}

function populateCondOps(cond, gid) {
  var opSel = document.getElementById('fo-' + cond.id);
  if (!opSel) return;
  var col = getColByField(cond.field);
  if (!col) return;
  opSel.innerHTML = col.operators.map(function(op) {
    return '<option value="' + esc(op) + '"' + (op === cond.operator ? ' selected' : '') + '>' + esc(op) + '</option>';
  }).join('');
  renderCondValue(cond, gid);
}

function renderCondValue(cond, gid) {
  var vDiv = document.getElementById('fv-' + cond.id);
  if (!vDiv) return;
  var op  = cond.operator;
  var cat = cond.category;

  if (op === 'is empty' || op === 'is not empty') { vDiv.innerHTML = ''; return; }
  var changeAttr = 'onchange="onCondValueChange(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ',\'val1\',this.value)" ' +
                   'oninput="onCondValueChange(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ',\'val1\',this.value)"';
  var changeAttr2 = 'onchange="onCondValueChange(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ',\'val2\',this.value)"';

  if (op === 'between') {
    vDiv.innerHTML = '<input id="fv1-' + cond.id + '" class="input-sm" style="width:100%;margin-bottom:2px" placeholder="From…" value="' + esc(cond.value) + '" ' + changeAttr + '>' +
                     '<input id="fv2-' + cond.id + '" class="input-sm" style="width:100%" placeholder="To…" value="' + esc(cond.value2) + '" ' + changeAttr2 + '>';
    return;
  }
  var type = cat === 'date' ? 'date' : cat === 'time' ? 'time' : cat === 'number' ? 'number' : 'text';
  var ph   = cat === 'date' ? '' : cat === 'time' ? '' : 'Value…';
  vDiv.innerHTML = '<input id="fv1-' + cond.id + '" type="' + type + '" class="input-sm" style="width:100%" placeholder="' + ph + '" value="' + esc(cond.value) + '" ' + changeAttr + '>';
}

function getColByField(field) {
  var bare = field.indexOf('.') !== -1 ? field.split('.').pop() : field;
  for (var i = 0; i < _tableColumns.length; i++) {
    if (_tableColumns[i].name === bare) return _tableColumns[i];
  }
  return null;
}

/* Sync from DOM state back to _filterGroups data model */
function syncFilterState() {
  _filterGroups.forEach(function(g) { syncGroupState(g); });
}
function syncGroupState(group) {
  group.items.forEach(function(item) {
    if (item._type === 'group') {
      syncGroupState(item);
    } else {
      var ff = document.getElementById('ff-' + item.id);
      var fo = document.getElementById('fo-' + item.id);
      var fv1 = document.getElementById('fv1-' + item.id);
      var fv2 = document.getElementById('fv2-' + item.id);
      if (ff)  item.field    = ff.value;
      if (fo)  item.operator = fo.value;
      if (fv1) item.value    = fv1.value;
      if (fv2) item.value2   = fv2.value;
      var col = getColByField(item.field);
      if (col) item.category = col.category;
    }
  });
}

/* React to field change */
function onCondFieldChange(gid, iid, fieldVal) {
  var group = findGroup(_filterGroups, gid);
  if (!group) return;
  var cond = group.items.find(function(it) { return it.id === iid; });
  if (!cond) return;
  cond.field = fieldVal;
  var col = getColByField(fieldVal);
  if (col) {
    cond.category = col.category;
    cond.operator = col.operators[0];
    cond.value    = '';
    cond.value2   = '';
    var opSel = document.getElementById('fo-' + iid);
    if (opSel) opSel.innerHTML = col.operators.map(function(op) {
      return '<option value="' + esc(op) + '">' + esc(op) + '</option>';
    }).join('');
    renderCondValue(cond, gid);
  }
}
function updateFilterOps(fieldName, iid) {
  var col = _tableColumns.find(function(c) { return c.name === fieldName; });
  if (!col) return;
  var opSel = document.getElementById('fo-' + iid);
  if (opSel) opSel.innerHTML = col.operators.map(function(op) {
    return '<option value="' + esc(op) + '">' + esc(op) + '</option>';
  }).join('');
}
function onCondOpChange(gid, iid, opVal) {
  var group = findGroup(_filterGroups, gid);
  if (!group) return;
  var cond = group.items.find(function(it) { return it.id === iid; });
  if (!cond) return;
  cond.operator = opVal;
  cond.value = ''; cond.value2 = '';
  renderCondValue(cond, gid);
}
function onCondValueChange(gid, iid, which, val) {
  var group = findGroup(_filterGroups, gid);
  if (!group) return;
  var cond = group.items.find(function(it) { return it.id === iid; });
  if (!cond) return;
  if (which === 'val1') cond.value  = val;
  else                  cond.value2 = val;
}

/* Build the wire format to send to Python */
function serializeFilterGroups(groups) {
  return groups.map(function(g) { return serializeGroupItem(g); });
}
function serializeGroupItem(item) {
  if (item._type === 'group') {
    return {
      _type:  'group',
      id:     item.id,
      joiner: item.joiner || 'OR',
      items:  item.items.map(function(it) { return serializeGroupItem(it); }),
    };
  }
  return {
    _type:        'condition',
    field:        item.field.indexOf('.') !== -1 ? item.field.split('.').pop() : item.field,
    operator:     item.operator,
    value:        item.value,
    value2:       item.value2,
    joiner:       item.joiner || 'AND',
    category:     item.category,
    table_prefix: item.table_prefix || '',
  };
}

/* ── Aggregate builder ──────────────────────────────────────────────── */
function buildAggDropdowns() {
  var selectAdd  = document.getElementById('select-add');
  var groupbyAdd = document.getElementById('groupby-add');
  if (!selectAdd || !groupbyAdd) return;
  selectAdd.innerHTML  = '<option value="">+ Add column or aggregate…</option>';
  groupbyAdd.innerHTML = '<option value="">+ Add group field…</option>';
  _tableColumns.forEach(function(c) {
    selectAdd.appendChild(new Option(c.name, JSON.stringify({ expr: '"' + c.name + '"', label: c.name, agg: false })));
    groupbyAdd.appendChild(new Option(c.name, JSON.stringify({ expr: '"' + c.name + '"', label: c.name })));
  });
  var grp = document.createElement('optgroup');
  grp.label = 'Aggregates';
  selectAdd.appendChild(grp);
  ['COUNT(*)', 'SUM', 'AVG', 'MIN', 'MAX'].forEach(function(fn) {
    if (fn === 'COUNT(*)') {
      grp.appendChild(new Option('COUNT(*)', JSON.stringify({ expr: 'COUNT(*)', label: 'COUNT(*)', agg: true })));
    } else {
      _tableColumns.forEach(function(c) {
        var expr  = fn + '("' + c.name + '")';
        var label = fn + '(' + c.name + ')';
        grp.appendChild(new Option(label, JSON.stringify({ expr: expr, label: label, agg: true })));
      });
    }
  });
}
function addSelectField(sel) {
  if (!sel.value) return;
  var d = JSON.parse(sel.value);
  _selectPills.push({ expr: d.expr, label: d.label, agg: !!d.agg });
  renderSelectPills();
  sel.value = '';
}
function addGroupByField(sel) {
  if (!sel.value) return;
  var d = JSON.parse(sel.value);
  _groupByPills.push({ expr: d.expr, label: d.label });
  renderGroupByPills();
  sel.value = '';
}
function renderSelectPills() {
  var el = document.getElementById('select-pills');
  if (!el) return;
  el.innerHTML = _selectPills.map(function(p, i) {
    return '<span class="pill ' + (p.agg ? 'pill-agg' : '') + '">' + esc(p.label) +
      '<button onclick="removeSelectPill(' + i + ')" style="margin-left:3px;opacity:.6;background:none;border:none;cursor:pointer;font-size:11px">✕</button></span>';
  }).join('');
}
function renderGroupByPills() {
  var el = document.getElementById('groupby-pills');
  if (!el) return;
  el.innerHTML = _groupByPills.map(function(p, i) {
    return '<span class="pill">' + esc(p.label) +
      '<button onclick="removeGroupByPill(' + i + ')" style="margin-left:3px;opacity:.6;background:none;border:none;cursor:pointer;font-size:11px">✕</button></span>';
  }).join('');
}
function removeSelectPill(i)  { _selectPills.splice(i, 1);  renderSelectPills(); }
function removeGroupByPill(i) { _groupByPills.splice(i, 1); renderGroupByPills(); }
function clearHaving() {
  var a = document.getElementById('having-agg'); if (a) a.value = '';
  var v = document.getElementById('having-val'); if (v) v.value = '';
}
function toggleAggSection() {
  var sec  = document.getElementById('agg-section');
  var icon = document.getElementById('agg-toggle-icon');
  if (!sec) return;
  var hidden = sec.classList.toggle('hidden');
  if (icon) icon.textContent = hidden ? '▶' : '▼';
}

/* ── Run filter ─────────────────────────────────────────────────────── */
function runFilter() {
  if (!_activeTable) { toast('Select a table first.', 'warn'); return; }
  syncFilterState();
  var groupsPayload = serializeFilterGroups(_filterGroups);
  var sortCol   = (document.getElementById('sort-col') || {}).value || '';
  var sortDir   = (document.getElementById('sort-dir') || {}).value || 'ASC';
  var limit     = parseInt((document.getElementById('result-limit') || {}).value || '5000', 10);
  var selExprs  = _selectPills.map(function(p) { return p.expr; });
  var selLabels = _selectPills.map(function(p) { return p.label; });
  var grpExprs  = _groupByPills.map(function(p) { return p.expr; });
  var havingAgg = ((document.getElementById('having-agg') || {}).value || '').trim();
  var havingOp  = (document.getElementById('having-op') || {}).value || '>';
  var havingVal = ((document.getElementById('having-val') || {}).value || '').trim();
  var having    = (havingAgg && havingVal) ? havingAgg + ' ' + havingOp + ' ' + havingVal : '';

  setSqlStatus('Running…');
  apiCall('run_filter',
    _activeTable,
    JSON.stringify(groupsPayload),
    sortCol, sortDir, limit,
    JSON.stringify(selExprs),
    JSON.stringify(selLabels),
    JSON.stringify(grpExprs),
    having,
    JSON.stringify(_selectedTables.filter(function(t) { return t !== _activeTable; })),
    JSON.stringify(_joinClauses.map(function(jc) { return jc.clause; }))
  ).then(function(d) {
    var ed = document.getElementById('sql-editor');
    if (ed && d.sql) { ed.value = d.sql; syncSqlLines(); }
    setSqlStatus((d.count || 0).toLocaleString() + ' rows');
    renderResults(d.columns || [], d.rows || [], d.count || 0);
  }).catch(function(e) { setSqlStatus('⚠ ' + e.message); toast(e.message, 'error'); });
}

function clearFilter() {
  clearFilterGroups();
  _selectPills  = [];
  _groupByPills = [];
  renderSelectPills();
  renderGroupByPills();
  clearHaving();
  var ed = document.getElementById('sql-editor');
  if (ed) ed.value = '';
  syncSqlLines();
  setSqlStatus('');
}

/* ── Raw SQL ────────────────────────────────────────────────────────── */
function runSql() {
  var sql = (document.getElementById('sql-editor') || {}).value;
  if (!sql || !sql.trim()) return;
  setSqlStatus('Running…');
  apiCall('run_sql', sql.trim())
    .then(function(d) {
      setSqlStatus((d.count || 0).toLocaleString() + ' rows');
      renderResults(d.columns || [], d.rows || [], d.count || 0);
    })
    .catch(function(e) { setSqlStatus('⚠ ' + e.message); toast(e.message, 'error'); });
}
function clearSql() {
  var ed = document.getElementById('sql-editor');
  if (ed) ed.value = '';
  syncSqlLines();
  setSqlStatus('');
}

/* ── SQL Explainer ──────────────────────────────────────────────────── */
function explainSql() {
  var sql = ((document.getElementById('sql-editor') || {}).value || '').trim();
  if (!sql) { toast('Write or generate a SQL query first.', 'warn'); return; }
  var explanation = generateExplanation(sql);
  var panel = document.getElementById('explainer-panel');
  var content = document.getElementById('explainer-content');
  if (content) content.innerHTML = explanation;
  if (panel) panel.classList.remove('hidden');
}
function closeExplainer() {
  var panel = document.getElementById('explainer-panel');
  if (panel) panel.classList.add('hidden');
}

function generateExplanation(sql) {
  var s = sql.replace(/\s+/g, ' ').trim();
  var parts = [];

  // SELECT
  var selMatch = s.match(/SELECT\s+([\s\S]+?)\s+FROM/i);
  if (selMatch) {
    var cols = selMatch[1].trim();
    if (cols === '*') {
      parts.push('📋 <strong>Selects all columns</strong> from the table.');
    } else {
      parts.push('📋 <strong>Selects:</strong> <code style="font-family:monospace;font-size:10px;background:var(--bg-muted);padding:1px 4px;border-radius:3px">' + esc(cols) + '</code>');
    }
  }

  // FROM
  var fromMatch = s.match(/FROM\s+["']?([\w.]+)["']?/i);
  if (fromMatch) {
    parts.push('🗂 <strong>From table:</strong> <code style="font-family:monospace;font-size:10px;background:var(--bg-muted);padding:1px 4px;border-radius:3px">' + esc(fromMatch[1]) + '</code>');
  }

  // JOIN
  var joinMatches = s.match(/(?:LEFT |INNER |RIGHT )?JOIN\s+["']?([\w]+)["']?\s+ON\s+([^WHERE^GROUP^ORDER^HAVING^LIMIT]+)/gi);
  if (joinMatches) {
    joinMatches.forEach(function(j) {
      parts.push('🔗 <strong>Joined with:</strong> <code style="font-family:monospace;font-size:10px;background:var(--bg-muted);padding:1px 4px;border-radius:3px">' + esc(j.trim()) + '</code>');
    });
  }

  // WHERE
  var whereMatch = s.match(/WHERE\s+([\s\S]+?)(?:\s+GROUP BY|\s+ORDER BY|\s+HAVING|\s+LIMIT|$)/i);
  if (whereMatch) {
    parts.push('🔍 <strong>Filters rows where:</strong> <code style="font-family:monospace;font-size:10px;background:var(--bg-muted);padding:1px 4px;border-radius:3px">' + esc(whereMatch[1].trim()) + '</code>');
  }

  // GROUP BY
  var groupMatch = s.match(/GROUP BY\s+([\s\S]+?)(?:\s+HAVING|\s+ORDER BY|\s+LIMIT|$)/i);
  if (groupMatch) {
    parts.push('📦 <strong>Groups results by:</strong> <code style="font-family:monospace;font-size:10px;background:var(--bg-muted);padding:1px 4px;border-radius:3px">' + esc(groupMatch[1].trim()) + '</code>');
  }

  // HAVING
  var havingMatch = s.match(/HAVING\s+([\s\S]+?)(?:\s+ORDER BY|\s+LIMIT|$)/i);
  if (havingMatch) {
    parts.push('🔢 <strong>Having (filters groups):</strong> <code style="font-family:monospace;font-size:10px;background:var(--bg-muted);padding:1px 4px;border-radius:3px">' + esc(havingMatch[1].trim()) + '</code>');
  }

  // ORDER BY
  var orderMatch = s.match(/ORDER BY\s+([\s\S]+?)(?:\s+LIMIT|$)/i);
  if (orderMatch) {
    var dir = /DESC/i.test(orderMatch[1]) ? 'newest/largest first (↓)' : 'oldest/smallest first (↑)';
    parts.push('↕ <strong>Sorted by:</strong> <code style="font-family:monospace;font-size:10px;background:var(--bg-muted);padding:1px 4px;border-radius:3px">' + esc(orderMatch[1].trim()) + '</code> — ' + dir);
  }

  // LIMIT
  var limitMatch = s.match(/LIMIT\s+(\d+)/i);
  if (limitMatch) {
    parts.push('🔢 <strong>Shows at most</strong> ' + limitMatch[1] + ' rows.');
  }

  if (!parts.length) {
    return '<span style="color:var(--text-dim)">Could not parse this query. Try a SELECT statement.</span>';
  }

  return '<ul style="list-style:none;padding:0;margin:0;space-y:2px">' +
    parts.map(function(p) {
      return '<li style="padding:3px 0;border-bottom:1px solid var(--border-light)">' + p + '</li>';
    }).join('') + '</ul>';
}

/* ── SQL Templates ──────────────────────────────────────────────────── */
var SQL_TEMPLATES = [
  { icon: '📋', title: 'Select all rows',
    sql: 'SELECT *\nFROM "your_table"\nLIMIT 100' },
  { icon: '🔢', title: 'Count by group',
    sql: 'SELECT "column_name", COUNT(*) AS count\nFROM "your_table"\nGROUP BY "column_name"\nORDER BY count DESC' },
  { icon: '🔍', title: 'Search text column',
    sql: 'SELECT *\nFROM "your_table"\nWHERE LOWER("column_name") LIKE LOWER(\'%search_term%\')' },
  { icon: '📅', title: 'Filter by date range',
    sql: 'SELECT *\nFROM "your_table"\nWHERE "date_column" BETWEEN \'2024-01-01\' AND \'2024-12-31\'\nORDER BY "date_column"' },
  { icon: '🔗', title: 'JOIN two tables',
    sql: 'SELECT t1.*, t2."col_from_t2"\nFROM "table_one" t1\nLEFT JOIN "table_two" t2\n  ON t1."id_column" = t2."id_column"\nLIMIT 100' },
  { icon: '📊', title: 'SUM & AVG by group',
    sql: 'SELECT\n  "group_column",\n  COUNT(*) AS rows,\n  SUM("amount_column") AS total,\n  ROUND(AVG("amount_column"), 2) AS average\nFROM "your_table"\nGROUP BY "group_column"\nORDER BY total DESC' },
  { icon: '🔂', title: 'Find duplicates',
    sql: 'SELECT "column_name", COUNT(*) AS occurrences\nFROM "your_table"\nGROUP BY "column_name"\nHAVING COUNT(*) > 1\nORDER BY occurrences DESC' },
  { icon: '❓', title: 'Find empty / NULL rows',
    sql: 'SELECT *\nFROM "your_table"\nWHERE "column_name" IS NULL\n   OR "column_name" = \'\'' },
  { icon: '🏆', title: 'Top N rows',
    sql: 'SELECT *\nFROM "your_table"\nORDER BY "value_column" DESC\nLIMIT 10' },
  { icon: '🔀', title: 'Complex WHERE with groups',
    sql: 'SELECT *\nFROM "your_table"\nWHERE\n  ("status" = \'active\' AND "amount" > 100)\n  OR ("status" = \'pending\' AND "date" > \'2024-01-01\')\nLIMIT 500' },
];

function openTemplates() {
  var grid = document.getElementById('templates-grid');
  if (!grid) return;
  var tbl = _activeTable ? '"' + _activeTable + '"' : '"your_table"';
  grid.innerHTML = SQL_TEMPLATES.map(function(t, i) {
    var sql = t.sql.replace(/"your_table"/g, tbl);
    return '<div class="template-card" onclick="useTemplate(' + i + ')">' +
      '<div style="font-size:18px;margin-bottom:4px">' + t.icon + '</div>' +
      '<div style="font-size:11px;font-weight:600;color:var(--text-head)">' + esc(t.title) + '</div>' +
      '<div style="font-size:9px;font-family:monospace;color:var(--text-dim);margin-top:4px;line-height:1.5;white-space:pre">' + esc(sql.slice(0, 80)) + (sql.length > 80 ? '…' : '') + '</div>' +
    '</div>';
  }).join('');
  openModal('modal-templates');
}
function useTemplate(i) {
  var t = SQL_TEMPLATES[i];
  if (!t) return;
  var tbl = _activeTable ? '"' + _activeTable + '"' : '"your_table"';
  var sql = t.sql.replace(/"your_table"/g, tbl);
  var ed = document.getElementById('sql-editor');
  if (ed) { ed.value = sql; syncSqlLines(); }
  closeModal();
  toast('Template inserted! Edit column names as needed.');
}

/* ── Results table ──────────────────────────────────────────────────── */
/* ── Results rendering — paginated + DocumentFragment ───────────────── */
function renderResults(columns, firstPageRows, totalCount) {
  _lastResults  = { columns: columns, cachedPages: { 0: firstPageRows || [] }, total: totalCount || 0 };
  _currentPage  = 0;
  _colSearch    = '';

  var empty   = document.getElementById('results-empty');
  var count   = document.getElementById('results-count');
  var hasData = _lastResults.total > 0;
  if (empty) empty.classList.toggle('hidden', hasData);
  var csvBtn = document.getElementById('btn-export-csv');
  var pdfBtn = document.getElementById('btn-export-pdf');
  if (csvBtn) csvBtn.disabled = !hasData;
  if (pdfBtn) pdfBtn.disabled = !hasData;

  var head = document.getElementById('results-head');
  var body = document.getElementById('results-body');

  if (!hasData) {
    if (count) count.textContent = '';
    if (head) head.innerHTML = '';
    if (body) body.innerHTML = '';
    renderPaginationBar(0, 0);
    return;
  }

  // Header — with column search when cols > 12
  if (head) {
    var searchHtml = '';
    if (columns.length > 12) {
      searchHtml = '<tr><td colspan="' + columns.length + '" style="padding:3px 6px;background:var(--bg-muted);border-bottom:1px solid var(--border)">' +
        '<input id="col-search-input" type="text" class="input-sm" style="width:220px;font-size:10px" ' +
        'placeholder="🔍 Filter columns by name…" oninput="filterResultColumns(this.value)"></td></tr>';
    }
    head.innerHTML = searchHtml +
      '<tr id="results-header-row">' + columns.map(function(c) {
        return '<th class="tbl-head" data-col="' + esc(c) + '">' + esc(c) + '</th>';
      }).join('') + '</tr>';
  }

  renderPage(0);

  var total = _lastResults.total;
  if (count) count.textContent = total.toLocaleString() + ' rows · ' + columns.length + ' cols';
  renderPaginationBar(0, total);
}

/* Render a single page of rows using DocumentFragment (fast) */
function renderPage(page) {
  if (!_lastResults) return;

  if (!_lastResults.cachedPages[page]) {
    var body = document.getElementById('results-body');
    if (body) body.innerHTML = '<tr><td colspan="100" style="text-align:center;padding:20px;color:var(--text-dim)">Loading page...</td></tr>';
    apiCall('get_result_page', page, PAGE_SIZE).then(function(rows) {
      _lastResults.cachedPages[page] = rows || [];
      drawPage(page);
    }).catch(function(e) { toast('Error loading page: ' + e.message, 'error'); });
  } else {
    drawPage(page);
  }
}

function drawPage(page) {
  var columns = _lastResults.columns;
  var rows    = _lastResults.cachedPages[page] || [];

  // Apply column filter if active
  var visibleCols = columns;
  if (_colSearch) {
    var term = _colSearch.toLowerCase();
    visibleCols = columns.filter(function(c) { return c.toLowerCase().indexOf(term) !== -1; });
  }

  var body = document.getElementById('results-body');
  if (!body) return;
  body.innerHTML = '';   // clear previous page

  var end = rows.length;

  // Use DocumentFragment — one DOM mutation instead of thousands
  var frag = document.createDocumentFragment();
  for (var i = 0; i < end; i++) {
    var row = rows[i];
    var tr  = document.createElement('tr');
    tr.className = 'tbl-row';
    for (var j = 0; j < visibleCols.length; j++) {
      var c  = visibleCols[j];
      var v  = row[c];
      var td = document.createElement('td');
      td.className = 'tbl-cell';
      if (v == null) {
        var span = document.createElement('span');
        span.style.color = 'var(--text-dim)';
        span.textContent = 'NULL';
        td.appendChild(span);
      } else {
        td.textContent = String(v);
      }
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  body.appendChild(frag);

  // Update header visibility to match column filter
  if (_colSearch) {
    var ths = document.querySelectorAll('#results-header-row th');
    ths.forEach(function(th) {
      th.style.display = (th.getAttribute('data-col') && th.getAttribute('data-col').toLowerCase().indexOf(_colSearch.toLowerCase()) !== -1) ? '' : 'none';
    });
  } else {
    var ths = document.querySelectorAll('#results-header-row th');
    ths.forEach(function(th) { th.style.display = ''; });
  }

  _currentPage = page;
}

function filterResultColumns(term) {
  _colSearch = term;
  drawPage(_currentPage);
}

function renderPaginationBar(page, total) {
  var bar = document.getElementById('results-pagination');
  if (!bar) return;
  if (!total || total <= PAGE_SIZE) { bar.innerHTML = ''; return; }
  var pages = Math.ceil(total / PAGE_SIZE);
  var html  = '<div style="display:flex;align-items:center;gap:6px;font-size:11px;padding:4px 8px">';
  html += '<button class="btn-ghost" style="font-size:10px;height:22px;padding:0 8px" onclick="goPage(0)" ' + (page === 0 ? 'disabled' : '') + '>« First</button>';
  html += '<button class="btn-ghost" style="font-size:10px;height:22px;padding:0 8px" onclick="goPage(' + (page - 1) + ')" ' + (page === 0 ? 'disabled' : '') + '>‹ Prev</button>';
  // Page numbers around current
  var from = Math.max(0, page - 2), to = Math.min(pages - 1, from + 4);
  for (var p = from; p <= to; p++) {
    html += '<button class="btn-ghost' + (p === page ? ' active' : '') + '" style="font-size:10px;height:22px;padding:0 7px;min-width:28px" onclick="goPage(' + p + ')">' + (p + 1) + '</button>';
  }
  html += '<button class="btn-ghost" style="font-size:10px;height:22px;padding:0 8px" onclick="goPage(' + (page + 1) + ')" ' + (page >= pages - 1 ? 'disabled' : '') + '>Next ›</button>';
  html += '<button class="btn-ghost" style="font-size:10px;height:22px;padding:0 8px" onclick="goPage(' + (pages - 1) + ')" ' + (page >= pages - 1 ? 'disabled' : '') + '>Last »</button>';
  html += '<span style="margin-left:4px;color:var(--text-dim)">Page ' + (page + 1) + ' / ' + pages + ' · showing rows ' + (page * PAGE_SIZE + 1) + '–' + Math.min((page + 1) * PAGE_SIZE, total) + ' of ' + total.toLocaleString() + '</span>';
  html += '</div>';
  bar.innerHTML = html;
}

function goPage(page) {
  if (!_lastResults) return;
  var pages = Math.ceil(_lastResults.total / PAGE_SIZE);
  page = Math.max(0, Math.min(pages - 1, page));
  renderPage(page);
  renderPaginationBar(page, _lastResults.total);
  // Scroll results to top
  var wrap = document.querySelector('#results-table');
  if (wrap && wrap.parentElement) wrap.parentElement.scrollTop = 0;
}

/* ── Export ─────────────────────────────────────────────────────────── */
function exportCsv() {
  if (!_lastResults) return;
  apiCall('save_file_dialog', 'querii_export', 'csv')
    .then(function(path) { if (!path) return null; return apiCall('export_csv', [], [], path); })
    .then(function(r) { if (r) toast('CSV exported.'); })
    .catch(function(e) { toast('Export failed: ' + e.message, 'error'); });
}
function exportPdf() {
  if (!_lastResults) return;
  var org  = (document.getElementById('s-org-name') || {}).value || '';
  var imgEl = document.getElementById('logo-img');
  var logo = (imgEl && imgEl.src && imgEl.src.indexOf('base64,') !== -1) ? imgEl.src.replace(/^data:[^;]+;base64,/, '') : '';
  var sql  = (document.getElementById('sql-editor') || {}).value || '';
  apiCall('save_file_dialog', 'querii_export', 'pdf')
    .then(function(path) { if (!path) return null; return apiCall('export_pdf', [], [], path, 'Query Results', org, logo, sql, null); })
    .then(function(r) { if (r) toast('PDF export started.'); })
    .catch(function(e) { toast('Export failed: ' + e.message, 'error'); });
}

/* ── Schema toggle panel ────────────────────────────────────────────── */
function toggleSchemaPanel() {
  var panel = document.getElementById('schema-panel');
  if (!panel) return;
  var hidden = panel.classList.toggle('hidden');
  var btn = document.getElementById('btn-schema-toggle');
  if (btn) btn.classList.toggle('active', !hidden);
  if (!hidden) {
    var html = '';
    _allSchemaData.forEach(function(t) {
      var userCols = t.columns.filter(function(c) { return !c.name.startsWith('_'); });
      html += '<div style="padding:6px 8px;border-bottom:1px solid var(--border)">' +
        '<div style="font-weight:600;font-size:11px;font-family:monospace;color:var(--text-head);margin-bottom:4px">📋 ' + esc(t.table) + '</div>';
      userCols.forEach(function(c) {
        html += '<div style="display:flex;justify-content:space-between;padding:1px 4px;cursor:pointer;border-radius:2px" onclick="insertColInSql(\'' + esc(c.name) + '\')" title="Click to insert">' +
          '<span style="font-family:monospace;font-size:10px">' + esc(c.name) + '</span>' +
          '<span style="font-size:9px;color:var(--text-dim)">' + c.type + '</span></div>';
      });
      html += '</div>';
    });
    if (!html) html = '<div style="padding:12px;font-size:11px;color:var(--text-dim)">No tables yet.</div>';
    panel.innerHTML = html;
  }
}
function insertColInSql(colName) {
  var ed = document.getElementById('sql-editor');
  if (!ed) return;
  var s = ed.selectionStart;
  ed.value = ed.value.slice(0, s) + '"' + colName + '"' + ed.value.slice(ed.selectionEnd);
  ed.selectionStart = ed.selectionEnd = s + colName.length + 2;
  ed.focus();
}

/* ── Drop table ─────────────────────────────────────────────────────── */
function dropActiveTable() {
  if (!_activeTable) return;
  var el = document.getElementById('droptable-name');
  if (el) el.textContent = _activeTable;
  openModal('modal-droptable');
}
function confirmDropTable() {
  if (!_activeTable) return;
  closeModal();
  apiCall('drop_table', _activeTable)
    .then(function() {
      toast('Table "' + _activeTable + '" deleted.');
      _activeTable = '';
      var atb = document.getElementById('active-table-badge');
      if (atb) atb.classList.add('hidden');
      refreshSchema();
    })
    .catch(function(e) { toast('Failed: ' + e.message, 'error'); });
}

/* ── File List (replaces History) ───────────────────────────────────── */
function openFileList() {
  var tbody   = document.getElementById('filelist-tbody');
  var emptyEl = document.getElementById('filelist-empty');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:12px;font-size:11px;color:var(--text-dim)">Loading…</td></tr>';
  openModal('modal-filelist');

  // Load schema + history in parallel
  Promise.all([
    apiCall('get_schema'),
    apiCall('get_import_history'),
  ]).then(function(results) {
    var schema  = results[0] || [];
    var history = results[1] || [];
    if (tbody) tbody.innerHTML = '';

    if (!schema.length) {
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');

    // Build map: table → history row
    var histMap = {};
    history.forEach(function(h) { histMap[h.table_name] = h; });

    schema.forEach(function(t) {
      var h = histMap[t.table] || {};
      var userCols = t.columns.filter(function(c) { return !c.name.startsWith('_'); });
      var isSelected = _selectedTables.indexOf(t.table) !== -1;
      var tr = document.createElement('tr');
      tr.className = 'tbl-row' + (isSelected ? ' selected-row' : '');
      tr.innerHTML =
        '<td class="tbl-cell" style="text-align:center"><input type="checkbox" class="table-checkbox" data-table="' + esc(t.table) + '"' + (isSelected ? ' checked' : '') + '></td>' +
        '<td class="tbl-cell" style="font-family:monospace;font-size:11px;font-weight:600;color:var(--text-head)">' + esc(t.table) + '</td>' +
        '<td class="tbl-cell" style="color:var(--text-dim)">' + esc(h.filename || '—') + '</td>' +
        '<td class="tbl-cell" style="color:var(--text-dim)">' + esc((h.imported_at || '').slice(0, 19)) + '</td>' +
        '<td class="tbl-cell text-right">' + ((h.rows_imported || 0).toLocaleString()) + '</td>' +
        '<td class="tbl-cell text-right">' + userCols.length + '</td>' +
        '<td class="tbl-cell" style="text-align:center">' +
          '<button onclick="fileListSelect(\'' + esc(t.table) + '\')" style="font-size:10px;color:var(--accent);background:none;border:none;cursor:pointer;text-decoration:underline;margin-right:6px" title="Use this table alone">Use</button>' +
          '<button onclick="fileListDrop(\'' + esc(t.table) + '\')" style="font-size:10px;color:var(--danger);background:none;border:none;cursor:pointer" title="Delete table">🗑</button>' +
        '</td>';
      if (tbody) tbody.appendChild(tr);
    });
  }).catch(function(e) { toast('Error loading file list: ' + e.message, 'error'); });
}

function toggleCheckAll(cb) {
  document.querySelectorAll('.table-checkbox').forEach(function(el) { el.checked = cb.checked; });
}

function fileListSelect(name) {
  closeModal();
  _selectedTables = [name];
  var sel = document.getElementById('table-select');
  if (sel) { sel.value = name; onTableChange(); }
  updateTableBadge();
}

function fileListDrop(name) {
  if (!confirm('Delete table "' + name + '"? This cannot be undone.')) return;
  apiCall('drop_table', name)
    .then(function() {
      toast('Table "' + name + '" deleted.');
      if (_activeTable === name) { _activeTable = ''; }
      _selectedTables = _selectedTables.filter(function(t) { return t !== name; });
      refreshSchema();
      openFileList(); // Refresh the list
    })
    .catch(function(e) { toast('Failed: ' + e.message, 'error'); });
}

function useSelectedTables() {
  var checked = [];
  document.querySelectorAll('.table-checkbox:checked').forEach(function(cb) {
    checked.push(cb.getAttribute('data-table'));
  });
  if (!checked.length) { toast('Select at least one table.', 'warn'); return; }
  closeModal();
  _selectedTables = checked;

  if (checked.length === 1) {
    // Single table — normal mode
    var sel = document.getElementById('table-select');
    if (sel) { sel.value = checked[0]; }
    _activeTable = checked[0];
    exitJoinMode();
    onTableChange();
  } else {
    // Multi-table — JOIN mode
    _activeTable = checked[0];
    enterJoinMode(checked);
  }
  updateTableBadge();
}

function updateTableBadge() {
  var atb = document.getElementById('active-table-badge');
  var atn = document.getElementById('active-table-name');
  if (!_activeTable) { if (atb) atb.classList.add('hidden'); return; }
  if (atb) atb.classList.remove('hidden');
  if (atn) {
    atn.textContent = _selectedTables.length > 1
      ? _selectedTables.join(' ⋈ ')
      : _activeTable;
  }
}

/* ── JOIN mode ──────────────────────────────────────────────────────── */
function enterJoinMode(tables) {
  var bar   = document.getElementById('join-bar');
  var label = document.getElementById('join-tables-label');
  if (bar)   bar.classList.remove('hidden');
  if (label) label.textContent = tables.join(' ⋈ ');
  _joinClauses = [];
  renderJoinClauses();

  var sel = document.getElementById('table-select');
  if (sel) {
    var oldOpt = sel.querySelector('.join-option');
    if (oldOpt) oldOpt.remove();
    var joinLabel = tables.join(' ⋈ ');
    var opt = document.createElement('option');
    opt.value = 'JOIN_MODE';
    opt.textContent = joinLabel + ' (JOIN)';
    opt.className = 'join-option';
    sel.insertBefore(opt, sel.firstChild);
    sel.value = 'JOIN_MODE';
  }

  // Auto-suggest join: find matching column names between tables
  var tableSchemas = {};
  _allSchemaData.forEach(function(t) {
    if (tables.indexOf(t.table) !== -1) tableSchemas[t.table] = t.columns.filter(function(c) { return !c.name.startsWith('_'); }).map(function(c) { return c.name; });
  });
  // Find cols shared between first two tables
  if (tables.length >= 2) {
    var cols1 = tableSchemas[tables[0]] || [];
    var cols2 = tableSchemas[tables[1]] || [];
    var shared = cols1.filter(function(c) { return cols2.indexOf(c) !== -1; });
    if (shared.length > 0) {
      _joinClauses.push({ id: 'jc' + Date.now(), t1: tables[0], c1: shared[0], t2: tables[1], c2: shared[0], clause: '"' + tables[0] + '"."' + shared[0] + '" = "' + tables[1] + '"."' + shared[0] + '"' });
      renderJoinClauses();
      toast('JOIN suggestion: ' + shared[0] + ' column found in both tables!');
    }
  }

  // Merge columns from all selected tables
  var allCols = [];
  tables.forEach(function(tbl) {
    var tData = _allSchemaData.find(function(t) { return t.table === tbl; });
    if (tData) {
      tData.columns.filter(function(c) { return !c.name.startsWith('_'); }).forEach(function(c) {
        allCols.push({
          name: c.name,
          type: c.type,
          category: sql_type_to_category_js(c.type),
          operators: getOpsForCat(sql_type_to_category_js(c.type)),
          table_prefix: tbl + '.',
        });
      });
    }
  });
  _tableColumns = allCols;
  rebuildSortDropdown();
  buildAggDropdowns();
  clearFilterGroups();
}

function sql_type_to_category_js(t) {
  t = (t || '').toUpperCase();
  if (t === 'INTEGER' || t === 'REAL' || t === 'NUMERIC' || t === 'FLOAT' || t === 'INT') return 'number';
  if (t === 'DATE') return 'date';
  if (t === 'TIME') return 'time';
  return 'text';
}
function getOpsForCat(cat) {
  var map = {
    text:   ['contains', 'equals', 'starts with', 'ends with', 'not contains', 'not equals', 'is empty', 'is not empty'],
    date:   ['on', 'before', 'after', 'between', 'on or before', 'on or after'],
    time:   ['before', 'after', 'equals'],
    number: ['equals', 'greater than', 'less than', 'greater or equal', 'less or equal', 'not equals', 'between'],
  };
  return map[cat] || map.text;
}

function exitJoinMode() {
  var bar = document.getElementById('join-bar');
  if (bar) bar.classList.add('hidden');
  _joinClauses = [];

  var sel = document.getElementById('table-select');
  if (sel) {
    var oldOpt = sel.querySelector('.join-option');
    if (oldOpt) oldOpt.remove();
    if (_activeTable && sel.querySelector('option[value="' + _activeTable.replace(/"/g, '\\"') + '"]')) {
      sel.value = _activeTable;
    }
  }
}

function addJoinClause() {
  var t1 = _selectedTables[0] || '';
  var t2 = _selectedTables[1] || '';
  var id = 'jc' + Date.now();
  _joinClauses.push({ id: id, t1: t1, c1: '', t2: t2, c2: '', clause: '' });
  renderJoinClauses();
}

function renderJoinClauses() {
  var area = document.getElementById('join-clause-area');
  if (!area) return;
  area.innerHTML = _joinClauses.map(function(jc, i) {
    return '<div style="display:flex;align-items:center;gap:3px;font-size:10px;font-family:monospace">' +
      '<span style="color:var(--text-dim);font-size:9px">' + esc(jc.t1) + '.</span>' +
      '<input class="input-sm" style="width:80px;font-family:monospace;font-size:10px" placeholder="col" value="' + esc(jc.c1) + '" ' +
        'oninput="updateJoinClause(' + i + ',\'c1\',this.value)">' +
      '<span style="color:var(--accent)">=</span>' +
      '<span style="color:var(--text-dim);font-size:9px">' + esc(jc.t2) + '.</span>' +
      '<input class="input-sm" style="width:80px;font-family:monospace;font-size:10px" placeholder="col" value="' + esc(jc.c2) + '" ' +
        'oninput="updateJoinClause(' + i + ',\'c2\',this.value)">' +
      '<button onclick="removeJoinClause(' + i + ')" style="color:var(--danger);background:none;border:none;cursor:pointer;font-size:11px;padding:0">✕</button>' +
    '</div>';
  }).join('');
}
function updateJoinClause(i, key, val) {
  _joinClauses[i][key] = val;
  var jc = _joinClauses[i];
  if (jc.c1 && jc.c2) {
    jc.clause = '"' + jc.t1 + '"."' + jc.c1 + '" = "' + jc.t2 + '"."' + jc.c2 + '"';
  }
}
function removeJoinClause(i) {
  _joinClauses.splice(i, 1);
  renderJoinClauses();
}

/* ── Custom (saved) reports ─────────────────────────────────────────── */
function loadCustomReports() { renderCustomReports(); }
function renderCustomReports() {
  var el = document.getElementById('quick-custom');
  if (!el) return;
  if (!_customReports.length) {
    el.innerHTML = '<div style="font-size:10px;color:var(--text-dim);text-align:center;padding:24px 8px">No saved reports yet.<br>Click ＋ Add to create one.</div>';
    return;
  }
  el.innerHTML = _customReports.map(function(r, i) {
    return '<div class="quick-btn" onclick="runCustomReport(' + i + ')" style="display:flex;align-items:center;gap:6px">' +
      '<span style="font-size:13px">' + esc(r.icon || '📌') + '</span>' +
      '<span style="flex:1;font-size:11px;font-weight:500">' + esc(r.title) + '</span>' +
      '<button onclick="event.stopPropagation();deleteCustomReport(' + i + ')" style="font-size:10px;color:var(--danger);background:none;border:none;cursor:pointer">✕</button></div>';
  }).join('');
}
function openCustomReportModal() {
  var t = document.getElementById('cr-title'); if (t) t.value = '';
  var ic = document.getElementById('cr-icon');  if (ic) ic.value = '📌';
  var sq = document.getElementById('cr-sql');   if (sq) sq.value = '';
  syncLines('cr-sql', 'cr-lines');
  openModal('modal-custom-report');
}
function saveCustomReport() {
  var title = ((document.getElementById('cr-title') || {}).value || '').trim();
  var icon  = ((document.getElementById('cr-icon') || {}).value || '').trim() || '📌';
  var sql   = ((document.getElementById('cr-sql') || {}).value || '').trim();
  if (!title || !sql) { toast('Title and SQL are required.', 'warn'); return; }
  _customReports.push({ title: title, icon: icon, sql: sql });
  renderCustomReports();
  apiCall('save_settings', { ap_custom_reports: JSON.stringify(_customReports) }).catch(function() {});
  closeModal();
  toast('Report saved.');
}
function runCustomReport(i) {
  var report = _customReports[i];
  if (!report) return;
  var ed = document.getElementById('sql-editor');
  if (ed) { ed.value = report.sql; syncSqlLines(); }
  runSql();
}
function deleteCustomReport(i) {
  _customReports.splice(i, 1);
  renderCustomReports();
  apiCall('save_settings', { ap_custom_reports: JSON.stringify(_customReports) }).catch(function() {});
}

/* ── SQL editor helpers ─────────────────────────────────────────────── */
function syncSqlLines() { syncLines('sql-editor', 'sql-lines'); }
function syncLines(editorId, linesId) {
  var ed    = document.getElementById(editorId);
  var lines = document.getElementById(linesId);
  if (!ed || !lines) return;
  var count = (ed.value.match(/\n/g) || []).length + 1;
  var h = '';
  for (var i = 1; i <= count; i++) h += i + '\n';
  lines.textContent = h;
  lines.scrollTop = ed.scrollTop;
}

/* ── Status helpers ─────────────────────────────────────────────────── */
function setSqlStatus(msg) {
  var el = document.getElementById('sql-status');
  if (el) el.textContent = msg;
}
function setImportStatus(msg) {
  var el = document.getElementById('import-status');
  if (el) el.textContent = msg;
}
function showProgress(show) {
  var el = document.getElementById('import-progress');
  if (el) el.classList.toggle('hidden', !show);
}

/* ── Resize handles — SMOOTH (requestAnimationFrame) ────────────────── */
function initResizableHandles() {
  setupHandleH('rh-left',  'panel-filter', 'left');
  setupHandleH('rh-right', 'panel-quick',  'right');
  setupHandleV('rh-sql',   'sql-panel');
}

function setupHandleH(hId, pId, side) {
  var handle  = document.getElementById(hId);
  var panel   = document.getElementById(pId);
  if (!handle || !panel) return;
  var dragging = false, startX = 0, startW = 0, pendingW = null;

  handle.addEventListener('mousedown', function(e) {
    dragging = true; startX = e.clientX; startW = panel.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    var delta = side === 'left' ? e.clientX - startX : startX - e.clientX;
    pendingW = Math.max(220, Math.min(600, startW + delta));
    if (pendingW !== null) {
      requestAnimationFrame(function() {
        if (pendingW !== null && panel) { panel.style.width = pendingW + 'px'; pendingW = null; }
      });
    }
  });

  document.addEventListener('mouseup', function() {
    if (!dragging) return;
    dragging = false; pendingW = null;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

function setupHandleV(hId, pId) {
  var handle = document.getElementById(hId);
  var panel  = document.getElementById(pId);
  if (!handle || !panel) return;
  var dragging = false, startY = 0, startH = 0, pendingH = null;

  handle.addEventListener('mousedown', function(e) {
    dragging = true; startY = e.clientY; startH = panel.offsetHeight;
    handle.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    pendingH = Math.max(60, Math.min(window.innerHeight - 150, startH + e.clientY - startY));
    requestAnimationFrame(function() {
      if (pendingH !== null && panel) { panel.style.height = pendingH + 'px'; pendingH = null; }
    });
  });

  document.addEventListener('mouseup', function() {
    if (!dragging) return;
    dragging = false; pendingH = null;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

/* ─────────────────────────────────────────────────────────────────────
   DOMContentLoaded — SYNCHRONOUS setup, then API calls at the end
   ───────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
  initResizableHandles();

  // Button bindings
  on('btn-browse',        'click', browseFile);
  on('btn-import',        'click', startImport);
  on('btn-reimport',      'click', startImport);
  on('btn-run-filter',    'click', runFilter);
  on('btn-clear-filter',  'click', clearFilter);
  on('btn-add-condition', 'click', addTopLevelCondition);
  on('btn-add-group',     'click', addFilterGroup);
  on('btn-sql-run',       'click', runSql);
  on('btn-sql-clear',     'click', clearSql);
  on('btn-schema-toggle', 'click', toggleSchemaPanel);
  on('btn-filelist',      'click', openFileList);
  on('btn-settings',      'click', openSettings);
  on('btn-export-csv',    'click', exportCsv);
  on('btn-export-pdf',    'click', exportPdf);

  // SQL editor
  var sqlEd = document.getElementById('sql-editor');
  if (sqlEd) {
    sqlEd.addEventListener('input', syncSqlLines);
    sqlEd.addEventListener('scroll', function() {
      var ln = document.getElementById('sql-lines');
      if (ln) ln.scrollTop = sqlEd.scrollTop;
    });
    sqlEd.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(); }
      if (e.key === 'Tab') {
        e.preventDefault();
        var s = sqlEd.selectionStart;
        sqlEd.value = sqlEd.value.slice(0, s) + '  ' + sqlEd.value.slice(sqlEd.selectionEnd);
        sqlEd.selectionStart = sqlEd.selectionEnd = s + 2;
        syncSqlLines();
      }
    });
  }

  // Custom report editor
  var crSql = document.getElementById('cr-sql');
  if (crSql) {
    crSql.addEventListener('input', function() { syncLines('cr-sql', 'cr-lines'); });
    crSql.addEventListener('scroll', function() {
      var ln = document.getElementById('cr-lines');
      if (ln) ln.scrollTop = crSql.scrollTop;
    });
  }

  // Zoom keys
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeModal();
    if (!e.ctrlKey) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); adjustZoom(0.1); }
    else if (e.key === '-') { e.preventDefault(); adjustZoom(-0.1); }
    else if (e.key === '0') { e.preventDefault(); resetZoom(); }
  });

  // ── AFTER all DOM setup: call API ─────────────────────────────────
  waitForApi().then(function() {
    return window.pywebview.api.get_settings();
  }).then(function(res) {
    var s = (res && res.ok && res.data) ? res.data : {};
    var theme = s.ap_theme || 'mono';
    memSet('ap_theme', theme);
    if (typeof applyTheme === 'function') applyTheme(theme);

    var z = parseFloat(s.ap_zoom || '1.0');
    if (!isNaN(z)) {
      _zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
      document.documentElement.style.zoom = String(_zoom);
      var lbl = document.getElementById('zoom-label');
      if (lbl) lbl.textContent = Math.round(_zoom * 100) + '%';
      memSet('ap_zoom', _zoom);
    }

    if (s.org_name) {
      var el = document.getElementById('org-name-display');
      if (el) { el.textContent = s.org_name; el.classList.remove('hidden'); }
      var inp = document.getElementById('s-org-name');
      if (inp) inp.value = s.org_name;
    }
    if (s.org_logo_b64) setLogoPreview(s.org_logo_b64);

    if (s.ap_custom_reports) {
      try { _customReports = JSON.parse(s.ap_custom_reports) || []; } catch(e) { _customReports = []; }
    }
    loadCustomReports();

    return window.pywebview.api.get_schema();
  }).then(function(res) {
    var schema = (res && res.ok && res.data) ? res.data : [];
    _allSchemaData = schema;
    var sel = document.getElementById('table-select');
    if (sel) sel.innerHTML = '';
    if (!schema.length) {
      if (sel) sel.innerHTML = '<option value="">— no tables yet —</option>';
      renderSchemaTree([]);
      return;
    }
    schema.forEach(function(t) {
      var opt = document.createElement('option');
      opt.value = t.table;
      opt.textContent = t.table + '  (' + t.columns.filter(function(c) { return !c.name.startsWith('_'); }).length + ' cols)';
      if (sel) sel.appendChild(opt);
    });
    if (sel) sel.value = schema[0].table;
    onTableChange();
    renderSchemaTree(schema);
  }).catch(function(e) {
    console.error('[Querii init error]', e);
    loadCustomReports();
  });
});
