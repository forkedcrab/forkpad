#!/usr/bin/env node
/* ForkPad connector: a stdio MCP server that lets Claude Code read and update ForkPad
   (projects, #section tags, tasks, notes, screenshots and GDD boards). It works on the data folder
   directly, so ForkPad doesn't need to be open; an open ForkPad window picks up the
   changes within a second. Hand-written JSON-RPC, no npm dependencies. */
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('../server/store');
const { htmlToMd, htmlToText, mdToHtml } = require('./md');
const M = require('../gdd-model.js');

const VERSION = '1.0.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const STATUS = { todo: 'To do', doing: 'In progress', done: 'Done' };
// Same palette as the app's project colors (COLORS in app.js).
const COLORS = ['#ff8f1f', '#f2b84b', '#ef5b5b', '#d16bd6', '#8f7bff', '#4fa8ff', '#3fc7ad', '#7fcf63'];
const COLOR_NAMES = { orange: 0, yellow: 1, red: 2, pink: 3, purple: 4, blue: 5, teal: 6, green: 7 };

/* ---------- helpers ---------- */
class UserError extends Error {}
const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const normTag = s => String(s || '').trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 40);
const normPath = p => path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const day = ts => ts ? new Date(ts).toISOString().slice(0, 10) : '';
const tagsArg = v => (Array.isArray(v) ? v : v ? String(v).split(/[,\s]+/) : []).map(normTag).filter(Boolean);
function statusArg(s) {
  const k = norm(s);
  if (['todo', 'open', 'backlog', 'new'].includes(k)) return 'todo';
  if (['doing', 'inprogress', 'progress', 'started', 'wip'].includes(k)) return 'doing';
  if (['done', 'complete', 'completed', 'fixed', 'closed'].includes(k)) return 'done';
  throw new UserError(`Unknown status "${s}". Use todo, doing or done.`);
}

const projects = () => store.all('projects').sort((a, b) => a.created - b.created);
const allNotes = () => store.all('notes').map(n => ({ ...n, tags: n.tags || [] }));
const allTasks = () => store.all('tasks').map(t => ({ ...t, tags: t.tags || [] }));

let roots = [];
// Folder the Claude session runs in: MCP roots if the client shares them, else our cwd.
const sessionDirs = () => [...roots, process.env.CLAUDE_PROJECT_DIR, process.cwd()].filter(Boolean);
function projectForDir(dirs = sessionDirs()) {
  const ps = projects();
  for (const d of dirs) {
    const dir = normPath(d);
    const hits = ps.filter(p => p.repoPath && (dir === normPath(p.repoPath) || dir.startsWith(normPath(p.repoPath) + '/')));
    if (hits.length) return { project: hits.sort((a, b) => b.repoPath.length - a.repoPath.length)[0], how: 'code folder', dir: d };
  }
  for (const d of dirs) {
    const base = norm(path.basename(path.resolve(d)));
    const hit = base && ps.find(p => norm(p.name) === base);
    if (hit) return { project: hit, how: 'folder name', dir: d };
  }
  return null;
}
function findProject(arg) {
  const ps = projects();
  if (arg == null || arg === '') {
    const cur = projectForDir();
    if (cur) return cur.project;
    throw new UserError(`No project given and none is linked to ${sessionDirs().slice(-1)[0]}. Projects: ${ps.map(p => p.name).join(', ') || '(none)'}. Pass project, or link one with link_project_folder.`);
  }
  const a = String(arg).trim(), n = norm(a);
  const hit = ps.find(p => p.id === a) || ps.find(p => p.name.toLowerCase() === a.toLowerCase()) || ps.find(p => norm(p.name) === n);
  if (hit) return hit;
  const partial = ps.filter(p => n && norm(p.name).includes(n));
  if (partial.length === 1) return partial[0];
  throw new UserError(`${partial.length ? 'Several' : 'No'} projects match "${a}". Projects: ${ps.map(p => p.name).join(', ') || '(none)'}.`);
}
function findTask(id) {
  const t = store.get('tasks', String(id || '').trim());
  if (!t) throw new UserError(`No task with id "${id}". Use list_tasks to see ids.`);
  t.tags ||= [];
  return t;
}
function findNote(arg, projectArg) {
  const a = String(arg || '').trim();
  const byId = store.get('notes', a);
  if (byId) { byId.tags ||= []; return byId; }
  let list = allNotes();
  if (projectArg) { const p = findProject(projectArg); list = list.filter(n => n.projectId === p.id); }
  const exact = list.filter(n => (n.title || '').toLowerCase() === a.toLowerCase());
  const loose = exact.length ? exact : list.filter(n => norm(a) && norm(n.title).includes(norm(a)));
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) throw new UserError(`Several notes match "${a}": ${loose.slice(0, 10).map(n => `"${n.title}" (${n.id})`).join(', ')}. Pass the id.`);
  throw new UserError(`No note matches "${a}". Use search or get_project to find notes.`);
}
const projName = id => projects().find(p => p.id === id)?.name || 'No project';

function taskLine(t, withProject = false) {
  const bits = [t.due && `due ${t.due}`, ...t.tags.map(g => '#' + g), withProject && projName(t.projectId)].filter(Boolean);
  return `- [${t.status === 'done' ? 'x' : ' '}] **${t.title}** \`${t.id}\`${bits.length ? ` _(${bits.join(', ')})_` : ''}`;
}
function taskBlock(t, withProject) {
  const L = [taskLine(t, withProject)];
  if (t.desc?.trim()) L.push(...t.desc.trim().split('\n').map(l => '  ' + l));
  for (const id of t.images || []) L.push(`  ![screenshot](forkpad-image:${id})`);
  return L.join('\n');
}
function noteBlock(n) {
  const { md, images } = htmlToMd(n.html);
  const meta = [n.tags.length && n.tags.map(g => '#' + g).join(' '), `updated ${day(n.updated)}`, `id \`${n.id}\``].filter(Boolean);
  return { text: `### ${n.title || (n.kind === 'quick' ? 'Quick thought' : 'Untitled note')}\n_${meta.join(' · ')}_\n\n${md || '_(empty)_'}`, images };
}
const imageHint = ids => ids.length ? `\n\n_${ids.length} screenshot(s) referenced as \`forkpad-image:<id>\`. Call get_image with an id to see one._` : '';
const touch = (o, fields) => Object.assign(o, fields, { updated: Date.now() });
function nextOrder(projectId, status, except) {
  return Math.max(-1, ...allTasks().filter(x => x.id !== except && x.projectId === projectId && x.status === status).map(x => x.order ?? 0)) + 1;
}
function setStatus(t, status) {
  if (t.status === status) return;
  t.order = nextOrder(t.projectId, status, t.id);
  t.status = status;
  t.doneAt = status === 'done' ? Date.now() : null;
}
function colorArg(c, fallbackIndex) {
  if (c == null || c === '') return COLORS[fallbackIndex % COLORS.length];
  const s = String(c).trim().toLowerCase();
  if (s in COLOR_NAMES) return COLORS[COLOR_NAMES[s]];
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  throw new UserError(`Unknown color "${c}". Use one of ${Object.keys(COLOR_NAMES).join(', ')} or a hex like #4fa8ff.`);
}
const repoArg = p => p ? path.resolve(String(p).trim().replace(/^"(.*)"$/, '$1')).replace(/[\\/]+$/, '') : null;
// Puts a task into a board column at a position (0 = top), renumbering that column like a drag in the app.
function placeTask(t, status, position) {
  const was = t.status;
  t.status = status;
  if (was !== status) t.doneAt = status === 'done' ? Date.now() : null;
  const col = allTasks().filter(x => x.id !== t.id && x.projectId === t.projectId && x.status === status).sort((a, b) => a.order - b.order);
  const at = position == null ? col.length : Math.max(0, Math.min(col.length, Math.floor(Number(position))));
  col.splice(at, 0, t);
  const now = Date.now();
  col.forEach((x, i) => { if (x === t) { x.order = i; return; } if (x.order !== i) { x.order = i; x.updated = now; store.put('tasks', x); } });
  return at;
}
const str = v => v == null ? '' : String(v).trim();

