/* HTML <-> Markdown for the ForkPad connector. Note HTML is already sanitized by the app to a
   small tag set, so a tiny tokenizer is enough. htmlToMd mirrors nodeToMd() in app.js. */
'use strict';

const VOID = new Set(['br', 'img', 'hr']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function parse(html) {
  const root = { tag: 'div', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+|<)/g;
  let m;
  while ((m = re.exec(html || ''))) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const i = stack.map(n => n.tag).lastIndexOf(tag);
      if (i > 0) stack.length = i;
    } else if (m[2]) {
      const tag = m[2].toLowerCase(), attrs = {};
      for (const a of (m[3] || '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      const node = { tag, attrs, children: [] };
      top.children.push(node);
      if (!VOID.has(tag)) stack.push(node);
    } else if (m[4] != null) top.children.push(decode(m[4]));
  }
  return root;
}
const textOf = n => typeof n === 'string' ? n : n.children.map(textOf).join('');

function toMd(node, ctx) {
  if (typeof node === 'string') return node.replace(/ /g, ' ');
  const kids = () => node.children.map(n => toMd(n, ctx)).join('');
  const block = s => `\n\n${s.trim()}\n\n`;
  switch (node.tag) {
    case 'br': return '  \n';
    case 'b': case 'strong': { const k = kids(); return k.trim() ? `**${k.trim()}**` : k; }
    case 'i': case 'em': { const k = kids(); return k.trim() ? `*${k.trim()}*` : k; }
    case 's': case 'strike': case 'del': return `~~${kids()}~~`;
    case 'code': return ctx.inPre ? textOf(node) : '`' + textOf(node) + '`';
    case 'a': return `[${kids()}](${node.attrs.href || ''})`;
    case 'h1': return block('# ' + kids());
    case 'h2': return block('## ' + kids());
    case 'h3': return block('### ' + kids());
    case 'hr': return block('---');
    case 'pre': return block('```\n' + textOf(node).replace(/\n$/, '') + '\n```');
    case 'blockquote': return block(kids().trim().split('\n').map(l => '> ' + l).join('\n'));
    case 'img': {
      const id = node.attrs['data-fp'];
      if (!id) return /^https?:/.test(node.attrs.src || '') ? `![image](${node.attrs.src})` : '';
      ctx.images.add(id);
      return block(`![screenshot](forkpad-image:${id})`);
    }
    case 'ul': case 'ol': {
      const depth = ctx.depth++;
      const check = /(^|\s)checklist(\s|$)/.test(node.attrs.class || '');
      const items = node.children.filter(li => li.tag === 'li').map((li, i) => {
        const marker = check ? `- [${li.attrs['data-checked'] === 'true' ? 'x' : ' '}]` : node.tag === 'ol' ? `${i + 1}.` : '-';
        const inner = li.children.map(n => toMd(n, ctx)).join('').trim().replace(/\n{2,}/g, '\n');
        return '  '.repeat(depth) + marker + ' ' + inner;
      });
      ctx.depth--;
      return depth ? '\n' + items.join('\n') : block(items.join('\n'));
    }
    case 'p': case 'div': return block(kids());
    default: return kids();
  }
}
// Returns { md, images } where images are the ForkPad image ids the note embeds.
function htmlToMd(html) {
  const ctx = { images: new Set(), depth: 0, inPre: false };
  const walk = toMd;
  // Code inside <pre> keeps its raw text.
  const tree = parse(html);
  const markPre = n => { if (typeof n !== 'string') { if (n.tag === 'pre') n.children = [textOf(n)]; n.children.forEach(markPre); } };
  markPre(tree);
  const md = walk(tree, ctx).replace(/\n{3,}/g, '\n\n').trim();
  return { md, images: [...ctx.images] };
}

// Plain text, the way the app stores it in note.text for search and snippets.
function htmlToText(html) {
  return textOf(parse(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-3]|li|pre|blockquote)>/gi, '$&\n')))
    .replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function inline(s) {
  const codes = [];
  let out = esc(s).replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  out = out
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');
  return out.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[i]}</code>`);
}
// Markdown from Claude into the app's note HTML (headings, lists, checklists, code, quotes).
function mdToHtml(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}${list.check ? ' class="checklist"' : ''}>${list.items.join('')}</${list.tag}>`); list = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (/^```/.test(line)) {
      flushPara(); flushList();
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    } else if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flushPara(); flushList();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushPara(); flushList(); out.push('<hr>');
    } else if ((m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line))) {
      flushPara();
      if (!list || !list.check) { flushList(); list = { tag: 'ul', check: true, items: [] }; }
      list.items.push(`<li data-checked="${m[1] !== ' '}">${inline(m[2])}</li>`);
    } else if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      flushPara();
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (!list || list.check || list.tag !== tag) { flushList(); list = { tag, check: false, items: [] }; }
      list.items.push(`<li>${inline(m[2])}</li>`);
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flushPara(); flushList();
      const q = [m[1]];
      while (i + 1 < lines.length && /^>/.test(lines[i + 1])) q.push(lines[++i].replace(/^>\s?/, ''));
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList(); para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return out.join('');
}

module.exports = { htmlToMd, htmlToText, mdToHtml, esc };
