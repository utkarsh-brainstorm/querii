/**
 * themes.js — AttendanceProcessor v3
 * ====================================
 * Six UI themes. Applied via CSS custom properties on :root.
 * NOTE: localStorage is NOT available in pywebview/GTK WebKit2 —
 * use window._apMem (in-memory) as fallback; Python backend for persistence.
 */

const THEMES = {
  mono: {
    label: 'Mono',
    desc:  'Clean light grey — default, professional',
    preview: { bg: '#F7F7F8', accent: '#2563EB', text: '#0F0F12' },
    vars: {
      '--bg-base':       '#F7F7F8',
      '--bg-surface':    '#FFFFFF',
      '--bg-muted':      '#F0F0F1',
      '--bg-sidebar':    '#F5F5F6',
      '--border':        '#E2E2E4',
      '--border-light':  '#EBEBEC',
      '--text-head':     '#0F0F12',
      '--text-body':     '#2A2A2F',
      '--text-mid':      '#6B6B72',
      '--text-dim':      '#A0A0A6',
      '--text-inv':      '#FFFFFF',
      '--accent':        '#2563EB',
      '--accent-hover':  '#1D4ED8',
      '--accent-bg':     '#EFF6FF',
      '--ok':            '#16A34A',
      '--ok-bg':         '#F0FDF4',
      '--warn':          '#D97706',
      '--warn-bg':       '#FFFBEB',
      '--danger':        '#DC2626',
      '--danger-bg':     '#FEF2F2',
      '--navbar-bg':     '#FFFFFF',
      '--navbar-text':   '#0F0F12',
      '--navbar-text-dim': '#A0A0A6',
      '--panel-hdr-bg':  '#F7F7F8',
      '--diff-bg':       '#FFFBEB',
      '--diff-border':   '#FCD34D',
      '--diff-text':     '#92400E',
      '--table-row-alt': '#F2F2F4',
    }
  },
  professional: {
    label: 'Professional',
    desc:  'Deep executive navy with blue accents',
    preview: { bg: '#0b0f19', accent: '#3b82f6', text: '#e2e8f0' },
    vars: {
      '--bg-base':       '#0b0f19',
      '--bg-surface':    '#111827',
      '--bg-muted':      '#172033',
      '--bg-sidebar':    '#0e1422',
      '--border':        '#1e293b',
      '--border-light':  '#172033',
      '--text-head':     '#f8fafc',
      '--text-body':     '#e2e8f0',
      '--text-mid':      '#94a3b8',
      '--text-dim':      '#64748b',
      '--text-inv':      '#ffffff',
      '--accent':        '#3b82f6',
      '--accent-hover':  '#2563eb',
      '--accent-bg':     'rgba(59,130,246,0.15)',
      '--ok':            '#4ade80',
      '--ok-bg':         'rgba(74,222,128,0.12)',
      '--warn':          '#fbbf24',
      '--warn-bg':       'rgba(251,191,36,0.12)',
      '--danger':        '#f87171',
      '--danger-bg':     'rgba(248,113,113,0.12)',
      '--navbar-bg':     '#0e1526',
      '--navbar-text':   '#f8fafc',
      '--navbar-text-dim': '#94a3b8',
      '--panel-hdr-bg':  '#141c2e',
      '--diff-bg':       'rgba(251,191,36,0.12)',
      '--diff-border':   '#fbbf24',
      '--diff-text':     '#fde68a',
      '--table-row-alt': '#0e1526',
    }
  },
  dark: {
    label: 'Dark Obsidian',
    desc:  'Modern slate dark mode with indigo accents',
    preview: { bg: '#0a0e17', accent: '#6366f1', text: '#cbd5e1' },
    vars: {
      '--bg-base':       '#0a0e17',
      '--bg-surface':    '#131926',
      '--bg-muted':      '#1a2233',
      '--bg-sidebar':    '#0f1420',
      '--border':        '#243046',
      '--border-light':  '#1c2637',
      '--text-head':     '#f1f5f9',
      '--text-body':     '#cbd5e1',
      '--text-mid':      '#94a3b8',
      '--text-dim':      '#64748b',
      '--text-inv':      '#ffffff',
      '--accent':        '#6366f1',
      '--accent-hover':  '#4f46e5',
      '--accent-bg':     'rgba(99,102,241,0.16)',
      '--ok':            '#3fb950',
      '--ok-bg':         'rgba(63,185,80,0.12)',
      '--warn':          '#e3b341',
      '--warn-bg':       'rgba(227,179,65,0.12)',
      '--danger':        '#f85149',
      '--danger-bg':     'rgba(248,81,73,0.12)',
      '--navbar-bg':     '#0d121c',
      '--navbar-text':   '#f1f5f9',
      '--navbar-text-dim': '#94a3b8',
      '--panel-hdr-bg':  '#151c2b',
      '--diff-bg':       'rgba(227,179,65,0.12)',
      '--diff-border':   '#e3b341',
      '--diff-text':     '#e3b341',
      '--table-row-alt': '#101622',
    }
  },
  light: {
    label: 'Light Blue',
    desc:  'Crisp clean daylight with sky blue accents',
    preview: { bg: '#f1f5f9', accent: '#0284c7', text: '#0f172a' },
    vars: {
      '--bg-base':       '#f1f5f9',
      '--bg-surface':    '#ffffff',
      '--bg-muted':      '#e2e8f0',
      '--bg-sidebar':    '#f8fafc',
      '--border':        '#cbd5e1',
      '--border-light':  '#e2e8f0',
      '--text-head':     '#0f172a',
      '--text-body':     '#1e293b',
      '--text-mid':      '#475569',
      '--text-dim':      '#64748b',
      '--text-inv':      '#ffffff',
      '--accent':        '#0284c7',
      '--accent-hover':  '#0369a1',
      '--accent-bg':     '#e0f2fe',
      '--ok':            '#16a34a',
      '--ok-bg':         '#f0fdf4',
      '--warn':          '#d97706',
      '--warn-bg':       '#fffbeb',
      '--danger':        '#dc2626',
      '--danger-bg':     '#fef2f2',
      '--navbar-bg':     '#ffffff',
      '--navbar-text':   '#0f172a',
      '--navbar-text-dim': '#64748b',
      '--panel-hdr-bg':  '#f8fafc',
      '--diff-bg':       '#fffbeb',
      '--diff-border':   '#fcd34d',
      '--diff-text':     '#92400e',
      '--table-row-alt': '#f8fafc',
    }
  },
  minimal: {
    label: 'Minimalist',
    desc:  'Pure monochrome modern light',
    preview: { bg: '#fafafa', accent: '#18181b', text: '#09090b' },
    vars: {
      '--bg-base':       '#fafafa',
      '--bg-surface':    '#ffffff',
      '--bg-muted':      '#f4f4f5',
      '--bg-sidebar':    '#fafafa',
      '--border':        '#e4e4e7',
      '--border-light':  '#f4f4f5',
      '--text-head':     '#09090b',
      '--text-body':     '#27272a',
      '--text-mid':      '#52525b',
      '--text-dim':      '#71717a',
      '--text-inv':      '#ffffff',
      '--accent':        '#18181b',
      '--accent-hover':  '#27272a',
      '--accent-bg':     '#f4f4f5',
      '--ok':            '#16a34a',
      '--ok-bg':         '#f0fdf4',
      '--warn':          '#d97706',
      '--warn-bg':       '#fffbeb',
      '--danger':        '#dc2626',
      '--danger-bg':     '#fef2f2',
      '--navbar-bg':     '#ffffff',
      '--navbar-text':   '#09090b',
      '--navbar-text-dim': '#71717a',
      '--panel-hdr-bg':  '#fafafa',
      '--diff-bg':       '#fffbeb',
      '--diff-border':   '#d97706',
      '--diff-text':     '#92400e',
      '--table-row-alt': '#fbfbfb',
    }
  },

  apple: {
    label: 'Apple Minimal',
    desc:  'Glassmorphism, rounded corners, blur',
    preview: { bg: '#f5f5f7', accent: '#0066cc', text: '#1d1d1f' },
    vars: {
      '--bg-base':       '#f5f5f7',
      '--bg-surface':    '#ffffff',
      '--bg-muted':      '#e8e8ed',
      '--bg-sidebar':    '#f5f5f7',
      '--border':        '#d2d2d7',
      '--border-light':  '#e5e5ea',
      '--text-head':     '#1d1d1f',
      '--text-body':     '#333336',
      '--text-mid':      '#86868b',
      '--text-dim':      '#98989d',
      '--text-inv':      '#ffffff',
      '--accent':        '#0066cc',
      '--accent-hover':  '#004c99',
      '--accent-bg':     '#e5f0fa',
      '--ok':            '#34c759',
      '--ok-bg':         '#eaf9ed',
      '--warn':          '#ff9f0a',
      '--warn-bg':       '#fff5e6',
      '--danger':        '#ff3b30',
      '--danger-bg':     '#ffebe9',
      '--navbar-bg':     'rgba(255, 255, 255, 0.7)',
      '--navbar-text':   '#1d1d1f',
      '--navbar-text-dim': '#86868b',
      '--panel-hdr-bg':  '#f5f5f7',
      '--diff-bg':       '#fff5e6',
      '--diff-border':   '#ff9f0a',
      '--diff-text':     '#995c00',
      '--table-row-alt': '#f0f0f3',
    }
  },
  accessible: {
    label: 'High Contrast',
    desc:  'High-contrast dark with vivid yellow accents — WCAG AAA',
    preview: { bg: '#000000', accent: '#facc15', text: '#ffffff' },
    vars: {
      '--bg-base':       '#000000',
      '--bg-surface':    '#0d0d0d',
      '--bg-muted':      '#1c1c1c',
      '--bg-sidebar':    '#050505',
      '--border':        '#404040',
      '--border-light':  '#262626',
      '--text-head':     '#ffffff',
      '--text-body':     '#f5f5f5',
      '--text-mid':      '#e5e5e5',
      '--text-dim':      '#a3a3a3',
      '--text-inv':      '#000000',
      '--accent':        '#facc15',
      '--accent-hover':  '#eab308',
      '--accent-bg':     'rgba(250, 204, 21, 0.2)',
      '--ok':            '#22c55e',
      '--ok-bg':         'rgba(34, 197, 94, 0.2)',
      '--warn':          '#f59e0b',
      '--warn-bg':       'rgba(245, 158, 11, 0.2)',
      '--danger':        '#ef4444',
      '--danger-bg':     'rgba(239, 68, 68, 0.2)',
      '--navbar-bg':     '#000000',
      '--navbar-text':   '#ffffff',
      '--navbar-text-dim': '#e5e5e5',
      '--panel-hdr-bg':  '#171717',
      '--diff-bg':       'rgba(250, 204, 21, 0.2)',
      '--diff-border':   '#facc15',
      '--diff-text':     '#fef08a',
      '--table-row-alt': '#141414',
    }
  },
};

