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
  document.querySelectorAll('.modal').forEach(function(m) { m.classList.add('hidden'); });
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
var _allQueryLogs = [];
var _displayedQueryLogs = [];

function loadQueryLog() {
  var c = document.getElementById('query-log-list');
  if (!c) return;
  c.innerHTML = '<div style="padding:12px;text-align:center;font-size:11px;color:var(--text-dim)">Loading…</div>';
  var searchInp = document.getElementById('qlog-search');
  if (searchInp) searchInp.value = '';
  apiCall('get_query_log')
    .then(function(logs) {
      _allQueryLogs = logs || [];
      renderQueryLogList(_allQueryLogs);
    }).catch(function(e) {
      c.innerHTML = '<div style="padding:20px;text-align:center;font-size:11px;color:var(--danger)">Error loading log: ' + esc(e.message) + '</div>';
    });
}

function filterQueryLog(term) {
  term = (term || '').trim().toLowerCase();
  if (!term) {
    renderQueryLogList(_allQueryLogs);
    return;
  }
  var filtered = _allQueryLogs.filter(function(q) {
    var matchSql = (q.sql_text || '').toLowerCase().indexOf(term) !== -1;
    var matchBs = false;
    if (q.builder_state) {
      try {
        var bs = typeof q.builder_state === 'string' ? JSON.parse(q.builder_state) : q.builder_state;
        if (bs.table && bs.table.toLowerCase().indexOf(term) !== -1) matchBs = true;
      } catch(e) {}
    }
    return matchSql || matchBs;
  });
  renderQueryLogList(filtered);
}

function renderQueryLogList(logs) {
  var c = document.getElementById('query-log-list');
  if (!c) return;
  _displayedQueryLogs = logs || [];
  if (!_displayedQueryLogs.length) {
    c.innerHTML = '<div style="padding:20px;text-align:center;font-size:11px;color:var(--text-dim)">No matching queries found.</div>';
    return;
  }
  c.innerHTML = '';
  _displayedQueryLogs.forEach(function(q, i) {
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
}

function useQueryLog(idx) {
  var q = _displayedQueryLogs[idx];
  if (!q) return;
  var sql = q.sql_text;

  // 1) Paste into SQL editor
  var ed = document.getElementById('sql-editor');
  if (ed) { ed.value = sql; syncSqlLines(); }

  // 2) Rehydrate visual query builder ONLY if query was generated by visual builder
  if (q.builder_state) {
    try {
      var bs = typeof q.builder_state === 'string' ? JSON.parse(q.builder_state) : q.builder_state;
      restoreVisualBuilder(bs);
    } catch(e) {
      console.error('Failed to restore builder state:', e);
    }
  }

  // 3) Copy to clipboard
  copyToClipboard(sql, 'Query loaded into editor and copied');
  // 4) Close modal
  closeModal();

  setTimeout(function() {
    var sqlPanel = document.getElementById('sql-panel');
    if (sqlPanel) sqlPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    var ed2 = document.getElementById('sql-editor');
    if (ed2) ed2.focus();
  }, 150);
  toast('✓ Query pasted to editor' + (q.builder_state ? ' & visual builder restored!' : '!'));
}

function restoreVisualBuilder(bs) {
  if (!bs || !bs.table) return;
  _activeTable = bs.table;
  _selectedTables = bs.extra_tables && bs.extra_tables.length ? [bs.table].concat(bs.extra_tables) : [bs.table];

  var sel = document.getElementById('table-select');
  if (sel) sel.value = bs.table;

  var atb = document.getElementById('active-table-badge');
  var atn = document.getElementById('active-table-name');
  var btd = document.getElementById('btn-drop-table');
  var feh = document.getElementById('filter-empty-hint');
  if (atn) atn.textContent = _activeTable;
  if (atb) atb.classList.remove('hidden');
  if (btd) btd.classList.remove('hidden');
  if (feh) feh.classList.add('hidden');

  renderSchemaTree(_allSchemaData);
  refreshOpenSchemaPanel();

  apiCall('get_table_columns', _activeTable).then(function(cols) {
    _tableColumns = cols || [];
    rebuildSortDropdown();
    buildAggDropdowns();

    // Restore select pills
    if (bs.select_exprs && Array.isArray(bs.select_exprs)) {
      _selectPills = bs.select_exprs.map(function(expr, i) {
        return {
          expr: expr,
          label: (bs.select_labels && bs.select_labels[i]) ? bs.select_labels[i] : expr,
          agg: expr.indexOf('(') !== -1
        };
      });
    } else {
      _selectPills = [];
    }
    renderSelectPills();

    // Restore group by pills
    if (bs.group_exprs && Array.isArray(bs.group_exprs)) {
      _groupByPills = bs.group_exprs.map(function(expr) {
        return { expr: expr, label: expr.replace(/"/g, '') };
      });
    } else {
      _groupByPills = [];
    }
    renderGroupByPills();

    // Restore sort
    var sortColEl = document.getElementById('sort-col');
    var sortDirEl = document.getElementById('sort-dir');
    if (sortColEl && bs.sort_col) sortColEl.value = bs.sort_col;
    if (sortDirEl && bs.sort_dir) sortDirEl.value = bs.sort_dir;

    // Restore limit
    var limEl = document.getElementById('result-limit');
    if (limEl && bs.limit) limEl.value = bs.limit;

    // Restore having
    if (bs.having) {
      var parts = bs.having.split(/\s+/);
      if (parts.length >= 3) {
        var hAgg = document.getElementById('having-agg');
        var hOp = document.getElementById('having-op');
        var hVal = document.getElementById('having-val');
        if (hAgg) hAgg.value = parts[0];
        if (hOp) hOp.value = parts[1];
        if (hVal) hVal.value = parts.slice(2).join(' ');
      }
    } else {
      clearHaving();
    }

    // Restore filter groups
    if (bs.groups && Array.isArray(bs.groups)) {
      _groupCounter = 0;
      _itemCounter = 0;
      function hydrateGroup(g) {
        _groupCounter++;
        var gid = g.id || ('g' + _groupCounter);
        var items = (g.items || []).map(function(it) {
          if (it._type === 'group') return hydrateGroup(it);
          _itemCounter++;
          return {
            _type: 'condition',
            id: it.id || ('i' + _itemCounter),
            gid: gid,
            joiner: it.joiner || 'AND',
            field: it.field || '',
            operator: it.operator || 'equals',
            value: it.value || '',
            value2: it.value2 || '',
            category: it.category || 'text',
            table_prefix: it.table_prefix || ''
          };
        });
        return {
          _type: 'group',
          id: gid,
          joiner: g.joiner || 'OR',
          items: items
        };
      }
      _filterGroups = bs.groups.map(hydrateGroup);
      renderFilterGroups();
    } else {
      clearFilterGroups();
    }
  }).catch(function(e) {
    console.error('restoreVisualBuilder get_table_columns error:', e);
  });
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

/* ── Schema & Multi-Table Selection ─────────────────────────────────── */
var _activeMultiTablePopover = null;

function closeActiveMultiTablePopover() {
  if (_activeMultiTablePopover) {
    if (_activeMultiTablePopover.popover && _activeMultiTablePopover.popover.parentNode) {
      _activeMultiTablePopover.popover.parentNode.removeChild(_activeMultiTablePopover.popover);
    }
    if (_activeMultiTablePopover.trigger) {
      _activeMultiTablePopover.trigger.classList.remove('active');
    }
    _activeMultiTablePopover = null;
  }
}

document.addEventListener('click', function(e) {
  if (_activeMultiTablePopover) {
    if (!_activeMultiTablePopover.popover.contains(e.target) && !_activeMultiTablePopover.trigger.contains(e.target)) {
      closeActiveMultiTablePopover();
    }
  }
});
window.addEventListener('resize', closeActiveMultiTablePopover);

function renderLeftPanelTableMultiSelect() {
  var sel = document.getElementById('table-select');
  if (!sel) return;

  var wrap = document.getElementById('multi-table-wrap-left');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'multi-table-wrap-left';
    wrap.className = 'multi-table-wrap flex-1 min-w-0';
    sel.style.display = 'none';
    sel.parentNode.insertBefore(wrap, sel);
  }

  var selectedCount = (_selectedTables || []).length;
  var labelText = '';
  if (selectedCount === 0) {
    labelText = '— No tables selected —';
  } else if (selectedCount === 1) {
    labelText = '📋 ' + _selectedTables[0];
  } else {
    labelText = '📋 ' + selectedCount + ' tables (' + _selectedTables.join(', ') + ')';
  }

  wrap.innerHTML =
    '<div class="multi-table-trigger" tabindex="0" title="Click to select one, multiple, or no tables">' +
      '<span class="multi-table-label font-mono text-[11px] truncate ' + (selectedCount === 0 ? 'text-[var(--text-dim)] italic' : '') + '">' + esc(labelText) + '</span>' +
      '<span class="multi-table-arrow">▼</span>' +
    '</div>';

  var trigger = wrap.querySelector('.multi-table-trigger');
  trigger.onclick = function(e) {
    e.stopPropagation();
    openLeftPanelTablePopover(trigger);
  };
}

function openLeftPanelTablePopover(trigger) {
  if (_activeMultiTablePopover && _activeMultiTablePopover.trigger === trigger) {
    closeActiveMultiTablePopover();
    return;
  }
  closeActiveMultiTablePopover();
  closeActiveSearchablePopover();

  var rect = trigger.getBoundingClientRect();
  var popover = document.createElement('div');
  popover.className = 'multi-table-popover';
  popover.style.top = (rect.bottom + 3) + 'px';
  popover.style.left = Math.max(10, Math.min(rect.left, window.innerWidth - 300)) + 'px';
  popover.style.width = Math.max(rect.width, 270) + 'px';

  // Prevent wheel scroll closure
  popover.addEventListener('wheel', function(e) { e.stopPropagation(); }, { passive: true });

  var allTables = (_allSchemaData || []).map(function(t) { return t.table; });

  var header = document.createElement('div');
  header.className = 'multi-table-popover-header';
  header.innerHTML =
    '<span style="font-weight:700;color:var(--text-head)">Select Tables</span>' +
    '<div class="multi-table-popover-actions">' +
      '<a id="mt-select-all">All</a>' +
      '<span>·</span>' +
      '<a id="mt-clear-all">None</a>' +
    '</div>';
  popover.appendChild(header);

  var searchWrap = document.createElement('div');
  searchWrap.className = 'searchable-select-search-wrap';
  var searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'searchable-select-search-input';
  searchInput.placeholder = '🔍 Search tables…';
  searchWrap.appendChild(searchInput);
  popover.appendChild(searchWrap);

  var listEl = document.createElement('div');
  listEl.className = 'multi-table-list';
  popover.appendChild(listEl);

  function populateItems(term) {
    listEl.innerHTML = '';
    var filtered = allTables.filter(function(t) {
      return !term || t.toLowerCase().indexOf(term.toLowerCase()) !== -1;
    });

    if (!filtered.length) {
      listEl.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-dim);font-size:10px">No tables match search</div>';
      return;
    }

    filtered.forEach(function(tbl) {
      var sObj = _allSchemaData.find(function(s) { return s.table === tbl; });
      var colCount = sObj ? sObj.columns.filter(function(c) { return !c.name.startsWith('_'); }).length : 0;
      var isChecked = (_selectedTables || []).indexOf(tbl) !== -1;

      var row = document.createElement('div');
      row.className = 'multi-table-item';
      row.innerHTML =
        '<input type="checkbox" ' + (isChecked ? 'checked' : '') + ' tabindex="-1">' +
        '<span class="multi-table-item-name">' + esc(tbl) + '</span>' +
        '<span class="multi-table-item-count">' + colCount + ' cols</span>';

      var cb = row.querySelector('input[type="checkbox"]');
      row.onclick = function(e) {
        if (e.target !== cb) cb.checked = !cb.checked;
        toggleTableSelected(tbl, cb.checked);
      };
      listEl.appendChild(row);
    });
  }

  function toggleTableSelected(tbl, checked) {
    if (!_selectedTables) _selectedTables = [];
    var idx = _selectedTables.indexOf(tbl);
    if (checked && idx === -1) {
      _selectedTables.push(tbl);
    } else if (!checked && idx !== -1) {
      _selectedTables.splice(idx, 1);
    }
    applyLeftPanelTableSelectionChange();
  }

  header.querySelector('#mt-select-all').onclick = function(e) {
    e.preventDefault();
    _selectedTables = allTables.slice();
    applyLeftPanelTableSelectionChange();
    populateItems(searchInput.value.trim());
  };

  header.querySelector('#mt-clear-all').onclick = function(e) {
    e.preventDefault();
    _selectedTables = [];
    applyLeftPanelTableSelectionChange();
    populateItems(searchInput.value.trim());
  };

  searchInput.oninput = function() {
    populateItems(searchInput.value.trim());
  };

  populateItems('');
  document.body.appendChild(popover);
  _activeMultiTablePopover = { popover: popover, trigger: trigger };
  trigger.classList.add('active');

  setTimeout(function() { searchInput.focus(); }, 15);
}

function syncTableSelection(tables, options) {
  options = options || {};
  var allTables = (_allSchemaData || []).map(function(t) { return t.table; });

  if (!Array.isArray(tables)) {
    if (tables === '__ALL__') {
      tables = allTables.slice();
    } else if (!tables || tables === '__NONE__') {
      tables = [];
    } else {
      tables = [String(tables)];
    }
  }

  // Deduplicate and filter to valid tables if schema is loaded
  var uniqueTables = [];
  tables.forEach(function(t) {
    if (t && uniqueTables.indexOf(t) === -1) {
      if (!allTables.length || allTables.indexOf(t) !== -1) {
        uniqueTables.push(t);
      }
    }
  });

  _selectedTables = uniqueTables.slice();
  _activeTable = _selectedTables.length > 0 ? _selectedTables[0] : '';

  // 1. Update Active Tab session
  var activeTab = _tabs.find(function(t) { return t.id === _activeTabId; });
  if (activeTab) {
    activeTab.selectedTables = _selectedTables.slice();
    activeTab.activeTable = _activeTable;
    if (allTables.length > 0 && _selectedTables.length === allTables.length) {
      activeTab.aiContextTables = '__ALL__';
    } else if (_selectedTables.length === 0) {
      activeTab.aiContextTables = [];
    } else {
      activeTab.aiContextTables = _selectedTables.slice();
    }
  }

  // 2. Synchronize Left Panel Selector
  renderLeftPanelTableMultiSelect();

  // 3. Synchronize AI Context Selector
  renderAiContextMultiSelect();

  // 4. Update Header Badges & Hints
  updateTableBadge();
  var btd = document.getElementById('btn-drop-table');
  if (btd) btd.classList.toggle('hidden', _selectedTables.length > 1);
  var feh = document.getElementById('filter-empty-hint');
  if (feh) feh.classList.toggle('hidden', _selectedTables.length > 0);

  // 5. Synchronize Schema Tree and Center Schema Reference
  renderSchemaTree(_allSchemaData);
  refreshOpenSchemaPanel();

  // 6. Synchronize File List Modal Checkboxes if open
  var fileListCbs = document.querySelectorAll('.table-checkbox');
  if (fileListCbs.length) {
    fileListCbs.forEach(function(cb) {
      var t = cb.getAttribute('data-table');
      cb.checked = (_selectedTables.indexOf(t) !== -1);
      var tr = cb.closest('tr');
      if (tr) tr.classList.toggle('selected-row', cb.checked);
    });
  }

  // 7. Update columns & builder
  if (!_activeTable) {
    _tableColumns = [];
    _selectPills = [];
    _groupByPills = [];
    renderSelectPills();
    renderGroupByPills();
    clearFilterGroups();
  } else {
    apiCall('get_table_columns', _activeTable)
      .then(function(cols) {
        _tableColumns = cols || [];
        rebuildSortDropdown();
        buildAggDropdowns();
        if (options.onTableChange) {
          onTableChange();
        }
      }).catch(function(){});
  }

  schedulePersistedSessionSave();
}

function applyLeftPanelTableSelectionChange() {
  syncTableSelection(_selectedTables);
}

function refreshSchema(selectTable, options) {
  options = options || {};
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
        _activeTable = '';
        _selectedTables = [];
        renderLeftPanelTableMultiSelect();
        updateAiContextTableDropdown();
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

      if (found) {
        _activeTable = target;
        _selectedTables = [target];
      } else if (!selectTable && _selectedTables && _selectedTables.length > 0) {
        // Retain currently selected tables if they still exist
        var valid = (_allSchemaData || []).map(function(t) { return t.table; });
        _selectedTables = _selectedTables.filter(function(tbl) { return valid.indexOf(tbl) !== -1; });
        _activeTable = _selectedTables.length > 0 ? _selectedTables[0] : _allSchemaData[0].table;
        if (!_selectedTables.length && _activeTable) _selectedTables = [_activeTable];
      } else {
        _activeTable = _allSchemaData[0].table;
        _selectedTables = [_activeTable];
      }

      renderLeftPanelTableMultiSelect();
      updateAiContextTableDropdown();
      onTableChange(options.skipFilter);
      renderSchemaTree(_allSchemaData);
    })
    .catch(function(e) { console.error('refreshSchema error:', e); });
}

function onTableChange(skipFilter) {
  var sel = document.getElementById('table-select');
  var val = _activeTable || (sel ? sel.value : '');

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
    renderSchemaTree([]);
    refreshOpenSchemaPanel();
    return;
  }

  if (atn) atn.textContent = _activeTable;
  if (atb) atb.classList.remove('hidden');
  if (btd) btd.classList.remove('hidden');
  if (feh) feh.classList.add('hidden');

  if (!_selectedTables || !_selectedTables.length) {
    _selectedTables = [_activeTable];
  }
  renderSchemaTree(_allSchemaData);
  refreshOpenSchemaPanel();

  apiCall('get_table_columns', _activeTable)
    .then(function(cols) {
      _tableColumns = cols || [];
      _selectPills = [];
      _groupByPills = [];
      renderSelectPills();
      renderGroupByPills();
      clearHaving();
      var sc = document.getElementById('sort-col');
      if (sc) sc.value = '';
      rebuildSortDropdown();
      buildAggDropdowns();
      clearFilterGroups();
      if (!skipFilter) {
        runFilter();
      }
    })
    .catch(function(e) { console.error('get_table_columns error:', e); });
}

/* ── Custom Searchable Select Component ─────────────────────────────── */
var _activeSearchablePopover = null;

function syncSearchableSelectTrigger(selectEl, customPlaceholder) {
  if (!selectEl) return;
  var wrap = selectEl.nextElementSibling;
  if (!wrap || !wrap.classList || !wrap.classList.contains('searchable-select-wrap')) return;
  var lbl = wrap.querySelector('.searchable-select-label');
  if (lbl) {
    var opt = selectEl.options[selectEl.selectedIndex];
    var text = (opt && opt.value) ? opt.text : (customPlaceholder || (opt ? opt.text : 'Select…'));
    lbl.textContent = text;
  }
}

