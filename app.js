'use strict';
/* ForkPad: notes, quick thoughts and project boards. Plain JS, no build step. */

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return todayStr(d); };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const fmtBytes = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
const normTag = s => s.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 40);
const pref = {
  get(k, d) { try { const v = localStorage.getItem('fp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fp.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

function rel(ts) {
  const d = Date.now() - ts, m = 60e3, h = 60 * m;
  if (d < m) return 'just now';
  if (d < h) return Math.floor(d / m) + 'm ago';
  if (d < 24 * h && todayStr(new Date(ts)) === todayStr()) return Math.floor(d / h) + 'h ago';
  if (todayStr(new Date(ts)) === addDays(-1)) return 'yesterday';
  const dt = new Date(ts);
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(dt.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
}
function dueLabel(due) {
  if (due === todayStr()) return 'Today';
  if (due === addDays(1)) return 'Tomorrow';
  if (due === addDays(-1)) return 'Yesterday';
  return new Date(due + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function dueClass(t) {
  if (!t.due || t.status === 'done') return '';
  const now = todayStr();
  return t.due < now ? 'overdue' : t.due === now ? 'today' : t.due <= addDays(7) ? 'soon' : '';
}

const ICONS = {
  home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  pin: '<path d="M12 17v5M9 3h6l-1 6 4 4v2H6v-2l4-4z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  board: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  listUl: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  listOl: '<path d="M10 6h10M10 12h10M10 18h10M4 4h1v4M4 14h2l-2 3h2"/>',
  checksq: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  quote: '<path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  canvas: '<rect x="3" y="3" width="8" height="6" rx="1.5"/><rect x="13" y="15" width="8" height="6" rx="1.5"/><circle cx="17" cy="6" r="3"/><path d="M7 9v4a2 2 0 0 0 2 2h4"/>',
};
const ic = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;
const LOGO = $('.brand .logo').outerHTML;

const COLORS = ['#ff8f1f', '#f2b84b', '#ef5b5b', '#d16bd6', '#8f7bff', '#4fa8ff', '#3fc7ad', '#7fcf63'];
const badge = (p, cls = '') => `<span class="proj-badge ${cls}" style="--c:${p.color}">${esc([...p.name.trim()][0]?.toUpperCase() || '?')}</span>`;
const STATUSES = [{ id: 'todo', name: 'To do' }, { id: 'doing', name: 'In progress' }, { id: 'done', name: 'Done' }];

/* ---------- state ---------- */
const S = { projects: [], notes: [], tasks: [], boards: [], view: { type: 'inbox' }, prevView: null, noteId: null, query: '', listSource: () => [] };
const proj = id => S.projects.find(p => p.id === id);
const noteById = id => S.notes.find(n => n.id === id);
const taskById = id => S.tasks.find(t => t.id === id);
const boardById = id => S.boards.find(b => b.id === id);
// The one open GDD editor: { id, item, el, ctl }. render() runs often, so it is kept, not remounted.
let gddMount = null;
const projectOptions = (sel, none = true) => (none ? '<option value="">No project</option>' : '') +
  S.projects.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

function makeNote(fields) {
  const now = Date.now();
  return { id: uid(), kind: 'note', projectId: null, title: '', html: '', text: '', tags: [], pinned: false, created: now, updated: now, ...fields };
}
function addTask({ projectId, title, status = 'todo', due = null, desc = '', tags = [], gdd = null }) {
  const order = Math.max(-1, ...S.tasks.filter(t => t.projectId === projectId && t.status === status).map(t => t.order)) + 1;
  const t = { id: uid(), projectId, title, status, due, desc, tags, order, created: Date.now(), updated: Date.now(), ...(gdd?.boardId && { gdd: { boardId: gdd.boardId, ...(gdd.itemId && { itemId: gdd.itemId }) } }) };
  S.tasks.push(t);
  DB.put('tasks', t);
  return t;
}
const sortNotes = list => [...list].sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
function tagCounts(notes = S.notes.filter(n => n.kind === 'note'), tasks = []) {
  const m = new Map();
  for (const x of [...notes, ...tasks]) for (const t of x.tags || []) m.set(t, (m.get(t) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/* debounced saves, flushed before any re-render so nothing is lost */
const pending = new Map();
function queueSave(id, fn) {
  clearTimeout(pending.get(id)?.t);
  pending.set(id, { fn, t: setTimeout(() => { pending.delete(id); fn(); }, 400) });
}
function flushSaves() {
  for (const [, e] of pending) { clearTimeout(e.t); e.fn(); }
  pending.clear();
  try { gddMount?.ctl?.flush?.(); } catch (err) { console.warn('GDD flush failed', err); }
}

/* ---------- images ---------- */
const Img = {
  urls: new Map(),
  async url(id) {
    if (this.urls.has(id)) return this.urls.get(id);
    if (DB.imageURL(id)) return DB.imageURL(id);
    const rec = await DB.get('images', id);
    if (!rec) return '';
    const u = URL.createObjectURL(rec.blob);
    this.urls.set(id, u);
    return u;
  },
  async add(file) {
    const blob = await downscale(file);
    const id = uid();
    await DB.put('images', { id, blob, created: Date.now() });
    const url = URL.createObjectURL(blob);
    this.urls.set(id, url);
    return { id, url };
  },
  hydrate(root) {
    return Promise.all($$('img[data-fp]', root).map(async img => { img.src = await Img.url(img.dataset.fp); }));
  },
};
async function downscale(file, max = 1800) {
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6) { bmp.close(); return file; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return await new Promise(r => c.toBlob(b => r(b || file), 'image/webp', 0.9));
  } catch { return file; }
}
// Delete images no note references any more (skips fresh ones in case another tab is mid-edit).
async function gcImages() {
  if (!S.boardsOk) return; // boards couldn't be read, so we can't tell which images they use
  const imgs = await DB.all('images');
  const used = S.notes.map(n => n.html || '').join(' ');
  const keep = new Set([...S.tasks.flatMap(t => t.images || []), ...S.boards.flatMap(boardImageIds)]);
  for (const i of imgs) if (!used.includes(`data-fp="${i.id}"`) && !keep.has(i.id) && Date.now() - (i.created || 0) > 864e5) DB.del('images', i.id);
}
const boardImageIds = b => [b.previewId, ...(b.items || []).filter(i => i.type === 'image').map(i => i.imageId)].filter(Boolean);

/* ---------- rich text ---------- */
const ALLOWED = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'A', 'IMG', 'HR', 'DIV', 'SPAN']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'FORM']);
function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const tw = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const comments = []; while (tw.nextNode()) comments.push(tw.currentNode);
  comments.forEach(c => c.remove());
  const walk = el => {
    for (const child of [...el.children]) {
      if (DROP.has(child.tagName)) { child.remove(); continue; }
      if (!ALLOWED.has(child.tagName)) {
        walk(child);
        if (/^(H[4-6]|TABLE|TR|SECTION|ARTICLE)$/.test(child.tagName)) {
          const p = doc.createElement(child.tagName.startsWith('H') ? 'h3' : 'div');
          p.append(...child.childNodes); child.replaceWith(p);
        } else child.replaceWith(...child.childNodes);
        continue;
      }
      for (const a of [...child.attributes]) {
        const n = a.name, tag = child.tagName;
        const keep = (tag === 'A' && n === 'href' && /^(https?:|mailto:)/i.test(a.value))
          || (tag === 'IMG' && (n === 'data-fp' || n === 'alt' || (n === 'src' && /^(https?:|data:image\/)/i.test(a.value))))
          || (tag === 'UL' && n === 'class' && a.value === 'checklist')
          || (tag === 'LI' && n === 'data-checked');
        if (!keep) child.removeAttribute(n);
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}
function serialize(el) {
  const c = el.cloneNode(true);
  $$('img[data-fp]', c).forEach(i => i.removeAttribute('src'));
  return c.innerHTML;
}
function closestIn(node, sel, root) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement)?.closest(sel);
  return el && root.contains(el) ? el : null;
}
function caretToEnd(el) {
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
const markEmpty = el => el.classList.toggle('is-empty', !el.textContent.trim() && !el.querySelector('img,hr,li'));

async function insertImages(body, files, range) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const { id, url } = await Img.add(f);
    body.focus();
    const s = getSelection();
    if (range) { s.removeAllRanges(); s.addRange(range); range = null; }
    else if (!body.contains(s.anchorNode)) caretToEnd(body);
    document.execCommand('insertHTML', false, `<img data-fp="${id}" src="${url}" alt="">`);
  }
}
function pickImages(body) {
  const s = getSelection();
  const range = s.rangeCount && body.contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null;
  const inp = $('#fileImg');
  inp.value = '';
  inp.onchange = () => insertImages(body, [...inp.files], range);
  inp.click();
}
// Images pasted as data: URLs get moved into the image store so notes stay small.
async function internalize(el) {
  for (const img of $$('img:not([data-fp])', el)) {
    if (!img.getAttribute('src')?.startsWith('data:image/')) continue;
    try {
      const { id, url } = await Img.add(await (await fetch(img.src)).blob());
      img.dataset.fp = id; img.src = url;
    } catch { /* keep inline copy */ }
  }
}

function toggleChecklist(root) {
  const s = getSelection(); if (!s.rangeCount) return;
  let ul = closestIn(s.anchorNode, 'ul', root);
  if (ul?.classList.contains('checklist')) { document.execCommand('insertUnorderedList'); return; }
  if (!ul) {
    document.execCommand('insertUnorderedList');
    // the caret can end up on the editor root itself, so look at the child it points to
    const r = getSelection().getRangeAt(0);
    let n = r.startContainer;
    if (n === root) n = root.childNodes[r.startOffset] || root.childNodes[r.startOffset - 1];
    ul = closestIn(n, 'ul', root);
  }
  ul?.classList.add('checklist');
}

// Markdown-style shortcuts: "# ", "## ", "- ", "1. ", "[] ", "> ", "``` "
const MD_RULES = [['# ', 'h1'], ['## ', 'h2'], ['### ', 'h3'], ['> ', 'blockquote'], ['- ', 'ul'], ['* ', 'ul'], ['1. ', 'ol'], ['[] ', 'check'], ['[ ] ', 'check'], ['``` ', 'pre']];
function mdShortcut(root) {
  const s = getSelection();
  const node = s.anchorNode;
  if (!s.isCollapsed || !node || node.nodeType !== 3) return false;
  const before = node.textContent.slice(0, s.anchorOffset).replace(/ /g, ' ');
  const rule = MD_RULES.find(r => r[0] === before);
  if (!rule) return false;
  const block = closestIn(node, 'p,div,h1,h2,h3,li,blockquote', root);
  if (!block) return false;
  if (block === root) {
    const prev = node.previousSibling;
    if (node.parentNode !== root || (prev && prev.nodeName !== 'BR' && !/^(P|DIV|H\d|UL|OL|BLOCKQUOTE|PRE|HR)$/.test(prev.nodeName))) return false;
  } else {
    const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    if (tw.nextNode() !== node) return false;
  }
  if (block.tagName === 'LI' && rule[1] !== 'check') return false;
  const rest = node.textContent.slice(s.anchorOffset);
  const r = document.createRange();
  if (rest) { node.textContent = rest; r.setStart(node, 0); }
  else {
    const parent = node.parentNode; const idx = [...parent.childNodes].indexOf(node);
    node.remove();
    if (parent !== root && !parent.firstChild) parent.appendChild(document.createElement('br'));
    r.setStart(parent, Math.min(idx, parent.childNodes.length));
  }
  r.collapse(true); s.removeAllRanges(); s.addRange(r);
  const t = rule[1];
  if (t === 'ul') document.execCommand('insertUnorderedList');
  else if (t === 'ol') document.execCommand('insertOrderedList');
  else if (t === 'check') {
    const ul = closestIn(s.anchorNode, 'ul', root);
    if (block.tagName === 'LI' && ul) ul.classList.add('checklist'); else toggleChecklist(root);
  } else document.execCommand('formatBlock', false, `<${t}>`);
  return true;
}

/* Shared behaviour for every editable rich-text area (note body, capture box, thought cards). */
function setupRich(el, onChange, { onEnter } = {}) {
  markEmpty(el);
  el.addEventListener('input', e => {
    // execCommand can't run inside another command's input event, so convert on the next tick.
    if (e.inputType === 'insertText' && e.data === ' ') setTimeout(() => { if (mdShortcut(el)) { markEmpty(el); onChange(); } });
    markEmpty(el);
    onChange();
  });
  el.addEventListener('keydown', e => {
    if (onEnter && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); onEnter(); return; }
    if (e.key === 'Tab' && closestIn(getSelection().anchorNode, 'li', el)) {
      e.preventDefault(); document.execCommand(e.shiftKey ? 'outdent' : 'indent');
    }
    if (e.key === 'Enter') setTimeout(() => {
      const li = closestIn(getSelection().anchorNode, 'ul.checklist > li', el);
      if (li && li.dataset.checked === 'true' && !li.textContent.trim()) li.dataset.checked = 'false';
    });
  });
  el.addEventListener('paste', async e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); await insertImages(el, files); return; }
    const html = e.clipboardData?.getData('text/html');
    if (html) {
      e.preventDefault();
      document.execCommand('insertHTML', false, sanitize(html));
      await internalize(el);
      onChange();
    }
  });
  el.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  el.addEventListener('drop', async e => {
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    let range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (!range && document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
    }
    await insertImages(el, files, range && el.contains(range.startContainer) ? range : null);
  });
  el.addEventListener('click', e => {
    const li = e.target.closest('ul.checklist > li');
    if (li && e.target === li && el.contains(li) && e.clientX - li.getBoundingClientRect().left < parseFloat(getComputedStyle(li).paddingLeft)) {
      li.dataset.checked = li.dataset.checked === 'true' ? 'false' : 'true';
      onChange();
    }
    const a = e.target.closest('a[href]');
    if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
  });
  el.addEventListener('dblclick', e => {
    if (e.target.tagName === 'IMG') modal(`<img src="${esc(e.target.src)}" alt="">`, null, { cls: 'lightbox' });
  });
}

const TOOLS = [
  ['h1', 'H1', 'Heading'], ['h2', 'H2', 'Subheading'], ['|'],
  ['bold', '<b>B</b>', 'Bold (Ctrl+B)'], ['italic', '<i>I</i>', 'Italic (Ctrl+I)'], ['underline', '<u>U</u>', 'Underline (Ctrl+U)'], ['strikeThrough', '<s>S</s>', 'Strikethrough'], ['|'],
  ['ul', ic('listUl'), 'Bullet list'], ['ol', ic('listOl'), 'Numbered list'], ['check', ic('checksq'), 'Checklist'], ['|'],
  ['quote', ic('quote'), 'Quote'], ['code', ic('code'), 'Code block'], ['link', ic('link'), 'Link'], ['hr', 'HR', 'Divider line'], ['img', ic('image'), 'Insert image'],
];
const toolbarHTML = () => TOOLS.map(([c, label, title]) => c === '|' ? '<span class="sep"></span>' : `<button type="button" data-cmd="${c}" title="${title}">${label}</button>`).join('');

function execTool(cmd, body) {
  if (!body.contains(getSelection().anchorNode)) { body.focus(); caretToEnd(body); }
  const block = (document.queryCommandValue('formatBlock') || '').toLowerCase();
  const fb = tag => document.execCommand('formatBlock', false, block === tag ? '<p>' : `<${tag}>`);
  switch (cmd) {
    case 'h1': case 'h2': fb(cmd); break;
    case 'quote': fb('blockquote'); break;
    case 'code': fb('pre'); break;
    case 'ul': document.execCommand('insertUnorderedList'); break;
    case 'ol': document.execCommand('insertOrderedList'); break;
    case 'check': toggleChecklist(body); break;
    case 'hr': document.execCommand('insertHorizontalRule'); break;
    case 'img': pickImages(body); break;
    case 'link': {
      const sel = getSelection(), range = sel.getRangeAt(0).cloneRange();
      promptDialog('Link to', 'https://', 'Add link').then(url => {
        if (!url) return;
        body.focus(); sel.removeAllRanges(); sel.addRange(range);
        if (range.collapsed) document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url)}</a>&nbsp;`);
        else document.execCommand('createLink', false, url);
      });
      break;
    }
    default: document.execCommand(cmd);
  }
  updateToolbar();
}
function updateToolbar() {
  const body = $('.ed-body'), tb = $('.toolbar');
  if (!body || !tb || !body.contains(getSelection().anchorNode)) return;
  const block = (document.queryCommandValue('formatBlock') || '').toLowerCase();
  const inCheck = !!closestIn(getSelection().anchorNode, 'ul.checklist', body);
  const q = c => document.queryCommandState(c);
  const st = {
    bold: q('bold'), italic: q('italic'), underline: q('underline'), strikeThrough: q('strikeThrough'),
    h1: block === 'h1', h2: block === 'h2', quote: block === 'blockquote', code: block === 'pre',
    ul: !inCheck && q('insertUnorderedList'), ol: q('insertOrderedList'), check: inCheck,
  };
  $$('button[data-cmd]', tb).forEach(b => b.classList.toggle('on', !!st[b.dataset.cmd]));
}

/* ---------- modal, dialogs, toast ---------- */
function modal(html, onMount, { cls = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  $('#modalRoot').appendChild(wrap);
  const m = wrap.firstElementChild;
  const close = () => { if (!wrap.isConnected) return; wrap.remove(); m.onclose?.(); };
  m.close = close;
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
  $$('[data-close]', m).forEach(b => b.addEventListener('click', close));
  onMount?.(m, close);
  requestAnimationFrame(() => {
    const f = m.querySelector('[autofocus]') || m.querySelector('input:not([type=checkbox]),textarea,select,[contenteditable]');
    f?.focus(); if (f?.select && f.hasAttribute('autofocus')) f.select();
  });
  return m;
}
function confirmDialog(title, msg, okLabel = 'Delete', danger = true) {
  return new Promise(res => {
    let ok = false;
    modal(`<h2>${esc(title)}</h2><p class="muted">${esc(msg)}</p>
      <footer><span class="spacer"></span><button class="btn ghost" data-close>Cancel</button>
      <button class="btn ${danger ? 'danger-solid' : 'primary'}" id="cdOk">${esc(okLabel)}</button></footer>`, (m, close) => {
      $('#cdOk', m).onclick = () => { ok = true; close(); };
      m.onclose = () => res(ok);
      setTimeout(() => $('#cdOk', m).focus());
    });
  });
}
function promptDialog(title, value = '', okLabel = 'OK') {
  return new Promise(res => {
    let out = null;
    modal(`<h2>${esc(title)}</h2><input class="input" id="pdIn" value="${esc(value)}" autofocus>
      <footer><span class="spacer"></span><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pdOk">${esc(okLabel)}</button></footer>`, (m, close) => {
      const ok = () => { out = $('#pdIn', m).value.trim() || null; close(); };
      $('#pdOk', m).onclick = ok;
      $('#pdIn', m).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
      m.onclose = () => res(out);
    });
  });
}
let toastTimer;
function toast(msg, action, fn) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { t.classList.remove('show'); fn(); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2500);
}

