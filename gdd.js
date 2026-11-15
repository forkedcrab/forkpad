'use strict';
/* ForkPad GDD boards: the canvas editor, window.GDD.
   GDD.mount(el, board, host, opts) builds the editor inside el and returns its controller (PLAN.md "Editor API").
   The data model and geometry live in gdd-model.js (GDDModel); gdd-render.js draws the same board to PNG,
   so the visuals here follow GDDModel.TYPO / FONTS and the drawing order in PLAN.md.
   app.js loads after this file, so its helpers (toast, pref) are only touched inside functions. */
(function () {
  const M = window.GDDModel;
  const T = M.TYPO;

  /* ---------- constants ---------- */
  const ZMIN = 0.1, ZMAX = 4, GRID = 24, SNAP = 8, HISTORY = 100;
  // Frame look. gdd-render.js should use the same numbers so snapshots match the editor.
  const FRAME = { radius: 16, body: 0.08, bar: 0.22, stroke: 0.45, strokeW: 2 };
  const SHAPE_SIZE = { rect: [160, 120], roundrect: [180, 100], ellipse: [140, 140], triangle: [150, 130], diamond: [150, 150], hexagon: [160, 140], star: [140, 134], arrow: [180, 100] };
  // Text needs more room inside pointy shapes than inside a box.
  const SHAPE_ROOM = { ellipse: 1.3, diamond: 1.7, triangle: 1.7, star: 1.9, hexagon: 1.15 };
  const TEXT_SIZES = [14, 16, 20, 24, 32, 40, 48, 64, 80];
  const NOTE_SIZES = [11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 40];
  const PEN_WIDTHS = [2, 4, 8, 14];
  const LINK_WIDTHS = [1, 2, 3, 4, 6, 8];
  const FONT_NAMES = { sans: 'Sans', hand: 'Handwritten', mono: 'Mono' };
  const FITS = { text: 1, bubble: 1, shape: 1 };
  const TOOLS = [['select', 'Select', 'V'], ['hand', 'Hand', 'H'], 0, ['frame', 'Frame', 'F'], ['text', 'Text', 'T'], ['note', 'Note', 'N'], ['shape', 'Shapes', 'S'], ['arrow', 'Arrow', 'A'], ['line', 'Line', 'L'], 0, ['pen', 'Pen', 'P'], ['eraser', 'Eraser', 'E'], ['image', 'Image', 'I']];
  const KEYS = { v: 'select', h: 'hand', f: 'frame', t: 'text', n: 'note', s: 'shape', a: 'arrow', l: 'line', p: 'pen', e: 'eraser', i: 'image', 'ı': 'image' };
  const HELP = [
    ['Tools', [['V', 'Select'], ['H or Space', 'Pan'], ['F', 'Frame (a GDD section)'], ['T', 'Text'], ['N', 'Note, again for next style'], ['S', 'Shape, again for next shape'], ['A / L', 'Arrow / line'], ['P', 'Pen'], ['E', 'Eraser (doodles)'], ['I', 'Image']]],
    ['Canvas', [['Scroll', 'Pan'], ['Ctrl + scroll', 'Zoom at cursor'], ['Shift 1', 'Zoom to fit'], ['Shift 0', 'Zoom to 100%'], ['G', 'Snap to grid'], ['Double-click', 'New note'], ['Ctrl V', 'Paste images, text or items'], ['Drop files', 'Add images']]],
    ['Editing', [['Enter', 'Edit text'], ['Esc', 'Finish / deselect'], ['Del', 'Delete'], ['Ctrl D', 'Duplicate'], ['Ctrl C / V', 'Copy / paste'], ['Ctrl Z / Y', 'Undo / redo'], ['Arrows', 'Nudge (Shift: 10px)'], ['] / [', 'Bring front / send back'], ['Shift + drag', 'Keep ratio or lock axis'], ['Drag a +', 'Connect, drop for a new note']]],
  ];

  /* ---------- small helpers ---------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const E = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const r1 = n => Math.round(n * 10) / 10;
  const isHex = c => /^#[0-9a-f]{3,8}$/i.test(c || '');
  const hex6 = c => {
    let h = (isHex(c) ? c : '#ffffff').slice(1);
    if (h.length < 6) h = h.slice(0, 3).split('').map(x => x + x).join('');
    return '#' + h.slice(0, 6);
  };
  const rectOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  const contains = (o, i) => i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
  const sameBorder = (a, b) => !!a && !!b && a.style === b.style && +a.width === +b.width && +a.radius === +b.radius && String(a.color).toLowerCase() === String(b.color).toLowerCase();
  function segDist(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
    const t = l ? clamp(((px - a[0]) * dx + (py - a[1]) * dy) / l, 0, 1) : 0;
    return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
  }
  // Rounded rect with only the top corners rounded (frame title bar).
  function topBarPath(w, h, r) {
    r = Math.min(r, h, w / 2);
    return `M0 ${h}V${r}A${r} ${r} 0 0 1 ${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h}Z`;
  }
  const measure = (() => { let c; return (text, font) => { c ||= document.createElement('canvas').getContext('2d'); c.font = font; return c.measureText(text).width; }; })();
  const say = (msg, action, fn) => { if (typeof toast === 'function') toast(msg, action, fn); };
  const prefGet = (k, d) => { try { return typeof pref !== 'undefined' ? pref.get(k, d) : d; } catch { return d; } };
  const prefSet = (k, v) => { try { if (typeof pref !== 'undefined') pref.set(k, v); } catch { /* storage blocked */ } };
  const typingIn = a => !!a?.matches?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  const modalOpen = () => (document.getElementById('modalRoot')?.children.length || 0) > 0;

  let CLIP = null; // items copied with Ctrl+C, shared by every board opened in this window

  /* ---------- icons ---------- */
  const P = {
    select: '<path d="M4.5 4.5 19.5 10l-6.8 2.7-2.7 6.8z"/>',
    hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
    frame: '<path d="M7 3v18M17 3v18M3 7h18M3 17h18"/>',
    text: '<path d="M5 7V5h14v2M12 5v14M9 19h6"/>',
    note: '<path d="M4 4h16v10l-6 6H4z"/><path d="M14 20v-6h6"/>',
    shape: '<rect x="3.5" y="11.5" width="9" height="9" rx="1.5"/><circle cx="16.5" cy="7.5" r="4.5"/>',
    arrow: '<path d="M5 19 19 5M10 5h9v9"/>',
    line: '<path d="M5 19 19 5"/>',
    pen: '<path d="M15.5 4.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/><path d="m13.5 6.5 3 3"/>',
    eraser: '<path d="m7 20-3.3-3.3a1.5 1.5 0 0 1 0-2.1l9.9-9.9a1.5 1.5 0 0 1 2.1 0l4.6 4.6a1.5 1.5 0 0 1 0 2.1L11.7 20z"/><path d="M20 20H7M9 9.5l5.5 5.5"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.5M12 17h.01"/>',
    back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a6.6 6.6 0 0 0 10 10z"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    template: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    checksq: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    up: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
    down: '<path d="M12 5v14M5.5 12.5 12 19l6.5-6.5"/>',
    bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>',
    left: '<path d="M4 6h16M4 12h10M4 18h13"/>',
    center: '<path d="M4 6h16M7 12h10M5.5 18h13"/>',
    right: '<path d="M4 6h16M10 12h10M7 18h13"/>',
    dash: '<path d="M3 12h4M10 12h4M17 12h4"/>',
    grid: '<path d="M5 5h.01M12 5h.01M19 5h.01M5 12h.01M12 12h.01M19 12h.01M5 19h.01M12 19h.01M19 19h.01"/>',
    straight: '<path d="M5 19 19 5"/>',
    curve: '<path d="M4 19C4 10 20 14 20 5"/>',
    elbow: '<path d="M4 19h8V5h8"/>',
    swap: '<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>',
    caption: '<rect x="4" y="4" width="16" height="11" rx="2"/><path d="M7 19.5h10"/>',
    heading: '<path d="M6 4v16M18 4v16M6 12h12"/>',
    marker: '<path d="m9 11-5 5v4h4l5-5"/><path d="m13 7 4 4M10.5 9.5 16 4l4 4-5.5 5.5"/>',
    border: '<rect x="4" y="4" width="16" height="16" rx="3" stroke-dasharray="3 2.6"/>',
    sticky: '<path d="M4 4h16v11l-5 5H4z"/>',
    card: '<rect x="3" y="5" width="18" height="14" rx="4"/>',
    speech: '<path d="M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>',
    outline: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
    letter: '<path d="m6 17 6-13 6 13M8.5 12h7"/>',
    hnone: '<path d="M4 12h16"/>',
    harrow: '<path d="M4 12h15M13 6l6 6-6 6"/>',
    hdot: '<path d="M4 12h11"/><circle cx="17.5" cy="12" r="2.5" fill="currentColor"/>',
  };
  const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;
  function shapeIcon(s) {
    const [w, h] = ['rect', 'roundrect', 'arrow'].includes(s) ? [18, 13] : [18, 17];
    return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path transform="translate(${(24 - w) / 2} ${(24 - h) / 2})" d="${M.shapePath(s, w, h)}"/></svg>`;
  }
  const headIcon = (kind, flip) => icon(kind === 'arrow' ? 'harrow' : kind === 'dot' ? 'hdot' : 'hnone', flip ? 'flip' : '');

  const EMPTY_ART = `<svg class="ge-art" viewBox="0 0 120 64" aria-hidden="true"><rect x="6" y="10" width="40" height="38" rx="3" fill="#f7d774"/>
    <path d="M13 22h26M13 30h18" stroke="#2a2111" stroke-width="3" stroke-linecap="round"/>
    <path d="M52 34Q66 16 79 28" fill="none" stroke="#ff8f1f" stroke-width="2.5" stroke-linecap="round"/><path d="M82 31 74.5 28.3 79.3 23.5Z" fill="#ff8f1f"/>
    <circle cx="99" cy="40" r="15" fill="#8cc8ff"/></svg>`;

  /* ======================================================================
     mount
     ====================================================================== */
  function mount(el, board, host, opts = {}) {
    M.migrate(board);
    const saved = prefGet('gdd.tools', {}) || {};
    const S = {
      tool: 'select',
      noteStyle: M.BUBBLE_STYLES.includes(saved.noteStyle) ? saved.noteStyle : 'sticky',
      shape: M.SHAPES.includes(saved.shape) ? saved.shape : 'rect',
      pen: { color: '#ff8f1f', width: 4, highlight: false, ...(saved.pen || {}) },
      linkStyle: { route: 'straight', width: 2, dash: false, color: null, ...(saved.linkStyle || {}) },
      sel: new Set(), link: null, view: { x: 0, y: 0, z: 1 }, viewReady: false,
      g: null, edit: null, label: null, hover: null, pop: null,
      space: false, dirty: false, undo: [], redo: [], histKey: null, histAt: 0,
      pointer: null, lastDown: null, lastPaste: null, lastZ: 0, destroyed: false,
    };
    const saveTools = () => prefSet('gdd.tools', { noteStyle: S.noteStyle, shape: S.shape, pen: S.pen, linkStyle: S.linkStyle });

    /* ---------- DOM ---------- */
    const dockHTML = TOOLS.map(t => t
      ? `<button class="gd-tool" data-tool="${t[0]}" data-tip="${t[1]} (${t[2]})" aria-label="${t[1]}">${icon(t[0])}</button>`
      : '<span class="gd-sep"></span>').join('');
    const helpHTML = `<div class="gh-panel" role="dialog" aria-label="Shortcuts">
      <div class="gh-top"><h3>Board shortcuts</h3><button class="icon-btn" data-help="close" aria-label="Close">${icon('x')}</button></div>
      <div class="gh-cols">${HELP.map(([h, rows]) => `<div><h4>${h}</h4>${rows.map(([k, d]) => `<div class="gh-row"><kbd>${E(k)}</kbd><span>${E(d)}</span></div>`).join('')}</div>`).join('')}</div>
      <p class="gh-tip">Claude can read this board through the ForkPad connector, then turn it into a project with tasks. Use <b>Ask Claude</b> to copy a ready prompt.</p></div>`;

    el.replaceChildren();
    const root = document.createElement('div');
    root.className = 'gdd';
    root.dataset.tool = 'select';
    root.innerHTML = `
      <header class="gdd-top">
        <button class="icon-btn" data-hb="back" data-tip="Back">${icon('back')}</button>
        <input class="gdd-title" spellcheck="false" maxlength="120" aria-label="Board title" placeholder="Untitled GDD">
        <select class="select gdd-proj" aria-label="Project"></select>
        <span class="gdd-saved"></span>
        <span class="spacer"></span>
        <button class="icon-btn" data-hb="undo" data-tip="Undo (Ctrl+Z)">${icon('undo')}</button>
        <button class="icon-btn" data-hb="redo" data-tip="Redo (Ctrl+Y)">${icon('redo')}</button>
        <button class="icon-btn" data-hb="snap" data-tip="Snap to grid (G)">${icon('grid', 'dots')}</button>
        <button class="icon-btn" data-hb="bg" data-tip="Light or dark canvas"></button>
        <span class="gdd-sep"></span>
        <button class="btn sm ghost" data-hb="template" data-tip="Add the GDD section frames">${icon('template')}Template</button>
        <button class="btn sm ghost" data-hb="export" data-tip="Download the board as PNG">${icon('download')}Export</button>
        <button class="btn sm gdd-claude" data-hb="claude" data-tip="Copy a prompt for Claude Code">${icon('spark')}Ask Claude</button>
        <button class="icon-btn" data-hb="help" data-tip="Shortcuts (?)">${icon('help')}</button>
      </header>
      <div class="gdd-stage">
        <div class="gdd-vp" tabindex="-1">
          <div class="gdd-world">
            <div class="gdd-frames"></div>
            <svg class="gdd-links" xmlns="http://www.w3.org/2000/svg"></svg>
            <div class="gdd-items"></div>
            <div class="gdd-ui"></div>
            <svg class="gdd-live" xmlns="http://www.w3.org/2000/svg"><path class="gl-live" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path class="gl-live-head"/></svg>
          </div>
        </div>
        <div class="gdd-blank" hidden><div class="ge-card">${EMPTY_ART}
          <h3>Sketch your game idea</h3>
          <p>Drop in reference images, connect ideas with arrows and explain mechanics in notes. Claude can read the board and turn it into tasks.</p>
          <div class="ge-btns"><button class="btn primary" data-e="template">${icon('template')}Start from GDD template</button><button class="btn" data-e="image">${icon('image')}Add images</button></div>
          <ul class="ge-tips"><li><kbd>Ctrl V</kbd> paste or drop images</li><li><kbd>Double-click</kbd> anywhere for a note</li><li><kbd>P</kbd> doodle <kbd>A</kbd> arrows <kbd>S</kbd> shapes</li></ul>
        </div></div>
        <nav class="gdd-dock" aria-label="Tools">${dockHTML}</nav>
        <div class="gdd-fly" hidden></div>
        <div class="gdd-bar" hidden></div>
        <div class="gdd-pop" hidden></div>
        <div class="gdd-zoom">
          <button class="icon-btn xs" data-z="out" data-tip="Zoom out">${icon('minus')}</button>
          <button class="gz-pct" data-z="pct" data-tip="Zoom to 100%">100%</button>
          <button class="icon-btn xs" data-z="in" data-tip="Zoom in">${icon('plus')}</button>
          <button class="icon-btn xs" data-z="fit" data-tip="Zoom to fit (Shift+1)">${icon('fit')}</button>
        </div>
        <div class="gdd-help" hidden>${helpHTML}</div>
      </div>`;
    el.append(root);
    const q = s => root.querySelector(s);
    const head = q('.gdd-top'), titleIn = q('.gdd-title'), projSel = q('.gdd-proj'), savedEl = q('.gdd-saved');
    const stage = q('.gdd-stage'), vp = q('.gdd-vp'), world = q('.gdd-world');
    const framesL = q('.gdd-frames'), linksL = q('.gdd-links'), itemsL = q('.gdd-items'), ui = q('.gdd-ui');
    const livePath = q('.gl-live'), liveHead = q('.gl-live-head');
    const emptyEl = q('.gdd-blank'), dock = q('.gdd-dock'), fly = q('.gdd-fly'), bar = q('.gdd-bar'), pop = q('.gdd-pop');
    const zoomPct = q('.gz-pct'), helpEl = q('.gdd-help');

    /* ---------- lookups ---------- */
    const byId = id => board.items.find(i => i.id === id);
    const selItems = () => board.items.filter(i => S.sel.has(i.id));
    const curLink = () => S.link ? board.links.find(l => l.id === S.link) || null : null;
    const bgKey = () => board.style.background === 'light' ? 'light' : 'dark';
    const BG = () => M.BACKGROUNDS[bgKey()];
    const snap = v => board.style.snap ? Math.round(v / SNAP) * SNAP : Math.round(v);
    // A frame's items move with it (and are copied with it).
    function moving(ids) {
      const out = new Set(ids);
      for (const id of ids) { const f = byId(id); if (f?.type === 'frame') for (const c of M.itemsInFrame(board, f)) out.add(c.id); }
      return board.items.filter(i => out.has(i.id));
    }
    // Topmost item a connector can attach to (frames and doodles are skipped).
    function hitItem(p, skip) {
      for (let i = board.items.length - 1; i >= 0; i--) {
        const it = board.items[i];
        if (it.type !== 'frame' && it.type !== 'draw' && it.id !== skip && M.inside(p, it)) return it;
      }
      return null;
    }
    function nearStroke(it, p, tol) {
      const w = (it.highlight ? it.width * 3 : it.width) / 2 + tol;
      if (p.x < it.x - w || p.x > it.x + it.w + w || p.y < it.y - w || p.y > it.y + it.h + w) return false;
      const pts = it.points || [], lx = p.x - it.x, ly = p.y - it.y;
      if (pts.length === 1) return Math.hypot(lx - pts[0][0], ly - pts[0][1]) <= w;
      for (let i = 1; i < pts.length; i++) if (segDist(lx, ly, pts[i - 1], pts[i]) <= w) return true;
      return false;
    }
    // New frames go behind other items (right after the last frame), everything else on top.
    function insert(list) {
      const fr = list.filter(i => i.type === 'frame'), rest = list.filter(i => i.type !== 'frame');
      if (fr.length) {
        let at = 0;
        board.items.forEach((i, k) => { if (i.type === 'frame') at = k + 1; });
        board.items.splice(at, 0, ...fr);
      }
      board.items.push(...rest);
    }
    const defaultTail = it => ({ x: Math.round(it.w * 0.28), y: it.h + 46 });

    /* ---------- view: pan & zoom ---------- */
    const toWorld = (e, r = vp.getBoundingClientRect()) => ({ x: (e.clientX - r.left - S.view.x) / S.view.z, y: (e.clientY - r.top - S.view.y) / S.view.z });
    const viewCenter = () => ({ x: (stage.clientWidth / 2 - S.view.x) / S.view.z, y: (stage.clientHeight / 2 - S.view.y) / S.view.z });
    let viewT = 0;
    const saveViewNow = () => { clearTimeout(viewT); prefSet('gdd.view.' + board.id, { x: Math.round(S.view.x), y: Math.round(S.view.y), z: Math.round(S.view.z * 1000) / 1000 }); };
    function applyView() {
      const { x, y, z } = S.view;
      world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
      world.style.setProperty('--z', z);
      // keep grid dots at least ~14px apart on screen by doubling the step when zoomed out
      let step = GRID; while (step * z < 14) step *= 2;
      const s = step * z;
      vp.style.backgroundSize = `${s}px ${s}px`;
      vp.style.backgroundPosition = `${x - s / 2}px ${y - s / 2}px`;
      zoomPct.textContent = Math.round(z * 100) + '%';
      if (z !== S.lastZ) { S.lastZ = z; renderUI(); }
      placeBar();
      clearTimeout(viewT); viewT = setTimeout(saveViewNow, 400);
    }
    function zoomAt(sx, sy, z) {
      z = clamp(z, ZMIN, ZMAX);
      const v = S.view, wx = (sx - v.x) / v.z, wy = (sy - v.y) / v.z;
      v.z = z; v.x = sx - wx * z; v.y = sy - wy * z;
      applyView();
    }
    const zoomBy = f => zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, S.view.z * f);
    function fitView(b = M.contentBounds(board), maxZ = 1) {
      const W = stage.clientWidth, H = stage.clientHeight;
      if (!b) { S.view = { x: W / 2, y: H / 2, z: 1 }; applyView(); return; }
      const z = clamp(Math.min((W - 180) / Math.max(1, b.w), (H - 120) / Math.max(1, b.h), maxZ), ZMIN, ZMAX);
      S.view = { z, x: (W + 50) / 2 - (b.x + b.w / 2) * z, y: H / 2 - (b.y + b.h / 2) * z };
      applyView();
    }
    function centerOn(it) {
      const W = stage.clientWidth, H = stage.clientHeight;
      if (it.w * S.view.z > W - 160 || it.h * S.view.z > H - 140) return fitView(M.bounds(it), 1);
      S.view.x = W / 2 - (it.x + it.w / 2) * S.view.z;
      S.view.y = H / 2 - (it.y + it.h / 2) * S.view.z;
      applyView();
    }
    function initView() {
      if (S.viewReady || !stage.clientWidth) return;
      S.viewReady = true;
      const v = prefGet('gdd.view.' + board.id, null), cb = M.contentBounds(board);
      const W = stage.clientWidth, H = stage.clientHeight;
      if (v && [v.x, v.y, v.z].every(Number.isFinite)) {
        S.view = { x: v.x, y: v.y, z: clamp(v.z, ZMIN, ZMAX) };
        // a remembered view that shows none of the content (Claude added things elsewhere) falls back to fit
        const seen = { x: -S.view.x / S.view.z, y: -S.view.y / S.view.z, w: W / S.view.z, h: H / S.view.z };
        if (cb && !M.overlaps(seen, cb)) return focusAfter(fitView(cb));
        applyView();
      } else if (cb) fitView(cb);
      else { S.view = { x: W / 2, y: H / 2, z: 1 }; applyView(); }
      focusAfter();
    }
    function focusAfter() {
      const f = opts.focusItem && byId(opts.focusItem);
      if (f) { select([f.id]); centerOn(f); }
    }
    function onWheel(e) {
      e.preventDefault();
      closePop();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (e.ctrlKey || e.metaKey) {
        const r = vp.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, S.view.z * Math.exp(-clamp(e.deltaY * k, -120, 120) * 0.0022));
      } else {
        S.view.x -= e.deltaX * k; S.view.y -= e.deltaY * k;
        applyView();
      }
    }
    function applyBg() {
      const k = bgKey(), B = M.BACKGROUNDS[k];
      root.dataset.bg = k;
      for (const [n, v] of Object.entries({ bg: B.bg, dot: B.dot, ink: B.ink, muted: B.muted })) vp.style.setProperty('--cv-' + n, v);
    }

    /* ---------- rendering: items ---------- */
    const nodes = new Map(); // item id -> { el, sig, geo }
    const urls = new Map(), loading = new Set();
    let taskMap = new Map(), taskSig = '';
    function refreshTasks() {
      let list = [];
      try { list = host.tasksFor?.(board.id) || []; } catch { list = []; }
      taskMap = new Map();
      for (const t of list) {
        const id = t?.gdd?.itemId; if (!id) continue;
        if (!taskMap.has(id)) taskMap.set(id, []);
        taskMap.get(id).push(t);
      }
      const sig = list.map(t => `${t.id}:${t.status}:${t.gdd?.itemId || ''}:${t.title}`).join('|');
      const changedSig = sig !== taskSig;
      taskSig = sig;
      return changedSig;
    }
    function loadImg(id) {
      if (!id || urls.has(id) || loading.has(id)) return;
      loading.add(id);
      Promise.resolve(host.imageURL(id)).then(u => {
        loading.delete(id);
        if (!u || S.destroyed) return;
        urls.set(id, u);
        for (const it of board.items) if (it.imageId === id) { const img = nodes.get(it.id)?.el.querySelector('img'); if (img) img.src = u; }
      }).catch(() => loading.delete(id));
    }
    const textCSS = (it, color) => `font-family:${M.FONTS[it.font] || M.FONTS.sans};font-size:${it.size}px;line-height:${T.lineHeight};color:${color};`;

    // The part of an item that depends on its size: an SVG body (frames, notes, shapes, doodles).
    function svgFor(it) {
      const { w, h } = it, bg = bgKey();
      const open = (extra = '') => `<svg class="gi-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${extra}>`;
      switch (it.type) {
        case 'frame': {
          const c = M.fillOf(it.color) || M.PALETTE.gray.fill;
          return open() + `<path d="${M.roundRectPath(w, h, FRAME.radius)}" fill="${c}" fill-opacity="${FRAME.body}" stroke="${c}" stroke-opacity="${FRAME.stroke}" stroke-width="${FRAME.strokeW}"/>`
            + `<path d="${topBarPath(w, T.frameTitleH, FRAME.radius)}" fill="${c}" fill-opacity="${FRAME.bar}"/></svg>`;
        }
        case 'bubble': return open() + `<path d="${M.bubblePath(it)}" fill="${M.fillOf(it.color) || M.PALETTE.yellow.fill}"/></svg>`;
        case 'shape': {
          const fill = M.fillOf(it.fill), sw = +it.strokeWidth || 0;
          const stroke = sw ? M.inkOf(it.stroke, bg) : 'none';
          return open() + `<path d="${M.shapePath(it.shape, w, h)}" fill="${fill || 'none'}" stroke="${stroke}" stroke-width="${sw}"${it.dash && sw ? ` stroke-dasharray="${sw * 3} ${sw * 2}"` : ''} stroke-linejoin="round"/></svg>`;
        }
        case 'draw': {
          const sw = it.highlight ? it.width * 3 : it.width, m = Math.ceil(sw / 2 + 10), d = M.strokePath(it.points);
          return `<svg class="gi-svg gi-dsvg" style="left:${-m}px;top:${-m}px" width="${w + 2 * m}" height="${h + 2 * m}" viewBox="${-m} ${-m} ${w + 2 * m} ${h + 2 * m}">`
            + `<path d="${d}" fill="none" stroke="${M.inkOf(it.color, bg)}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${it.highlight ? ' stroke-opacity=".4"' : ''}/>`
            + `<path class="gi-hit" d="${d}" fill="none" stroke="transparent" stroke-width="${sw + 12}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        }
      }
      return '';
    }
    function chipHTML(it) {
      const ts = taskMap.get(it.id);
      if (!ts?.length) return '';
      const done = ts.filter(t => t.status === 'done').length;
      return `<button class="gi-chip${done === ts.length ? ' done' : ''}" title="Linked tasks">${icon('check')}${done}/${ts.length}</button>`;
    }
    function itemHTML(it) {
      const bg = bgKey();
      let h = svgFor(it);
      switch (it.type) {
        case 'frame': h += `<div class="gi-ftitle gi-ed" data-f="title" data-ph="Section name" style="font-size:${T.frameTitleSize}px;height:${T.frameTitleH}px;line-height:${T.frameTitleH}px;padding:0 ${T.framePad}px">${E(it.title)}</div>`; break;
        case 'image': {
          const b = it.border || { style: 'none' }, bw = b.style === 'none' ? 0 : Math.max(0, +b.width || 0);
          let box = `border-radius:${+b.radius || 0}px;`;
          if (b.style === 'polaroid') box += `background:${b.color};padding:${bw}px ${bw}px ${bw * 3}px;`;
          else if (bw) box += `border:${bw}px ${b.style === 'dashed' ? 'dashed' : 'solid'} ${b.color};`;
          const src = urls.get(it.imageId);
          h += `<div class="gi-imgbox" style="${E(box)}">${it.imageId
            ? `<img alt="" draggable="false" style="object-fit:${it.fit === 'contain' ? 'contain' : 'cover'}"${src ? ` src="${E(src)}"` : ''}>`
            : `<div class="gi-noimg">${icon('image')}</div>`}</div>`;
          h += `<div class="gi-cap gi-ed" data-f="caption" data-ph="Add a caption" style="top:calc(100% + ${T.captionGap}px);font-size:${T.captionSize}px;line-height:${T.lineHeight}">${E(it.caption)}</div>`;
          break;
        }
        case 'text':
          h += `<div class="gi-text gi-ed" data-f="text" data-ph="Type something" style="${E(textCSS(it, M.inkOf(it.color, bg)))}font-weight:${it.weight};text-align:${it.align};padding:${T.pad.text}px">${E(it.text)}</div>`;
          break;
        case 'bubble':
          h += `<div class="gi-body" style="${E(textCSS(it, M.textOn(it.color, bg)))}padding:${T.pad.bubble}px">`
            + `<div class="gi-btitle gi-ed" data-f="title" data-ph="Title" style="font-size:${r1(it.size * T.bubbleTitleScale)}px;margin-bottom:${T.titleGap}px">${E(it.title)}</div>`
            + `<div class="gi-btext gi-ed" data-f="text" data-ph="Write a note">${E(it.text)}</div></div>`;
          break;
        case 'shape': {
          const ink = it.color ? M.inkOf(it.color, bg) : M.textOn(it.fill, bg);
          h += `<div class="gi-body gi-center" style="padding:${T.pad.shape}px"><div class="gi-label gi-ed" data-f="text" style="${E(textCSS(it, ink))}">${E(it.text)}</div></div>`;
          break;
        }
      }
      return h + chipHTML(it);
    }
    function place(e, it) {
      e.style.left = it.x + 'px'; e.style.top = it.y + 'px';
      e.style.width = it.w + 'px'; e.style.height = it.h + 'px';
    }
    // Create or update one item's node. Moves only touch left/top; size changes only redraw the SVG,
    // so images and the text being edited are never rebuilt mid-gesture.
    function syncItem(it) {
      let n = nodes.get(it.id);
      if (!n) {
        const e = document.createElement('div');
        e.dataset.i = it.id;
        n = { el: e, sig: '', geo: '' };
        nodes.set(it.id, n);
      }
      const { x, y, w, h, ...rest } = it;
      const sig = JSON.stringify(rest) + bgKey() + (taskMap.get(it.id) || []).map(t => t.status).join();
      const geo = w + 'x' + h;
      const editing = S.edit?.id === it.id;
      if (n.sig !== sig && !editing) {
        n.el.className = `gi gi-${it.type}`;
        n.el.innerHTML = itemHTML(it);
        n.sig = sig; n.geo = geo;
        if (it.type === 'image' && it.imageId && !urls.has(it.imageId)) loadImg(it.imageId);
      } else if (n.geo !== geo) {
        const old = n.el.querySelector(':scope > .gi-svg');
        if (old) old.outerHTML = svgFor(it);
        n.geo = geo;
      }
      place(n.el, it);
      return n.el;
    }
    const placeNode = it => { const n = nodes.get(it.id); if (n) place(n.el, it); };
    function orderLayer(layer, list) {
      const ch = layer.children;
      if (ch.length === list.length && list.every((e, i) => ch[i] === e)) return;
      layer.replaceChildren(...list);
    }
    function renderItems() {
      const fr = [], rest = [], ids = new Set();
      for (const it of board.items) { ids.add(it.id); (it.type === 'frame' ? fr : rest).push(syncItem(it)); }
      for (const [id, n] of nodes) if (!ids.has(id)) { n.el.remove(); nodes.delete(id); }
      orderLayer(framesL, fr);
      orderLayer(itemsL, rest);
    }

    /* ---------- text auto-height ---------- */
    function natural(it) {
      const n = nodes.get(it.id)?.el;
      if (!n) return 0;
      if (it.type === 'text') return n.querySelector('.gi-text')?.offsetHeight || 0;
      if (it.type === 'bubble') return n.querySelector('.gi-body')?.offsetHeight || 0;
      const lab = n.querySelector('.gi-label');
      if (!lab || !lab.textContent.trim()) return 0;
      return Math.ceil(lab.offsetHeight * (SHAPE_ROOM[it.shape] || 1) + 2 * T.pad.shape);
    }
    // Text items fit exactly; notes and shapes only grow (a note sized bigger on purpose stays big).
    function fit(it) {
      if (!FITS[it.type]) return false;
      const need = natural(it);
      if (!need) return false;
      const h = Math.ceil(it.type === 'text' ? Math.max(need, it.size * T.lineHeight + 2 * T.pad.text) : Math.max(it.h, need));
      if (Math.abs(h - it.h) < 1) return false;
      it.h = h;
      return true;
    }
    function fitAll() {
      if (S.destroyed || S.edit || S.g) return;
      let any = false;
      for (const it of board.items) if (fit(it)) any = true;
      if (any) { renderAll(); changed(); }
    }

    /* ---------- rendering: links ---------- */
    function linkSVG(l, g, B) {
      const col = M.inkOf(l.color, bgKey()), w = +l.width || 2, on = S.link === l.id;
      const head = (kind, p, ang) => kind === 'arrow' ? `<path d="${M.arrowHeadPath(p, ang, w)}" fill="${col}"/>`
        : kind === 'dot' ? `<circle cx="${p.x}" cy="${p.y}" r="${3 + w}" fill="${col}"/>` : '';
      let s = `<g data-link="${l.id}"${on ? ' class="on"' : ''}>`;
      if (on) s += `<path class="gl-sel" d="${g.d}" stroke-width="${w + 10}"/>`;
      s += `<path d="${g.d}" fill="none" stroke="${col}" stroke-width="${w}"${l.dash ? ` stroke-dasharray="${w * 3} ${w * 2.5}"` : ''} stroke-linecap="round" stroke-linejoin="round"/>`;
      s += head(l.start, g.a, g.angA) + head(l.end, g.b, g.angB);
      s += `<path class="gl-hit" d="${g.d}"/>`;
      if (l.label) {
        const pw = Math.ceil(measure(l.label, `13px ${M.FONTS.sans}`)) + 18;
        s += `<rect class="gl-pill" x="${g.mid.x - pw / 2}" y="${g.mid.y - 11}" width="${pw}" height="22" rx="11" fill="${B.bg}"/>`
          + `<text class="gl-text" x="${g.mid.x}" y="${g.mid.y}" fill="${B.ink}" font-size="13" text-anchor="middle" dominant-baseline="central" font-family="${E(M.FONTS.sans)}">${E(l.label)}</text>`;
      }
      return s + '</g>';
    }
    // The links SVG is sized to its content so clicks on lines far from the origin still hit.
    function renderLinks() {
      const B = BG();
      let out = '', x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const l of board.links) {
        const g = M.linkGeometry(board, l);
        if (!g) continue;
        x1 = Math.min(x1, g.a.x, g.b.x); y1 = Math.min(y1, g.a.y, g.b.y);
        x2 = Math.max(x2, g.a.x, g.b.x); y2 = Math.max(y2, g.a.y, g.b.y);
        out += linkSVG(l, g, B);
      }
      if (!out) { linksL.innerHTML = ''; linksL.setAttribute('width', 0); linksL.setAttribute('height', 0); return; }
      const m = 280;
      x1 = Math.floor(x1 - m); y1 = Math.floor(y1 - m); x2 = Math.ceil(x2 + m); y2 = Math.ceil(y2 + m);
      linksL.setAttribute('viewBox', `${x1} ${y1} ${x2 - x1} ${y2 - y1}`);
      linksL.setAttribute('width', x2 - x1); linksL.setAttribute('height', y2 - y1);
      linksL.style.left = x1 + 'px'; linksL.style.top = y1 + 'px';
      linksL.innerHTML = out;
    }
    function clearLive() {
      livePath.removeAttribute('d'); liveHead.removeAttribute('d');
      livePath.removeAttribute('style');
    }
    function liveLink(from, to, line) {
      const g = M.linkGeometry(board, { from, to, route: S.linkStyle.route });
      livePath.setAttribute('d', g ? g.d : '');
      livePath.setAttribute('style', `stroke:var(--accent);stroke-width:calc(2px / var(--z))`);
      liveHead.setAttribute('d', g && !line ? M.arrowHeadPath(g.b, g.angB, 2 / S.view.z) : '');
      liveHead.setAttribute('style', 'fill:var(--accent)');
    }
    function livePen(pts) {
      const w = S.pen.highlight ? S.pen.width * 3 : S.pen.width;
      livePath.setAttribute('d', M.strokePath(pts));
      livePath.setAttribute('style', `stroke:${M.inkOf(S.pen.color, bgKey())};stroke-width:${w}px;stroke-opacity:${S.pen.highlight ? 0.4 : 1}`);
    }

    /* ---------- rendering: selection UI ---------- */
    function renderUI() {
      const z = S.view.z, pad = 4 / z, g = S.g;
      const box = (r, cls, k = 0) => `<div class="${cls}" style="left:${r.x - k}px;top:${r.y - k}px;width:${r.w + 2 * k}px;height:${r.h + 2 * k}px"></div>`;
      const dot = (x, y, cls, attrs = '') => `<div class="${cls}" ${attrs} style="left:${x}px;top:${y}px"></div>`;
      const items = selItems();
      const dragging = !!(g?.moved && g.kind === 'move');
      let h = '';
      for (const it of items) h += box(it, 'gu-box' + (it.type === 'frame' ? ' fr' : ''), pad);
      if (items.length > 1 && !dragging) h += box(M.unionBounds(items), 'gu-box multi', pad * 3);
      const one = items.length === 1 && S.tool === 'select' && !S.edit && !dragging ? items[0] : null;
      if (one) {
        const { x, y, w } = one, hh = one.h, x2 = x + w, y2 = y + hh, cx = x + w / 2, cy = y + hh / 2;
        const H = { nw: [x - pad, y - pad], n: [cx, y - pad], ne: [x2 + pad, y - pad], e: [x2 + pad, cy], se: [x2 + pad, y2 + pad], s: [cx, y2 + pad], sw: [x - pad, y2 + pad], w: [x - pad, cy] };
        const dirs = one.type === 'text' ? ['w', 'e'] : (w * z < 44 || hh * z < 44) ? ['nw', 'ne', 'se', 'sw'] : Object.keys(H);
        for (const d of dirs) h += dot(H[d][0], H[d][1], 'gu-h', `data-h="${d}"`);
        if (one.type !== 'frame' && one.type !== 'draw' && g?.kind !== 'resize') {
          const o = 26 / z, below = one.type === 'image' && one.caption ? T.captionGap + T.captionSize * T.lineHeight * 2 : 0;
          const Q = { n: [cx, y - o], e: [x2 + o, cy], s: [cx, y2 + o + below], w: [x - o, cy] };
          for (const [side, p] of Object.entries(Q)) h += `<div class="gu-plus" data-h="plus" data-side="${side}" style="left:${p[0]}px;top:${p[1]}px" title="Drag to connect, click to add a connected note">${icon('plus')}</div>`;
        }
        if (one.type === 'bubble' && one.style === 'speech' && one.tail) h += dot(x + one.tail.x, y + one.tail.y, 'gu-tail', 'data-h="tail" title="Drag to point the bubble at something"');
      }
      const l = curLink();
      if (l && S.tool === 'select') {
        const lg = M.linkGeometry(board, l);
        if (lg) h += dot(lg.a.x, lg.a.y, 'gu-lend', 'data-h="lend" data-end="from"') + dot(lg.b.x, lg.b.y, 'gu-lend', 'data-h="lend" data-end="to"');
      }
      if (g?.moved && (g.kind === 'marquee' || g.kind === 'create')) h += box(rectOf(g.p0, g.p1), g.kind === 'marquee' ? 'gu-marq' : 'gu-new');
      const tgt = g ? g.target : S.hover && byId(S.hover);
      if (tgt) h += box(tgt, 'gu-target', 6 / z);
      ui.innerHTML = h;
    }
    function renderAll() {
      if (S.destroyed) return;
      renderItems(); renderLinks(); renderUI(); renderBar(); syncHead();
      emptyEl.hidden = board.items.length > 0;
    }
    function select(ids, link = null) {
      S.sel = new Set(ids); S.link = link;
      renderLinks(); renderUI(); renderBar();
    }

    /* ---------- history & saving ---------- */
    const snapshot = () => JSON.stringify({ items: board.items, links: board.links, style: board.style });
    // Push the current state before a change. Repeated changes with the same key (a color drag,
    // nudges, size steps) within a second become one undo step.
    function checkpoint(key) {
      const now = Date.now();
      if (key && key === S.histKey && now - S.histAt < 1000) { S.histAt = now; return; }
      S.histKey = key || null; S.histAt = now;
      S.undo.push(snapshot());
      if (S.undo.length > HISTORY) S.undo.shift();
      S.redo = [];
      syncHead();
    }
    function restore(s) {
      if (!s) return;
      const o = JSON.parse(s);
      board.items = o.items; board.links = o.links; board.style = o.style;
      const ids = new Set(board.items.map(i => i.id));
      S.sel = new Set([...S.sel].filter(id => ids.has(id)));
      if (S.link && !board.links.some(l => l.id === S.link)) S.link = null;
      applyBg(); renderAll(); changed();
    }
    function undo() {
      endEdit();
      if (!S.undo.length) return;
      S.redo.push(snapshot()); S.histKey = null;
      restore(S.undo.pop());
    }
    function redo() {
      endEdit();
      if (!S.redo.length) return;
      S.undo.push(snapshot()); S.histKey = null;
      restore(S.redo.pop());
    }
    let saveT = 0;
    function changed() {
      board.updated = Date.now();
      S.dirty = true;
      savedEl.textContent = 'Saving…';
      clearTimeout(saveT);
      saveT = setTimeout(flush, 500);
    }
    // Text being typed lives only in the editable until endEdit. Copy it into the board so a
    // save on pagehide or a tab switch keeps it, without ending the edit.
    function commitEdit() {
      const ed = S.edit; if (!ed || S.destroyed) return;
      const it = byId(ed.id); if (!it) return;
      let v = (ed.el.innerText || '').replace(/\r/g, '');
      if (v.endsWith('\n')) v = v.slice(0, -1);
      if (ed.field !== 'text') v = v.replace(/\s*\n+\s*/g, ' ').trim();
      if (v === (it[ed.field] || '') || (ed.fresh && !v.trim())) return;
      if (!ed.touched && !ed.fresh) { ed.touched = true; checkpoint(); }
      it[ed.field] = v;
      S.dirty = true;
    }
    function flush() {
      clearTimeout(saveT);
      commitEdit();
      if (!S.dirty) return;
      S.dirty = false;
      try { host.save(board); savedEl.textContent = 'Saved'; } catch (err) { console.error('GDD save failed', err); savedEl.textContent = 'Not saved'; }
    }
    const isBusy = () => !!S.g || !!S.edit || !!S.label || document.activeElement === titleIn;

    /* ---------- inline text editing ---------- */
    function startEdit(it, field = 'text', { fresh = false, selectAll = false } = {}) {
      endEdit();
      if (!it) return;
      if (!S.sel.has(it.id) || S.sel.size > 1 || S.link) { S.sel = new Set([it.id]); S.link = null; }
      renderItems();
      const n = nodes.get(it.id)?.el, ed = n?.querySelector(`.gi-ed[data-f="${field}"]`);
      if (!ed) return;
      ed.textContent = it[field] || '';
      ed.contentEditable = 'plaintext-only';
      if (ed.contentEditable !== 'plaintext-only') ed.contentEditable = 'true';
      ed.spellcheck = true;
      ed.classList.add('editing'); n.classList.add('is-editing');
      S.edit = { id: it.id, field, el: ed, fresh, orig: it[field] || '', touched: false, h0: it.h };
      ed.addEventListener('keydown', edKey);
      ed.addEventListener('input', edInput);
      ed.addEventListener('blur', edBlur);
      ed.addEventListener('paste', edPaste);
      ed.focus({ preventScroll: true });
      const r = document.createRange();
      r.selectNodeContents(ed);
      if (!selectAll) r.collapse(false);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      renderUI(); renderBar();
    }
    function edKey(e) {
      e.stopPropagation(); // typing never reaches the board or app shortcuts
      const ed = S.edit; if (!ed) return;
      const it = byId(ed.id);
      const oneLine = ed.field === 'caption' || ed.field === 'title';
      if (e.key === 'Enter' && !e.shiftKey && ed.field === 'title' && it?.type === 'bubble') { e.preventDefault(); endEdit(); startEdit(byId(ed.id), 'text'); return; }
      if (e.key === 'Escape' || e.key === 'Tab' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (oneLine && !e.shiftKey)))) {
        e.preventDefault();
        endEdit();
        vp.focus({ preventScroll: true });
      }
    }
    function edInput() {
      const ed = S.edit; if (!ed) return;
      if (!ed.touched) { ed.touched = true; if (!ed.fresh) checkpoint(); }
      const it = byId(ed.id);
      if (it && fit(it)) { syncItem(it); renderLinks(); renderUI(); placeBar(); }
    }
    function edPaste(e) {
      e.preventDefault(); e.stopPropagation();
      const t = e.clipboardData?.getData('text/plain') || '';
      if (t) document.execCommand('insertText', false, t);
    }
    function edBlur() { endEdit(); }
    function endEdit() {
      const ed = S.edit; if (!ed) return;
      S.edit = null;
      const el = ed.el;
      el.removeEventListener('keydown', edKey); el.removeEventListener('input', edInput);
      el.removeEventListener('blur', edBlur); el.removeEventListener('paste', edPaste);
      let v = (el.innerText || '').replace(/\r/g, '');
      if (v.endsWith('\n')) v = v.slice(0, -1);
      el.removeAttribute('contenteditable');
      el.classList.remove('editing');
      el.closest('.gi')?.classList.remove('is-editing');
      if (document.activeElement === el) el.blur();
      try { getSelection().removeAllRanges(); } catch { /* nothing selected */ }
      const it = byId(ed.id);
      if (!it) { renderAll(); return; }
      if (ed.field !== 'text') v = v.replace(/\s*\n+\s*/g, ' ').trim();
      // a brand-new text or note left empty disappears without a trace
      if (ed.fresh && !v.trim() && (it.type === 'text' || (it.type === 'bubble' && !it.title))) { restore(S.undo.pop()); return; }
      if (v !== (it[ed.field] || '')) { if (!ed.touched && !ed.fresh) checkpoint(); it[ed.field] = v; }
      const n = nodes.get(it.id); if (n) n.sig = ''; // repaint from data (the editable may hold stray markup)
      renderItems(); fit(it); renderAll();
      if (v !== ed.orig || ed.fresh || it.h !== ed.h0) changed();
    }
    // Link labels are edited in a small input over the label spot.
    function editLabel(l) {
      endEdit();
      const g = M.linkGeometry(board, l); if (!g) return;
      const inp = document.createElement('input');
      inp.className = 'gdd-inline';
      inp.value = l.label || '';
      inp.placeholder = 'Label';
      inp.maxLength = 80;
      inp.style.left = (g.mid.x * S.view.z + S.view.x) + 'px';
      inp.style.top = (g.mid.y * S.view.z + S.view.y) + 'px';
      stage.append(inp);
      S.label = inp;
      let done = false;
      const fin = ok => {
        if (done) return;
        done = true; S.label = null;
        const v = inp.value.trim();
        inp.remove();
        if (ok && v !== (l.label || '') && board.links.includes(l)) { checkpoint(); l.label = v; renderLinks(); placeBar(); changed(); }
        vp.focus({ preventScroll: true });
      };
      inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') fin(true); else if (e.key === 'Escape') fin(false); });
      inp.addEventListener('blur', () => fin(true));
      inp.focus(); inp.select();
    }

    /* ---------- creating items ---------- */
    function addItem(it, { edit = null, fresh = false, selectAll = false } = {}) {
      insert([it]);
      S.sel = new Set([it.id]); S.link = null;
      renderAll();
      if (FITS[it.type] && fit(it)) renderAll();
      if (edit) startEdit(it, edit, { fresh, selectAll });
      changed();
      return it;
    }
    function newNoteAt(p, text = '') {
      checkpoint();
      const it = M.newItem('bubble', { style: S.noteStyle, text, x: snap(p.x - 120), y: snap(p.y - 75) }, board.style);
      if (it.style === 'speech') it.tail = defaultTail(it);
      return addItem(it, { edit: text ? null : 'text', fresh: !text });
    }
    // r: the dragged rectangle, or null for a plain click at p.
    function createAt(tool, r, p) {
      checkpoint();
      const at = (w, h) => r ? { x: snap(r.x), y: snap(r.y), w: Math.max(40, Math.round(r.w)), h: Math.max(30, Math.round(r.h)) } : { x: snap(p.x - w / 2), y: snap(p.y - h / 2), w, h };
      let it, edit = null, fresh = false, selectAll = false;
      if (tool === 'frame') {
        it = M.newItem('frame', r ? { ...at(720, 480), w: Math.max(160, Math.round(r.w)), h: Math.max(100, Math.round(r.h)) } : { x: snap(p.x), y: snap(p.y) }, board.style);
        edit = 'title'; selectAll = true;
      } else if (tool === 'text') {
        it = M.newItem('text', r ? { x: snap(r.x), y: snap(r.y), w: Math.max(80, Math.round(r.w)) } : { x: snap(p.x - 4), y: snap(p.y - 20) }, board.style);
        edit = 'text'; fresh = true;
      } else if (tool === 'note') {
        it = M.newItem('bubble', { style: S.noteStyle, ...at(240, 150) }, board.style);
        if (it.style === 'speech') it.tail = defaultTail(it);
        edit = 'text'; fresh = true;
      } else {
        const [w, h] = SHAPE_SIZE[S.shape] || [160, 120];
        it = M.newItem('shape', { shape: S.shape, ...at(w, h) }, board.style);
      }
      setTool('select');
      addItem(it, { edit, fresh, selectAll });
    }
    // A new item of the same kind as src (for connected "+" adds).
    function cloneLike(src) {
      if (src.type === 'shape') return M.newItem('shape', { shape: src.shape, fill: src.fill, stroke: src.stroke, strokeWidth: src.strokeWidth, dash: src.dash, size: src.size, font: src.font, color: src.color, w: src.w, h: src.h }, board.style);
      if (src.type === 'bubble') return M.newItem('bubble', { style: src.style === 'speech' ? 'card' : src.style, color: src.color, size: src.size, font: src.font, w: src.w }, board.style);
      if (src.type === 'text') return M.newItem('text', { size: src.size, weight: src.weight, font: src.font, color: src.color, w: src.w }, board.style);
      return M.newItem('bubble', { style: S.noteStyle === 'speech' ? 'sticky' : S.noteStyle }, board.style);
    }
    function quickAdd(src, side, p) {
      if (!src) return;
      checkpoint();
      const n = cloneLike(src), gap = 110;
      if (p) { n.x = snap(p.x - n.w / 2); n.y = snap(p.y - n.h / 2); }
      else {
        const cx = src.x + src.w / 2, cy = src.y + src.h / 2;
        if (side === 'e') { n.x = src.x + src.w + gap; n.y = cy - n.h / 2; }
        else if (side === 'w') { n.x = src.x - gap - n.w; n.y = cy - n.h / 2; }
        else if (side === 'n') { n.x = cx - n.w / 2; n.y = src.y - gap - n.h; }
        else { n.x = cx - n.w / 2; n.y = src.y + src.h + gap + (src.type === 'image' && src.caption ? 40 : 0); }
        n.x = snap(n.x); n.y = snap(n.y);
      }
      board.links.push(M.newLink({ item: src.id }, { item: n.id }, { ...S.linkStyle }));
      addItem(n, { edit: 'text', fresh: n.type !== 'shape' });
    }

    /* ---------- pointer gestures ---------- */
    function isDouble(e) {
      const now = performance.now(), L = S.lastDown;
      const d = !!L && now - L.t < 420 && Math.hypot(e.clientX - L.x, e.clientY - L.y) < 6;
      S.lastDown = d ? null : { t: now, x: e.clientX, y: e.clientY };
      return d;
    }
    function begin(e, g) {
      g.moved = false; g.pid = e.pointerId; g.c0 = [e.clientX, e.clientY]; g.rect = vp.getBoundingClientRect(); g.target ??= null;
      S.g = g;
      try { vp.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      if (g.kind === 'pan') root.classList.add('panning');
    }
    function onDown(e) {
      closePop();
      if (S.label) S.label.blur();
      if (S.edit) { if (S.edit.el.contains(e.target)) return; endEdit(); }
      if (S.g) return;
      const chip = e.target.closest('.gi-chip');
      if (chip && e.button === 0) {
        e.preventDefault();
        const id = chip.closest('.gi').dataset.i;
        select([id]); taskPop(id, chip);
        return;
      }
      vp.focus({ preventScroll: true });
      if (e.button === 1 || (e.button === 0 && (S.space || S.tool === 'hand'))) {
        e.preventDefault();
        return begin(e, { kind: 'pan', v: { ...S.view } });
      }
      if (e.button !== 0) return;
      e.preventDefault();
      const p = toWorld(e), dbl = isDouble(e);
      switch (S.tool) {
        case 'select': return downSelect(e, p, dbl);
        case 'pen': begin(e, { kind: 'pen', pts: [[r1(p.x), r1(p.y)]] }); livePen(S.g.pts); return;
        case 'eraser': begin(e, { kind: 'erase', last: p, hit: false }); eraseAt(p); return;
        case 'arrow': case 'line': {
          const src = hitItem(p);
          return begin(e, { kind: 'connect', from: src ? { item: src.id } : { x: r1(p.x), y: r1(p.y) }, src, p0: p, p1: p, line: S.tool === 'line' });
        }
        default: return begin(e, { kind: 'create', tool: S.tool, p0: p, p1: p });
      }
    }
    function downSelect(e, p, dbl) {
      const hd = e.target.closest('[data-h]');
      if (hd) return downHandle(e, p, hd);
      const node = e.target.closest('.gi'), it = node && byId(node.dataset.i);
      const lnk = !it && e.target.closest('[data-link]');
      if (dbl && onDouble(e, p, it, lnk)) return;
      if (lnk) { select([], lnk.dataset.link); return; }
      const frameBody = it?.type === 'frame' && !e.target.closest('.gi-ftitle');
      if (it && !frameBody) {
        const was = S.sel.has(it.id);
        if (e.shiftKey && !was) select([...S.sel, it.id]);
        else if (!was || S.link) select([it.id]);
        return begin(e, { kind: 'move', p0: p, anchor: it, list: null, toggle: e.shiftKey && was, only: !e.shiftKey && was && S.sel.size > 1 ? it.id : null });
      }
      begin(e, { kind: 'marquee', p0: p, p1: p, frame: frameBody ? it : null, add: e.shiftKey, base: new Set(e.shiftKey ? S.sel : []) });
    }
    function downHandle(e, p, hd) {
      const kind = hd.dataset.h, one = selItems()[0];
      if (kind === 'lend') { const l = curLink(); if (l) begin(e, { kind: 'lend', link: l, end: hd.dataset.end, p0: p }); return; }
      if (!one) return;
      if (kind === 'plus') return begin(e, { kind: 'connect', from: { item: one.id }, src: one, side: hd.dataset.side, p0: p, p1: p, line: false });
      if (kind === 'tail') return begin(e, { kind: 'tail', it: one });
      begin(e, { kind: 'resize', it: one, dir: kind, p0: p, o: { x: one.x, y: one.y, w: one.w, h: one.h }, pts: one.points?.map(q => [...q]), tail: one.tail ? { ...one.tail } : null });
    }
    function onDouble(e, p, it, lnk) {
      if (lnk) { const l = board.links.find(x => x.id === lnk.dataset.link); if (l) { select([], l.id); editLabel(l); } return true; }
      if (!it) { newNoteAt(p); return true; }
      if (it.type === 'frame') {
        if (e.target.closest('.gi-ftitle')) startEdit(it, 'title', { selectAll: true }); else newNoteAt(p);
        return true;
      }
      if (it.type === 'draw') return false;
      if (it.type === 'image') { startEdit(it, 'caption'); return true; }
      startEdit(it, e.target.closest('.gi-ed')?.dataset.f || 'text');
      return true;
    }
    function resizeBox(o, dir, dx, dy, keep, min) {
      let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
      if (dir.includes('w')) x1 = Math.min(x2 - min, x1 + dx);
      if (dir.includes('e')) x2 = Math.max(x1 + min, x2 + dx);
      if (dir.includes('n')) y1 = Math.min(y2 - min, y1 + dy);
      if (dir.includes('s')) y2 = Math.max(y1 + min, y2 + dy);
      let w = x2 - x1, h = y2 - y1;
      if (keep && o.w > 0 && o.h > 0) {
        const r = o.w / o.h;
        if (dir.length === 2) { if (w / h > r) w = h * r; else h = w / r; }
        else if (dir === 'e' || dir === 'w') h = w / r;
        else w = h * r;
        x1 = dir.includes('w') ? o.x + o.w - w : (dir === 'n' || dir === 's') ? o.x + (o.w - w) / 2 : o.x;
        y1 = dir.includes('n') ? o.y + o.h - h : (dir === 'e' || dir === 'w') ? o.y + (o.h - h) / 2 : o.y;
      }
      return { x: Math.round(x1), y: Math.round(y1), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
    }
    function hover(p) {
      const want = (S.tool === 'arrow' || S.tool === 'line') ? hitItem(p)?.id || null : null;
      if (want !== S.hover) { S.hover = want; renderUI(); }
    }
    function onMove(e) {
      const g = S.g;
      if (!g) { const p = toWorld(e); S.pointer = p; hover(p); return; }
      if (e.pointerId !== g.pid) return;
      const p = toWorld(e, g.rect);
      S.pointer = p;
      if (!g.moved) {
        const far = Math.hypot(e.clientX - g.c0[0], e.clientY - g.c0[1]) >= 4;
        if (!far && g.kind !== 'pen' && g.kind !== 'erase' && g.kind !== 'pan') return;
        g.moved = true;
        bar.hidden = true; closePop();
        if (['move', 'resize', 'tail', 'lend'].includes(g.kind)) checkpoint();
      }
      switch (g.kind) {
        case 'pan':
          S.view.x = g.v.x + e.clientX - g.c0[0]; S.view.y = g.v.y + e.clientY - g.c0[1];
          applyView(); break;
        case 'move': {
          if (!g.list) g.list = moving(S.sel).map(i => [i, i.x, i.y]);
          let dx = p.x - g.p0.x, dy = p.y - g.p0.y;
          if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
          const a = g.list.find(r => r[0] === g.anchor) || g.list[0];
          if (a) { dx = snap(a[1] + dx) - a[1]; dy = snap(a[2] + dy) - a[2]; }
          for (const [i, x, y] of g.list) { i.x = x + dx; i.y = y + dy; placeNode(i); }
          renderLinks(); renderUI(); break;
        }
        case 'marquee': {
          g.p1 = p;
          const r = rectOf(g.p0, p);
          const hits = board.items.filter(i => i.type === 'frame' ? contains(r, i) : M.overlaps(r, i)).map(i => i.id);
          S.sel = new Set([...g.base, ...hits]);
          if (S.link) { S.link = null; renderLinks(); }
          renderUI(); break;
        }
        case 'resize': {
          const it = g.it, keep = it.type === 'image' ? !e.shiftKey : e.shiftKey;
          const min = it.type === 'frame' ? 120 : it.type === 'draw' ? 4 : 16;
          const b = resizeBox(g.o, g.dir, p.x - g.p0.x, p.y - g.p0.y, keep, min);
          if (board.style.snap && !keep) {
            let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
            if (g.dir.includes('w')) x1 = snap(x1);
            if (g.dir.includes('e')) x2 = snap(x2);
            if (g.dir.includes('n')) y1 = snap(y1);
            if (g.dir.includes('s')) y2 = snap(y2);
            if (x2 - x1 >= min && y2 - y1 >= min) Object.assign(b, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
          }
          Object.assign(it, b);
          if (it.type === 'draw' && g.pts) {
            const sx = g.o.w > 1 ? b.w / g.o.w : 1, sy = g.o.h > 1 ? b.h / g.o.h : 1;
            it.points = g.pts.map(([a, c]) => [r1(a * sx), r1(c * sy)]);
          }
          if (g.tail) it.tail = { x: g.o.x + g.tail.x - b.x, y: g.o.y + g.tail.y - b.y }; // the tip stays put
          syncItem(it);
          if (it.type === 'text' && fit(it)) syncItem(it);
          renderLinks(); renderUI(); break;
        }
        case 'tail':
          g.it.tail = { x: Math.round(p.x - g.it.x), y: Math.round(p.y - g.it.y) };
          syncItem(g.it); renderUI(); break;
        case 'lend': {
          const other = g.link[g.end === 'from' ? 'to' : 'from'];
          const t = hitItem(p);
          g.target = t && t.id !== other.item ? t : null;
          g.link[g.end] = g.target ? { item: g.target.id } : { x: r1(p.x), y: r1(p.y) };
          renderLinks(); renderUI(); break;
        }
        case 'connect':
          g.p1 = p;
          g.target = hitItem(p, g.src?.id);
          liveLink(g.from, g.target ? { item: g.target.id } : { x: p.x, y: p.y }, g.line);
          renderUI(); break;
        case 'create': g.p1 = p; renderUI(); break;
        case 'pen': {
          const evs = e.getCoalescedEvents?.() || [];
          for (const ev of evs.length ? evs : [e]) {
            const qp = toWorld(ev, g.rect), last = g.pts[g.pts.length - 1];
            if (Math.hypot(qp.x - last[0], qp.y - last[1]) * S.view.z >= 1.5) g.pts.push([r1(qp.x), r1(qp.y)]);
          }
          livePen(g.pts); break;
        }
        case 'erase': {
          const d = Math.hypot(p.x - g.last.x, p.y - g.last.y), steps = Math.max(1, Math.ceil(d * S.view.z / 4));
          for (let k = 1; k <= steps; k++) eraseAt({ x: g.last.x + (p.x - g.last.x) * k / steps, y: g.last.y + (p.y - g.last.y) * k / steps });
          g.last = p; break;
        }
      }
    }
    function onUp(e) {
      const g = S.g;
      if (!g || e.pointerId !== g.pid) return;
      S.g = null;
      root.classList.remove('panning');
      try { if (vp.hasPointerCapture(e.pointerId)) vp.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      const p = e.type === 'pointerup' ? toWorld(e, g.rect) : (g.p1 || g.p0 || { x: 0, y: 0 });
      clearLive();
      switch (g.kind) {
        case 'move':
          if (g.moved) changed();
          else if (g.toggle) S.sel.delete(g.anchor.id);
          else if (g.only) S.sel = new Set([g.only]);
          break;
        case 'marquee':
          if (!g.moved) {
            if (g.frame) { if (e.shiftKey && S.sel.has(g.frame.id)) S.sel.delete(g.frame.id); else S.sel = new Set(e.shiftKey ? [...S.sel, g.frame.id] : [g.frame.id]); }
            else if (!g.add) S.sel = new Set();
            S.link = null;
          }
          break;
        case 'resize':
          if (g.moved) { if (FITS[g.it.type]) fit(g.it); changed(); }
          break;
        case 'tail': case 'lend':
          if (g.moved) changed();
          break;
        case 'connect': finishConnect(g, p); break;
        case 'create': {
          const r = g.moved ? rectOf(g.p0, p) : null;
          createAt(g.tool, r && r.w * S.view.z > 10 && (g.tool === 'text' || r.h * S.view.z > 10) ? r : null, g.p0);
          return;
        }
        case 'pen': finishPen(g); break;
        case 'erase': if (g.hit) changed(); break;
      }
      S.hover = null;
      renderAll();
    }
    function finishConnect(g, p) {
      const mk = to => M.newLink(g.from, to, { ...S.linkStyle, end: g.line ? 'none' : 'arrow' });
      const fromTool = !g.side;
      if (!g.moved) { if (g.side) quickAdd(g.src, g.side); return; }
      if (g.target) {
        checkpoint();
        const l = mk({ item: g.target.id });
        board.links.push(l);
        S.sel = new Set(); S.link = l.id;
        changed();
      } else if (g.side) { quickAdd(g.src, g.side, p); return; }
      else if (Math.hypot(p.x - g.p0.x, p.y - g.p0.y) * S.view.z > 12) {
        checkpoint();
        const l = mk({ x: r1(p.x), y: r1(p.y) });
        board.links.push(l);
        S.sel = new Set(); S.link = l.id;
        changed();
      }
      if (fromTool) setTool('select');
    }
    function finishPen(g) {
      if (!g.pts.length) return;
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const [a, b] of g.pts) { x1 = Math.min(x1, a); y1 = Math.min(y1, b); x2 = Math.max(x2, a); y2 = Math.max(y2, b); }
      checkpoint();
      board.items.push(M.newItem('draw', {
        x: r1(x1), y: r1(y1), w: Math.max(1, r1(x2 - x1)), h: Math.max(1, r1(y2 - y1)),
        points: g.pts.map(([a, b]) => [r1(a - x1), r1(b - y1)]),
        color: S.pen.color, width: S.pen.width, highlight: !!S.pen.highlight,
      }, board.style));
      changed();
    }
    function eraseAt(p) {
      const tol = 6 / S.view.z;
      const hit = board.items.filter(i => i.type === 'draw' && nearStroke(i, p, tol));
      if (!hit.length) return;
      if (S.g && !S.g.hit) { checkpoint(); S.g.hit = true; }
      const ids = new Set(hit.map(i => i.id));
      board.items = board.items.filter(i => !ids.has(i.id));
      ids.forEach(id => S.sel.delete(id));
      renderItems();
    }

    /* ---------- style bar ---------- */
    const btn = (a, content, tip, { v = '', on = false, cls = '' } = {}) =>
      `<button class="gb${cls ? ' ' + cls : ''}${on ? ' on' : ''}" data-a="${a}" data-v="${E(v)}" data-tip="${E(tip)}" aria-label="${E(tip)}">${content}</button>`;
    const SEP = '<span class="gb-sep"></span>';
    const dotOf = c => `<span class="gb-dot${c ? '' : ' none'}" style="--c:${c || 'transparent'}"></span>`;
    const letterOf = c => `<span class="gb-letter">${icon('letter')}<i style="background:${c}"></i></span>`;
    const sizeCtl = it => btn('size', icon('minus'), 'Smaller text', { v: -1 }) + `<span class="gb-val">${it.size}</span>` + btn('size', icon('plus'), 'Bigger text', { v: 1 });
    function itemBar(items) {
      const it = items[0], t = items.every(i => i.type === it.type) ? it.type : null, bg = bgKey();
      let h = '';
      if (t === 'frame') h += btn('pop', dotOf(M.fillOf(it.color)), 'Section color', { v: 'fill' }) + btn('edit', icon('edit'), 'Rename (Enter)');
      if (t === 'bubble') {
        h += btn('pop', dotOf(M.fillOf(it.color)), 'Note color', { v: 'fill' }) + SEP
          + M.BUBBLE_STYLES.map(s => btn('bstyle', icon(s), cap(s) + (s === 'speech' ? ' bubble' : ' note'), { v: s, on: it.style === s })).join('') + SEP
          + btn('btitle', icon('heading'), it.title ? 'Remove title' : 'Add a title', { on: !!it.title }) + sizeCtl(it)
          + btn('pop', 'Aa', 'Font', { v: 'font', cls: 'txt' });
      }
      if (t === 'shape') {
        h += btn('pop', dotOf(M.fillOf(it.fill)), 'Fill', { v: 'fill' })
          + btn('pop', icon('outline'), 'Outline', { v: 'stroke', on: !!it.strokeWidth })
          + btn('pop', shapeIcon(it.shape), 'Shape', { v: 'shape' }) + SEP + sizeCtl(it)
          + btn('pop', 'Aa', 'Font', { v: 'font', cls: 'txt' })
          + btn('pop', letterOf(it.color ? M.inkOf(it.color, bg) : M.textOn(it.fill, bg)), 'Text color', { v: 'ink' });
      }
      if (t === 'text') {
        const next = { left: 'center', center: 'right', right: 'left' }[it.align] || 'center';
        h += btn('pop', letterOf(M.inkOf(it.color, bg)), 'Text color', { v: 'ink' }) + sizeCtl(it)
          + btn('bold', icon('bold'), 'Bold', { on: it.weight >= 600 })
          + btn('pop', 'Aa', 'Font', { v: 'font', cls: 'txt' })
          + btn('align', icon(it.align in P ? it.align : 'left'), `Align ${next}`, { v: next });
      }
      if (t === 'image') {
        h += btn('pop', icon('border') + 'Border', 'Image border', { v: 'border', cls: 'txt' })
          + btn('fit', it.fit === 'contain' ? 'Fit' : 'Fill', it.fit === 'contain' ? 'Whole image shown (click to fill the box)' : 'Image fills the box (click to show it whole)', { cls: 'txt' })
          + btn('caption', icon('caption'), 'Caption (double-click)');
      }
      if (t === 'draw') {
        h += btn('pop', dotOf(M.inkOf(it.color, bg)), 'Color', { v: 'ink' })
          + PEN_WIDTHS.map(w => btn('dwidth', `<span class="gb-wd" style="--d:${clamp(w, 3, 14)}px"></span>`, `Width ${w}`, { v: w, on: +it.width === w })).join('')
          + btn('hl', icon('marker'), 'Highlighter', { on: !!it.highlight });
      }
      if (h) h += SEP;
      h += btn('front', icon('up'), 'Bring to front ( ] )') + btn('back', icon('down'), 'Send to back ( [ )') + btn('dup', icon('copy'), 'Duplicate (Ctrl+D)');
      if (t !== 'draw') {
        h += SEP + btn('task', icon('checksq') + (items.length > 1 ? `Make ${items.length} tasks` : 'Make task'), 'Create a ForkPad task from this', { cls: 'txt' });
        const ts = items.length === 1 ? taskMap.get(it.id) : null;
        if (ts?.length) h += btn('tasks', `${ts.filter(x => x.status === 'done').length}/${ts.length}`, 'Linked tasks', { cls: 'txt chip' });
      }
      return h + btn('del', icon('trash'), 'Delete (Del)', { cls: 'danger' });
    }
    function linkBar(l) {
      return ['straight', 'curve', 'elbow'].map(r => btn('route', icon(r), cap(r), { v: r, on: (l.route || 'straight') === r })).join('') + SEP
        + btn('head', headIcon(l.start, true), `Start: ${l.start} (click to change)`, { v: 'start' })
        + btn('head', headIcon(l.end), `End: ${l.end} (click to change)`, { v: 'end' })
        + btn('swap', icon('swap'), 'Reverse direction') + SEP
        + btn('ldash', icon('dash'), 'Dashed', { on: !!l.dash })
        + btn('pop', `<span class="gb-lw" style="--d:${clamp(+l.width || 2, 1, 8)}px"></span>`, 'Line width', { v: 'lwidth' })
        + btn('pop', dotOf(M.inkOf(l.color, bgKey())), 'Color', { v: 'ink' })
        + btn('label', icon('text') + (l.label ? 'Edit label' : 'Label'), 'Label (double-click the line)', { cls: 'txt' }) + SEP
        + btn('del', icon('trash'), 'Delete (Del)', { cls: 'danger' });
    }
    function renderBar() {
      const items = selItems(), l = curLink();
      const show = S.tool === 'select' && !(S.g && S.g.moved) && (items.length > 0 || !!l);
      if (!show) { bar.hidden = true; if (S.pop?.name !== 'tasks') closePop(); return; }
      bar.innerHTML = l ? linkBar(l) : itemBar(items);
      bar.hidden = false;
      placeBar();
      refreshPop();
    }
    function placeBar() {
      if (bar.hidden) return;
      const l = curLink();
      let b;
      if (l) { const g = M.linkGeometry(board, l); if (g) b = M.unionBounds([g.a, g.b, g.mid].map(p => ({ x: p.x, y: p.y, w: 0, h: 0 }))); }
      else b = M.unionBounds(selItems());
      if (!b) return;
      const W = stage.clientWidth, H = stage.clientHeight, bw = bar.offsetWidth, bh = bar.offsetHeight, z = S.view.z;
      const one = !l && S.sel.size === 1 ? selItems()[0] : null;
      const gap = one && one.type !== 'frame' && one.type !== 'draw' ? 44 : 14;
      const top = b.y * z + S.view.y, bottom = (b.y + b.h) * z + S.view.y, cx = (b.x + b.w / 2) * z + S.view.x;
      let y = top - bh - gap;
      if (y < 8) { y = bottom + gap; if (y > H - bh - 8) y = 8; }
      const x = clamp(cx - bw / 2, 8, Math.max(8, W - bw - 8));
      bar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }

    /* ---------- popovers ---------- */
    function openPop(name, anchor, html) {
      S.pop = { name };
      pop.innerHTML = html;
      pop.hidden = false;
      placePop(anchor);
    }
    function placePop(anchor) {
      if (!anchor || pop.hidden) return;
      const sr = stage.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
      const pw = pop.offsetWidth, ph = pop.offsetHeight;
      const x = clamp(ar.left - sr.left + ar.width / 2 - pw / 2, 8, Math.max(8, sr.width - pw - 8));
      let y = ar.bottom - sr.top + 8;
      if (y + ph > sr.height - 8) y = Math.max(8, ar.top - sr.top - ph - 8);
      pop.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
    function closePop() {
      if (!S.pop) return;
      S.pop = null;
      pop.hidden = true;
      pop.innerHTML = '';
    }
    function togglePop(name, anchor) {
      if (S.pop?.name === name) return closePop();
      const h = popHTML(name);
      if (h) openPop(name, anchor, h);
    }
    // Rebuild an open popover after a change, unless its color picker is in use.
    function refreshPop() {
      if (!S.pop || S.pop.name === 'tasks') return;
      const a = document.activeElement;
      if (a && pop.contains(a) && a.type === 'color') return;
      const h = popHTML(S.pop.name);
      if (!h) return closePop();
      pop.innerHTML = h;
      placePop(bar.querySelector(`[data-a="pop"][data-v="${S.pop.name}"]`));
    }
    function popHTML(name) {
      const it = selItems()[0], l = curLink(), B = BG();
      const sw = (a, v, color, on, label, cls = '') => `<button class="gp-sw${cls}${on ? ' on' : ''}" data-a="${a}" data-v="${E(v)}" style="--c:${color}" title="${E(label)}" aria-label="${E(label)}"></button>`;
      const custom = (a, cur) => `<label class="gp-sw gp-custom" title="Custom color">${icon('plus')}<input type="color" data-a="${a}" value="${hex6(cur)}"></label>`;
      const row = (label, inner) => `<div class="gp-label">${label}</div><div class="gp-row">${inner}</div>`;
      const chip = (a, v, label, on) => `<button class="gp-chip${on ? ' on' : ''}" data-a="${a}" data-v="${E(v)}">${label}</button>`;
      const step = (a, val) => `<span class="gp-step"><button data-a="${a}" data-v="-1" aria-label="Less">${icon('minus')}</button><b>${val}</b><button data-a="${a}" data-v="1" aria-label="More">${icon('plus')}</button></span>`;
      switch (name) {
        case 'fill': {
          if (!it) return '';
          const cur = it.type === 'shape' ? it.fill : it.color;
          let h = M.PALETTE_NAMES.map(n => sw('fill', n, M.PALETTE[n].fill, cur === n, cap(n))).join('');
          if (it.type === 'shape') h = sw('fill', 'none', 'transparent', !cur, 'No fill', ' none') + h;
          return row(it.type === 'frame' ? 'Section color' : it.type === 'shape' ? 'Fill' : 'Note color', h + custom('fill', M.fillOf(cur)));
        }
        case 'ink': {
          const cur = l ? l.color : it?.color;
          if (!l && !it) return '';
          const h = sw('ink', '', B.ink, !cur, 'Auto (follows the canvas)', ' auto') + M.INKS.map(c => sw('ink', c, c, String(cur).toLowerCase() === c, c)).join('');
          return row('Color', h + custom('ink', cur || B.ink));
        }
        case 'stroke': {
          if (it?.type !== 'shape') return '';
          const sw0 = +it.strokeWidth || 0;
          return row('Outline color', sw('stroke', 'none', 'transparent', !sw0, 'No outline', ' none') + M.INKS.map(c => sw('stroke', c, c, sw0 > 0 && String(it.stroke).toLowerCase() === c, c)).join('') + custom('stroke', it.stroke || B.ink))
            + row('Width', [1, 2, 4, 6, 8].map(w => chip('swidth', w, w, sw0 === w)).join('') + chip('sdash', '', icon('dash') + 'Dashed', !!it.dash));
        }
        case 'shape':
          return `<div class="gp-grid">${M.SHAPES.map(s => `<button class="gp-item${it?.shape === s ? ' on' : ''}" data-a="shape" data-v="${s}" title="${M.SHAPE_NAMES[s]}" aria-label="${M.SHAPE_NAMES[s]}">${shapeIcon(s)}</button>`).join('')}</div>`;
        case 'font':
          return Object.keys(FONT_NAMES).map(f => `<button class="gp-line${it?.font === f ? ' on' : ''}" data-a="font" data-v="${f}" style="font-family:${E(M.FONTS[f])}">${FONT_NAMES[f]}</button>`).join('');
        case 'lwidth':
          return LINK_WIDTHS.map(w => `<button class="gp-line${+l?.width === w ? ' on' : ''}" data-a="lwidth" data-v="${w}"><span class="gb-lw wide" style="--d:${w}px"></span>${w}px</button>`).join('');
        case 'border': {
          if (it?.type !== 'image') return '';
          const b = it.border || M.BORDER_PRESETS.none;
          const tile = pb => {
            const bw = Math.min(pb.width, 4);
            const css = pb.style === 'polaroid' ? `background:${pb.color};padding:3px 3px 8px;border-radius:2px`
              : pb.style === 'none' ? 'border-radius:3px' : `border:${Math.max(1, bw)}px ${pb.style} ${pb.color};border-radius:${Math.round(pb.radius / 2.5)}px`;
            return `<i class="gp-bpi" style="${css}"><u></u></i>`;
          };
          const presets = Object.entries(M.BORDER_PRESETS).map(([k, pb]) => `<button class="gp-bp${sameBorder(b, pb) ? ' on' : ''}" data-a="bpreset" data-v="${k}">${tile(pb)}<span>${cap(k)}</span></button>`).join('');
          const colors = ['#ffffff', ...M.INKS].map(c => sw('bcolor', c, c, String(b.color).toLowerCase() === c, c)).join('') + custom('bcolor', b.color);
          const isDef = sameBorder(b, board.style.imageBorder);
          return `<div class="gp-label">Presets</div><div class="gp-bps">${presets}</div>`
            + row('Style', ['solid', 'dashed', 'polaroid', 'none'].map(s => chip('bkind', s, cap(s), b.style === s)).join(''))
            + row('Color', colors)
            + `<div class="gp-steps"><label>Width ${step('bwidth', +b.width || 0)}</label><label>Corners ${step('bradius', +b.radius || 0)}</label></div>`
            + `<div class="gp-foot"><button class="btn sm${isDef ? ' ghost' : ' primary'}" data-a="bdefault"${isDef ? ' disabled' : ''}>${isDef ? icon('check') + 'Default for new images' : 'Set as default'}</button>`
            + `<button class="btn sm" data-a="ball">Apply to all images</button></div>`;
        }
      }
      return '';
    }
    function taskPop(id, anchor) {
      const ts = taskMap.get(id) || [];
      const st = { todo: 'To do', doing: 'In progress', done: 'Done' };
      const list = ts.length
        ? ts.map(t => `<button class="gp-task ${E(t.status)}" data-a="opentask" data-v="${E(t.id)}"><i></i><span>${E(t.title)}</span><em>${st[t.status] || ''}</em></button>`).join('')
        : '<div class="gp-empty">No linked tasks yet</div>';
      openPop('tasks', anchor, `<div class="gp-label">Linked tasks</div>${list}<div class="gp-foot"><button class="btn sm" data-a="task">${icon('plus')}New task from this</button></div>`);
    }

    /* ---------- style actions ---------- */
    function apply(fn, key) {
      endEdit();
      const list = selItems();
      if (!list.length) return;
      checkpoint(key);
      list.forEach(fn);
      renderItems();
      list.forEach(fit);
      renderAll();
      changed();
    }
    function applyLink(fn, key) {
      endEdit();
      const l = curLink();
      if (!l) return;
      checkpoint(key);
      fn(l);
      // new connectors reuse the look of the last edited one
      S.linkStyle = { route: l.route, width: l.width, dash: l.dash, color: l.color };
      saveTools();
      renderAll();
      changed();
    }
    const stepSize = (it, d) => {
      const list = it.type === 'text' ? TEXT_SIZES : NOTE_SIZES;
      return d > 0 ? list.find(s => s > it.size) ?? it.size : [...list].reverse().find(s => s < it.size) ?? it.size;
    };
    const ACT = {
      pop: (v, b) => togglePop(v, b),
      fill: (v, b, live) => {
        apply(it => {
          if (it.type === 'shape') { it.fill = v === 'none' ? null : v; if (!it.fill && !+it.strokeWidth) it.strokeWidth = 2; }
          else if (it.type === 'bubble' || it.type === 'frame') {
            it.color = v;
            if (it.type === 'bubble') board.style.bubbleColor = v; // next notes use the last picked color
          }
        }, 'fill');
        if (!live) closePop();
      },
      ink: (v, b, live) => {
        const c = v || null;
        if (S.link) applyLink(l => { l.color = c; }, 'ink');
        else apply(it => { if (it.type === 'text' || it.type === 'shape' || it.type === 'draw') it.color = c; }, 'ink');
        if (!live) closePop();
      },
      stroke: v => apply(it => { if (v === 'none') { it.stroke = null; it.strokeWidth = 0; } else { it.stroke = v; if (!+it.strokeWidth) it.strokeWidth = 2; } }, 'stroke'),
      swidth: v => apply(it => { it.strokeWidth = +v; }),
      sdash: () => apply(it => { it.dash = !it.dash; if (!+it.strokeWidth) it.strokeWidth = 2; }),
      size: v => apply(it => { it.size = stepSize(it, +v); }, 'size'),
      bold: () => { const on = !(selItems()[0]?.weight >= 600); apply(it => { it.weight = on ? 700 : 400; }); },
      font: v => { apply(it => { it.font = v; }); closePop(); },
      align: v => apply(it => { it.align = v; }),
      bstyle: v => apply(it => { it.style = v; if (v === 'speech' && !it.tail) it.tail = defaultTail(it); }),
      btitle: () => { const it = selItems()[0]; if (!it) return; if (it.title) apply(i => { i.title = ''; }); else startEdit(it, 'title'); },
      shape: v => { apply(it => { it.shape = v; }); S.shape = v; saveTools(); closePop(); },
      bpreset: v => apply(it => { it.border = { ...M.BORDER_PRESETS[v] }; }),
      bkind: v => apply(it => { const b = { ...it.border, style: v }; if (v !== 'none' && !+b.width) b.width = v === 'polaroid' ? 12 : 3; it.border = b; }),
      bcolor: v => apply(it => { const b = { ...it.border, color: v }; if (b.style === 'none') { b.style = 'solid'; b.width = Math.max(2, +b.width || 0); } it.border = b; }, 'bcolor'),
      bwidth: v => apply(it => {
        const b = { ...it.border }, w = +b.width || 0;
        b.width = clamp(w + (+v) * (w >= 8 ? 2 : 1), 0, 40);
        if (b.style === 'none' && b.width) b.style = 'solid';
        if (!b.width) b.style = 'none';
        it.border = b;
      }, 'bwidth'),
      bradius: v => apply(it => { it.border = { ...it.border, radius: clamp((+it.border.radius || 0) + (+v) * 4, 0, 80) }; }, 'bradius'),
      bdefault: () => {
        const it = selItems()[0]; if (!it?.border) return;
        checkpoint(); board.style.imageBorder = { ...it.border };
        changed(); renderBar(); say('New images will use this border');
      },
      ball: () => {
        const it = selItems()[0]; if (!it?.border) return;
        const imgs = board.items.filter(i => i.type === 'image');
        checkpoint(); imgs.forEach(i => { i.border = { ...it.border }; });
        renderAll(); changed(); say(`Border applied to ${imgs.length} image${imgs.length === 1 ? '' : 's'}`);
      },
      fit: () => apply(it => { it.fit = it.fit === 'contain' ? 'cover' : 'contain'; }),
      caption: () => { const it = selItems()[0]; if (it) startEdit(it, 'caption'); },
      edit: () => { const it = selItems()[0]; if (it) startEdit(it, it.type === 'frame' ? 'title' : 'text', { selectAll: it.type === 'frame' }); },
      dwidth: v => apply(it => { it.width = +v; }),
      hl: () => { const on = !selItems()[0]?.highlight; apply(it => { it.highlight = on; }); },
      front: () => reorder(true),
      back: () => reorder(false),
      dup: () => duplicate(),
      del: () => deleteSel(),
      task: () => { closePop(); makeTasks(); },
      tasks: (v, b) => { const it = selItems()[0]; if (it) { if (S.pop?.name === 'tasks') closePop(); else taskPop(it.id, b); } },
      opentask: v => { closePop(); const t = [...taskMap.values()].flat().find(x => x.id === v); if (t) host.openTask(t); },
      route: v => applyLink(l => { l.route = v; }),
      head: v => applyLink(l => { l[v] = { none: 'arrow', arrow: 'dot', dot: 'none' }[l[v]] || 'arrow'; }),
      swap: () => applyLink(l => { [l.from, l.to] = [l.to, l.from]; }),
      ldash: () => applyLink(l => { l.dash = !l.dash; }),
      lwidth: v => { applyLink(l => { l.width = +v; }); closePop(); },
      label: () => { const l = curLink(); if (l) editLabel(l); },
    };
    function onBarClick(e) {
      const b = e.target.closest('[data-a]');
      if (!b || b.tagName === 'INPUT' || b.disabled) return;
      ACT[b.dataset.a]?.(b.dataset.v, b, false);
    }
    // Keep focus where it is (for example in text being edited) when using the bar.
    const keepFocus = e => { if (!e.target.closest('input')) e.preventDefault(); };

    /* ---------- arranging, deleting, copying ---------- */
    function reorder(front) {
      if (!S.sel.size) return;
      endEdit(); checkpoint();
      const a = board.items.filter(i => S.sel.has(i.id)), rest = board.items.filter(i => !S.sel.has(i.id));
      board.items = front ? [...rest, ...a] : [...a, ...rest];
      renderAll(); changed();
    }
    function deleteSel() {
      endEdit();
      if (S.link) {
        checkpoint();
        board.links = board.links.filter(l => l.id !== S.link);
        S.link = null;
      } else if (S.sel.size) {
        checkpoint();
        const ids = S.sel;
        board.items = board.items.filter(i => !ids.has(i.id));
        board.links = board.links.filter(l => !ids.has(l.from.item) && !ids.has(l.to.item));
        S.sel = new Set();
      } else return;
      closePop(); renderAll(); changed();
    }
    function nudge(dx, dy) {
      if (!S.sel.size) return;
      checkpoint('nudge');
      for (const i of moving(S.sel)) { i.x += dx; i.y += dy; }
      renderAll(); changed();
    }
    // Copy of a selection: frames bring their contents, links come along when their ends do.
    function clipData() {
      const items = moving(S.sel);
      if (!items.length) return null;
      const ids = new Set(items.map(i => i.id));
      const links = board.links.filter(l => (l.from.item || l.to.item) && (!l.from.item || ids.has(l.from.item)) && (!l.to.item || ids.has(l.to.item)));
      return { forkpadGdd: 1, items: structuredClone(items), links: structuredClone(links) };
    }
    function cloneSet(items, links, dx, dy) {
      const map = new Map();
      const outI = items.map(i => { const c = structuredClone(i); c.id = M.uid(); c.x += dx; c.y += dy; map.set(i.id, c.id); return c; });
      const end = e => e.item ? { item: map.get(e.item) } : { x: e.x + dx, y: e.y + dy };
      const outL = links.filter(l => (!l.from.item || map.has(l.from.item)) && (!l.to.item || map.has(l.to.item)))
        .map(l => ({ ...structuredClone(l), id: M.uid(), from: end(l.from), to: end(l.to) }));
      return { items: outI, links: outL };
    }
    function placeClone(c) {
      insert(c.items);
      board.links.push(...c.links);
      S.sel = new Set(c.items.map(i => i.id)); S.link = null;
      renderAll(); changed();
    }
    function duplicate() {
      const d = clipData(); if (!d) return;
      endEdit(); checkpoint();
      placeClone(cloneSet(d.items, d.links, 24, 24));
    }
    const pastePoint = () => S.pointer || viewCenter();
    function pasteData(data) {
      const clean = M.migrate({ items: data.items || [], links: data.links || [] }); // sanitizes foreign input
      if (!clean.items.length) return;
      const b = M.unionBounds(clean.items), at = pastePoint();
      const L = S.lastPaste, k = L && Math.hypot(L.x - at.x, L.y - at.y) < 1 ? L.n + 1 : 0;
      S.lastPaste = { x: at.x, y: at.y, n: k };
      const dx = snap(at.x - (b.x + b.w / 2) + k * 24), dy = snap(at.y - (b.y + b.h / 2) + k * 24);
      endEdit(); checkpoint();
      placeClone(cloneSet(clean.items, clean.links, dx, dy));
    }

    /* ---------- images ---------- */
    const imageSize = url => new Promise(res => {
      const im = new Image();
      im.onload = () => res([im.naturalWidth || 480, im.naturalHeight || 360]);
      im.onerror = () => res([480, 360]);
      im.src = url;
    });
    async function addImages(files, at) {
      const list = [...files].filter(f => f && /^image\//.test(f.type));
      if (!list.length) return;
      const made = [];
      let first = true;
      for (const f of list) {
        let r;
        try { r = await host.addImage(f); } catch (err) { console.error(err); }
        if (!r?.id || S.destroyed) { say('Could not add that image'); continue; }
        if (r.url) urls.set(r.id, r.url);
        let { width: nw, height: nh } = r;
        if (!(nw > 0 && nh > 0)) [nw, nh] = r.url ? await imageSize(r.url) : [480, 360];
        const s = Math.min(1, 480 / Math.max(nw, nh)), w = Math.max(16, Math.round(nw * s)), h = Math.max(16, Math.round(nh * s));
        const k = made.length;
        if (first) { endEdit(); checkpoint(); first = false; }
        const it = M.newItem('image', { imageId: r.id, x: snap(at.x - w / 2 + k * 36), y: snap(at.y - h / 2 + k * 36), w, h, naturalW: nw, naturalH: nh }, board.style);
        board.items.push(it);
        made.push(it.id);
      }
      if (!made.length) return;
      S.sel = new Set(made); S.link = null;
      setTool('select');
      renderAll(); changed();
    }
    function pickImages(at = viewCenter()) {
      const inp = document.getElementById('fileImg');
      if (!inp) return;
      inp.value = '';
      inp.onchange = () => addImages(inp.files, at);
      inp.click();
    }

    /* ---------- tasks ---------- */
    function taskText(it) {
      const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
      const short = (s, n = 110) => s.length > n ? s.slice(0, n - 1) + '…' : s;
      let title = '', body = '';
      if (it.type === 'bubble') { const L = lines(it.text); title = it.title?.trim() || L[0] || 'Note'; body = it.title?.trim() ? it.text : L.slice(1).join('\n'); }
      else if (it.type === 'text' || it.type === 'shape') { const L = lines(it.text); title = L[0] || M.SHAPE_NAMES[it.shape] || 'Text'; body = L.slice(1).join('\n'); }
      else if (it.type === 'image') title = it.caption?.trim() || 'Image';
      else if (it.type === 'frame') {
        title = it.title || 'Section';
        body = M.readingOrder(M.itemsInFrame(board, it)).filter(c => c.type !== 'draw').map(c => '- ' + M.itemLabel(c)).join('\n');
      }
      if (title.length > 110) { body = title + (body ? '\n' + body : ''); title = short(title); }
      const desc = [String(body || '').trim(), `From the GDD board "${board.title}" (${M.itemLabel(it)}).`].filter(Boolean).join('\n\n');
      return { title, desc };
    }
    async function makeTasks() {
      endEdit();
      const list = selItems().filter(i => i.type !== 'draw');
      if (!list.length) return;
      let last = null, n = 0;
      for (const it of list) {
        const { title, desc } = taskText(it);
        let t = null;
        try { t = await host.createTask({ title, desc, projectId: board.projectId || null, gdd: { boardId: board.id, itemId: it.id } }); } catch (err) { console.error(err); }
        if (!t) break;
        last = t; n++;
      }
      if (!n || S.destroyed) return;
      refreshTasks(); renderAll(); syncHead();
      say(n > 1 ? `${n} tasks added` : 'Task added', 'Open', () => host.openTask(last));
    }

    /* ---------- template ---------- */
    function addTemplate() {
      endEdit();
      const t = M.newBoard({ template: 'gdd' });
      const cb = M.contentBounds(board);
      if (cb) {
        const dx = Math.round(cb.x + cb.w + 240), dy = Math.round(cb.y);
        t.items.forEach(i => { i.x += dx; i.y += dy; });
      }
      checkpoint();
      insert(t.items);
      board.links.push(...t.links);
      S.sel = new Set(); S.link = null;
      renderAll();
      t.items.forEach(fit);
      renderAll();
      fitView(M.unionBounds(t.items));
      changed();
      if (cb) say('GDD sections added', 'Undo', undo);
    }

    /* ---------- tools, dock and flyout ---------- */
    function setTool(t) {
      if (t === 'image') { pickImages(); return; }
      if (t === S.tool && t === 'note') S.noteStyle = M.BUBBLE_STYLES[(M.BUBBLE_STYLES.indexOf(S.noteStyle) + 1) % M.BUBBLE_STYLES.length];
      else if (t === S.tool && t === 'shape') S.shape = M.SHAPES[(M.SHAPES.indexOf(S.shape) + 1) % M.SHAPES.length];
      endEdit();
      S.tool = t; S.hover = null;
      root.dataset.tool = t;
      for (const b of dock.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
      saveTools();
      renderFly(); renderUI(); renderBar(); renderLinks();
    }
    function renderFly() {
      const sw = (f, v, c, on, label) => `<button class="gp-sw${on ? ' on' : ''}" data-f="${f}" data-v="${E(v)}" style="--c:${c}" title="${E(label)}" aria-label="${E(label)}"></button>`;
      let h = '';
      if (S.tool === 'note') {
        h = `<div class="gf-row">${M.BUBBLE_STYLES.map(s => `<button class="gb${S.noteStyle === s ? ' on' : ''}" data-f="nstyle" data-v="${s}" title="${cap(s)}">${icon(s)}</button>`).join('')}</div>`
          + `<div class="gf-sws">${M.PALETTE_NAMES.map(n => sw('ncolor', n, M.PALETTE[n].fill, board.style.bubbleColor === n, cap(n))).join('')}</div>`;
      } else if (S.tool === 'shape') {
        h = `<div class="gf-grid">${M.SHAPES.map(s => `<button class="gb${S.shape === s ? ' on' : ''}" data-f="shape" data-v="${s}" title="${M.SHAPE_NAMES[s]}">${shapeIcon(s)}</button>`).join('')}</div>`;
      } else if (S.tool === 'pen') {
        h = `<div class="gf-sws">${M.INKS.map(c => sw('pcolor', c, c, S.pen.color === c, c)).join('')}</div>`
          + `<div class="gf-row">${PEN_WIDTHS.map(w => `<button class="gb${+S.pen.width === w ? ' on' : ''}" data-f="pwidth" data-v="${w}" title="Width ${w}"><span class="gb-wd" style="--d:${clamp(w, 3, 14)}px"></span></button>`).join('')}`
          + `<button class="gb${S.pen.highlight ? ' on' : ''}" data-f="phl" title="Highlighter">${icon('marker')}</button></div>`;
      } else if (S.tool === 'arrow' || S.tool === 'line') {
        h = `<div class="gf-row">${['straight', 'curve', 'elbow'].map(r => `<button class="gb${S.linkStyle.route === r ? ' on' : ''}" data-f="route" data-v="${r}" title="${cap(r)}">${icon(r)}</button>`).join('')}</div>`
          + `<div class="gf-hint">Drag from one item to another</div>`;
      } else if (S.tool === 'eraser') h = '<div class="gf-hint">Drag over doodles to erase them</div>';
      fly.innerHTML = h;
      fly.hidden = !h;
      if (!h) return;
      const b = dock.querySelector(`[data-tool="${S.tool}"]`);
      if (!b) return;
      const sr = stage.getBoundingClientRect(), br = b.getBoundingClientRect(), dr = dock.getBoundingClientRect();
      fly.style.left = Math.round(dr.right - sr.left + 8) + 'px';
      fly.style.top = Math.round(clamp(br.top - sr.top - 6, 8, Math.max(8, sr.height - fly.offsetHeight - 8))) + 'px';
    }
    const FLY = {
      nstyle: v => { S.noteStyle = v; },
      ncolor: v => { checkpoint('ncolor'); board.style.bubbleColor = v; changed(); },
      shape: v => { S.shape = v; },
      pcolor: v => { S.pen.color = v; },
      pwidth: v => { S.pen.width = +v; },
      phl: () => { S.pen.highlight = !S.pen.highlight; },
      route: v => { S.linkStyle.route = v; },
    };

    /* ---------- header ---------- */
    function projOptions() {
      let list = [];
      try { list = host.projects?.() || []; } catch { list = []; }
      projSel.innerHTML = '<option value="">No project</option>' + list.map(p => `<option value="${E(p.id)}">${E(p.name)}</option>`).join('');
      projSel.value = board.projectId || '';
      if (projSel.value !== (board.projectId || '')) projSel.value = '';
    }
    function syncHead() {
      if (document.activeElement !== titleIn) titleIn.value = board.title || '';
      head.querySelector('[data-hb="undo"]').disabled = !S.undo.length;
      head.querySelector('[data-hb="redo"]').disabled = !S.redo.length;
      head.querySelector('[data-hb="snap"]').classList.toggle('on', !!board.style.snap);
      const bgB = head.querySelector('[data-hb="bg"]'), dark = bgKey() === 'dark';
      const want = dark ? 'sun' : 'moon';
      if (bgB.dataset.icon !== want) { bgB.innerHTML = icon(want); bgB.dataset.icon = want; }
      if (document.activeElement !== projSel && projSel.value !== (board.projectId || '')) projOptions();
    }
    function toggleHelp(on = helpEl.hidden) { helpEl.hidden = !on; }
    const HB = {
      back: () => { endEdit(); flush(); host.back(); },
      undo, redo,
      snap: () => { board.style.snap = !board.style.snap; changed(); syncHead(); say(board.style.snap ? 'Snap to grid on' : 'Snap to grid off'); },
      bg: () => { endEdit(); checkpoint(); board.style.background = bgKey() === 'dark' ? 'light' : 'dark'; applyBg(); renderAll(); changed(); },
      template: addTemplate,
      export: () => { endEdit(); flush(); host.exportPNG(board); },
      claude: () => { endEdit(); flush(); host.askClaude(board); },
      help: () => toggleHelp(),
    };

    /* ---------- keyboard & clipboard ---------- */
    // The board takes keys only when it is on screen, no modal is open and nobody is typing.
    const active = () => {
      if (!root.isConnected || S.destroyed || modalOpen()) return false;
      const a = document.activeElement;
      return !a || a === document.body || root.contains(a);
    };
    function onKey(e) {
      if (e.defaultPrevented || !active() || typingIn(document.activeElement)) return;
      // AltGr reports Ctrl+Alt on Windows; treat it as a plain key so '[' and ']' on layouts like Turkish Q still work
      const k = e.key, ctrl = (e.ctrlKey || e.metaKey) && !e.altKey, code = e.code;
      if (k === ' ') { e.preventDefault(); if (!e.repeat && !S.space) { S.space = true; root.classList.add('space'); } return; }
      if (ctrl) {
        let hit = true;
        if (code === 'KeyZ') e.shiftKey ? redo() : undo();
        else if (code === 'KeyY') redo();
        else if (code === 'KeyD') duplicate();
        else if (code === 'KeyA') select(board.items.map(i => i.id));
        else if (code === 'Equal' || code === 'NumpadAdd') zoomBy(1.25);
        else if (code === 'Minus' || code === 'NumpadSubtract') zoomBy(0.8);
        else if (code === 'Digit0' || code === 'Numpad0') fitView();
        else hit = false; // Ctrl+C / X / V arrive as clipboard events
        if (hit) e.preventDefault();
        return;
      }
      if (e.altKey && !e.ctrlKey) return;
      if (e.shiftKey && code === 'Digit1') { e.preventDefault(); fitView(); return; }
      if (e.shiftKey && code === 'Digit0') { e.preventDefault(); zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1); return; }
      const step = e.shiftKey ? 10 : 1;
      switch (k) {
        case 'Escape':
          if (!helpEl.hidden) toggleHelp(false);
          else if (S.pop) closePop();
          else if (S.tool !== 'select') setTool('select');
          else if (S.sel.size || S.link) select([]);
          else return;
          e.preventDefault(); return;
        case 'Delete': case 'Backspace': e.preventDefault(); deleteSel(); return;
        case 'Enter': {
          e.preventDefault();
          const l = curLink();
          if (l) { editLabel(l); return; }
          const it = S.sel.size === 1 && selItems()[0];
          if (it && it.type !== 'draw') startEdit(it, it.type === 'frame' ? 'title' : it.type === 'image' ? 'caption' : 'text', { selectAll: it.type === 'frame' });
          return;
        }
        case 'ArrowLeft': e.preventDefault(); nudge(-step, 0); return;
        case 'ArrowRight': e.preventDefault(); nudge(step, 0); return;
        case 'ArrowUp': e.preventDefault(); nudge(0, -step); return;
        case 'ArrowDown': e.preventDefault(); nudge(0, step); return;
        case ']': e.preventDefault(); reorder(true); return;
        case '[': e.preventDefault(); reorder(false); return;
        case '?': e.preventDefault(); toggleHelp(); return;
      }
      const lk = k.length === 1 ? k.toLocaleLowerCase() : '';
      if (lk === 'g') { e.preventDefault(); HB.snap(); return; }
      const tool = KEYS[lk] || KEYS[lk.toLowerCase()];
      if (tool) { e.preventDefault(); setTool(tool); }
    }
    function onKeyUp(e) { if (e.key === ' ') { S.space = false; root.classList.remove('space'); } }
    function onWinBlur() { S.space = false; root.classList.remove('space'); }
    function onCopy(e, cut) {
      if (!active() || typingIn(document.activeElement) || !S.sel.size) return;
      const d = clipData(); if (!d) return;
      e.preventDefault();
      CLIP = d;
      try { e.clipboardData.setData('text/plain', JSON.stringify(d)); } catch { /* keep the in-window copy */ }
      if (cut) deleteSel();
    }
    const onCopyEv = e => onCopy(e, false), onCutEv = e => onCopy(e, true);
    function onPaste(e) {
      if (!active() || typingIn(document.activeElement)) return;
      const cd = e.clipboardData;
      const files = [...(cd?.items || [])].filter(i => i.kind === 'file' && /^image\//.test(i.type)).map(i => i.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); addImages(files, pastePoint()); return; }
      const txt = cd?.getData('text/plain') || '';
      let data = null;
      if (txt.startsWith('{')) { try { const j = JSON.parse(txt); if (j?.forkpadGdd) data = j; } catch { /* plain text */ } }
      if (!data && !txt && CLIP) data = CLIP;
      if (data) { e.preventDefault(); pasteData(data); return; }
      if (txt.trim()) { e.preventDefault(); newNoteAt(pastePoint(), txt.trim().slice(0, 4000)); }
    }

    /* ---------- wiring ---------- */
    vp.addEventListener('pointerdown', onDown);
    vp.addEventListener('pointermove', onMove);
    vp.addEventListener('pointerup', onUp);
    vp.addEventListener('pointercancel', onUp);
    vp.addEventListener('lostpointercapture', e => { if (S.g && e.pointerId === S.g.pid) onUp(e); });
    vp.addEventListener('pointerleave', () => { if (!S.g) { S.pointer = null; if (S.hover) { S.hover = null; renderUI(); } } });
    vp.addEventListener('wheel', onWheel, { passive: false });
    vp.addEventListener('scroll', () => { vp.scrollTop = 0; vp.scrollLeft = 0; }); // focusing text must never scroll the canvas
    // Drops are caught on the whole stage so the empty-board card and the toolbars take them too.
    stage.addEventListener('dragover', e => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; root.classList.add('drop-on');
    });
    stage.addEventListener('dragleave', e => { if (!stage.contains(e.relatedTarget)) root.classList.remove('drop-on'); });
    stage.addEventListener('drop', e => {
      root.classList.remove('drop-on');
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      addImages(e.dataTransfer.files, toWorld(e));
    });
    for (const x of [bar, pop, fly]) x.addEventListener('pointerdown', keepFocus);
    bar.addEventListener('click', onBarClick);
    pop.addEventListener('click', onBarClick);
    pop.addEventListener('input', e => { const i = e.target.closest('input[data-a]'); if (i) ACT[i.dataset.a]?.(i.value, i, true); });
    fly.addEventListener('click', e => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      FLY[b.dataset.f]?.(b.dataset.v);
      saveTools(); renderFly();
    });
    dock.addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b) { setTool(b.dataset.tool); vp.focus({ preventScroll: true }); } });
    head.addEventListener('click', e => {
      const b = e.target.closest('[data-hb]'); if (!b) return;
      HB[b.dataset.hb]?.();
      if (b.dataset.hb !== 'back' && root.isConnected) vp.focus({ preventScroll: true });
    });
    titleIn.addEventListener('input', () => { board.title = titleIn.value; changed(); });
    titleIn.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); titleIn.blur(); } });
    titleIn.addEventListener('blur', () => { const t = titleIn.value.trim() || 'Untitled GDD'; if (t !== board.title) { board.title = t; changed(); } titleIn.value = t; });
    projSel.addEventListener('pointerenter', () => { if (document.activeElement !== projSel) projOptions(); });
    projSel.addEventListener('change', () => {
      const v = projSel.value || null;
      Promise.resolve(host.setProject(board, v)).catch(err => console.error(err)).finally(() => { if (!S.destroyed) projOptions(); });
    });
    emptyEl.addEventListener('click', e => {
      const b = e.target.closest('[data-e]'); if (!b) return;
      if (b.dataset.e === 'template') addTemplate(); else pickImages();
    });
    q('.gdd-zoom').addEventListener('click', e => {
      const b = e.target.closest('[data-z]'); if (!b) return;
      const z = b.dataset.z;
      if (z === 'in') zoomBy(1.25); else if (z === 'out') zoomBy(0.8); else if (z === 'fit') fitView();
      else zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1);
    });
    helpEl.addEventListener('click', e => { if (e.target === helpEl || e.target.closest('[data-help]')) toggleHelp(false); });
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('copy', onCopyEv);
    document.addEventListener('cut', onCutEv);
    document.addEventListener('paste', onPaste);
    window.addEventListener('blur', onWinBlur);
    const ro = new ResizeObserver(() => { initView(); placeBar(); renderFly(); });
    ro.observe(stage);
    // Task chips refresh when a modal closes (the task modal may have changed a task).
    const modalRoot = document.getElementById('modalRoot');
    const mo = modalRoot ? new MutationObserver(() => { if (!modalRoot.children.length && root.isConnected && refreshTasks()) renderAll(); }) : null;
    mo?.observe(modalRoot, { childList: true });

    /* ---------- first paint ---------- */
    applyBg();
    projOptions();
    refreshTasks();
    renderAll();
    for (const b of dock.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === S.tool);
    initView();
    fitAll(); // connector-made items carry estimated heights
    document.fonts?.ready.then(() => { if (!S.destroyed) fitAll(); });

    /* ---------- controller ---------- */
    return {
      destroy() {
        if (S.destroyed) return;
        endEdit();
        flush();
        saveViewNow();
        S.destroyed = true;
        clearTimeout(saveT);
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('keyup', onKeyUp);
        document.removeEventListener('copy', onCopyEv);
        document.removeEventListener('cut', onCutEv);
        document.removeEventListener('paste', onPaste);
        window.removeEventListener('blur', onWinBlur);
        ro.disconnect();
        mo?.disconnect();
        root.remove();
      },
      flush,
      isBusy,
      get board() { return board; },
      // Called by the app after tasks or projects change (connector writes, task modal, project picker).
      refresh() {
        if (S.destroyed) return;
        if (document.activeElement !== projSel) projOptions(); // rebuilding would close an open dropdown
        if (refreshTasks()) renderAll();
        syncHead();
      },
      reload(fresh) {
        if (S.destroyed || !fresh || S.dirty || isBusy()) return false;
        M.migrate(fresh);
        if (fresh !== board) {
          for (const k of Object.keys(board)) if (!(k in fresh)) delete board[k];
          Object.assign(board, fresh);
        }
        S.undo = []; S.redo = []; S.histKey = null;
        const ids = new Set(board.items.map(i => i.id));
        S.sel = new Set([...S.sel].filter(id => ids.has(id)));
        if (S.link && !board.links.some(l => l.id === S.link)) S.link = null;
        for (const n of nodes.values()) n.sig = '';
        applyBg(); projOptions(); refreshTasks(); renderAll();
        requestAnimationFrame(fitAll);
        return true;
      },
    };
  }

  window.GDD = { mount };
})();
