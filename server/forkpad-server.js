/* ForkPad helper: serves the app and a small storage API on 127.0.0.1 only.
   Started hidden by ForkPad.vbs. Exits by itself once no ForkPad window has been
   connected for a minute. Changes made by other programs (the Claude connector)
   are pushed to open windows over server-sent events. No npm dependencies. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const PORT = Number(process.env.FORKPAD_PORT) || 47821;
const IDLE_MS = Number(process.env.FORKPAD_IDLE_MS) || 60e3;
const ORIGINS = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js', '/db.js': 'db.js', '/forkpad.ico': 'forkpad.ico' };
const MIME = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', ico: 'image/x-icon' };
const LOG = path.join(__dirname, 'forkpad-server.log');

const log = (...a) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${a.join(' ')}\n`); } catch { /* ignore */ } };
try { fs.writeFileSync(LOG, ''); } catch { /* ignore */ }
process.on('uncaughtException', e => log('uncaught', e.stack || e));

store.ensure();

/* ---------- change push ---------- */
const clients = new Set();
let lastActive = Date.now();
// Hash of the last bytes this server wrote per file, so its own writes aren't echoed back.
const ownWrites = new Map();
const own = (file, data) => ownWrites.set(path.resolve(file), store.hash(data));

function broadcast(msg) {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(line);
}
const pendingEvents = new Map();
function onFsEvent(rel) {
  if (!rel || rel.endsWith('.tmp')) return;
  const m = /^(projects|notes|tasks|images)[\\/]([A-Za-z0-9_-]+)\.[a-z]+$/.exec(rel);
  if (!m) return;
  const key = m[1] + '/' + m[2];
  clearTimeout(pendingEvents.get(key));
  pendingEvents.set(key, setTimeout(() => {
    pendingEvents.delete(key);
    const file = path.resolve(store.DATA, rel);
    let data = null;
    try { data = fs.readFileSync(file); } catch { /* deleted */ }
    const h = data && store.hash(data);
    if (h && ownWrites.get(file) === h) return;
    ownWrites.delete(file);
    broadcast({ store: m[1], id: m[2], deleted: !data });
  }, 120));
}
try {
  fs.watch(store.DATA, { recursive: true }, (ev, name) => onFsEvent(name && String(name)));
} catch (e) { log('watch failed', e.message); }

/* ---------- http ---------- */
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = req => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 200e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

async function handle(req, res) {
  lastActive = Date.now();
  // Only answer requests addressed to this machine (blocks DNS-rebinding tricks).
  const host = String(req.headers.host || '');
  if (!ORIGINS.some(o => o.endsWith('//' + host))) return send(res, 403, { error: 'forbidden host' });
  if (req.method !== 'GET' && req.headers.origin && !ORIGINS.includes(req.headers.origin)) return send(res, 403, { error: 'forbidden origin' });

  const url = new URL(req.url, ORIGINS[0]);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (parts[0] !== 'api') {
    const file = STATIC[url.pathname];
    if (!file || req.method !== 'GET') return send(res, 404, 'Not found', 'text/plain');
    fs.readFile(path.join(store.ROOT, file), (err, data) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      send(res, 200, data, MIME[file.split('.').pop()]);
    });
    return;
  }

  const [, what, id] = parts;
  if (what === 'ping') return send(res, 200, { ok: true, app: 'ForkPad', pid: process.pid, data: store.DATA });
  if (what === 'events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => { clients.delete(res); lastActive = Date.now(); });
    return;
  }
  if (what === 'info') {
    const counts = Object.fromEntries(store.STORES.map(s => [s, store.all(s).length]));
    return send(res, 200, { dataDir: store.DATA, bytes: dirSize(store.DATA), counts, images: store.listImages().length });
  }
  if (what === 'prefs') return send(res, 200, store.getMeta('prefs') || {});

  if (what === 'images') {
    if (!id) return req.method === 'GET' ? send(res, 200, store.listImages()) : send(res, 405, { error: 'method' });
    if (!store.safeId(id)) return send(res, 400, { error: 'bad id' });
    if (req.method === 'GET') {
      const f = store.imageFile(id);
      if (!f) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'private, max-age=31536000, immutable' });
      return fs.createReadStream(f.file).pipe(res);
    }
    if (req.method === 'PUT') {
      const buf = await readBody(req);
      const file = store.putImage(id, buf, req.headers['content-type'], req.headers['x-created']);
      own(file, buf);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') { store.delImage(id); return send(res, 200, { ok: true }); }
    return send(res, 405, { error: 'method' });
  }

  if (!store.isStore(what)) return send(res, 404, { error: 'unknown store' });
  if (!id) {
    if (req.method === 'GET') return send(res, 200, store.all(what));
    if (req.method === 'POST') {
      const list = JSON.parse(await readBody(req) || '[]');
      if (!Array.isArray(list)) return send(res, 400, { error: 'expected an array' });
      for (const obj of list) own(path.join(store.DATA, what, obj.id + '.json'), store.put(what, obj));
      return send(res, 200, { ok: true, count: list.length });
    }
    return send(res, 405, { error: 'method' });
  }
  if (!store.safeId(id)) return send(res, 400, { error: 'bad id' });
  if (req.method === 'GET') {
    const obj = store.get(what, id);
    return obj ? send(res, 200, obj) : send(res, 404, { error: 'not found' });
  }
  if (req.method === 'PUT') {
    const obj = JSON.parse(await readBody(req));
    if (obj?.id !== id) return send(res, 400, { error: 'id mismatch' });
    own(path.join(store.DATA, what, id + '.json'), store.put(what, obj));
    return send(res, 200, { ok: true });
  }
  if (req.method === 'DELETE') { store.del(what, id); return send(res, 200, { ok: true }); }
  send(res, 405, { error: 'method' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => { log('request failed', req.method, req.url, e.stack || e); if (!res.headersSent) send(res, 500, { error: String(e.message || e) }); });
});
server.on('error', e => {
  // Another copy is already serving: nothing to do.
  if (e.code === 'EADDRINUSE') process.exit(0);
  log('server error', e.stack || e); process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => log(`listening on ${ORIGINS[0]}, data in ${store.DATA}`));

// Keep-alive comments stop idle connections from being dropped; the idle check ends the process.
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25e3);
setInterval(() => {
  if (!clients.size && Date.now() - lastActive > IDLE_MS) { log('no windows open, exiting'); process.exit(0); }
}, 5e3);