function makeSearchableSelect(selectEl, customPlaceholder) {
  if (!selectEl) return;

  var wrap = selectEl.nextElementSibling;
  if (!wrap || !wrap.classList || !wrap.classList.contains('searchable-select-wrap')) {
    wrap = document.createElement('div');
    wrap.className = 'searchable-select-wrap';
    selectEl.style.display = 'none';
    selectEl.parentNode.insertBefore(wrap, selectEl.nextSibling);
  }

  function getSelectedLabel() {
    var opt = selectEl.options[selectEl.selectedIndex];
    if (opt && opt.value) return opt.text;
    return (opt && opt.text) ? opt.text : (customPlaceholder || 'Select column…');
  }

  wrap.innerHTML = '<div class="searchable-select-trigger" tabindex="0">' +
    '<span class="searchable-select-label">' + esc(getSelectedLabel()) + '</span>' +
    '</div>';

  var trigger = wrap.querySelector('.searchable-select-trigger');

  function openPopover() {
    closeActiveSearchablePopover();

    var rect = trigger.getBoundingClientRect();
    var popover = document.createElement('div');
    popover.className = 'searchable-select-popover';

    var popWidth = Math.max(rect.width, 240);
    var popLeft = Math.min(rect.left, window.innerWidth - popWidth - 10);
    if (popLeft < 10) popLeft = 10;

    var spaceBelow = window.innerHeight - rect.bottom;
    var spaceAbove = rect.top;
    var openUpward = (spaceBelow < 220 && spaceAbove > spaceBelow);

    if (openUpward) {
      popover.style.bottom = (window.innerHeight - rect.top + 2) + 'px';
      popover.style.left = popLeft + 'px';
      popover.style.width = popWidth + 'px';
    } else {
      popover.style.top = (rect.bottom + 2) + 'px';
      popover.style.left = popLeft + 'px';
      popover.style.width = popWidth + 'px';
    }

    var searchWrap = document.createElement('div');
    searchWrap.className = 'searchable-select-search-wrap';
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'searchable-select-search-input';
    searchInput.placeholder = '🔍 Search column…';
    searchWrap.appendChild(searchInput);
    popover.appendChild(searchWrap);

    var listEl = document.createElement('div');
    listEl.className = 'searchable-select-list';
    popover.appendChild(listEl);

    var allItems = [];
    var children = Array.from(selectEl.children);
    children.forEach(function(child) {
      if (child.tagName === 'OPTGROUP') {
        var grpTitle = document.createElement('div');
        grpTitle.className = 'searchable-select-group-title';
        grpTitle.textContent = child.label;
        listEl.appendChild(grpTitle);

        Array.from(child.children).forEach(function(opt) {
          var item = createItemEl(opt);
          listEl.appendChild(item);
          allItems.push({ el: item, text: opt.text.toLowerCase(), grp: grpTitle });
        });
      } else if (child.tagName === 'OPTION') {
        var item = createItemEl(child);
        listEl.appendChild(item);
        allItems.push({ el: item, text: child.text.toLowerCase() });
      }
    });

    function createItemEl(opt) {
      var item = document.createElement('div');
      item.className = 'searchable-select-item' + (opt.selected ? ' selected' : '');
      item.textContent = opt.text;
      item.setAttribute('data-value', opt.value);
      item.addEventListener('click', function(e) {
        e.stopPropagation();
        selectEl.value = opt.value;
        syncSearchableSelectTrigger(selectEl, customPlaceholder);
        closeActiveSearchablePopover();
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return item;
    }

    searchInput.addEventListener('input', function() {
      var term = searchInput.value.trim().toLowerCase();
      var visibleCount = 0;
      allItems.forEach(function(obj) {
        var match = !term || obj.text.indexOf(term) !== -1;
        obj.el.style.display = match ? '' : 'none';
        if (match) visibleCount++;
      });
      var grpHeaders = listEl.querySelectorAll('.searchable-select-group-title');
      grpHeaders.forEach(function(gh) {
        var next = gh.nextElementSibling;
        var hasVisible = false;
        while (next && next.classList.contains('searchable-select-item')) {
          if (next.style.display !== 'none') { hasVisible = true; break; }
          next = next.nextElementSibling;
        }
        gh.style.display = hasVisible ? '' : 'none';
      });

      var emptyMsg = listEl.querySelector('.searchable-select-empty');
      if (visibleCount === 0) {
        if (!emptyMsg) {
          emptyMsg = document.createElement('div');
          emptyMsg.className = 'searchable-select-empty';
          emptyMsg.textContent = 'No matching columns';
          listEl.appendChild(emptyMsg);
        }
      } else if (emptyMsg) {
        emptyMsg.remove();
      }
    });

    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        closeActiveSearchablePopover();
        trigger.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var visibleItems = allItems.map(function(o) { return o.el; }).filter(function(el) { return el.style.display !== 'none'; });
        if (!visibleItems.length) return;
        var curIdx = visibleItems.findIndex(function(el) { return el.classList.contains('highlighted'); });
        if (e.key === 'ArrowDown') curIdx = (curIdx + 1) % visibleItems.length;
        else curIdx = (curIdx - 1 + visibleItems.length) % visibleItems.length;
        visibleItems.forEach(function(el, i) { el.classList.toggle('highlighted', i === curIdx); });
        visibleItems[curIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        var high = listEl.querySelector('.searchable-select-item.highlighted');
        if (!high) high = listEl.querySelector('.searchable-select-item:not([style*="none"])');
        if (high) high.click();
      }
    });

    document.body.appendChild(popover);
    _activeSearchablePopover = { popover: popover, trigger: trigger };
    trigger.classList.add('active');

    setTimeout(function() {
      searchInput.focus();
    }, 10);
  }

  trigger.onclick = function(e) {
    e.stopPropagation();
    if (_activeSearchablePopover && _activeSearchablePopover.trigger === trigger) {
      closeActiveSearchablePopover();
    } else {
      openPopover();
    }
  };

  trigger.onkeydown = function(e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      openPopover();
    }
  };
}

function closeActiveSearchablePopover() {
  if (_activeSearchablePopover) {
    if (_activeSearchablePopover.popover && _activeSearchablePopover.popover.parentNode) {
      _activeSearchablePopover.popover.parentNode.removeChild(_activeSearchablePopover.popover);
    }
    if (_activeSearchablePopover.trigger) {
      _activeSearchablePopover.trigger.classList.remove('active');
    }
    _activeSearchablePopover = null;
  }
}

document.addEventListener('click', function(e) {
  if (_activeSearchablePopover) {
    if (!_activeSearchablePopover.popover.contains(e.target) && !_activeSearchablePopover.trigger.contains(e.target)) {
      closeActiveSearchablePopover();
    }
  }
});
window.addEventListener('resize', closeActiveSearchablePopover);
window.addEventListener('scroll', function(e) {
  if (_activeSearchablePopover && _activeSearchablePopover.popover) {
    if (e.target && (_activeSearchablePopover.popover === e.target || _activeSearchablePopover.popover.contains(e.target))) {
      return; // Do NOT close popover when scrolling inside its own list
    }
  }
  closeActiveSearchablePopover();
}, true);

function rebuildSortDropdown() {
  var sortSel = document.getElementById('sort-col');
  if (!sortSel) return;
  sortSel.innerHTML = '<option value="">— none —</option>';
  _tableColumns.forEach(function(c) {
    sortSel.appendChild(new Option(c.name, c.name));
  });
  makeSearchableSelect(sortSel, '— none —');

  // Show column search bar in filter panel when there are many columns
  var searchBar = document.getElementById('col-filter-search-bar');
  if (searchBar) {
    searchBar.classList.toggle('hidden', _tableColumns.length <= 15);
  }
}

/* ── Column search for filter dropdowns ─────────────────────────────── */
/* Filters the field <select> inside every open condition row and aggregate/sort selects */
var _colDropdownFilterTimer = null;
function filterColumnDropdowns(term) {
  clearTimeout(_colDropdownFilterTimer);
  _colDropdownFilterTimer = setTimeout(function() {
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
  }, 150);
}



/* ── Schema tree render ─────────────────────────────────────────────── */
// showAll: if false, only show tables in _selectedTables (or active table)
function renderSchemaTree(schema, showAll) {
  var el = document.getElementById('schema-tree');
  var cr = document.getElementById('cr-schema-ref');
  if (!el) return;

  var currentTables = (_selectedTables && _selectedTables.length > 0) ? _selectedTables : (_activeTable ? [_activeTable] : []);
  var sidebarSchema = schema;
  if (!showAll && currentTables.length > 0) {
    sidebarSchema = schema.filter(function(t) { return currentTables.indexOf(t.table) !== -1; });
  }

  if (!schema || schema.length === 0) {
    var empty = '<div style="color:var(--text-dim);text-align:center;padding:32px 8px;font-size:11px">Import a file to see schema</div>';
    el.innerHTML = empty;
    if (cr) cr.innerHTML = empty;
    return;
  }

  if (sidebarSchema.length === 0) {
    var noSel = '<div style="color:var(--text-dim);text-align:center;padding:32px 8px;font-size:11px">No tables selected</div>';
    el.innerHTML = noSel;
    if (cr) cr.innerHTML = noSel;
    return;
  }

  // Render sidebar with filtered tables
  el.innerHTML = _buildSchemaHtml(sidebarSchema, false);
  // Render SQL reference panel with FILTERED tables
  if (cr) cr.innerHTML = _buildSchemaHtml(sidebarSchema, true);
}

