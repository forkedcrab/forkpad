/* ForkPad disk storage, shared by the helper server and the MCP server.
   Layout: data/<store>/<id>.json for projects, notes, tasks and GDD boards; data/images/<id>.<ext>.
   One file per item keeps concurrent writers (app and Claude) from clobbering each other. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.resolve(process.env.FORKPAD_DATA || path.join(ROOT, 'data'));
const STORES = ['projects', 'notes', 'tasks', 'boards'];
const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' };
const EXT_OF = Object.fromEntries(Object.entries(IMG_TYPES).map(([e, t]) => [t, e]));

const isStore = s => STORES.includes(s);
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
const hash = buf => crypto.createHash('sha1').update(buf).digest('hex');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function ensure() {
  for (const s of [...STORES, 'images', 'meta']) fs.mkdirSync(path.join(DATA, s), { recursive: true });
}

// Write to a temp file, then rename over the target, so readers never see half a file.
// Rename can briefly fail on Windows while another process has the target open, so retry.
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
      const until = Date.now() + 25; while (Date.now() < until) { /* short spin before retrying */ }
    }
  }
}
function readJSON(file) {
  for (let i = 0; i < 5; i++) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return undefined;
      if (i === 4) return undefined;
    }
  }
}

const itemFile = (store, id) => path.join(DATA, store, id + '.json');
function all(store) {
  const dir = path.join(DATA, store);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => n.endsWith('.json')).map(n => readJSON(path.join(dir, n))).filter(x => x && typeof x.id === 'string');
}
const get = (store, id) => safeId(id) ? readJSON(itemFile(store, id)) : undefined;
// Returns the bytes written so callers can recognise their own writes later.
function put(store, obj) {
  if (!obj || !safeId(obj.id)) throw new Error('bad id');
  const text = JSON.stringify(obj);
  writeAtomic(itemFile(store, obj.id), text);
  return text;
}
function del(store, id) {
  if (!safeId(id)) return;
  try { fs.unlinkSync(itemFile(store, id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

function imageFile(id) {
  if (!safeId(id)) return null;
  const dir = path.join(DATA, 'images');
  for (const ext of Object.keys(IMG_TYPES)) {
    const f = path.join(dir, `${id}.${ext}`);
    if (fs.existsSync(f)) return { file: f, ext, type: IMG_TYPES[ext] };
  }
  return null;
}
function listImages() {
  let names = [];
  try { names = fs.readdirSync(path.join(DATA, 'images')); } catch { return []; }
  return names.map(n => /^([A-Za-z0-9_-]+)\.([a-z]+)$/.exec(n)).filter(m => m && IMG_TYPES[m[2]]).map(m => {
    const st = fs.statSync(path.join(DATA, 'images', m[0]));
    return { id: m[1], type: IMG_TYPES[m[2]], created: Math.round(st.mtimeMs), size: st.size };
  });
}
function putImage(id, buf, type, created) {
  if (!safeId(id)) throw new Error('bad id');
  const ext = EXT_OF[String(type).split(';')[0].trim().toLowerCase()] || 'png';
  const old = imageFile(id);
  const file = path.join(DATA, 'images', `${id}.${ext}`);
  writeAtomic(file, buf);
  if (old && old.file !== file) fs.rmSync(old.file, { force: true });
  // The file's modified time stands in for the image's "created" stamp.
  if (created) { const t = new Date(Number(created)); fs.utimesSync(file, t, t); }
  return file;
}
function delImage(id) {
  const f = imageFile(id);
  if (f) fs.rmSync(f.file, { force: true });
}

const metaFile = name => path.join(DATA, 'meta', name + '.json');
const getMeta = name => readJSON(metaFile(name));
const putMeta = (name, obj) => writeAtomic(metaFile(name), JSON.stringify(obj, null, 1));

module.exports = { ROOT, DATA, STORES, IMG_TYPES, isStore, safeId, hash, uid, ensure, writeAtomic, all, get, put, del, imageFile, listImages, putImage, delImage, getMeta, putMeta };
