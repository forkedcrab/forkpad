/* ForkPad GDD boards: the shared data model. Loaded by the app (window.GDDModel) and by the
   Claude connector (require). Pure functions only: no DOM, no storage.
   A board is { id, title, projectId, created, updated, version, style, items, links, previewId, previewAt }.
   items is in z order (last = on top). See PLAN.md for the full contract. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.GDDModel = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- palette & typography ---------- */
  // Named fills for notes, shapes and frames. Each has a readable text color.
  const PALETTE = {
    yellow: { fill: '#f7d774', text: '#2a2111' }, orange: { fill: '#ffb36b', text: '#2b1906' },
    red: { fill: '#ff8a80', text: '#2b0d0a' }, pink: { fill: '#f4a3d7', text: '#2a0d20' },
    purple: { fill: '#b9a6ff', text: '#170f33' }, blue: { fill: '#8cc8ff', text: '#0a1c2e' },
    teal: { fill: '#7fe0c8', text: '#06241d' }, green: { fill: '#a8e08a', text: '#10230a' },
    gray: { fill: '#d9d4ce', text: '#1d1a16' }, white: { fill: '#ffffff', text: '#1d1a16' },
    dark: { fill: '#2b2724', text: '#f3efea' },
  };
  const PALETTE_NAMES = Object.keys(PALETTE);
  // Ink colors for pen strokes, lines, text and borders.
  const INKS = ['#f3efea', '#1d1a16', '#ff8f1f', '#ef5b5b', '#f2c14e', '#7fcf63', '#4fa8ff', '#d16bd6', '#8d8379'];
  const BACKGROUNDS = { dark: { bg: '#161412', dot: '#2c2825', ink: '#f3efea', muted: '#8d8379' }, light: { bg: '#f6f2ec', dot: '#ddd5cb', ink: '#1d1a16', muted: '#7a7067' } };

  const FONTS = {
    sans: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif',
    hand: '"Segoe Print", "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive',
    mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
  };
  // Editor CSS and the PNG renderer must both follow these so a snapshot looks like the editor.
  const TYPO = {
    lineHeight: 1.35,
    pad: { bubble: 16, shape: 12, text: 4 },
    bubbleTitleScale: 1.15, // bubble title size = size * this, bold, then a 6px gap before the body
    titleGap: 6,
    frameTitleSize: 20, frameTitleH: 40, // frame title bar height (title is drawn inside the frame, top-left, padded 14)
    framePad: 14,
    captionSize: 14, captionGap: 8, // image captions sit centered under the image box, outside its bounds
  };
  const SHAPE_NAMES = { rect: 'Box', roundrect: 'Rounded box', ellipse: 'Circle', triangle: 'Triangle', diamond: 'Diamond', hexagon: 'Hexagon', star: 'Star', arrow: 'Arrow shape' };
  const SHAPES = ['rect', 'roundrect', 'ellipse', 'triangle', 'diamond', 'hexagon', 'star', 'arrow'];
  const BUBBLE_STYLES = ['sticky', 'card', 'speech'];
  const BORDER_STYLES = ['none', 'solid', 'dashed', 'polaroid'];
  // Ready-made image border looks offered in the editor.
  const BORDER_PRESETS = {
    none: { style: 'none', width: 0, color: '#f3efea', radius: 0 },
    thin: { style: 'solid', width: 2, color: '#f3efea', radius: 8 },
    thick: { style: 'solid', width: 6, color: '#f3efea', radius: 12 },
    accent: { style: 'solid', width: 4, color: '#ff8f1f', radius: 12 },
    dashed: { style: 'dashed', width: 3, color: '#f2c14e', radius: 10 },
    polaroid: { style: 'polaroid', width: 12, color: '#ffffff', radius: 4 },
  };

  const DEFAULT_STYLE = () => ({
    background: 'dark',
    imageBorder: { ...BORDER_PRESETS.thin },
    bubbleColor: 'yellow',
    snap: false,
  });

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const num = (v, d) => Number.isFinite(+v) ? +v : d;

  /* ---------- colors ---------- */
  // A fill: palette name -> hex, '#hex' as is, null/'none' -> null (transparent).
  function fillOf(c) {
    if (c == null || c === 'none' || c === '') return null;
    if (PALETTE[c]) return PALETTE[c].fill;
    return /^#[0-9a-f]{3,8}$/i.test(c) ? c : null;
  }
  // Text color to use on top of a fill (palette names know theirs; hex picks by luminance).
  function textOn(c, background = 'dark') {
    if (PALETTE[c]) return PALETTE[c].text;
    const hex = fillOf(c);
    if (!hex) return BACKGROUNDS[background]?.ink || BACKGROUNDS.dark.ink;
    const h = hex.replace('#', '');
    const f = h.length === 3 ? h.split('').map(x => x + x).join('') : h.slice(0, 6);
    const [r, g, b] = [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#1d1a16' : '#f3efea';
  }
  // An ink (stroke/text) color: null -> the background's default ink.
  const inkOf = (c, background = 'dark') => (c && /^#[0-9a-f]{3,8}$/i.test(c)) ? c : PALETTE[c]?.fill || BACKGROUNDS[background]?.ink || BACKGROUNDS.dark.ink;

  /* ---------- items ---------- */
  const DEFAULTS = {
    frame: () => ({ w: 720, h: 480, title: 'Section', color: 'gray' }),
    image: () => ({ w: 320, h: 240, imageId: null, caption: '', border: null, fit: 'cover', naturalW: null, naturalH: null }),
    text: () => ({ w: 320, h: 44, text: '', size: 24, color: null, weight: 600, align: 'left', font: 'sans' }),
    bubble: () => ({ w: 240, h: 150, title: '', text: '', color: 'yellow', style: 'sticky', size: 15, font: 'sans', tail: null }),
    shape: () => ({ w: 160, h: 120, shape: 'rect', fill: 'blue', stroke: null, strokeWidth: 0, dash: false, text: '', size: 16, color: null, font: 'sans' }),
    draw: () => ({ w: 1, h: 1, points: [], color: '#ff8f1f', width: 4, highlight: false }),
  };
  const TYPES = Object.keys(DEFAULTS);

  function newItem(type, props = {}, style = DEFAULT_STYLE()) {
    if (!DEFAULTS[type]) throw new Error('Unknown item type ' + type);
    const it = { id: uid(), type, x: 0, y: 0, ...DEFAULTS[type](), ...props };
    if (type === 'image' && !props.border) it.border = { ...(style.imageBorder || BORDER_PRESETS.thin) };
    if (type === 'bubble' && !props.color) it.color = style.bubbleColor || 'yellow';
    return it;
  }
  function newLink(from, to, props = {}) {
    return { id: uid(), from, to, end: 'arrow', start: 'none', route: 'straight', color: null, width: 2, dash: false, label: '', ...props };
  }

  // Fill in anything missing (older or hand-written boards). Mutates and returns the board.
  function migrate(b) {
    b.version = 1;
    b.title ??= 'Untitled GDD';
    b.projectId ??= null;
    b.style = { ...DEFAULT_STYLE(), ...(b.style || {}) };
    b.style.imageBorder = { ...BORDER_PRESETS.thin, ...(b.style.imageBorder || {}) };
    b.items = (Array.isArray(b.items) ? b.items : []).filter(i => i && DEFAULTS[i.type]).map(i => {
      const full = { ...DEFAULTS[i.type](), ...i };
      full.id ||= uid();
      full.x = num(full.x, 0); full.y = num(full.y, 0);
      full.w = Math.max(1, num(full.w, 100)); full.h = Math.max(1, num(full.h, 60));
      if (full.type === 'image' && !full.border) full.border = { ...b.style.imageBorder };
      return full;
    });
    const ids = new Set(b.items.map(i => i.id));
    const endOk = e => e && (typeof e.item === 'string' ? ids.has(e.item) : Number.isFinite(e.x) && Number.isFinite(e.y));
    b.links = (Array.isArray(b.links) ? b.links : []).filter(l => l && endOk(l.from) && endOk(l.to)).map(l => ({ ...newLink(l.from, l.to), ...l }));
    b.previewId ??= null;
    b.previewAt ??= 0;
    return b;
  }

  /* ---------- templates ---------- */
  // Starter layout for a new game: one frame per GDD section with a hint card, plus a sample core loop.
  const TEMPLATE = [
    ['Pitch', 'yellow', 'One sentence: what is the game and why is it fun? Add genre, platform and who it is for.'],
    ['Core loop', 'orange', 'What does the player do again and again? Connect the steps with arrows.'],
    ['Mechanics', 'blue', 'One note per mechanic: what it does, the controls, and how it feels.'],
    ['Characters', 'pink', 'Player, enemies, NPCs. Paste reference images and give each a border.'],
    ['World & levels', 'green', 'Setting, level list, a rough map. Doodle over screenshots with the pen.'],
    ['Art & audio', 'purple', 'Mood board: drop reference images, palette, music and sound notes.'],
    ['Progression', 'teal', 'Unlocks, upgrades, economy, difficulty curve.'],
    ['Scope & milestones', 'red', 'What is in the first playable? What can wait?'],
  ];
  function newBoard({ title = 'Untitled GDD', projectId = null, template = 'blank' } = {}) {
    const now = Date.now();
    const b = migrate({ id: uid(), title, projectId, created: now, updated: now, items: [], links: [] });
    if (template === 'gdd') {
      const FW = 720, FH = 460, GAP = 80;
      TEMPLATE.forEach(([name, color, hint], i) => {
        const x = (i % 4) * (FW + GAP), y = Math.floor(i / 4) * (FH + GAP);
        b.items.push(newItem('frame', { x, y, w: FW, h: FH, title: name, color }, b.style));
        b.items.push(newItem('bubble', { x: x + 24, y: y + TYPO.frameTitleH + 16, w: 300, h: 110, style: 'card', color: 'gray', text: hint, size: 14 }, b.style));
        if (name === 'Core loop') {
          const pos = [[400, 80], [540, 270], [250, 270]];
          const steps = ['Explore', 'Fight', 'Upgrade'].map((t, k) => newItem('shape', { shape: 'roundrect', fill: color, text: t, x: x + pos[k][0], y: y + pos[k][1], w: 150, h: 72 }, b.style));
          b.items.push(...steps);
          steps.forEach((s, k) => b.links.push(newLink({ item: s.id }, { item: steps[(k + 1) % 3].id }, { route: 'curve' })));
        }
      });
      // frames go behind everything
      b.items.sort((p, q) => (q.type === 'frame') - (p.type === 'frame'));
    }
    return b;
  }

  /* ---------- geometry ---------- */
  const bounds = it => ({ x: it.x, y: it.y, w: it.w, h: it.h });
  const center = it => ({ x: it.x + it.w / 2, y: it.y + it.h / 2 });
  const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  function unionBounds(list) {
    if (!list.length) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of list) { x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  // Everything on the board, including image captions and speech tails (for zoom-to-fit and export).
  function contentBounds(board) {
    const rs = board.items.map(it => {
      const r = bounds(it);
      if (it.type === 'image' && it.caption) r.h += TYPO.captionGap + TYPO.captionSize * TYPO.lineHeight * 2;
      if (it.type === 'bubble' && it.tail) return unionBounds([r, { x: it.x + it.tail.x, y: it.y + it.tail.y, w: 1, h: 1 }]);
      return r;
    });
    for (const l of board.links) { const g = linkGeometry(board, l); if (g) rs.push(unionBounds([{ ...g.a, w: 1, h: 1 }, { ...g.b, w: 1, h: 1 }])); }
    return unionBounds(rs);
  }

  const f = n => Math.round(n * 100) / 100;
  // SVG path data for a shape filling a w x h box at the origin.
  function shapePath(shape, w, h) {
    switch (shape) {
      case 'roundrect': { const r = Math.min(18, w / 4, h / 4); return `M${f(r)} 0H${f(w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)}V${f(h - r)}A${f(r)} ${f(r)} 0 0 1 ${f(w - r)} ${f(h)}H${f(r)}A${f(r)} ${f(r)} 0 0 1 0 ${f(h - r)}V${f(r)}A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0Z`; }
      case 'ellipse': return `M0 ${f(h / 2)}A${f(w / 2)} ${f(h / 2)} 0 1 1 ${f(w)} ${f(h / 2)}A${f(w / 2)} ${f(h / 2)} 0 1 1 0 ${f(h / 2)}Z`;
      case 'triangle': return `M${f(w / 2)} 0L${f(w)} ${f(h)}H0Z`;
      case 'diamond': return `M${f(w / 2)} 0L${f(w)} ${f(h / 2)}L${f(w / 2)} ${f(h)}L0 ${f(h / 2)}Z`;
      case 'hexagon': return `M${f(w * .25)} 0H${f(w * .75)}L${f(w)} ${f(h / 2)}L${f(w * .75)} ${f(h)}H${f(w * .25)}L0 ${f(h / 2)}Z`;
      case 'arrow': return `M0 ${f(h * .3)}H${f(w * .62)}V0L${f(w)} ${f(h / 2)}L${f(w * .62)} ${f(h)}V${f(h * .7)}H0Z`;
      case 'star': {
        const pts = [];
        for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.45 : 1; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const minX = Math.min(...xs), minY = Math.min(...ys), sx = w / (Math.max(...xs) - minX), sy = h / (Math.max(...ys) - minY);
        return 'M' + pts.map(([x, y]) => `${f((x - minX) * sx)} ${f((y - minY) * sy)}`).join('L') + 'Z';
      }
      default: return `M0 0H${f(w)}V${f(h)}H0Z`;
    }
  }
  const BUBBLE_RADIUS = { sticky: 4, card: 14, speech: 20 };
  // Speech-bubble tail: a triangle from the side nearest the tip (tip relative to the item origin).
  // Returned as its own subpath; fill it together with the body (bubbles have no stroke) and they merge.
  function tailPath(w, h, tip) {
    if (!tip) return '';
    const cx = w / 2, cy = h / 2, dx = (tip.x - cx) / w, dy = (tip.y - cy) / h;
    const base = Math.min(32, w / 3, h / 3) / 2, r = BUBBLE_RADIUS.speech;
    let a, b;
    if (Math.abs(dx) > Math.abs(dy)) {
      const y = clamp(tip.y, r + base, h - r - base), x = dx > 0 ? w - 1 : 1;
      a = [x, y - base]; b = [x, y + base];
    } else {
      const x = clamp(tip.x, r + base, w - r - base), y = dy > 0 ? h - 1 : 1;
      a = [x - base, y]; b = [x + base, y];
    }
    return `M${f(a[0])} ${f(a[1])}L${f(tip.x)} ${f(tip.y)}L${f(b[0])} ${f(b[1])}Z`;
  }
  const bubblePath = it => roundRectPath(it.w, it.h, BUBBLE_RADIUS[it.style] ?? 4) + (it.style === 'speech' ? tailPath(it.w, it.h, it.tail) : '');
  function roundRectPath(w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    if (r <= 0) return shapePath('rect', w, h);
    return `M${f(r)} 0H${f(w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)}V${f(h - r)}A${f(r)} ${f(r)} 0 0 1 ${f(w - r)} ${f(h)}H${f(r)}A${f(r)} ${f(r)} 0 0 1 0 ${f(h - r)}V${f(r)}A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0Z`;
  }
  // Freehand stroke: points [[x,y],...] relative to the item origin -> smooth path (midpoint quadratic curves).
  function strokePath(points) {
    if (!points?.length) return '';
    if (points.length < 3) return `M${f(points[0][0])} ${f(points[0][1])}` + points.slice(1).map(p => `L${f(p[0])} ${f(p[1])}`).join('') + (points.length === 1 ? 'h0.01' : '');
    let d = `M${f(points[0][0])} ${f(points[0][1])}`;
    for (let i = 1; i < points.length - 1; i++) {
      const [x, y] = points[i], [nx, ny] = points[i + 1];
      d += `Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
    }
    const l = points[points.length - 1];
    return d + `L${f(l[0])} ${f(l[1])}`;
  }

  /* ---------- links (connectors) ---------- */
  const GAP = 6; // space between an attached line end and the item edge
  const itemOf = (board, end) => end && typeof end.item === 'string' ? board.items.find(i => i.id === end.item) : null;
  const refPoint = (board, end) => { const it = itemOf(board, end); return it ? center(it) : end ? { x: end.x, y: end.y } : null; };
  // Where a straight line from the item's center toward p leaves the item (ellipses and diamonds are respected).
  function edgePoint(it, p, gap = GAP) {
    const c = center(it), dx = p.x - c.x, dy = p.y - c.y;
    if (!dx && !dy) return { x: c.x, y: c.y };
    const hw = it.w / 2 + gap, hh = it.h / 2 + gap;
    let t;
    if (it.type === 'shape' && it.shape === 'ellipse') t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
    else if (it.type === 'shape' && it.shape === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
    else t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
    return { x: c.x + dx * t, y: c.y + dy * t };
  }
  // The side of an item facing p, as the midpoint of that side plus its outward normal.
  function sideAnchor(it, p, gap = GAP) {
    const c = center(it), dx = (p.x - c.x) / it.w, dy = (p.y - c.y) / it.h;
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? { x: it.x + it.w + gap, y: c.y, nx: 1, ny: 0 } : { x: it.x - gap, y: c.y, nx: -1, ny: 0 };
    return dy >= 0 ? { x: c.x, y: it.y + it.h + gap, nx: 0, ny: 1 } : { x: c.x, y: it.y - gap, nx: 0, ny: -1 };
  }
  // Full geometry for drawing a link: end points a/b, path d, label point mid, and the angles of the
  // line at each end (radians, pointing outward from the line, for placing arrow heads).
  function linkGeometry(board, link) {
    const A = itemOf(board, link.from), B = itemOf(board, link.to);
    const pa = refPoint(board, link.from), pb = refPoint(board, link.to);
    if (!pa || !pb) return null;
    const route = link.route || 'straight';
    if (route === 'straight') {
      const a = A ? edgePoint(A, pb) : pa, b = B ? edgePoint(B, pa) : pb;
      return { a, b, d: `M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}`, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, angA: Math.atan2(a.y - b.y, a.x - b.x), angB: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    const sa = A ? sideAnchor(A, pb) : { ...pa, nx: Math.sign(pb.x - pa.x) || 1, ny: 0 };
    const sb = B ? sideAnchor(B, pa) : { ...pb, nx: -(Math.sign(pb.x - pa.x) || 1), ny: 0 };
    if (route === 'curve') {
      const dist = Math.hypot(sb.x - sa.x, sb.y - sa.y), k = clamp(dist * 0.4, 30, 220);
      const c1 = { x: sa.x + sa.nx * k, y: sa.y + sa.ny * k }, c2 = { x: sb.x + sb.nx * k, y: sb.y + sb.ny * k };
      const mid = { x: (sa.x + 3 * c1.x + 3 * c2.x + sb.x) / 8, y: (sa.y + 3 * c1.y + 3 * c2.y + sb.y) / 8 };
      return { a: sa, b: sb, d: `M${f(sa.x)} ${f(sa.y)}C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(sb.x)} ${f(sb.y)}`, mid, angA: Math.atan2(sa.y - c1.y, sa.x - c1.x), angB: Math.atan2(sb.y - c2.y, sb.x - c2.x) };
    }
    // elbow: leave each end along its normal, meet with right angles
    const pts = [[sa.x, sa.y]];
    const out = 24, a1 = [sa.x + sa.nx * out, sa.y + sa.ny * out], b1 = [sb.x + sb.nx * out, sb.y + sb.ny * out];
    pts.push(a1);
    if (sa.nx) {
      if (sb.nx) { const mx = (a1[0] + b1[0]) / 2; pts.push([mx, a1[1]], [mx, b1[1]]); } else pts.push([b1[0], a1[1]]);
    } else if (sb.ny) { const my = (a1[1] + b1[1]) / 2; pts.push([a1[0], my], [b1[0], my]); } else pts.push([a1[0], b1[1]]);
    pts.push(b1, [sb.x, sb.y]);
    const clean = pts.filter((p, i) => !i || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
    const midI = Math.floor((clean.length - 1) / 2);
    const mid = { x: (clean[midI][0] + clean[midI + 1][0]) / 2, y: (clean[midI][1] + clean[midI + 1][1]) / 2 };
    return { a: sa, b: sb, d: 'M' + clean.map(p => `${f(p[0])} ${f(p[1])}`).join('L'), mid, angA: Math.atan2(sa.y - a1[1], sa.x - a1[0]), angB: Math.atan2(sb.y - b1[1], sb.x - b1[0]) };
  }
  // Arrow head (filled triangle) at tip pointing along angle; size scales with line width.
  function arrowHeadPath(tip, angle, width = 2) {
    const s = 8 + width * 2.2, back = angle + Math.PI;
    const p1 = { x: tip.x + Math.cos(back - 0.45) * s, y: tip.y + Math.sin(back - 0.45) * s };
    const p2 = { x: tip.x + Math.cos(back + 0.45) * s, y: tip.y + Math.sin(back + 0.45) * s };
    return `M${f(tip.x)} ${f(tip.y)}L${f(p1.x)} ${f(p1.y)}L${f(p2.x)} ${f(p2.y)}Z`;
  }

  /* ---------- reading the board (for Claude) ---------- */
  const frames = board => board.items.filter(i => i.type === 'frame');
  // The smallest frame holding an item's center, or null.
  function frameOf(board, it, fs = frames(board)) {
    if (it.type === 'frame') return null;
    const c = center(it);
    return fs.filter(fr => fr !== it && inside(c, fr)).sort((a, b) => a.w * a.h - b.w * b.h)[0] || null;
  }
  // Items a frame contains (moving a frame moves these).
  const itemsInFrame = (board, fr) => board.items.filter(i => i !== fr && i.type !== 'frame' && frameOf(board, i) === fr);
  // Top-to-bottom, then left-to-right, treating items within ~60px vertically as one row.
  function readingOrder(list) {
    return [...list].sort((a, b) => (Math.abs(a.y - b.y) < 60 ? 0 : a.y - b.y) || a.x - b.x || a.y - b.y);
  }
  const short = (s, n = 60) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  function itemLabel(it) {
    switch (it.type) {
      case 'frame': return it.title || 'Section';
      case 'image': return it.caption ? `image "${short(it.caption, 40)}"` : 'image';
      case 'text': return `"${short(it.text, 40) || 'text'}"`;
      case 'bubble': return `"${short(it.title || it.text, 40) || 'note'}"`;
      case 'shape': { const n = (SHAPE_NAMES[it.shape] || it.shape).toLowerCase(); return it.text ? `${n} "${short(it.text, 40)}"` : n; }
      case 'draw': return 'doodle';
      default: return it.type;
    }
  }
  const quoteLines = s => String(s || '').trim().split('\n').map(l => '> ' + l).join('\n');
  // Markdown description of a board. imageRef(id) builds the reference for an image id.
  // taskLookup(itemId) -> [{title, status, id}] lets the caller mention linked tasks.
  function boardToMarkdown(board, { imageRef = id => `forkpad-image:${id}`, taskLookup = null, projectName = null } = {}) {
    const fs = frames(board);
    const images = [];
    const linkedTasks = it => {
      const ts = taskLookup ? taskLookup(it.id) : [];
      return ts.length ? ` _(tasks: ${ts.map(t => `${t.status === 'done' ? '✓ ' : ''}${short(t.title, 50)} \`${t.id}\``).join('; ')})_` : '';
    };
    const describe = it => {
      const id = ` \`${it.id}\``, tasks = linkedTasks(it);
      switch (it.type) {
        case 'image': {
          if (it.imageId) images.push(it.imageId);
          return `- Image${id}${it.caption ? `: ${it.caption}` : ''}${tasks}\n  ![${short(it.caption, 60) || 'image'}](${imageRef(it.imageId)})`;
        }
        case 'text': return it.text?.trim() ? (it.size >= 28 ? `- **${it.text.trim().replace(/\n+/g, ' ')}**${id}${tasks}` : `- Text${id}: ${it.text.trim().replace(/\n/g, '\n  ')}${tasks}`) : '';
        case 'bubble': {
          const head = `- ${it.style === 'speech' ? 'Speech bubble' : 'Note'}${id}${it.title ? `: **${it.title.trim()}**` : ''}${tasks}`;
          const pointsAt = it.tail ? pointedItem(board, it) : null;
          return head + (pointsAt ? ` (points at ${itemLabel(pointsAt)} \`${pointsAt.id}\`)` : '') + (it.text?.trim() ? '\n' + quoteLines(it.text).replace(/^/gm, '  ') : '');
        }
        case 'shape': return `- ${SHAPE_NAMES[it.shape] || it.shape}${id}${it.text?.trim() ? `: ${it.text.trim().replace(/\n+/g, ' ')}` : ''}${tasks}`;
        case 'draw': {
          const under = board.items.filter(o => o !== it && o.type !== 'frame' && o.type !== 'draw' && overlaps(bounds(it), bounds(o)));
          return `- Freehand doodle${id}${it.highlight ? ' (highlighter)' : ''}${under.length ? ` over ${under.slice(0, 4).map(itemLabel).join(', ')}` : ''}`;
        }
        default: return '';
      }
    };
    const L = [`# GDD: ${board.title || 'Untitled GDD'}`, ''];
    const meta = [`id \`${board.id}\``, projectName ? `project: ${projectName}` : 'no project', `updated ${new Date(board.updated || Date.now()).toISOString().slice(0, 10)}`];
    L.push(`_${meta.join(' · ')}_`, '');
    for (const fr of readingOrder(fs)) {
      const kids = readingOrder(itemsInFrame(board, fr));
      L.push(`## ${fr.title || 'Section'} \`${fr.id}\`${linkedTasks(fr)}`, '');
      const lines = kids.map(describe).filter(Boolean);
      L.push(...(lines.length ? lines : ['_(empty section)_']), '');
    }
    const loose = readingOrder(board.items.filter(i => i.type !== 'frame' && !frameOf(board, i, fs)));
    const looseLines = loose.map(describe).filter(Boolean);
    if (looseLines.length) L.push(fs.length ? '## Elsewhere on the board' : '## Board', '', ...looseLines, '');
    if (board.links.length) {
      const name = end => { const it = itemOf(board, end); return it ? `${itemLabel(it)} \`${it.id}\`` : 'a point'; };
      L.push('## Connections', '');
      for (const l of board.links) {
        const arrow = l.start === 'arrow' && l.end === 'arrow' ? '↔' : l.end === 'arrow' ? '→' : l.start === 'arrow' ? '←' : '-';
        L.push(`- ${name(l.from)} ${arrow} ${name(l.to)}${l.label ? ` (${l.label})` : ''}`);
      }
      L.push('');
    }
    if (!board.items.length) L.push('_This board is empty._');
    return { md: L.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', images };
  }
  // The topmost non-frame item under a speech bubble's tail tip.
  function pointedItem(board, b) {
    if (!b.tail) return null;
    const p = { x: b.x + b.tail.x, y: b.y + b.tail.y };
    return [...board.items].reverse().find(o => o !== b && o.type !== 'frame' && o.type !== 'draw' && inside(p, bounds(o))) || null;
  }
  // Plain text of a board, for search.
  function boardText(board) {
    return [board.title, ...board.items.map(i => [i.title, i.text, i.caption].filter(Boolean).join(' ')), ...board.links.map(l => l.label)].filter(Boolean).join(' ');
  }
  // Rough text height for items created without a DOM (the connector); the editor corrects it on load.
  function estimateTextHeight(text, w, size, extraLines = 0) {
    const perLine = Math.max(4, Math.floor(w / (size * 0.55)));
    const lines = String(text || '').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0) + extraLines;
    return Math.ceil(lines * size * TYPO.lineHeight);
  }

  return {
    PALETTE, PALETTE_NAMES, SHAPE_NAMES, INKS, BACKGROUNDS, FONTS, TYPO, SHAPES, BUBBLE_STYLES, BORDER_STYLES, BORDER_PRESETS, BUBBLE_RADIUS, TYPES, TEMPLATE,
    DEFAULT_STYLE, uid, fillOf, textOn, inkOf, newItem, newLink, newBoard, migrate,
    bounds, center, inside, overlaps, unionBounds, contentBounds, shapePath, roundRectPath, tailPath, bubblePath, strokePath,
    edgePoint, sideAnchor, linkGeometry, arrowHeadPath, itemOf,
    frames, frameOf, itemsInFrame, readingOrder, itemLabel, pointedItem, boardToMarkdown, boardText, estimateTextHeight,
  };
});