function _buildSchemaHtml(schema, isEditor) {
  var html = '';
  schema.forEach(function(t) {
    var userCols = t.columns.filter(function(c) { return !c.name.startsWith('_'); });
    var colNames = userCols.map(function(c) { return '"' + c.name + '"'; }).join(', ');
    var sampleSql = 'SELECT ' + colNames + '\nFROM "' + t.table + '"\nLIMIT 100';
    html += '<div class="schema-table" style="margin-bottom:10px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 8px;background:var(--bg-muted);border-radius:4px 4px 0 0;border:1px solid var(--border);border-bottom:0">' +
      '<span style="font-weight:600;font-size:11px;color:var(--text-head);font-family:monospace;cursor:pointer" onclick="syncTableSelection([\'' + esc(t.table) + '\'], {onTableChange:true})" title="Click to focus this table alone">📋 ' + esc(t.table) + '</span>' +
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

/* ── Copy Schema Text (Formatted for AI) ────────────────────────────── */
function copySchemaText() {
  if (!_allSchemaData || !_allSchemaData.length) { toast('No tables imported yet.', 'warn'); return; }
  var currentTables = (_selectedTables && _selectedTables.length > 0) ? _selectedTables : (_activeTable ? [_activeTable] : []);
  var tables = _allSchemaData.filter(function(t) { return currentTables.length === 0 || currentTables.indexOf(t.table) !== -1; });
  if (!tables.length) tables = _allSchemaData;

  var lines = [];
  lines.push('### Role & Instructions');
  lines.push('You are an expert SQL Assistant for **Querii**, a high-performance offline desktop data analysis platform running an embedded **SQLite 3** engine.');
  lines.push('Based on the active database schema and query constraints below, write clean, efficient, and syntactically valid SQLite queries.');
  lines.push('');
  lines.push('### Database Engine & Dialect Specifications');
  lines.push('- **Engine**: SQLite 3 (in-memory / local storage).');
  lines.push('- **Identifier Quoting**: ALWAYS double-quote table and column identifiers with spaces or special characters, e.g. `"Order ID"`, `"Customer Name"`, `"' + (tables[0] ? tables[0].table : 'table') + '"`.');
  lines.push('- **String Literals**: Single quotes only, e.g. \'Completed\', \'2024-01-01\'.');
  lines.push('- **Date & Time Operations**: Dates and timestamps are stored as ISO-8601 strings. Use SQLite functions: `date()`, `datetime()`, `strftime(\'%Y-%m\', "col")`, `julianday()`.');
  lines.push('- **Case-Insensitive Match**: Use `LOWER("col") LIKE \'%pattern%\'` or `LIKE` (case-insensitive for ASCII in SQLite). Do NOT use PostgreSQL `ILIKE`.');
  lines.push('- **Null Coalescing**: Use `COALESCE("col", default_value)` or `IFNULL("col", default_value)`.');
  lines.push('');
  lines.push('### Permitted Capabilities & Statements');
  lines.push('- Full standard query syntax: `SELECT`, `FROM`, `JOIN` (INNER, LEFT OUTER, CROSS), `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`, `OFFSET`.');
  lines.push('- Common Table Expressions (CTEs): `WITH ... AS (...) SELECT ...`.');
  lines.push('- Window functions: `ROW_NUMBER() OVER (...)`, `RANK()`, `DENSE_RANK()`, `SUM(...) OVER (...)`, `LAG()`, `LEAD()`.');
  lines.push('- Full Aggregates: `COUNT()`, `SUM()`, `AVG()`, `MIN()`, `MAX()`, `GROUP_CONCAT("col", \', \')`.');
  lines.push('- Data modification (DML): `INSERT INTO`, `UPDATE`, `DELETE`, `CREATE TABLE` are supported in Querii.');
  lines.push('');
  lines.push('### Strict Restrictions & Prohibited Commands');
  lines.push('- **FORBIDDEN**: Do NOT generate `DROP TABLE`, `DROP VIEW`, or `TRUNCATE` unless explicitly asked (these destructive commands are safety-restricted).');
  lines.push('- Do NOT use non-SQLite syntax such as SQL Server `SELECT TOP n`, MySQL `LIMIT offset, count`, or PostgreSQL `DISTINCT ON (...)` (use standard SQLite window functions instead).');
  lines.push('');
  lines.push('### Active Database Schema (' + tables.length + ' table' + (tables.length > 1 ? 's' : '') + ')');
  tables.forEach(function(t) {
    var userCols = t.columns.filter(function(c) { return !c.name.startsWith('_'); });
    lines.push('#### Table: "' + t.table + '" (' + userCols.length + ' columns)');
    lines.push('Columns:');
    userCols.forEach(function(c) {
      lines.push('  - "' + c.name + '" : ' + c.type);
    });
    var sampleCols = userCols.slice(0, 5).map(function(c) { return '"' + c.name + '"'; }).join(', ');
    lines.push('Sample Query:');
    lines.push('```sql');
    lines.push('SELECT ' + sampleCols + (userCols.length > 5 ? ' ...' : '') + ' FROM "' + t.table + '" LIMIT 10;');
    lines.push('```');
    lines.push('');
  });
  lines.push('### Instructions for Response');
  lines.push('- Enclose SQL in a single ```sql code block.');
  lines.push('- Briefly explain any complex JOINs, CTEs, or window calculations used.');
  lines.push('');
  lines.push('### My Question:');
  lines.push('[Type your query requirement or data question here]');

  var text = lines.join('\n');
  copyToClipboard(text, 'Schema copied structured for AI! Paste it into ChatGPT, Claude, or Gemini.');
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
  ['schema', 'ai'].forEach(function(t) {
    var btn = document.getElementById('rt-' + t);
    var pnl = document.getElementById('right-tab-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
    if (pnl) pnl.classList.toggle('hidden', t !== tab);
  });
  if (tab === 'ai') {
    updateAiContextTableDropdown();
    renderActiveTabAiMessages();
    updateAiProviderBadge();
    setTimeout(function() {
      var inp = document.getElementById('ai-chat-input');
      if (inp) inp.focus();
    }, 50);
  }
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

  cond.rhs_type = cond.rhs_type || 'value';

  // Op select + RHS mode toggle button
  html += '<div style="display:flex;gap:3px;align-items:center">';
  html += '<select class="select-sm" style="flex:1" id="fo-' + cond.id + '" ' +
    'onchange=\'onCondOpChange(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ',this.value)\'></select>';
  html += '<button type="button" class="btn-ghost" style="font-size:9.5px;padding:1px 5px;height:22px;border:1px solid var(--border);border-radius:4px;white-space:nowrap" ' +
    'onclick=\'toggleCondRhsType(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ')\' ' +
    'title="Switch condition between literal value and table column">' +
    (cond.rhs_type === 'column' ? '⊞ Col' : '123 Val') + '</button>';
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
    var ff = document.getElementById('ff-' + cond.id);
    if (ff) makeSearchableSelect(ff);
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

function toggleCondRhsType(gid, iid) {
  var group = findGroup(_filterGroups, gid);
  if (!group) return;
  var cond = group.items.find(function(it) { return it.id === iid; });
  if (!cond) return;
  cond.rhs_type = (cond.rhs_type === 'column' ? 'value' : 'column');
  cond.value = '';
  cond.value2 = '';
  var oldRow = document.getElementById('fi-' + iid);
  if (oldRow && oldRow.parentNode) {
    var newRow = buildConditionEl(cond, 0, gid);
    oldRow.parentNode.replaceChild(newRow, oldRow);
  }
}

function renderCondValue(cond, gid) {
  var vDiv = document.getElementById('fv-' + cond.id);
  if (!vDiv) return;
  var op  = cond.operator;
  var cat = cond.category;

  if (op === 'is empty' || op === 'is not empty') { vDiv.innerHTML = ''; return; }

  if (cond.rhs_type === 'column') {
    // Column-to-Column Comparison mode
    var colOpts = '<option value="">— Select Target Column —</option>' +
      _tableColumns.map(function(c) {
        var val = (_selectedTables.length > 1) ? _activeTable + '.' + c.name : c.name;
        return '<option value="' + esc(val) + '"' + (val === cond.value ? ' selected' : '') + '>' + esc(c.name) + ' (' + c.type + ')</option>';
      }).join('');
    vDiv.innerHTML = '<select id="fv1-' + cond.id + '" class="select-sm font-mono text-[11px]" style="width:100%" ' +
      'onchange=\'onCondValueChange(' + JSON.stringify(gid) + ',' + JSON.stringify(cond.id) + ',"val1",this.value)\'>' +
      colOpts + '</select>';
    return;
  }

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
    var ff = document.getElementById('ff-' + iid);
    if (ff) syncSearchableSelectTrigger(ff);
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
var _filterSqlDebounceTimer = null;
function onCondValueChange(gid, iid, which, val) {
  var group = findGroup(_filterGroups, gid);
  if (!group) return;
  var cond = group.items.find(function(it) { return it.id === iid; });
  if (!cond) return;
  if (which === 'val1') cond.value  = val;
  else                  cond.value2 = val;

  // Debounce typing in filter fields so SQL text generation doesn't re-trigger on every microsecond backspace
  clearTimeout(_filterSqlDebounceTimer);
  _filterSqlDebounceTimer = setTimeout(function() {
    generateSqlPreview();
  }, 200);
}

function generateSqlPreview() {
  if (!_activeTable) return;
  syncFilterState();

  var selPart = _selectPills.length ? _selectPills.map(function(p) { return p.expr; }).join(', ') : '*';
  var sql = 'SELECT ' + selPart + '\nFROM "' + _activeTable + '"';

  if (_selectedTables.length > 1) {
    _joinClauses.forEach(function(jc) {
      if (jc && jc.clause) sql += '\n' + jc.clause;
    });
  }

  function escVal(v, cat) {
    if (v === '' || v === null || v === undefined) return "''";
    if (cat === 'number' && !isNaN(Number(v))) return String(Number(v));
    return "'" + String(v).replace(/'/g, "''") + "'";
  }

  function buildWhere(group) {
    if (!group || !group.items || !group.items.length) return '';
    var parts = [];
    for (var i = 0; i < group.items.length; i++) {
      var item = group.items[i];
      if (item._type === 'group') {
        var sub = buildWhere(item);
        if (sub) parts.push('(' + sub + ')');
      } else if (item.field && item.operator) {
        var fld = item.field.indexOf('.') !== -1 ? item.field : '"' + item.field + '"';
        var op = item.operator;
        var val1 = item.value || '';
        var val2 = item.value2 || '';
        if (item.rhs_type === 'column') {
          var rCol = val1.indexOf('.') !== -1 ? val1 : '"' + val1 + '"';
          if (op === 'contains') {
            parts.push("LOWER(" + fld + ") LIKE '%' || LOWER(" + rCol + ") || '%'");
          } else if (op === 'not contains') {
            parts.push("LOWER(" + fld + ") NOT LIKE '%' || LOWER(" + rCol + ") || '%'");
          } else if (op === 'starts with') {
            parts.push("LOWER(" + fld + ") LIKE LOWER(" + rCol + ") || '%'");
          } else if (op === 'ends with') {
            parts.push("LOWER(" + fld + ") LIKE '%' || LOWER(" + rCol + ")");
          } else if (op === 'not equals') {
            parts.push(fld + ' != ' + rCol);
          } else if (op === 'equals') {
            parts.push(fld + ' = ' + rCol);
          } else if (op === 'greater than') {
            parts.push(fld + ' > ' + rCol);
          } else if (op === 'less than') {
            parts.push(fld + ' < ' + rCol);
          } else if (op === 'greater or equal') {
            parts.push(fld + ' >= ' + rCol);
          } else if (op === 'less or equal') {
            parts.push(fld + ' <= ' + rCol);
          } else {
            parts.push(fld + ' ' + op + ' ' + rCol);
          }
        } else if (op === 'is empty') {
          parts.push('(' + fld + ' IS NULL OR ' + fld + " = '')");
        } else if (op === 'is not empty') {
          parts.push('(' + fld + ' IS NOT NULL AND ' + fld + " != '')");
        } else if (op === 'between') {
          parts.push(fld + ' BETWEEN ' + escVal(val1, item.category) + ' AND ' + escVal(val2, item.category));
        } else if (op === 'contains') {
          parts.push(fld + " LIKE '%" + val1.replace(/'/g, "''") + "%'");
        } else if (op === 'starts with') {
          parts.push(fld + " LIKE '" + val1.replace(/'/g, "''") + "%'");
        } else if (op === 'ends with') {
          parts.push(fld + " LIKE '%" + val1.replace(/'/g, "''") + "'");
        } else {
          parts.push(fld + ' ' + op + ' ' + escVal(val1, item.category));
        }
      }
    }
    return parts.join(' ' + (group.joiner || 'AND') + ' ');
  }

  if (_filterGroups && _filterGroups.length) {
    var topParts = [];
    _filterGroups.forEach(function(g) {
      var s = buildWhere(g);
      if (s) topParts.push('(' + s + ')');
    });
    if (topParts.length) sql += '\nWHERE ' + topParts.join(' OR ');
  }

  if (_groupByPills.length) {
    sql += '\nGROUP BY ' + _groupByPills.map(function(p) { return p.expr; }).join(', ');
    var havingAgg  = ((document.getElementById('having-agg') || {}).value || '').trim();
    var havingOp   = (document.getElementById('having-op') || {}).value || '>';
    var havingVal  = ((document.getElementById('having-val') || {}).value || '').trim();
    var havingVal2 = ((document.getElementById('having-val2') || {}).value || '').trim();
    if (havingAgg) {
      if (havingOp === 'IS NULL' || havingOp === 'IS NOT NULL') {
        sql += '\nHAVING ' + havingAgg + ' ' + havingOp;
      } else if ((havingOp === 'BETWEEN' || havingOp === 'NOT BETWEEN') && havingVal && havingVal2) {
        sql += '\nHAVING ' + havingAgg + ' ' + havingOp + ' ' + havingVal + ' AND ' + havingVal2;
      } else if (havingOp === 'IN' && havingVal) {
        sql += '\nHAVING ' + havingAgg + ' IN (' + havingVal + ')';
      } else if (havingOp === 'LIKE' && havingVal) {
        var lVal = (havingVal.startsWith("'") && havingVal.endsWith("'")) ? havingVal : "'" + havingVal.replace(/'/g, "''") + "'";
        sql += '\nHAVING ' + havingAgg + ' LIKE ' + lVal;
      } else if (havingVal) {
        sql += '\nHAVING ' + havingAgg + ' ' + havingOp + ' ' + havingVal;
      }
    }
  }

  var sortCol = (document.getElementById('sort-col') || {}).value || '';
  var sortDir = (document.getElementById('sort-dir') || {}).value || 'ASC';
  if (sortCol) {
    sql += '\nORDER BY ' + (sortCol.indexOf('.') !== -1 ? sortCol : '"' + sortCol + '"') + ' ' + sortDir;
  }

  var limit = parseInt((document.getElementById('result-limit') || {}).value || '5000', 10);
  if (limit) {
    sql += '\nLIMIT ' + limit;
  }

  var ed = document.getElementById('sql-editor');
  if (ed) {
    ed.value = sql;
    syncSqlLines();
  }
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
    rhs_type:     item.rhs_type || 'value',
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
  makeSearchableSelect(selectAdd, '+ Add column or aggregate…');
  makeSearchableSelect(groupbyAdd, '+ Add group field…');
}
function addSelectField(sel) {
  if (!sel.value) return;
  var d = JSON.parse(sel.value);
  _selectPills.push({ expr: d.expr, label: d.label, agg: !!d.agg });
  renderSelectPills();
  sel.value = '';
  syncSearchableSelectTrigger(sel, '+ Add column or aggregate…');
}
function addGroupByField(sel) {
  if (!sel.value) return;
  var d = JSON.parse(sel.value);
  _groupByPills.push({ expr: d.expr, label: d.label });
  renderGroupByPills();
  sel.value = '';
  syncSearchableSelectTrigger(sel, '+ Add group field…');
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
  var v1 = document.getElementById('having-val'); if (v1) v1.value = '';
  var v2 = document.getElementById('having-val2'); if (v2) v2.value = '';
  var op = document.getElementById('having-op'); if (op) op.value = '>';
  var andLbl = document.getElementById('having-and-label'); if (andLbl) andLbl.classList.add('hidden');
  if (v2) { v2.classList.add('hidden'); v2.style.display = 'none'; }
  if (v1) v1.style.display = 'block';
  runFilter();
}

function onHavingOpChange() {
  var opEl = document.getElementById('having-op');
  var op = opEl ? opEl.value : '>';
  var v1 = document.getElementById('having-val');
  var v2 = document.getElementById('having-val2');
  var andLbl = document.getElementById('having-and-label');

  if (op === 'BETWEEN' || op === 'NOT BETWEEN') {
    if (v1) { v1.style.display = 'block'; v1.placeholder = 'min'; }
    if (andLbl) andLbl.classList.remove('hidden');
    if (v2) { v2.classList.remove('hidden'); v2.style.display = 'block'; v2.placeholder = 'max'; }
  } else if (op === 'IS NULL' || op === 'IS NOT NULL') {
    if (v1) v1.style.display = 'none';
    if (andLbl) andLbl.classList.add('hidden');
    if (v2) { v2.classList.add('hidden'); v2.style.display = 'none'; }
  } else {
    if (v1) {
      v1.style.display = 'block';
      if (op === 'LIKE') v1.placeholder = "'%val%'";
      else if (op === 'IN') v1.placeholder = "1, 2, 3";
      else v1.placeholder = "val";
    }
    if (andLbl) andLbl.classList.add('hidden');
    if (v2) { v2.classList.add('hidden'); v2.style.display = 'none'; }
  }
  onHavingChange();
}

function onHavingChange() {
  runFilter();
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
  var havingAgg  = ((document.getElementById('having-agg') || {}).value || '').trim();
  var havingOp   = (document.getElementById('having-op') || {}).value || '>';
  var havingVal  = ((document.getElementById('having-val') || {}).value || '').trim();
  var havingVal2 = ((document.getElementById('having-val2') || {}).value || '').trim();
  var having     = '';
  if (havingAgg) {
    if (havingOp === 'IS NULL' || havingOp === 'IS NOT NULL') {
      having = havingAgg + ' ' + havingOp;
    } else if ((havingOp === 'BETWEEN' || havingOp === 'NOT BETWEEN') && havingVal && havingVal2) {
      having = havingAgg + ' ' + havingOp + ' ' + havingVal + ' AND ' + havingVal2;
    } else if (havingOp === 'IN' && havingVal) {
      having = havingAgg + ' IN (' + havingVal + ')';
    } else if (havingOp === 'LIKE' && havingVal) {
      var lVal = (havingVal.startsWith("'") && havingVal.endsWith("'")) ? havingVal : "'" + havingVal.replace(/'/g, "''") + "'";
      having = havingAgg + ' LIKE ' + lVal;
    } else if (havingVal) {
      having = havingAgg + ' ' + havingOp + ' ' + havingVal;
    }
  }

  var isSec = (_focusedPane === 'secondary' && _splitActive);
  if (isSec) {
    setSqlStatusSecondary('Running…');
  } else {
    setSqlStatus('Running…');
  }

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
    if (isSec) {
      var edB = document.getElementById('sql-editor-b');
      if (edB && d.sql) { edB.value = d.sql; syncSqlLinesSecondary(); }
      _lastExecutedSqlB = d.sql;
      var secTab = _tabs.find(function(t) { return t.id === _secondaryTabId; });
      if (secTab) secTab.lastExecutedSql = d.sql;
      setSqlStatusSecondary((d.count || 0).toLocaleString() + ' rows');
      renderResultsSecondary(d.columns || [], d.rows || [], d.count || 0);
    } else {
      var ed = document.getElementById('sql-editor');
      if (ed && d.sql) { ed.value = d.sql; syncSqlLines(); }
      _lastExecutedSql = d.sql;
      var activeTab = _tabs.find(function(t) { return t.id === _activeTabId; });
      if (activeTab) activeTab.lastExecutedSql = d.sql;
      setSqlStatus((d.count || 0).toLocaleString() + ' rows');
      renderResults(d.columns || [], d.rows || [], d.count || 0);
    }
  }).catch(function(e) {
    if (isSec) {
      setSqlStatusSecondary('⚠ ' + e.message);
    } else {
      setSqlStatus('⚠ ' + e.message);
    }
    toast(e.message, 'error');
  });
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

/* ── Toddler-Proof Safety Inspection for Destructive DML/DDL ─────────── */
var _pendingDestructiveQuery = null;
var _safetyTimer = null;

function analyzeDestructiveQuery(rawSql) {
  if (!rawSql) return null;
  var sql = rawSql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();

  // 1. DROP TABLE
  var dropTableMatch = sql.match(/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?([a-zA-Z0-9_]+)["'`]?/i);
  if (dropTableMatch) {
    var tbl = dropTableMatch[1];
    return {
      isDestructive: true,
      action: 'DROP TABLE',
      table: tbl,
      badge: 'DROP TABLE: Permanent Deletion of Table "' + tbl + '"',
      detail: 'You are attempting to delete the entire table "' + tbl + '" and all its data and column definitions.\nThis action is permanent and CANNOT be undone!'
    };
  }

  // 2. DROP VIEW
  var dropViewMatch = sql.match(/^DROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?["'`]?([a-zA-Z0-9_]+)["'`]?/i);
  if (dropViewMatch) {
    var vw = dropViewMatch[1];
    return {
      isDestructive: true,
      action: 'DROP VIEW',
      table: vw,
      badge: 'DROP VIEW: Deletion of View "' + vw + '"',
      detail: 'You are attempting to permanently drop the view "' + vw + '".'
    };
  }

  // 3. TRUNCATE TABLE
  var truncMatch = sql.match(/^TRUNCATE(?:\s+TABLE)?\s+["'`]?([a-zA-Z0-9_]+)["'`]?/i);
  if (truncMatch) {
    var tblT = truncMatch[1];
    return {
      isDestructive: true,
      action: 'TRUNCATE',
      table: tblT,
      badge: 'TRUNCATE: Erasing all rows from "' + tblT + '"',
      detail: 'You are attempting to erase every single row inside table "' + tblT + '".\nTable structure remains, but all data will be lost!'
    };
  }

  // 4. DELETE FROM without WHERE
  var deleteMatch = sql.match(/^DELETE\s+FROM\s+["'`]?([a-zA-Z0-9_]+)["'`]?/i);
  if (deleteMatch && !/\bWHERE\b/i.test(sql)) {
    var tblD = deleteMatch[1];
    return {
      isDestructive: true,
      action: 'DELETE ALL',
      table: tblD,
      badge: 'UNCONSTRAINED DELETE: Deleting ALL rows in "' + tblD + '"',
      detail: 'Your DELETE query does NOT have a WHERE clause!\nEvery single row in table "' + tblD + '" will be deleted immediately.'
    };
  }

  // 5. UPDATE without WHERE
  var updateMatch = sql.match(/^UPDATE\s+["'`]?([a-zA-Z0-9_]+)["'`]?\s+SET\b/i);
  if (updateMatch && !/\bWHERE\b/i.test(sql)) {
    var tblU = updateMatch[1];
    return {
      isDestructive: true,
      action: 'UPDATE ALL',
      table: tblU,
      badge: 'UNCONSTRAINED UPDATE: Overwriting ALL rows in "' + tblU + '"',
      detail: 'Your UPDATE query does NOT have a WHERE clause!\nEvery row in table "' + tblU + '" will be overwritten with the specified values.'
    };
  }

  return null;
}

function promptDestructiveSafetyModal(danger, sql, targetPane) {
  _pendingDestructiveQuery = { sql: sql, targetPane: targetPane || 'primary' };

  var badgeEl = document.getElementById('safety-warning-badge');
  var detailsEl = document.getElementById('safety-warning-details');
  var sqlEl = document.getElementById('safety-warning-sql');
  var confirmBtn = document.getElementById('safety-btn-confirm');

  if (badgeEl) badgeEl.textContent = danger.badge;
  if (sqlEl) sqlEl.textContent = sql;

  if (detailsEl) {
    detailsEl.innerHTML = esc('Checking affected row count…\n' + danger.detail).replace(/\n/g, '<br>');
  }

  // Fetch actual table row count
  apiCall('get_table_row_count', danger.table)
    .then(function(res) {
      var count = (typeof res === 'object' && res !== null && res.count !== undefined) ? res.count : Number(res);
      if (isNaN(count)) count = -1;
      if (detailsEl) {
        var rowNotice = (count >= 0)
          ? ('⚠️ IMPACT WARNING: Table "' + danger.table + '" currently contains ' + count.toLocaleString() + ' rows.\n\n')
          : '';
        detailsEl.innerHTML = esc(rowNotice + danger.detail).replace(/\n/g, '<br>');
      }
    }).catch(function() {
      if (detailsEl) detailsEl.innerHTML = esc(danger.detail).replace(/\n/g, '<br>');
    });

  // 2-second safety delay countdown
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.classList.add('opacity-50', 'cursor-not-allowed');
    var secondsLeft = 2;
    confirmBtn.textContent = 'Execute Destructive Query (' + secondsLeft + 's)';

    if (_safetyTimer) clearInterval(_safetyTimer);
    _safetyTimer = setInterval(function() {
      secondsLeft--;
      if (secondsLeft > 0) {
        confirmBtn.textContent = 'Execute Destructive Query (' + secondsLeft + 's)';
      } else {
        clearInterval(_safetyTimer);
        _safetyTimer = null;
        confirmBtn.disabled = false;
        confirmBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        confirmBtn.textContent = '⚠️ I Understand the Risk — Execute Now';
      }
    }, 1000);
  }

  openModal('modal-safety-warning');
}

function executeConfirmedDestructiveQuery() {
  if (!_pendingDestructiveQuery) return;
  var q = _pendingDestructiveQuery;
  _pendingDestructiveQuery = null;
  closeModal();

  if (q.targetPane === 'secondary') {
    runSqlSecondaryDirect(q.sql);
  } else {
    runSqlDirect(q.sql);
  }
}

/* ── Raw SQL ────────────────────────────────────────────────────────── */
function runSql() {
  var sql = (document.getElementById('sql-editor') || {}).value;
  if (!sql || !sql.trim()) return;

  var danger = analyzeDestructiveQuery(sql.trim());
  if (danger && danger.isDestructive) {
    promptDestructiveSafetyModal(danger, sql.trim(), 'primary');
    return;
  }

  runSqlDirect(sql.trim());
}

function renderMutationSuccess(message, table) {
  var tbody = document.getElementById('results-tbody');
  var thead = document.getElementById('results-thead');
  var countEl = document.getElementById('result-count');
  if (thead) thead.innerHTML = '';
  if (countEl) countEl.textContent = 'Statement Executed';

  if (tbody) {
    tbody.innerHTML =
      '<tr><td colspan="100" style="padding:0;border:none">' +
        '<div class="mutation-result-card">' +
          '<div style="width:48px;height:48px;border-radius:24px;background:var(--ok-bg);color:var(--ok);display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:12px;border:1px solid var(--ok)">✓</div>' +
          '<div style="font-size:14px;font-weight:700;color:var(--text-head);margin-bottom:6px">Query Executed Successfully</div>' +
          '<div style="font-size:12px;font-family:monospace;color:var(--ok);background:var(--ok-bg);padding:4px 14px;border-radius:6px;border:1px solid var(--ok);margin-bottom:12px">' + esc(message) + '</div>' +
          (table ? '<div style="font-size:11.5px;color:var(--text-mid);max-width:440px;line-height:1.4">Created table <strong>' + esc(table) + '</strong> is now active in your schema. Query it anytime using <code style="background:var(--bg-muted);padding:2px 6px;border-radius:4px;border:1px solid var(--border)">SELECT * FROM "' + esc(table) + '" LIMIT 100</code></div>' : '') +
        '</div>' +
      '</td></tr>';
  }
}

function runSqlDirect(sql) {
  setSqlStatus('Running…');
  _lastExecutedSql = sql;
  var activeTab = _tabs.find(function(t) { return t.id === _activeTabId; });
  if (activeTab) activeTab.lastExecutedSql = sql;

  apiCall('run_sql', sql)
    .then(function(d) {
      if (d.message && (!d.columns || d.columns.length === 0)) {
        setSqlStatus(d.message);
        toast('✓ ' + d.message);

        // Detect if CREATE TABLE created a new table
        var createdTableMatch = sql.match(/CREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-zA-Z0-9_]+)["']?/i);
        var newlyCreatedTable = createdTableMatch ? createdTableMatch[1] : null;

        // Refresh schema without running filter or overwriting SQL editor
        refreshSchema(newlyCreatedTable, { skipFilter: true, preserveEditor: true });
        renderMutationSuccess(d.message, newlyCreatedTable);
        schedulePersistedSessionSave();
        return;
      }
      setSqlStatus((d.count || 0).toLocaleString() + ' rows');
      renderResults(d.columns || [], d.rows || [], d.count || 0);
      if (d.is_mutation) {
        refreshSchema(null, { skipFilter: true, preserveEditor: true });
      }
      schedulePersistedSessionSave();
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
  _lastResults  = {
    columns: columns,
    cachedPages: { 0: firstPageRows || [] },
    total: totalCount || 0,
    rows: (firstPageRows || []).slice()
  };
  window._lastResultRows = (firstPageRows || []).slice();
  window._lastResultCols = (columns || []).slice();
  if (typeof _dev !== 'undefined') {
    _dev.cols = (columns || []).slice();
    _dev.colWidths = {};
    _dev.colHeaders = {};
    _dev.colVisible = null;
    _dev.extraCols = [];
    _dev.extraBlankRows = 0;
  }
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
function buildSortedQuery(baseSql, col, dir) {
  var clean = (baseSql || '').trim().replace(/;\s*$/, '');
  var escapedCol = col.replace(/"/g, '""');

  var orderLimitMatch = clean.match(/^([\s\S]+?)\s+ORDER\s+BY\s+[\s\S]+?\s+(LIMIT\s+\d+(?:\s+OFFSET\s+\d+)?)$/i);
  if (orderLimitMatch) {
    return orderLimitMatch[1] + ' ORDER BY "' + escapedCol + '" ' + dir + ' ' + orderLimitMatch[2];
  }

  var limitMatch = clean.match(/^([\s\S]+?)\s+(LIMIT\s+\d+(?:\s+OFFSET\s+\d+)?)$/i);
  if (limitMatch) {
    return limitMatch[1] + ' ORDER BY "' + escapedCol + '" ' + dir + ' ' + limitMatch[2];
  }

  var orderOnlyMatch = clean.match(/^([\s\S]+?)\s+ORDER\s+BY\s+[^\(\)]+$/i);
  if (orderOnlyMatch) {
    return orderOnlyMatch[1] + ' ORDER BY "' + escapedCol + '" ' + dir;
  }

  return 'SELECT * FROM (\n  ' + clean + '\n) ORDER BY "' + escapedCol + '" ' + dir;
}

function toggleColumnSort(col) {
  var activeTab = _tabs.find(function(t) { return t.id === _activeTabId; });
  var ed = document.getElementById('sql-editor');
  var baseSql = (activeTab && activeTab.lastExecutedSql) || _lastExecutedSql || (ed ? ed.value.trim() : '');

  if (!baseSql && _activeTable) {
    baseSql = 'SELECT * FROM "' + _activeTable + '" LIMIT 5000';
  }
  if (!baseSql) return;

  if (_sortCol === col) {
    _sortDir = (_sortDir === 'ASC' ? 'DESC' : 'ASC');
  } else {
    _sortCol = col;
    _sortDir = 'ASC';
  }

  var sortColEl = document.getElementById('sort-col');
  var sortDirEl = document.getElementById('sort-dir');
  if (sortColEl) sortColEl.value = col;
  if (sortDirEl) sortDirEl.value = _sortDir;

  var sortedSql = buildSortedQuery(baseSql, col, _sortDir);
  setSqlStatus('Sorting by ' + col + ' ' + _sortDir + '…');

  apiCall('run_sql', sortedSql)
    .then(function(d) {
      setSqlStatus((d.count || 0).toLocaleString() + ' rows');
      renderResults(d.columns || [], d.rows || [], d.count || 0);
      schedulePersistedSessionSave();
    })
    .catch(function(e) {
      toast('Sort error: ' + e.message, 'error');
      setSqlStatus('⚠ ' + e.message);
    });
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

var _rowSearchTimer = null;
function filterResultRows(text) {
  clearTimeout(_rowSearchTimer);
  _rowSearchTimer = setTimeout(function() {
    _rowSearchTerm = (text || '').trim();
    drawPage(_currentPage);
  }, 150);
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
      if (rows && rows.length && _lastResults.rows) {
        _lastResults.rows = _lastResults.rows.concat(rows);
        window._lastResultRows = _lastResults.rows;
      }
      drawPage(page);
    }).catch(function(e) { toast('Error loading page: ' + e.message, 'error'); });
  } else {
    drawPage(page);
  }
}

/* ── Output Table Rectangular Drag-Selection & Auto-Scroll ─────────── */
var _tableDragStart = null;
var _tableDragCurrent = null;
var _isTableDragging = false;
var _tableDragCopied = false;
var _tableAutoScrollAnim = null;
var _tableAutoScrollDx = 0;
var _tableAutoScrollDy = 0;

function _runTableAutoScroll() {
  if (!_isTableDragging || (_tableAutoScrollDx === 0 && _tableAutoScrollDy === 0)) {
    _tableAutoScrollAnim = null;
    return;
  }
  var tbl = document.getElementById('results-table');
  var wrap = tbl ? tbl.parentElement : null;
  if (wrap) {
    if (_tableAutoScrollDx !== 0) wrap.scrollLeft += _tableAutoScrollDx;
    if (_tableAutoScrollDy !== 0) wrap.scrollTop += _tableAutoScrollDy;
  }
  _tableAutoScrollAnim = requestAnimationFrame(_runTableAutoScroll);
}

function _updateTableCellHighlights() {
  var body = document.getElementById('results-body');
  if (!body || !_tableDragStart || !_tableDragCurrent) return;

  var minR = Math.min(_tableDragStart.ri, _tableDragCurrent.ri);
  var maxR = Math.max(_tableDragStart.ri, _tableDragCurrent.ri);
  var minC = Math.min(_tableDragStart.ci, _tableDragCurrent.ci);
  var maxC = Math.max(_tableDragStart.ci, _tableDragCurrent.ci);

  var prev = body.querySelectorAll('.tbl-cell-selected');
  prev.forEach(function(td) { td.classList.remove('tbl-cell-selected'); });

  for (var r = minR; r <= maxR; r++) {
    var tr = body.children[r];
    if (!tr || tr.style.display === 'none') continue;
    for (var c = minC; c <= maxC; c++) {
      var td = tr.children[c];
      if (td) td.classList.add('tbl-cell-selected');
    }
  }
}

function initTableSelectionAndDragCopy() {
  var table = document.getElementById('results-table');
  if (!table || table._dragCopyInited) return;
  table._dragCopyInited = true;

  table.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return; // left click only
    var td = e.target.closest('td.tbl-cell');
    if (!td) return;
    var tr = td.parentElement;
    if (!tr || !tr.hasAttribute('data-row-idx')) return;

    var ri = parseInt(tr.getAttribute('data-row-idx'), 10);
    var ci = parseInt(td.getAttribute('data-col-idx'), 10);

    _tableDragStart = { ri: ri, ci: ci, clientX: e.clientX, clientY: e.clientY };
    _tableDragCurrent = { ri: ri, ci: ci };
    _isTableDragging = false;
  });

  window.addEventListener('mousemove', function(e) {
    if (!_tableDragStart) return;

    var dist = Math.hypot(e.clientX - _tableDragStart.clientX, e.clientY - _tableDragStart.clientY);
    if (dist > 5) {
      if (!_isTableDragging) {
        _isTableDragging = true;
        document.body.classList.add('tbl-selecting');
        try { window.getSelection().removeAllRanges(); } catch(err) {}
      }

      var tbl = document.getElementById('results-table');
      var wrap = tbl ? tbl.parentElement : null;
      if (wrap) {
        var rect = wrap.getBoundingClientRect();
        var edgeZone = 40;
        var maxSpeed = 16;
        _tableAutoScrollDx = 0;
        _tableAutoScrollDy = 0;

        if (e.clientY < rect.top + edgeZone) {
          _tableAutoScrollDy = -Math.round(maxSpeed * Math.min(2, Math.max(0.5, (rect.top + edgeZone - e.clientY) / edgeZone)));
        } else if (e.clientY > rect.bottom - edgeZone) {
          _tableAutoScrollDy = Math.round(maxSpeed * Math.min(2, Math.max(0.5, (e.clientY - (rect.bottom - edgeZone)) / edgeZone)));
        }

        if (e.clientX < rect.left + edgeZone) {
          _tableAutoScrollDx = -Math.round(maxSpeed * Math.min(2, Math.max(0.5, (rect.left + edgeZone - e.clientX) / edgeZone)));
        } else if (e.clientX > rect.right - edgeZone) {
          _tableAutoScrollDx = Math.round(maxSpeed * Math.min(2, Math.max(0.5, (e.clientX - (rect.right - edgeZone)) / edgeZone)));
        }

        if ((_tableAutoScrollDx !== 0 || _tableAutoScrollDy !== 0) && !_tableAutoScrollAnim) {
          _tableAutoScrollAnim = requestAnimationFrame(_runTableAutoScroll);
        }
      }

      var el = document.elementFromPoint(e.clientX, e.clientY);
      var td = el ? el.closest('#results-body td.tbl-cell') : null;
      if (td && td.parentElement && td.parentElement.hasAttribute('data-row-idx')) {
        var curRi = parseInt(td.parentElement.getAttribute('data-row-idx'), 10);
        var curCi = parseInt(td.getAttribute('data-col-idx'), 10);
        if (!isNaN(curRi) && !isNaN(curCi)) {
          _tableDragCurrent = { ri: curRi, ci: curCi };
          _updateTableCellHighlights();
        }
      }
    }
  });

  window.addEventListener('mouseup', function(e) {
    _tableAutoScrollDx = 0;
    _tableAutoScrollDy = 0;
    if (_tableAutoScrollAnim) {
      cancelAnimationFrame(_tableAutoScrollAnim);
      _tableAutoScrollAnim = null;
    }
    document.body.classList.remove('tbl-selecting');

    if (_isTableDragging && _tableDragStart && _tableDragCurrent) {
      var minR = Math.min(_tableDragStart.ri, _tableDragCurrent.ri);
      var maxR = Math.max(_tableDragStart.ri, _tableDragCurrent.ri);
      var minC = Math.min(_tableDragStart.ci, _tableDragCurrent.ci);
      var maxC = Math.max(_tableDragStart.ci, _tableDragCurrent.ci);

      var body = document.getElementById('results-body');
      if (body) {
        var csvLines = [];
        for (var r = minR; r <= maxR; r++) {
          var tr = body.children[r];
          if (!tr || tr.style.display === 'none') continue;
          var rowVals = [];
          for (var c = minC; c <= maxC; c++) {
            var cell = tr.children[c];
            var val = cell ? cell.textContent.trim() : '';
            if (val === 'NULL') val = '';
            if (val.indexOf(',') !== -1 || val.indexOf('"') !== -1 || val.indexOf('\n') !== -1) {
              val = '"' + val.replace(/"/g, '""') + '"';
            }
            rowVals.push(val);
          }
          csvLines.push(rowVals.join(','));
        }

        if (csvLines.length > 0) {
          var csvText = csvLines.join('\n');
          var numRows = maxR - minR + 1;
          var numCols = maxC - minC + 1;
          copyToClipboard(csvText, '✓ Copied ' + numRows + '×' + numCols + ' cells to clipboard as CSV');
          _tableDragCopied = true;
          setTimeout(function() { _tableDragCopied = false; }, 300);
        }

        // Keep selection highlight visible briefly for feedback, then clear
        setTimeout(function() {
          var prev = body.querySelectorAll('.tbl-cell-selected');
          prev.forEach(function(td) { td.classList.remove('tbl-cell-selected'); });
        }, 600);
      }
    }

    _tableDragStart = null;
    _tableDragCurrent = null;
    _isTableDragging = false;
  });
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
    tr.setAttribute('data-row-idx', i);
    tr.onclick = function(e) {
      if (_tableDragCopied) return;
      var wasSelected = this.classList.contains('tbl-row-selected');
      var allRows = body.querySelectorAll('.tbl-row-selected');
      allRows.forEach(function(r) { r.classList.remove('tbl-row-selected'); });
      if (!wasSelected) {
        this.classList.add('tbl-row-selected');
      }
    };
    
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
      td.setAttribute('data-col-idx', j);
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
  initTableSelectionAndDragCopy();

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

var _resColFilterTimer = null;
function filterResultColumns(term) {
  clearTimeout(_resColFilterTimer);
  _resColFilterTimer = setTimeout(function() {
    _colSearch = term;
    drawPage(_currentPage);
  }, 150);
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

  // Pre-fill organisation name from settings
  var orgInp = document.getElementById('pdf-org-name');
  if (orgInp) {
    orgInp.value = (document.getElementById('s-org-name') || {}).value || '';
  }
  var logoCb = document.getElementById('pdf-include-logo');
  if (logoCb) {
    logoCb.checked = true;
  }

  // Default to HTML mode so rich templates, presets, and scaling are active
  var useHtmlEl = document.getElementById('pdf-use-html');
  if (useHtmlEl) useHtmlEl.checked = true;

  openModal('modal-pdf-export');
  if (typeof loadExportModalCustomStyles === 'function') loadExportModalCustomStyles();
}

/* ── PDF Presets & Default Style ─────────────────────────────────────── */
var PDF_PRESETS = {
  'executive': `/* ==========================================================================
   🏢 EXECUTIVE SLATE — Complete Style Template
   Inspired by Document_Template.html — High Data Density & Clean Elegance
   ========================================================================== */
:root {
  --paper: #ffffff;
  --screen-bg: #e7ebf0;
  --navy: #0f172a;
  --navy-light: #1e293b;
  --gold: #b7791f;
  --accent: #b7791f;
  --text: #111827;
  --muted: #64748b;
  --border: #cbd5e1;
  --border-light: #e2e8f0;
  --border-dark: #94a3b8;
  --row-alt: #f8fafc;
  --table-head-bg: #0f172a;
  --table-head-text: #ffffff;
  --header-bg: #f8fafc;
  --data-font-weight: 400;
}

.pdf-page-sheet, .page {
  background: var(--paper);
  color: var(--text);
  font-family: "Libron", Georgia, serif;
}
.document-frame {
  border: 1.2px solid #9ca8b7;
}
.document-frame::after {
  border: 0.5px solid #e1e6eb;
}

.school-header, .masthead {
  background: var(--header-bg);
  border: 1px solid var(--border);
  border-top: 3px solid var(--gold);
  border-radius: 10px;
  padding: 12px 20px;
  margin-bottom: 14px;
}
.school-logo, .report-logo {
  width: 60px;
  height: 60px;
}
.school-info h2, .org-title {
  color: var(--navy);
  font-family: "Libron", Georgia, serif;
  font-size: 21px;
  font-weight: 800;
  letter-spacing: -0.01em;
}

.document-heading {
  border-bottom: 2px solid var(--navy);
  padding: 2px 0 10px;
  margin-bottom: 14px;
}
.heading-accent {
  background: var(--gold);
  width: 48px;
  height: 3px;
  border-radius: 4px;
}
.title, .report-title {
  color: var(--navy);
  font-family: "Libron", Georgia, serif;
  font-size: 22px;
  font-weight: 800;
}

.data-table-wrap {
  margin-bottom: 12px;
}
.data-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed !important;
  background: var(--paper, #ffffff);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  font-size: 8.5pt;
  line-height: 1.3;
}
.data-table thead th {
  background: var(--table-head-bg);
  color: var(--table-head-text);
  border-bottom: 2px solid var(--gold);
  padding: 6px 7px;
  font-size: 8pt;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
}
.data-table thead th .th-content {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
.data-table tbody tr {
  min-height: 26px;
  height: 26px;
  break-inside: avoid;
  page-break-inside: avoid;
}
.data-table tbody td {
  min-height: 26px;
  height: 26px;
  padding: 5px 7px;
  border-bottom: 1px solid var(--border-light);
  color: var(--text);
  font-variant-numeric: tabular-nums;
  word-break: break-word;
  overflow-wrap: break-word;
  box-sizing: border-box;
  background: #ffffff;
}
.data-table tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
.data-table tbody tr:hover td {
  background: #f1f5f9;
}

.report-footer {
  border-top: 1px solid var(--border-light);
  color: var(--muted);
  font-size: 7.5pt;
  padding-top: 8px;
  margin-top: 10px;
}`,

  'minimal': `/* ==========================================================================
   📰 FINANCIAL MINIMAL — Complete Style Template
   High-Clarity Monospace Tabular Design with Crisp Borders
   ========================================================================== */
:root {
  --paper: #ffffff;
  --navy: #1e293b;
  --navy-light: #334155;
  --gold: #64748b;
  --accent: #64748b;
  --text: #0f172a;
  --muted: #64748b;
  --border: #cbd5e1;
  --border-light: #e2e8f0;
  --border-dark: #94a3b8;
  --row-alt: #f8fafc;
  --table-head-bg: #f1f5f9;
  --table-head-text: #0f172a;
  --header-bg: #ffffff;
  --data-font-weight: 400;
}

.pdf-page-sheet, .page {
  background: var(--paper);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.document-frame {
  border: 1px solid #cbd5e1;
}
.document-frame::after {
  display: none;
}

.school-header, .masthead {
  background: var(--header-bg);
  border: 1px solid var(--border);
  border-top: 3px solid var(--navy);
  border-radius: 6px;
  padding: 10px 18px;
  margin-bottom: 12px;
}
.school-info h2, .org-title {
  color: var(--navy);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.document-heading {
  border-bottom: 1.5px solid var(--border);
  padding: 2px 0 8px;
  margin-bottom: 12px;
}
.heading-accent {
  background: var(--navy);
  width: 36px;
  height: 2px;
}
.title, .report-title {
  color: var(--navy);
  font-size: 20px;
  font-weight: 700;
}

.data-table-wrap {
  margin-bottom: 12px;
}
.data-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed !important;
  background: var(--paper, #ffffff);
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
  font-size: 8pt;
  line-height: 1.35;
}
.data-table thead th {
  background: var(--table-head-bg);
  color: var(--table-head-text);
  border-bottom: 2px solid #94a3b8;
  padding: 5.5px 7px;
  font-size: 7.5pt;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
}
.data-table thead th .th-content {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
.data-table tbody tr {
  min-height: 26px;
  height: 26px;
  break-inside: avoid;
  page-break-inside: avoid;
}
.data-table tbody td {
  min-height: 26px;
  height: 26px;
  padding: 4.5px 7px;
  border-bottom: 1px solid var(--border-light);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  word-break: break-word;
  overflow-wrap: break-word;
  box-sizing: border-box;
  background: #ffffff;
}
.data-table tbody tr:nth-child(even) td {
  background: #fafafa;
}
.data-table tbody tr:hover td {
  background: #f1f5f9;
}

.report-footer {
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 7pt;
  padding-top: 6px;
  margin-top: 8px;
  font-family: ui-monospace, monospace;
}`,

  'emerald': `/* ==========================================================================
   🌲 EMERALD CORPORATE — Complete Style Template
   Prestigious Deep Forest Emerald with Mint Accents
   ========================================================================== */
:root {
  --paper: #ffffff;
  --navy: #064e3b;
  --navy-light: #065f46;
  --gold: #059669;
  --accent: #059669;
  --text: #062b21;
  --muted: #047857;
  --border: #a7f3d0;
  --border-light: #d1fae5;
  --border-dark: #6ee7b7;
  --row-alt: #f0fdf4;
  --table-head-bg: #064e3b;
  --table-head-text: #ffffff;
  --header-bg: #f0fdf4;
  --data-font-weight: 400;
}

.pdf-page-sheet, .page {
  background: var(--paper);
  color: var(--text);
  font-family: "Libron", Georgia, serif;
}
.document-frame {
  border: 1.2px solid #6ee7b7;
}
.document-frame::after {
  border: 0.5px solid #a7f3d0;
}

.school-header, .masthead {
  background: var(--header-bg);
  border: 1px solid var(--border);
  border-top: 3px solid #059669;
  border-radius: 10px;
  padding: 12px 20px;
  margin-bottom: 14px;
}
.school-info h2, .org-title {
  color: var(--navy);
  font-family: "Libron", Georgia, serif;
  font-size: 21px;
  font-weight: 800;
}
.document-heading {
  border-bottom: 2px solid var(--navy);
  padding: 2px 0 10px;
  margin-bottom: 14px;
}
.heading-accent {
  background: #059669;
  width: 48px;
  height: 3px;
  border-radius: 4px;
}
.title, .report-title {
  color: var(--navy);
  font-family: "Libron", Georgia, serif;
  font-size: 22px;
  font-weight: 800;
}

.data-table-wrap {
  margin-bottom: 12px;
}
.data-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed !important;
  background: var(--paper, #ffffff);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  font-size: 8.5pt;
  line-height: 1.3;
}
.data-table thead th {
  background: var(--table-head-bg);
  color: var(--table-head-text);
  border-bottom: 2px solid #059669;
  padding: 6px 7px;
  font-size: 8pt;
  font-weight: 700;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
}
.data-table thead th .th-content {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
.data-table tbody tr {
  min-height: 26px;
  height: 26px;
  break-inside: avoid;
  page-break-inside: avoid;
}
.data-table tbody td {
  min-height: 26px;
  height: 26px;
  padding: 5px 7px;
  border-bottom: 1px solid var(--border-light);
  color: var(--text);
  font-variant-numeric: tabular-nums;
  word-break: break-word;
  overflow-wrap: break-word;
  box-sizing: border-box;
  background: #ffffff;
}
.data-table tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
.data-table tbody tr:hover td {
  background: #e6fcf0;
}

.report-footer {
  border-top: 1px solid var(--border);
  color: #065f46;
  font-size: 7.5pt;
  padding-top: 8px;
  margin-top: 10px;
}`,

  'tech': `/* ==========================================================================
   🟣 MODERN TECH — Complete Style Template
   Indigo & Violet Executive Theme Inspired by Stripe and Linear
   ========================================================================== */
:root {
  --paper: #ffffff;
  --navy: #312e81;
  --navy-light: #3730a3;
  --gold: #6366f1;
  --accent: #6366f1;
  --text: #1e1b4b;
  --muted: #6366f1;
  --border: #c7d2fe;
  --border-light: #e0e7ff;
  --border-dark: #a5b4fc;
  --row-alt: #f5f3ff;
  --table-head-bg: #312e81;
  --table-head-text: #ffffff;
  --header-bg: #f5f3ff;
  --data-font-weight: 400;
}

.pdf-page-sheet, .page {
  background: var(--paper);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.document-frame {
  border: 1.2px solid #a5b4fc;
}
.document-frame::after {
  border: 0.5px solid #c7d2fe;
}

.school-header, .masthead {
  background: var(--header-bg);
  border: 1px solid var(--border);
  border-top: 3px solid #6366f1;
  border-radius: 10px;
  padding: 12px 20px;
  margin-bottom: 14px;
}
.school-info h2, .org-title {
  color: var(--navy);
  font-size: 20px;
  font-weight: 800;
  letter-spacing: -0.02em;
}
.document-heading {
  border-bottom: 2px solid var(--navy);
  padding: 2px 0 10px;
  margin-bottom: 14px;
}
.heading-accent {
  background: #6366f1;
  width: 44px;
  height: 3px;
  border-radius: 4px;
}
.title, .report-title {
  color: var(--navy);
  font-size: 21px;
  font-weight: 800;
}

.data-table-wrap {
  margin-bottom: 12px;
}
.data-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed !important;
  background: var(--paper, #ffffff);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  font-size: 8.5pt;
  line-height: 1.3;
}
.data-table thead th {
  background: var(--table-head-bg);
  color: var(--table-head-text);
  border-bottom: 2px solid #6366f1;
  padding: 6px 7px;
  font-size: 8pt;
  font-weight: 700;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
}
.data-table thead th .th-content {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
.data-table tbody tr {
  min-height: 26px;
  height: 26px;
  break-inside: avoid;
  page-break-inside: avoid;
}
.data-table tbody td {
  min-height: 26px;
  height: 26px;
  padding: 5px 7px;
  border-bottom: 1px solid var(--border-light);
  color: var(--text);
  font-variant-numeric: tabular-nums;
  word-break: break-word;
  overflow-wrap: break-word;
  box-sizing: border-box;
  background: #ffffff;
}
.data-table tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
.data-table tbody tr:hover td {
  background: #ede9fe;
}

.report-footer {
  border-top: 1px solid var(--border);
  color: #4338ca;
  font-size: 7.5pt;
  padding-top: 8px;
  margin-top: 10px;
}`,

  'compact': `/* ==========================================================================
   📏 DENSE COMPACT — Complete Style Template
   Engineered for Maximum Data Density (7-12 Columns on A4 Portrait)
   ========================================================================== */
:root {
  --paper: #ffffff;
  --navy: #0f172a;
  --navy-light: #1e293b;
  --gold: #b7791f;
  --accent: #b7791f;
  --text: #0f172a;
  --muted: #64748b;
  --border: #cbd5e1;
  --border-light: #e2e8f0;
  --border-dark: #94a3b8;
  --row-alt: #f8fafc;
  --table-head-bg: #0f172a;
  --table-head-text: #ffffff;
  --header-bg: #f8fafc;
  --data-font-weight: 400;
}

.pdf-page-sheet, .page {
  background: var(--paper);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  padding: 8mm 10mm;
}
.document-frame {
  border: 1px solid #cbd5e1;
}

.school-header, .masthead {
  background: var(--header-bg);
  border: 1px solid var(--border);
  border-top: 2.5px solid var(--gold);
  border-radius: 6px;
  padding: 8px 14px;
  margin-bottom: 8px;
}
.school-info h2, .org-title {
  color: var(--navy);
  font-size: 16px;
  font-weight: 700;
}
.document-heading {
  border-bottom: 1.5px solid var(--navy);
  padding: 1px 0 6px;
  margin-bottom: 8px;
}
.heading-accent {
  background: var(--gold);
  width: 36px;
  height: 2px;
}
.title, .report-title {
  color: var(--navy);
  font-size: 17px;
  font-weight: 700;
}

.data-table-wrap {
  margin-bottom: 8px;
}
.data-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed !important;
  background: var(--paper, #ffffff);
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
  font-size: 8pt;
  line-height: 1.25;
}
.data-table thead th {
  background: var(--table-head-bg);
  color: var(--table-head-text);
  border-bottom: 1.5px solid var(--gold);
  padding: 4px 5px;
  font-size: 7.5pt;
  font-weight: 700;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
}
.data-table thead th .th-content {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
.data-table tbody tr {
  min-height: 26px;
  height: 26px;
  break-inside: avoid;
  page-break-inside: avoid;
}
.data-table tbody td {
  min-height: 26px;
  height: 26px;
  padding: 3.5px 5px;
  border-bottom: 1px solid var(--border-light);
  color: var(--text);
  font-variant-numeric: tabular-nums;
  word-break: break-word;
  overflow-wrap: break-word;
  box-sizing: border-box;
  background: #ffffff;
}
.data-table tbody tr:nth-child(even) td {
  background: var(--row-alt);
}
.data-table tbody tr:hover td {
  background: #f1f5f9;
}

.report-footer {
  border-top: 1px solid var(--border-light);
  color: var(--muted);
  font-size: 7pt;
  padding-top: 5px;
  margin-top: 6px;
}`
};
window.PDF_PRESETS = PDF_PRESETS;

function applyPdfPreset(name) {
  if (!PDF_PRESETS[name]) return;
  var cssText = PDF_PRESETS[name];
  var useHtml = document.getElementById('pdf-use-html');
  if (useHtml) useHtml.checked = true;
  var section = document.getElementById('pdf-css-section');
  if (section) section.classList.remove('hidden');
  var cssEl = document.getElementById('pdf-custom-css');
  if (cssEl) cssEl.value = cssText;
  var sInp = document.getElementById('s-pdf-custom-css');
  if (sInp) sInp.value = cssText;
  _pdfCustomCss = cssText;
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

  var orgInp = document.getElementById('pdf-org-name');
  var org    = (orgInp && orgInp.value.trim()) ? orgInp.value.trim() : ((document.getElementById('s-org-name') || {}).value || '');
  var logoCb = document.getElementById('pdf-include-logo');
  var inclLogo = logoCb ? logoCb.checked : true;

  // Prefer square logo for PDF (it's used as the circular header logo)
  var sqEl  = document.getElementById('logo-sq-img');
  var imgEl = document.getElementById('logo-img');
  var logo  = '';
  if (inclLogo) {
    logo = (sqEl  && sqEl.src  && sqEl.src.indexOf('base64,')  !== -1) ? sqEl.src.replace(/^data:[^;]+;base64,/, '')  :
           (imgEl && imgEl.src && imgEl.src.indexOf('base64,') !== -1) ? imgEl.src.replace(/^data:[^;]+;base64,/, '') : '';
  }
  var sql   = inclQuery ? ((document.getElementById('sql-editor') || {}).value || '') : '';
  var sourceLabel = inclSource ? (_selectedTables.length > 1 ? _selectedTables.join(', ') : _activeTable) : '';


  var boldEl    = document.getElementById('pdf-bold-data');
  var gridEl    = document.getElementById('pdf-grid-lines');
  var boldData  = boldEl ? boldEl.checked : false;
  var gridLines = gridEl ? gridEl.checked : false;

  var cBlankRows = (typeof _dev !== 'undefined' && _dev.extraBlankRows) ? _dev.extraBlankRows : 0;
  var cExtraCols = (typeof _dev !== 'undefined' && _dev.extraCols) ? _dev.extraCols : [];
  var visArr     = (typeof _dev !== 'undefined' && _dev.colVisible) ? Array.from(_dev.colVisible) : null;
  var cWidths    = (typeof _dev !== 'undefined') ? _dev.colWidths : {};
  var cHeads     = (typeof _dev !== 'undefined') ? _dev.colHeaders : {};
  var cFullO     = (typeof _dev !== 'undefined') ? _dev.fullOverride : false;
  var cBold      = (typeof _dev !== 'undefined' && _dev.boldData !== undefined) ? _dev.boldData : boldData;
  var cGrid      = (typeof _dev !== 'undefined' && _dev.showGridLines !== undefined) ? _dev.showGridLines : gridLines;
  var wmCb       = document.getElementById('pdf-include-watermark');
  var inclWatermark = (typeof _dev !== 'undefined' && _dev.inclWatermark !== undefined)
    ? _dev.inclWatermark
    : (wmCb ? wmCb.checked : true);

  closeModal();
  showProgress(true);
  toast('⚡ Generating PDF…', 'info');

  var apiMethod = useHtml ? 'export_pdf_html' : 'export_pdf';
  if (useHtml) {
    apiCall('export_pdf_html', filepath, title, org, logo, sql, sourceLabel, customCss, pageSize, orient, scale, cWidths, cHeads, visArr, cFullO, cBold, cGrid, cBlankRows, cExtraCols, inclWatermark)
      .then(function(r) { showProgress(false); if (r) toast('✓ PDF saved: ' + safeName + '.pdf'); })
      .catch(function(e) { showProgress(false); toast('Export failed: ' + e.message, 'error'); });
  } else {
    apiCall('export_pdf', filepath, title, "", org, logo, sql, null, pageSize, orient, scale, continuous, sourceLabel, cWidths, cHeads, visArr, cBlankRows, cExtraCols, inclWatermark)
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
    refreshOpenSchemaPanel();
  }
}

function refreshOpenSchemaPanel() {
  var panel = document.getElementById('schema-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  var currentTables = (_selectedTables && _selectedTables.length > 0) ? _selectedTables : (_activeTable ? [_activeTable] : []);
  var targetTables = _allSchemaData.filter(function(t) { return currentTables.indexOf(t.table) !== -1; });
  var html = '';
  targetTables.forEach(function(t) {
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
  if (!html) html = '<div style="padding:12px;font-size:11px;color:var(--text-dim)">No selected tables.</div>';
  panel.innerHTML = html;
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
var _allFileListItems = [];
var _fileListSortCol = 'date';
var _fileListSortDir = 'desc';
var _fileListSearchTerm = '';

function openFileList() {
  var tbody   = document.getElementById('filelist-tbody');
  var emptyEl = document.getElementById('filelist-empty');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:12px;font-size:11px;color:var(--text-dim)">Loading…</td></tr>';
  var searchInp = document.getElementById('filelist-search');
  if (searchInp) searchInp.value = '';
  _fileListSearchTerm = '';
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

    _allSchemaData = schema;
    renderSchemaTree(schema);

    // Build map: table → history row
    var histMap = {};
    history.forEach(function(h) { histMap[h.table_name] = h; });

    _allFileListItems = schema.map(function(t) {
      var h = histMap[t.table] || {};
      var userCols = t.columns.filter(function(c) { return !c.name.startsWith('_'); });
      var fname = (h.filename || '').toLowerCase();
      var isCsv = fname.endsWith('.csv') || fname === 'csv_editor' || (!h.filename && !fname.endsWith('.xls') && !fname.endsWith('.xlsx') && !fname.endsWith('.ods'));
      return {
        table: t.table,
        filename: h.filename || '—',
        imported_at: h.imported_at || '',
        rows_imported: h.rows_imported || 0,
        colsCount: userCols.length,
        isCsv: isCsv
      };
    });

    renderFileListTable();
  }).catch(function(e) { toast('Error loading file list: ' + e.message, 'error'); });
}

function toggleFileListSort(col) {
  if (_fileListSortCol === col) {
    _fileListSortDir = _fileListSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    _fileListSortCol = col;
    _fileListSortDir = col === 'table' ? 'asc' : 'desc';
  }
  renderFileListTable();
}

function filterFileList(term) {
  _fileListSearchTerm = (term || '').trim().toLowerCase();
  renderFileListTable();
}

function renderFileListTable() {
  var tbody   = document.getElementById('filelist-tbody');
  var emptyEl = document.getElementById('filelist-empty');
  if (!tbody) return;

  var sortTableEl = document.getElementById('filelist-sort-table');
  var sortDateEl  = document.getElementById('filelist-sort-date');
  if (sortTableEl) sortTableEl.textContent = _fileListSortCol === 'table' ? (_fileListSortDir === 'asc' ? '▲' : '▼') : '↕';
  if (sortDateEl)  sortDateEl.textContent  = _fileListSortCol === 'date'  ? (_fileListSortDir === 'asc' ? '▲' : '▼') : '↕';

  var items = _allFileListItems.slice();

  if (_fileListSearchTerm) {
    items = items.filter(function(it) {
      return (it.table && it.table.toLowerCase().indexOf(_fileListSearchTerm) !== -1) ||
             (it.filename && it.filename.toLowerCase().indexOf(_fileListSearchTerm) !== -1);
    });
  }

  items.sort(function(a, b) {
    var res = 0;
    if (_fileListSortCol === 'table') {
      res = a.table.localeCompare(b.table);
    } else {
      res = (a.imported_at || '').localeCompare(b.imported_at || '');
    }
    return _fileListSortDir === 'asc' ? res : -res;
  });

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:16px;font-size:11px;color:var(--text-dim)">No matching tables found.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  items.forEach(function(it) {
    var isSelected = _selectedTables.indexOf(it.table) !== -1;
    var tr = document.createElement('tr');
    tr.className = 'tbl-row' + (isSelected ? ' selected-row' : '');
    var editBtnHtml = it.isCsv
      ? '<button onclick="openCsvEditorForTable(\'' + esc(it.table) + '\')" style="font-size:10px;color:var(--accent);background:none;border:none;cursor:pointer;text-decoration:underline;margin-right:6px" title="Edit CSV table in spreadsheet editor">✏️ Edit</button>'
      : '';
    tr.innerHTML =
      '<td class="tbl-cell" style="text-align:center"><input type="checkbox" class="table-checkbox" data-table="' + esc(it.table) + '"' + (isSelected ? ' checked' : '') + '></td>' +
      '<td class="tbl-cell" style="font-family:monospace;font-size:11px;font-weight:600;color:var(--text-head)">' + esc(it.table) + '</td>' +
      '<td class="tbl-cell" style="color:var(--text-dim)">' + esc(it.filename) + '</td>' +
      '<td class="tbl-cell" style="color:var(--text-dim)">' + esc((it.imported_at || '').slice(0, 19)) + '</td>' +
      '<td class="tbl-cell text-right">' + (it.rows_imported || 0).toLocaleString() + '</td>' +
      '<td class="tbl-cell text-right">' + it.colsCount + '</td>' +
      '<td class="tbl-cell" style="text-align:center">' +
        editBtnHtml +
        '<button onclick="fileListSelect(\'' + esc(it.table) + '\')" style="font-size:10px;color:var(--accent);background:none;border:none;cursor:pointer;text-decoration:underline;margin-right:6px" title="Use this table alone">Use</button>' +
        '<button onclick="fileListDrop(\'' + esc(it.table) + '\')" style="font-size:10px;color:var(--danger);background:none;border:none;cursor:pointer" title="Delete table">🗑</button>' +
      '</td>';
    tbody.appendChild(tr);
  });
}

function toggleCheckAll(cb) {
  document.querySelectorAll('.table-checkbox').forEach(function(el) { el.checked = cb.checked; });
}

function fileListSelect(name) {
  closeModal();
  exitJoinMode();
  if (!_allSchemaData.length) {
    apiCall('get_schema').then(function(schema) {
      _allSchemaData = schema || [];
      syncTableSelection([name], { onTableChange: true });
    });
  } else {
    syncTableSelection([name], { onTableChange: true });
  }
}

function fileListDrop(name) {
  if (!confirm('Delete table "' + name + '"? This cannot be undone.')) return;
  apiCall('drop_table', name)
    .then(function() {
      toast('Table "' + name + '" deleted.');
      var rem = (_selectedTables || []).filter(function(t) { return t !== name; });
      syncTableSelection(rem, { onTableChange: (rem.length > 0) });
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

  if (checked.length === 1) {
    exitJoinMode();
    syncTableSelection(checked, { onTableChange: true });
  } else {
    syncTableSelection(checked);
    enterJoinMode(checked);
  }
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
  renderSchemaTree(_allSchemaData);
  refreshOpenSchemaPanel();
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
  if (_activeTable) { _selectedTables = [_activeTable]; }

  var sel = document.getElementById('table-select');
  if (sel) {
    var oldOpt = sel.querySelector('.join-option');
    if (oldOpt) oldOpt.remove();
    if (_activeTable && sel.querySelector('option[value="' + _activeTable.replace(/"/g, '\\"') + '"]')) {
      sel.value = _activeTable;
    }
  }
  renderSchemaTree(_allSchemaData);
  refreshOpenSchemaPanel();
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
  if (ed._lastLineCount !== count) {
    ed._lastLineCount = count;
    var h = '';
    for (var i = 1; i <= count; i++) h += i + '\n';
    lines.textContent = h;
  }
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

/* ── Multi-Tab Management & Split View Comparison Panes ─────────────── */
var _tabs = [];
var _activeTabId = 'tab_1';
var _secondaryTabId = null;
var _focusedPane = 'primary';
var _splitActive = false;
var _tabSeq = 1;
var _lastResultsB = null;
var _saveSessionDebounceTid = null;
function schedulePersistedSessionSave() {
  if (_saveSessionDebounceTid) clearTimeout(_saveSessionDebounceTid);
  _saveSessionDebounceTid = setTimeout(savePersistedSession, 750);
}

function savePersistedSession() {
  if (new URLSearchParams(window.location.search).get('window_id')) return;
  if (!_tabs || !_tabs.length) return;
  saveTabState(_activeTabId);
  var payload = {
    tabs: _tabs,
    activeTabId: _activeTabId,
    secondaryTabId: _secondaryTabId,
    splitActive: _splitActive,
    focusedPane: _focusedPane,
    selectedTables: _selectedTables || [],
    activeTable: _activeTable || '',
    savedAt: Date.now()
  };
  apiCall('save_persisted_tabs', JSON.stringify(payload)).catch(function(){});
}

function restorePersistedSession() {
  return apiCall('get_persisted_tabs').then(function(raw) {
    if (!raw) return false;
    try {
      var sess = JSON.parse(raw);
      if (sess && Array.isArray(sess.tabs) && sess.tabs.length > 0) {
        _tabs = sess.tabs;
        _activeTabId = sess.activeTabId || _tabs[0].id;
        _secondaryTabId = sess.secondaryTabId || (_tabs[1] ? _tabs[1].id : null);
        _splitActive = !!sess.splitActive;
        _focusedPane = sess.focusedPane || 'primary';

        var maxSeq = 1;
        _tabs.forEach(function(t) {
          var num = parseInt(String(t.id || '').replace('tab_', ''), 10);
          if (!isNaN(num) && num > maxSeq) maxSeq = num;
        });
        _tabSeq = maxSeq;

        var validTables = (_allSchemaData || []).map(function(t) { return t.table; });
        if (validTables.length === 0) {
          _activeTable = '';
          _selectedTables = [];
          _tabs.forEach(function(t) {
            t.activeTable = '';
            t.selectedTables = [];
            t.tableColumns = [];
          });
        } else {
          _tabs.forEach(function(t) {
            if (t.selectedTables) {
              t.selectedTables = t.selectedTables.filter(function(tbl) { return validTables.indexOf(tbl) !== -1; });
            }
            if (t.activeTable && validTables.indexOf(t.activeTable) === -1) {
              t.activeTable = validTables[0] || '';
            }
          });
          _selectedTables = sess.selectedTables ? sess.selectedTables.filter(function(tbl) { return validTables.indexOf(tbl) !== -1; }) : [];
          _activeTable = (sess.activeTable && validTables.indexOf(sess.activeTable) !== -1) ? sess.activeTable : (validTables[0] || '');
        }

        renderTabStrip();
        renderLeftPanelTableMultiSelect();
        updateAiContextTableDropdown();
        restoreTabState(_activeTabId, 'primary');
        if (_splitActive && _secondaryTabId) {
          restoreTabState(_secondaryTabId, 'secondary');
        }
        return true;
      }
    } catch(e) {
      console.error('Error parsing persisted tabs', e);
    }
    return false;
  }).catch(function() { return false; });
}

function initCleanZeroState() {
  _activeTable = '';
  _selectedTables = [];
  _tableColumns = [];
  _tabs = [{
    id: 'tab_1',
    title: 'Query 1',
    activeTable: '',
    selectedTables: [],
    joinClauses: [],
    tableColumns: [],
    sql: '',
    filterGroups: [],
    groupCounter: 0,
    itemCounter: 0,
    selectPills: [],
    groupByPills: [],
    havingAgg: '',
    havingOp: '>',
    havingVal: '',
    sortCol: '',
    sortDir: 'ASC',
    limit: '5000',
    results: null,
    currentPage: 0,
    sqlStatus: '',
    aiChatHistory: [],
    aiContextTables: '__ALL__'
  }];
  _activeTabId = 'tab_1';
  _tabSeq = 1;
  renderTabStrip();
  updateSplitDropdown();
  var edA = document.getElementById('sql-editor');
  if (edA) { edA.value = ''; syncSqlLines(); }
  setSqlStatus('');
  renderResults([], [], 0);
  renderSchemaTree([]);
  refreshOpenSchemaPanel();
  renderLeftPanelTableMultiSelect();
  updateAiContextTableDropdown();
}
window.addEventListener('beforeunload', savePersistedSession);

function createNewTab(initialData) {
  _tabSeq++;
  var newId = 'tab_' + _tabSeq;
  var title = (initialData && initialData.title) ? initialData.title : ('Query ' + _tabSeq);

  var newTab = {
    id: newId,
    title: title,
    activeTable: (initialData && initialData.activeTable) || _activeTable || '',
    selectedTables: (initialData && initialData.selectedTables) || (_activeTable ? [_activeTable] : []),
    joinClauses: (initialData && initialData.joinClauses) || [],
    tableColumns: (initialData && initialData.tableColumns) || _tableColumns.slice(),
    sql: (initialData && initialData.sql) || '',
    filterGroups: (initialData && initialData.filterGroups) || [],
    groupCounter: (initialData && initialData.groupCounter) || 0,
    itemCounter: (initialData && initialData.itemCounter) || 0,
    selectPills: (initialData && initialData.selectPills) || [],
    groupByPills: (initialData && initialData.groupByPills) || [],
    havingAgg: (initialData && initialData.havingAgg) || '',
    havingOp: (initialData && initialData.havingOp) || '>',
    havingVal: (initialData && initialData.havingVal) || '',
    sortCol: (initialData && initialData.sortCol) || '',
    sortDir: (initialData && initialData.sortDir) || 'ASC',
    limit: (initialData && initialData.limit) || '5000',
    results: (initialData && initialData.results) || null,
    currentPage: 0,
    sqlStatus: (initialData && initialData.sqlStatus) || '',
    aiChatHistory: (initialData && initialData.aiChatHistory) ? initialData.aiChatHistory.slice() : [],
    aiContextTable: (initialData && initialData.aiContextTable) || '__ACTIVE__'
  };

  _tabs.push(newTab);
  renderTabStrip();
  updateSplitDropdown();
  switchTab(newId);
  return newTab;
}

function saveTabState(tabId, pane) {
  if (!tabId) return;
  var tab = _tabs.find(function(t) { return t.id === tabId; });
  if (!tab) return;

  pane = pane || (_splitActive && _focusedPane === 'secondary' && tabId === _secondaryTabId ? 'secondary' : 'primary');

  if (pane === 'secondary') {
    var edB = document.getElementById('sql-editor-b');
    var stB = document.getElementById('sql-status-b');
    if (edB) tab.sql = edB.value;
    if (stB) tab.sqlStatus = stB.textContent;
    if (_lastResultsB) tab.results = _lastResultsB;
  } else {
    var edA = document.getElementById('sql-editor');
    var stA = document.getElementById('sql-status');
    if (edA) tab.sql = edA.value;
    if (stA) tab.sqlStatus = stA.textContent;
    tab.activeTable = _activeTable;
    tab.selectedTables = _selectedTables.slice();
    tab.joinClauses = JSON.parse(JSON.stringify(_joinClauses));
    tab.tableColumns = _tableColumns.slice();

    syncFilterState();
    tab.filterGroups = JSON.parse(JSON.stringify(_filterGroups));
    tab.groupCounter = _groupCounter;
    tab.itemCounter = _itemCounter;
    tab.selectPills = JSON.parse(JSON.stringify(_selectPills));
    tab.groupByPills = JSON.parse(JSON.stringify(_groupByPills));

    var hAgg = document.getElementById('having-agg');
    var hOp = document.getElementById('having-op');
    var hVal = document.getElementById('having-val');
    tab.havingAgg = hAgg ? hAgg.value : '';
    tab.havingOp = hOp ? hOp.value : '>';
    tab.havingVal = hVal ? hVal.value : '';

    var sCol = document.getElementById('sort-col');
    var sDir = document.getElementById('sort-dir');
    tab.sortCol = sCol ? sCol.value : '';
    tab.sortDir = sDir ? sDir.value : 'ASC';

    var lim = document.getElementById('result-limit');
    tab.limit = lim ? lim.value : '5000';

    if (_lastResults) tab.results = _lastResults;
    tab.currentPage = _currentPage;

    if (_activeTabAiHistory) {
      tab.aiChatHistory = _activeTabAiHistory.slice();
    }
    var ctxSel = document.getElementById('ai-context-table-sel');
    if (ctxSel) {
      tab.aiContextTable = ctxSel.value;
    }
  }
}

function restoreTabState(tabId, pane) {
  var tab = _tabs.find(function(t) { return t.id === tabId; });
  if (!tab) return;

  if (pane === 'secondary') {
    var edB = document.getElementById('sql-editor-b');
    var stB = document.getElementById('sql-status-b');
    if (edB) { edB.value = tab.sql || ''; syncSqlLinesSecondary(); }
    if (stB) setSqlStatusSecondary(tab.sqlStatus || '');
    if (tab.results) {
      renderResultsSecondary(tab.results.columns || [], tab.results.rows || [], tab.results.count || (tab.results.rows ? tab.results.rows.length : 0));
    } else {
      renderResultsSecondary([], [], 0);
    }
  } else {
    var edA = document.getElementById('sql-editor');
    if (edA) { edA.value = tab.sql || ''; syncSqlLines(); }
    setSqlStatus(tab.sqlStatus || '');

    _activeTable = tab.activeTable || '';
    _selectedTables = tab.selectedTables && tab.selectedTables.length ? tab.selectedTables.slice() : (_activeTable ? [_activeTable] : []);
    _joinClauses = tab.joinClauses ? JSON.parse(JSON.stringify(tab.joinClauses)) : [];
    _tableColumns = tab.tableColumns ? tab.tableColumns.slice() : [];

    var sel = document.getElementById('table-select');
    if (sel && _activeTable) sel.value = _activeTable;

    var atb = document.getElementById('active-table-badge');
    var atn = document.getElementById('active-table-name');
    var btd = document.getElementById('btn-drop-table');
    var feh = document.getElementById('filter-empty-hint');
    if (atn) atn.textContent = _activeTable;
    if (_activeTable) {
      if (atb) atb.classList.remove('hidden');
      if (btd) btd.classList.remove('hidden');
      if (feh) feh.classList.add('hidden');
    } else {
      if (atb) atb.classList.add('hidden');
      if (btd) btd.classList.add('hidden');
      if (feh) feh.classList.remove('hidden');
    }

    renderSchemaTree(_allSchemaData);
    refreshOpenSchemaPanel();

    rebuildSortDropdown();
    buildAggDropdowns();

    _selectPills = tab.selectPills ? JSON.parse(JSON.stringify(tab.selectPills)) : [];
    renderSelectPills();

    _groupByPills = tab.groupByPills ? JSON.parse(JSON.stringify(tab.groupByPills)) : [];
    renderGroupByPills();

    var sCol = document.getElementById('sort-col');
    var sDir = document.getElementById('sort-dir');
    if (sCol && tab.sortCol) sCol.value = tab.sortCol;
    if (sDir && tab.sortDir) sDir.value = tab.sortDir;

    var lim = document.getElementById('result-limit');
    if (lim && tab.limit) lim.value = tab.limit;

    var hAgg = document.getElementById('having-agg');
    var hOp = document.getElementById('having-op');
    var hVal = document.getElementById('having-val');
    if (hAgg) hAgg.value = tab.havingAgg || '';
    if (hOp) hOp.value = tab.havingOp || '>';
    if (hVal) hVal.value = tab.havingVal || '';

    _filterGroups = tab.filterGroups ? JSON.parse(JSON.stringify(tab.filterGroups)) : [];
    _groupCounter = tab.groupCounter || 0;
    _itemCounter = tab.itemCounter || 0;
    renderFilterGroups();

    if (tab.results) {
      renderResults(tab.results.columns || [], tab.results.rows || [], tab.results.count || (tab.results.rows ? tab.results.rows.length : 0));
    } else {
      renderResults([], [], 0);
    }

    _activeTabAiHistory = (tab.aiChatHistory && Array.isArray(tab.aiChatHistory)) ? tab.aiChatHistory.slice() : [];
    updateAiContextTableDropdown();
    var ctxSel = document.getElementById('ai-context-table-sel');
    if (ctxSel && tab.aiContextTable) ctxSel.value = tab.aiContextTable;
    renderActiveTabAiMessages();
    updateAiProviderBadge();
  }
}

function switchTab(tabId, targetPane) {
  targetPane = targetPane || (_splitActive && _focusedPane === 'secondary' ? 'secondary' : 'primary');

  if (targetPane === 'secondary') {
    if (_secondaryTabId === tabId) return;
    saveTabState(_secondaryTabId, 'secondary');
    _secondaryTabId = tabId;
    restoreTabState(tabId, 'secondary');
    updateSplitDropdown();
    renderTabStrip();
  } else {
    if (_activeTabId === tabId) return;
    saveTabState(_activeTabId, 'primary');
    _activeTabId = tabId;
    restoreTabState(tabId, 'primary');
    renderTabStrip();
    updateSplitDropdown();
  }
}

function closeTab(tabId) {
  if (_tabs.length <= 1) {
    toast('Cannot close the only tab.', 'warn');
    return;
  }
  var idx = _tabs.findIndex(function(t) { return t.id === tabId; });
  if (idx === -1) return;

  _tabs.splice(idx, 1);

  if (_activeTabId === tabId) {
    var nextTab = _tabs[Math.max(0, idx - 1)];
    _activeTabId = nextTab.id;
    restoreTabState(_activeTabId, 'primary');
  }
  if (_secondaryTabId === tabId) {
    var nextSec = _tabs.find(function(t) { return t.id !== _activeTabId; }) || _tabs[0];
    _secondaryTabId = nextSec.id;
    if (_splitActive) {
      restoreTabState(_secondaryTabId, 'secondary');
    }
  }

  renderTabStrip();
  updateSplitDropdown();
}

function renameTab(tabId, newTitle) {
  var tab = _tabs.find(function(t) { return t.id === tabId; });
  if (!tab) return;
  if (!newTitle) {
    newTitle = prompt('Enter new tab name:', tab.title);
  }
  if (newTitle && newTitle.trim()) {
    tab.title = newTitle.trim();
    renderTabStrip();
    updateSplitDropdown();
  }
}

var _draggingTabId = null;

function renderTabStrip() {
  var strip = document.getElementById('tab-strip');
  if (!strip) return;
  strip.innerHTML = '';

  var isDetachedWindow = !!(new URLSearchParams(window.location.search).get('window_id'));

  _tabs.forEach(function(t) {
    var isPrimary = (t.id === _activeTabId);
    var isSecondary = (_splitActive && t.id === _secondaryTabId);

    var pill = document.createElement('div');
    pill.className = 'tab-strip-item' + (isPrimary ? ' active' : '') + (isSecondary ? ' active-secondary' : '');
    pill.title = t.title + ' (double-click to rename, drag out to detach)';
    pill.draggable = true;

    pill.ondragstart = function(e) {
      saveTabState(t.id);
      _draggingTabId = t.id;
      var transferPayload = JSON.stringify({
        queriiTab: true,
        tab: t,
        sourceWindowId: new URLSearchParams(window.location.search).get('window_id') || 'main'
      });
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('application/x-querii-tab', transferPayload);
      e.dataTransfer.setData('application/json', transferPayload);
      // NOTE: Do not set text/plain because Linux desktop shells create dropped text files on the desktop!
      apiCall('set_active_drag_tab', transferPayload);
      pill.classList.add('tab-dragging');

      var dz = document.getElementById('tab-detach-dropzone');
      if (dz) dz.classList.remove('hidden');
    };

    pill.ondragend = function(e) {
      pill.classList.remove('tab-dragging');
      var dz = document.getElementById('tab-detach-dropzone');
      if (dz) dz.classList.add('hidden');
      apiCall('clear_active_drag_tab');

      // Check if this tab was transferred to another window
      apiCall('is_tab_transferred', t.id).then(function(transferred) {
        if (transferred) {
          closeTab(t.id);
        } else if (e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight) {
          detachTabToNewWindow(t.id);
        }
      }).catch(function() {
        if (e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight) {
          detachTabToNewWindow(t.id);
        }
      });
    };

    pill.ondragover = function(e) { e.preventDefault(); };
    pill.ondrop = function(e) {
      e.preventDefault();
      var raw = e.dataTransfer.getData('application/x-querii-tab') || e.dataTransfer.getData('application/json');
      if (!raw) return;
      if (raw.startsWith('querii_tab:')) raw = raw.slice('querii_tab:'.length);
      try {
        var parsed = JSON.parse(raw);
        var srcId = parsed.tab ? parsed.tab.id : (parsed.id || raw);
        if (srcId && srcId !== t.id) {
          var srcIdx = _tabs.findIndex(function(x) { return x.id === srcId; });
          var dstIdx = _tabs.findIndex(function(x) { return x.id === t.id; });
          if (srcIdx !== -1 && dstIdx !== -1) {
            var moved = _tabs.splice(srcIdx, 1)[0];
            _tabs.splice(dstIdx, 0, moved);
            renderTabStrip();
            schedulePersistedSessionSave();
          }
        }
      } catch(err) {}
    };

    pill.onclick = function() {
      if (_splitActive && _focusedPane === 'secondary') {
        switchTab(t.id, 'secondary');
      } else {
        switchTab(t.id, 'primary');
      }
    };

    pill.ondblclick = function(e) {
      e.stopPropagation();
      renameTab(t.id);
    };

    var indicator = isPrimary ? '🗲 ' : (isSecondary ? '◫ ' : '');
    var titleSpan = document.createElement('span');
    titleSpan.className = 'tab-title-text';
    titleSpan.textContent = indicator + t.title;
    pill.appendChild(titleSpan);

    var popBtn = document.createElement('button');
    popBtn.className = 'tab-popout-btn';
    popBtn.title = 'Detach tab into separate window';
    popBtn.innerHTML = '↗';
    popBtn.onclick = function(e) {
      e.stopPropagation();
      detachTabToNewWindow(t.id);
    };
    pill.appendChild(popBtn);

    if (_tabs.length > 1) {
      var closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close-btn';
      closeBtn.title = 'Close tab';
      closeBtn.innerHTML = '✕';
      closeBtn.onclick = function(e) {
        e.stopPropagation();
        closeTab(t.id);
      };
      pill.appendChild(closeBtn);
    }

    strip.appendChild(pill);
  });

  if (isDetachedWindow) {
    var reattachBtn = document.createElement('button');
    reattachBtn.className = 'tab-reattach-btn';
    reattachBtn.style.cssText = 'margin-left:auto;font-size:10.5px;padding:3px 10px;border-radius:6px;background:var(--bg-muted);border:1px solid var(--border);color:var(--accent);font-weight:600;cursor:pointer';
    reattachBtn.innerHTML = '↩ Attach to Main';
    reattachBtn.title = 'Reattach this tab back to the primary main window and close this window';
    reattachBtn.onclick = function() {
      reattachCurrentWindowToMain();
    };
    strip.appendChild(reattachBtn);
  }

  // Setup tab strip drop target for attaching tabs from other windows
  strip.ondragover = function(e) {
    e.preventDefault();
    strip.classList.add('tab-drop-active');
  };
  strip.ondragleave = function(e) {
    strip.classList.remove('tab-drop-active');
  };
  strip.ondrop = function(e) {
    e.preventDefault();
    strip.classList.remove('tab-drop-active');
    var raw = e.dataTransfer.getData('application/x-querii-tab') || e.dataTransfer.getData('application/json');

    function applyDropPayload(payloadText) {
      if (!payloadText) return;
      if (payloadText.startsWith('querii_tab:')) payloadText = payloadText.slice('querii_tab:'.length);
      try {
        var parsed = JSON.parse(payloadText);
        var tabData = parsed.tab || parsed;
        if (tabData && tabData.id) {
          var existing = _tabs.find(function(x) { return x.id === tabData.id; });
          if (!existing) {
            _tabs.push(tabData);
            renderTabStrip();
            switchTab(tabData.id);
            apiCall('notify_tab_transferred', tabData.id);
            schedulePersistedSessionSave();
            toast('✓ Tab "' + (tabData.title || 'Tab') + '" attached to this window!');
          } else {
            switchTab(tabData.id);
          }
        }
      } catch(err) {
        console.error('Failed to attach tab:', err);
      }
    }

    if (raw) {
      applyDropPayload(raw);
    } else {
      apiCall('get_active_drag_tab').then(function(backendPayload) {
        if (backendPayload) applyDropPayload(backendPayload);
      });
    }
  };

  // Setup Detach dropzone event listeners
  var dz = document.getElementById('tab-detach-dropzone');
  if (dz) {
    dz.ondragover = function(e) {
      e.preventDefault();
      dz.classList.add('drag-hover');
    };
    dz.ondragleave = function(e) {
      dz.classList.remove('drag-hover');
    };
    dz.ondrop = function(e) {
      e.preventDefault();
      dz.classList.remove('drag-hover');
      dz.classList.add('hidden');
      if (_draggingTabId) {
        detachTabToNewWindow(_draggingTabId);
        _draggingTabId = null;
      }
    };
  }

  // Setup panes-container drop target for dragging out of tab bar
  var pc = document.getElementById('panes-container');
  if (pc) {
    pc.ondragover = function(e) {
      if (_draggingTabId) e.preventDefault();
    };
    pc.ondrop = function(e) {
      if (_draggingTabId) {
        e.preventDefault();
        var tid = _draggingTabId;
        _draggingTabId = null;
        var dz2 = document.getElementById('tab-detach-dropzone');
        if (dz2) dz2.classList.add('hidden');
        detachTabToNewWindow(tid);
      }
    };
  }
}

function detachTabToNewWindow(tabId) {
  var tab = _tabs.find(function(t) { return t.id === tabId; });
  if (!tab) return;

  saveTabState(tabId);
  var stateJson = JSON.stringify(tab);
  var title = tab.title ? ('Querii — ' + tab.title) : 'Querii';

  apiCall('create_new_window', stateJson, title)
    .then(function() {
      toast('Tab detached to new window!');
      if (_tabs.length > 1) {
        closeTab(tabId);
      } else {
        tab.title = 'Query 1';
        tab.sql = '';
        tab.results = null;
        restoreTabState(tab.id, 'primary');
        renderTabStrip();
      }
    })
    .catch(function(e) {
      toast('Failed to detach tab: ' + e.message, 'error');
    });
}

function toggleSplitView() {
  if (_splitActive) {
    closeSplitView();
  } else {
    openSplitView();
  }
}

function openSplitView() {
  _splitActive = true;
  var secPane = document.getElementById('pane-secondary');
  var rhSplit = document.getElementById('rh-split');
  var splitBtn = document.getElementById('btn-split-toggle');
  var primPane = document.getElementById('pane-primary');
  var panesCont = document.getElementById('panes-container');

  if (panesCont) panesCont.classList.add('is-split');
  if (secPane) secPane.classList.remove('hidden');
  if (rhSplit) rhSplit.classList.remove('hidden');
  if (primPane) primPane.style.flex = '1 1 0%';
  if (secPane) secPane.style.flex = '1 1 0%';
  if (splitBtn) {
    splitBtn.classList.add('bg-[var(--accent-bg)]', 'text-[var(--accent)]');
    splitBtn.textContent = '◫ Close Split';
  }

  if (!_secondaryTabId || _secondaryTabId === _activeTabId) {
    var other = _tabs.find(function(t) { return t.id !== _activeTabId; });
    if (!other) {
      other = createNewTab({ title: 'Comparison B' });
    }
    _secondaryTabId = other.id;
  }

  updateSplitDropdown();
  restoreTabState(_secondaryTabId, 'secondary');
  setFocusedPane('primary');
  renderTabStrip();
}

function closeSplitView() {
  if (!_splitActive) return;
  saveTabState(_secondaryTabId, 'secondary');
  _splitActive = false;

  var secPane = document.getElementById('pane-secondary');
  var rhSplit = document.getElementById('rh-split');
  var splitBtn = document.getElementById('btn-split-toggle');
  var primPane = document.getElementById('pane-primary');
  var panesCont = document.getElementById('panes-container');

  if (panesCont) panesCont.classList.remove('is-split');
  if (secPane) secPane.classList.add('hidden');
  if (rhSplit) rhSplit.classList.add('hidden');
  if (primPane) {
    primPane.style.flex = '1 1 0%';
  }
  if (splitBtn) {
    splitBtn.classList.remove('bg-[var(--accent-bg)]', 'text-[var(--accent)]');
    splitBtn.textContent = '◫ Split View';
  }

  setFocusedPane('primary');
  renderTabStrip();
}

function setFocusedPane(pane) {
  _focusedPane = pane;
  var pA = document.getElementById('pane-primary');
  var pB = document.getElementById('pane-secondary');

  if (pane === 'secondary' && _splitActive) {
    if (pB) pB.classList.add('focused-pane');
    if (pA) pA.classList.remove('focused-pane');

    var secTab = _tabs.find(function(t) { return t.id === _secondaryTabId; });
    if (secTab) {
      _activeTable = secTab.activeTable || '';
      _selectedTables = secTab.selectedTables || (_activeTable ? [_activeTable] : []);
      _tableColumns = secTab.tableColumns || [];
      var sel = document.getElementById('table-select');
      if (sel && _activeTable) sel.value = _activeTable;
      var atn = document.getElementById('active-table-name');
      if (atn) atn.textContent = _activeTable || '—';
      renderSchemaTree(_allSchemaData);
      refreshOpenSchemaPanel();
    }
  } else {
    if (pA) pA.classList.add('focused-pane');
    if (pB) pB.classList.remove('focused-pane');

    var primTab = _tabs.find(function(t) { return t.id === _activeTabId; });
    if (primTab) {
      _activeTable = primTab.activeTable || '';
      _selectedTables = primTab.selectedTables || (_activeTable ? [_activeTable] : []);
      _tableColumns = primTab.tableColumns || [];
      var sel = document.getElementById('table-select');
      if (sel && _activeTable) sel.value = _activeTable;
      var atn = document.getElementById('active-table-name');
      if (atn) atn.textContent = _activeTable || '—';
      renderSchemaTree(_allSchemaData);
      refreshOpenSchemaPanel();
    }
  }
}

function updateSplitDropdown() {
  var selB = document.getElementById('split-tab-select-b');
  if (!selB) return;
  selB.innerHTML = '';
  _tabs.forEach(function(t) {
    var opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.title + (t.id === _activeTabId ? ' (Pane A)' : '');
    if (t.id === _secondaryTabId) opt.selected = true;
    selB.appendChild(opt);
  });
}

function onSecondaryTabChange(tabId) {
  if (tabId === _secondaryTabId) return;
  saveTabState(_secondaryTabId, 'secondary');
  _secondaryTabId = tabId;
  restoreTabState(_secondaryTabId, 'secondary');
  renderTabStrip();
  if (_focusedPane === 'secondary') {
    setFocusedPane('secondary');
  }
}

function runSqlSecondary() {
  var edB = document.getElementById('sql-editor-b');
  var sql = edB ? edB.value.trim() : '';
  if (!sql) return;

  var danger = analyzeDestructiveQuery(sql);
  if (danger && danger.isDestructive) {
    promptDestructiveSafetyModal(danger, sql, 'secondary');
    return;
  }

  runSqlSecondaryDirect(sql);
}

function runSqlSecondaryDirect(sql) {
  setSqlStatusSecondary('Running…');
  apiCall('run_sql', sql)
    .then(function(d) {
      if (d.message && (!d.columns || d.columns.length === 0)) {
        setSqlStatusSecondary(d.message);
        toast('✓ ' + d.message);
        var createdTableMatch = sql.match(/CREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-zA-Z0-9_]+)["']?/i);
        var newlyCreatedTable = createdTableMatch ? createdTableMatch[1] : null;
        refreshSchema(newlyCreatedTable, { skipFilter: true, preserveEditor: true });
        renderResultsSecondary([], [], 0);
        schedulePersistedSessionSave();
        return;
      }
      setSqlStatusSecondary((d.count || 0).toLocaleString() + ' rows');
      renderResultsSecondary(d.columns || [], d.rows || [], d.count || 0);
      if (d.is_mutation) {
        refreshSchema(null, { skipFilter: true, preserveEditor: true });
      }
      schedulePersistedSessionSave();
    })
    .catch(function(e) {
      setSqlStatusSecondary('⚠ ' + e.message);
      toast(e.message, 'error');
    });
}

function setSqlStatusSecondary(msg) {
  var el = document.getElementById('sql-status-b');
  if (el) el.textContent = msg;
}

function syncSqlLinesSecondary() {
  var ed = document.getElementById('sql-editor-b');
  var ln = document.getElementById('sql-lines-b');
  if (!ed || !ln) return;
  var count = (ed.value.match(/\n/g) || []).length + 1;
  var arr = [];
  for (var i = 1; i <= count; i++) arr.push(i);
  ln.innerHTML = arr.join('<br>');
}

function renderResultsSecondary(columns, rows, totalCount) {
  _lastResultsB = {
    columns: columns || [],
    rows: rows || [],
    count: totalCount || (rows ? rows.length : 0)
  };

  var head = document.getElementById('results-head-b');
  var body = document.getElementById('results-body-b');
  var countEl = document.getElementById('results-count-b');
  var emptyEl = document.getElementById('results-empty-b');
  var csvBtn = document.getElementById('btn-export-csv-b');
  var copyBtn = document.getElementById('btn-copy-csv-b');

  var hasData = columns && columns.length > 0 && rows && rows.length > 0;
  if (emptyEl) emptyEl.classList.toggle('hidden', hasData);
  if (csvBtn) csvBtn.disabled = !hasData;
  if (copyBtn) copyBtn.disabled = !hasData;

  if (!hasData) {
    if (countEl) countEl.textContent = '';
    if (head) head.innerHTML = '';
    if (body) body.innerHTML = '';
    return;
  }

  if (countEl) countEl.textContent = (totalCount || rows.length).toLocaleString() + ' rows · ' + columns.length + ' cols';

  if (head) {
    head.innerHTML = '<tr>' + columns.map(function(c) {
      return '<th class="tbl-head">' + esc(c) + '</th>';
    }).join('') + '</tr>';
  }

  if (body) {
    var displayRows = rows.slice(0, 100);
    var html = '';
    displayRows.forEach(function(r) {
      html += '<tr class="tbl-row">' + columns.map(function(c) {
        var v = r[c];
        return '<td class="tbl-cell">' + esc(v != null ? v : '') + '</td>';
      }).join('') + '</tr>';
    });
    body.innerHTML = html;
  }
}

function exportCsvSecondary() {
  if (!_lastResultsB || !_lastResultsB.rows || !_lastResultsB.rows.length) {
    toast('No secondary results to export.', 'warn');
    return;
  }
  var cols = _lastResultsB.columns;
  var rows = _lastResultsB.rows;
  var lines = [cols.map(function(c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',')];
  rows.forEach(function(r) {
    lines.push(cols.map(function(c) {
      var v = r[c];
      return '"' + String(v != null ? v : '').replace(/"/g, '""') + '"';
    }).join(','));
  });
  var csvContent = lines.join('\n');
  var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'querii_comparison_' + Date.now() + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('✓ Exported CSV from Pane B');
}

function copyCsvSecondary() {
  if (!_lastResultsB || !_lastResultsB.rows || !_lastResultsB.rows.length) {
    toast('No secondary results to copy.', 'warn');
    return;
  }
  var cols = _lastResultsB.columns;
  var rows = _lastResultsB.rows;
  var lines = [cols.join('\t')];
  rows.forEach(function(r) {
    lines.push(cols.map(function(c) {
      var v = r[c];
      return String(v != null ? v : '');
    }).join('\t'));
  });
  copyToClipboard(lines.join('\n'), '✓ Copied Pane B results to clipboard!');
}

function setupSplitHandle(handleId, panePrimaryId, paneSecondaryId) {
  var handle = document.getElementById(handleId);
  var paneA = document.getElementById(panePrimaryId);
  var paneB = document.getElementById(paneSecondaryId);
  if (!handle || !paneA || !paneB) return;

  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    var sx = e.clientX;
    var container = paneA.parentElement;
    var containerWidth = container.offsetWidth;
    var swA = paneA.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    function onMove(ev) {
      var delta = ev.clientX - sx;
      var newWidthA = Math.max(220, Math.min(containerWidth - 220, swA + delta));
      var pctA = (newWidthA / containerWidth) * 100;
      paneA.style.flex = '0 0 ' + pctA + '%';
      paneB.style.flex = '0 0 ' + (100 - pctA) + '%';
    }

    function onUp() {
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function initTabs() {
  if (_tabs.length > 0) return;
  var initialTable = _activeTable || '';
  _tabs = [{
    id: 'tab_1',
    title: 'Query 1',
    activeTable: initialTable,
    selectedTables: initialTable ? [initialTable] : [],
    joinClauses: [],
    tableColumns: _tableColumns ? _tableColumns.slice() : [],
    sql: (document.getElementById('sql-editor') || {}).value || '',
    filterGroups: [],
    groupCounter: 0,
    itemCounter: 0,
    selectPills: [],
    groupByPills: [],
    havingAgg: '',
    havingOp: '>',
    havingVal: '',
    sortCol: '',
    sortDir: 'ASC',
    limit: '5000',
    results: null,
    currentPage: 0,
    sqlStatus: '',
    aiChatHistory: [],
    aiContextTable: '__ACTIVE__'
  }];
  _activeTabId = 'tab_1';
  _tabSeq = 1;
  renderTabStrip();
  updateSplitDropdown();
}

/* ── AI Chat Assistant (OpenRouter, Gemini & NVIDIA NIM) ────────────── */
var _aiSettings = {
  provider: 'openrouter',
  openrouterKey: '',
  openrouterModel: 'openrouter/free',
  geminiKey: '',
  geminiModel: 'gemini-2.5-flash',
  nvidiaKey: '',
  nvidiaModel: 'nvidia/nemotron-3-ultra-550b-a55b',
  fallbackChain: ['openrouter', 'gemini', 'nvidia']
};
var _activeTabAiHistory = [];
var _aiIsSending = false;

function loadAiSettings(s) {
  if (!s) return;
  if (s.ai_provider)         _aiSettings.provider = s.ai_provider;
  if (s.ai_openrouter_key)   _aiSettings.openrouterKey = s.ai_openrouter_key;
  if (s.ai_openrouter_model) _aiSettings.openrouterModel = s.ai_openrouter_model;
  if (s.ai_gemini_key)       _aiSettings.geminiKey = s.ai_gemini_key;
  if (s.ai_gemini_model)     _aiSettings.geminiModel = s.ai_gemini_model;
  if (s.ai_nvidia_key)       _aiSettings.nvidiaKey = s.ai_nvidia_key;
  if (s.ai_nvidia_model)     _aiSettings.nvidiaModel = s.ai_nvidia_model;
  if (s.ai_fallback_chain) {
    try {
      var parsed = JSON.parse(s.ai_fallback_chain);
      if (Array.isArray(parsed) && parsed.length) _aiSettings.fallbackChain = parsed;
    } catch(e) {}
  }
  updateAiProviderBadge();
}

function updateAiProviderBadge() {
  var badge = document.getElementById('ai-provider-badge');
  if (!badge) return;
  if (_aiSettings.provider === 'openrouter') {
    var shortMod = (_aiSettings.openrouterModel || 'openrouter/free').split('/').pop().replace(':free', '');
    badge.textContent = 'OpenRouter · ' + shortMod;
  } else if (_aiSettings.provider === 'nvidia') {
    var shortMod = (_aiSettings.nvidiaModel || 'Nemotron Ultra').split('/').pop();
    if (shortMod.toLowerCase().indexOf('nemotron') !== -1) shortMod = 'Nemotron Ultra 550B';
    badge.textContent = 'NVIDIA · ' + shortMod;
  } else {
    badge.textContent = 'Gemini · ' + (_aiSettings.geminiModel || 'gemini-2.5-flash');
  }
}

/* ── AI Context Multi-Table Selector ────────────────────────────────── */
var _activeAiContextPopover = null;

function closeActiveAiContextPopover() {
  if (_activeAiContextPopover) {
    if (_activeAiContextPopover.popover && _activeAiContextPopover.popover.parentNode) {
      _activeAiContextPopover.popover.parentNode.removeChild(_activeAiContextPopover.popover);
    }
    if (_activeAiContextPopover.trigger) {
      _activeAiContextPopover.trigger.classList.remove('active');
    }
    _activeAiContextPopover = null;
  }
}

document.addEventListener('click', function(e) {
  if (_activeAiContextPopover) {
    if (!_activeAiContextPopover.popover.contains(e.target) && !_activeAiContextPopover.trigger.contains(e.target)) {
      closeActiveAiContextPopover();
    }
  }
});

function updateAiContextTableDropdown() {
  renderAiContextMultiSelect();
}

function renderAiContextMultiSelect() {
  var sel = document.getElementById('ai-context-table-sel');
  if (!sel) return;

  var wrap = document.getElementById('ai-context-multi-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'ai-context-multi-wrap';
    wrap.className = 'multi-table-wrap flex-1 min-w-0';
    sel.style.display = 'none';
    sel.parentNode.insertBefore(wrap, sel);
  }

  var activeTab = _tabs.find(function(t) { return t.id === _activeTabId; });
  var ctx = activeTab ? (activeTab.aiContextTables !== undefined ? activeTab.aiContextTables : '__ALL__') : '__ALL__';

  var labelText = '';
  if (ctx === '__ALL__') {
    labelText = 'All Tables (' + (_allSchemaData ? _allSchemaData.length : 0) + ')';
  } else if (!ctx || ctx === '__NONE__' || (Array.isArray(ctx) && ctx.length === 0)) {
    labelText = 'None (Clean General)';
  } else if (Array.isArray(ctx)) {
    labelText = ctx.length === 1 ? ctx[0] : (ctx.length + ' tables (' + ctx.join(', ') + ')');
  } else {
    labelText = String(ctx);
  }

  wrap.innerHTML =
    '<div class="multi-table-trigger h-6 text-[10px] py-0 px-2" tabindex="0" title="Choose which tables the AI sees in its context">' +
      '<span class="multi-table-label truncate">' + esc(labelText) + '</span>' +
      '<span class="multi-table-arrow">▼</span>' +
    '</div>';

  var trigger = wrap.querySelector('.multi-table-trigger');
  trigger.onclick = function(e) {
    e.stopPropagation();
    openAiContextMultiPopover(trigger);
  };
}

function openAiContextMultiPopover(trigger) {
  if (_activeAiContextPopover && _activeAiContextPopover.trigger === trigger) {
    closeActiveAiContextPopover();
    return;
  }
  closeActiveAiContextPopover();
  closeActiveMultiTablePopover();
  closeActiveSearchablePopover();

  var rect = trigger.getBoundingClientRect();
  var popover = document.createElement('div');
  popover.className = 'multi-table-popover';
  popover.style.top = (rect.bottom + 3) + 'px';
  popover.style.right = (window.innerWidth - rect.right) + 'px';
  popover.style.width = Math.max(rect.width, 260) + 'px';

  popover.addEventListener('wheel', function(e) { e.stopPropagation(); }, { passive: true });

  var activeTab = _tabs.find(function(t) { return t.id === _activeTabId; });
  var currentCtx = activeTab ? (activeTab.aiContextTables !== undefined ? activeTab.aiContextTables : '__ALL__') : '__ALL__';
  var allTables = (_allSchemaData || []).map(function(t) { return t.table; });

  var header = document.createElement('div');
  header.className = 'multi-table-popover-header';
  header.innerHTML =
    '<span style="font-weight:700;color:var(--text-head);font-size:10.5px">AI Context Tables</span>' +
    '<div class="multi-table-popover-actions">' +
      '<a id="ai-ctx-all">All</a>' +
      '<span>·</span>' +
      '<a id="ai-ctx-none">None</a>' +
    '</div>';
  popover.appendChild(header);

  var listEl = document.createElement('div');
  listEl.className = 'multi-table-list';
  popover.appendChild(listEl);

  function populate() {
    listEl.innerHTML = '';

    if (!allTables.length) {
      listEl.innerHTML = '<div style="padding:10px;text-align:center;color:var(--text-dim);font-size:10px">No tables in database</div>';
      return;
    }

    allTables.forEach(function(tbl) {
      var isChecked = (currentCtx === '__ALL__') || (Array.isArray(currentCtx) && currentCtx.indexOf(tbl) !== -1);
      var row = document.createElement('div');
      row.className = 'multi-table-item';
      row.innerHTML =
        '<input type="checkbox" ' + (isChecked ? 'checked' : '') + ' tabindex="-1">' +
        '<span class="multi-table-item-name">' + esc(tbl) + '</span>';

      var cb = row.querySelector('input[type="checkbox"]');
      row.onclick = function(e) {
        if (e.target !== cb) cb.checked = !cb.checked;
        if (currentCtx === '__ALL__') {
          currentCtx = allTables.slice();
        } else if (currentCtx === '__NONE__' || !Array.isArray(currentCtx)) {
          currentCtx = [];
        }
        var idx = currentCtx.indexOf(tbl);
        if (cb.checked && idx === -1) {
          currentCtx.push(tbl);
        } else if (!cb.checked && idx !== -1) {
          currentCtx.splice(idx, 1);
        }
        syncTableSelection(currentCtx);
        populate();
      };
      listEl.appendChild(row);
    });
  }

  header.querySelector('#ai-ctx-all').onclick = function(e) {
    e.preventDefault();
    currentCtx = allTables.slice();
    syncTableSelection(currentCtx);
    populate();
  };

  header.querySelector('#ai-ctx-none').onclick = function(e) {
    e.preventDefault();
    currentCtx = [];
    syncTableSelection([]);
    populate();
  };

  populate();
  document.body.appendChild(popover);
  _activeAiContextPopover = { popover: popover, trigger: trigger };
  trigger.classList.add('active');
}

function clearActiveTabAiChat() {
  if (!confirm('Clear AI conversation history for this tab? (Conversation will be saved in Past Sessions)')) return;
  saveActiveTabAiSessionToHistory();
  _activeTabAiHistory = [];
  var activeTab = _tabs.find(function(t) { return t.id === _activeTabId; });
  if (activeTab) {
    activeTab.aiChatHistory = [];
    activeTab.aiSessionId = null;
  }
  schedulePersistedSessionSave();
  renderActiveTabAiMessages();
}

function saveActiveTabAiSessionToHistory() {
  var activeTab = _tabs.find(function(t) { return t.id === _activeTabId; });
  if (!activeTab || !activeTab.aiChatHistory || activeTab.aiChatHistory.length === 0) return;

  var firstUserMsg = activeTab.aiChatHistory.find(function(m) { return m.role === 'user'; });
  var title = firstUserMsg ? firstUserMsg.content.slice(0, 55).trim() : 'AI Conversation';
  if (firstUserMsg && firstUserMsg.content.length > 55) title += '…';

  var sessId = activeTab.aiSessionId || ('sess_' + activeTab.id + '_' + Date.now());
  activeTab.aiSessionId = sessId;

  var provider = _aiSettings.provider || 'gemini';
  var model = provider === 'nvidia' ? _aiSettings.nvidiaModel : _aiSettings.geminiModel;

  apiCall('save_ai_chat_session', sessId, title, provider, model, JSON.stringify(activeTab.aiChatHistory))
    .catch(function(e) { console.error('Failed to save AI session', e); });
}

function openAiSessionsHistoryModal() {
  var list = document.getElementById('ai-sessions-list');
  var countEl = document.getElementById('ai-sessions-count');
  if (list) list.innerHTML = '<div class="py-6 text-center text-[var(--text-dim)]">Loading history…</div>';
  openModal('modal-ai-history');

  apiCall('get_ai_chat_sessions', 50)
    .then(function(sessions) {
      if (!sessions || !sessions.length) {
        if (list) list.innerHTML = '<div class="py-6 text-center text-[var(--text-dim)]">No past AI conversations recorded yet.</div>';
        if (countEl) countEl.textContent = '0 sessions';
        return;
      }
      if (countEl) countEl.textContent = sessions.length + ' saved sessions';
      list.innerHTML = '';
      sessions.forEach(function(sess) {
        var card = document.createElement('div');
        card.className = 'p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] hover:border-[var(--accent)] transition-all space-y-2';

        var msgsCount = 0;
        try {
          var parsed = JSON.parse(sess.messages_json);
          msgsCount = Array.isArray(parsed) ? parsed.length : 0;
        } catch(e) {}

        var dateStr = sess.updated_at || sess.created_at || '';
        card.innerHTML =
          '<div class="flex items-center justify-between">' +
            '<div class="font-semibold text-[12px] text-[var(--text-head)] truncate flex-1 mr-2">' + esc(sess.title || 'Untitled Conversation') + '</div>' +
            '<span class="text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--bg-muted)] border border-[var(--border)] font-mono text-[var(--text-dim)]">' + esc(sess.provider || 'AI') + '</span>' +
          '</div>' +
          '<div class="flex items-center justify-between text-[10px] text-[var(--text-dim)]">' +
            '<span>' + esc(dateStr) + ' · ' + msgsCount + ' messages</span>' +
            '<div class="flex items-center gap-1.5">' +
              '<button class="btn-ghost text-[10.5px] h-6 px-2 text-[var(--accent)] hover:bg-[var(--accent-bg)] font-medium" onclick="restoreAiSessionToCurrentTab(\'' + sess.id + '\')">📥 Load into Tab</button>' +
              '<button class="btn-ghost text-[10.5px] h-6 px-1.5 text-red-500 hover:bg-red-50" onclick="deleteAiSessionFromHistory(\'' + sess.id + '\')">✕</button>' +
            '</div>' +
          '</div>';
        list.appendChild(card);
      });
    })
    .catch(function(err) {
      if (list) list.innerHTML = '<div class="py-6 text-center text-red-500">Error loading sessions: ' + esc(err.message) + '</div>';
    });
}

function restoreAiSessionToCurrentTab(sessionId) {
  apiCall('get_ai_chat_sessions', 100)
    .then(function(sessions) {
      var found = (sessions || []).find(function(s) { return s.id === sessionId; });
      if (!found) { toast('Session not found', 'error'); return; }
      try {
        var msgs = JSON.parse(found.messages_json);
        if (Array.isArray(msgs)) {
          _activeTabAiHistory = msgs.slice();
          var activeTab = _tabs.find(function(t) { return t.id === _activeTabId; });
          if (activeTab) {
            activeTab.aiChatHistory = _activeTabAiHistory.slice();
            activeTab.aiSessionId = found.id;
          }
          renderActiveTabAiMessages();
          closeModal();
          schedulePersistedSessionSave();
          toast('✓ AI Conversation session restored into active tab!');
        }
      } catch(e) {
        toast('Failed to parse session messages', 'error');
      }
    });
}

function deleteAiSessionFromHistory(sessionId) {
  if (!confirm('Permanently delete this saved conversation session?')) return;
  apiCall('delete_ai_chat_session', sessionId)
    .then(function() {
      toast('Session deleted');
      openAiSessionsHistoryModal();
    }).catch(function(e) {
      toast(e.message, 'error');
    });
}

function renderActiveTabAiMessages() {
  var container = document.getElementById('ai-chat-messages');
  if (!container) return;
  container.innerHTML = '';

  if (!_activeTabAiHistory || !_activeTabAiHistory.length) {
    var welcome = document.createElement('div');
    welcome.className = 'py-4 px-2 text-center text-[var(--text-dim)]';
    welcome.innerHTML =
      '<div class="text-3xl mb-2">✨</div>' +
      '<div class="text-[12px] font-semibold text-[var(--text-head)] mb-1">Querii AI Assistant</div>' +
      '<div class="text-[10.5px] mb-4 text-[var(--text-body)]">Ask questions in natural language. Queries are auto-generated and read-only queries are executed live!</div>' +
      '<div class="space-y-1.5 text-left">' +
        '<button class="ai-suggestion-chip" onclick="applyAiSuggestion(\'Show top 10 rows with highest values\')">📊 Top 10 highest values</button>' +
        '<button class="ai-suggestion-chip" onclick="applyAiSuggestion(\'Summarize row count and key column statistics\')">📈 Summarize column statistics</button>' +
        '<button class="ai-suggestion-chip" onclick="applyAiSuggestion(\'Find any duplicate or missing records\')">🔍 Find duplicate or missing records</button>' +
      '</div>';
    container.appendChild(welcome);
    return;
  }

  _activeTabAiHistory.forEach(function(msg, idx) {
    var bubble = document.createElement('div');
    if (msg.role === 'user') {
      bubble.className = 'ai-chat-bubble-user';
      bubble.textContent = msg.content;
    } else {
      bubble.className = 'ai-chat-bubble-assistant';
      bubble.innerHTML = formatAssistantMessageHtml(msg, idx);
    }
    container.appendChild(bubble);
  });

  container.scrollTop = container.scrollHeight;
}

function applyAiSuggestion(text) {
  var inp = document.getElementById('ai-chat-input');
  if (inp) {
    inp.value = text;
    inp.focus();
  }
}

function handleAiChatInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendAiChatMessage();
  }
}

/* ── Markdown to HTML Renderer ───────────────────────────────────────── */
window.copyCodeblock = function(btn) {
  if (!btn) return;
  var container = btn.closest('.ai-codeblock-container') || btn.closest('.ai-sql-card');
  var codeEl = container ? container.querySelector('pre code') : null;
  var text = codeEl ? codeEl.textContent : '';
  if (!text) {
    var preEl = container ? container.querySelector('pre') : null;
    text = preEl ? preEl.textContent : '';
  }
  if (!text) return;

  if (typeof copyToClipboard === 'function') {
    copyToClipboard(text, '✓ Code copied to clipboard!');
  } else {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      if (typeof toast === 'function') toast('✓ Code copied to clipboard!');
    } catch(e) {}
  }

  var span = btn.querySelector('span');
  var origText = btn.getAttribute('data-orig-text') || (span ? span.textContent : btn.textContent);
  btn.setAttribute('data-orig-text', origText);
  if (span) span.textContent = 'Copied!';
  else btn.textContent = '✓ Copied!';
  btn.classList.add('copied');

  setTimeout(function() {
    if (span) span.textContent = origText;
    else btn.textContent = origText;
    btn.classList.remove('copied');
  }, 2000);
};

function renderMarkdown(md) {
  if (!md) return '';
  var text = esc(md);

  // Preserve code blocks with syntax header and copy button
  text = text.replace(/```([a-zA-Z0-9_-]*)\s*\n?([\s\S]*?)```/g, function(match, lang, code) {
    var displayLang = (lang || 'code').toUpperCase();
    return '<div class="ai-codeblock-container">' +
      '<div class="ai-codeblock-header">' +
        '<span class="ai-codeblock-lang">' + esc(displayLang) + '</span>' +
        '<button class="ai-codeblock-copy-btn" onclick="window.copyCodeblock(this)" title="Copy code">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
          '<span>Copy</span>' +
        '</button>' +
      '</div>' +
      '<pre class="ai-sql-code"><code>' + code.trim() + '</code></pre>' +
    '</div>';
  });

  // Headings
  text = text.replace(/^### (.*$)/gim, '<h3 style="font-size:12px;font-weight:700;margin:6px 0 3px">$1</h3>');
  text = text.replace(/^## (.*$)/gim, '<h2 style="font-size:13px;font-weight:700;margin:8px 0 4px">$1</h2>');
  text = text.replace(/^# (.*$)/gim, '<h1 style="font-size:14px;font-weight:800;margin:10px 0 5px">$1</h1>');

  // Bold & Italic
  text = text.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
  text = text.replace(/~~(.*?)~~/g, '<del>$1</del>');

  // Inline code
  text = text.replace(/`([^`]+)`/g, '<code style="font-family:monospace;font-size:10px;background:var(--bg-muted);padding:1px 4px;border-radius:3px">$1</code>');

  // Blockquotes
  text = text.replace(/^\> (.*$)/gim, '<blockquote style="border-left:2px solid var(--accent);padding-left:8px;margin:4px 0;opacity:0.85">$1</blockquote>');

  // Unordered lists
  text = text.replace(/^\s*[-*]\s+(.*)$/gim, '<li style="margin-left:14px;list-style:disc">$1</li>');

  // Paragraphs and breaks
  text = text.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>');

  return '<div class="ai-markdown-content"><p>' + text + '</p></div>';
}
window.renderMarkdown = renderMarkdown;

function isReadOnlyQuery(sql) {
  if (!sql) return false;
  var clean = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();

  // Check for destructive/mutating commands
  var mutatingPatterns = [
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bDROP\s+TABLE\b/i,
    /\bDROP\s+VIEW\b/i,
    /\bTRUNCATE\b/i,
    /\bALTER\s+TABLE\b/i,
    /\bCREATE\s+TABLE\b/i,
    /\bCREATE\s+VIEW\b/i,
    /\bREPLACE\s+INTO\b/i
  ];

  for (var i = 0; i < mutatingPatterns.length; i++) {
    if (mutatingPatterns[i].test(clean)) {
      return false;
    }
  }

  // Must begin with read-only statement
  return /^(SELECT|WITH|EXPLAIN|PRAGMA)\b/i.test(clean);
}

function extractSqlFromResponse(text) {
  if (!text) return null;
  var match = text.match(/```(?:sql|sqlite)?\s*([\s\S]*?)```/i);
  return match ? match[1].trim() : null;
}

function formatAssistantMessageHtml(msgObj, msgIdx) {
  var fullText = typeof msgObj === 'string' ? msgObj : (msgObj.content || '');
  var reasoning = (typeof msgObj === 'object' && msgObj.reasoning) ? msgObj.reasoning : '';
  var agentSteps = (typeof msgObj === 'object' && msgObj.agent_steps) ? msgObj.agent_steps : [];

  var reasoningHtml = '';
  if (reasoning) {
    reasoningHtml =
      '<details class="ai-reasoning-accordion">' +
        '<summary class="ai-accordion-summary"><span>🧠 Reasoning Process</span></summary>' +
        '<div class="ai-reasoning-body">' + renderMarkdown(reasoning) + '</div>' +
      '</details>';
  }

  var stepsHtml = '';
  if (agentSteps && agentSteps.length > 0) {
    stepsHtml =
      '<details class="ai-agent-steps-accordion" open>' +
        '<summary class="ai-accordion-summary"><span>⚡ Dynamic Inspection (' + agentSteps.length + ' step' + (agentSteps.length > 1 ? 's' : '') + ')</span></summary>' +
        '<div class="ai-steps-body">' +
          agentSteps.map(function(s) {
            return '<div class="ai-step-row">' +
              '<div class="ai-step-action">🔍 ' + esc(s.action) + ' ' + (s.input && Object.keys(s.input).length ? ('<code style="font-size:9px;color:var(--text-mid)">' + esc(JSON.stringify(s.input)) + '</code>') : '') + '</div>' +
              (s.thought ? '<div style="font-size:9.5px;color:var(--text-mid);margin:2px 0 3px"><em>' + esc(s.thought) + '</em></div>' : '') +
              (s.observation ? '<div class="ai-step-obs">' + esc(s.observation) + '</div>' : '') +
            '</div>';
          }).join('') +
        '</div>' +
      '</details>';
  }

  var sql = extractSqlFromResponse(fullText);
  var explanatoryText = fullText;

  var sqlCardHtml = '';
  if (sql) {
    explanatoryText = fullText.replace(/```(?:sql|sqlite)?\s*[\s\S]*?```/i, '').trim();

    var isSafe = isReadOnlyQuery(sql);
    var badgeHtml = isSafe
      ? '<span class="ai-badge-auto">⚡ Auto-executed</span>'
      : '<span class="ai-badge-manual">🔒 Mutating query — manual run</span>';

    var runBtnHtml = isSafe
      ? '<button class="ai-sql-action-btn" onclick="runAiSqlManual(' + msgIdx + ')">▶ Run</button>'
      : '<button class="ai-sql-action-btn font-bold text-red-600" onclick="runAiSqlManual(' + msgIdx + ')">▶ Run in Editor</button>';

    sqlCardHtml =
      '<div class="ai-sql-card">' +
        '<div class="ai-sql-card-header">' +
          '<div style="display:flex;align-items:center;gap:6px">' +
            '<span class="font-mono font-semibold text-[10px]">SQL Query</span>' +
            badgeHtml +
          '</div>' +
          '<button class="ai-codeblock-copy-btn" onclick="window.copyCodeblock(this)" title="Copy SQL">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
            '<span>Copy</span>' +
          '</button>' +
        '</div>' +
        '<pre class="ai-sql-code"><code>' + esc(sql) + '</code></pre>' +
        '<div class="ai-sql-actions">' +
          '<button class="ai-sql-action-btn" onclick="copyAiSql(' + msgIdx + ')">📋 Copy</button>' +
          '<button class="ai-sql-action-btn" onclick="loadAiSqlIntoEditor(' + msgIdx + ')">↗ Paste to Editor</button>' +
          runBtnHtml +
        '</div>' +
      '</div>';
  }

  var mdHtml = explanatoryText ? renderMarkdown(explanatoryText) : '';
  return reasoningHtml + stepsHtml + mdHtml + sqlCardHtml;
}

function getSqlFromMsgIdx(msgIdx) {
  if (!_activeTabAiHistory || !_activeTabAiHistory[msgIdx]) return null;
  return extractSqlFromResponse(_activeTabAiHistory[msgIdx].content);
}

function copyAiSql(msgIdx) {
  var sql = getSqlFromMsgIdx(msgIdx);
  if (sql) copyToClipboard(sql, 'SQL copied to clipboard!');
}

function loadAiSqlIntoEditor(msgIdx) {
  var sql = getSqlFromMsgIdx(msgIdx);
  if (!sql) return;
  var ed = document.getElementById('sql-editor');
  if (ed) {
    ed.value = sql;
    syncSqlLines();
    ed.focus();
    toast('✓ SQL loaded into editor');
  }
}

function runAiSqlManual(msgIdx) {
  var sql = getSqlFromMsgIdx(msgIdx);
  if (!sql) return;
  var ed = document.getElementById('sql-editor');
  if (ed) {
    ed.value = sql;
    syncSqlLines();
  }
  runSql();
}

function buildAiSystemPrompt(contextChoice) {
  var tables = [];
  if (contextChoice === '__ALL__') {
    tables = _allSchemaData || [];
  } else if (!contextChoice || contextChoice === '__NONE__' || (Array.isArray(contextChoice) && contextChoice.length === 0)) {
    tables = [];
  } else if (Array.isArray(contextChoice)) {
    tables = (_allSchemaData || []).filter(function(t) { return contextChoice.indexOf(t.table) !== -1; });
  } else if (contextChoice === '__ACTIVE__') {
    var curr = (_selectedTables && _selectedTables.length) ? _selectedTables : (_activeTable ? [_activeTable] : []);
    tables = (_allSchemaData || []).filter(function(t) { return curr.indexOf(t.table) !== -1; });
  } else {
    tables = (_allSchemaData || []).filter(function(t) { return t.table === contextChoice; });
  }

  var prompt = [];
  prompt.push('You are an expert SQL analytics and data intelligence AI assistant embedded inside Querii, an offline desktop analytics app running an embedded SQLite 3 engine.');
  prompt.push('');
  prompt.push('### MANDATORY TWO-PART RESPONSE FORMAT');
  prompt.push('Always structure your answer into TWO distinct parts:');
  prompt.push('1. SQL Query Code Block (if data retrieval or manipulation is requested): Enclose in a ```sql ... ``` code block.');
  prompt.push('   - READ-ONLY QUERIES (SELECT, WITH ... SELECT): The desktop app will AUTOMATICALLY execute this query in the live data table grid!');
  prompt.push('   - MUTATING QUERIES (INSERT, UPDATE, DELETE, CREATE, ALTER, DROP): Will NOT auto-execute for safety; user will be given a button to run manually.');
  prompt.push('2. Short Explanation / Note: Clear, concise markdown notes, insights, or answer summary.');
  prompt.push('');
  prompt.push('### SQLite 3 Dialect Rules:');
  prompt.push('- ALWAYS wrap table names and column names with double quotes: "table_name", "Column Name".');
  prompt.push('- String literals use single quotes: \'Active\'.');
  prompt.push('- Support CTEs (WITH ... AS ...) and window functions: ROW_NUMBER(), RANK(), DENSE_RANK(), LAG(), LEAD().');
  prompt.push('');

  if (tables.length > 0) {
    prompt.push('### Active Database Schema (' + tables.length + ' table' + (tables.length > 1 ? 's' : '') + ' in context):');
    tables.forEach(function(t) {
      var cols = t.columns.filter(function(c) { return !c.name.startsWith('_'); });
      prompt.push('Table: "' + t.table + '" (' + cols.length + ' columns)');
      prompt.push('Columns: ' + cols.map(function(c) { return '"' + c.name + '" (' + c.type + ')'; }).join(', '));
      prompt.push('');
    });
  } else {
    prompt.push('### Context: No specific tables currently assigned. Answer generally or utilize available dynamic inspection tools to inspect data on demand.');
  }

  return prompt.join('\n');
}

function sendAiChatMessage() {
  if (_aiIsSending) return;
  var inp = document.getElementById('ai-chat-input');
  var text = inp ? inp.value.trim() : '';
  if (!text) return;

  var activeTab = _tabs.find(function(t) { return t.id === _activeTabId; });
  if (!activeTab) return;

  var provider = _aiSettings.provider || 'openrouter';
  var apiKey = '';
  var model = '';

  if (provider === 'openrouter') {
    apiKey = _aiSettings.openrouterKey;
    model = _aiSettings.openrouterModel || 'openrouter/free';
  } else if (provider === 'nvidia') {
    apiKey = _aiSettings.nvidiaKey;
    model = _aiSettings.nvidiaModel || 'nvidia/nemotron-3-ultra-550b-a55b';
  } else {
    apiKey = _aiSettings.geminiKey;
    model = _aiSettings.geminiModel || 'gemini-2.5-flash';
  }

  var hasAnyKey = !!((_aiSettings.openrouterKey && _aiSettings.openrouterKey.trim()) ||
                     (_aiSettings.geminiKey && _aiSettings.geminiKey.trim()) ||
                     (_aiSettings.nvidiaKey && _aiSettings.nvidiaKey.trim()));

  if (!hasAnyKey && !apiKey) {
    openAiSettingsModal();
    toast('Please configure an API key (OpenRouter, Gemini, or NVIDIA) in AI Settings.', 'warn');
    return;
  }

  // 1. Add user message
  _activeTabAiHistory.push({ role: 'user', content: text, time: Date.now() });
  inp.value = '';
  renderActiveTabAiMessages();

  // 2. Add loading bubble
  _aiIsSending = true;
  var container = document.getElementById('ai-chat-messages');
  var sendBtn = document.getElementById('ai-chat-send');
  if (sendBtn) sendBtn.disabled = true;

  var loadingBubble = document.createElement('div');
  loadingBubble.className = 'ai-chat-bubble-assistant opacity-70';
  loadingBubble.id = 'ai-loading-bubble';
  loadingBubble.innerHTML = '<span class="inline-flex items-center gap-1.5 text-[11px] font-mono">✨ Thinking & inspecting database…</span>';
  if (container) {
    container.appendChild(loadingBubble);
    container.scrollTop = container.scrollHeight;
  }

  var contextChoice = activeTab.aiContextTables !== undefined ? activeTab.aiContextTables : '__ALL__';
  var systemPrompt = buildAiSystemPrompt(contextChoice);

  // Build message chain
  var conversationChain = _activeTabAiHistory.map(function(m) {
    return { role: m.role, content: m.content };
  });

  apiCall('send_ai_chat', provider, model, apiKey, JSON.stringify(conversationChain), systemPrompt, true, _aiSettings.fallbackChain || ['openrouter', 'gemini', 'nvidia'])
    .then(function(res) {
      _aiIsSending = false;
      if (sendBtn) sendBtn.disabled = false;
      var lb = document.getElementById('ai-loading-bubble');
      if (lb) lb.remove();

      var reply = (res && res.text) ? res.text : '';
      if (!reply) throw new Error('Empty response from AI service.');

      if (res && res.fallback_occurred && res.fallback_note) {
        toast('⚡ ' + res.fallback_note, 'info');
      }

      // 3. Save assistant reply with reasoning and agent_steps
      _activeTabAiHistory.push({
        role: 'assistant',
        content: reply,
        reasoning: (res && res.reasoning) || '',
        agent_steps: (res && res.agent_steps) || [],
        time: Date.now()
      });
      activeTab.aiChatHistory = _activeTabAiHistory.slice();

      // 4. Inspect for SQL
      var sql = extractSqlFromResponse(reply);
      if (sql) {
        var isSafe = isReadOnlyQuery(sql);
        var ed = document.getElementById('sql-editor');
        if (ed) {
          ed.value = sql;
          syncSqlLines();
        }
        if (isSafe) {
          runSqlDirect(sql);
          toast('⚡ AI Query executed automatically!');
        } else {
          toast('🔒 Mutating SQL loaded into editor — click Run to execute.', 'warn');
        }
      }

      saveActiveTabAiSessionToHistory();
      schedulePersistedSessionSave();
      renderActiveTabAiMessages();
    })
    .catch(function(err) {
      _aiIsSending = false;
      if (sendBtn) sendBtn.disabled = false;
      var lb = document.getElementById('ai-loading-bubble');
      if (lb) lb.remove();

      _activeTabAiHistory.push({
        role: 'assistant',
        content: '⚠️ **Error calling AI service**: ' + err.message + '\n\nPlease verify your API key in **AI Settings (⚙️)**.'
      });
      activeTab.aiChatHistory = _activeTabAiHistory.slice();
      renderActiveTabAiMessages();
      toast('AI Error: ' + err.message, 'error');
    });
}

function openAiSettingsModal() {
  var pSel = document.getElementById('setting-ai-provider');
  var oKey = document.getElementById('setting-openrouter-key');
  var oMod = document.getElementById('setting-openrouter-model');
  var gKey = document.getElementById('setting-gemini-key');
  var gMod = document.getElementById('setting-gemini-model');
  var nKey = document.getElementById('setting-nvidia-key');
  var nMod = document.getElementById('setting-nvidia-model');

  if (pSel) pSel.value = _aiSettings.provider || 'openrouter';
  if (oKey) oKey.value = _aiSettings.openrouterKey || '';
  if (oMod) oMod.value = _aiSettings.openrouterModel || 'openrouter/free';
  if (gKey) gKey.value = _aiSettings.geminiKey || '';
  if (gMod) gMod.value = _aiSettings.geminiModel || 'gemini-2.5-flash';
  if (nKey) nKey.value = _aiSettings.nvidiaKey || '';
  if (nMod) nMod.value = _aiSettings.nvidiaModel || 'nvidia/nemotron-3-ultra-550b-a55b';

  toggleAiProviderFields(_aiSettings.provider || 'openrouter');
  renderFallbackPriorityQueue();
  openModal('modal-ai-settings');
}

function toggleAiProviderFields(provider) {
  var openrouterBox = document.getElementById('ai-config-openrouter');
  var geminiBox = document.getElementById('ai-config-gemini');
  var nvidiaBox = document.getElementById('ai-config-nvidia');
  if (openrouterBox) openrouterBox.classList.toggle('hidden', provider !== 'openrouter');
  if (geminiBox) geminiBox.classList.toggle('hidden', provider !== 'gemini');
  if (nvidiaBox) nvidiaBox.classList.toggle('hidden', provider !== 'nvidia');
}

function renderFallbackPriorityQueue() {
  var list = document.getElementById('ai-fallback-list');
  if (!list) return;
  var chain = _aiSettings.fallbackChain || ['openrouter', 'gemini', 'nvidia'];
  var labels = {
    'openrouter': 'OpenRouter (Free Top Models)',
    'gemini': 'Google Gemini',
    'nvidia': 'NVIDIA NIM'
  };
  var keys = {
    'openrouter': _aiSettings.openrouterKey,
    'gemini': _aiSettings.geminiKey,
    'nvidia': _aiSettings.nvidiaKey
  };

  list.innerHTML = '';
  chain.forEach(function(prov, idx) {
    var hasKey = !!(keys[prov] && keys[prov].trim());
    var row = document.createElement('div');
    row.className = 'flex items-center justify-between p-1.5 rounded border border-[var(--border)] bg-[var(--bg-muted)] text-[11px]';
    row.innerHTML =
      '<div class="flex items-center gap-2">' +
        '<span class="font-mono text-[10px] w-4 text-center font-bold text-[var(--accent)]">' + (idx + 1) + '</span>' +
        '<span class="font-medium text-[var(--text-head)]">' + esc(labels[prov] || prov) + '</span>' +
        '<span class="text-[9px] px-1.5 py-0.5 rounded font-mono ' + (hasKey ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/30' : 'bg-amber-500/10 text-amber-500 border border-amber-500/30') + '">' +
          (hasKey ? 'Key Configured' : 'No Key Set') +
        '</span>' +
      '</div>' +
      '<div class="flex items-center gap-1">' +
        '<button type="button" class="btn-ghost h-6 px-1.5 text-[10px]" ' + (idx === 0 ? 'disabled style="opacity:0.3"' : 'onclick="moveFallbackPriority(' + idx + ', -1)"') + ' title="Move Up">▲</button>' +
        '<button type="button" class="btn-ghost h-6 px-1.5 text-[10px]" ' + (idx === chain.length - 1 ? 'disabled style="opacity:0.3"' : 'onclick="moveFallbackPriority(' + idx + ', 1)"') + ' title="Move Down">▼</button>' +
      '</div>';
    list.appendChild(row);
  });
}

function moveFallbackPriority(index, dir) {
  var chain = (_aiSettings.fallbackChain || ['openrouter', 'gemini', 'nvidia']).slice();
  var target = index + dir;
  if (target < 0 || target >= chain.length) return;
  var temp = chain[index];
  chain[index] = chain[target];
  chain[target] = temp;
  _aiSettings.fallbackChain = chain;
  renderFallbackPriorityQueue();
}

function saveAiSettings() {
  var pSel = document.getElementById('setting-ai-provider');
  var oKey = document.getElementById('setting-openrouter-key');
  var oMod = document.getElementById('setting-openrouter-model');
  var gKey = document.getElementById('setting-gemini-key');
  var gMod = document.getElementById('setting-gemini-model');
  var nKey = document.getElementById('setting-nvidia-key');
  var nMod = document.getElementById('setting-nvidia-model');

  var provider = pSel ? pSel.value : 'openrouter';
  var openrouterKey = oKey ? oKey.value.trim() : '';
  var openrouterModel = oMod ? oMod.value : 'openrouter/free';
  var geminiKey = gKey ? gKey.value.trim() : '';
  var geminiModel = gMod ? gMod.value : 'gemini-2.5-flash';
  var nvidiaKey = nKey ? nKey.value.trim() : '';
  var nvidiaModel = nMod ? nMod.value : 'nvidia/nemotron-3-ultra-550b-a55b';

  _aiSettings.provider = provider;
  _aiSettings.openrouterKey = openrouterKey;
  _aiSettings.openrouterModel = openrouterModel;
  _aiSettings.geminiKey = geminiKey;
  _aiSettings.geminiModel = geminiModel;
  _aiSettings.nvidiaKey = nvidiaKey;
  _aiSettings.nvidiaModel = nvidiaModel;

  apiCall('save_settings', {
    ai_provider: provider,
    ai_openrouter_key: openrouterKey,
    ai_openrouter_model: openrouterModel,
    ai_gemini_key: geminiKey,
    ai_gemini_model: geminiModel,
    ai_nvidia_key: nvidiaKey,
    ai_nvidia_model: nvidiaModel,
    ai_fallback_chain: JSON.stringify(_aiSettings.fallbackChain || ['openrouter', 'gemini', 'nvidia'])
  }).then(function() {
    toast('✓ AI Settings saved!');
    closeModal();
    updateAiProviderBadge();
  }).catch(function(e) {
    toast('Save error: ' + e.message, 'error');
  });
}

/* ── Resize handles ────────────────────────────────────────────────────── */
function initResizableHandles() {
  setupHandleH('rh-left',  'panel-filter', 'left');
  setupHandleH('rh-right', 'panel-quick',  'right');
  setupHandleV('rh-sql',   'sql-panel');
  setupHandleV('rh-sql-b', 'sql-panel-b');
  setupSplitHandle('rh-split', 'pane-primary', 'pane-secondary');
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
    var _sqlPushTimer = null;
    sqlEd.addEventListener('input', function() {
      syncSqlLines();
      clearTimeout(_sqlPushTimer);
      _sqlPushTimer = setTimeout(_sqlPush, 300);
    });
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

  // Pane B (secondary) SQL editor bindings
  var sqlEdB = document.getElementById('sql-editor-b');
  if (sqlEdB) {
    sqlEdB.addEventListener('input', function() {
      syncSqlLinesSecondary();
    });
    sqlEdB.addEventListener('scroll', function() {
      var ln = document.getElementById('sql-lines-b');
      if (ln) ln.scrollTop = sqlEdB.scrollTop;
    });
    sqlEdB.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        runSqlSecondary();
      }
    });
  }

  // Multi-tab keyboard shortcuts
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
      e.preventDefault();
      createNewTab();
    }
  });

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
    if (window._dev && window._dev.open) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); adjustZoom(0.1); }
    else if (e.key === '-') { e.preventDefault(); adjustZoom(-0.1); }
    else if (e.key === '0') { e.preventDefault(); resetZoom(); }
  });

  // ── AFTER all DOM setup: call API ─────────────────────────────────
  waitForApi().then(function() {
    return window.pywebview.api.get_settings();
  }).then(function(res) {
    var s = (res && res.ok && res.data) ? res.data : {};
    loadAiSettings(s);
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

    // Check if window was detached with pre-existing state
    var urlParams = new URLSearchParams(window.location.search);
    var winId = urlParams.get('window_id');
    if (winId) {
      apiCall('get_initial_tab_state', winId)
        .then(function(stateStr) {
          if (stateStr) {
            try {
              var state = JSON.parse(stateStr);
              if (state && state.id) {
                _tabs = [state];
                _activeTabId = state.id;
                _tabSeq = parseInt(state.id.replace('tab_', ''), 10) || 1;
                renderLeftPanelTableMultiSelect();
                updateAiContextTableDropdown();
                restoreTabState(_activeTabId, 'primary');
                renderTabStrip();
                if (state.title) document.title = 'Querii — ' + state.title;
              }
            } catch(e) {
              console.error('Failed to parse initial tab state:', e);
            }
          }
        }).catch(function(e) {
          console.error('get_initial_tab_state error:', e);
        });
      return;
    }

    if (!schema.length) {
      initCleanZeroState();
      return;
    }

    schema.forEach(function(t) {
      var opt = document.createElement('option');
      opt.value = t.table;
      opt.textContent = t.table + '  (' + t.columns.filter(function(c) { return !c.name.startsWith('_'); }).length + ' cols)';
      if (sel) sel.appendChild(opt);
    });

    renderLeftPanelTableMultiSelect();
    updateAiContextTableDropdown();

    restorePersistedSession().then(function(restored) {
      if (!restored) {
        if (sel) sel.value = schema[0].table;
        _activeTable = schema[0].table;
        _selectedTables = [_activeTable];
        renderLeftPanelTableMultiSelect();
        onTableChange();
        renderSchemaTree(schema);
        initTabs();
      }
    });
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
