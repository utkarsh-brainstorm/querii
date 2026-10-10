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
var _pdfCustomCss    = '';    // default CSS from settings
var _pdfDevMode      = false; // developer toggle
/* Pagination */
var PAGE_SIZE        = 200;     // rows per page
var _currentPage     = 0;       // 0-indexed
var _colSearch       = '';      // current column search term in results
var _clientSortCol   = '';      // column sorted client-side
var _clientSortDir   = 'ASC';   // client-side sort direction
var _sortCol         = '';      // column currently sorted by (click-sort) — kept for header display
var _sortDir         = 'ASC';   // 'ASC' or 'DESC'

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

function copyToClipboard(text, successMsg) {
  successMsg = successMsg || '✓ Copied to clipboard!';
  text = String(text || '');

  if (typeof apiCall === 'function') {
    return apiCall('copy_to_clipboard', text)
      .then(function() {
        toast(successMsg);
        return true;
      })
      .catch(function() {
        return _fallbackDomCopy(text, successMsg);
      });
  }
  return Promise.resolve(_fallbackDomCopy(text, successMsg));
}

function _fallbackDomCopy(text, successMsg) {
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) {
      toast(successMsg || '✓ Copied to clipboard!');
      return true;
    }
  } catch (e) {}
  toast('Could not copy automatically. Please copy manually.', 'error');
  return false;
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
  var pdfCss  = (document.getElementById('s-pdf-custom-css') || {}).value || '';
  var pdfDev  = (document.getElementById('s-pdf-dev-mode') || {}).checked ? '1' : '';
  var payload = {
    org_name:  orgName,
    ap_theme:  currentTheme(),
    ap_zoom:   String(_zoom),
    ap_custom_reports: JSON.stringify(_customReports),
    pdf_custom_css: pdfCss,
    pdf_dev_mode:   pdfDev,
  };
  _pdfCustomCss = pdfCss;
  _pdfDevMode   = !!pdfDev;
  // Wide banner logo
  var imgEl = document.getElementById('logo-img');
  if (imgEl && imgEl.src && imgEl.src.indexOf('base64,') !== -1) {
    payload.org_logo_b64 = imgEl.src.replace(/^data:[^;]+;base64,/, '');
  }
  // Square logo
  var sqEl = document.getElementById('logo-sq-img');
  if (sqEl && sqEl.src && sqEl.src.indexOf('base64,') !== -1) {
    payload.org_logo_sq_b64 = sqEl.src.replace(/^data:[^;]+;base64,/, '');
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
var _qlogSqls = [];   // stores SQL strings for query log Use buttons (avoids onclick quoting issues)

function loadQueryLog() {
  var c = document.getElementById('query-log-list');
  if (!c) return;
  _qlogSqls = [];
  c.innerHTML = '<div style="padding:12px;text-align:center;font-size:11px;color:var(--text-dim)">Loading…</div>';
  apiCall('get_query_log')
    .then(function(logs) {
      if (!logs || !logs.length) {
        c.innerHTML = '<div style="padding:20px;text-align:center;font-size:11px;color:var(--text-dim)">No queries logged yet. Run a search or SQL query to start.</div>';
        return;
      }
      c.innerHTML = '';
      _qlogSqls = [];
      logs.forEach(function(q, i) {
        _qlogSqls.push(q.sql_text);   // safe storage — no inline quoting
        var d = document.createElement('div');
        d.className = 'qlog-row';
        var srcTag = q.source === 'filter'
          ? '<span style="font-size:9px;padding:1px 4px;border-radius:3px;background:var(--accent-bg);color:var(--accent);margin-right:4px">filter</span>'
          : '<span style="font-size:9px;padding:1px 4px;border-radius:3px;background:var(--bg-muted);color:var(--text-dim);margin-right:4px">sql</span>';
        d.innerHTML = '<div class="qlog-sql">' + srcTag + esc(q.sql_text) + '</div>' +
          '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">' +
          '<span class="qlog-meta">' + esc((q.ran_at || '').slice(0, 16)) + '<br>' + (q.row_count || 0) + ' rows</span>' +
          '<button class="qlog-copy" onclick="useQueryLog(' + i + ')">Use</button></div>';
        c.appendChild(d);
      });
    }).catch(function(e) {
      c.innerHTML = '<div style="padding:20px;text-align:center;font-size:11px;color:var(--danger)">Error loading log: ' + esc(e.message) + '</div>';
    });
}
function useQueryLog(idx) {
  var sql = _qlogSqls[idx];
  if (!sql) return;
  // 1) Paste into SQL editor
  var ed = document.getElementById('sql-editor');
  if (ed) { ed.value = sql; syncSqlLines(); }
  // 2) Copy to clipboard
  copyToClipboard(sql, 'Query loaded into editor and copied');
  // 3) Close modal
  closeModal();
  // 4) Switch to SQL tab if there's a tab switch mechanism
  var sqlTab = document.querySelector('.tab-btn[data-tab="sql"]') ||
               document.querySelector('[onclick*="switchTab"][onclick*="sql"]') ||
               document.querySelector('[onclick*="tab-sql"]');
  if (sqlTab) sqlTab.click();
  // 5) Scroll into view and focus
  setTimeout(function() {
    var sqlPanel = document.getElementById('sql-panel') ||
                   document.getElementById('tab-sql') ||
                   document.querySelector('.sql-editor-wrap');
    if (sqlPanel) sqlPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    var ed2 = document.getElementById('sql-editor');
    if (ed2) ed2.focus();
  }, 150);
  toast('✓ Query pasted to editor!');
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

/* Square logo (1:1, used as circular PDF header logo) */
function pickLogoSq() {
  apiCall('open_file_dialog_type', 'image')
    .then(function(path) { if (!path) return null; return apiCall('read_file_as_b64', path); })
    .then(function(b64) { if (!b64) return; setLogoSqPreview(b64); })
    .catch(function(e) { toast('Could not load logo: ' + e.message, 'error'); });
}
function setLogoSqPreview(b64) {
  var img  = document.getElementById('logo-sq-img');
  var prev = document.getElementById('logo-sq-preview');
  if (img)  img.src = 'data:image/png;base64,' + b64;
  if (prev) prev.classList.remove('hidden');
}
function clearLogoSq() {
  var img  = document.getElementById('logo-sq-img');
  var prev = document.getElementById('logo-sq-preview');
  if (img)  img.src = '';
  if (prev) prev.classList.add('hidden');
  apiCall('save_settings', { org_logo_sq_b64: '' }).catch(function() {});
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

  _selectedTables = [_activeTable]; // Update selected tables before rendering schema
  // Always re-render schema tree so it shows up even after relaunch
  var tableSchema = _allSchemaData.find(function(t) { return t.table === _activeTable; });
  if (tableSchema) {
    renderSchemaTree(_allSchemaData);
  } else {
    // Schema might not be loaded yet — refresh from backend
    apiCall('get_schema').then(function(schema) {
      _allSchemaData = schema || [];
      renderSchemaTree(_allSchemaData);
    }).catch(function(e) { console.error('schema refresh error', e); });
  }

  apiCall('get_table_columns', _activeTable)
    .then(function(cols) {
      _tableColumns = cols;
      _selectedTables = [_activeTable];
      rebuildSortDropdown();
      buildAggDropdowns();
      clearFilterGroups();
      runFilter();
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
// showAll: if false, only show tables in _selectedTables
function renderSchemaTree(schema, showAll) {
  var el = document.getElementById('schema-tree');
  var cr = document.getElementById('cr-schema-ref');
  if (!el) return;

  // Sidebar: filter to selected tables only (showAll === false or undefined)
  var sidebarSchema = schema;
  if (!showAll && _selectedTables.length > 0) {
    sidebarSchema = schema.filter(function(t) { return _selectedTables.indexOf(t.table) !== -1; });
  }

  if (!schema || schema.length === 0) {
    var empty = '<div style="color:var(--text-dim);text-align:center;padding:32px 8px;font-size:11px">Import a file to see schema</div>';
    el.innerHTML = empty;
    if (cr) cr.innerHTML = empty;
    return;
  }

  // Render sidebar with filtered tables
  el.innerHTML = _buildSchemaHtml(sidebarSchema.length ? sidebarSchema : schema, false);
  // Render SQL reference panel with FILTERED tables
  if (cr) cr.innerHTML = _buildSchemaHtml(sidebarSchema.length ? sidebarSchema : schema, true);
}

function _buildSchemaHtml(schema, isEditor) {
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
      var clickHandler = isEditor ? 
          'insertColIntoEditor(' + JSON.stringify(c.name) + ')' : 
          'showColStats(' + JSON.stringify(t.table) + ',' + JSON.stringify(c.name) + ')';
      var title = isEditor ? 'Click to insert into SQL Editor' : 'Click for column stats';
      html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 8px;border-bottom:1px solid var(--border-light);cursor:pointer;transition:background 80ms" ' +
        'onmouseover="this.style.background=\'var(--bg-muted)\'" onmouseout="this.style.background=\'\'" ' +
        'onclick="' + clickHandler + '" title="' + title + '">' +
        '<span style="font-family:monospace;font-size:10px;color:var(--text-body)">' + esc(c.name) + '</span>' +
        '<span style="background:' + color + ';color:#fff;font-size:9px;font-family:monospace;font-weight:600;padding:0 4px;border-radius:2px">' + c.type + '</span></div>';
    });
    html += '</div>';
    html += '<div style="margin-top:2px;padding:0 2px"><button style="width:100%;text-align:left;font-size:9px;font-family:monospace;color:var(--text-dim);background:var(--bg-muted);border:1px solid var(--border);border-radius:3px;padding:3px 6px;cursor:pointer;line-height:1.4;transition:background 100ms" onclick="copySql(' + JSON.stringify(sampleSql) + ')" title="Click to copy SELECT template">' + esc(sampleSql.replace(/\n/g, ' ')) + '</button></div></div>';
  });
  return html;
}

function copySql(sql) {
  var ta = document.createElement('textarea');
  ta.value = sql; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  var ed = document.getElementById('sql-editor');
  if (ed) { ed.value = sql; syncSqlLines(); }
  toast('SQL copied to editor.');
}

function insertColIntoEditor(colName) {
  var ed = document.getElementById('sql-editor');
  if (!ed) return;
  var colStr = '"' + colName + '"';
  var val = ed.value;
  var start = ed.selectionStart;
  var end = ed.selectionEnd;
  
  // If not at the very beginning, and the preceding non-whitespace character isn't a comma, add one
  var prefix = '';
  if (start > 0) {
    var preceding = val.substring(0, start).trimEnd();
    if (preceding.length > 0 && !preceding.endsWith(',')) {
      prefix = ', ';
    }
  }
  
  var insert = prefix + colStr;
  ed.value = val.substring(0, start) + insert + val.substring(end);
  ed.selectionStart = ed.selectionEnd = start + insert.length;
  ed.focus();
  syncSqlLines();
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
  copyToClipboard(text, 'Schema copied to clipboard! Paste it into ChatGPT or any AI to get custom queries.');
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
  syncFilterState();
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
  syncFilterState();
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
  syncFilterState();
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
  syncFilterState();
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
  syncFilterState();
  _filterGroups = _filterGroups.filter(function(g) { return g.id !== gid; });
  renderFilterGroups();
}

/* Remove any item (condition or nested group) from its parent group */
function removeGroupItem(gid, iid) {
  syncFilterState();
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
  syncFilterState();
  var group = findGroup(_filterGroups, gid);
  if (!group) return;
  group.joiner = group.joiner === 'AND' ? 'OR' : 'AND';
  renderFilterGroups();
}
/* Toggle joiner of any item */
function toggleItemJoiner(parentGid, iid) {
  syncFilterState();
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
      'onclick=\'toggleItemJoiner(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ')\' ' +
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
    'onchange=\'onCondFieldChange(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ',this.value)\'>' + fieldOpts + '</select>';

  // Op select (populated by updateFilterOps)
  html += '<div style="display:flex;gap:3px">';
  html += '<select class="select-sm" style="flex:1" id="fo-' + cond.id + '" ' +
    'onchange=\'onCondOpChange(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ',this.value)\'></select>';
  html += '</div>';
  html += '<div id="fv-' + cond.id + '" style="margin-top:2px"></div>';
  html += '</div>';

  // Remove
  html += '<button onclick=\'removeGroupItem(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ')\' ' +
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
  var changeAttr = 'onchange=\'onCondValueChange(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ',"val1",this.value)\' ' +
                   'oninput=\'onCondValueChange(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ',"val1",this.value)\'';
  var changeAttr2 = 'onchange=\'onCondValueChange(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ',"val2",this.value)\'';

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

