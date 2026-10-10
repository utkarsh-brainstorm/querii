/* ═══════════════════════════════════════════════════════════════════════════
   pdf_dev_mode.js — Querii Ultra Dev Mode PDF Editor
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

/* ── State ──────────────────────────────────────────────────────────────── */
var _dev = {
  open:        false,
  cols:        [],          // original column names from last result
  colWidths:   {},          // col -> width% (0 = auto)
  colHeaders:  {},          // col -> custom label
  colVisible:  null,        // null = all visible; Set = visible cols
  title:       'Query Results',
  orgName:     '',
  logo:        '',
  pageSize:    'A4',
  orient:      'portrait',
  css:         '',
  inclSql:     false,
  inclSource:  false,
  fullOverride:false,
  fileTab:     'style.css', // active file tab
  fileBuf:     {},          // name -> content (in-memory edits)
  devPaths:    {},          // {dir, csv, css, script}
  watching:    false,
  watchTid:    null,
  prevTid:     null,        // debounce timer
  previewPage: 1,
  previewTotal:1,
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function _dEsc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function _dToast(msg, type) {
  if (typeof toast === 'function') toast(msg, type);
}
function _dApi(method) {
  var args = Array.prototype.slice.call(arguments, 1);
  if (typeof apiCall === 'function') return apiCall.apply(null, [method].concat(args));
  if (window.pywebview && window.pywebview.api && window.pywebview.api[method]) {
    return Promise.resolve(window.pywebview.api[method].apply(window.pywebview.api, args)).then(function(r) {
      return (r && r.ok !== undefined) ? (r.ok ? r.data : Promise.reject(new Error(r.error || 'API error'))) : r;
    });
  }
  return Promise.reject(new Error('API not available'));
}

/* ══════════════════════════════════════════════════════════════════════════
   OPEN / CLOSE
   ══════════════════════════════════════════════════════════════════════════ */
function openUltraDevMode() {
  // Seed state from export dialog if open
  var titleEl = document.getElementById('pdf-title');
  var sizeEl  = document.getElementById('pdf-page-size');
  var orntEl  = document.getElementById('pdf-orientation');
  var sqEl    = document.getElementById('logo-sq-img');
  var imgEl   = document.getElementById('logo-img');
  var orgEl   = document.getElementById('s-org-name');
  var cssEl   = document.getElementById('s-pdf-custom-css');
  var devCssEl= document.getElementById('pdf-custom-css-input');

  _dev.title   = (titleEl && titleEl.value) || 'Query Results';
  _dev.pageSize= (sizeEl  && sizeEl.value)  || 'A4';
  _dev.orient  = (orntEl  && orntEl.value)  || 'portrait';
  _dev.orgName = (orgEl   && orgEl.value)   || '';
  _dev.css     = (devCssEl && devCssEl.value) || (cssEl && cssEl.value) || (typeof _pdfCustomCss !== 'undefined' ? _pdfCustomCss : '');
  _dev.logo    = (sqEl  && sqEl.src  && sqEl.src.indexOf('base64,')  !== -1) ? sqEl.src.replace(/^data:[^;]+;base64,/, '')  :
                 (imgEl && imgEl.src && imgEl.src.indexOf('base64,') !== -1) ? imgEl.src.replace(/^data:[^;]+;base64,/, '') : '';

  // Columns from last result
  _dev.cols = (typeof _lastResults !== 'undefined' && _lastResults && _lastResults.columns) ? _lastResults.columns.slice() : [];
  if (!_dev.cols.length && typeof _lastResultCols !== 'undefined') _dev.cols = (_lastResultCols || []).slice();

  // Reset col state only if cols changed
  var needReset = !_dev.colVisible || Object.keys(_dev.colWidths).some(function(k){ return _dev.cols.indexOf(k) < 0; });
  if (needReset) {
    _dev.colWidths  = {};
    _dev.colHeaders = {};
    _dev.colVisible = null;
  }

  // Show overlay
  var ov = document.getElementById('ultra-dev-overlay');
  if (!ov) { _dToast('Ultra Dev Mode overlay not found', 'error'); return; }
  ov.classList.remove('hidden');
  ov.classList.add('dev-open');
  _dev.open = true;
  document.body.classList.add('overflow-hidden');

  // Write dev files in background
  _dApi('open_dev_files', _dev.css, _dev.title, _dev.orgName, _dev.pageSize, _dev.orient, _dev.fullOverride)
    .then(function(r) {
      if (r) {
        _dev.devPaths = r;
        _devLoadAllFiles();
      }
    }).catch(function(){});

  _devRenderAll();
  _devRefreshPreviewDebounced(300);
}

function closeUltraDevMode(saveCss) {
  var ov = document.getElementById('ultra-dev-overlay');
  if (ov) { ov.classList.add('hidden'); ov.classList.remove('dev-open'); }
  _dev.open = false;
  document.body.classList.remove('overflow-hidden');
  _devStopWatcher();
  if (saveCss !== false) {
    // Save CSS back to settings textarea
    var cssEl = document.getElementById('s-pdf-custom-css');
    if (cssEl) cssEl.value = _dev.css;
    var devCssEl = document.getElementById('pdf-custom-css-input');
    if (devCssEl) devCssEl.value = _dev.css;
    if (typeof _pdfCustomCss !== 'undefined') _pdfCustomCss = _dev.css;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   RENDER LEFT PANEL
   ══════════════════════════════════════════════════════════════════════════ */
function _devRenderAll() {
  _devRenderDocControls();
  _devRenderColControls();
  _devRenderCssEditor();
  _devRenderFilePanel();
}

function _devRenderDocControls() {
  var el = document.getElementById('dev-doc-controls');
  if (!el) return;
  el.innerHTML =
    '<div class="dev-field-row">' +
      '<label class="dev-lbl">Title</label>' +
      '<input id="dev-title" class="dev-input" value="' + _dEsc(_dev.title) + '" oninput="window._devOnTitleChange(this.value)">' +
    '</div>' +
    '<div class="dev-field-row">' +
      '<label class="dev-lbl">Organisation</label>' +
      '<input id="dev-orgname" class="dev-input" value="' + _dEsc(_dev.orgName) + '" oninput="window._devOnOrgChange(this.value)">' +
    '</div>' +
    '<div class="dev-field-row">' +
      '<label class="dev-lbl">Page size</label>' +
      '<select id="dev-page-size" class="dev-select" onchange="window._devOnPageSize(this.value)">' +
        ['A4','A3','Letter'].map(function(s){ return '<option' + (s===_dev.pageSize?' selected':'') + '>' + s + '</option>'; }).join('') +
      '</select>' +
    '</div>' +
    '<div class="dev-field-row">' +
      '<label class="dev-lbl">Orientation</label>' +
      '<div class="dev-radio-group">' +
        '<label class="dev-radio' + (_dev.orient==='portrait'  ?' active':'') + '"><input type="radio" name="dev-orient" value="portrait"'  + (_dev.orient==='portrait' ?' checked':'') + ' onchange="window._devOnOrient(this.value)"> Portrait</label>' +
        '<label class="dev-radio' + (_dev.orient==='landscape' ?' active':'') + '"><input type="radio" name="dev-orient" value="landscape"' + (_dev.orient==='landscape'?' checked':'') + ' onchange="window._devOnOrient(this.value)"> Landscape</label>' +
      '</div>' +
    '</div>' +
    '<div class="dev-field-row">' +
      '<label class="dev-lbl">Include SQL</label>' +
      '<input type="checkbox" id="dev-incl-sql" class="dev-cb"' + (_dev.inclSql?' checked':'') + ' onchange="window._devOnInclSql(this.checked)">' +
    '</div>' +
    '<div class="dev-field-row" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">' +
      '<label class="dev-lbl" title="If checked, your Custom CSS fully controls page size. If unchecked, Querii enforces the selected size/orientation.">CSS Override</label>' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:10px;cursor:pointer">' +
        '<input type="checkbox" class="dev-cb" ' + (_dev.fullOverride?'checked':'') + ' onchange="window._devOnFullOverride(this.checked)"> Full Override (Allow CSS @page)' +
      '</label>' +
    '</div>';
}

function _devRenderColControls() {
  var el = document.getElementById('dev-col-controls');
  if (!el) return;
  if (!_dev.cols.length) {
    el.innerHTML = '<div class="dev-empty">Run a query first to see columns.</div>';
    return;
  }
  var visColsCount = _dev.cols.filter(function(c) { return _dev.colVisible === null || _dev.colVisible.has(c); }).length;
  var avgWidth = visColsCount > 0 ? Math.floor(100 / visColsCount) : 20;

  var toolbar = '<div style="display:flex;gap:6px;margin-bottom:10px">' +
    '<button class="dev-btn dev-btn-sm" onclick="window._devDistributeEvenly()" style="flex:1;background:#f8fafc;border:1px solid #cbd5e1;padding:5px 8px;border-radius:6px;cursor:pointer;font-weight:600;font-size:10px;color:#334155" title="Distribute widths equally across all visible columns">⚖ Equal Widths</button>' +
    '<button class="dev-btn dev-btn-sm" onclick="window._devResetColumns()" style="flex:1;background:#f8fafc;border:1px solid #cbd5e1;padding:5px 8px;border-radius:6px;cursor:pointer;font-weight:600;font-size:10px;color:#64748b" title="Reset all custom widths and headers">↺ Reset All</button>' +
  '</div>';

  var html = toolbar + '<div class="dev-col-list">';
  _dev.cols.forEach(function(c) {
    var vis    = _dev.colVisible === null || _dev.colVisible.has(c);
    var width  = _dev.colWidths[c] !== undefined ? _dev.colWidths[c] : avgWidth;
    var header = _dev.colHeaders[c] || '';
    html += '<div class="dev-col-row' + (vis?'':' dev-col-hidden') + '">' +
      '<label class="dev-col-vis" title="Show/hide column">' +
        '<input type="checkbox" ' + (vis?'checked':'') + ' onchange="window._devToggleCol(\'' + _dEsc(c) + '\', this.checked)">' +
        '<span class="dev-col-name" title="' + _dEsc(c) + '">' + _dEsc(c) + '</span>' +
      '</label>' +
      '<input class="dev-col-hdr" placeholder="Label override…" value="' + _dEsc(header) + '" oninput="window._devSetHeader(\'' + _dEsc(c) + '\', this.value)" title="Custom column header">' +
      '<div class="dev-col-width-wrap">' +
        '<input type="range" min="1" max="100" step="1" value="' + width + '" class="dev-slider" oninput="window._devSetWidth(\'' + _dEsc(c) + '\', this.value, this.nextElementSibling)">' +
        '<span class="dev-width-lbl">' + width + '%</span>' +
      '</div>' +
    '</div>';
  });
  html += '</div>';
  el.innerHTML = html;
}

window._devDistributeEvenly = function() {
  var visCols = _dev.cols.filter(function(c) { return _dev.colVisible === null || _dev.colVisible.has(c); });
  if (!visCols.length) return;
  var equalW = Math.floor(100 / visCols.length);
  visCols.forEach(function(c) {
    _dev.colWidths[c] = equalW;
  });
  _devRenderColControls();
  _devRefreshPreviewDebounced(150);
  _dToast('Columns distributed evenly (' + equalW + '%)');
};

window._devResetColumns = function() {
  _dev.colWidths = {};
  _dev.colHeaders = {};
  _dev.colVisible = null;
  _devRenderColControls();
  _devRefreshPreviewDebounced(150);
  _dToast('Column widths and headers reset');
};

function _devRenderCssEditor() {
  var el = document.getElementById('dev-css-editor');
  if (!el) return;
  if (el.value !== undefined) {
    if (document.activeElement !== el) el.value = _dev.css;
  }
}

window._devApplyPreset = function(presetName) {
  var presets = {
    'executive': '/* 🏢 Executive Slate */\n:root {\n  --table-head-bg: #0f172a;\n  --accent: #3b82f6;\n  --row-alt: #f8fafc;\n}\n.data-table thead th {\n  background: #0f172a !important;\n  color: #ffffff !important;\n  border-bottom: 2px solid #3b82f6 !important;\n}\n.report-header {\n  border-bottom: 2px solid #0f172a !important;\n}',
    'minimal': '/* 📰 Financial Minimal */\n:root {\n  --table-head-bg: #f8fafc;\n  --table-head-text: #0f172a;\n  --accent: #94a3b8;\n  --row-alt: #ffffff;\n}\n.data-table thead th {\n  background: #f1f5f9 !important;\n  color: #0f172a !important;\n  border-bottom: 2px solid #94a3b8 !important;\n}\n.data-table tbody td {\n  font-family: ui-monospace, SFMono-Regular, monospace;\n  font-size: 7.5pt;\n}',
    'emerald': '/* 🌲 Emerald Corporate */\n:root {\n  --table-head-bg: #064e3b;\n  --accent: #10b981;\n  --row-alt: #f0fdf4;\n}\n.data-table thead th {\n  background: #064e3b !important;\n  color: #ffffff !important;\n  border-bottom: 2px solid #10b981 !important;\n}\n.org-title {\n  color: #064e3b !important;\n}',
    'tech': '/* 🟣 Modern Tech */\n:root {\n  --table-head-bg: #312e81;\n  --accent: #6366f1;\n  --row-alt: #eef2ff;\n}\n.data-table thead th {\n  background: #312e81 !important;\n  color: #ffffff !important;\n  border-bottom: 2px solid #6366f1 !important;\n}\n.badge-records {\n  background: #e0e7ff !important;\n  color: #4338ca !important;\n}',
    'compact': '/* 📏 Dense Compact */\nbody {\n  font-size: 7.5pt !important;\n}\n.data-table th, .data-table td {\n  padding: 4px 6px !important;\n  font-size: 7pt !important;\n}\n.report-header {\n  margin-bottom: 8px !important;\n  padding-bottom: 6px !important;\n}'
  };

  if (presets[presetName]) {
    _dev.css = presets[presetName];
    var editor = document.getElementById('dev-css-editor');
    if (editor) editor.value = _dev.css;
    _devRefreshPreviewDebounced(150);
    _dToast('Applied preset: ' + presetName);
  }
};

function _devRenderFilePanel() {
  var el = document.getElementById('dev-file-panel');
  if (!el) return;
  var files = ['style.css', 'data.csv', 'render.py'];
  var tabs = files.map(function(f) {
    return '<button class="dev-file-tab' + (f===_dev.fileTab?' active':'') + '" onclick="window._devOpenFileTab(\'' + f + '\')">' + f + '</button>';
  }).join('');
  var dirLine = _dev.devPaths.dir
    ? '<div class="dev-dir-path" title="' + _dEsc(_dev.devPaths.dir) + '">📁 ' + _dEsc(_dev.devPaths.dir) + '</div>'
    : '<div class="dev-dir-path">Dev files not yet written</div>';
  var content = _dev.fileBuf[_dev.fileTab] || '';
  el.innerHTML =
    dirLine +
    '<div class="dev-file-tabs">' + tabs + '</div>' +
    '<textarea id="dev-file-editor" class="dev-file-area" spellcheck="false" ' +
      'oninput="window._devOnFileEdit(this.value)">' + _dEsc(content) + '</textarea>' +
    '<div class="dev-file-actions">' +
      '<button class="dev-btn dev-btn-primary" onclick="window._devSaveFile()">💾 Save</button>' +
      '<button class="dev-btn" onclick="window._devOpenPath(\'' + _dEsc(_dev.devPaths.dir || '') + '\')" title="Open folder">📂 Open folder</button>' +
      (_dev.fileTab === 'render.py' ? '<button class="dev-btn" onclick="window._devRunScript()">▶ Run Script</button>' : '') +
      '<button class="dev-btn dev-btn-sm" onclick="window._devStartWatcher()" title="Auto-reload CSS when file changes on disk">👁 Watch' + (_dev.watching ? ' (on)' : '') + '</button>' +
    '</div>';
}

/* ══════════════════════════════════════════════════════════════════════════
   CONTROL EVENT HANDLERS
   ══════════════════════════════════════════════════════════════════════════ */
window._devOnTitleChange = function(v) { _dev.title = v; _devRefreshPreviewDebounced(); };
window._devOnOrgChange   = function(v) { _dev.orgName = v; _devRefreshPreviewDebounced(); };
window._devOnPageSize    = function(v) { _dev.pageSize = v; _devRefreshPreviewDebounced(200); };
window._devOnOrient      = function(v) {
  _dev.orient = v;
  document.querySelectorAll('.dev-radio').forEach(function(r) { r.classList.toggle('active', r.querySelector('input').value === v); });
  _devRefreshPreviewDebounced(200);
};
window._devOnInclSql     = function(v) { _dev.inclSql = v; _devRefreshPreviewDebounced(); };
window._devOnFullOverride= function(v) { _dev.fullOverride = v; _devRefreshPreviewDebounced(200); };

window._devToggleCol = function(col, vis) {
  if (_dev.colVisible === null) {
    _dev.colVisible = new Set(_dev.cols);
  }
  if (vis) _dev.colVisible.add(col);
  else     _dev.colVisible.delete(col);
  _devRefreshPreviewDebounced();
};

window._devSetWidth = function(col, val, lbl) {
  var n = parseInt(val, 10);
  _dev.colWidths[col] = n;
  if (lbl) lbl.textContent = n + '%';
  _devRefreshPreviewDebounced();
};

window._devSetHeader = function(col, val) {
  _dev.colHeaders[col] = val;
  _devRefreshPreviewDebounced();
};

window._devCssChanged = function(val) {
  _dev.css = val;
  _devRefreshPreviewDebounced(400);
};

window._devOnFileEdit = function(val) {
  _dev.fileBuf[_dev.fileTab] = val;
  if (_dev.fileTab === 'style.css') {
    _dev.css = val;
    _devRefreshPreviewDebounced(500);
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   PREVIEW (Smooth & Scroll-Preserved)
   ══════════════════════════════════════════════════════════════════════════ */
function _devRefreshPreviewDebounced(delay) {
  if (_dev.prevTid) clearTimeout(_dev.prevTid);
  _dev.prevTid = setTimeout(_devRefreshPreview, delay || 300);
}

function _devRefreshPreview() {
  var iframe = document.getElementById('dev-preview-frame');
  if (!iframe) return;
  var visArr = _dev.colVisible ? Array.from(_dev.colVisible) : null;

  // Preserve scroll offset
  var scrollY = 0;
  try {
    if (iframe.contentWindow) scrollY = iframe.contentWindow.scrollY || 0;
  } catch (e) {}

  _dApi('get_pdf_html_preview',
    _dev.title, _dev.orgName, _dev.logo, _dev.css,
    _dev.pageSize, _dev.orient,
    _dev.colWidths, _dev.colHeaders, visArr, _dev.fullOverride
  ).then(function(r) {
    if (!r) return;
    var html = r;
    var previewStyle = '<style>' +
      'body{background:#dde3ec;margin:0;padding:16px}' +
      '.dev-preview-scale{transform-origin:top center;width:210mm;margin:0 auto}' +
      '@media print{body{background:#fff;padding:0}}' +
    '</style>';
    iframe.srcdoc = previewStyle + html;

    iframe.onload = function() {
      try {
        if (iframe.contentWindow && scrollY > 0) {
          iframe.contentWindow.scrollTo(0, scrollY);
        }
      } catch (e) {}
    };

    var spin = document.getElementById('dev-preview-spinner');
    if (spin) spin.classList.add('hidden');
  }).catch(function(e) {
    console.warn('[Ultra Dev Mode] Preview error:', e);
  });

  var spin = document.getElementById('dev-preview-spinner');
  if (spin) spin.classList.remove('hidden');
}

/* ══════════════════════════════════════════════════════════════════════════
   FILE EDITOR
   ══════════════════════════════════════════════════════════════════════════ */
function _devLoadAllFiles() {
  ['style.css', 'data.csv', 'render.py'].forEach(function(name) {
    _dApi('read_dev_file', name).then(function(r) {
      if (r !== undefined) {
        _dev.fileBuf[name] = r;
        if (name === _dev.fileTab) _devRenderFilePanel();
      }
    }).catch(function(){});
  });
}

window._devOpenFileTab = function(name) {
  _dev.fileTab = name;
  _devRenderFilePanel();
};

window._devSaveFile = function() {
  var content = _dev.fileBuf[_dev.fileTab] || '';
  _dApi('write_dev_file', _dev.fileTab, content)
    .then(function(r) {
      _dToast('✓ ' + _dev.fileTab + ' saved');
      if (_dev.fileTab === 'style.css') {
        _dev.css = content;
        _devRefreshPreviewDebounced(200);
      }
    })
    .catch(function(e) { _dToast('Save failed: ' + e.message, 'error'); });
};

window._devOpenPath = function(path) {
  if (!path) return;
  _dApi('open_path', path).catch(function(){});
};

window._devRunScript = function() {
  _dToast('Running render.py…');
  var content = _dev.fileBuf['render.py'] || '';
  // Save first, then open folder so user can see output.pdf
  _dApi('write_dev_file', 'render.py', content).then(function() {
    return _dApi('open_path', _dev.devPaths.dir || '');
  }).then(function() {
    _dToast('Script saved. Open a terminal in the folder and run: python3 render.py', 'info');
  }).catch(function(e){ _dToast(e.message, 'error'); });
};

/* ── File watcher ──────────────────────────────────────────────────────── */
window._devStartWatcher = function() {
  if (_dev.watching) { _devStopWatcher(); return; }
  _dev.watching = true;
  _dToast('👁 Watching style.css for changes…');
  _dev.watchTid = setInterval(function() {
    _dApi('read_dev_file', 'style.css').then(function(r) {
      if (r !== undefined && r !== _dev.fileBuf['style.css']) {
        _dev.fileBuf['style.css'] = r;
        _dev.css = r;
        if (_dev.fileTab === 'style.css') {
          var ta = document.getElementById('dev-file-editor');
          if (ta && document.activeElement !== ta) ta.value = r;
          var cssEd = document.getElementById('dev-css-editor');
          if (cssEd && document.activeElement !== cssEd) cssEd.value = r;
        }
        _devRefreshPreviewDebounced(200);
      }
    }).catch(function(){});
  }, 2000);
  _devRenderFilePanel(); // update button label
};

function _devStopWatcher() {
  if (_dev.watchTid) clearInterval(_dev.watchTid);
  _dev.watchTid = null;
  _dev.watching = false;
}

/* ══════════════════════════════════════════════════════════════════════════
   EXPORT PDF from dev mode
   ══════════════════════════════════════════════════════════════════════════ */
window._devExportPdf = function() {
  var visArr = _dev.colVisible ? Array.from(_dev.colVisible) : null;
  _dApi('save_file_dialog', _dev.title || 'export', 'pdf').then(function(r) {
    if (!r) return;
    var filepath = r;
    var orgEl = document.getElementById('s-org-name');
    var org = (orgEl && orgEl.value) || _dev.orgName;
    _dToast('⚡ Generating PDF…', 'info');
    return _dApi('export_pdf_html',
      filepath, _dev.title, org, _dev.logo,
      _dev.inclSql ? ((document.getElementById('sql-editor')||{}).value||'') : '',
      '', _dev.css, _dev.pageSize, _dev.orient,
      _dev.colWidths, _dev.colHeaders, visArr, _dev.fullOverride
    );
  }).then(function(r) {
    if (r) _dToast('✓ PDF exported!');
  }).catch(function(e){ if (e) _dToast(e.message||'Export failed', 'error'); });
};

/* ══════════════════════════════════════════════════════════════════════════
   COPY AI REQUIREMENT (dynamic, context-aware)
   ══════════════════════════════════════════════════════════════════════════ */
window._devCopyAiRequirement = function() {
  var visArr = _dev.colVisible ? Array.from(_dev.colVisible) : _dev.cols;
  var orient  = _dev.orient;
  var size    = _dev.pageSize;
  var landscape = orient === 'landscape';
  var w = size === 'A3' ? '297mm' : size === 'Letter' ? '216mm' : '210mm';
  var h = size === 'A3' ? '420mm' : size === 'Letter' ? '279mm' : '297mm';
  if (landscape) { var tmp = w; w = h; h = tmp; }

  var widthHints = visArr.map(function(c) {
    return c + ': ' + (_dev.colWidths[c] ? _dev.colWidths[c] + '%' : 'auto');
  }).join(', ');

  var prompt = [
    '# Querii PDF Custom CSS — AI Generation Request',
    '',
    '## Configuration',
    '- Page size: ' + size + ' (' + w + ' × ' + h + ')',
    '- Orientation: ' + orient,
    '- Title: ' + _dev.title,
    '- Organisation: ' + (_dev.orgName || '(none)'),
    '- Columns (' + visArr.length + '): ' + visArr.join(', '),
    '- Column widths: ' + (widthHints || 'all auto'),
    '',
    '## Instructions',
    'Generate a CSS snippet to be injected into a Querii PDF report.',
    'The CSS overrides the base WeasyPrint-compatible stylesheet.',
    'Do NOT use external fonts — use system fonts only.',
    'Do NOT use JavaScript.',
    'Do NOT break the @page rule.',
    '',
    '## Base @page rule (do not duplicate, just override if needed)',
    '@page {',
    '  size: ' + size + (landscape ? ' landscape' : '') + ';',
    '  margin: 18mm 14mm 14mm 14mm;',
    '  @top-center { content: "' + (_dev.orgName||'Organisation') + ' \u2014 ' + _dev.title + '"; font-size: 8pt; color: #64748b; }',
    '  @bottom-right { content: "Page " counter(page) " of " counter(pages); font-size: 8pt; color: #64748b; }',
    '}',
    '',
    '## HTML structure (classes you can target)',
    '/* body — the page root */',
    '/* .school-header — org header block (contains logo + org name) */',
    '/* .school-logo — logo <img> (circular, 68×68px) */',
    '/* .school-info h2 — org name heading */',
    '/* .document-heading — title section */',
    '/* .heading-accent — decorative accent bar above title */',
    '/* .title — the h1 report title */',
    '/* .gen-date — generated date line */',
    '/* .data-table — the results <table> */',
    '/* .data-table thead th — header cells */',
    '/* .data-table tbody td — data cells */',
    '/* .data-table tbody tr.even — zebra even rows */',
    '/* .data-table tbody tr.odd — zebra odd rows */',
    '/* .report-footer — bottom summary line */',
    '/* .sql-block, .sql-pre — SQL query section */',
    '',
    '## Column width reference',
    '/* Use <col> width via CSS — colgroup widths are set by the app */',
    '/* To override a specific column by index: */',
    '/* .data-table col:nth-child(1) { width: 30% } */',
    visArr.map(function(c, i) {
      return '/* col ' + (i+1) + ': ' + c + (_dev.colWidths[c] ? ' (' + _dev.colWidths[c] + '%)' : ' (auto)') + ' */';
    }).join('\n'),
    '',
    '## Generate CSS below (pure CSS only):',
    '```css',
    '/* Your custom styles here */',
    '```',
  ].join('\n');

  // Avoid navigator.clipboard because it triggers Qt setFeaturePermission crash
  _devFallbackCopy(prompt);
};

function _devFallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta); ta.select();
  document.execCommand('copy'); document.body.removeChild(ta);
  _dToast('✓ AI requirement copied!');
}

/* ══════════════════════════════════════════════════════════════════════════
   KEYBOARD SHORTCUT — Ctrl+S saves CSS in file editor
   ══════════════════════════════════════════════════════════════════════════ */
document.addEventListener('keydown', function(e) {
  if (!_dev.open) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    var active = document.activeElement;
    if (active && active.id === 'dev-css-editor') {
      _dev.css = active.value;
      _devRefreshPreviewDebounced(100);
      _dToast('Preview refreshed (Ctrl+S)');
    } else if (active && active.id === 'dev-file-editor') {
      window._devSaveFile();
    }
  }
  if (e.key === 'Escape' && _dev.open) {
    closeUltraDevMode();
  }
});