/* ---------- GDD boards ---------- */
const allBoards = () => store.all('boards').map(M.migrate).sort((a, b) => b.updated - a.updated);
const boardTasks = id => allTasks().filter(t => t.gdd?.boardId === id);
const saveBoard = b => store.put('boards', touch(b, {}));
function findBoard(arg, projectArg) {
  const a = str(arg);
  if (!a) throw new UserError('Name the GDD board (title or id). Use list_gdds to see them.');
  const byId = store.get('boards', a);
  if (byId) return M.migrate(byId);
  let list = allBoards();
  if (projectArg) { const p = findProject(projectArg); list = list.filter(b => b.projectId === p.id); }
  const exact = list.filter(b => b.title.toLowerCase() === a.toLowerCase());
  const same = exact.length ? exact : list.filter(b => norm(a) && norm(b.title) === norm(a));
  const loose = same.length ? same : list.filter(b => norm(a) && norm(b.title).includes(norm(a)));
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) throw new UserError(`Several GDDs match "${a}": ${loose.slice(0, 10).map(b => `"${b.title}" (${b.id})`).join(', ')}. Pass the id.`);
  throw new UserError(`No GDD matches "${a}". GDDs: ${allBoards().map(b => `"${b.title}"`).join(', ') || '(none)'}. Use list_gdds, or create_gdd to make one.`);
}
// The app re-saves the board right after storing a fresh snapshot, so allow a little slack.
function snapshotOf(b) {
  const f = b.previewId ? store.imageFile(b.previewId) : null;
  return { f, state: !f ? 'none' : (b.previewAt || 0) < b.updated - 1500 ? 'stale' : 'fresh' };
}
const SNAP_NOTE = { none: 'no snapshot yet', stale: 'snapshot out of date', fresh: 'snapshot up to date' };
function boardLine(b, withProject = true) {
  const ts = boardTasks(b.id), n = type => b.items.filter(i => i.type === type).length;
  const facts = [`${n('frame')} section(s), ${b.items.length - n('frame')} item(s), ${b.links.length} connection(s), ${n('image')} image(s)`,
    `${ts.length} task(s)${ts.length ? ` (${ts.filter(t => t.status === 'done').length} done)` : ''}`, `updated ${day(b.updated)}`, SNAP_NOTE[snapshotOf(b).state]];
  return `- **${b.title}** \`${b.id}\`${withProject ? ` (${b.projectId ? projName(b.projectId) : 'no project'})` : ''}\n  ${facts.join('; ')}`;
}
const itemTexts = it => [it.title, it.text, it.caption].filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
const itemRef = it => `${M.itemLabel(it)} \`${it.id}\``;
// An item by id, by a ref made earlier in the same call, or by its exact title / text / caption.
function findItem(board, arg, refs, only) {
  const a = str(arg), what = only === 'frame' ? 'section (frame)' : 'item';
  if (!a) throw new UserError(`An ${what} reference is empty. Use an id from get_gdd${refs ? ', a ref from this call' : ''} or an exact title.`);
  const pool = board.items.filter(i => !only || i.type === only);
  let hit = refs?.get(a) || pool.find(i => i.id === a);
  if (hit && only && hit.type !== only) throw new UserError(`"${a}" is a ${hit.type}, not a frame. Pass a frame title, id or ref.`);
  if (hit) return hit;
  let hits = pool.filter(i => itemTexts(i).some(s => s.toLowerCase() === a.toLowerCase()));
  if (!hits.length) hits = pool.filter(i => norm(a) && itemTexts(i).some(s => norm(s) === norm(a)));
  if (hits.length === 1) return hits[0];
  if (hits.length) throw new UserError(`Several ${what}s on "${board.title}" match "${a}": ${hits.slice(0, 8).map(itemRef).join(', ')}. Use the id.`);
  const hint = only === 'frame' ? ` Sections: ${M.frames(board).map(f => `"${f.title}" (${f.id})`).join(', ') || '(none)'}.` : ' Use an id from get_gdd or the exact title/text of an item.';
  throw new UserError(`No ${what} on "${board.title}" matches "${a}".${hint}`);
}
const taskLookupFor = b => { const ts = boardTasks(b.id); return id => ts.filter(t => t.gdd.itemId === id).map(t => ({ title: t.title, status: t.status, id: t.id })); };
function gddOfTask(t) {
  if (!t.gdd?.boardId) return null;
  const raw = store.get('boards', t.gdd.boardId);
  if (!raw) return 'From GDD: (board deleted)';
  const b = M.migrate(raw), it = t.gdd.itemId && b.items.find(i => i.id === t.gdd.itemId);
  return `From GDD: ${b.title} \`${b.id}\`${it ? ` / ${itemRef(it)}` : t.gdd.itemId ? ' / (item removed)' : ''}`;
}
// Project for new tasks: the one passed, else the GDD's project, else the folder's.
function taskProject(project, board) {
  if (project) return findProject(project);
  const bp = board?.projectId && projects().find(p => p.id === board.projectId);
  return bp || findProject();
}
function gddLink(board, itemArg, where = '') {
  if (itemArg && !board) throw new UserError(`${where}gdd_item needs gdd (the board title or id) too.`);
  if (!board) return null;
  const it = itemArg ? findItem(board, itemArg) : null;
  return { boardId: board.id, ...(it && { itemId: it.id }) };
}
const projectHint = (b, p) => b && b.projectId !== p.id ? `\n\nGDD "${b.title}" is ${b.projectId ? `linked to ${projName(b.projectId)}` : 'not linked to a project'}; update_gdd with project "${p.name}" links it here.` : '';