function _applyTemplateTableNames(sql) {
  // Replace generic placeholders with actual table names from the active session
  var tbl1 = _selectedTables[0] ? '"' + _selectedTables[0] + '"' : '"your_table"';
  var tbl2 = _selectedTables[1] ? '"' + _selectedTables[1] + '"' : '"table_two"';
  var tbl  = _activeTable ? '"' + _activeTable + '"' : '"your_table"';

  // Replace the JOIN placeholders specifically
  sql = sql.replace(/"table_one"/g, tbl1);
  sql = sql.replace(/"table_two"/g, tbl2);
  // Replace general fallback
  sql = sql.replace(/"your_table"/g, tbl);

  // Auto-fill first column name if we have schema info
  var firstCol = _tableColumns.length > 0 ? _tableColumns[0].name : 'column_name';
  var numCol   = _tableColumns.find(function(c) { return c.category === 'numeric'; });
  var numColName = numCol ? numCol.name : 'amount_column';
  sql = sql.replace(/"column_name"/g, '"' + firstCol + '"');
  sql = sql.replace(/"amount_column"/g, '"' + numColName + '"');
  sql = sql.replace(/"group_column"/g, '"' + firstCol + '"');
  sql = sql.replace(/"value_column"/g, '"' + numColName + '"');
  return sql;
}

function openTemplates() {
  var grid = document.getElementById('templates-grid');
  if (!grid) return;
  grid.innerHTML = SQL_TEMPLATES.map(function(t, i) {
    var sql = _applyTemplateTableNames(t.sql);
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
  var sql = _applyTemplateTableNames(t.sql);
  var ed = document.getElementById('sql-editor');
  if (ed) { ed.value = sql; syncSqlLines(); }
  closeModal();
  toast('Template inserted! Table names auto-filled from your active selection.');
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
  var csvBtn  = document.getElementById('btn-export-csv');
  var cpyCsvBtn = document.getElementById('btn-copy-csv');
  var pdfBtn  = document.getElementById('btn-export-pdf');
  var rowSearch = document.getElementById('row-search-input');
  if (csvBtn)    csvBtn.disabled = !hasData;
  if (cpyCsvBtn) cpyCsvBtn.disabled = !hasData;
  if (pdfBtn)    pdfBtn.disabled = !hasData;
  if (rowSearch) {
    rowSearch.style.display = hasData ? 'inline-block' : 'none';
    rowSearch.value = '';
  }

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
    // Build sortable header
    head.innerHTML = searchHtml +
      '<tr id="results-header-row">' + columns.map(function(c) {
        var sortIndicator = (_sortCol === c) ? (_sortDir === 'ASC' ? ' ▲' : ' ▼') : '';
        return '<th class="tbl-head" data-col="' + esc(c) + '" ' +
          'style="cursor:pointer;user-select:none" ' +
          'onclick="toggleColumnSort(\'' + esc(c).replace(/'/g, "\\'") + '\')" ' +
          'title="Click to sort by ' + esc(c) + '">' +
          esc(c) + sortIndicator + '</th>';
      }).join('') + '</tr>';
  }

  renderPage(0);

  var total = _lastResults.total;
  if (count) count.textContent = total.toLocaleString() + ' rows · ' + columns.length + ' cols';
  renderPaginationBar(0, total);
}

/* Click a column header to sort via SQL */
function toggleColumnSort(col) {
  var sortColEl = document.getElementById('sort-col');
  var sortDirEl = document.getElementById('sort-dir');
  if (!sortColEl || !sortDirEl) return;

  if (sortColEl.value === col) {
    sortDirEl.value = sortDirEl.value === 'ASC' ? 'DESC' : 'ASC';
  } else {
    sortColEl.value = col;
    sortDirEl.value = 'ASC';
  }
  
  _sortCol = col;
  _sortDir = sortDirEl.value;

  // Re-run the SQL query to sort properly
  runFilter();
}

var _rowSearchTerm = '';
var _rowMatches = [];
var _rowMatchIndex = -1;

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, function(m) {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
    }
  });
}

function filterResultRows(text) {
  _rowSearchTerm = (text || '').trim();
  drawPage(_currentPage);
}