/* ---------- navigation ---------- */
function cleanupEmpty(id) {
  const n = noteById(id);
  if (n && n.kind === 'note' && !n.title && !n.text && !/<img|<hr/.test(n.html || '')) {
    S.notes = S.notes.filter(x => x !== n);
    DB.del('notes', n.id);
  }
}
function go(view) {
  flushSaves();
  cleanupEmpty(S.noteId);
  if (view.type !== 'search') { $('#search').value = ''; S.query = ''; }
  if (view.type === 'gdd' && S.view.type !== 'gdd') S.gddReturn = S.view;
  S.view = view;
  render();
}
function selectNote(id) {
  if (id === S.noteId) return;
  flushSaves();
  cleanupEmpty(S.noteId);
  S.noteId = id;
  renderList();
  mountEditor();
}
function clearSearch() {
  $('#search').value = '';
  S.query = '';
  if (S.view.type === 'search') { S.view = S.prevView || { type: 'inbox' }; render(); }
}

function render() {
  flushSaves();
  const v = S.view;
  if (v.type !== 'search') { const { item, ...keep } = v; pref.set('view', keep); }
  // Leaving the open board (or opening it on another item): close the editor before the DOM goes.
  if (gddMount && (v.type !== 'gdd' || v.id !== gddMount.id || (v.item || null) !== gddMount.item)) unmountGdd();
  renderNav();
  const c = $('#content');
  c.className = 'content view-' + v.type;
  switch (v.type) {
    case 'home': renderHome(c); break;
    case 'inbox': renderInbox(c); break;
    case 'notes': renderNotes(c, () => S.notes.filter(n => n.kind === 'note'), 'All notes'); break;
    case 'tag': renderNotes(c, () => S.notes.filter(n => n.kind === 'note' && n.tags.includes(v.id)), '#' + v.id, {
      tasks: S.tasks.filter(t => t.tags?.includes(v.id)), exportable: { label: `Tag #${v.id}`, tag: v.id },
    }); break;
    case 'upcoming': renderUpcoming(c); break;
    case 'project': renderProject(c); break;
    case 'search': renderSearch(c); break;
    case 'gdds': renderGdds(c); break;
    case 'gdd': renderGdd(c); break;
  }
  $('#app').classList.remove('nav-open');
}

function renderNav() {
  const v = S.view, t0 = todayStr();
  const open = S.tasks.filter(t => t.due && t.status !== 'done');
  const overdue = open.filter(t => t.due < t0).length, dueNow = open.filter(t => t.due <= t0).length;
  const vt = v.type === 'gdd' ? 'gdds' : v.type; // an open board keeps "GDDs" highlighted
  const is = (type, id) => vt === type && (id == null || v.id === id);
  const item = (type, id, icon, label, count, cls = '') =>
    `<button class="nav-item ${is(type, id) ? 'active' : ''}" data-nav="${type}"${id != null ? ` data-id="${esc(id)}"` : ''}>${icon}<span class="lbl">${esc(label)}</span>${count ? `<em class="count ${cls}">${count}</em>` : ''}</button>`;
  const tags = tagCounts(S.notes.filter(n => n.kind === 'note'), S.tasks);
  const tagsOpen = pref.get('tagsOpen', false) || v.type === 'tag';
  $('#nav').innerHTML = `
    <div class="nav-group">
      ${item('home', null, ic('home'), 'Home', 0)}
      ${item('inbox', null, ic('bolt'), 'Quick thoughts', S.notes.filter(n => n.kind === 'quick').length)}
      ${item('notes', null, ic('note'), 'All notes', S.notes.filter(n => n.kind === 'note').length)}
      ${item('gdds', null, ic('canvas'), 'GDDs', S.boards.length)}
      ${item('upcoming', null, ic('calendar'), 'Upcoming', dueNow, overdue ? 'hot' : '')}
    </div>
    <div class="nav-projects">
      <div class="nav-head"><span>Projects</span><button class="icon-btn xs" data-act="new-project" title="New project">${ic('plus')}</button></div>
      ${S.projects.map(p => {
        const open = S.tasks.filter(t => t.projectId === p.id && t.status !== 'done').length;
        return `<button class="proj-item ${is('project', p.id) ? 'active' : ''}" data-nav="project" data-id="${p.id}" style="--c:${p.color}">${badge(p)}<span class="lbl">${esc(p.name)}</span>${open ? `<em class="count">${open}</em>` : ''}</button>`;
      }).join('')}
      <button class="nav-add" data-act="new-project">${ic('plus')}New project</button>
    </div>
    ${tags.length ? `<details class="nav-tags" ${tagsOpen ? 'open' : ''}><summary>${ic('chev')}Tags<em class="count">${tags.length}</em></summary><div class="tag-cloud">${tags.map(([t, c]) =>
      `<button class="tag ${is('tag', t) ? 'active' : ''}" data-nav="tag" data-id="${esc(t)}">#${esc(t)}<em>${c}</em></button>`).join('')}</div></details>` : ''}`;
  $('.nav-tags', $('#nav'))?.addEventListener('toggle', e => pref.set('tagsOpen', e.target.open));
  $('#tagList').innerHTML = tags.map(([t]) => `<option value="${esc(t)}">`).join('');
  const backupDue = Date.now() - pref.get('lastBackup', pref.get('firstRun', Date.now())) > 7 * 864e5;
  $('#settingsBtn').classList.toggle('alert', backupDue);
  $('#settingsBtn').title = backupDue ? 'Time for a backup, the last one was over a week ago' : 'Backup & data';
}

/* ---------- quick thoughts ---------- */
const captureHTML = id => `<div class="capture">
  <div class="cap-input rich" id="${id}" contenteditable="true" data-placeholder="What's on your mind?"></div>
  <div class="cap-foot">
    <span class="hint"><kbd>Enter</kbd> save · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · paste or drop images</span>
    <span class="cap-btns"><button class="icon-btn cap-img" title="Add image">${ic('image')}</button><button class="btn primary sm cap-save">Save</button></span>
  </div></div>`;
