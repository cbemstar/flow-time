/* ============================================================
   Flow — local (no-server) backend

   Implements exactly the surface the app already talks to, but
   against IndexedDB in the browser instead of an HTTP API. The
   rules come from lib/domain.js — the same module the server
   runs — so a to do created offline is byte-for-byte the shape
   of one created online.

   IndexedDB, not localStorage: localStorage caps out around 5MB,
   blocks the main thread, and Safari evicts it after seven days
   of no visits. Losing someone's planner to a storage quirk is
   not an acceptable failure.
   ============================================================ */

import * as D from '/lib/domain.js';

const DB_NAME  = 'flow';
const STORE    = 'state';
const KEY      = 'db';
const VERSION  = 1;

let _idb = null;

function open() {
  if (_idb) return _idb;
  _idb = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _idb;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let req;
    try { req = fn(s); } catch (e) { reject(e); return; }
    // An IDBRequest for a missing key completes with result === undefined.
    // Returning the request itself in that case hands the caller a truthy
    // object that is not a database, which then fails validation instead of
    // reading as "nothing stored yet".
    t.oncomplete = () => resolve(req instanceof IDBRequest ? req.result : req);
    t.onerror    = () => reject(t.error);
    t.onabort    = () => reject(t.error);
  }));
}

async function read() {
  const raw = await tx('readonly', (s) => s.get(KEY));
  if (!raw) return D.EMPTY_DB();
  return D.migrate(D.sane(raw));
}

async function write(db) {
  if (!db || !Array.isArray(db.tasks)) throw new Error('refusing to save a malformed database');
  await tx('readwrite', (s) => s.put(db, KEY));
  return db;
}

/** load → mutate → save, so no caller can forget to persist */
async function edit(fn) {
  const db = await read();
  const out = fn(db);
  await write(db);
  return out;
}

export const localBackend = {
  mode: 'local',

  list:        ()            => read().then(db => db.tasks),
  create:      (t)           => edit(db => D.createTask(db, t)),
  update:      (id, patch)   => edit(db => D.patchTask(db, id, patch)),
  del:         (id, casc)    => edit(db => D.deleteTask(db, id, !!casc)),
  reorder:     (updates)     => edit(db => D.reorderTasks(db, updates)),
  replace:     (tasks, note) => edit(db => D.replaceTasks(db, tasks, note)),
  bulk:        (body)        => edit(db => D.bulk(db, body)),
  materialize: (until)       => edit(db => D.materialize(db, until)),

  activity:      ()   => read().then(db => db.activity || []),
  clearActivity: ()   => edit(db => { db.activity = []; return { ok: true }; }),

  settings:    ()     => read().then(D.readSettings),
  putSettings: (body) => edit(db => D.writeSettings(db, body)),

  templates:      ()   => read().then(db => db.templates || []),
  addTemplate:    (t)  => edit(db => D.addTemplate(db, t)),
  removeTemplate: (id) => edit(db => D.removeTemplate(db, id)),

  backup:  ()  => read(),
  restore: (incoming) => write(D.restore(incoming)).then(db => ({ ok: true, count: db.tasks.length })),

  /** the calendar feed, generated in the browser and handed over as a file */
  ics: () => read().then(D.buildICS),

  /* Google sync needs a server to hold the OAuth secret, so it is simply
     absent here rather than pretending and failing halfway. */
  gcalStatus: async () => ({ configured: false, connected: false, unavailable: 'local' }),

  async isEmpty() {
    const db = await read();
    return db.tasks.length === 0;
  },

  /** Used when moving from a server to this device. */
  importAll: (doc) => write(D.restore(doc)),
};