const DEFAULT_THEME = 'mono';

/** Apply theme variables to :root — safe, no localStorage. */
function applyTheme(name) {
  var theme = THEMES[name] || THEMES[DEFAULT_THEME];
  var root  = document.documentElement;
  var vars  = theme.vars;
  for (var k in vars) {
    if (vars.hasOwnProperty(k)) root.style.setProperty(k, vars[k]);
  }
  root.setAttribute('data-theme', name);
  // Persist to in-memory map (actual persistence is via Python backend)
  if (window._apMem) window._apMem['ap_theme'] = name;
}

function loadSavedTheme(name) {
  // name comes from Python backend (passed after API loads);
  // on first render use default — no localStorage needed
  applyTheme(name || DEFAULT_THEME);
}

function buildThemeGrid() {
  var grid = document.getElementById('theme-grid');
  if (!grid) return;
  grid.innerHTML = '';
  var current = (window._apMem && window._apMem['ap_theme']) || DEFAULT_THEME;
  for (var name in THEMES) {
    if (!THEMES.hasOwnProperty(name)) continue;
    (function(n) {
      var theme  = THEMES[n];
      var active = n === current;
      var btn    = document.createElement('button');
      btn.className = 'theme-card' + (active ? ' active' : '');
      btn.dataset.theme = n;
      btn.innerHTML =
        '<div class="theme-preview" style="background:' + theme.preview.bg + ';border:1px solid #ccc">' +
          '<div style="background:' + theme.preview.accent + ';width:100%;height:6px;border-radius:2px 2px 0 0"></div>' +
          '<div style="padding:4px;display:flex;gap:3px">' +
            '<div style="flex:1;height:8px;background:' + theme.preview.accent + ';opacity:.3;border-radius:2px"></div>' +
            '<div style="flex:2;height:8px;background:' + theme.preview.text  + ';opacity:.15;border-radius:2px"></div>' +
          '</div>' +
          '<div style="padding:2px 4px;font-size:9px;color:' + theme.preview.text + ';opacity:.6;font-family:monospace">Aa</div>' +
        '</div>' +
        '<div class="theme-label">' + theme.label + '</div>' +
        '<div class="theme-desc">'  + theme.desc  + '</div>';
      btn.addEventListener('click', function() {
        grid.querySelectorAll('.theme-card').forEach(function(c){ c.classList.remove('active'); });
        btn.classList.add('active');
        applyTheme(n);
        if (window._apMem) window._apMem['ap_theme'] = n;
        // Persist via backend
        if (window.pywebview && window.pywebview.api) {
          window.pywebview.api.save_settings({ ap_theme: n });
        }
      });
      grid.appendChild(btn);
    })(name);
  }
}

// Apply default theme immediately — no localStorage needed
applyTheme(DEFAULT_THEME);