function wireCapture(box, after) {
  const save = async () => {
    const text = box.innerText.trim();
    if (!text && !box.querySelector('img')) return;
    const n = makeNote({ kind: 'quick', html: serialize(box), text });
    S.notes.unshift(n);
    await DB.put('notes', n);
    box.innerHTML = '';
    markEmpty(box);
    after(n);
  };
  setupRich(box, () => {}, { onEnter: save });
  const cap = box.closest('.capture');
  $('.cap-img', cap).onclick = () => pickImages(box);
  $('.cap-save', cap).onclick = save;
}
function openQuickCapture() {
  if ($('#capInline')) { $('#capInline').focus(); return; }
  modal(`<h2>${ic('bolt', 'accent')} Quick thought</h2>${captureHTML('capModal')}`, (m, close) => {
    wireCapture($('#capModal', m), () => {
      close(); renderNav();
      toast('Saved to Quick thoughts', 'View', () => go({ type: 'inbox' }));
    });
  }, { cls: 'capture-modal' });
}
function renderInbox(c) {
  const thoughts = S.notes.filter(n => n.kind === 'quick').sort((a, b) => b.created - a.created);
  c.innerHTML = `<div class="page">
    <div class="page-head"><h1>${ic('bolt', 'accent')} Quick thoughts</h1>
      <p class="sub">Dump whatever pops into your head. Sort it later, or never.</p></div>
    ${captureHTML('capInline')}
    <div class="thoughts">${thoughts.map(n => `<article class="thought" data-id="${n.id}">
      <div class="thought-body rich" contenteditable="true"></div>
      <footer><time title="${new Date(n.created).toLocaleString()}">${rel(n.created)}</time><div class="acts">
        <button class="icon-btn" data-act="th-note" title="Turn into a note">${ic('note')}</button>
        <button class="icon-btn" data-act="th-task" title="Turn into a task">${ic('board')}</button>
        <button class="icon-btn danger" data-act="th-del" title="Delete">${ic('trash')}</button>
      </div></footer></article>`).join('') || '<div class="empty-sm">Nothing here yet. Your brain is suspiciously quiet.</div>'}</div>
  </div>`;
  wireCapture($('#capInline', c), () => { flushSaves(); renderInbox(c); renderNav(); });
  $$('.thought', c).forEach(card => {
    const n = noteById(card.dataset.id), b = $('.thought-body', card);
    b.innerHTML = n.html;
    Img.hydrate(b);
    setupRich(b, () => queueSave(n.id, () => {
      n.html = serialize(b); n.text = b.innerText.trim(); n.updated = Date.now();
      DB.put('notes', n);
    }));
  });
  $('#capInline', c).focus();
}
function renderHome(c) {
  const t7 = addDays(7);
  const dueSoon = S.tasks.filter(t => t.due && t.status !== 'done' && t.due <= t7).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 6);
  const thoughts = S.notes.filter(n => n.kind === 'quick').sort((a, b) => b.created - a.created).slice(0, 5);
  const hour = new Date().getHours();
  const card = p => {
    const tasks = S.tasks.filter(t => t.projectId === p.id);
    const n = s => tasks.filter(t => t.status === s).length;
    const notes = S.notes.filter(x => x.projectId === p.id && x.kind === 'note').length;
    const gdds = S.boards.filter(b => b.projectId === p.id).length;
    const pct = tasks.length ? Math.round(n('done') / tasks.length * 100) : 0;
    const next = tasks.filter(t => t.due && t.status !== 'done').sort((a, b) => a.due.localeCompare(b.due))[0];
    return `<button class="proj-card" data-nav="project" data-id="${p.id}" style="--c:${p.color}">
      <div class="pc-top">${badge(p, 'lg')}<span class="pc-name">${esc(p.name)}</span></div>
      <div class="pc-stats"><span><b>${n('todo')}</b> to do</span><span><b>${n('doing')}</b> in progress</span><span><b>${notes}</b> notes</span>${gdds ? `<span><b>${gdds}</b> GDD${gdds > 1 ? 's' : ''}</span>` : ''}</div>
      <div class="pc-bar" title="${pct}% done"><i style="width:${pct}%"></i></div>
      <div class="pc-foot">${next ? `<span class="due ${dueClass(next)}">${ic('calendar')}${dueLabel(next.due)}</span><span class="pc-next">${esc(next.title)}</span>` : '<span class="muted">No upcoming due dates</span>'}</div>
    </button>`;
  };
  c.innerHTML = `<div class="page home">
    <div class="page-head"><h1>${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}</h1>
      <p class="sub">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p></div>
    ${captureHTML('capInline')}
    <section class="home-sec">
      <div class="sec-head"><h2>Projects</h2><button class="btn sm" data-act="new-project">${ic('plus')}New project</button></div>
      <div class="proj-grid">${S.projects.map(card).join('')}
        <button class="proj-card add" data-act="new-project">${ic('plus')}<span>New project</span></button></div>
    </section>
    <div class="home-cols">
      <section class="home-sec">
        <div class="sec-head"><h2>Due this week</h2><button class="link" data-nav="upcoming">View all</button></div>
        ${dueSoon.map(taskRowHTML).join('') || '<div class="empty-sm boxed">Nothing due this week.</div>'}
      </section>
      <section class="home-sec">
        <div class="sec-head"><h2>Recent thoughts</h2><button class="link" data-nav="inbox">View all</button></div>
        ${thoughts.map(n => `<button class="mini-thought" data-nav="inbox"><span>${esc((n.text || '(image)').replace(/\s+/g, ' ').slice(0, 140))}</span><time>${rel(n.created)}</time></button>`).join('')
          || '<div class="empty-sm boxed">No thoughts yet. Type one above.</div>'}
      </section>
    </div>
  </div>`;
  wireCapture($('#capInline', c), () => { renderHome(c); renderNav(); toast('Saved to Quick thoughts', 'View', () => go({ type: 'inbox' })); });
}
function thoughtToTask(n) {
  const [first = '', ...rest] = (n.text || '').split('\n');
  modal(`<h2>Turn into a task</h2>
    <label class="field"><span>Task</span><input id="ctTitle" value="${esc(first.slice(0, 200))}"></label>
    <div class="row">
      <label class="field"><span>Project</span><select id="ctProj">${S.projects.length ? projectOptions(pref.get('lastProject', S.projects[0].id), false) : '<option value="">New “General” project</option>'}</select></label>
      <label class="field"><span>Due date</span><input type="date" id="ctDue"></label>
    </div>
    <footer><span class="spacer"></span><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="ctOk">Create task</button></footer>`, (m, close) => {
    $('#ctOk', m).onclick = async () => {
      let pid = $('#ctProj', m).value;
      if (!pid) {
        const p = { id: uid(), name: 'General', color: COLORS[0], created: Date.now() };
        S.projects.push(p); await DB.put('projects', p); pid = p.id;
      }
      pref.set('lastProject', pid);
      addTask({ projectId: pid, title: $('#ctTitle', m).value.trim() || 'Untitled task', due: $('#ctDue', m).value || null, desc: rest.join('\n').trim() });
      S.notes = S.notes.filter(x => x !== n);
      DB.del('notes', n.id);
      close(); render();
      toast('Task created', 'Open board', () => go({ type: 'project', id: pid }));
    };
  });
}

/* ---------- notes list + editor ---------- */
function renderNotes(c, source, title, { sub = '', tasks = null, boards = null, exportable = null } = {}) {
  S.listSource = source;
  const notes = sortNotes(source());
  if (!notes.some(n => n.id === S.noteId)) S.noteId = notes[0]?.id || null;
  S.listExport = exportable;
  c.innerHTML = `<div class="split">
    <div class="list-pane">
      <div class="list-head"><div class="lh-title"><h2>${esc(title)}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}</div>
        <div class="lh-acts">${exportable ? `<button class="icon-btn" data-act="export-list" title="Export for Claude">${ic('spark')}</button>` : ''}
        <button class="btn primary sm" data-act="new-note" title="New note (Alt+N)">${ic('plus')}New</button></div></div>
      ${boards?.length ? `<div class="list-tasks list-gdds"><div class="list-sub">GDD boards</div>${boards.slice(0, 8).map(gddRowHTML).join('')}</div>` : ''}
      ${tasks?.length ? `<div class="list-tasks"><div class="list-sub">Tasks</div>${tasks.slice(0, 12).map(taskRowHTML).join('')}</div>` : ''}
      ${tasks?.length || boards?.length ? '<div class="list-sub pad">Notes</div>' : ''}
      <div class="note-list" id="noteList"></div>
    </div>
    <div class="editor-pane" id="editorPane"></div>
  </div>`;
  renderList();
  mountEditor();
}
function renderList() {
  const el = $('#noteList'); if (!el) return;
  const notes = sortNotes(S.listSource());
  el.innerHTML = notes.length ? notes.map(n => {
    const p = proj(n.projectId);
    const snip = (n.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    return `<button class="note-item ${n.id === S.noteId ? 'active' : ''}" data-note="${n.id}">
      <div class="ni-title">${n.pinned ? ic('pin', 'accent') : ''}${n.kind === 'quick' ? ic('bolt', 'accent') : ''}<span>${esc(n.title || 'Untitled')}</span></div>
      ${snip ? `<div class="ni-snip">${esc(snip)}</div>` : ''}
      <div class="ni-meta">${p && S.view.type !== 'project' ? `<span class="chip" style="--c:${p.color}">${esc(p.name)}</span>` : ''}${n.tags.map(t => `<span class="ni-tag">#${esc(t)}</span>`).join('')}${/data-fp|<img/.test(n.html) ? ic('image') : ''}<time>${rel(n.updated)}</time></div>
    </button>`;
  }).join('') : '<div class="empty-sm">No notes here yet.</div>';
}
function mountEditor() {
  const pane = $('#editorPane'); if (!pane) return;
  const n = noteById(S.noteId);
  if (!n) {
    pane.innerHTML = `<div class="empty">${LOGO}<h3>${S.view.type === 'search' ? 'No matching notes' : 'No note selected'}</h3>
      <p>Start one with <kbd>Alt</kbd>+<kbd>N</kbd> or the button below.</p><button class="btn primary" data-act="new-note">${ic('plus')}New note</button></div>`;
    return;
  }
  pane.innerHTML = `<div class="editor">
    <div class="ed-meta">
      ${n.kind === 'quick' ? `<span class="chip">${ic('bolt')}Quick thought</span><button class="btn sm ghost" data-act="promote">Move to notes</button>` : ''}
      <select class="select ed-project" title="Project">${projectOptions(n.projectId)}</select>
      <div class="ed-tags" title="Tags work as sections, e.g. #bugs, #ideas"></div>
      <span class="ed-saved" title="Created ${esc(new Date(n.created).toLocaleString())}">Edited ${rel(n.updated)}</span>
      <button class="icon-btn" data-act="export-note" title="Export this note for Claude">${ic('spark')}</button>
      <button class="icon-btn ${n.pinned ? 'on' : ''}" data-act="pin" title="Pin to top">${ic('pin')}</button>
      <button class="icon-btn danger" data-act="del-note" title="Delete note">${ic('trash')}</button>
    </div>
    <input class="ed-title" placeholder="Untitled" maxlength="200">
    <div class="toolbar">${toolbarHTML()}</div>
    <div class="ed-body rich" contenteditable="true" spellcheck="true" data-placeholder="Start writing… paste or drop images, type # for a heading or [] for a checklist"></div>
  </div>`;
  const body = $('.ed-body', pane), title = $('.ed-title', pane), saved = $('.ed-saved', pane);
  title.value = n.title;
  body.innerHTML = n.html || '';
  Img.hydrate(body);
  const save = () => queueSave(n.id, () => {
    n.title = title.value.trim();
    n.html = serialize(body);
    n.text = body.innerText.trim();
    n.updated = Date.now();
    DB.put('notes', n);
    renderList();
    saved.textContent = 'Saved';
  });
  setupRich(body, save);
  title.addEventListener('input', save);
  title.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); body.focus(); } });
  $('.toolbar', pane).addEventListener('mousedown', e => {
    const b = e.target.closest('[data-cmd]'); if (!b) return;
    e.preventDefault(); execTool(b.dataset.cmd, body);
  });
  $('.ed-project', pane).onchange = e => {
    n.projectId = e.target.value || null; n.updated = Date.now();
    DB.put('notes', n); renderNav(); renderList();
  };
  wireTagEditor($('.ed-tags', pane), n, 'notes', () => { renderList(); });
  if (!n.title && !n.text) title.focus();
}
function wireTagEditor(el, obj, store, after) {
  const draw = () => {
    el.innerHTML = obj.tags.map(t => `<span class="tag-chip">#${esc(t)}<button type="button" data-rm="${esc(t)}" title="Remove">×</button></span>`).join('')
      + `<input class="tag-input" placeholder="${obj.tags.length ? '+ tag' : 'Add tags / sections…'}" list="tagList">`;
  };
  const commit = refocus => {
    obj.updated = Date.now(); DB.put(store, obj); draw(); renderNav(); after?.();
    if (refocus) $('.tag-input', el).focus();
  };
  const addFrom = inp => {
    const t = normTag(inp.value);
    if (t && !obj.tags.includes(t)) obj.tags.push(t);
    inp.value = '';
  };
  draw();
  el.addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { obj.tags = obj.tags.filter(t => t !== rm.dataset.rm); commit(true); }
    else if (e.target === el) $('.tag-input', el).focus();
  });
  el.addEventListener('keydown', e => {
    const inp = e.target.closest('.tag-input'); if (!inp) return;
    if ((e.key === 'Enter' || e.key === ',') && inp.value.trim()) { e.preventDefault(); addFrom(inp); commit(true); }
    else if (e.key === 'Backspace' && !inp.value && obj.tags.length) { obj.tags.pop(); commit(true); }
  });
  el.addEventListener('focusout', e => {
    const inp = e.target.closest?.('.tag-input');
    if (inp?.value.trim()) { addFrom(inp); commit(false); }
  });
}
async function newNote() {
  flushSaves();
  cleanupEmpty(S.noteId);
  const v = S.view;
  const n = makeNote({ projectId: v.type === 'project' ? v.id : null, tags: v.type === 'tag' ? [v.id] : v.type === 'project' ? [...(pref.get('filter.' + v.id, []))] : [] });
  S.notes.unshift(n);
  await DB.put('notes', n);
  S.noteId = n.id;
  if (v.type === 'project') pref.set('tab.' + v.id, 'notes');
  else if (!['notes', 'tag'].includes(v.type)) { $('#search').value = ''; S.view = { type: 'notes' }; }
  render();
  $('.ed-title')?.focus();
}
function deleteNote(n) {
  flushSaves();
  S.notes = S.notes.filter(x => x !== n);
  DB.del('notes', n.id);
  if (S.noteId === n.id) S.noteId = null;
  render();
  toast(n.kind === 'quick' ? 'Thought deleted' : 'Note deleted', 'Undo', () => {
    S.notes.push(n); DB.put('notes', n);
    if (n.kind === 'note') S.noteId = n.id;
    render();
  });
}

