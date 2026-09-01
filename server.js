/* ============================================================
   Flow — local development server

   The app itself lives in lib/app.js so it can also be mounted as
   a serverless function (see api/index.js). This file adds the two
   things only a long-lived local process needs: a listening socket
   and the single-instance lock.
   ============================================================ */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import app from './lib/app.js';
import { DRIVER } from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = Number(process.env.PORT) || 3000;
const DATA_DIR  = path.join(__dirname, 'data');
const LOCK_FILE = path.join(DATA_DIR, '.server.lock');

/* ────────────────────────────────────────────────────────────
   Single-instance lock.

   Two servers sharing data/db.json is how a half-written temp file
   becomes corrupt JSON — which then read back as "empty" and got
   saved over the real data. One owner at a time, always.

   Only meaningful for the file driver: Postgres is the arbiter of
   its own writes, and serverless runs many instances by design.
   ──────────────────────────────────────────────────────────── */
function claimLock() {
  if (DRIVER !== 'file') return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    if (alive && pid !== process.pid) {
      console.error(`\n  Another Flow server (pid ${pid}) already owns data/db.json.\n  Stop it first:   kill ${pid}\n`);
      process.exit(1);
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock() {
  if (DRIVER !== 'file') return;
  try {
    if (fs.existsSync(LOCK_FILE) &&
        String(fs.readFileSync(LOCK_FILE, 'utf8')).trim() === String(process.pid)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

claimLock();
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { releaseLock(); process.exit(0); });
}

app.listen(PORT, () => {
  console.log(`\n  Flow — http://localhost:${PORT}`);
  console.log(`  storage: ${DRIVER}${DRIVER === 'file' ? ' (data/db.json)' : ''}\n`);
});
