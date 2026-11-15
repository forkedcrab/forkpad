/* ForkPad GDD boards: render a board to a standalone SVG string and to a PNG Blob (snapshots, export).
   Follows the drawing order and specs in PLAN.md so a snapshot looks like the editor.
   UMD: window.GDDRender in the browser, module.exports in Node (the SVG part runs in Node when a
   measure function is injected, which is how it is tested). */
(function (root, factory) {
  const Model = (root && root.GDDModel) || (typeof require === 'function' ? require('./gdd-model.js') : null);
  const m = factory(Model);
  if (typeof module === 'object' && module.exports) module.exports = m; else root.GDDRender = m;
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';
  const { FONTS, TYPO, BACKGROUNDS } = M;

  /* ---------- small helpers ---------- */
  const f = n => Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  const num = (v, d) => Number.isFinite(+v) && v !== null && v !== '' ? +v : d;
  // XML text/attribute escape; also drops characters XML 1.0 does not allow (they would break the document).
  const esc = s => String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const family = font => FONTS[font] || FONTS.sans;
  const weightOf = (w, d = 400) => { const n = num(w, d); return Math.min(900, Math.max(100, Math.round(n / 100) * 100)); };
  const fontCSS = (font, size, weight) => `${weightOf(weight)} ${f(size)}px ${family(font)}`;
  const isHex = c => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c);

  /* ---------- measuring and wrapping text ---------- */
  let ctx2d = null;
  const cache = new Map();
  // Width of text in a CSS font, via a 2D canvas; a rough estimate when no canvas exists (Node).
  function canvasMeasure(text, font) {
    const key = font + '\n' + text;
    let w = cache.get(key);
    if (w != null) return w;
    if (!ctx2d) {
      try {
        if (typeof OffscreenCanvas === 'function') ctx2d = new OffscreenCanvas(8, 8).getContext('2d');
        else if (typeof document === 'object') ctx2d = document.createElement('canvas').getContext('2d');
      } catch { ctx2d = null; }
      if (!ctx2d) ctx2d = false;
    }
    if (ctx2d) { ctx2d.font = font; w = ctx2d.measureText(text).width; }
    else { const px = +(/([\d.]+)px/.exec(font) || [0, 16])[1]; w = text.length * px * 0.55; }
    if (cache.size > 5000) cache.clear();
    cache.set(key, w);
    return w;
  }
  const measure = (text, font = 'sans', size = 16, weight = 400) => canvasMeasure(String(text ?? ''), fontCSS(font, size, weight));

  // Greedy word wrap like CSS pre-wrap: keeps explicit newlines and leading spaces, wraps at spaces,
  // breaks words that are wider than the line on their own.
  function wrap(text, maxW, font, measureFn = canvasMeasure) {
    const fit = s => measureFn(s, font) <= maxW;
    const out = [];
    for (const para of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
      let line = '', fresh = true;
      for (const tok of para.match(/\s+|\S+/g) || []) {
        if (/^\s/.test(tok)) { if (line || fresh) line += tok; continue; }
        fresh = false;
        if (fit(line + tok)) { line += tok; continue; }
        if (line.trim()) out.push(line.replace(/\s+$/, ''));
        line = '';
        if (fit(tok)) { line = tok; continue; }
        let part = '';
        for (const ch of tok) { if (part && !fit(part + ch)) { out.push(part); part = ''; } part += ch; }
        line = part;
      }
      out.push(line.replace(/\s+$/, ''));
    }
    return out;
  }
  // Cut lines to at most max, ending the last kept one with an ellipsis that fits.
  function limitLines(lines, max, maxW, font, measureFn) {
    if (lines.length <= max) return lines;
    const kept = lines.slice(0, max);
    let last = kept[max - 1];
    while (last && measureFn(last + '…', font) > maxW) last = last.slice(0, -1);
    kept[max - 1] = last.replace(/\s+$/, '') + '…';
    return kept;
  }

  // One <text> block; y is the top of the first line box. Lines are centered in their line box like CSS.
  function textBlock(lines, { x, y, w, size, lh, align = 'left', color, font, weight }) {
    if (!lines.some(l => l)) return '';
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
    const ax = align === 'center' ? x + w / 2 : align === 'right' ? x + w : x;
    const spans = lines.map((l, i) => l ? `<tspan x="${f(ax)}" y="${f(y + i * lh + lh / 2)}">${esc(l)}</tspan>` : '').join('');
    return `<text font-family="${esc(family(font))}" font-size="${f(size)}" font-weight="${weightOf(weight)}" fill="${esc(color)}" text-anchor="${anchor}" dominant-baseline="central" xml:space="preserve" style="white-space:pre">${spans}</text>`;
  }

  /* ---------- image sources ---------- */
  async function toDataURL(url) {
    if (typeof url !== 'string' || !url) return null;
    if (url.startsWith('data:')) return url;
    // An SVG drawn through <img> cannot load outside resources, so blob:/http URLs are inlined here.
    if (typeof fetch !== 'function') return null;
    const r = await fetch(url);
    if (!r.ok) return null;
    const blob = await r.blob(), bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
  }
  async function resolveAll(items, resolveImage) {
    const ids = [...new Set(items.filter(i => i.type === 'image' && i.imageId).map(i => String(i.imageId)))];
    const map = new Map();
    await Promise.all(ids.map(async id => {
      try { map.set(id, await toDataURL(resolveImage ? await resolveImage(id) : null)); } catch { map.set(id, null); }
    }));
    return map;
  }

  /* ---------- the SVG ---------- */
  async function toSVG(board, { resolveImage = null, padding = 40, measure: measureFn = canvasMeasure, grid = true } = {}) {
    // Work on a migrated copy: never mutate the caller's board, and tolerate partial data.
    let b;
    try { b = M.migrate(JSON.parse(JSON.stringify(board || {}))); } catch { b = M.migrate({}); }
    const bgName = BACKGROUNDS[b.style.background] ? b.style.background : 'dark';
    const BG = BACKGROUNDS[bgName], ink = c => M.inkOf(c, bgName);
    const mw = (s, font) => { const w = +measureFn(s, font); return Number.isFinite(w) ? w : 0; };
    const images = await resolveAll(b.items, resolveImage);
    const pad = Math.max(0, num(padding, 40));
    let cb = null;
    try { cb = M.contentBounds(b); } catch { cb = null; }
    if (!cb || ![cb.x, cb.y, cb.w, cb.h].every(Number.isFinite)) cb = { x: 0, y: 0, w: 320, h: 200 };
    const vb = { x: Math.floor(cb.x - pad), y: Math.floor(cb.y - pad), w: Math.ceil(cb.w + pad * 2), h: Math.ceil(cb.h + pad * 2) };
    vb.w = Math.max(1, vb.w); vb.h = Math.max(1, vb.h);

    const idp = 'g' + String(b.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) + '-';
    let seq = 0;
    const defs = [];
    // clipPath may only hold shapes (no <g>), so offsets go on the shape itself.
    const clip = shape => { const id = idp + 'c' + (++seq); defs.push(`<clipPath id="${id}">${shape}</clipPath>`); return id; };
    const rectClip = (x, y, w, h) => clip(`<rect x="${f(x)}" y="${f(y)}" width="${f(Math.max(0, w))}" height="${f(Math.max(0, h))}"/>`);
    const lineH = size => size * TYPO.lineHeight;

    /* frames */
    function frame(it) {
      // Numbers mirror the editor's FRAME constants in gdd.js so snapshots look like the canvas.
      const col = M.fillOf(it.color) || M.fillOf('gray'), r = Math.min(16, it.w / 2, it.h / 2);
      const tH = Math.min(TYPO.frameTitleH, it.h), size = TYPO.frameTitleSize, fp = TYPO.framePad;
      const font = fontCSS('sans', size, 700), maxW = Math.max(0, it.w - fp * 2);
      const title = limitLines(wrap(String(it.title ?? '').replace(/\s+/g, ' ').trim(), maxW, font, mw), 1, maxW, font, mw);
      // Title bar: only the top corners are rounded, drawn over the body and its stroke.
      const br = Math.min(r, tH, it.w / 2), x0 = it.x, y0 = it.y, x1 = it.x + it.w, y1 = it.y + tH;
      const bar = `M${f(x0)} ${f(y1)}V${f(y0 + br)}A${f(br)} ${f(br)} 0 0 1 ${f(x0 + br)} ${f(y0)}H${f(x1 - br)}A${f(br)} ${f(br)} 0 0 1 ${f(x1)} ${f(y0 + br)}V${f(y1)}Z`;
      return `<g>` +
        `<rect x="${f(it.x)}" y="${f(it.y)}" width="${f(it.w)}" height="${f(it.h)}" rx="${f(r)}" fill="${col}" fill-opacity="0.08" stroke="${col}" stroke-opacity="0.45" stroke-width="2"/>` +
        `<path d="${bar}" fill="${col}" fill-opacity="0.22"/>` +
        `<g clip-path="url(#${rectClip(it.x, it.y, it.w, tH)})">` +
        textBlock(title, { x: it.x + fp, y: it.y + (tH - size) / 2, w: maxW, size, lh: size, color: ink(null), font: 'sans', weight: 700 }) +
        `</g></g>`;
    }

    /* links */
    function link(l) {
      const g = M.linkGeometry(b, l);
      if (!g || !g.d || /NaN|undefined/.test(g.d)) return '';
      const col = ink(l.color), w = Math.max(0.5, num(l.width, 2));
      const heads = l.start === 'arrow' || l.end === 'arrow';
      let s = `<path d="${g.d}" fill="none" stroke="${col}" stroke-width="${f(w)}" stroke-linecap="${heads ? 'butt' : 'round'}" stroke-linejoin="round"${l.dash ? ` stroke-dasharray="${f(w * 3)} ${f(w * 2.5)}"` : ''}/>`;
      const head = (kind, p, ang) => {
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return '';
        if (kind === 'arrow') return `<path d="${M.arrowHeadPath(p, ang, w)}" fill="${col}" stroke="${col}" stroke-width="1" stroke-linejoin="round"/>`;
        if (kind === 'dot') return `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(3 + w)}" fill="${col}"/>`;
        return '';
      };
      s += head(l.start, g.a, g.angA) + head(l.end, g.b, g.angB);
      const label = String(l.label ?? '').replace(/\s+/g, ' ').trim();
      if (label && g.mid && Number.isFinite(g.mid.x) && Number.isFinite(g.mid.y)) {
        const size = 13, font = fontCSS('sans', size, 400);
        const tw = Math.min(mw(label, font), 320), ph = 22, pw = tw + 18;
        const shown = limitLines(wrap(label, 320, font, mw), 1, 320, font, mw);
        s += `<rect x="${f(g.mid.x - pw / 2)}" y="${f(g.mid.y - ph / 2)}" width="${f(pw)}" height="${f(ph)}" rx="${f(ph / 2)}" fill="${BG.bg}"/>` +
          textBlock(shown, { x: g.mid.x - tw / 2, y: g.mid.y - lineH(size) / 2, w: tw, size, lh: lineH(size), align: 'center', color: BG.ink, font: 'sans', weight: 400 });
      }
      return `<g>${s}</g>`;
    }

    /* images */
    function image(it) {
      const bd = { ...M.BORDER_PRESETS.none, ...(it.border || b.style.imageBorder || {}) };
      const style = M.BORDER_STYLES.includes(bd.style) ? bd.style : 'none';
      const bw = Math.max(0, Math.min(num(bd.width, 0), it.w / 4, it.h / 4)), r = Math.max(0, num(bd.radius, 0));
      const bcol = isHex(bd.color) ? bd.color : ink(null);
      let s = '', ix = it.x, iy = it.y, iw = it.w, ih = it.h, ir = r;
      if (style === 'polaroid') {
        s += `<path transform="translate(${f(it.x)} ${f(it.y)})" d="${M.roundRectPath(it.w, it.h, r)}" fill="${bcol}"/>`;
        ix += bw; iy += bw; iw = Math.max(1, it.w - bw * 2); ih = Math.max(1, it.h - bw * 4); ir = Math.max(0, r - bw / 2);
      }
      const cid = clip(`<path transform="translate(${f(ix)} ${f(iy)})" d="${M.roundRectPath(iw, ih, ir)}"/>`);
      const src = it.imageId ? images.get(String(it.imageId)) : null;
      s += `<g clip-path="url(#${cid})">`;
      if (src) s += `<image x="${f(ix)}" y="${f(iy)}" width="${f(iw)}" height="${f(ih)}" href="${esc(src)}" preserveAspectRatio="xMidYMid ${it.fit === 'contain' ? 'meet' : 'slice'}"/>`;
      else {
        s += `<rect x="${f(ix)}" y="${f(iy)}" width="${f(iw)}" height="${f(ih)}" fill="${BG.dot}"/>`;
        if (iw > 60 && ih > 30) s += textBlock(['Image missing'], { x: ix, y: iy + ih / 2 - lineH(13) / 2, w: iw, size: 13, lh: lineH(13), align: 'center', color: BG.muted, font: 'sans', weight: 500 });
      }
      s += `</g>`;
      if ((style === 'solid' || style === 'dashed') && bw > 0) {
        // Borders sit inside the box: the stroke is centered on a rect inset by half its width.
        const rr = Math.max(0, Math.min(r - bw / 2, (it.w - bw) / 2, (it.h - bw) / 2));
        s += `<rect x="${f(it.x + bw / 2)}" y="${f(it.y + bw / 2)}" width="${f(Math.max(0, it.w - bw))}" height="${f(Math.max(0, it.h - bw))}" rx="${f(rr)}" fill="none" stroke="${bcol}" stroke-width="${f(bw)}"${style === 'dashed' ? ` stroke-dasharray="${f(bw * 3)} ${f(bw * 2)}"` : ''}/>`;
      }
      const cap = String(it.caption ?? '').trim();
      if (cap) {
        const size = TYPO.captionSize, font = fontCSS('sans', size, 400);
        const lines = limitLines(wrap(cap, it.w, font, mw), 2, it.w, font, mw);
        s += textBlock(lines, { x: it.x, y: it.y + it.h + TYPO.captionGap, w: it.w, size, lh: lineH(size), align: 'center', color: ink(null), font: 'sans', weight: 400 });
      }
      return `<g>${s}</g>`;
    }

    /* text items: top-left, align applies */
    function text(it) {
      const size = Math.max(1, num(it.size, 24)), p = TYPO.pad.text, w = Math.max(0, it.w - p * 2);
      const lines = wrap(it.text, w, fontCSS(it.font, size, num(it.weight, 600)), mw);
      const t = textBlock(lines, { x: it.x + p, y: it.y + p, w, size, lh: lineH(size), align: it.align, color: ink(it.color), font: it.font, weight: num(it.weight, 600) });
      return t ? `<g clip-path="url(#${rectClip(it.x, it.y, it.w, it.h)})">${t}</g>` : '';
    }

    /* bubbles: body (plus speech tail) filled, then bold title and body text */
    function bubble(it) {
      const fill = M.fillOf(it.color) || M.fillOf('yellow'), tcol = M.textOn(M.fillOf(it.color) ? it.color : 'yellow', bgName);
      const tail = it.style === 'speech' && it.tail && Number.isFinite(+it.tail.x) && Number.isFinite(+it.tail.y) ? { x: +it.tail.x, y: +it.tail.y } : null;
      let s = `<path transform="translate(${f(it.x)} ${f(it.y)})" d="${M.bubblePath({ ...it, tail })}" fill="${fill}"/>`;
      const size = Math.max(1, num(it.size, 15)), p = TYPO.pad.bubble, w = Math.max(0, it.w - p * 2);
      const tsize = size * TYPO.bubbleTitleScale;
      const title = String(it.title ?? '').trim() ? wrap(String(it.title).trim(), w, fontCSS(it.font, tsize, 700), mw) : [];
      const body = String(it.text ?? '') ? wrap(it.text, w, fontCSS(it.font, size, 400), mw) : [];
      let y = it.y + p, inner = '';
      if (title.length) { inner += textBlock(title, { x: it.x + p, y, w, size: tsize, lh: lineH(tsize), color: tcol, font: it.font, weight: 700 }); y += title.length * lineH(tsize) + (body.length ? TYPO.titleGap : 0); }
      if (body.length) inner += textBlock(body, { x: it.x + p, y, w, size, lh: lineH(size), color: tcol, font: it.font, weight: 400 });
      if (inner) s += `<g clip-path="url(#${rectClip(it.x, it.y, it.w, it.h)})">${inner}</g>`;
      return `<g>${s}</g>`;
    }

    /* shapes: fill, optional stroke, text centered both ways */
    function shape(it) {
      const fill = M.fillOf(it.fill), sw = Math.max(0, num(it.strokeWidth, 0));
      // Like the editor, a width without a color means the canvas ink.
      const stroke = sw > 0 ? ink(it.stroke) : null;
      let s = '';
      if (fill || stroke) {
        s += `<path transform="translate(${f(it.x)} ${f(it.y)})" d="${M.shapePath(M.SHAPES.includes(it.shape) ? it.shape : 'rect', it.w, it.h)}" fill="${fill || 'none'}"` +
          (stroke ? ` stroke="${stroke}" stroke-width="${f(sw)}" stroke-linejoin="round"${it.dash ? ` stroke-dasharray="${f(sw * 3)} ${f(sw * 2)}"` : ''}` : '') + `/>`;
      }
      if (String(it.text ?? '').trim()) {
        const size = Math.max(1, num(it.size, 16)), p = TYPO.pad.shape, w = Math.max(0, it.w - p * 2);
        const col = it.color ? ink(it.color) : fill ? M.textOn(it.fill, bgName) : ink(null);
        const lines = wrap(it.text, w, fontCSS(it.font, size, 400), mw), lh = lineH(size);
        const t = textBlock(lines, { x: it.x + p, y: it.y + (it.h - lines.length * lh) / 2, w, size, lh, align: 'center', color: col, font: it.font, weight: 400 });
        if (t) s += `<g clip-path="url(#${rectClip(it.x, it.y, it.w, it.h)})">${t}</g>`;
      }
      return s ? `<g>${s}</g>` : '';
    }

    /* pen doodles; highlighter is wider and see-through */
    function draw(it) {
      const pts = (Array.isArray(it.points) ? it.points : []).filter(q => Array.isArray(q) && Number.isFinite(+q[0]) && Number.isFinite(+q[1])).map(q => [+q[0], +q[1]]);
      if (!pts.length) return '';
      const w = Math.max(0.5, num(it.width, 4)) * (it.highlight ? 3 : 1);
      return `<path transform="translate(${f(it.x)} ${f(it.y)})" d="${M.strokePath(pts)}" fill="none" stroke="${ink(it.color)}" stroke-width="${f(w)}" stroke-linecap="round" stroke-linejoin="round"${it.highlight ? ' stroke-opacity="0.4"' : ''}/>`;
    }

    const R = { frame, image, text, bubble, shape, draw };
    // A broken item is skipped rather than failing the whole snapshot.
    const safe = (fn, x) => { try { const s = fn(x); return typeof s === 'string' ? s : ''; } catch { return ''; } };
    const frames = b.items.filter(i => i.type === 'frame').map(i => safe(frame, i)).join('');
    const links = b.links.map(l => safe(link, l)).join('');
    const items = b.items.filter(i => i.type !== 'frame' && R[i.type]).map(i => safe(R[i.type], i)).join('');

    let bg = `<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="${BG.bg}"/>`;
    if (grid) {
      // Dots on world multiples of 24px, so they line up with the editor grid.
      const pid = idp + 'dots';
      defs.unshift(`<pattern id="${pid}" x="-12" y="-12" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="1.2" fill="${BG.dot}"/></pattern>`);
      bg += `<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="url(#${pid})"/>`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${vb.w}" height="${vb.h}" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}">` +
      `<title>${esc(b.title || 'GDD')}</title>` +
      (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
      bg + `<g class="frames">${frames}</g><g class="links">${links}</g><g class="items">${items}</g></svg>`;
  }

  /* ---------- PNG ---------- */
  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('Could not draw the board'));
      img.src = src;
    });
  }
  async function toPNG(board, { resolveImage = null, maxSide = 2400, scale = 2, padding = 40 } = {}) {
    if (typeof document !== 'object') throw new Error('toPNG needs a browser');
    const svg = await toSVG(board, { resolveImage, padding });
    const [, W, H] = /width="(\d+)" height="(\d+)"/.exec(svg).map(Number);
    const k = Math.max(0.01, Math.min(num(scale, 2), num(maxSide, 2400) / Math.max(W, H)));
    const cw = Math.max(1, Math.round(W * k)), ch = Math.max(1, Math.round(H * k));
    const render = async src => {
      const img = await loadImage(src);
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      c.getContext('2d').drawImage(img, 0, 0, cw, ch);
      return new Promise((res, rej) => c.toBlob(bl => bl ? res(bl) : rej(new Error('PNG encoding failed')), 'image/png'));
    };
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    try { return await render(url); }
    // Some browsers treat a blob: SVG as tainting; a data: URL is the fallback.
    catch { return render('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)); }
    finally { URL.revokeObjectURL(url); }
  }

  return { toSVG, toPNG, measure, wrap, fontCSS, esc };
});