/* ---------- tasks ---------- */
function taskRowHTML(t) {
  const p = proj(t.projectId);
  return `<div class="task-row ${t.status === 'done' ? 'is-done' : ''}" data-task="${t.id}">
    <button class="chk ${t.status === 'done' ? 'on' : ''}" data-act="toggle-done" data-id="${t.id}" title="Mark done">${ic('check')}</button>
    <span class="tr-title">${esc(t.title)}</span>
    ${(t.tags || []).map(x => `<span class="ni-tag">#${esc(x)}</span>`).join('')}
    ${p ? `<span class="chip" style="--c:${p.color}">${esc(p.name)}</span>` : ''}
    ${t.due ? `<span class="due ${dueClass(t)}">${ic('calendar')}${dueLabel(t.due)}</span>` : ''}
  </div>`;
}
function setStatus(t, status) {
  if (t.status === status) return;
  t.status = status;
  t.order = Math.max(-1, ...S.tasks.filter(x => x !== t && x.projectId === t.projectId && x.status === status).map(x => x.order)) + 1;
  t.doneAt = status === 'done' ? Date.now() : null;
}
function openTask(t, after) {
  if (!t) return;
  t.tags ||= [];
  const gb = t.gdd && boardById(t.gdd.boardId);
  modal(`
    <div class="tm-head">
      <button class="chk lg ${t.status === 'done' ? 'on' : ''}" id="tmChk" title="Mark done">${ic('check')}</button>
      <textarea class="tm-title" id="tmTitle" rows="1" placeholder="Task name">${esc(t.title)}</textarea>
    </div>
    <div class="tm-grid">
      <label class="field"><span>Status</span><select id="tmStatus">${STATUSES.map(s => `<option value="${s.id}" ${s.id === t.status ? 'selected' : ''}>${s.name}</option>`).join('')}</select></label>
      <label class="field"><span>Due date</span><input type="date" id="tmDue" value="${t.due || ''}"></label>
      <label class="field"><span>Project</span><select id="tmProj">${projectOptions(t.projectId, false)}</select></label>
    </div>
    ${gb ? `<button type="button" class="gdd-from" id="tmGdd" title="Open the board on this item">${ic('canvas')}<span>From GDD: <b>${esc(gb.title)}</b></span>${ic('arrow')}</button>` : ''}
    <div class="field"><span>Tags / sections</span><div class="ed-tags boxed" id="tmTags"></div></div>
    <label class="field"><span>Details</span><textarea id="tmDesc" rows="6" placeholder="Steps, links, repro notes… paste or drop images">${esc(t.desc || '')}</textarea></label>
    <div class="tm-imgs" id="tmImgs"></div>
    <footer><button class="btn ghost danger" id="tmDel">${ic('trash')}Delete</button><span class="spacer"></span>
      <span class="muted small">Created ${rel(t.created)}</span><button class="btn primary" data-close>Done</button></footer>`, (m, close) => {
    const ta = $('#tmTitle', m);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    requestAnimationFrame(grow);
    const sync = () => {
      t.title = ta.value.trim() || 'Untitled task';
      setStatus(t, $('#tmStatus', m).value);
      t.due = $('#tmDue', m).value || null;
      t.projectId = $('#tmProj', m).value;
      t.desc = $('#tmDesc', m).value;
      t.updated = Date.now();
      DB.put('tasks', t);
      $('#tmChk', m).classList.toggle('on', t.status === 'done');
    };
    ta.addEventListener('input', grow);
    ['tmTitle', 'tmStatus', 'tmDue', 'tmProj', 'tmDesc'].forEach(id => {
      $('#' + id, m).addEventListener('input', sync); $('#' + id, m).addEventListener('change', sync);
    });
    wireTagEditor($('#tmTags', m), t, 'tasks');
    wireTaskImages(m, t);
    $('#tmChk', m).onclick = () => { $('#tmStatus', m).value = t.status === 'done' ? 'todo' : 'done'; sync(); };
    $('#tmDel', m).onclick = () => { m.onclose = null; close(); deleteTask(t); after?.(); };
    if (gb) $('#tmGdd', m).onclick = () => { m.onclose = null; close(); go({ type: 'gdd', id: gb.id, item: t.gdd.itemId || null }); after?.(); };
    ta.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); close(); } });
    m.onclose = () => { render(); after?.(); };
  }, { cls: 'task-modal' });
}
// Screenshots attached to a task: kept as t.images (ids in the image store), shown under Details.
function wireTaskImages(m, t) {
  const box = $('#tmImgs', m);
  const draw = () => {
    const ids = t.images || [];
    box.innerHTML = ids.map(id => `<div class="tm-img"><img data-fp="${esc(id)}" alt="" title="Click to view full size"><button class="tm-img-x" data-rm="${esc(id)}" title="Remove image">${ic('x')}</button></div>`).join('')
      + `<button class="tm-img-add" title="Attach images (or paste / drop them on this window)">${ic('image')}<span>${ids.length ? 'Add' : 'Attach image'}</span></button>`;
    Img.hydrate(box);
  };
  const save = () => { t.updated = Date.now(); DB.put('tasks', t); };
  const add = async files => {
    files = files.filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    for (const f of files) { const { id } = await Img.add(f); (t.images ||= []).push(id); }
    save(); draw();
  };
  box.addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { t.images = (t.images || []).filter(x => x !== rm.dataset.rm); save(); draw(); return; }
    if (e.target.closest('.tm-img-add')) {
      const inp = $('#fileImg');
      inp.value = '';
      inp.onchange = () => add([...inp.files]);
      inp.click();
      return;
    }
    if (e.target.tagName === 'IMG') modal(`<img src="${esc(e.target.src)}" alt="">`, null, { cls: 'lightbox' });
  });
  m.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); add(files); }
  });
  m.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); m.classList.add('drop-on'); } });
  m.addEventListener('dragleave', e => { if (!m.contains(e.relatedTarget)) m.classList.remove('drop-on'); });
  m.addEventListener('drop', e => {
    m.classList.remove('drop-on');
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); add(files); }
  });
  draw();
}
function deleteTask(t) {
  S.tasks = S.tasks.filter(x => x !== t);
  DB.del('tasks', t.id);
  render();
  toast('Task deleted', 'Undo', () => { S.tasks.push(t); DB.put('tasks', t); render(); });
}

/* ---------- projects & board ---------- */
function renderProject(c) {
  const p = proj(S.view.id);
  if (!p) { go({ type: 'home' }); return; }
  const tab = pref.get('tab.' + p.id, 'board');
  const filter = pref.get('filter.' + p.id, []);
  const allTasks = S.tasks.filter(t => t.projectId === p.id);
  const allNotes = S.notes.filter(n => n.projectId === p.id && n.kind === 'note');
  const boards = S.boards.filter(b => b.projectId === p.id).sort((a, b) => b.updated - a.updated);
  const pass = x => !filter.length || filter.some(f => x.tags?.includes(f));
  const done = allTasks.filter(t => t.status === 'done').length;
  const pct = allTasks.length ? Math.round(done / allTasks.length * 100) : 0;
  const sections = tagCounts(allNotes, allTasks);
  c.innerHTML = `<div class="proj-head" style="--c:${p.color}">
      <div class="proj-title">${badge(p, 'lg')}<h1>${esc(p.name)}</h1>
        <button class="icon-btn" data-act="edit-project" title="Rename, recolor or delete">${ic('edit')}</button></div>
      <div class="proj-progress" title="${done} of ${allTasks.length} tasks done"><div class="bar"><i style="width:${pct}%"></i></div><span>${done}/${allTasks.length} done</span></div>
      <button class="btn sm claude-btn" data-act="export-project" title="Copy or download this project as Markdown for a Claude session">${ic('spark')}Export for Claude</button>
      <div class="tabs">
        <button class="tab ${tab === 'board' ? 'on' : ''}" data-act="tab" data-tab="board">${ic('board')}Board<em>${allTasks.filter(t => t.status !== 'done').length}</em></button>
        <button class="tab ${tab === 'notes' ? 'on' : ''}" data-act="tab" data-tab="notes">${ic('note')}Notes<em>${allNotes.length}</em></button>
        <button class="tab ${tab === 'gdd' ? 'on' : ''}" data-act="tab" data-tab="gdd">${ic('canvas')}GDD<em>${boards.length}</em></button>
      </div>
    </div>
    ${tab === 'gdd' ? '' : `<div class="sections">
      <span class="sec-label">Sections</span>
      <button class="sec ${filter.length ? '' : 'on'}" data-act="sec" data-tag="">All</button>
      ${sections.map(([t, n]) => `<button class="sec ${filter.includes(t) ? 'on' : ''}" data-act="sec" data-tag="${esc(t)}">#${esc(t)}<em>${n}</em></button>`).join('')}
      <span class="sec-hint">${sections.length ? 'Ctrl-click to pick several' : 'Tag notes or tasks (e.g. <b>bugs</b>, <b>ideas</b>) to split this project into sections'}</span>
    </div>`}
    <div class="proj-body" id="projBody"></div>`;
  const body = $('#projBody', c);
  if (tab === 'board') {
    body.innerHTML = boardHTML(allTasks.filter(pass), filter);
    wireBoard($('#board', body));
  } else if (tab === 'gdd') {
    body.innerHTML = `<div class="proj-gdds">
      <div class="sec-head"><p class="sub">Visual design boards for ${esc(p.name)}. Claude can read them and turn them into tasks.</p>
        <button class="btn primary sm" data-act="new-gdd" data-project="${p.id}">${ic('plus')}New GDD</button></div>
      ${gddGridHTML(boards, { showProject: false, projectId: p.id })}</div>`;
    wireGddCards(body, boards);
  } else {
    renderNotes(body, () => S.notes.filter(n => n.projectId === p.id && n.kind === 'note' && pass(n)), filter.length ? filter.map(f => '#' + f).join(' ') : 'Project notes');
  }
}
function boardHTML(tasks, filter) {
  return `<div class="board" id="board">${STATUSES.map(st => {
    const list = tasks.filter(t => t.status === st.id).sort((a, b) => a.order - b.order);
    return `<section class="col col-${st.id}" data-status="${st.id}">
      <header class="col-head"><span class="col-dot"></span><span>${st.name}</span><em>${list.length}</em>
        ${st.id === 'done' && list.length ? '<button class="link-btn" data-act="clear-done" title="Delete all finished tasks">Clear</button>' : ''}</header>
      <div class="col-cards">${list.map(cardHTML).join('')}</div>
      <form class="add-task" data-status="${st.id}"><input placeholder="+ Add task${filter.length ? ' to #' + esc(filter[0]) : ''}" maxlength="300"></form>
    </section>`;
  }).join('')}</div>`;
}
function cardHTML(t) {
  const meta = [
    t.due ? `<span class="due ${dueClass(t)}">${ic('calendar')}${dueLabel(t.due)}</span>` : '',
    ...(t.tags || []).map(x => `<span class="ni-tag">#${esc(x)}</span>`),
    t.desc?.trim() ? `<span class="muted" title="Has details">${ic('note')}</span>` : '',
    t.images?.length ? `<span class="muted card-imgs" title="${t.images.length} image(s) attached">${ic('image')}${t.images.length > 1 ? t.images.length : ''}</span>` : '',
    t.gdd ? `<span class="muted card-gdd" title="${esc(boardById(t.gdd.boardId) ? 'From GDD: ' + boardById(t.gdd.boardId).title : 'From a GDD board')}">${ic('canvas')}</span>` : '',
  ].join('');
  return `<div class="card ${t.status === 'done' ? 'is-done' : ''}" draggable="true" data-task="${t.id}">
    <div class="card-title">${esc(t.title)}</div>${meta ? `<div class="card-meta">${meta}</div>` : ''}</div>`;
}
function wireBoard(board) {
  let dragEl = null;
  board.addEventListener('dragstart', e => {
    dragEl = e.target.closest('.card'); if (!dragEl) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragEl.dataset.task);
    requestAnimationFrame(() => dragEl?.classList.add('dragging'));
  });
  board.addEventListener('dragover', e => {
    const col = e.target.closest('.col');
    if (!dragEl || !col) return;
    e.preventDefault();
    const list = $('.col-cards', col);
    const after = $$('.card:not(.dragging)', list).find(c => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    if (after) { if (dragEl.nextElementSibling !== after) list.insertBefore(dragEl, after); }
    else if (list.lastElementChild !== dragEl) list.appendChild(dragEl);
    $$('.col', board).forEach(x => x.classList.toggle('drag-over', x === col));
  });
  board.addEventListener('drop', e => {
    if (!dragEl) return;
    e.preventDefault();
    const col = dragEl.closest('.col'), status = col.dataset.status;
    const t = taskById(dragEl.dataset.task);
    if (t.status !== status) { t.status = status; t.doneAt = status === 'done' ? Date.now() : null; }
    $$('.card', col).forEach((card, i) => {
      const x = taskById(card.dataset.task);
      if (x.order !== i || x === t) { x.order = i; x.updated = Date.now(); DB.put('tasks', x); }
    });
  });
  board.addEventListener('dragend', () => { dragEl = null; render(); });
}
function openProjectModal(p) {
  const isNew = !p;
  let color = p?.color || COLORS[S.projects.length % COLORS.length];
  modal(`<h2>${isNew ? 'New project' : 'Edit project'}</h2>
    <label class="field"><span>Name</span><input id="pmName" value="${esc(p?.name || '')}" placeholder="e.g. My game, Website redesign" maxlength="80" autofocus></label>
    <label class="field"><span>Code folder <em class="muted">(optional)</em></span><input id="pmRepo" value="${esc(p?.repoPath || '')}" placeholder="e.g. C:\\code\\my-game or ~/code/my-game" spellcheck="false">
      <small class="muted">The project's code or git folder. Claude sessions opened in this folder pick this project automatically.</small></label>
    <div class="field"><span>Color</span><div class="swatches">${COLORS.map(c => `<button type="button" class="sw ${c === color ? 'on' : ''}" data-c="${c}" style="--c:${c}"></button>`).join('')}</div></div>
    <footer>${isNew ? '' : `<button class="btn ghost danger" id="pmDel">${ic('trash')}Delete project</button>`}<span class="spacer"></span>
      <button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pmOk">${isNew ? 'Create project' : 'Save'}</button></footer>`, (m, close) => {
    $$('.sw', m).forEach(b => b.onclick = () => { color = b.dataset.c; $$('.sw', m).forEach(x => x.classList.toggle('on', x === b)); });
    const ok = async () => {
      const name = $('#pmName', m).value.trim();
      if (!name) { $('#pmName', m).focus(); return; }
      const repoPath = $('#pmRepo', m).value.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '') || null;
      if (isNew) { p = { id: uid(), name, color, repoPath, created: Date.now() }; S.projects.push(p); }
      else Object.assign(p, { name, color, repoPath });
      await DB.put('projects', p);
      close();
      go({ type: 'project', id: p.id });
    };
    $('#pmOk', m).onclick = ok;
    $('#pmName', m).onkeydown = e => { if (e.key === 'Enter') ok(); };
    if (!isNew) $('#pmDel', m).onclick = async () => {
      const notes = S.notes.filter(n => n.projectId === p.id), tasks = S.tasks.filter(t => t.projectId === p.id);
      const boards = S.boards.filter(b => b.projectId === p.id);
      if (!await confirmDialog(`Delete “${p.name}”?`, `This also deletes its ${tasks.length} task(s) and ${notes.length} note(s).${boards.length ? ` Its GDD boards are kept (${boards.length}), just no longer linked.` : ''} It can't be undone (unless you have a backup).`)) return;
      notes.forEach(n => DB.del('notes', n.id));
      tasks.forEach(t => DB.del('tasks', t.id));
      // Design work is never deleted with a project, only unlinked.
      boards.forEach(b => { b.projectId = null; touchMeta(b); DB.put('boards', b).catch(() => {}); });
      DB.del('projects', p.id);
      S.notes = S.notes.filter(n => !notes.includes(n));
      S.tasks = S.tasks.filter(t => !tasks.includes(t));
      S.projects = S.projects.filter(x => x !== p);
      close();
      go({ type: 'home' });
    };
  });
}

