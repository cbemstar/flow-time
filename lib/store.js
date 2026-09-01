/* ============================================================
   Flow — storage
   Two drivers behind one async interface.

     file      local development. Atomic rename + rolling backup.
     postgres  anything serverless. Vercel gives each invocation a
               fresh, read-only filesystem, so a JSON file on disk
               would vanish between requests.

   The whole database is one JSON document either way. Flow is a
   single-user planner holding a few hundred to dos, so a document
   swap costs nothing and keeps the two drivers honest with each
   other — there is no schema that can drift between them.
   ============================================================ */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');
const DATA_DIR  = path.join(ROOT, 'data');
const DB_FILE   = path.join(DATA_DIR, 'db.json');
const BAK_FILE  = path.join(DATA_DIR, 'db.bak.json');
const TOK_FILE  = path.join(DATA_DIR, 'gcal-tokens.json');

export const EMPTY_DB = () => ({ tasks: [], settings: {}, templates: [], activity: [] });

const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
export const DRIVER = PG_URL ? 'postgres' : 'file';

/* Anytime used to be inferred from "hours === 0", which meant a to do with no
   estimate silently fell out of the timed pile. It is explicit now, so older
   rows need the flag stamped on to keep them where they sit. */
function migrate(db) {
  if (db.schemaVersion >= 2) return db;
  for (const t of db.tasks) {
    if (typeof t.anytime !== 'boolean') t.anytime = !Number(t.hours);
  }
  db.schemaVersion = 2;
  return db;
}

function sane(parsed) {
  if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('not a Flow database');
  return { ...EMPTY_DB(), ...parsed };
}

/* ── file driver ───────────────────────────────────────────── */

function fileRead(file) { return sane(JSON.parse(fs.readFileSync(file, 'utf8'))); }

let writeSeq = 0;
const fileDriver = {
  async load() {
    if (!fs.existsSync(DB_FILE)) return migrate(EMPTY_DB());
    try {
      return migrate(fileRead(DB_FILE));
    } catch (err) {
      /* Never fall through to an empty DB: returning {} on a bad read is what
         silently destroyed the file, because the next save wrote the emptiness
         straight back. Quarantine the bad copy and recover from the backup. */
      const bad = `${DB_FILE}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(DB_FILE, bad); } catch {}
      if (fs.existsSync(BAK_FILE)) {
        try {
          const recovered = fileRead(BAK_FILE);
          console.error(`  db.json unreadable (${err.message}); recovered ${recovered.tasks.length} tasks from db.bak.json`);
          return migrate(recovered);
        } catch {}
      }
      throw Object.assign(
        new Error(`db.json is unreadable (${err.message}) and no usable backup exists. A copy is at ${bad} — repair or delete it, then restart.`),
        { fatalDB: true });
    }
  },
  async save(db) {
    if (!db || !Array.isArray(db.tasks)) throw new Error('refusing to save a malformed database');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) { try { fs.copyFileSync(DB_FILE, BAK_FILE); } catch {} }
    const tmp = `${DB_FILE}.${process.pid}.${++writeSeq}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);          // rename is atomic; a partial write never lands
  },
  async loadTokens() {
    if (!fs.existsSync(TOK_FILE)) return null;
    try { return JSON.parse(fs.readFileSync(TOK_FILE, 'utf8')); } catch { return null; }
  },
  async saveTokens(tokens) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOK_FILE, JSON.stringify(tokens, null, 2));
  },
  async clearTokens() { try { fs.unlinkSync(TOK_FILE); } catch {} },
};

/* ── postgres driver ───────────────────────────────────────── */

let pool = null;
let ready = null;

async function pg() {
  if (!pool) {
    const { default: Pg } = await import('pg');
    pool = new Pg.Pool({
      connectionString: PG_URL,
      // Managed Postgres (Neon, Supabase, Vercel) terminates TLS with its own
      // chain; verifying it needs a CA bundle we do not ship.
      ssl: /localhost|127\.0\.0\.1/.test(PG_URL) ? false : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10_000,
    });
  }
  if (!ready) {
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS flow_state (
        key        text PRIMARY KEY,
        value      jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`).catch((e) => { ready = null; throw e; });
  }
  await ready;
  return pool;
}

async function pgGet(key) {
  const p = await pg();
  const { rows } = await p.query('SELECT value FROM flow_state WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}

async function pgSet(key, value) {
  const p = await pg();
  await p.query(
    `INSERT INTO flow_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

const pgDriver = {
  async load() {
    const raw = await pgGet('db');
    if (!raw) return migrate(EMPTY_DB());
    return migrate(sane(raw));
  },
  async save(db) {
    if (!db || !Array.isArray(db.tasks)) throw new Error('refusing to save a malformed database');
    await pgSet('db', db);
  },
  loadTokens:  () => pgGet('gcal_tokens'),
  saveTokens:  (t) => pgSet('gcal_tokens', t),
  clearTokens: () => pgSet('gcal_tokens', null),
};

/* ── public interface ──────────────────────────────────────── */

const driver = DRIVER === 'postgres' ? pgDriver : fileDriver;

export const loadDB      = () => driver.load();
export const saveDB      = (db) => driver.save(db);
export const loadTokens  = async () => (await driver.loadTokens()) || null;
export const saveTokens  = (t) => driver.saveTokens(t);
export const clearTokens = () => driver.clearTokens();

/** Report what storage is live — surfaced by /api/health after a deploy. */
export async function describe() {
  try {
    const db = await loadDB();
    return { driver: DRIVER, ok: true, tasks: db.tasks.length };
  } catch (err) {
    return { driver: DRIVER, ok: false, error: err.message };
  }
}
