#!/usr/bin/env node
/* ForkPad connector: a stdio MCP server that lets Claude Code read and update ForkPad
   (projects, #section tags, tasks, notes and screenshots). It works on the data folder
   directly, so ForkPad doesn't need to be open; an open ForkPad window picks up the
   changes within a second. Hand-written JSON-RPC, no npm dependencies. */
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('../server/store');
const { htmlToMd, htmlToText, mdToHtml } = require('./md');

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

/* ---------- tools ---------- */
const P_PROJECT = { type: 'string', description: 'Project name or id (case-insensitive). Leave out to use the project linked to the current folder.' };
const tools = [
  {
    name: 'list_projects', title: 'List ForkPad projects', readOnly: true,
    description: 'List all ForkPad projects with their code folder, open task counts and sections (tags such as #bugs).',
    inputSchema: { type: 'object', properties: {} },
    run() {
      const ts = allTasks(), ns = allNotes(), cur = projectForDir();
      const L = projects().map(p => {
        const pt = ts.filter(t => t.projectId === p.id), pn = ns.filter(n => n.projectId === p.id && n.kind === 'note');
        const tags = new Map();
        for (const x of [...pt.filter(t => t.status !== 'done'), ...pn]) for (const g of x.tags) tags.set(g, (tags.get(g) || 0) + 1);
        return `- **${p.name}** \`${p.id}\`${cur?.project.id === p.id ? ' (current folder)' : ''}\n  ${pt.filter(t => t.status !== 'done').length} open tasks, ${pt.filter(t => t.status === 'done').length} done, ${pn.length} notes` +
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
    description: 'Permanently delete a project together with ALL its tasks and notes, like Delete project in the app. There is no undo. Only call this when the user clearly asked for it, and pass confirm: true.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project name or id (required, never guessed from the folder).' }, confirm: { type: 'boolean', description: 'Must be true.' } }, required: ['project', 'confirm'] },
    run({ project, confirm }) {
      if (!project) throw new UserError('Name the project to delete.');
      const p = findProject(project);
      const ts = allTasks().filter(t => t.projectId === p.id), ns = allNotes().filter(n => n.projectId === p.id);
      if (confirm !== true) throw new UserError(`Not deleted. "${p.name}" has ${ts.length} task(s) and ${ns.length} note(s) that would be deleted too. Call again with confirm: true if the user really wants that.`);
      ts.forEach(t => store.del('tasks', t.id));
      ns.forEach(n => store.del('notes', n.id));
      store.del('projects', p.id);
      return `Deleted project "${p.name}" with ${ts.length} task(s) and ${ns.length} note(s).`;
    },
  },
  {
    name: 'get_project', title: 'Project brief', readOnly: true,
    description: 'Markdown brief of a project: tasks by status (with ids) and notes, optionally only some sections (tags like "bugs"). Screenshots show as forkpad-image:<id>; view them with get_image.',
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
      const imgs = [];
      if (ns.length) {
        L.push('## Notes', '');
        for (const n of ns) { const b = noteBlock(n); imgs.push(...b.images); L.push(b.text, ''); }
      }
      if (!ts.length && !ns.length) L.push('_Nothing matched._');
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
    description: 'Full details of one task by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run({ id }) {
      const t = findTask(id);
      const facts = [`id: \`${t.id}\``, `project: ${projName(t.projectId)}`, `status: ${STATUS[t.status] || t.status}`, t.due && `due: ${t.due}`,
        t.tags.length && `sections: ${t.tags.map(g => '#' + g).join(' ')}`, `created ${day(t.created)}, updated ${day(t.updated)}${t.doneAt ? `, done ${day(t.doneAt)}` : ''}`];
      return `# ${t.title}\n\n${facts.filter(Boolean).map(f => '- ' + f).join('\n')}\n\n${t.desc?.trim() || '_(no description)_'}`;
    },
  },
  {
    name: 'search', title: 'Search ForkPad', readOnly: true,
    description: 'Search notes and tasks by words and #tags (all words must match). Optionally limit to one project.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string', description: 'Project name or id to search in (default: all projects).' } }, required: ['query'] },
    run({ query, project }) {
      const toks = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!toks.length) throw new UserError('Give some words to search for.');
      const pid = project ? findProject(project).id : null;
      const names = new Map(projects().map(p => [p.id, p.name]));
      const hay = x => [x.title, x.text, x.desc, names.get(x.projectId), ...x.tags.map(t => '#' + t)].join(' ').toLowerCase();
      const hit = x => (!pid || x.projectId === pid) && toks.every(t => hay(x).includes(t));
      const ts = allTasks().filter(hit), ns = allNotes().filter(hit).sort((a, b) => b.updated - a.updated);
      if (!ts.length && !ns.length) return `Nothing matches "${query}".`;
      const L = [`# Search "${query}": ${ts.length} task(s), ${ns.length} note(s)`, ''];
      if (ts.length) L.push('## Tasks', ...ts.map(t => taskLine(t, true)), '');
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
    description: 'Show a ForkPad image (e.g. a bug screenshot) by its id from forkpad-image:<id>.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Image id (the part after forkpad-image:).' } }, required: ['id'] },
    run({ id }) {
      const clean = String(id || '').replace(/^forkpad-image:/, '').trim();
      const f = store.imageFile(clean);
      if (!f) throw new UserError(`No image with id "${clean}".`);
      const note = allNotes().find(n => (n.html || '').includes(`data-fp="${clean}"`));
      const caption = { type: 'text', text: `Image ${clean}${note ? ` from note "${note.title || 'Untitled'}" (${projName(note.projectId)})` : ''}. File: ${f.file}` };
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.type)) return [caption, { type: 'text', text: `It is ${f.type}, which can't be shown inline; open the file instead.` }];
      return [caption, { type: 'image', data: fs.readFileSync(f.file).toString('base64'), mimeType: f.type }];
    },
  },
  {
    name: 'add_task', title: 'Add task',
    description: 'Add a task to a project board. Use tags for the section, e.g. ["bugs"].',
    inputSchema: {
      type: 'object', properties: {
        project: P_PROJECT, title: { type: 'string' }, desc: { type: 'string', description: 'Details (plain text).' },
        tags: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['todo', 'doing', 'done'] },
        due: { type: 'string', description: 'Due date, YYYY-MM-DD.' },
      }, required: ['title'],
    },
    run({ project, title, desc = '', tags, status = 'todo', due }) {
      const p = findProject(project);
      if (!String(title || '').trim()) throw new UserError('A task needs a title.');
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new UserError('due must look like 2026-12-31.');
      const st = statusArg(status), now = Date.now();
      const t = { id: store.uid(), projectId: p.id, title: String(title).trim(), status: st, due: due || null, desc, tags: tagsArg(tags), order: nextOrder(p.id, st), created: now, updated: now, ...(st === 'done' && { doneAt: now }) };
      store.put('tasks', t);
      return `Added to ${p.name}:\n${taskLine(t)}`;
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
      instructions: "ForkPad is the user's notes and Kanban app. Projects contain tasks (To do / In progress / Done) and notes; tags act as sections, e.g. #bugs. Start with current_project or list_projects, then get_project or list_tasks. You can also create, edit and delete projects, tasks, notes and quick thoughts; only delete when the user asks. Screenshots appear as forkpad-image:<id>: call get_image to look at them. When you fix something, call complete_task with a short comment.",
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