/* ---------- GDD boards ---------- */
// Visual game design boards. The canvas editor (gdd.js, window.GDD) and the PNG renderer
// (gdd-render.js, window.GDDRender) are separate files; this part is the gallery, the host the
// editor talks to, previews, and the links between boards, projects and tasks. See PLAN.md.
const THUMB_PH = `<svg class="gc-ph" viewBox="0 0 160 100" aria-hidden="true">
  <g fill="currentColor" opacity=".28">${[...Array(8)].map((_, i) => [...Array(5)].map((_, j) => `<circle cx="${10 + i * 20}" cy="${10 + j * 20}" r="1.2"/>`).join('')).join('')}</g>
  <rect x="16" y="16" width="62" height="42" rx="6" fill="none" stroke="currentColor" stroke-width="2" opacity=".55"/>
  <rect x="24" y="26" width="30" height="16" rx="3" fill="#f7d774" opacity=".7"/>
  <rect x="94" y="22" width="48" height="26" rx="13" fill="none" stroke="#ff8f1f" stroke-width="2"/>
  <path d="M78 40c10 0 14 8 20 24" fill="none" stroke="currentColor" stroke-width="2" opacity=".55"/>
  <path d="m93 61 5 6 2-8" fill="none" stroke="currentColor" stroke-width="2" opacity=".55"/>
  <rect x="88" y="68" width="44" height="18" rx="4" fill="#8cc8ff" opacity=".55"/>
  <path d="M22 78c8-8 14 6 22-2s12 4 18-2" fill="none" stroke="#ff8f1f" stroke-width="2" stroke-linecap="round"/>
</svg>`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const gddTasks = id => S.tasks.filter(t => t.gdd?.boardId === id);
const isStale = b => snap.broken.has(b.id) || !b.previewId || (b.previewAt || 0) < b.updated - 1500;
// Title and project changes don't alter the picture, so a fresh preview stays fresh.
function touchMeta(b) { const fresh = !isStale(b); b.updated = Date.now(); if (fresh) b.previewAt = b.updated; }
const refreshGdd = () => { try { gddMount?.ctl?.refresh?.(); } catch (err) { console.warn('GDD refresh failed', err); } };

function thumbHTML(b) {
  const u = b.items.length && b.previewId && !snap.broken.has(b.id) && (Img.urls.get(b.previewId) || DB.imageURL(b.previewId));
  return u ? `<img src="${esc(u)}" alt="" draggable="false">` : THUMB_PH;
}
function gddCardHTML(b, showProject) {
  const p = showProject && proj(b.projectId), ts = gddTasks(b.id), done = ts.filter(t => t.status === 'done').length;
  const bg = GDDModel.BACKGROUNDS[b.style?.background]?.bg || GDDModel.BACKGROUNDS.dark.bg;
  return `<div class="gdd-card" data-id="${b.id}">
    <button class="gc-open" data-nav="gdd" data-id="${b.id}" title="Open ${esc(b.title)}">
      <span class="gc-thumb" style="--tb:${bg}">${thumbHTML(b)}</span>
      <span class="gc-body"><span class="gc-title">${esc(b.title || 'Untitled GDD')}</span>
        <span class="gc-meta">${p ? `<span class="chip" style="--c:${p.color}">${esc(p.name)}</span>` : ''}<span>${plural(b.items.length, 'item')}</span>${ts.length ? `<span title="Tasks made from this board">${done}/${ts.length} tasks</span>` : ''}<time>${rel(b.updated)}</time></span></span>
    </button>
    <span class="gc-acts"><button class="icon-btn" data-act="gdd-edit" data-id="${b.id}" title="Rename or move to a project">${ic('edit')}</button><button class="icon-btn danger" data-act="gdd-del" data-id="${b.id}" title="Delete">${ic('trash')}</button></span>
  </div>`;
}
function gddGridHTML(boards, { showProject = true, projectId = null } = {}) {
  return `<div class="gdd-grid">${boards.map(b => gddCardHTML(b, showProject)).join('')}
    <button class="gdd-card add" data-act="new-gdd"${projectId ? ` data-project="${projectId}"` : ''}>${ic('plus')}<span>New GDD</span></button></div>`;
}
const gddRowHTML = b => {
  const p = proj(b.projectId);
  return `<button class="task-row gdd-row" data-nav="gdd" data-id="${b.id}">${ic('canvas', 'accent')}<span class="tr-title">${esc(b.title)}</span>
    ${p ? `<span class="chip" style="--c:${p.color}">${esc(p.name)}</span>` : ''}<time>${rel(b.updated)}</time></button>`;
};
// Fills in previews that need loading or rendering for the cards on screen.
function wireGddCards(root, boards) {
  const grid = $('.gdd-grid', root); if (!grid) return;
  // a preview image that won't load (deleted, or a stale id): show the placeholder and render a new one
  grid.addEventListener('error', e => {
    const card = e.target.closest?.('.gdd-card'); if (!card || e.target.tagName !== 'IMG') return;
    snap.broken.add(card.dataset.id);
    e.target.outerHTML = THUMB_PH;
    queuePreviews([boardById(card.dataset.id)].filter(Boolean));
  }, true);
  // IndexedDB mode has no URL until the blob is read
  for (const b of boards) if (b.items.length && b.previewId && !snap.broken.has(b.id) && !Img.urls.has(b.previewId) && !DB.imageURL(b.previewId)) {
    Img.url(b.previewId).then(u => { if (u) updateThumbs(b); else { snap.broken.add(b.id); queuePreviews([b]); } }).catch(() => {});
  }
  queuePreviews(boards);
}
function updateThumbs(b) {
  $$(`.gdd-card[data-id="${b.id}"] .gc-thumb`).forEach(el => { el.innerHTML = thumbHTML(b); });
}

function renderGdds(c) {
  const boards = [...S.boards].sort((a, b) => b.updated - a.updated);
  c.innerHTML = `<div class="page gdd-page">
    <div class="page-head gdd-head"><div><h1>${ic('canvas', 'accent')} GDD boards</h1>
      <p class="sub">Game design docs on a canvas: images, notes, arrows, shapes and doodles. Claude can read them and plan the tasks.</p></div>
      ${boards.length ? `<button class="btn primary" data-act="new-gdd">${ic('plus')}New GDD</button>` : ''}</div>
    ${boards.length ? gddGridHTML(boards) : `<div class="empty tall gdd-empty"><span class="gc-thumb">${THUMB_PH}</span><h3>No GDDs yet</h3>
      <p>Lay out your next game idea: drop in reference images, connect ideas with arrows, explain mechanics in notes.<br>The template starts you off with the usual sections.</p>
      <button class="btn primary" data-act="new-gdd">${ic('plus')}New GDD</button></div>`}
  </div>`;
  wireGddCards(c, boards);
}
function newGddModal(projectId = null) {
  if (!window.GDDModel) { toast("The GDD files didn't load. Reload ForkPad"); return; }
  modal(`<h2>${ic('canvas', 'accent')} New GDD</h2>
    <label class="field"><span>Game or idea</span><input id="ngTitle" placeholder="e.g. Cozy space farming roguelite" maxlength="120" autofocus></label>
    <label class="field"><span>Project</span><select id="ngProj">${projectOptions(projectId)}</select></label>
    <div class="field"><span>Start from</span><div class="checks gdd-start">
      <label><input type="radio" name="ngTpl" value="gdd" checked><span><b>GDD template</b><small class="muted">Sections for pitch, core loop, mechanics, characters, world, art, progression and scope</small></span></label>
      <label><input type="radio" name="ngTpl" value="blank"><span><b>Blank canvas</b><small class="muted">An empty board</small></span></label>
    </div></div>
    <footer><span class="spacer"></span><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="ngOk">Create GDD</button></footer>`, (m, close) => {
    const ok = async () => {
      const b = GDDModel.newBoard({ title: $('#ngTitle', m).value.trim() || 'Untitled GDD', projectId: $('#ngProj', m).value || null, template: $('input[name=ngTpl]:checked', m).value });
      S.boards.push(b);
      close();
      await DB.put('boards', b).catch(() => {});
      go({ type: 'gdd', id: b.id });
    };
    $('#ngOk', m).onclick = ok;
    $('#ngTitle', m).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
  });
}
function editGddModal(b) {
  if (!b) return;
  modal(`<h2>Edit GDD</h2>
    <label class="field"><span>Title</span><input id="egTitle" value="${esc(b.title)}" maxlength="120" autofocus></label>
    <label class="field"><span>Project</span><select id="egProj">${projectOptions(b.projectId)}</select></label>
    <footer><button class="btn ghost danger" id="egDel">${ic('trash')}Delete</button><span class="spacer"></span>
      <button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="egOk">Save</button></footer>`, (m, close) => {
    const ok = () => {
      b.title = $('#egTitle', m).value.trim() || 'Untitled GDD';
      b.projectId = $('#egProj', m).value || null;
      touchMeta(b);
      DB.put('boards', b).catch(() => {});
      close(); render();
    };
    $('#egOk', m).onclick = ok;
    $('#egTitle', m).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
    $('#egDel', m).onclick = () => { close(); deleteBoard(b); };
  });
}
async function deleteBoard(b) {
  if (!b) return;
  const n = gddTasks(b.id).length;
  if (!await confirmDialog(`Delete “${b.title}”?`, `The board and everything on it is deleted.${n ? ` The ${plural(n, 'task')} made from it ${n === 1 ? 'stays' : 'stay'} on its project.` : ''}`)) return;
  if (gddMount?.id === b.id) { S.view = { type: 'gdds' }; unmountGdd(); }
  clearTimeout(snap.timers.get(b.id)); snap.timers.delete(b.id);
  S.boards = S.boards.filter(x => x !== b);
  DB.del('boards', b.id).catch(() => {});
  if (b.previewId) { dropImage(b.previewId); b.previewId = null; b.previewAt = 0; }
  render();
  toast('GDD deleted', 'Undo', () => { S.boards.push(b); DB.put('boards', b).catch(() => {}); render(); });
}

/* the open board */
function renderGdd(c) {
  const v = S.view, b = boardById(v.id);
  if (!b) { go({ type: 'gdds' }); return; }
  if (gddMount) { if (gddMount.el.isConnected) return; unmountGdd(); } // already open: render() runs often
  if (!window.GDD?.mount) {
    c.innerHTML = `<div class="empty">${LOGO}<h3>The GDD editor didn't load</h3><p>gdd.js is missing or failed to start. Reload ForkPad, or update it if this keeps happening.</p>
      <button class="btn" data-nav="gdds">Back to GDDs</button></div>`;
    return;
  }
  c.innerHTML = '<div class="gdd-host"></div>';
  const el = c.firstElementChild;
  try {
    const ctl = GDD.mount(el, b, gddHost, { focusItem: v.item || null });
    gddMount = { id: b.id, item: v.item || null, el, ctl };
  } catch (err) {
    console.error('GDD editor failed', err);
    c.innerHTML = `<div class="empty">${LOGO}<h3>This GDD couldn't be opened</h3><p>${esc(err?.message || 'The editor ran into a problem.')}</p>
      <button class="btn" data-nav="gdds">Back to GDDs</button></div>`;
  }
}
let gddDiscard = null; // board id whose last editor save must be dropped (loading someone else's version)
function unmountGdd() {
  const m = gddMount; if (!m) return;
  gddMount = null; // first, so a flush from destroy() can't reach the closed editor again
  try { m.ctl?.destroy?.(); } catch (err) { console.warn('GDD destroy failed', err); }
  m.el.remove();
  // leaving the board: take its snapshot now so the gallery is up to date
  if (snap.timers.has(m.id)) { clearTimeout(snap.timers.get(m.id)); snap.timers.delete(m.id); snapshotBoard(m.id); }
}

