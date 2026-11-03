/* ForkPad storage. Normally the app runs from the local helper (the launcher starts it)
   and keeps everything as plain files in the data folder, where the Claude connector can
   read them too. Opened straight from file:// (the old way) it falls back to the browser's
   IndexedDB, which is where data lived before the move. Same DB.* interface either way.
   Image records: { id, created, type, blob }; DB.all('images') leaves blob out. */
const DB = location.protocol === 'file:' ? (() => {
  const STORES = ['projects', 'notes', 'tasks', 'images'];
  let db;

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('forkpad', 1);
      req.onupgradeneeded = () => {
        for (const s of STORES) {
          if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => { db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }

  function run(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => resolve(r instanceof IDBRequest ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const withType = i => i && { ...i, type: i.blob?.type || 'image/png' };

  return {
    open,
    local: true,
    all: async s => { const r = await run(s, 'readonly', st => st.getAll()); return s === 'images' ? r.map(withType) : r; },
    get: async (s, id) => { const r = await run(s, 'readonly', st => st.get(id)); return s === 'images' ? withType(r) : r; },
    put: (s, v) => run(s, 'readwrite', st => st.put(v)),
    putMany: (s, list) => run(s, 'readwrite', st => { list.forEach(v => st.put(v)); }),
    del: (s, id) => run(s, 'readwrite', st => st.delete(id)),
    imageURL: () => null,
    info: async () => ({ dataDir: null, bytes: (await navigator.storage?.estimate?.().catch(() => null))?.usage }),
    prefs: async () => ({}),
    watch: () => {},
  };
})() : (() => {
  let onError = () => {};
  async function api(path, opts = {}) {
    let r;
    try { r = await fetch('/api/' + path, { cache: 'no-store', ...opts }); } catch (e) { onError(e); throw e; }
    if (r.status === 404 && (!opts.method || opts.method === 'GET')) return null;
    if (!r.ok) { const e = new Error(`ForkPad helper said ${r.status} for ${path}`); onError(e); throw e; }
    return r;
  }
  const json = r => r && r.json();
  const enc = encodeURIComponent;
  const putJSON = (path, body, method = 'PUT') => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  return {
    open: () => api('ping').then(r => { if (!r) throw new Error("The ForkPad helper isn't answering."); }),
    local: false,
    all: s => api(s).then(json),
    async get(s, id) {
      if (s !== 'images') return api(`${s}/${enc(id)}`).then(json).then(x => x || undefined);
      const r = await api(`images/${enc(id)}`);
      if (!r) return undefined;
      const blob = await r.blob();
      return { id, blob, type: blob.type, created: Date.now() };
    },
    put(s, v) {
      if (s === 'images') return api(`images/${enc(v.id)}`, { method: 'PUT', headers: { 'Content-Type': v.blob.type || 'image/png', 'X-Created': String(v.created || Date.now()) }, body: v.blob });
      return putJSON(`${s}/${enc(v.id)}`, v);
    },
    putMany: (s, list) => putJSON(s, list, 'POST'),
    del: (s, id) => api(`${s}/${enc(id)}`, { method: 'DELETE' }),
    imageURL: id => '/api/images/' + enc(id),
    info: () => api('info').then(json),
    prefs: () => api('prefs').then(json),
    // Calls onChange({ store, id, deleted }) when another program (Claude) edits the data,
    // and onChange({ resync: true }) after the connection to the helper comes back.
    watch(onChange, onStatus) {
      onError = () => onStatus(false);
      let es, wasDown = false, downTimer;
      const connect = () => {
        es = new EventSource('/api/events');
        es.onopen = () => { clearTimeout(downTimer); onStatus(true); if (wasDown) onChange({ resync: true }); wasDown = false; };
        es.onmessage = e => { try { onChange(JSON.parse(e.data)); } catch { /* ignore */ } };
        es.onerror = () => {
          wasDown = true;
          clearTimeout(downTimer);
          downTimer = setTimeout(() => onStatus(false), 4000);
          if (es.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
        };
      };
      connect();
    },
  };
})();