function nextResultRowMatch(event) {
  if (event && event.key !== 'Enter') return;
  if (!_rowMatches || !_rowMatches.length) return;
  
  if (_rowMatchIndex >= 0 && _rowMatchIndex < _rowMatches.length) {
    _rowMatches[_rowMatchIndex].style.background = '#fde68a';
    _rowMatches[_rowMatchIndex].style.color = '#000';
  }
  
  _rowMatchIndex = (_rowMatchIndex + 1) % _rowMatches.length;
  
  _rowMatches[_rowMatchIndex].style.background = '#f59e0b';
  _rowMatches[_rowMatchIndex].style.color = '#fff';
  _rowMatches[_rowMatchIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
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

  _rowMatches = [];
  _rowMatchIndex = -1;
  var termReg = _rowSearchTerm ? new RegExp(escapeRegExp(_rowSearchTerm), 'gi') : null;

  // Use DocumentFragment — one DOM mutation instead of thousands
  var frag = document.createDocumentFragment();
  for (var i = 0; i < end; i++) {
    var row = rows[i];
    var tr  = document.createElement('tr');
    tr.className = 'tbl-row';
    
    var rowMatchesTerm = false;
    if (_rowSearchTerm) {
      for (var k = 0; k < visibleCols.length; k++) {
        var cTest = visibleCols[k];
        if (row[cTest] != null && String(row[cTest]).toLowerCase().indexOf(_rowSearchTerm.toLowerCase()) > -1) {
          rowMatchesTerm = true;
          break;
        }
      }
      if (!rowMatchesTerm) {
        tr.style.display = 'none';
      }
    }

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
        var strV = String(v);
        if (_rowSearchTerm && rowMatchesTerm) {
          var highlighted = escapeHtml(strV).replace(termReg, function(match) {
            return '<mark class="row-match" style="background:#fde68a;color:#000;border-radius:2px;padding:0 2px">' + match + '</mark>';
          });
          td.innerHTML = highlighted;
        } else {
          td.textContent = strV;
        }
      }
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  body.appendChild(frag);

  if (_rowSearchTerm) {
    var marks = body.querySelectorAll('mark.row-match');
    for (var m = 0; m < marks.length; m++) {
      _rowMatches.push(marks[m]);
    }
    if (_rowMatches.length > 0) nextResultRowMatch();
  }

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

/* ── Copy CSV to clipboard ───────────────────────────────────────────── */
function copyCsv() {
  if (!_lastResults || !_lastResults.total) { toast('No results to copy.', 'warn'); return; }
  var cols = _lastResults.columns;
  // Collect all cached pages
  var allRows = [];
  var pageKeys = Object.keys(_lastResults.cachedPages);
  pageKeys.sort(function(a, b) { return Number(a) - Number(b); });
  pageKeys.forEach(function(k) {
    var pg = _lastResults.cachedPages[k];
    if (pg) allRows = allRows.concat(pg);
  });
  // If we don't have all rows cached yet, fetch from backend then copy
  var totalPages = Math.ceil(_lastResults.total / PAGE_SIZE);
  if (allRows.length < _lastResults.total) {
    toast('Fetching all rows for copy…', 'warn');
    var fetches = [];
    for (var p = 0; p < totalPages; p++) {
      if (!_lastResults.cachedPages[p]) {
        fetches.push(apiCall('get_result_page', p, PAGE_SIZE).then((function(pg) {
          return function(rows) { _lastResults.cachedPages[pg] = rows || []; };
        })(p)));
      }
    }
    Promise.all(fetches).then(function() { copyCsv(); }); // retry after fetching
    return;
  }
  // Build CSV string
  function csvEsc(v) {
    var s = String(v == null ? '' : v);
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }
  var lines = [cols.map(csvEsc).join(',')];
  allRows.forEach(function(row) {
    lines.push(cols.map(function(c) { return csvEsc(row[c]); }).join(','));
  });
  var csv = lines.join('\n');
  copyToClipboard(csv, '✓ ' + allRows.length.toLocaleString() + ' rows copied as CSV!');
}
/* ── PDF Export ─────────────────────────────────────────────────────── */
var _pdfDefaultDir = '';

function exportPdf() {
  if (!_lastResults || !_lastResults.total) { toast('Run a query first to have data to export.', 'warn'); return; }

  // Pre-fill the title with the active table name
  var titleEl = document.getElementById('pdf-title');
  if (titleEl) {
    var autoTitle = _activeTable
      ? (_selectedTables.length > 1 ? _selectedTables.join(' \u22c8 ') : _activeTable)
      : 'Query Results';
    titleEl.value = autoTitle;
  }

  // Fill the save path with stored default or request one from backend
  var pathEl = document.getElementById('pdf-save-path');
  if (pathEl) {
    if (_pdfDefaultDir) {
      pathEl.value = _pdfDefaultDir;
    } else {
      apiCall('get_default_downloads_dir').then(function(dir) {
        if (dir) { _pdfDefaultDir = dir; pathEl.value = dir; }
      }).catch(function() {});
    }
  }

  // Pre-fill CSS editor with saved default CSS
  var cssEl = document.getElementById('pdf-custom-css');
  if (cssEl) cssEl.value = _pdfCustomCss;

  // Show/hide CSS section based on dev mode
  var cssSection = document.getElementById('pdf-css-section');
  if (cssSection) cssSection.classList.toggle('hidden', !_pdfDevMode);

  // Restore html mode checkbox
  var useHtmlEl = document.getElementById('pdf-use-html');
  if (useHtmlEl) useHtmlEl.checked = false;

  openModal('modal-pdf-export');
}

/* ── PDF Presets & Default Style ─────────────────────────────────────── */
var PDF_PRESETS = {
  'executive': '/* ==========================================================================\\n   🏢 EXECUTIVE SLATE — Complete Style Template\\n   Inspired by Document_Template.html — High Data Density & Clean Elegance\\n   ========================================================================== */\\n:root {\\n  --paper: #ffffff;\\n  --screen-bg: #e7ebf0;\\n  --navy: #0f172a;\\n  --navy-light: #1e293b;\\n  --gold: #b7791f;\\n  --accent: #b7791f;\\n  --text: #111827;\\n  --muted: #64748b;\\n  --border: #cbd5e1;\\n  --border-light: #e2e8f0;\\n  --border-dark: #94a3b8;\\n  --row-alt: #f8fafc;\\n  --table-head-bg: #0f172a;\\n  --table-head-text: #ffffff;\\n  --header-bg: #f8fafc;\\n  --data-font-weight: 400;\\n}\\n\\n.pdf-page-sheet, .page {\\n  background: var(--paper);\\n  color: var(--text);\\n  font-family: \"Libron\", Georgia, serif;\\n}\\n.document-frame {\\n  border: 1.2px solid #9ca8b7;\\n}\\n.document-frame::after {\\n  border: 0.5px solid #e1e6eb;\\n}\\n\\n.school-header, .masthead {\\n  background: var(--header-bg);\\n  border: 1px solid var(--border);\\n  border-top: 3px solid var(--gold);\\n  border-radius: 10px;\\n  padding: 12px 20px;\\n  margin-bottom: 14px;\\n}\\n.school-logo, .report-logo {\\n  width: 60px;\\n  height: 60px;\\n}\\n.school-info h2, .org-title {\\n  color: var(--navy);\\n  font-family: \"Libron\", Georgia, serif;\\n  font-size: 21px;\\n  font-weight: 800;\\n  letter-spacing: -0.01em;\\n}\\n\\n.document-heading {\\n  border-bottom: 2px solid var(--navy);\\n  padding: 2px 0 10px;\\n  margin-bottom: 14px;\\n}\\n.heading-accent {\\n  background: var(--gold);\\n  width: 48px;\\n  height: 3px;\\n  border-radius: 4px;\\n}\\n.title, .report-title {\\n  color: var(--navy);\\n  font-family: \"Libron\", Georgia, serif;\\n  font-size: 22px;\\n  font-weight: 800;\\n}\\n\\n.data-table-wrap {\\n  margin-bottom: 12px;\\n}\\n.data-table {\\n  border: 1px solid var(--border);\\n  border-radius: 8px;\\n  font-size: 8.5pt;\\n  line-height: 1.3;\\n}\\n.data-table thead th {\\n  background: var(--table-head-bg);\\n  color: var(--table-head-text);\\n  border-bottom: 2px solid var(--gold);\\n  padding: 6px 7px;\\n  font-size: 8pt;\\n  font-weight: 700;\\n  text-transform: uppercase;\\n  letter-spacing: 0.03em;\\n}\\n.data-table tbody td {\\n  padding: 5px 7px;\\n  border-bottom: 1px solid var(--border-light);\\n  color: var(--text);\\n  font-variant-numeric: tabular-nums;\\n  word-break: break-word;\\n}\\n.data-table tbody tr:nth-child(even) {\\n  background: var(--row-alt);\\n}\\n.data-table tbody tr:hover {\\n  background: #f1f5f9;\\n}\\n\\n.report-footer {\\n  border-top: 1px solid var(--border-light);\\n  color: var(--muted);\\n  font-size: 7.5pt;\\n  padding-top: 8px;\\n  margin-top: 10px;\\n}',

  'minimal': '/* ==========================================================================\\n   📰 FINANCIAL MINIMAL — Complete Style Template\\n   High-Clarity Monospace Tabular Design with Crisp Borders\\n   ========================================================================== */\\n:root {\\n  --paper: #ffffff;\\n  --navy: #1e293b;\\n  --navy-light: #334155;\\n  --gold: #64748b;\\n  --accent: #64748b;\\n  --text: #0f172a;\\n  --muted: #64748b;\\n  --border: #cbd5e1;\\n  --border-light: #e2e8f0;\\n  --border-dark: #94a3b8;\\n  --row-alt: #f8fafc;\\n  --table-head-bg: #f1f5f9;\\n  --table-head-text: #0f172a;\\n  --header-bg: #ffffff;\\n  --data-font-weight: 400;\\n}\\n\\n.pdf-page-sheet, .page {\\n  background: var(--paper);\\n  color: var(--text);\\n  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif;\\n}\\n.document-frame {\\n  border: 1px solid #cbd5e1;\\n}\\n.document-frame::after {\\n  display: none;\\n}\\n\\n.school-header, .masthead {\\n  background: var(--header-bg);\\n  border: 1px solid var(--border);\\n  border-top: 3px solid var(--navy);\\n  border-radius: 6px;\\n  padding: 10px 18px;\\n  margin-bottom: 12px;\\n}\\n.school-info h2, .org-title {\\n  color: var(--navy);\\n  font-size: 19px;\\n  font-weight: 700;\\n  letter-spacing: -0.02em;\\n}\\n.document-heading {\\n  border-bottom: 1.5px solid var(--border);\\n  padding: 2px 0 8px;\\n  margin-bottom: 12px;\\n}\\n.heading-accent {\\n  background: var(--navy);\\n  width: 36px;\\n  height: 2px;\\n}\\n.title, .report-title {\\n  color: var(--navy);\\n  font-size: 20px;\\n  font-weight: 700;\\n}\\n\\n.data-table-wrap {\\n  margin-bottom: 12px;\\n}\\n.data-table {\\n  border: 1px solid var(--border);\\n  border-radius: 4px;\\n  font-size: 8pt;\\n  line-height: 1.35;\\n}\\n.data-table thead th {\\n  background: var(--table-head-bg);\\n  color: var(--table-head-text);\\n  border-bottom: 2px solid #94a3b8;\\n  padding: 5.5px 7px;\\n  font-size: 7.5pt;\\n  font-weight: 700;\\n  text-transform: uppercase;\\n  letter-spacing: 0.04em;\\n}\\n.data-table tbody td {\\n  padding: 4.5px 7px;\\n  border-bottom: 1px solid var(--border-light);\\n  color: var(--text);\\n  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;\\n  font-variant-numeric: tabular-nums;\\n  word-break: break-word;\\n}\\n.data-table tbody tr:nth-child(even) {\\n  background: #fafafa;\\n}\\n\\n.report-footer {\\n  border-top: 1px solid var(--border);\\n  color: var(--muted);\\n  font-size: 7pt;\\n  padding-top: 6px;\\n  margin-top: 8px;\\n  font-family: ui-monospace, monospace;\\n}',

  'emerald': '/* ==========================================================================\\n   🌲 EMERALD CORPORATE — Complete Style Template\\n   Prestigious Deep Forest Emerald with Mint Accents\\n   ========================================================================== */\\n:root {\\n  --paper: #ffffff;\\n  --navy: #064e3b;\\n  --navy-light: #065f46;\\n  --gold: #059669;\\n  --accent: #059669;\\n  --text: #062b21;\\n  --muted: #047857;\\n  --border: #a7f3d0;\\n  --border-light: #d1fae5;\\n  --border-dark: #6ee7b7;\\n  --row-alt: #f0fdf4;\\n  --table-head-bg: #064e3b;\\n  --table-head-text: #ffffff;\\n  --header-bg: #f0fdf4;\\n  --data-font-weight: 400;\\n}\\n\\n.pdf-page-sheet, .page {\\n  background: var(--paper);\\n  color: var(--text);\\n  font-family: \"Libron\", Georgia, serif;\\n}\\n.document-frame {\\n  border: 1.2px solid #6ee7b7;\\n}\\n.document-frame::after {\\n  border: 0.5px solid #a7f3d0;\\n}\\n\\n.school-header, .masthead {\\n  background: var(--header-bg);\\n  border: 1px solid var(--border);\\n  border-top: 3px solid #059669;\\n  border-radius: 10px;\\n  padding: 12px 20px;\\n  margin-bottom: 14px;\\n}\\n.school-info h2, .org-title {\\n  color: var(--navy);\\n  font-family: \"Libron\", Georgia, serif;\\n  font-size: 21px;\\n  font-weight: 800;\\n}\\n.document-heading {\\n  border-bottom: 2px solid var(--navy);\\n  padding: 2px 0 10px;\\n  margin-bottom: 14px;\\n}\\n.heading-accent {\\n  background: #059669;\\n  width: 48px;\\n  height: 3px;\\n  border-radius: 4px;\\n}\\n.title, .report-title {\\n  color: var(--navy);\\n  font-family: \"Libron\", Georgia, serif;\\n  font-size: 22px;\\n  font-weight: 800;\\n}\\n\\n.data-table-wrap {\\n  margin-bottom: 12px;\\n}\\n.data-table {\\n  border: 1px solid var(--border);\\n  border-radius: 8px;\\n  font-size: 8.5pt;\\n  line-height: 1.3;\\n}\\n.data-table thead th {\\n  background: var(--table-head-bg);\\n  color: var(--table-head-text);\\n  border-bottom: 2px solid #059669;\\n  padding: 6px 7px;\\n  font-size: 8pt;\\n  font-weight: 700;\\n  text-transform: uppercase;\\n}\\n.data-table tbody td {\\n  padding: 5px 7px;\\n  border-bottom: 1px solid var(--border-light);\\n  color: var(--text);\\n  font-variant-numeric: tabular-nums;\\n  word-break: break-word;\\n}\\n.data-table tbody tr:nth-child(even) {\\n  background: var(--row-alt);\\n}\\n.data-table tbody tr:hover {\\n  background: #e6fcf0;\\n}\\n\\n.report-footer {\\n  border-top: 1px solid var(--border);\\n  color: #065f46;\\n  font-size: 7.5pt;\\n  padding-top: 8px;\\n  margin-top: 10px;\\n}',

  'tech': '/* ==========================================================================\\n   🟣 MODERN TECH — Complete Style Template\\n   Indigo & Violet Executive Theme Inspired by Stripe and Linear\\n   ========================================================================== */\\n:root {\\n  --paper: #ffffff;\\n  --navy: #312e81;\\n  --navy-light: #3730a3;\\n  --gold: #6366f1;\\n  --accent: #6366f1;\\n  --text: #1e1b4b;\\n  --muted: #6366f1;\\n  --border: #c7d2fe;\\n  --border-light: #e0e7ff;\\n  --border-dark: #a5b4fc;\\n  --row-alt: #f5f3ff;\\n  --table-head-bg: #312e81;\\n  --table-head-text: #ffffff;\\n  --header-bg: #f5f3ff;\\n  --data-font-weight: 400;\\n}\\n\\n.pdf-page-sheet, .page {\\n  background: var(--paper);\\n  color: var(--text);\\n  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif;\\n}\\n.document-frame {\\n  border: 1.2px solid #a5b4fc;\\n}\\n.document-frame::after {\\n  border: 0.5px solid #c7d2fe;\\n}\\n\\n.school-header, .masthead {\\n  background: var(--header-bg);\\n  border: 1px solid var(--border);\\n  border-top: 3px solid #6366f1;\\n  border-radius: 10px;\\n  padding: 12px 20px;\\n  margin-bottom: 14px;\\n}\\n.school-info h2, .org-title {\\n  color: var(--navy);\\n  font-size: 20px;\\n  font-weight: 800;\\n  letter-spacing: -0.02em;\\n}\\n.document-heading {\\n  border-bottom: 2px solid var(--navy);\\n  padding: 2px 0 10px;\\n  margin-bottom: 14px;\\n}\\n.heading-accent {\\n  background: #6366f1;\\n  width: 44px;\\n  height: 3px;\\n  border-radius: 4px;\\n}\\n.title, .report-title {\\n  color: var(--navy);\\n  font-size: 21px;\\n  font-weight: 800;\\n}\\n\\n.data-table-wrap {\\n  margin-bottom: 12px;\\n}\\n.data-table {\\n  border: 1px solid var(--border);\\n  border-radius: 8px;\\n  font-size: 8.5pt;\\n  line-height: 1.3;\\n}\\n.data-table thead th {\\n  background: var(--table-head-bg);\\n  color: var(--table-head-text);\\n  border-bottom: 2px solid #6366f1;\\n  padding: 6px 7px;\\n  font-size: 8pt;\\n  font-weight: 700;\\n  text-transform: uppercase;\\n}\\n.data-table tbody td {\\n  padding: 5px 7px;\\n  border-bottom: 1px solid var(--border-light);\\n  color: var(--text);\\n  font-variant-numeric: tabular-nums;\\n  word-break: break-word;\\n}\\n.data-table tbody tr:nth-child(even) {\\n  background: var(--row-alt);\\n}\\n.data-table tbody tr:hover {\\n  background: #ede9fe;\\n}\\n\\n.report-footer {\\n  border-top: 1px solid var(--border);\\n  color: #4338ca;\\n  font-size: 7.5pt;\\n  padding-top: 8px;\\n  margin-top: 10px;\\n}',

  'compact': '/* ==========================================================================\\n   📏 DENSE COMPACT — Complete Style Template\\n   Engineered for Maximum Data Density (7-12 Columns on A4 Portrait)\\n   ========================================================================== */\\n:root {\\n  --paper: #ffffff;\\n  --navy: #0f172a;\\n  --navy-light: #1e293b;\\n  --gold: #b7791f;\\n  --accent: #b7791f;\\n  --text: #0f172a;\\n  --muted: #64748b;\\n  --border: #cbd5e1;\\n  --border-light: #e2e8f0;\\n  --border-dark: #94a3b8;\\n  --row-alt: #f8fafc;\\n  --table-head-bg: #0f172a;\\n  --table-head-text: #ffffff;\\n  --header-bg: #f8fafc;\\n  --data-font-weight: 400;\\n}\\n\\n.pdf-page-sheet, .page {\\n  background: var(--paper);\\n  color: var(--text);\\n  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif;\\n  padding: 8mm 10mm;\\n}\\n.document-frame {\\n  border: 1px solid #cbd5e1;\\n}\\n\\n.school-header, .masthead {\\n  background: var(--header-bg);\\n  border: 1px solid var(--border);\\n  border-top: 2.5px solid var(--gold);\\n  border-radius: 6px;\\n  padding: 8px 14px;\\n  margin-bottom: 8px;\\n}\\n.school-info h2, .org-title {\\n  color: var(--navy);\\n  font-size: 16px;\\n  font-weight: 700;\\n}\\n.document-heading {\\n  border-bottom: 1.5px solid var(--navy);\\n  padding: 1px 0 6px;\\n  margin-bottom: 8px;\\n}\\n.heading-accent {\\n  background: var(--gold);\\n  width: 36px;\\n  height: 2px;\\n}\\n.title, .report-title {\\n  color: var(--navy);\\n  font-size: 17px;\\n  font-weight: 700;\\n}\\n\\n.data-table-wrap {\\n  margin-bottom: 8px;\\n}\\n.data-table {\\n  border: 1px solid var(--border);\\n  border-radius: 4px;\\n  font-size: 8pt;\\n  line-height: 1.25;\\n}\\n.data-table thead th {\\n  background: var(--table-head-bg);\\n  color: var(--table-head-text);\\n  border-bottom: 1.5px solid var(--gold);\\n  padding: 4px 5px;\\n  font-size: 7.5pt;\\n  font-weight: 700;\\n  text-transform: uppercase;\\n}\\n.data-table tbody td {\\n  padding: 3.5px 5px;\\n  border-bottom: 1px solid var(--border-light);\\n  color: var(--text);\\n  font-variant-numeric: tabular-nums;\\n  word-break: break-word;\\n}\\n.data-table tbody tr:nth-child(even) {\\n  background: var(--row-alt);\\n}\\n\\n.report-footer {\\n  border-top: 1px solid var(--border-light);\\n  color: var(--muted);\\n  font-size: 7pt;\\n  padding-top: 5px;\\n  margin-top: 6px;\\n}'
};
window.PDF_PRESETS = PDF_PRESETS;

function applyPdfPreset(name) {
  if (!PDF_PRESETS[name]) return;
  var useHtml = document.getElementById('pdf-use-html');
  if (useHtml) useHtml.checked = true;
  var section = document.getElementById('pdf-css-section');
  if (section) section.classList.remove('hidden');
  var cssEl = document.getElementById('pdf-custom-css');
  if (cssEl) cssEl.value = PDF_PRESETS[name];
  toast('Applied complete preset: ' + name);
}

function resetPdfCustomCssToDefault() {
  var defCss = PDF_PRESETS['executive'];
  var sInp = document.getElementById('s-pdf-custom-css');
  if (sInp) sInp.value = defCss;
  var pdfCssInp = document.getElementById('pdf-custom-css');
  if (pdfCssInp) pdfCssInp.value = defCss;
  _pdfCustomCss = defCss;
  toast('Reset to default executive template');
}

function savePdfCssAsDefault() {
  var cssEl = document.getElementById('pdf-custom-css');
  var css = cssEl ? cssEl.value : '';
  _pdfCustomCss = css;
  var sInp = document.getElementById('s-pdf-custom-css');
  if (sInp) sInp.value = css;
  apiCall('save_settings', { pdf_custom_css: css })
    .then(function() {
      toast('✓ Saved as default PDF style');
    })
    .catch(function(e) {
      toast('Failed to save default style: ' + (e.message || e), 'error');
    });
}

/* ── PDF Dev mode / HTML mode toggles ───────────────────────────────── */
function togglePdfDevMode(checked) {
  _pdfDevMode = checked;
  var cssSection = document.getElementById('pdf-css-section');
  if (cssSection && checked) cssSection.classList.remove('hidden');
}
function togglePdfHtmlMode(checked) {
  var cssSection = document.getElementById('pdf-css-section');
  if (cssSection) cssSection.classList.toggle('hidden', !checked && !_pdfDevMode);
}

/* ── Copy PDF Requirement (AI template) ─────────────────────────────── */
function copyPdfRequirement() {
  var titleEl = document.getElementById('pdf-title');
  var sizeEl  = document.getElementById('pdf-page-size');
  var orntEl  = document.getElementById('pdf-orientation');
  var orgEl   = document.getElementById('s-org-name');

  var title   = (titleEl && titleEl.value) || 'Query Results';
  var size    = (sizeEl  && sizeEl.value)  || 'A4';
  var orient  = (orntEl  && orntEl.value)  || 'portrait';
  var orgName = (orgEl   && orgEl.value)   || '';
  var landscape = orient === 'landscape';
  var dims = { 'A4': ['210mm', '297mm'], 'A3': ['297mm', '420mm'], 'Letter': ['216mm', '279mm'] }[size] || ['210mm', '297mm'];
  var w = landscape ? dims[1] : dims[0];
  var h = landscape ? dims[0] : dims[1];

  var cols = (_lastResults && _lastResults.columns && _lastResults.columns.length)
    ? _lastResults.columns
    : ((typeof _lastResultCols !== 'undefined' && _lastResultCols && _lastResultCols.length) ? _lastResultCols : ['id', 'name', 'value']);

  var avgPct = cols.length > 0 ? Math.floor(100 / cols.length) : 20;
  var colWidthList = cols.map(function(c, i) {
    return '  - Column ' + (i + 1) + ' (`' + c + '`): ' + avgPct + '%';
  }).join('\n');

  var prompt = [
    '# Querii Executive PDF Custom CSS — AI Generation Specification',
    '',
    'You are generating custom CSS for an executive-grade PDF export in Querii. The report is rendered with headless Chromium via strict CSS Paged Media standards.',
    'Your custom CSS is injected at the very end of the stylesheet, giving you 100% cascade power to customize styling, layout, colors, element positions, borders, and typography.',
    '',
    '## 1. Document Context & Geometry (MUST Honor Selected Paper)',
    '- Page Size: ' + size + ' (' + w + ' × ' + h + ')',
    '- Orientation: ' + orient + (landscape ? ' (Landscape mode)' : ' (Portrait mode)'),
    '- Mandatory @page Rule: `@page { size: ' + size + ' ' + orient + '; margin: 10mm 12mm 12mm 12mm; }`',
    '- Document Title: "' + title + '"',
    '- Organisation: "' + (orgName || 'Querii') + '"',
    '- Total Columns (' + cols.length + '): ' + cols.join(', '),
    '',
    '### Active Columns & Recommended Proportional Widths:',
    colWidthList,
    '',
    '## 2. Complete HTML Architecture (Classes & Hierarchy)',
    '```html',
    '<main class="pdf-page-sheet page">',
    '  <!-- Outer Decorative Frame -->',
    '  <div class="document-frame" aria-hidden="true"></div>',
    '',
    '  <!-- Dense Repeating Watermark (Repeats across all pages in print) -->',
    '  <div class="watermark-area" id="watermarkArea" aria-hidden="true">',
    '    <div class="watermark-text" id="watermarkText">',
    '      <div class="watermark-row"><span class="watermark-item">' + (orgName || 'QUERII').toUpperCase() + ' • </span>...</div>',
    '    </div>',
    '    <div class="logo-watermark-zone">',
    '      <img src="..." class="logo-watermark" alt="">',
    '    </div>',
    '  </div>',
    '',
    '  <!-- Organisation Header (Clean Masthead: Logo + Organisation Name ONLY) -->',
    '  <header class="school-header masthead">',
    '    <img src="..." class="school-logo report-logo" alt="Logo">',
    '    <div class="school-info">',
    '      <h2 class="org-title">' + (orgName || 'Querii') + '</h2>',
    '    </div>',
    '  </header>',
    '',
    '  <!-- Document Heading (Accent Bar + Report Title ONLY) -->',
    '  <section class="document-heading">',
    '    <div class="heading-accent"></div>',
    '    <h1 class="title report-title">' + title + '</h1>',
    '  </section>',
    '',
    '  <!-- Data Table (Compact formation engineered to fit 7-8 columns cleanly) -->',
    '  <div class="data-table-wrap">',
    '    <table class="data-table (optional .grid-lines)">',
    '      <colgroup>',
    cols.map(function(c, i) { return '        <col class="col-' + i + '" data-col="' + c + '" style="width:' + avgPct + '%">'; }).join('\n'),
    '      </colgroup>',
    '      <thead>',
    '        <tr>',
    cols.map(function(c, i) { return '          <th data-col="' + c + '" data-idx="' + i + '"><span class="th-content">' + c + '</span></th>'; }).join('\n'),
    '        </tr>',
    '      </thead>',
    '      <tbody>',
    '        <tr class="even">',
    cols.map(function(c) { return '          <td data-col="' + c + '">Data</td>'; }).join('\n'),
    '        </tr>',
    '        <tr class="odd">...</tr>',
    '      </tbody>',
    '    </table>',
    '  </div>',
    '',
    '  <!-- Footer (Timestamp & Page Number only in small font) -->',
    '  <footer class="report-footer">',
    '    <div class="footer-timestamp">Generated: 10 Oct 2026, 07:05 PM</div>',
    '    <div class="footer-page">Page 1 of 1</div>',
    '  </footer>',
    '',
    '  <!-- Optional SQL Query Box -->',
    '  <section class="sql-block">',
    '    <div class="sql-label">SQL Query</div>',
    '    <pre class="sql-pre">SELECT * FROM ...</pre>',
    '  </section>',
    '</main>',
    '```',
    '',
    '## 3. Formatting Guidelines for High Data Density (7-8 Columns on A4)',
    '- Table Font Size: Use `8.5pt` to `9pt` (11px to 12px) for high readability.',
    '- Cell Padding: Use compact padding (`4.5px 6px` to `5px 7px`) so text fills columns nicely with minimal wasted margin.',
    '- Header: Keep ONLY organisation name and report title (NO extra kickers or audit sub-lines).',
    '- Footer: Keep ONLY timestamp on left and page number on right in small font.',
    '- Watermark: Dense repeating text filling the background across all pages.',
    '- Container width: Always use `width: 100%; max-width: 100%;` so it scales automatically with ' + size + ' ' + orient + '.',
    '',
    '## 4. CSS Variables Available to Override (:root)',
    '```css',
    ':root {',
    '  --paper: #ffffff;',
    '  --navy: #0f172a;             /* Primary brand color for headings & masthead */',
    '  --navy-light: #1e293b;       /* Secondary brand tint */',
    '  --gold: #b7791f;             /* Accent line bar and highlight borders */',
    '  --accent: #b7791f;',
    '  --text: #111827;             /* Base body text */',
    '  --muted: #64748b;            /* Secondary labels & timestamp */',
    '  --border: #cbd5e1;           /* Table cell borders */',
    '  --border-light: #e2e8f0;     /* Hairline table rows */',
    '  --row-alt: #f8fafc;          /* Alternating zebra row tint */',
    '  --table-head-bg: #0f172a;    /* Table header background */',
    '  --table-head-text: #ffffff;  /* Table header text color */',
    '  --header-bg: #f8fafc;        /* School/Organisation masthead background */',
    '  --data-font-weight: 400;     /* Table body text weight (400 regular, 700 bold) */',
    '}',
    '```',
    '',
    '## 5. HARD EXCEPTIONS & CRITICAL RULES (Follow Strictly)',
    '1. ⛔ NO `position: fixed` or `position: absolute` on table elements (`table`, `thead`, `tbody`, `tr`, `td`): Chromium Paged Media pagination breaks completely across page boundaries if table rows or cells are positioned absolutely.',
    '2. ⛔ NO external web fonts via `@import url(...)` or `<link>`: PDF compilation runs offline. Use bundled `Libron, Georgia, serif` or modern sans-serif: `ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`.',
    '3. ⛔ NO fixed pixel table widths (e.g. `width: 900px`): Always use `width: 100%` or percentage column widths to scale with ' + size + ' ' + orient + '.',
    '4. ⛔ NO `break-inside: avoid` on the entire `.data-table` or `.data-table-wrap`: The table MUST be allowed to paginate cleanly across multiple pages (`page-break-inside: auto`). Only individual rows `<tr>` have `break-inside: avoid;`.',
    '5. ⛔ NO `overflow: hidden` on `html` or `body`: Setting `overflow: hidden` on root elements disables Chromium print pagination and clips the entire document to page 1.',
    '6. ⛔ Pure Declarative CSS Only: Do NOT include `<script>`, HTML markup, or markdown explanations outside the code block. Output valid CSS inside ```css ... ```.',
    '',
    '## 6. Complete Working Baseline CSS Reference Template:',
    '```css',
    '@page {',
    '  size: ' + size + ' ' + orient + ';',
    '  margin: 10mm 12mm 12mm 12mm;',
    '}',
    '',
    ':root {',
    '  --paper: #ffffff;',
    '  --navy: #0f172a;',
    '  --gold: #b7791f;',
    '  --text: #111827;',
    '  --muted: #64748b;',
    '  --border: #cbd5e1;',
    '  --border-light: #e2e8f0;',
    '  --row-alt: #f8fafc;',
    '  --table-head-bg: #0f172a;',
    '  --table-head-text: #ffffff;',
    '  --header-bg: #f8fafc;',
    '}',
    '',
    '.pdf-page-sheet, .page {',
    '  background: var(--paper);',
    '  color: var(--text);',
    '  font-family: "Libron", Georgia, serif;',
    '}',
    '',
    '.school-header, .masthead {',
    '  background: var(--header-bg);',
    '  border: 1px solid var(--border);',
    '  border-top: 3px solid var(--gold);',
    '  border-radius: 10px;',
    '  padding: 12px 20px;',
    '  margin-bottom: 14px;',
    '}',
    '.school-info h2, .org-title {',
    '  color: var(--navy);',
    '  font-family: "Libron", Georgia, serif;',
    '  font-size: 21px;',
    '  font-weight: 800;',
    '}',
    '',
    '.document-heading {',
    '  border-bottom: 2px solid var(--navy);',
    '  padding: 2px 0 10px;',
    '  margin-bottom: 14px;',
    '}',
    '.heading-accent {',
    '  background: var(--gold);',
    '  width: 48px;',
    '  height: 3px;',
    '  border-radius: 4px;',
    '}',
    '.title, .report-title {',
    '  color: var(--navy);',
    '  font-family: "Libron", Georgia, serif;',
    '  font-size: 22px;',
    '  font-weight: 800;',
    '}',
    '',
    '.data-table {',
    '  border: 1px solid var(--border);',
    '  border-radius: 8px;',
    '  font-size: 8.5pt;',
    '  line-height: 1.3;',
    '}',
    '.data-table thead th {',
    '  background: var(--table-head-bg);',
    '  color: var(--table-head-text);',
    '  border-bottom: 2px solid var(--gold);',
    '  padding: 6px 7px;',
    '  font-size: 8pt;',
    '  font-weight: 700;',
    '  text-transform: uppercase;',
    '}',
    '.data-table tbody td {',
    '  padding: 5px 7px;',
    '  border-bottom: 1px solid var(--border-light);',
    '  color: var(--text);',
    '  font-variant-numeric: tabular-nums;',
    '}',
    '.data-table tbody tr:nth-child(even) {',
    '  background: var(--row-alt);',
    '}',
    '',
    '.report-footer {',
    '  border-top: 1px solid var(--border-light);',
    '  color: var(--muted);',
    '  font-size: 7.5pt;',
    '  padding-top: 8px;',
    '  margin-top: 10px;',
    '}',
    '```'
  ].join('\n');

  copyToClipboard(prompt, '✓ AI requirement copied to clipboard! Paste it into any AI to generate custom PDF CSS.');
}

/* ── PDF folder chooser ────────────────────────────────────────────── */
function choosePdfFolder() {
  apiCall('choose_folder_dialog').then(function(dir) {
    if (!dir) return;
    _pdfDefaultDir = dir;
    var pathEl = document.getElementById('pdf-save-path');
    if (pathEl) pathEl.value = dir;
    // Persist as setting
    apiCall('save_settings', { ap_pdf_dir: dir }).catch(function() {});
  }).catch(function(e) { toast('Could not open folder dialog: ' + e.message, 'error'); });
}

function toggleContinuousMode(checked) {
  var sizeEl   = document.getElementById('pdf-page-size');
  var orientEl = document.getElementById('pdf-orientation');
  if (sizeEl)   { sizeEl.disabled   = checked; sizeEl.style.opacity   = checked ? '0.4' : '1'; }
  if (orientEl) { orientEl.disabled = checked; orientEl.style.opacity = checked ? '0.4' : '1'; }
}

function confirmExportPdf() {
  var titleEl   = document.getElementById('pdf-title');
  var pathEl    = document.getElementById('pdf-save-path');
  var sizeEl    = document.getElementById('pdf-page-size');
  var orientEl  = document.getElementById('pdf-orientation');
  var scaleEl   = document.getElementById('pdf-scale');
  var contEl    = document.getElementById('pdf-continuous');
  var inclQEl   = document.getElementById('pdf-include-query');
  var inclSEl   = document.getElementById('pdf-include-source');
  var useHtmlEl = document.getElementById('pdf-use-html');
  var cssEl     = document.getElementById('pdf-custom-css');

  var title     = (titleEl ? titleEl.value.trim() : '') || 'Query Results';
  var saveDir   = pathEl ? pathEl.value.trim() : '';
  var pageSize  = sizeEl ? sizeEl.value : 'A4';
  var orient    = orientEl ? orientEl.value : 'portrait';
  var scale     = parseFloat(scaleEl ? scaleEl.value : '1.0') || 1.0;
  var continuous = contEl ? contEl.checked : false;
  var inclQuery = inclQEl ? inclQEl.checked : true;
  var inclSource = inclSEl ? inclSEl.checked : true;
  var useHtml   = useHtmlEl ? useHtmlEl.checked : false;
  var customCss = cssEl ? cssEl.value.trim() : '';

  if (!saveDir) { toast('Please choose a save location first.', 'warn'); return; }

  // Sanitize file name from title
  var safeName = title.replace(/[^a-zA-Z0-9 _\-().]/g, '_').trim() || 'querii_export';
  // Build path safely: strip trailing sep, then re-join with OS separator detected from the path
  var sep = (saveDir.indexOf('\\') !== -1) ? '\\' : '/';
  var filepath  = saveDir.replace(/[\/\\]$/, '') + sep + safeName + '.pdf';

  // Save folder as default
  _pdfDefaultDir = saveDir;
  apiCall('save_settings', { ap_pdf_dir: saveDir }).catch(function() {});

  var org   = (document.getElementById('s-org-name') || {}).value || '';
  // Prefer square logo for PDF (it's used as the circular header logo)
  var sqEl  = document.getElementById('logo-sq-img');
  var imgEl = document.getElementById('logo-img');
  var logo  = (sqEl  && sqEl.src  && sqEl.src.indexOf('base64,')  !== -1) ? sqEl.src.replace(/^data:[^;]+;base64,/, '')  :
              (imgEl && imgEl.src && imgEl.src.indexOf('base64,') !== -1) ? imgEl.src.replace(/^data:[^;]+;base64,/, '') : '';
  var sql   = inclQuery ? ((document.getElementById('sql-editor') || {}).value || '') : '';
  var sourceLabel = inclSource ? (_selectedTables.length > 1 ? _selectedTables.join(', ') : _activeTable) : '';


  var boldEl    = document.getElementById('pdf-bold-data');
  var gridEl    = document.getElementById('pdf-grid-lines');
  var boldData  = boldEl ? boldEl.checked : false;
  var gridLines = gridEl ? gridEl.checked : false;

  closeModal();
  showProgress(true);
  toast('⚡ Generating PDF…', 'info');

  var apiMethod = useHtml ? 'export_pdf_html' : 'export_pdf';
  if (useHtml) {
    var visArr = (typeof _dev !== 'undefined' && _dev.colVisible) ? Array.from(_dev.colVisible) : null;
    var cWidths = (typeof _dev !== 'undefined') ? _dev.colWidths : {};
    var cHeads  = (typeof _dev !== 'undefined') ? _dev.colHeaders : {};
    var cFullO  = (typeof _dev !== 'undefined') ? _dev.fullOverride : false;
    var cBold   = (typeof _dev !== 'undefined' && _dev.boldData !== undefined) ? _dev.boldData : boldData;
    var cGrid   = (typeof _dev !== 'undefined' && _dev.showGridLines !== undefined) ? _dev.showGridLines : gridLines;

    apiCall('export_pdf_html', filepath, title, org, logo, sql, sourceLabel, customCss, pageSize, orient, cWidths, cHeads, visArr, cFullO, cBold, cGrid)
      .then(function(r) { showProgress(false); if (r) toast('✓ PDF saved: ' + safeName + '.pdf'); })
      .catch(function(e) { showProgress(false); toast('Export failed: ' + e.message, 'error'); });
  } else {
    apiCall('export_pdf', filepath, title, "", org, logo, sql, null, pageSize, orient, scale, continuous, sourceLabel)
      .then(function(r) { showProgress(false); if (r) toast('✓ PDF saved: ' + safeName + '.pdf'); })
      .catch(function(e) { showProgress(false); toast('Export failed: ' + e.message, 'error'); });
  }
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

    // Always keep global schema cache in sync — this is what makes
    // schema panel work when selecting tables after a fresh app launch
    _allSchemaData = schema;
    renderSchemaTree(schema);

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
  _activeTable = name;
  // Make sure schema is up to date before switching
  if (!_allSchemaData.length) {
    apiCall('get_schema').then(function(schema) {
      _allSchemaData = schema || [];
      renderSchemaTree(_allSchemaData);
    });
  } else {
    renderSchemaTree(_allSchemaData);
  }
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
  runFilter();
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

/* ── Resize handles ────────────────────────────────────────────────────── */
function initResizableHandles() {
  setupHandleH('rh-left',  'panel-filter', 'left');
  setupHandleH('rh-right', 'panel-quick',  'right');
  setupHandleV('rh-sql',   'sql-panel');
}

function setupHandleH(hId, pId, side) {
  var handle = document.getElementById(hId);
  var panel  = document.getElementById(pId);
  if (!handle || !panel) return;
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    var sx = e.clientX, sw = panel.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    function onMove(ev) {
      var delta = side === 'left' ? ev.clientX - sx : sx - ev.clientX;
      var nw = Math.max(220, Math.min(600, sw + delta));
      panel.style.width = nw + 'px';
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

function setupHandleV(hId, pId) {
  var handle = document.getElementById(hId);
  var panel  = document.getElementById(pId);
  if (!handle || !panel) return;
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    var sy = e.clientY, sh = panel.offsetHeight;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
    function onMove(ev) {
      var nh = Math.max(60, Math.min(window.innerHeight - 150, sh + ev.clientY - sy));
      panel.style.height = nh + 'px';
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
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

  // SQL editor — with manual undo/redo stack for Ctrl+Z / Ctrl+Y
  var sqlEd = document.getElementById('sql-editor');
  if (sqlEd) {
    var _sqlHistory = [sqlEd.value], _sqlHistIdx = 0;
    function _sqlPush() {
      var cur = sqlEd.value;
      if (cur === _sqlHistory[_sqlHistIdx]) return;
      _sqlHistory = _sqlHistory.slice(0, _sqlHistIdx + 1);
      _sqlHistory.push(cur);
      if (_sqlHistory.length > 200) _sqlHistory.shift();
      _sqlHistIdx = _sqlHistory.length - 1;
    }
    sqlEd.addEventListener('input', function() { syncSqlLines(); _sqlPush(); });
    sqlEd.addEventListener('scroll', function() {
      var ln = document.getElementById('sql-lines');
      if (ln) ln.scrollTop = sqlEd.scrollTop;
    });
    sqlEd.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(); return; }
      // Undo
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        if (_sqlHistIdx > 0) {
          _sqlHistIdx--;
          sqlEd.value = _sqlHistory[_sqlHistIdx];
          syncSqlLines();
        }
        return;
      }
      // Redo: Ctrl+Y or Ctrl+Shift+Z
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
        e.preventDefault();
        if (_sqlHistIdx < _sqlHistory.length - 1) {
          _sqlHistIdx++;
          sqlEd.value = _sqlHistory[_sqlHistIdx];
          syncSqlLines();
        }
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        var s = sqlEd.selectionStart;
        sqlEd.value = sqlEd.value.slice(0, s) + '  ' + sqlEd.value.slice(sqlEd.selectionEnd);
        sqlEd.selectionStart = sqlEd.selectionEnd = s + 2;
        syncSqlLines();
        _sqlPush();
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
    if (s.org_logo_sq_b64) setLogoSqPreview(s.org_logo_sq_b64);


    if (s.pdf_custom_css && s.pdf_custom_css.trim()) {
      _pdfCustomCss = s.pdf_custom_css;
      var cssInp = document.getElementById('s-pdf-custom-css');
      if (cssInp) cssInp.value = s.pdf_custom_css;
    } else {
      _pdfCustomCss = (typeof PDF_PRESETS !== 'undefined' && PDF_PRESETS.executive) ? PDF_PRESETS.executive : '';
      var cssInp = document.getElementById('s-pdf-custom-css');
      if (cssInp) cssInp.value = _pdfCustomCss;
    }
    if (s.pdf_dev_mode) {
      _pdfDevMode = s.pdf_dev_mode === '1';
      var devInp = document.getElementById('s-pdf-dev-mode');
      if (devInp) devInp.checked = _pdfDevMode;
    }

    if (s.ap_custom_reports) {
      try { _customReports = JSON.parse(s.ap_custom_reports) || []; } catch(e) { _customReports = []; }
    }
    loadCustomReports();

    // Restore saved PDF default directory
    if (s.ap_pdf_dir) { _pdfDefaultDir = s.ap_pdf_dir; }

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

/* ══════════════════════════════════════════════════════════════════════════
   DATABASE ADMIN PANEL (Settings → Advanced tab)
   ══════════════════════════════════════════════════════════════════════════ */
function dbRunSql() {
  var sql = (document.getElementById('db-raw-sql') || {}).value || '';
  if (!sql.trim()) return;
  var resEl = document.getElementById('db-result');
  if (resEl) resEl.textContent = 'Running…';
  apiCall('execute_raw_sql', sql)
    .then(function(r) {
      if (!r) { if (resEl) resEl.textContent = 'No response'; return; }
      var d = r;
      if (d.message) {
        if (resEl) resEl.textContent = d.message;
        toast('✓ ' + d.message);
        return;
      }
      if (d.columns && d.columns.length) {
        var lines = [d.columns.join('\t')];
        (d.rows || []).forEach(function(row) {
          lines.push(d.columns.map(function(c) { return String(row[c] != null ? row[c] : 'NULL'); }).join('\t'));
        });
        if (resEl) resEl.textContent = lines.join('\n') + '\n\n(' + d.rows.length + ' row' + (d.rows.length !== 1 ? 's' : '') + ')';
      } else {
        if (resEl) resEl.textContent = 'Query OK — ' + (d.affected || 0) + ' row(s) affected';
      }
    })
    .catch(function(e) {
      if (resEl) resEl.textContent = '❌ Error: ' + e.message;
      toast('SQL error: ' + e.message, 'error');
    });
}

function dbDropAllTables() {
  if (!confirm('Drop ALL imported tables? This cannot be undone.')) return;
  apiCall('drop_all_tables')
    .then(function(r) {
      var msg = r || 'Done';
      var resEl = document.getElementById('db-result');
      if (resEl) resEl.textContent = msg;
      toast('✓ ' + msg);
      setTimeout(function() { location.reload(); }, 1400);
    })
    .catch(function(e) { toast(e.message, 'error'); });
}

function dbVacuum() {
  apiCall('vacuum_database')
    .then(function(r) {
      var resEl = document.getElementById('db-result');
      if (resEl) resEl.textContent = r || 'VACUUM complete';
      toast('✓ VACUUM complete');
    })
    .catch(function(e) { toast(e.message, 'error'); });
}

function dbDeleteDatabase() {
  if (!confirm('DELETE the entire Querii database?\n\nThis removes ALL imported data, settings, and query history. This cannot be undone.')) return;
  apiCall('delete_database')
    .then(function() {
      toast('Database deleted. Reloading…');
      setTimeout(function() { location.reload(); }, 1500);
    })
    .catch(function(e) { toast(e.message, 'error'); });
}

/* ══════════════════════════════════════════════════════════════════════════
   ULTRA DEV MODE — Overlay CSS injected at runtime
   ══════════════════════════════════════════════════════════════════════════ */
(function injectDevModeStyles() {
  var s = document.createElement('style');
  s.id = 'dev-mode-styles';
  s.textContent = [
    '#ultra-dev-overlay.hidden { display:none!important; }',
    '.dev-field-row{display:flex;align-items:center;gap:12px;margin-bottom:12px}',
    '.dev-lbl{font-size:11px;font-weight:700;color:#64748b;min-width:90px;flex-shrink:0}',
    '.dev-input,.dev-select{flex:1;background:#f8fafc;color:#1e293b;border:1px solid #cbd5e1;border-radius:6px;padding:6px 10px;font-size:12px;transition:all .15s}',
    '.dev-input:focus,.dev-select:focus{outline:none;border-color:#6366f1;box-shadow:0 0 0 2px rgba(99,102,241,.2);background:#fff}',
    '.dev-radio-group{display:flex;gap:8px}',
    '.dev-radio{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#64748b;cursor:pointer;padding:5px 12px;border-radius:6px;border:1px solid #cbd5e1;background:#f8fafc;transition:all .15s}',
    '.dev-radio.active{color:#4338ca;border-color:#6366f1;background:#e0e7ff}',
    '.dev-radio input[type=radio]{display:none}',
    '.dev-cb{width:16px;height:16px;accent-color:#6366f1;cursor:pointer}',
    '.dev-col-list{display:flex;flex-direction:column;gap:8px}',
    '.dev-col-row{background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;padding:10px 14px;transition:opacity .15s, box-shadow .15s}',
    '.dev-col-row:hover{box-shadow:0 2px 4px rgba(0,0,0,.02)}',
    '.dev-col-row.dev-col-hidden{opacity:.5;background:#f1f5f9}',
    '.dev-col-vis{display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px}',
    '.dev-col-vis input[type=checkbox]{accent-color:#6366f1;width:15px;height:15px;flex-shrink:0}',
    '.dev-col-name{font-size:12px;font-weight:800;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px}',
    '.dev-col-hdr{width:100%;background:#fff;border:1px solid #e2e8f0;border-radius:4px;padding:4px 8px;font-size:11px;margin-bottom:8px;color:#334155;transition:border-color .15s}',
    '.dev-col-hdr:focus{outline:none;border-color:#6366f1}',
    '.dev-col-width-wrap{display:flex;align-items:center;gap:12px}',
    '.dev-slider{flex:1;accent-color:#6366f1}',
    '.dev-width-lbl{font-size:11px;font-family:"JetBrains Mono",monospace;color:#64748b;min-width:36px;text-align:right}',
    '.dev-empty{font-size:11px;color:#94a3b8;font-style:italic;padding:12px;text-align:center}',
    '.dev-btn{font-size:11px;font-weight:600;padding:5px 12px;border-radius:6px;background:#fff;color:#475569;border:1px solid #cbd5e1;cursor:pointer;transition:all .15s}',
    '.dev-btn:hover{background:#f1f5f9;color:#0f172a}',
    '.dev-btn-primary{background:#3b82f6;color:#fff;border-color:#2563eb}',
    '.dev-btn-primary:hover{background:#2563eb;color:#fff}',
    '.dev-btn-sm{padding:3px 8px;font-size:10px}',
    '.dev-file-tabs{display:flex;gap:4px;margin-bottom:12px;border-bottom:1px solid #cbd5e1}',
    '.dev-file-tab{padding:6px 14px;font-size:11px;font-weight:700;color:#64748b;background:transparent;border:none;border-bottom:2px solid transparent;cursor:pointer;transition:all .15s}',
    '.dev-file-tab.active{color:#4338ca;border-bottom-color:#6366f1}',
    '.dev-file-tab:hover:not(.active){color:#334155;background:#f8fafc;border-radius:4px 4px 0 0}',
    '.dev-file-area{width:100%;height:180px;background:#f8fafc;color:#1e293b;border:1px solid #cbd5e1;border-radius:8px;padding:12px;font-family:"JetBrains Mono",monospace;font-size:11px;resize:vertical;margin-bottom:12px}',
    '.dev-file-area:focus{outline:none;border-color:#6366f1;box-shadow:inset 0 0 0 1px #6366f1}',
    '.dev-file-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.dev-dir-path{font-size:11px;color:#64748b;margin-bottom:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#f8fafc;padding:6px 10px;border-radius:6px;border:1px solid #e2e8f0}',
    '@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
    '#dev-preview-spinner:not(.hidden){display:inline-block;animation:spin 1s linear infinite}',
    'details summary::-webkit-details-marker{display:none}',
    'details>summary{list-style:none}',
  ].join('\n');
  document.head.appendChild(s);
})();