/* snapshots: a PNG of each board, for the gallery and for Claude (get_gdd) */
const snap = { timers: new Map(), running: new Set(), again: new Set(), broken: new Set(), failed: new Set(), queue: [], pumping: false };
const imgData = new Map(); // image id -> data URL (images never change under an id)
async function resolveImage(id) {
  if (imgData.has(id)) return imgData.get(id);
  const rec = await DB.get('images', id);
  if (!rec?.blob) return null;
  const url = await blobToDataURL(rec.blob);
  if (imgData.size >= 40) imgData.delete(imgData.keys().next().value);
  imgData.set(id, url);
  return url;
}
function dropImage(id) {
  DB.del('images', id).catch(() => {});
  const u = Img.urls.get(id);
  if (u) { URL.revokeObjectURL(u); Img.urls.delete(id); }
  imgData.delete(id);
}
function scheduleSnapshot(id, ms = 2000) {
  clearTimeout(snap.timers.get(id));
  snap.timers.set(id, setTimeout(() => { snap.timers.delete(id); snapshotBoard(id); }, ms));
}
// Renders the board and stores the PNG as its new preview. Resolves true/false, or null when one
// is already running (it re-runs after). Never throws: a failed snapshot must not break editing.
async function snapshotBoard(id) {
  if (snap.running.has(id)) { snap.again.add(id); return null; }
  const b = boardById(id);
  if (!b || !window.GDDRender?.toPNG) return false;
  snap.running.add(id);
  let ok = false;
  try {
    const from = b.updated;
    const blob = await GDDRender.toPNG(b, { resolveImage, maxSide: 2000 });
    const live = boardById(id);
    if (blob && live) {
      const pid = uid(), now = Date.now(), old = live.previewId;
      await DB.put('images', { id: pid, blob, created: now });
      // previewAt tells which edit the picture shows; updated is left alone (a snapshot isn't an edit)
      const at = upd => upd > from ? from : now;
      Object.assign(live, { previewId: pid, previewAt: at(live.updated) });
      let rec = live;
      if (gddMount?.id !== id) { // a closed board: if the file got newer meanwhile (Claude), patch that instead
        const disk = await DB.get('boards', id).catch(() => null);
        if (disk && disk.updated > live.updated) rec = Object.assign(disk, { previewId: pid, previewAt: at(disk.updated) });
      }
      await DB.put('boards', rec);
      if (old && old !== pid) dropImage(old);
      snap.broken.delete(id);
      updateThumbs(live);
      ok = true;
    }
  } catch (err) { console.warn('GDD snapshot failed', err); }
  finally {
    snap.running.delete(id);
    if (snap.again.delete(id)) scheduleSnapshot(id, 300);
  }
  return ok;
}
// Stale previews of the cards on screen are rendered lazily, one board at a time.
function queuePreviews(boards) {
  if (!window.GDDRender?.toPNG) return;
  for (const b of boards) if (b.items.length && isStale(b) && !snap.failed.has(b.id) && !snap.queue.includes(b.id)) snap.queue.push(b.id);
  pumpPreviews();
}
async function pumpPreviews() {
  if (snap.pumping) return;
  snap.pumping = true;
  try {
    while (snap.queue.length) {
      const id = snap.queue.shift(), b = boardById(id);
      if (!b || !isStale(b) || gddMount?.id === id) continue;
      if (await snapshotBoard(id) === false) snap.failed.add(id);
    }
  } finally { snap.pumping = false; }
}

// Claude edited the boards on disk. The open board is never overwritten in place: the editor decides.
let gddPending = null; // a newer outside version of the open board, held until the editor is idle
function syncBoards(fresh) {
  const open = gddMount && boardById(gddMount.id);
  const disk = open && fresh.find(b => b.id === open.id);
  if (open && !disk) { S.boards = mergeInto(S.boards, fresh); goneOutside(open); return; }
  S.boards = mergeInto(S.boards, fresh, open || null);
  // our own saves come back with the same (or an older) updated; only a newer one is someone else's
  if (!disk || !(disk.updated > open.updated)) return;
  gddPending = disk;
  retryGddReload();
}
// reload() edits the editor's board (`open`, already in S.boards) in place, so nothing is swapped.
// Refused while the editor is busy (typing, dragging): wait and try again. Refused while idle, or
// edited locally since, means unsaved or newer local work: then the user picks.
function retryGddReload() {
  const disk = gddPending;
  if (!disk) return;
  if (gddMount?.id !== disk.id) { gddPending = null; return; }
  if (gddBusy()) return;
  gddPending = null;
  const open = boardById(disk.id);
  let took = false;
  if (open && disk.updated > open.updated) {
    try { took = typeof gddMount.ctl?.reload === 'function' && gddMount.ctl.reload(disk) !== false; } catch (err) { console.warn('GDD reload failed', err); }
  }
  if (!took) toast('This GDD was also changed outside ForkPad', 'Load theirs', () => loadTheirs(disk));
}
// Claude deleted the open board. Close it (its file is gone), but keep the object for a 'Keep it'.
function goneOutside(b) {
  gddPending = null;
  clearTimeout(snap.timers.get(b.id)); snap.timers.delete(b.id);
  gddDiscard = b.id; unmountGdd(); gddDiscard = null;
  S.boards = S.boards.filter(x => x !== b);
  b.previewId = null; b.previewAt = 0; // the connector already deleted the preview image
  if (S.view.type === 'gdd' && S.view.id === b.id) S.view = { type: 'gdds' };
  render();
  toast('This GDD was deleted outside ForkPad', 'Keep it', () => {
    b.updated = Date.now();
    if (!boardById(b.id)) S.boards.push(b);
    DB.put('boards', b).catch(() => {});
    scheduleSnapshot(b.id);
    render();
  });
}
function loadTheirs(disk) {
  gddPending = null;
  if (gddMount?.id === disk.id) { gddDiscard = disk.id; unmountGdd(); gddDiscard = null; }
  disk.updated = Date.now(); // newer than anything the closed editor wrote
  const i = S.boards.findIndex(b => b.id === disk.id);
  if (i >= 0) S.boards[i] = disk; else S.boards.push(disk);
  DB.put('boards', disk).catch(() => {});
  scheduleSnapshot(disk.id);
  render();
}

// Asks which project a task from an unlinked board goes to; the board gets linked to it too.
function pickProjectForBoard(board) {
  return new Promise(res => {
    let out = null;
    modal(`<h2>Which project gets this task?</h2>
      <p class="muted small">“${esc(board.title)}” isn't linked to a project yet. Pick one and the GDD is linked to it as well.</p>
      <label class="field"><span>Project</span><select id="gpProj"><option value="">New project “${esc(board.title.slice(0, 80))}”</option>${projectOptions(null, false)}</select></label>
      <footer><span class="spacer"></span><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="gpOk">Add task</button></footer>`, (m, close) => {
      $('#gpOk', m).onclick = async () => {
        let pid = $('#gpProj', m).value;
        if (!pid) {
          const p = { id: uid(), name: board.title.slice(0, 80) || 'My game', color: COLORS[S.projects.length % COLORS.length], created: Date.now() };
          S.projects.push(p); await DB.put('projects', p).catch(() => {}); pid = p.id;
        }
        out = pid; close();
      };
      m.onclose = () => res(out);
    });
  });
}
function gddPrompt(b) {
  const p = proj(b.projectId);
  return `Please read my ForkPad GDD "${b.title}" (id ${b.id}) with the ForkPad connector: call get_gdd, look at the board snapshot, and open the images on it with get_image so you see the layout, the diagrams and any doodles.

Then turn it into a build plan:
1. ${p ? `Use the ForkPad project "${p.name}" it is linked to.` : 'Create a ForkPad project for this game (or reuse a matching one) and link the GDD to it with update_gdd.'}
2. Add concrete tasks with add_tasks, in the order I should build them (first playable first). Keep each one to the point: what to build, and how I can tell it is done.
3. Tag every task with its GDD section (for example #core-loop, #mechanics, #art) and set gdd_item to the board item it comes from.
4. Skip anything that already has a linked task (get_gdd lists them).

Finish with a short summary of the plan and any open design questions.`;
}

// What the editor can ask of the app (contract in PLAN.md).
const gddHost = {
  save(board) {
    if (!board?.id || gddDiscard === board.id) return;
    const i = S.boards.findIndex(x => x.id === board.id);
    if (i < 0) S.boards.push(board); else S.boards[i] = board; // the editor's object is the live one
    DB.put('boards', board).catch(err => console.warn('GDD save failed', err));
    scheduleSnapshot(board.id);
  },
  back() {
    const r = S.gddReturn;
    go(r && !['search', 'gdd'].includes(r.type) ? r : { type: 'gdds' });
  },
  imageURL: id => Img.url(id),
  async addImage(file) {
    const { id, url } = await Img.add(file);
    const [width, height] = await new Promise(res => {
      const im = new Image();
      im.onload = () => res([im.naturalWidth, im.naturalHeight]);
      im.onerror = () => res([0, 0]);
      im.src = url;
    });
    return { id, url, width, height };
  },
  projects: () => S.projects.map(({ id, name, color }) => ({ id, name, color })),
  tasksFor: boardId => gddTasks(boardId),
  openTask: task => openTask(typeof task === 'string' ? taskById(task) : task, refreshGdd),
  // Returns the Task right away when the board has a project, otherwise a Promise<Task|null>
  // after asking for one (so callers should await it).
  createTask({ title = '', desc = '', projectId = null, gdd = null } = {}) {
    const board = boardById(gdd?.boardId) || (gddMount && boardById(gddMount.id));
    const make = pid => {
      const [first = '', ...rest] = String(title).trim().split('\n');
      const t = addTask({ projectId: pid, title: first.trim().slice(0, 200) || 'Untitled task', desc: desc || rest.join('\n').trim(), gdd: gdd?.boardId ? gdd : board && { boardId: board.id } });
      renderNav();
      refreshGdd();
      toast('Task added', 'Open board', () => { pref.set('tab.' + pid, 'board'); go({ type: 'project', id: pid }); });
      return t;
    };
    const pid = [projectId, board?.projectId].find(x => x && proj(x));
    if (pid) return make(pid);
    if (!board) return null;
    return pickProjectForBoard(board).then(id => {
      if (!id) return null;
      gddHost.setProject(board, id);
      return make(id);
    });
  },
  setProject(board, projectId) {
    board.projectId = projectId && proj(projectId) ? projectId : null;
    touchMeta(board);
    DB.put('boards', board).catch(() => {});
    renderNav();
  },
  async exportPNG(board) {
    if (!window.GDDRender?.toPNG) { toast("The board renderer didn't load"); return; }
    try {
      download(await GDDRender.toPNG(board, { resolveImage }), `forkpad-gdd-${slug(board.title || 'board')}.png`);
      toast('PNG exported');
    } catch (err) { console.warn('GDD export failed', err); toast("Couldn't export this board as a PNG"); }
  },
  async askClaude(board) {
    try { gddMount?.ctl?.flush?.(); } catch { /* the save below still runs */ }
    // a fresh snapshot, so Claude sees what is on screen now
    clearTimeout(snap.timers.get(board.id)); snap.timers.delete(board.id);
    snapshotBoard(board.id);
    if (await copyText(gddPrompt(board))) toast('Prompt copied, paste it into Claude Code');
    else toast("Couldn't access the clipboard");
  },
};

/* ---------- upcoming & search ---------- */
function renderUpcoming(c) {
  const t0 = todayStr(), t1 = addDays(1), t7 = addDays(7);
  const open = S.tasks.filter(t => t.status !== 'done').sort((a, b) => (a.due || '9').localeCompare(b.due || '9') || a.order - b.order);
  const groups = [
    ['Overdue', t => t.due && t.due < t0, 'overdue'], ['Today', t => t.due === t0, 'today'], ['Tomorrow', t => t.due === t1],
    ['Next 7 days', t => t.due > t1 && t.due <= t7], ['Later', t => t.due > t7], ['In progress · no date', t => !t.due && t.status === 'doing'],
  ];
  const html = groups.map(([name, f, cls = '']) => {
    const list = open.filter(f);
    return list.length ? `<section class="due-group"><h3 class="${cls}">${name}<em>${list.length}</em></h3>${list.map(taskRowHTML).join('')}</section>` : '';
  }).join('');
  c.innerHTML = `<div class="page">
    <div class="page-head"><h1>${ic('calendar', 'accent')} Upcoming</h1><p class="sub">Everything with a due date (and anything in progress), across all projects.</p></div>
    ${html || `<div class="empty tall">${LOGO}<h3>All clear</h3><p>Nothing due. Give a task a due date and it shows up here.</p></div>`}
  </div>`;
}
function searchHay(x) {
  return [x.title, x.text, x.desc, proj(x.projectId)?.name, ...(x.tags || []).map(t => '#' + t)].join(' ').toLowerCase();
}
function renderSearch(c) {
  const toks = S.query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = x => toks.every(t => searchHay(x).includes(t));
  const boardHit = b => { const hay = (GDDModel.boardText(b) + ' ' + (proj(b.projectId)?.name || '')).toLowerCase(); return toks.every(t => hay.includes(t)); };
  renderNotes(c, () => S.notes.filter(hit), 'Search', {
    sub: `“${esc(S.query)}”`, tasks: S.tasks.filter(hit), boards: S.boards.filter(boardHit).sort((a, b) => b.updated - a.updated),
    exportable: { label: `Search “${S.query}”`, search: hit },
  });
}