/* GDD items made by the connector. Sizes are estimates; the editor refits heights on open. */
const T = M.TYPO;
const GDD_KINDS = { note: 'sticky', bubble: 'card', speech: 'speech', text: null, frame: null, shape: null };
const SHAPE_ALIAS = { rect: 'rect', box: 'rect', square: 'rect', rectangle: 'rect', roundrect: 'roundrect', rounded: 'roundrect', roundedbox: 'roundrect', roundedrect: 'roundrect', ellipse: 'ellipse', circle: 'ellipse', oval: 'ellipse', triangle: 'triangle', diamond: 'diamond', rhombus: 'diamond', hexagon: 'hexagon', star: 'star', arrow: 'arrow', arrowshape: 'arrow' };
const FRAME_COLORS = ['yellow', 'orange', 'blue', 'pink', 'green', 'purple', 'teal', 'red'];
const TAIL = 40; // room under a speech bubble for its tail
function gddColor(c, what) {
  if (c == null || c === '') return undefined;
  const s = String(c).trim().toLowerCase().replace(/^grey$/, 'gray');
  if (M.PALETTE[s] || /^#[0-9a-f]{6}$/.test(s)) return s;
  throw new UserError(`Unknown color "${c}"${what ? ` for ${what}` : ''}. Use one of ${M.PALETTE_NAMES.join(', ')} or a hex like #8cc8ff.`);
}
// Height the text needs (grow only keeps a taller height the user chose).
function fitItem(it, grow = false) {
  let need = it.h;
  if (it.type === 'bubble') {
    const inner = it.w - 2 * T.pad.bubble;
    const head = it.title ? M.estimateTextHeight(it.title, inner, it.size * T.bubbleTitleScale) + (it.text ? T.titleGap : 0) : 0;
    need = Math.max(64, 2 * T.pad.bubble + head + (it.text ? M.estimateTextHeight(it.text, inner, it.size) : 0));
  } else if (it.type === 'text') need = M.estimateTextHeight(it.text, it.w - 2 * T.pad.text, it.size) + 2 * T.pad.text;
  else if (it.type === 'shape' && it.text) {
    const k = ['rect', 'roundrect'].includes(it.shape) ? 1 : 0.7; // pointy shapes leave less room for text
    need = Math.max(grow ? 0 : 120, Math.ceil((M.estimateTextHeight(it.text, (it.w - 2 * T.pad.shape) * k, it.size) + 2 * T.pad.shape) / k));
  }
  it.h = grow ? Math.max(it.h, need) : need;
  if (!grow && it.type === 'bubble' && it.style === 'speech') it.tail = { x: Math.min(48, it.w / 3), y: it.h + TAIL - 8 };
  return it;
}
function buildItem(s, board, i, frameCount) {
  const where = `items[${i}]`, kind = norm(s?.type);
  if (kind === 'image') throw new UserError(`${where}: images can only be added in the ForkPad app (paste or drop them on the board).`);
  if (!(kind in GDD_KINDS)) throw new UserError(`${where}: unknown type "${s?.type}". Use note, bubble, speech, text, frame or shape.`);
  const title = str(s.title), text = String(s.text ?? '').trim(), any = text || title;
  const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const widthFor = (len, base, wide) => len > 400 ? wide + 60 : len > 160 ? wide : base;
  if (kind === 'frame') return M.newItem('frame', { w: 720, h: 480, title: (title || text || 'Section').slice(0, 120), color: gddColor(s.color, where) || FRAME_COLORS[frameCount % FRAME_COLORS.length] }, board.style);
  if (!any) throw new UserError(`${where}: a ${kind} needs a title or text.`);
  if (GDD_KINDS[kind]) {
    const it = M.newItem('bubble', clean({ style: GDD_KINDS[kind], title, text, color: gddColor(s.color, where), w: widthFor(text.length + title.length, 240, 300) }), board.style);
    return fitItem(it);
  }
  if (kind === 'text') {
    const big = any.length <= 60 && !any.includes('\n'), size = big ? 24 : 16;
    const longest = Math.max(...any.split('\n').map(l => l.length));
    const w = Math.round(Math.min(big ? 640 : 480, Math.max(120, longest * size * 0.55 + 2 * T.pad.text + 12)));
    return fitItem(M.newItem('text', clean({ text: any, size, weight: big ? 600 : 400, w, color: gddColor(s.color, where) }), board.style));
  }
  const shape = SHAPE_ALIAS[norm(s.shape || 'roundrect')];
  if (!shape) throw new UserError(`${where}: unknown shape "${s.shape}". Use ${M.SHAPES.join(', ')} (circle and square work too).`);
  return fitItem(M.newItem('shape', clean({ shape, text: any, fill: gddColor(s.color, where), w: any.length > 40 ? 220 : 160 }), board.style));
}
const footprint = it => it.h + (it.tail ? TAIL : 0);
// Grow a frame downward and push what sits under it (other frames with their items, loose items) down too.
function growFrame(board, fr, h) {
  if (h <= fr.h) return;
  const dh = h - fr.h, bottom = fr.y + fr.h, fs = M.frames(board);
  const under = it => it !== fr && it.y >= bottom - 1 && it.x < fr.x + fr.w && fr.x < it.x + it.w;
  const moving = new Set();
  for (const g of fs.filter(under)) { moving.add(g); M.itemsInFrame(board, g).forEach(k => moving.add(k)); }
  board.items.filter(it => it.type !== 'frame' && under(it) && !M.frameOf(board, it, fs)).forEach(k => moving.add(k));
  fr.h = h;
  for (const it of moving) it.y += dh;
}
// Inside a frame: below its content, left to right in rows that fit the frame width.
function placeInFrame(board, fr, it, cursors) {
  const G = 24;
  let c = cursors.get(fr.id);
  if (!c) {
    const kids = M.itemsInFrame(board, fr);
    const bottom = Math.max(fr.y + T.frameTitleH - 8, ...kids.map(k => k.y + footprint(k) + (k.type === 'image' && k.caption ? T.captionGap + T.captionSize * T.lineHeight * 2 : 0)));
    c = { x: fr.x + G, y: bottom + G, rowH: 0 };
    cursors.set(fr.id, c);
  }
  if (it.w > fr.w - 2 * G) { it.w = fr.w - 2 * G; fitItem(it); }
  if (c.x > fr.x + G && c.x + it.w > fr.x + fr.w - G) { c.y += c.rowH + G; c.x = fr.x + G; c.rowH = 0; }
  it.x = c.x; it.y = c.y;
  c.x += it.w + G; c.rowH = Math.max(c.rowH, footprint(it));
  growFrame(board, fr, it.y + footprint(it) + G - fr.y);
}
// New frames continue the last row of frames (up to 4 wide), else start a row below; with no frames, right of everything.
function placeFrame(board, fr) {
  const GAP = 80, fs = M.frames(board), cb = M.contentBounds(board);
  const free = r => !board.items.some(o => M.overlaps(r, M.bounds(o)));
  if (!fs.length) { fr.x = cb ? cb.x + cb.w + GAP : 0; fr.y = cb ? cb.y : 0; return; }
  const maxY = Math.max(...fs.map(g => g.y)), row = fs.filter(g => maxY - g.y < 60);
  if (row.length < 4) {
    const r = { x: Math.max(...row.map(g => g.x + g.w)) + GAP, y: Math.min(...row.map(g => g.y)), w: fr.w, h: fr.h };
    if (free(r)) { fr.x = r.x; fr.y = r.y; return; }
  }
  fr.x = Math.min(...fs.map(g => g.x));
  fr.y = Math.max(...fs.map(g => g.y + g.h)) + GAP;
  if (!free(M.bounds(fr)) && cb) fr.y = cb.y + cb.h + GAP;
}
// Loose items: a grid to the right of all content.
function placeLoose(board, it, c) {
  if (!c) { const cb = M.contentBounds(board); c = { x0: cb ? cb.x + cb.w + 80 : 0, y: cb ? cb.y : 0, rowH: 0 }; c.x = c.x0; }
  if (c.x > c.x0 && c.x + it.w - c.x0 > 1000) { c.y += c.rowH + 24; c.x = c.x0; c.rowH = 0; }
  it.x = c.x; it.y = c.y;
  c.x += it.w + 24; c.rowH = Math.max(c.rowH, footprint(it));
  return c;
}

/* ---------- tools ---------- */
const P_PROJECT = { type: 'string', description: 'Project name or id (case-insensitive). Leave out to use the project linked to the current folder.' };
const tools = [
  {
    name: 'list_projects', title: 'List ForkPad projects', readOnly: true,
    description: 'List all ForkPad projects with their code folder, open task counts and sections (tags such as #bugs).',
    inputSchema: { type: 'object', properties: {} },
    run() {
      const ts = allTasks(), ns = allNotes(), bs = store.all('boards'), cur = projectForDir();
      const L = projects().map(p => {
        const pt = ts.filter(t => t.projectId === p.id), pn = ns.filter(n => n.projectId === p.id && n.kind === 'note');
        const pb = bs.filter(b => b.projectId === p.id).length;
        const tags = new Map();
        for (const x of [...pt.filter(t => t.status !== 'done'), ...pn]) for (const g of x.tags) tags.set(g, (tags.get(g) || 0) + 1);
        return `- **${p.name}** \`${p.id}\`${cur?.project.id === p.id ? ' (current folder)' : ''}\n  ${pt.filter(t => t.status !== 'done').length} open tasks, ${pt.filter(t => t.status === 'done').length} done, ${pn.length} notes${pb ? `, ${pb} GDD(s)` : ''}` +
          `${tags.size ? `; sections: ${[...tags].map(([g, c]) => `#${g} (${c})`).join(', ')}` : ''}\n  Code folder: ${p.repoPath || '(not set)'}`;
      });
      return L.length ? `# ForkPad projects\n\n${L.join('\n')}` : 'ForkPad has no projects yet.';
    },
  },
  {
    name: 'current_project', title: 'Project for this folder', readOnly: true,
    description: "Find the ForkPad project linked to the folder this Claude session runs in (matched against each project's code folder, then by folder name).",
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Folder to look up instead of the session folder.' } } },
    run({ path: p }) {
      const cur = projectForDir(p ? [p] : undefined);
      if (!cur) return `No ForkPad project is linked to ${p || sessionDirs().slice(-1)[0]}. Projects: ${projects().map(x => x.name).join(', ') || '(none)'}. Use link_project_folder to link one.`;
      return `Current project: **${cur.project.name}** \`${cur.project.id}\` (matched by ${cur.how}: ${cur.dir}).${cur.how === 'folder name' ? ' Tip: link_project_folder makes this match exact.' : ''}`;
    },
  },
  {
    name: 'link_project_folder', title: 'Link project to folder',
    description: "Set a project's code folder so sessions in that folder (or below it) pick the project automatically.",
    inputSchema: { type: 'object', properties: { project: P_PROJECT, path: { type: 'string', description: 'Folder to link. Defaults to the session folder.' } }, required: ['project'] },
    run({ project, path: p }) {
      const pr = findProject(project);
      const dir = path.resolve(p || sessionDirs().slice(-1)[0]);
      store.put('projects', touch(pr, { repoPath: dir }));
      return `Linked **${pr.name}** to ${dir}.`;
    },
  },
  {
    name: 'create_project', title: 'Create project',
    description: 'Create a new ForkPad project (it appears in the sidebar and on Home). Color is a palette name (orange, yellow, red, pink, purple, blue, teal, green) or hex; by default the next palette color is used.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, color: { type: 'string' }, repoPath: { type: 'string', description: "The project's code folder, so sessions there pick it automatically." } }, required: ['name'] },
    run({ name, color, repoPath }) {
      const n = String(name || '').trim().slice(0, 80);
      if (!n) throw new UserError('A project needs a name.');
      const ps = projects();
      if (ps.some(p => p.name.toLowerCase() === n.toLowerCase())) throw new UserError(`A project called "${n}" already exists.`);
      const now = Date.now();
      const p = { id: store.uid(), name: n, color: colorArg(color, ps.length), repoPath: repoArg(repoPath), created: now, updated: now };
      store.put('projects', p);
      return `Created project **${p.name}** \`${p.id}\` (color ${p.color}${p.repoPath ? `, code folder ${p.repoPath}` : ''}).`;
    },
  },
  {
    name: 'update_project', title: 'Update project',
    description: "Rename a project, change its color, or set its code folder (pass an empty string to clear it). Only the fields you pass change.",
    inputSchema: { type: 'object', properties: { project: P_PROJECT, name: { type: 'string' }, color: { type: 'string' }, repoPath: { type: 'string' } }, required: ['project'] },
    run({ project, name, color, repoPath }) {
      const p = findProject(project);
      if (name != null && String(name).trim()) {
        const n = String(name).trim().slice(0, 80);
        if (projects().some(x => x.id !== p.id && x.name.toLowerCase() === n.toLowerCase())) throw new UserError(`A project called "${n}" already exists.`);
        p.name = n;
      }
      if (color != null && color !== '') p.color = colorArg(color, 0);
      if (repoPath !== undefined) p.repoPath = repoArg(repoPath);
      store.put('projects', touch(p, {}));
      return `Updated project **${p.name}** \`${p.id}\` (color ${p.color}, code folder ${p.repoPath || '(not set)'}).`;
    },
  },
  {
    name: 'delete_project', title: 'Delete project',
    description: 'Permanently delete a project together with ALL its tasks and notes, like Delete project in the app. There is no undo. Its GDD boards are kept (just unlinked). Only call this when the user clearly asked for it, and pass confirm: true.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project name or id (required, never guessed from the folder).' }, confirm: { type: 'boolean', description: 'Must be true.' } }, required: ['project', 'confirm'] },
    run({ project, confirm }) {
      if (!project) throw new UserError('Name the project to delete.');
      const p = findProject(project);
      const ts = allTasks().filter(t => t.projectId === p.id), ns = allNotes().filter(n => n.projectId === p.id);
      const bs = allBoards().filter(b => b.projectId === p.id);
      const kept = bs.length ? ` Its ${bs.length} GDD board(s) are kept and just unlinked.` : '';
      if (confirm !== true) throw new UserError(`Not deleted. "${p.name}" has ${ts.length} task(s) and ${ns.length} note(s) that would be deleted too.${kept} Call again with confirm: true if the user really wants that.`);
      ts.forEach(t => store.del('tasks', t.id));
      ns.forEach(n => store.del('notes', n.id));
      // Design work outlives the project: boards only lose the link.
      bs.forEach(b => saveBoard(Object.assign(b, { projectId: null })));
      store.del('projects', p.id);
      return `Deleted project "${p.name}" with ${ts.length} task(s) and ${ns.length} note(s).${bs.length ? ` Kept its GDD board(s), now without a project: ${bs.map(b => `"${b.title}"`).join(', ')}.` : ''}`;
    },
  },
  {
    name: 'get_project', title: 'Project brief', readOnly: true,
    description: 'Markdown brief of a project: tasks by status (with ids), its GDD boards and notes, optionally only some sections (tags like "bugs"). Screenshots show as forkpad-image:<id>; view them with get_image.',
    inputSchema: {
      type: 'object', properties: {
        project: P_PROJECT,
        sections: { type: 'array', items: { type: 'string' }, description: 'Only include items tagged with any of these, e.g. ["bugs"].' },
        include_done: { type: 'boolean', description: 'Include finished tasks (default false).' },
        include_notes: { type: 'boolean', description: 'Include notes (default true).' },
      },
    },
    run({ project, sections, include_done = false, include_notes = true }) {
      const p = findProject(project), secs = tagsArg(sections);
      const pass = x => !secs.length || secs.some(s => x.tags.includes(s));
      const ts = allTasks().filter(t => t.projectId === p.id && pass(t) && (include_done || t.status !== 'done'));
      const ns = include_notes ? allNotes().filter(n => n.projectId === p.id && n.kind === 'note' && pass(n)).sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated)) : [];
      const L = [`# ForkPad: ${p.name}${secs.length ? ` (${secs.map(s => '#' + s).join(', ')})` : ''}`, ''];
      if (p.repoPath) L.push(`Code folder: ${p.repoPath}`, '');
      if (ts.length) {
        L.push('## Tasks', '');
        for (const st of Object.keys(STATUS)) {
          const list = ts.filter(t => t.status === st).sort((a, b) => a.order - b.order);
          if (list.length) L.push(`### ${STATUS[st]}`, '', ...list.map(t => taskBlock(t)), '');
        }
      }
      const imgs = ts.flatMap(t => t.images || []);
      const bs = secs.length ? [] : allBoards().filter(b => b.projectId === p.id);
      if (bs.length) L.push('## GDDs', '', ...bs.map(b => `- **${b.title}** \`${b.id}\`: ${b.items.length} item(s); read with get_gdd`), '');
      if (ns.length) {
        L.push('## Notes', '');
        for (const n of ns) { const b = noteBlock(n); imgs.push(...b.images); L.push(b.text, ''); }
      }
      if (!ts.length && !ns.length && !bs.length) L.push('_Nothing matched._');
      return L.join('\n').trim() + imageHint(imgs);
    },
  },
  {
    name: 'list_tasks', title: 'List tasks', readOnly: true,
    description: 'List tasks in a project, optionally filtered by section tag and status. Returns ids for update_task / complete_task.',
    inputSchema: {
      type: 'object', properties: {
        project: P_PROJECT,
        section: { type: 'string', description: 'Section tag, e.g. "bugs".' },
        status: { type: 'string', enum: ['open', 'todo', 'doing', 'done', 'all'], description: 'Default "open" (todo + doing).' },
      },
    },
    run({ project, section, status = 'open' }) {
      const p = findProject(project), sec = normTag(section || '');
      const okStatus = t => status === 'all' || (status === 'open' ? t.status !== 'done' : t.status === statusArg(status));
      const ts = allTasks().filter(t => t.projectId === p.id && okStatus(t) && (!sec || t.tags.includes(sec)))
        .sort((a, b) => Object.keys(STATUS).indexOf(a.status) - Object.keys(STATUS).indexOf(b.status) || a.order - b.order);
      if (!ts.length) return `No ${status === 'all' ? '' : status + ' '}tasks in ${p.name}${sec ? ` tagged #${sec}` : ''}.`;
      const L = [`# ${p.name}: ${ts.length} ${status === 'all' ? '' : status + ' '}task(s)${sec ? ` in #${sec}` : ''}`, ''];
      for (const st of Object.keys(STATUS)) {
        const list = ts.filter(t => t.status === st);
        if (list.length) L.push(`## ${STATUS[st]}`, ...list.map(t => taskBlock(t)), '');
      }
      return L.join('\n').trim();
    },
  },
  {
    name: 'get_task', title: 'Get task', readOnly: true,
    description: 'Full details of one task by id, including attached screenshots (forkpad-image:<id>, view with get_image).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run({ id }) {
      const t = findTask(id);
      const facts = [`id: \`${t.id}\``, `project: ${projName(t.projectId)}`, `status: ${STATUS[t.status] || t.status}`, t.due && `due: ${t.due}`,
        t.tags.length && `sections: ${t.tags.map(g => '#' + g).join(' ')}`, gddOfTask(t), `created ${day(t.created)}, updated ${day(t.updated)}${t.doneAt ? `, done ${day(t.doneAt)}` : ''}`];
      const imgs = t.images || [];
      return `# ${t.title}\n\n${facts.filter(Boolean).map(f => '- ' + f).join('\n')}\n\n${t.desc?.trim() || '_(no description)_'}`
        + (imgs.length ? `\n\n${imgs.map(id => `![screenshot](forkpad-image:${id})`).join('\n')}` : '') + imageHint(imgs);
    },
  },
  {
    name: 'search', title: 'Search ForkPad', readOnly: true,
    description: 'Search notes, tasks and GDD boards by words and #tags (all words must match). Optionally limit to one project.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string', description: 'Project name or id to search in (default: all projects).' } }, required: ['query'] },
    run({ query, project }) {
      const toks = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!toks.length) throw new UserError('Give some words to search for.');
      const pid = project ? findProject(project).id : null;
      const names = new Map(projects().map(p => [p.id, p.name]));
      const hay = x => [x.title, x.text, x.desc, names.get(x.projectId), ...x.tags.map(t => '#' + t)].join(' ').toLowerCase();
      const hit = x => (!pid || x.projectId === pid) && toks.every(t => hay(x).includes(t));
      const ts = allTasks().filter(hit), ns = allNotes().filter(hit).sort((a, b) => b.updated - a.updated);
      const bs = allBoards().filter(b => (!pid || b.projectId === pid) && toks.every(t => [M.boardText(b), names.get(b.projectId)].join(' ').toLowerCase().includes(t)));
      if (!ts.length && !ns.length && !bs.length) return `Nothing matches "${query}".`;
      const L = [`# Search "${query}": ${ts.length} task(s), ${ns.length} note(s), ${bs.length} GDD(s)`, ''];
      if (ts.length) L.push('## Tasks', ...ts.map(t => taskLine(t, true)), '');
      if (bs.length) L.push('## GDDs', ...bs.map(b => {
        const where = b.items.filter(i => toks.some(t => itemTexts(i).join(' ').toLowerCase().includes(t))).slice(0, 4);
        return `- **${b.title}** \`${b.id}\` _(${names.get(b.projectId) || 'No project'})_${where.length ? `\n  matches ${where.map(itemRef).join(', ')}` : ''}`;
      }), '');
      if (ns.length) L.push('## Notes', ...ns.slice(0, 50).map(n => `- **${n.title || (n.kind === 'quick' ? 'Quick thought' : 'Untitled')}** \`${n.id}\` _(${[names.get(n.projectId) || 'No project', ...n.tags.map(g => '#' + g)].join(', ')})_\n  ${(n.text || '').replace(/\s+/g, ' ').slice(0, 160)}`));
      return L.join('\n').trim();
    },
  },
  {
    name: 'get_note', title: 'Get note', readOnly: true,
    description: 'One note as Markdown, by id or title. Screenshots show as forkpad-image:<id>.',
    inputSchema: { type: 'object', properties: { note: { type: 'string', description: 'Note id or title.' }, project: { type: 'string', description: 'Narrow a title lookup to this project.' } }, required: ['note'] },
    run({ note, project }) {
      const n = findNote(note, project), b = noteBlock(n);
      return `${b.text.replace(/^### /, '# ')}\n\n_Project: ${projName(n.projectId)}_${imageHint(b.images)}`;
    },
  },
  {
    name: 'get_image', title: 'View screenshot', readOnly: true,
    description: 'Show a ForkPad image (a bug screenshot, an image on a GDD board, or a GDD snapshot) by its id from forkpad-image:<id>.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Image id (the part after forkpad-image:).' } }, required: ['id'] },
    run({ id }) {
      const clean = String(id || '').replace(/^forkpad-image:/, '').trim();
      const f = store.imageFile(clean);
      if (!f) throw new UserError(`No image with id "${clean}".`);
      const note = allNotes().find(n => (n.html || '').includes(`data-fp="${clean}"`));
      const task = !note && allTasks().find(t => (t.images || []).includes(clean));
      const board = !note && !task && allBoards().find(b => b.previewId === clean || b.items.some(i => i.type === 'image' && i.imageId === clean));
      const onBoard = board && board.items.find(i => i.type === 'image' && i.imageId === clean);
      const from = note ? ` from note "${note.title || 'Untitled'}" (${projName(note.projectId)})` : task ? ` attached to task "${task.title}" (${task.id}, ${projName(task.projectId)})`
        : onBoard ? ` on GDD "${board.title}" (${board.id}), item ${itemRef(onBoard)}` : board ? `: snapshot of GDD "${board.title}" (${board.id})` : '';
      const caption = { type: 'text', text: `Image ${clean}${from}. File: ${f.file}` };
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.type)) return [caption, { type: 'text', text: `It is ${f.type}, which can't be shown inline; open the file instead.` }];
      return [caption, { type: 'image', data: fs.readFileSync(f.file).toString('base64'), mimeType: f.type }];
    },
  },
  {
    name: 'add_task', title: 'Add task',
    description: 'Add a task to a project board. Use tags for the section, e.g. ["bugs"]. To add many at once (for example a plan from a GDD), use add_tasks.',
    inputSchema: {
      type: 'object', properties: {
        project: { ...P_PROJECT, description: P_PROJECT.description + " With gdd, the board's project is the default." }, title: { type: 'string' }, desc: { type: 'string', description: 'Details (plain text).' },
        tags: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['todo', 'doing', 'done'] },
        due: { type: 'string', description: 'Due date, YYYY-MM-DD.' },
        gdd: { type: 'string', description: 'GDD board (title or id) this task comes from.' },
        gdd_item: { type: 'string', description: 'Id of the board item this task implements (from get_gdd), or its exact title. Needs gdd.' },
      }, required: ['title'],
    },
    run({ project, title, desc = '', tags, status = 'todo', due, gdd, gdd_item }) {
      const b = gdd ? findBoard(gdd) : null;
      if (gdd_item && !b) throw new UserError('gdd_item needs gdd (the board title or id) too.');
      const p = taskProject(project, b);
      if (!String(title || '').trim()) throw new UserError('A task needs a title.');
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new UserError('due must look like 2026-12-31.');
      const st = statusArg(status), now = Date.now(), link = gddLink(b, gdd_item);
      const t = { id: store.uid(), projectId: p.id, title: String(title).trim(), status: st, due: due || null, desc, tags: tagsArg(tags), order: nextOrder(p.id, st), created: now, updated: now, ...(st === 'done' && { doneAt: now }), ...(link && { gdd: link }) };
      store.put('tasks', t);
      return `Added to ${p.name}:\n${taskLine(t)}${link ? `\n  ${gddOfTask(t)}` : ''}${projectHint(b, p)}`;
    },
  },
  {
    name: 'add_tasks', title: 'Add several tasks',
    description: 'Add many tasks to a project board in one go, in the order given (each goes to the bottom of its column). Each task can link to the GDD item it implements with gdd_item. Use tags for sections such as core, art, audio, ui, levels, tech.',
    inputSchema: {
      type: 'object', properties: {
        project: { ...P_PROJECT, description: P_PROJECT.description + " With gdd, the board's project is the default." },
        gdd: { type: 'string', description: 'GDD board (title or id) the tasks come from. Every task gets linked to it.' },
        tasks: {
          type: 'array', minItems: 1, maxItems: 200, items: {
            type: 'object', properties: {
              title: { type: 'string' }, desc: { type: 'string', description: 'Details (plain text): what done looks like.' },
              tags: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['todo', 'doing', 'done'] },
              due: { type: 'string', description: 'YYYY-MM-DD.' },
              gdd_item: { type: 'string', description: 'Id of the board item this task implements (from get_gdd), or its exact title.' },
            }, required: ['title'],
          },
        },
      }, required: ['tasks'],
    },
    run({ project, gdd, tasks }) {
      if (!Array.isArray(tasks) || !tasks.length) throw new UserError('Pass tasks: [{ title, desc?, tags?, status?, due?, gdd_item? }].');
      if (tasks.length > 200) throw new UserError(`That is ${tasks.length} tasks; add at most 200 per call.`);
      const b = gdd ? findBoard(gdd) : null;
      if (!b && tasks.some(x => x?.gdd_item)) throw new UserError('Some tasks have gdd_item but no gdd was given. Pass gdd (the board title or id) too.');
      const p = taskProject(project, b);
      // Check everything first so a bad entry adds nothing.
      const rows = tasks.map((x, i) => {
        const title = str(x?.title);
        if (!title) throw new UserError(`tasks[${i}] needs a title.`);
        if (x.due && !/^\d{4}-\d{2}-\d{2}$/.test(x.due)) throw new UserError(`tasks[${i}] ("${title}"): due must look like 2026-12-31.`);
        let st, link;
        try { st = statusArg(x.status || 'todo'); link = gddLink(b, x.gdd_item); } catch (e) { throw e instanceof UserError ? new UserError(`tasks[${i}] ("${title}"): ${e.message}`) : e; }
        return { title, desc: String(x.desc ?? ''), tags: tagsArg(x.tags), st, due: x.due || null, link };
      });
      const next = {}, now = Date.now();
      const made = rows.map(r => {
        next[r.st] ??= nextOrder(p.id, r.st);
        const t = { id: store.uid(), projectId: p.id, title: r.title, status: r.st, due: r.due, desc: r.desc, tags: r.tags, order: next[r.st]++, created: now, updated: now, ...(r.st === 'done' && { doneAt: now }), ...(r.link && { gdd: r.link }) };
        store.put('tasks', t);
        return t;
      });
      const label = t => { const it = t.gdd?.itemId && b.items.find(i => i.id === t.gdd.itemId); return it ? ` -> ${M.itemLabel(it)}` : ''; };
      return `Added ${made.length} task(s) to ${p.name}${b ? ` from GDD "${b.title}"` : ''}:\n${made.map(t => taskLine(t) + label(t)).join('\n')}${projectHint(b, p)}`;
    },
  },
  {
    name: 'update_task', title: 'Update task',
    description: 'Change a task: status, title, description (replace or append), tags, due date, or move it to another project. Only the fields you pass change. To place it at a position in a column, use move_task.',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string' }, project: { type: 'string', description: 'Move the task to this project (name or id).' }, status: { type: 'string', enum: ['todo', 'doing', 'done'] }, title: { type: 'string' },
        desc: { type: 'string', description: 'Replace the description.' }, append_desc: { type: 'string', description: 'Add a paragraph to the end of the description.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replace all tags.' }, add_tags: { type: 'array', items: { type: 'string' } }, remove_tags: { type: 'array', items: { type: 'string' } },
        due: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to clear.' },
      }, required: ['id'],
    },
    run(a) {
      const t = findTask(a.id);
      if (a.project) {
        const p = findProject(a.project);
        if (p.id !== t.projectId) { t.projectId = p.id; t.order = nextOrder(p.id, t.status, t.id); }
      }
      if (a.status) setStatus(t, statusArg(a.status));
      if (a.title != null && String(a.title).trim()) t.title = String(a.title).trim();
      if (a.desc != null) t.desc = String(a.desc);
      if (a.append_desc) t.desc = [t.desc?.trim(), String(a.append_desc).trim()].filter(Boolean).join('\n\n');
      if (a.tags) t.tags = tagsArg(a.tags);
      if (a.add_tags) t.tags = [...new Set([...t.tags, ...tagsArg(a.add_tags)])];
      if (a.remove_tags) { const rm = tagsArg(a.remove_tags); t.tags = t.tags.filter(g => !rm.includes(g)); }
      if (a.due !== undefined) {
        if (a.due && !/^\d{4}-\d{2}-\d{2}$/.test(a.due)) throw new UserError('due must look like 2026-12-31.');
        t.due = a.due || null;
      }
      store.put('tasks', touch(t, {}));
      return `Updated:\n${taskBlock(t, true)}`;
    },
  },
  {
    name: 'complete_task', title: 'Complete task',
    description: 'Mark a task done, optionally recording what fixed it (added to the description with the date).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, comment: { type: 'string', description: 'What was done, e.g. "Fixed in PlayerController.cs, commit abc123".' } }, required: ['id'] },
    run({ id, comment }) {
      const t = findTask(id);
      setStatus(t, 'done');
      if (comment?.trim()) t.desc = [t.desc?.trim(), `Done ${today()}: ${comment.trim()}`].filter(Boolean).join('\n\n');
      store.put('tasks', touch(t, {}));
      return `Marked done in ${projName(t.projectId)}:\n${taskLine(t)}`;
    },
  },
  {
    name: 'move_task', title: 'Move task on the board',
    description: 'Drag a card: put a task into a column (todo, doing, done) at a position, 0 = top. Leave position out to put it at the bottom. Optionally move it to another project too.',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'done'], description: 'Target column (default: its current one).' },
        position: { type: 'integer', minimum: 0, description: '0-based position in the column.' }, project: { type: 'string', description: 'Move to this project (name or id).' },
      }, required: ['id'],
    },
    run({ id, status, position, project }) {
      const t = findTask(id);
      if (project) t.projectId = findProject(project).id;
      const at = placeTask(t, status ? statusArg(status) : t.status, position);
      store.put('tasks', touch(t, {}));
      return `Moved to ${projName(t.projectId)} / ${STATUS[t.status]}, position ${at}:\n${taskLine(t)}`;
    },
  },
  {
    name: 'delete_task', title: 'Delete task',
    description: 'Permanently delete a task. Prefer complete_task for finished work; delete only when the user asks or the task is a mistake or duplicate.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run({ id }) {
      const t = findTask(id);
      store.del('tasks', t.id);
      return `Deleted task "${t.title}" from ${projName(t.projectId)}.`;
    },
  },
  {
    name: 'add_quick_thought', title: 'Add quick thought',
    description: "Jot a quick thought into ForkPad's Quick thoughts inbox (like Alt+Q in the app). Markdown is allowed. No project unless you pass one.",
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, project: { type: 'string', description: 'Project name or id (optional).' } }, required: ['text'] },
    run({ text, project }) {
      if (!String(text || '').trim()) throw new UserError('A quick thought needs some text.');
      const html = mdToHtml(text), now = Date.now();
      const n = { id: store.uid(), kind: 'quick', projectId: project ? findProject(project).id : null, title: '', html, text: htmlToText(html), tags: [], pinned: false, created: now, updated: now };
      store.put('notes', n);
      return `Added quick thought \`${n.id}\`${n.projectId ? ` in ${projName(n.projectId)}` : ''}.`;
    },
  },
  {
    name: 'add_note', title: 'Add note',
    description: 'Create a note in a project. Body is Markdown (headings, lists, - [ ] checklists, code blocks, quotes).',
    inputSchema: { type: 'object', properties: { project: P_PROJECT, title: { type: 'string' }, markdown: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['title', 'markdown'] },
    run({ project, title, markdown, tags }) {
      const p = findProject(project), html = mdToHtml(markdown), now = Date.now();
      const n = { id: store.uid(), kind: 'note', projectId: p.id, title: String(title || '').trim(), html, text: htmlToText(html), tags: tagsArg(tags), pinned: false, created: now, updated: now };
      store.put('notes', n);
      return `Added note "${n.title}" \`${n.id}\` to ${p.name}.`;
    },
  },
  {
    name: 'append_to_note', title: 'Append to note',
    description: 'Add Markdown to the end of an existing note (by id or title).',
    inputSchema: { type: 'object', properties: { note: { type: 'string', description: 'Note id or title.' }, markdown: { type: 'string' }, project: { type: 'string', description: 'Narrow a title lookup to this project.' } }, required: ['note', 'markdown'] },
    run({ note, markdown, project }) {
      const n = findNote(note, project);
      n.html = (n.html || '') + mdToHtml(markdown);
      store.put('notes', touch(n, { text: htmlToText(n.html) }));
      return `Appended to "${n.title || 'Untitled'}" \`${n.id}\`.`;
    },
  },
  {
    name: 'update_note', title: 'Update note',
    description: 'Change a note: title, tags, pinned, replace its whole body with Markdown, move it to another project (or "none"), or turn a quick thought into a regular note. Only the fields you pass change. Replacing the body drops embedded screenshots, so prefer append_to_note for additions.',
    inputSchema: {
      type: 'object', properties: {
        note: { type: 'string', description: 'Note id or title.' }, title: { type: 'string' }, markdown: { type: 'string', description: 'New body (replaces the old one).' },
        tags: { type: 'array', items: { type: 'string' } }, pinned: { type: 'boolean' },
        project: { type: 'string', description: 'Move to this project (name or id), or "none" for no project.' },
        to_note: { type: 'boolean', description: 'true turns a quick thought into a regular note.' },
      }, required: ['note'],
    },
    run({ note, title, markdown, tags, pinned, project, to_note }) {
      const n = findNote(note);
      if (title != null) n.title = String(title).trim().slice(0, 200);
      if (markdown != null) { n.html = mdToHtml(markdown); n.text = htmlToText(n.html); }
      if (tags) n.tags = tagsArg(tags);
      if (pinned != null) n.pinned = !!pinned;
      if (project) n.projectId = /^(none|null|no project)$/i.test(project) ? null : findProject(project).id;
      if (to_note) n.kind = 'note';
      store.put('notes', touch(n, {}));
      return `Updated ${n.kind === 'quick' ? 'quick thought' : 'note'} "${n.title || 'Untitled'}" \`${n.id}\` (${projName(n.projectId)}).`;
    },
  },
  {
    name: 'delete_note', title: 'Delete note',
    description: 'Permanently delete a note or quick thought (by id or title). Only when the user asks for it.',
    inputSchema: { type: 'object', properties: { note: { type: 'string', description: 'Note id or title.' }, project: { type: 'string', description: 'Narrow a title lookup to this project.' } }, required: ['note'] },
    run({ note, project }) {
      const n = findNote(note, project);
      store.del('notes', n.id);
      return `Deleted ${n.kind === 'quick' ? 'quick thought' : 'note'} "${n.title || (n.text || '').slice(0, 40) || 'Untitled'}".`;
    },
  },
  /* GDD boards: visual game design documents (sections, notes, images, shapes, arrows, doodles). */
  {
    name: 'list_gdds', title: 'List GDD boards', readOnly: true,
    description: 'List GDD boards (visual game design documents) with their project, sections, item and image counts, linked tasks and whether the snapshot is up to date.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Only boards of this project (name or id). Default: all boards.' } } },
    run({ project }) {
      const p = project ? findProject(project) : null;
      const bs = allBoards().filter(b => !p || b.projectId === p.id);
      if (!bs.length) return p ? `${p.name} has no GDD boards yet. create_gdd makes one.` : 'ForkPad has no GDD boards yet. create_gdd makes one.';
      return `# GDD boards${p ? ` in ${p.name}` : ''}\n\n${bs.map(b => boardLine(b, !p)).join('\n')}\n\nRead one with get_gdd.`;
    },
  },
  {
    name: 'get_gdd', title: 'Read GDD board', readOnly: true,
    description: 'Read a GDD board: its sections (frames) in reading order with every note, text, shape, image and doodle (with ids), the connections between them, the tasks made from it, and a PNG snapshot of the whole board. Images show as forkpad-image:<id>; view them with get_image.',
    inputSchema: { type: 'object', properties: { gdd: { type: 'string', description: 'Board title or id.' }, project: { type: 'string', description: 'Narrow a title lookup to this project.' } }, required: ['gdd'] },
    run({ gdd, project }) {
      const b = findBoard(gdd, project);
      const { md, images } = M.boardToMarkdown(b, { taskLookup: taskLookupFor(b), projectName: b.projectId ? projName(b.projectId) : null });
      const ts = boardTasks(b.id), ids = new Set(b.items.map(i => i.id));
      // The shared model writes a plain line as a long dash; keep Claude's text free of it.
      const L = [md.replaceAll(String.fromCharCode(0x2014), '-').trim(), ''];
      if (ts.length) {
        const count = Object.keys(STATUS).map(s => [STATUS[s], ts.filter(t => t.status === s).length]).filter(([, n]) => n).map(([s, n]) => `${n} ${s.toLowerCase()}`);
        const loose = ts.filter(t => !t.gdd.itemId || !ids.has(t.gdd.itemId));
        L.push('## Tasks from this GDD', '', `${ts.length} task(s): ${count.join(', ')}.`);
        if (loose.length) L.push('', 'Linked to the board but not to an item:', ...loose.map(t => taskLine(t, true)));
        L.push('');
      } else L.push('_No tasks made from this GDD yet. add_tasks with gdd and gdd_item creates them._', '');
      if (images.length) L.push(`_${images.length} image(s) referenced as \`forkpad-image:<id>\`. Call get_image with an id to see one up close._`);
      const out = [{ type: 'text', text: L.join('\n').trim() }];
      const snap = snapshotOf(b);
      if (snap.state === 'none') out.push({ type: 'text', text: 'No snapshot of this board yet; open it in ForkPad to make one.' });
      else if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(snap.f.type)) out.push({ type: 'text', text: `The snapshot is ${snap.f.type}, which can't be shown inline: ${snap.f.file}` });
      else {
        const age = `taken ${new Date(b.previewAt || Date.now()).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
        out.push({ type: 'text', text: snap.state === 'stale' ? `Snapshot of the board (${age}). The snapshot predates the latest edits; open the board in ForkPad to refresh it. The Markdown above is current.` : `Snapshot of the whole board (${age}, up to date).` });
        out.push({ type: 'image', data: fs.readFileSync(snap.f.file).toString('base64'), mimeType: snap.f.type });
      }
      return out;
    },
  },
  {
    name: 'create_gdd', title: 'Create GDD board',
    description: 'Create a GDD board. template "gdd" (default) starts with sections Pitch, Core loop, Mechanics, Characters, World & levels, Art & audio, Progression, Scope & milestones, each with a hint card; "blank" is an empty canvas. Fill it with add_to_gdd.',
    inputSchema: {
      type: 'object', properties: {
        title: { type: 'string', description: 'Usually the game name.' }, project: { type: 'string', description: 'Project to link it to (name or id). Default: no project.' },
        template: { type: 'string', enum: ['gdd', 'blank'], description: 'Default "gdd".' },
      }, required: ['title'],
    },
    run({ title, project, template = 'gdd' }) {
      const t = str(title).slice(0, 120);
      if (!t) throw new UserError('A GDD needs a title, usually the game name.');
      if (!['gdd', 'blank'].includes(template)) throw new UserError('template must be "gdd" or "blank".');
      const dup = allBoards().find(b => b.title.toLowerCase() === t.toLowerCase());
      if (dup) throw new UserError(`A GDD called "${dup.title}" already exists (${dup.id}). Use it, or pick another title.`);
      const p = project && !/^(none|null|no project)$/i.test(project) ? findProject(project) : null;
      const b = M.newBoard({ title: t, projectId: p?.id || null, template });
      store.put('boards', b);
      const secs = M.readingOrder(M.frames(b));
      return `Created GDD **${b.title}** \`${b.id}\`${p ? ` in ${p.name}` : ' (no project)'}.` + (secs.length ? `\n\nSections (use the title or id as frame in add_to_gdd):\n${secs.map(f => `- ${f.title} \`${f.id}\``).join('\n')}` : '\n\nThe board is empty; add sections and notes with add_to_gdd.');
    },
  },
  {
    name: 'update_gdd', title: 'Update GDD board',
    description: 'Rename a GDD board or link it to a project ("none" unlinks it). Only the fields you pass change.',
    inputSchema: { type: 'object', properties: { gdd: { type: 'string', description: 'Board title or id.' }, title: { type: 'string' }, project: { type: 'string', description: 'Project name or id, or "none".' } }, required: ['gdd'] },
    run({ gdd, title, project }) {
      const b = findBoard(gdd);
      if (title == null && project == null) throw new UserError('Pass title and/or project to change.');
      if (title != null) {
        const t = str(title).slice(0, 120);
        if (!t) throw new UserError('The title cannot be empty.');
        if (allBoards().some(x => x.id !== b.id && x.title.toLowerCase() === t.toLowerCase())) throw new UserError(`Another GDD is already called "${t}".`);
        b.title = t;
      }
      if (project != null && project !== '') b.projectId = /^(none|null|no project)$/i.test(project) ? null : findProject(project).id;
      saveBoard(b);
      return `Updated GDD **${b.title}** \`${b.id}\` (${b.projectId ? projName(b.projectId) : 'no project'}).`;
    },
  },
  {
    name: 'add_to_gdd', title: 'Add to GDD board',
    description: 'Add sections, notes, text, shapes and arrows to a GDD board. Items are placed automatically: inside the frame you name (below what is already there) or, without a frame, next to the existing content. Types: note (sticky note with optional bold title), bubble (card), speech (speech bubble), text (a heading if short), frame (a section), shape (rect, roundrect, ellipse, triangle, diamond, hexagon, star, arrow). Give an item a ref to connect it in links within the same call.',
    inputSchema: {
      type: 'object', properties: {
        gdd: { type: 'string', description: 'Board title or id.' },
        items: {
          type: 'array', maxItems: 200, items: {
            type: 'object', properties: {
              type: { type: 'string', enum: ['note', 'bubble', 'speech', 'text', 'frame', 'shape'] },
              title: { type: 'string', description: 'Bold title of a note/bubble, or the frame title.' }, text: { type: 'string', description: 'Body text (plain, newlines allowed).' },
              color: { type: 'string', description: `Fill (frame, note, shape) or ink (text): ${M.PALETTE_NAMES.join(', ')}, or a hex.` },
              shape: { type: 'string', enum: M.SHAPES, description: 'For type shape. Default roundrect.' },
              frame: { type: 'string', description: 'Put it inside this section: frame title, id, or a ref from this call.' },
              ref: { type: 'string', description: 'A temporary name to use in links (and as frame) within this call.' },
            }, required: ['type'],
          },
        },
        links: {
          type: 'array', maxItems: 200, items: {
            type: 'object', properties: {
              from: { type: 'string', description: 'Item id, a ref from this call, or the exact title/text of an item.' }, to: { type: 'string' },
              label: { type: 'string' }, style: { type: 'string', enum: ['arrow', 'line'], description: 'Default arrow.' },
              route: { type: 'string', enum: ['straight', 'curve', 'elbow'], description: 'Default straight.' },
            }, required: ['from', 'to'],
          },
        },
      }, required: ['gdd'],
    },
    run({ gdd, items = [], links = [] }) {
      const b = findBoard(gdd);
      if (!Array.isArray(items) || !Array.isArray(links)) throw new UserError('items and links must be arrays.');
      if (!items.length && !links.length) throw new UserError('Pass items to add, links to draw, or both.');
      if (items.length > 200 || links.length > 200) throw new UserError('Add at most 200 items and 200 links per call.');
      // Everything happens on the in-memory board and is saved at the end, so an error adds nothing.
      const refs = new Map();
      let frameCount = M.frames(b).length;
      const specs = items.map((s, i) => {
        const it = buildItem(s, b, i, s && norm(s.type) === 'frame' ? frameCount++ : frameCount);
        const ref = str(s.ref);
        if (ref) { if (refs.has(ref)) throw new UserError(`items[${i}]: ref "${ref}" is used twice.`); refs.set(ref, it); }
        if (it.type === 'frame' && s.frame) throw new UserError(`items[${i}]: frames can't be put inside other frames here; leave out frame.`);
        return { s, it, i };
      });
      // Frames first, so items can go into frames made in the same call. Frames sit behind other items.
      for (const { it } of specs.filter(x => x.it.type === 'frame')) {
        placeFrame(b, it);
        const at = b.items.findIndex(i => i.type !== 'frame');
        b.items.splice(at < 0 ? b.items.length : at, 0, it);
      }
      const cursors = new Map(), placed = new Map();
      let loose = null;
      for (const { s, it, i } of specs.filter(x => x.it.type !== 'frame')) {
        if (s.frame) {
          let fr;
          try { fr = findItem(b, s.frame, refs, 'frame'); } catch (e) { throw new UserError(`items[${i}]: ${e.message}`); }
          placeInFrame(b, fr, it, cursors);
          placed.set(it, fr);
        } else loose = placeLoose(b, it, loose);
        b.items.push(it);
      }
      const made = links.map((l, i) => {
        let from, to;
        try { from = findItem(b, l?.from, refs); to = findItem(b, l?.to, refs); } catch (e) { throw new UserError(`links[${i}]: ${e.message}`); }
        if (from === to) throw new UserError(`links[${i}]: from and to are the same item.`);
        const style = norm(l.style || 'arrow'), route = norm(l.route || 'straight');
        if (!['arrow', 'line'].includes(style)) throw new UserError(`links[${i}]: style must be arrow or line.`);
        if (!['straight', 'curve', 'elbow'].includes(route)) throw new UserError(`links[${i}]: route must be straight, curve or elbow.`);
        return M.newLink({ item: from.id }, { item: to.id }, { end: style === 'arrow' ? 'arrow' : 'none', route, label: str(l.label).slice(0, 80) });
      });
      b.links.push(...made);
      saveBoard(b);
      const refOf = new Map([...refs].map(([r, it]) => [it, r]));
      const L = [`Added ${specs.length} item(s) and ${made.length} connection(s) to GDD "${b.title}" \`${b.id}\`.`];
      if (specs.length) L.push('', ...specs.map(({ it }) => `- ${it.type === 'frame' ? `section "${it.title}"` : M.itemLabel(it)} \`${it.id}\`${refOf.has(it) ? ` (ref ${refOf.get(it)})` : ''}${placed.has(it) ? ` in ${placed.get(it).title}` : ''}`));
      if (made.length) L.push('', ...made.map(l => { const n = e => itemRef(M.itemOf(b, e)); return `- ${n(l.from)} ${l.end === 'arrow' ? '->' : '-'} ${n(l.to)}${l.label ? ` (${l.label})` : ''} \`${l.id}\``; }));
      L.push('', 'Sizes are estimates; ForkPad refits them and refreshes the snapshot when the board is opened.');
      return L.join('\n');
    },
  },
  {
    name: 'update_gdd_item', title: 'Update GDD item',
    description: "Change one item on a GDD board (title, text, image caption, color), or delete it with delete: true (its connections go too; tasks linked to it stay, linked to the board). Item ids come from get_gdd.",
    inputSchema: {
      type: 'object', properties: {
        gdd: { type: 'string', description: 'Board title or id.' }, item: { type: 'string', description: 'Item id from get_gdd.' },
        title: { type: 'string', description: 'Frame or note title.' }, text: { type: 'string', description: 'Text of a note, text item or shape.' }, caption: { type: 'string', description: 'Image caption.' },
        color: { type: 'string', description: `${M.PALETTE_NAMES.join(', ')}, or a hex.` }, delete: { type: 'boolean', description: 'true deletes the item.' },
      }, required: ['gdd', 'item'],
    },
    run({ gdd, item, title, text, caption, color, delete: del }) {
      const b = findBoard(gdd);
      const it = b.items.find(i => i.id === str(item));
      if (!it) throw new UserError(`No item \`${item}\` on "${b.title}". Use get_gdd to see item ids.`);
      const label = itemRef(it);
      if (del === true) {
        const linked = boardTasks(b.id).filter(t => t.gdd.itemId === it.id);
        b.items = b.items.filter(i => i !== it);
        const before = b.links.length;
        b.links = b.links.filter(l => l.from.item !== it.id && l.to.item !== it.id);
        saveBoard(b);
        // Keep the tasks, but drop the reference to an item that no longer exists.
        linked.forEach(t => { const { itemId, ...rest } = t.gdd; store.put('tasks', touch(t, { gdd: rest })); });
        return `Deleted ${label} from "${b.title}"${before - b.links.length ? ` with ${before - b.links.length} connection(s)` : ''}.${it.type === 'frame' ? ' The items that were inside it stay on the board.' : ''}${linked.length ? ` ${linked.length} task(s) linked to it stay linked to the board.` : ''}`;
      }
      if (title == null && text == null && caption == null && (color == null || color === '')) throw new UserError('Pass title, text, caption or color to change, or delete: true.');
      const has = k => k in M.newItem(it.type);
      const set = (k, v, ok) => { if (v == null) return; if (!ok) throw new UserError(`A ${it.type} has no ${k}.`); it[k] = v; };
      set('title', title != null ? String(title).trim().slice(0, 200) : null, has('title'));
      set('text', text != null ? String(text).trim() : null, has('text'));
      set('caption', caption != null ? String(caption).trim().slice(0, 300) : null, it.type === 'image');
      if (color != null && color !== '') {
        const c = gddColor(color, it.type);
        const key = { frame: 'color', bubble: 'color', text: 'color', draw: 'color', shape: 'fill' }[it.type];
        if (!key) throw new UserError(`An ${it.type} has no color here; change its border in the ForkPad app.`);
        it[key] = it.type === 'draw' ? M.inkOf(c) : c;
      }
      fitItem(it, true);
      saveBoard(b);
      return `Updated ${itemRef(it)} on "${b.title}".`;
    },
  },
  {
    name: 'delete_gdd', title: 'Delete GDD board',
    description: 'Permanently delete a GDD board and its snapshot. Images used on it stay in ForkPad until the app cleans up unused ones; tasks made from it stay too. Only when the user asks, with confirm: true.',
    inputSchema: { type: 'object', properties: { gdd: { type: 'string', description: 'Board title or id.' }, confirm: { type: 'boolean', description: 'Must be true.' } }, required: ['gdd', 'confirm'] },
    run({ gdd, confirm }) {
      const b = findBoard(gdd), ts = boardTasks(b.id);
      if (confirm !== true) throw new UserError(`Not deleted. "${b.title}" has ${b.items.length} item(s) and ${b.links.length} connection(s)${ts.length ? `; ${ts.length} task(s) were made from it and would stay` : ''}. Call again with confirm: true if the user really wants that.`);
      store.del('boards', b.id);
      if (b.previewId) store.delImage(b.previewId);
      ts.forEach(t => { delete t.gdd; store.put('tasks', touch(t, {})); });
      return `Deleted GDD "${b.title}".${ts.length ? ` Its ${ts.length} task(s) stay, no longer linked to a board.` : ''}`;
    },
  },
];