/* ---------- export for Claude ---------- */
function nodeToMd(node, ctx) {
  if (node.nodeType === 3) return node.textContent.replace(/ /g, ' ');
  if (node.nodeType !== 1) return '';
  const kids = () => [...node.childNodes].map(n => nodeToMd(n, ctx)).join('');
  const block = s => `\n\n${s.trim()}\n\n`;
  switch (node.tagName) {
    case 'BR': return '  \n';
    case 'B': case 'STRONG': { const k = kids(); return k.trim() ? `**${k.trim()}**` : k; }
    case 'I': case 'EM': { const k = kids(); return k.trim() ? `*${k.trim()}*` : k; }
    case 'S': case 'STRIKE': case 'DEL': return `~~${kids()}~~`;
    case 'CODE': return node.closest('pre') ? node.textContent : '`' + node.textContent + '`';
    case 'A': return `[${kids()}](${node.getAttribute('href')})`;
    case 'H1': return block('# ' + kids());
    case 'H2': return block('## ' + kids());
    case 'H3': return block('### ' + kids());
    case 'HR': return block('---');
    case 'PRE': return block('```\n' + node.textContent.replace(/\n$/, '') + '\n```');
    case 'BLOCKQUOTE': return block(kids().trim().split('\n').map(l => '> ' + l).join('\n'));
    case 'IMG': {
      const id = node.dataset.fp;
      if (!id) return node.getAttribute('src')?.startsWith('http') ? `![image](${node.getAttribute('src')})` : '';
      ctx.images.add(id);
      return block(`![screenshot](images/${id}.${ctx.ext(id)})`);
    }
    case 'UL': case 'OL': {
      const depth = ctx.depth++;
      const items = [...node.children].filter(li => li.tagName === 'LI').map((li, i) => {
        const marker = node.classList.contains('checklist') ? `- [${li.dataset.checked === 'true' ? 'x' : ' '}]` : node.tagName === 'OL' ? `${i + 1}.` : '-';
        const inner = [...li.childNodes].map(n => nodeToMd(n, ctx)).join('').trim().replace(/\n{2,}/g, '\n');
        return '  '.repeat(depth) + marker + ' ' + inner;
      });
      ctx.depth--;
      return depth ? '\n' + items.join('\n') : block(items.join('\n'));
    }
    case 'P': case 'DIV': return block(kids());
    default: return kids();
  }
}
function htmlToMd(html, ctx) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return nodeToMd(div, ctx).replace(/\n{3,}/g, '\n\n').trim();
}
async function buildExport({ label, notes, tasks, includeDone, includeQuick, boards = [] }) {
  const imgRecs = new Map((await DB.all('images')).map(i => [i.id, i]));
  const extOf = id => (imgRecs.get(id)?.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const ctx = { images: new Set(), depth: 0, ext: extOf };
  const L = [];
  L.push(`# ForkPad export: ${label}`, '', `_Exported ${new Date().toLocaleString()} from my ForkPad notes app._`, '');
  L.push('> **Context for Claude:** these are my own notes and tasks for this project, exported from my note-taking app. Use them as background for what I ask next. Checkbox items `[x]` are done.', '');
  const t = tasks.filter(x => includeDone || x.status !== 'done');
  if (t.length) {
    L.push('## Tasks', '');
    for (const st of STATUSES) {
      const list = t.filter(x => x.status === st.id).sort((a, b) => a.order - b.order);
      if (!list.length) continue;
      L.push(`### ${st.name}`, '');
      for (const x of list) {
        const bits = [x.due && `due ${x.due}`, ...(x.tags || []).map(g => '#' + g)].filter(Boolean);
        L.push(`- [${x.status === 'done' ? 'x' : ' '}] **${x.title}**${bits.length ? ` _(${bits.join(', ')})_` : ''}`);
        if (x.desc?.trim()) L.push(...x.desc.trim().split('\n').map(l => '  ' + l));
        for (const id of (x.images || []).filter(id => imgRecs.has(id))) { ctx.images.add(id); L.push(`  ![screenshot](images/${id}.${extOf(id)})`); }
      }
      L.push('');
    }
  }
  const ns = sortNotes(notes.filter(n => includeQuick || n.kind === 'note'));
  if (ns.length) {
    L.push('## Notes', '');
    for (const n of ns) {
      L.push(`### ${n.title || (n.kind === 'quick' ? 'Quick thought' : 'Untitled note')}`);
      const meta = [n.tags.length && n.tags.map(g => '#' + g).join(' '), `updated ${new Date(n.updated).toLocaleDateString()}`].filter(Boolean);
      L.push(`_${meta.join(' · ')}_`, '', htmlToMd(n.html, ctx) || '_(empty)_', '');
    }
  }
  if (boards.length && window.GDDModel) {
    L.push('## GDDs', '', '_Visual game design boards. Ids in backticks are board and item ids for the ForkPad connector (get_gdd, gdd_item)._', '');
    for (const b of boards) {
      const { md, images } = GDDModel.boardToMarkdown(b, {
        imageRef: id => `images/${id}.${extOf(id)}`,
        projectName: proj(b.projectId)?.name || null,
        taskLookup: itemId => S.tasks.filter(x => x.gdd?.boardId === b.id && x.gdd.itemId === itemId),
      });
      images.filter(id => imgRecs.has(id)).forEach(id => ctx.images.add(id));
      // nest the board's own headings under "## GDDs"
      L.push(md.trim().replace(/^(#+) /gm, '##$1 '), '');
      if (b.previewId && imgRecs.has(b.previewId)) { ctx.images.add(b.previewId); L.push(`Snapshot of the whole board: ![${b.title}](images/${b.previewId}.${extOf(b.previewId)})`, ''); }
    }
  }
  if (!t.length && !ns.length && !boards.length) L.push('_Nothing matched this selection._');
  const imageFiles = [...ctx.images].filter(id => imgRecs.has(id)).map(id => ({ name: `images/${id}.${extOf(id)}`, id }));
  return { md: L.join('\n').replace(/\n{3,}/g, '\n\n') + '\n', imageFiles };
}

// Minimal ZIP writer (stored, no compression) so exports can carry screenshots.
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
async function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const data = f.text != null ? enc.encode(f.text) : new Uint8Array(await (f.blob || (await DB.get('images', f.id)).blob).arrayBuffer());
    const name = enc.encode(f.name), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, name.length, 2], [28, 0, 2]]
      .forEach(([o, v, s]) => s === 4 ? h.setUint32(o, v, true) : h.setUint16(o, v, true));
    const c = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
      .forEach(([o, v, s]) => s === 4 ? c.setUint32(o, v, true) : c.setUint16(o, v, true));
    parts.push(h, name, data);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, x) => a + x.byteLength, 0);
  const e = new DataView(new ArrayBuffer(22));
  [[0, 0x06054b50, 4], [8, files.length, 2], [10, files.length, 2], [12, cdSize, 4], [16, offset, 4]]
    .forEach(([o, v, s]) => s === 4 ? e.setUint32(o, v, true) : e.setUint16(o, v, true));
  return new Blob([...parts, ...central, e], { type: 'application/zip' });
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    return ok;
  }
}
const slug = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 50) || 'export';

/* scope: { label, notes, tasks, sections? (tags to choose from), projectId? } */
function openExport(scope) {
  const opts = { sel: new Set(scope.preselect || []), includeDone: false, includeQuick: true, includeTasks: true, includeNotes: true, includeGdds: true };
  const boards = scope.boards || [];
  const sections = scope.sections || [];
  modal(`<h2>${ic('spark', 'accent')} Export for Claude</h2>
    <p class="muted small">Builds a Markdown brief of <b>${esc(scope.label)}</b>. Copy it into any Claude chat or Claude Code session, or download a .zip that also includes the screenshots.</p>
    ${sections.length ? `<div class="field"><span>Sections (none selected = everything)</span><div class="sections inline">${sections.map(([t, n]) =>
      `<button type="button" class="sec ${opts.sel.has(t) ? 'on' : ''}" data-x-tag="${esc(t)}">#${esc(t)}<em>${n}</em></button>`).join('')}</div></div>` : ''}
    <div class="checks">
      ${scope.tasks.length ? '<label><input type="checkbox" id="exTasks" checked> Tasks</label><label><input type="checkbox" id="exDone"> Include finished tasks</label>' : ''}
      ${scope.notes.length ? '<label><input type="checkbox" id="exNotes" checked> Notes</label>' : ''}
      ${boards.length ? `<label><input type="checkbox" id="exGdds" checked> GDD boards (${boards.length})</label>` : ''}
    </div>
    <div class="field"><span class="ex-stats" id="exStats"></span><textarea id="exPreview" class="preview" readonly rows="12"></textarea></div>
    <footer><span class="muted small" id="exImgs"></span><span class="spacer"></span>
      <button class="btn" id="exZip">${ic('download')}Download .zip</button>
      <button class="btn primary" id="exCopy">${ic('copy')}Copy for Claude</button></footer>`, m => {
    let result;
    const refresh = async () => {
      const passes = x => !opts.sel.size || (x.tags || []).some(t => opts.sel.has(t));
      const label = scope.label + (opts.sel.size ? ` (${[...opts.sel].map(t => '#' + t).join(', ')})` : '');
      result = await buildExport({
        label,
        notes: opts.includeNotes ? scope.notes.filter(passes) : [],
        tasks: opts.includeTasks ? scope.tasks.filter(passes) : [],
        includeDone: opts.includeDone, includeQuick: opts.includeQuick,
        boards: opts.includeGdds ? boards : [], // boards have no tags, so the section filter doesn't apply
      });
      result.label = label;
      $('#exPreview', m).value = result.md;
      $('#exStats', m).textContent = `Preview · ${result.md.length.toLocaleString()} characters · ~${Math.ceil(result.md.length / 4).toLocaleString()} tokens`;
      $('#exImgs', m).textContent = result.imageFiles.length ? `${result.imageFiles.length} image(s), included in the .zip only` : '';
    };
    m.addEventListener('click', e => {
      const b = e.target.closest('[data-x-tag]'); if (!b) return;
      const t = b.dataset.xTag;
      opts.sel.has(t) ? opts.sel.delete(t) : opts.sel.add(t);
      b.classList.toggle('on', opts.sel.has(t));
      refresh();
    });
    m.addEventListener('change', () => {
      opts.includeTasks = $('#exTasks', m)?.checked ?? false;
      opts.includeDone = $('#exDone', m)?.checked ?? false;
      opts.includeNotes = $('#exNotes', m)?.checked ?? false;
      opts.includeGdds = $('#exGdds', m)?.checked ?? false;
      refresh();
    });
    $('#exCopy', m).onclick = async () => {
      if (await copyText(result.md)) toast(result.imageFiles.length ? 'Copied! (images are in the .zip download)' : 'Copied! Paste it into Claude');
      else toast("Couldn't access the clipboard. Select the preview and copy it");
    };
    $('#exZip', m).onclick = async () => {
      const name = 'forkpad-' + slug(result.label);
      download(await makeZip([{ name: 'README.md', text: result.md }, ...result.imageFiles]), name + '.zip');
      toast('Downloaded ' + name + '.zip');
    };
    refresh();
  }, { cls: 'export-modal' });
}
function exportProject(p) {
  const notes = S.notes.filter(n => n.projectId === p.id), tasks = S.tasks.filter(t => t.projectId === p.id);
  const boards = S.boards.filter(b => b.projectId === p.id).sort((a, b) => a.created - b.created);
  openExport({ label: `Project: ${p.name}`, notes, tasks, boards, sections: tagCounts(notes, tasks), preselect: pref.get('filter.' + p.id, []) });
}

/* ---------- backup ---------- */
async function openSettings() {
  const info = await DB.info().catch(() => null);
  const last = pref.get('lastBackup', 0);
  modal(`<h2>Backup &amp; data</h2>
    ${DB.local
      ? '<p class="muted">This window was opened as a plain file, so data here stays inside this browser. Start ForkPad with its launcher (or npm start) to use the version Claude can read.</p>'
      : `<p class="muted">ForkPad keeps everything as plain files in <code>${esc(info?.dataDir || 'the data folder')}</code> on this computer. Nothing is uploaded anywhere. Claude Code sessions can read and update it through the ForkPad connector. Export a backup now and then.</p>`}
    <div class="stat-grid">
      <div><b>${S.notes.length}</b><span>notes &amp; thoughts</span></div><div><b>${S.tasks.length}</b><span>tasks</span></div>
      <div><b>${S.projects.length}</b><span>projects${S.boards.length ? ` · ${S.boards.length} GDDs` : ''}</span></div><div><b>${info?.bytes != null ? fmtBytes(info.bytes) : '-'}</b><span>storage used</span></div>
    </div>
    <p class="small muted">Last backup: <b>${last ? rel(last) : 'never'}</b></p>
    <footer><button class="btn ghost" id="stImport">${ic('upload')}Import backup…</button><span class="spacer"></span>
      <button class="btn primary" id="stExport">${ic('download')}Export backup</button></footer>
    <div class="shortcuts"><h3>Keyboard shortcuts</h3>
      <div><kbd>Alt</kbd>+<kbd>Q</kbd><span>Quick thought (from anywhere)</span></div>
      <div><kbd>Alt</kbd>+<kbd>N</kbd><span>New note</span></div>
      <div><kbd>Ctrl</kbd>+<kbd>K</kbd><span>Search everything</span></div>
      <div><kbd>Ctrl</kbd>+click<span>Open a link inside a note</span></div>
      <div><kbd>#</kbd> <kbd>-</kbd> <kbd>1.</kbd> <kbd>[]</kbd> <kbd>&gt;</kbd> + space<span>Heading, bullets, numbers, checklist, quote</span></div>
      <div>Double-click image<span>View full size</span></div>
      <div><kbd>V</kbd> <kbd>T</kbd> <kbd>N</kbd> <kbd>P</kbd> <kbd>A</kbd><span>GDD board: select, text, note, pen, arrow</span></div>
      <div><kbd>?</kbd> on a GDD board<span>All board shortcuts</span></div>
    </div>`, (m, close) => {
    $('#stExport', m).onclick = async () => { await exportBackup(); close(); };
    $('#stImport', m).onclick = () => {
      const inp = $('#fileImport'); inp.value = '';
      inp.onchange = () => { close(); importBackup(inp.files[0]); };
      inp.click();
    };
  });
}
async function exportBackup() {
  flushSaves();
  const images = await Promise.all((await DB.all('images')).map(async i => ({ id: i.id, created: i.created, data: await blobToDataURL((await DB.get('images', i.id)).blob) })));
  const data = { app: 'ForkPad', version: 1, exported: new Date().toISOString(), projects: S.projects, notes: S.notes, tasks: S.tasks, boards: S.boards, images };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `forkpad-backup-${todayStr()}.json`);
  pref.set('lastBackup', Date.now());
  renderNav();
  toast('Backup exported');
}
async function importBackup(file) {
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast("That file isn't a valid backup"); return; }
  if (data?.app !== 'ForkPad') { toast("That file isn't a ForkPad backup"); return; }
  const list = k => (Array.isArray(data[k]) ? data[k] : []).filter(x => x && typeof x.id === 'string');
  const [projects, notes, tasks, boards, images] = ['projects', 'notes', 'tasks', 'boards', 'images'].map(list);
  if (!await confirmDialog('Import this backup?', `Adds ${notes.length} notes, ${tasks.length} tasks, ${projects.length} projects${boards.length ? ` and ${boards.length} GDD boards` : ''}. Items that already exist are replaced by the backup's version.`, 'Import', false)) return;
  notes.forEach(n => { n.html = sanitize(n.html || ''); n.tags ||= []; });
  boards.forEach(b => GDDModel.migrate(b));
  await DB.putMany('projects', projects);
  await DB.putMany('notes', notes);
  await DB.putMany('tasks', tasks);
  if (boards.length) await DB.putMany('boards', boards);
  for (const i of images) {
    if (!/^data:image\//.test(i.data)) continue;
    await DB.put('images', { id: i.id, blob: await (await fetch(i.data)).blob(), created: i.created || Date.now() });
  }
  unmountGdd(); // the open board may have been replaced; render() mounts the imported one
  await loadAll();
  render();
  toast('Backup imported');
}

/* ---------- actions & global events ---------- */
const actions = {
  'quick': () => openQuickCapture(),
  'new-note': () => newNote(),
  'new-project': () => openProjectModal(),
  'edit-project': () => openProjectModal(proj(S.view.id)),
  'export-project': () => exportProject(proj(S.view.id)),
  'export-note': () => { flushSaves(); const n = noteById(S.noteId); openExport({ label: `Note: ${n.title || 'Untitled'}`, notes: [n], tasks: [] }); },
  'export-list': () => {
    flushSaves();
    const x = S.listExport;
    const notes = x.tag ? S.notes.filter(n => n.tags.includes(x.tag)) : S.notes.filter(x.search);
    const tasks = x.tag ? S.tasks.filter(t => t.tags?.includes(x.tag)) : S.tasks.filter(x.search);
    openExport({ label: x.label, notes, tasks });
  },
  'settings': () => openSettings(),
  'menu': () => $('#app').classList.toggle('nav-open'),
  'tab': el => { pref.set('tab.' + S.view.id, el.dataset.tab); render(); },
  'sec': (el, e) => {
    const key = 'filter.' + S.view.id, t = el.dataset.tag;
    let f = pref.get(key, []);
    if (!t) f = [];
    else if (e.ctrlKey || e.metaKey) f = f.includes(t) ? f.filter(x => x !== t) : [...f, t];
    else f = f.length === 1 && f[0] === t ? [] : [t];
    pref.set(key, f);
    render();
  },
  'pin': el => {
    const n = noteById(S.noteId); n.pinned = !n.pinned;
    DB.put('notes', n); el.classList.toggle('on', n.pinned); renderList();
  },
  'del-note': () => deleteNote(noteById(S.noteId)),
  'promote': () => { const n = noteById(S.noteId); n.kind = 'note'; DB.put('notes', n); render(); },
  'th-note': el => {
    flushSaves();
    const n = noteById(el.closest('.thought').dataset.id);
    n.kind = 'note'; n.updated = Date.now(); DB.put('notes', n);
    S.noteId = n.id;
    go({ type: 'notes' });
  },
  'th-task': el => { flushSaves(); thoughtToTask(noteById(el.closest('.thought').dataset.id)); },
  'th-del': el => deleteNote(noteById(el.closest('.thought').dataset.id)),
  'toggle-done': el => {
    const t = taskById(el.dataset.id);
    const was = t.status;
    setStatus(t, t.status === 'done' ? 'todo' : 'done');
    t.updated = Date.now(); DB.put('tasks', t);
    render();
    if (t.status === 'done') toast('Task completed', 'Undo', () => { setStatus(t, was); DB.put('tasks', t); render(); });
  },
  'new-gdd': el => newGddModal(el.dataset.project || (S.view.type === 'project' ? S.view.id : null)),
  'gdd-edit': el => editGddModal(boardById(el.dataset.id)),
  'gdd-del': el => deleteBoard(boardById(el.dataset.id)),
  'clear-done': async () => {
    const p = proj(S.view.id);
    const done = S.tasks.filter(t => t.projectId === p.id && t.status === 'done');
    if (!await confirmDialog(`Clear ${done.length} finished task(s)?`, 'They will be deleted from this board.', 'Clear')) return;
    done.forEach(t => DB.del('tasks', t.id));
    S.tasks = S.tasks.filter(t => !done.includes(t));
    render();
  },
};

function bindGlobal() {
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-nav],[data-act],[data-note],[data-task]');
    // the GDD editor owns every click inside it (its own data-* attributes must not trigger app actions)
    if (!el || el.closest('.modal') || el.closest('.gdd-host')) return;
    if (el.dataset.nav) go({ type: el.dataset.nav, id: el.dataset.id });
    else if (el.dataset.act) actions[el.dataset.act]?.(el, e);
    else if (el.dataset.note) selectNote(el.dataset.note);
    else if (el.dataset.task) openTask(taskById(el.dataset.task));
  });
  document.addEventListener('submit', e => {
    const f = e.target.closest('.add-task'); if (!f) return;
    e.preventDefault();
    const input = $('input', f), title = input.value.trim();
    if (!title) return;
    const st = f.dataset.status;
    addTask({ projectId: S.view.id, title, status: st, tags: [...pref.get('filter.' + S.view.id, [])] });
    render();
    $(`.add-task[data-status="${st}"] input`)?.focus();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const ms = $$('#modalRoot .modal');
      if (ms.length) { e.preventDefault(); ms.at(-1).close(); }
      else if (document.activeElement === $('#search')) { clearSearch(); $('#search').blur(); }
      return;
    }
    if (e.altKey && !e.ctrlKey && e.code === 'KeyQ') { e.preventDefault(); openQuickCapture(); }
    else if (e.altKey && !e.ctrlKey && e.code === 'KeyN') { e.preventDefault(); newNote(); }
    else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') { e.preventDefault(); $('#search').focus(); $('#search').select(); }
  });
  $('#search').addEventListener('input', debounce(() => {
    const q = $('#search').value.trim();
    if (!q) { clearSearch(); return; }
    if (S.view.type !== 'search') S.prevView = S.view;
    S.query = q;
    flushSaves();
    S.view = { type: 'search' };
    render();
  }, 150));
  document.addEventListener('selectionchange', updateToolbar);
  // Dropping a file outside an editor shouldn't navigate away from the app.
  window.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSaves(); });
  window.addEventListener('pagehide', flushSaves);
  setInterval(() => { if (!document.hidden) renderNav(); }, 60e3);
}

/* ---------- live sync ---------- */
// Claude (through the ForkPad connector) edits the same data folder. Its changes are merged
// in place, so open editors keep their objects, and re-rendering waits while the user is busy.
const gddBusy = () => { try { return !!gddMount?.ctl?.isBusy?.(); } catch { return false; } };
const busy = () => $('#modalRoot').children.length > 0 || !!$('.dragging') || gddBusy() ||
  !!document.activeElement?.matches?.('input, textarea, select, [contenteditable="true"]');
function mergeInto(list, fresh, keep) {
  const byId = new Map(list.map(x => [x.id, x]));
  const out = fresh.map(f => {
    const o = byId.get(f.id);
    if (!o) return f;
    if (o === keep) return o;
    for (const k of Object.keys(o)) if (!(k in f)) delete o[k];
    return Object.assign(o, f);
  });
  if (keep && !out.includes(keep)) out.push(keep);
  return out;
}
async function syncFromDisk() {
  const [projects, notes, tasks, boards] = await Promise.all([...['projects', 'notes', 'tasks'].map(s => DB.all(s)), DB.all('boards').catch(() => null)]);
  if (!projects || !notes || !tasks) return;
  if (Array.isArray(boards)) syncBoards(boards.map(b => GDDModel.migrate(b)));
  const open = noteById(S.noteId);
  const editing = open && (pending.has(open.id) || !!document.activeElement?.closest?.('.editor'));
  const freshOpen = open && notes.find(n => n.id === open.id);
  const openChanged = freshOpen && freshOpen.updated !== open.updated;
  S.projects = mergeInto(S.projects, projects).sort((a, b) => a.created - b.created);
  S.notes = mergeInto(S.notes, notes, editing ? open : null);
  S.tasks = mergeInto(S.tasks, tasks);
  S.notes.forEach(n => { n.tags ||= []; });
  S.tasks.forEach(t => { t.tags ||= []; });
  refreshGdd(); // task chips and the project select on an open board
  if (editing && openChanged) toast('This note was also changed outside ForkPad', 'Load their version', () => { Object.assign(open, freshOpen); pending.delete(open.id); mountEditor(); renderList(); });
  if (busy()) { renderNav(); renderList(); S.stale = true; } else { S.stale = false; render(); }
}
const queueSync = debounce(() => syncFromDisk().catch(() => {}), 250);
function watchDisk() {
  let downShown = false;
  DB.watch(() => queueSync(), ok => {
    if (ok) { if (downShown) toast('Reconnected'); downShown = false; return; }
    if (!downShown) toast("Lost touch with the ForkPad helper. Changes may not save: close and reopen ForkPad.");
    downShown = true;
  });
  setInterval(() => { retryGddReload(); if (S.stale && !busy()) { S.stale = false; render(); } }, 1500);
  window.addEventListener('focus', () => { if (!DB.local) queueSync(); });
}

/* ---------- boot ---------- */
async function loadAll() {
  let boards;
  [S.projects, S.notes, S.tasks, boards] = await Promise.all([...['projects', 'notes', 'tasks'].map(s => DB.all(s)), DB.all('boards').catch(() => null)]);
  S.boardsOk = Array.isArray(boards);
  S.boards = (boards || []).map(b => GDDModel.migrate(b));
  S.projects.sort((a, b) => a.created - b.created);
  S.notes.forEach(n => { n.tags ||= []; });
  S.tasks.forEach(t => { t.tags ||= []; });
}
async function seed() {
  const p = { id: uid(), name: 'Getting started', color: COLORS[0], created: Date.now() };
  S.projects.push(p);
  await DB.put('projects', p);
  [
    ['Drag me over to “In progress” →', 'todo', todayStr(), []],
    ['Press Alt+Q anywhere to jot down a quick thought', 'todo', addDays(1), []],
    ['Example bug: player clips through walls', 'todo', null, ['bugs']],
    ['Click a card to add details, tags & a due date', 'doing', null, []],
    ['Open ForkPad for the first time', 'done', null, []],
  ].forEach(([title, status, due, tags]) => addTask({ projectId: p.id, title, status, due, tags }));
  const html = `<p>ForkPad is your lightweight notebook + project board. Everything saves automatically, right here on your computer.</p>
<h2>Try these</h2>
<ul class="checklist"><li data-checked="true">Open ForkPad</li><li data-checked="false">Tick this box by clicking it</li><li data-checked="false">Paste a screenshot or drop an image into a note</li><li data-checked="false">Make a project for something you're working on</li></ul>
<h2>Sections &amp; Claude</h2>
<p>Tag notes and tasks (like <code>bugs</code> or <code>ideas</code>) and they become <b>sections</b> you can filter in every project. Hit <b>Export for Claude</b> on a project (or the ✦ button on a note) to copy a clean Markdown brief into any Claude session.</p>
<h2>Writing shortcuts</h2>
<ul><li><b>#</b> + space → heading, <b>##</b> → subheading</li><li><b>-</b> → bullets, <b>1.</b> → numbered list, <b>[]</b> → checklist, <b>&gt;</b> → quote</li><li><b>Ctrl+B / I / U</b> → bold, italic, underline</li></ul>
<blockquote>Tip: open <b>Backup &amp; data</b> (bottom left) now and then to export a backup.</blockquote>`;
  const d = document.createElement('div'); d.innerHTML = html;
  const welcome = makeNote({ projectId: p.id, title: 'Welcome to ForkPad', tags: ['guide'], pinned: true, html, text: d.textContent });
  const thought = makeNote({ kind: 'quick', html: '<p>💡 Random idea? Type it in the box above and hit Enter. Turn it into a note or task later, or just leave it here.</p>' });
  thought.text = 'Random idea? Type it in the box above and hit Enter.';
  S.notes.push(welcome, thought);
  await DB.putMany('notes', [welcome, thought]);
}
async function boot() {
  try { await DB.open(); } catch (err) {
    $('#content').innerHTML = `<div class="empty">${LOGO}<h3>ForkPad couldn't open its storage</h3><p>${DB.local ? 'Your browser may be blocking site data (e.g. a private window).' : 'The ForkPad helper is not running. Close this window and open ForkPad with its shortcut.'} ${esc(err?.message || '')}</p></div>`;
    return;
  }
  // First run on the helper: bring over preferences saved by the migration (view, last backup).
  if (!DB.local && !pref.get('prefsImported', false)) {
    const old = await DB.prefs().catch(() => ({}));
    for (const [k, v] of Object.entries(old || {})) if (k.startsWith('fp.') && localStorage.getItem(k) == null) localStorage.setItem(k, v);
    pref.set('prefsImported', true);
  }
  await loadAll();
  if (!pref.get('seeded', false) && !S.projects.length && !S.notes.length) await seed();
  pref.set('seeded', true);
  if (!pref.get('firstRun', 0)) pref.set('firstRun', Date.now());
  navigator.storage?.persist?.().catch(() => {});
  document.execCommand('defaultParagraphSeparator', false, 'p');
  S.view = pref.get('view', { type: 'home' });
  if ((S.view.type === 'project' && !proj(S.view.id)) || S.view.type === 'search') S.view = { type: 'home' };
  if (S.view.type === 'gdd' && !boardById(S.view.id)) S.view = { type: 'gdds' };
  bindGlobal();
  render();
  gcImages();
  watchDisk();
}
boot();