/* ---------- JSON-RPC over stdio ---------- */
const write = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
let nextId = 1;
const waiting = new Map();
const request = (method, params) => new Promise(res => { const id = 'fp' + nextId++; waiting.set(id, res); write({ jsonrpc: '2.0', id, method, params }); setTimeout(() => { if (waiting.delete(id)) res(null); }, 5000); });
let clientCaps = {};
async function refreshRoots() {
  if (!clientCaps.roots) return;
  const r = await request('roots/list', {});
  const list = r?.result?.roots;
  if (Array.isArray(list)) roots = list.map(x => { try { return decodeURIComponent(new URL(x.uri).pathname).replace(/^\/([A-Za-z]:)/, '$1'); } catch { return null; } }).filter(Boolean);
}

async function onMessage(msg) {
  if (msg.id != null && !msg.method) { const w = waiting.get(msg.id); if (w) { waiting.delete(msg.id); w(msg); } return; }
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    clientCaps = params.capabilities || {};
    return reply(id, {
      protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'forkpad', title: 'ForkPad', version: VERSION },
      instructions: "ForkPad is the user's notes and Kanban app. Projects contain tasks (To do / In progress / Done) and notes; tags act as sections, e.g. #bugs. Start with current_project or list_projects, then get_project or list_tasks. You can also create, edit and delete projects, tasks, notes and quick thoughts; only delete when the user asks. Screenshots appear as forkpad-image:<id>: call get_image to look at them. When you fix something, call complete_task with a short comment. " +
        "GDD boards are visual game design documents: sections (frames) holding notes, text, shapes, images and doodles, joined by arrows. list_gdds finds them, add_to_gdd adds to them. " +
        "To plan a game from a GDD: get_gdd (look at the snapshot and any images with get_image), create_project if needed (or use the board's project) and link it with update_gdd, then add_tasks: concrete, ordered, to-the-point tasks grouped by section tags like core, art, audio, ui, levels, tech, each linked with gdd_item to the board item it implements. Keep the first playable small.",
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/roots/list_changed') { refreshRoots().catch(() => {}); return; }
  if (id == null) return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, {
      tools: tools.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: false, openWorldHint: false } })),
    });
  }
  if (method === 'tools/call') {
    const tool = tools.find(t => t.name === params.name);
    if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
    try {
      store.ensure();
      const out = await tool.run(params.arguments || {});
      return reply(id, { content: Array.isArray(out) ? out : [{ type: 'text', text: String(out) }] });
    } catch (e) {
      if (!(e instanceof UserError)) process.stderr.write(`forkpad: ${params.name} failed: ${e.stack || e}\n`);
      return reply(id, { content: [{ type: 'text', text: e instanceof UserError ? e.message : `ForkPad error: ${e.message}` }], isError: true });
    }
  }
  fail(id, -32601, `Method not found: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { fail(null, -32700, 'Parse error'); continue; }
    onMessage(msg).catch(e => process.stderr.write(`forkpad: ${e.stack || e}\n`));
  }
});
process.stdin.on('end', () => process.exit(0));
