import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR    = path.join(__dirname, 'data');
const DB_FILE     = path.join(DATA_DIR, 'db.json');
const BAK_FILE    = path.join(DATA_DIR, 'db.bak.json');
const LOCK_FILE   = path.join(DATA_DIR, '.server.lock');
const TOKENS_FILE = path.join(DATA_DIR, 'gcal-tokens.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ────────────────────────────────────────────────────────────
   Single-instance lock.

   Two servers sharing data/db.json is how a half-written temp file
   becomes corrupt JSON — which then read back as "empty" and got
   saved over the real data. One owner at a time, always.
   ──────────────────────────────────────────────────────────── */
function claimLock() {
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

const EMPTY_DB = () => ({ tasks: [], settings: {}, templates: [], activity: [] });

function readDBFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('not a Flow database');
  return { ...EMPTY_DB(), ...parsed };
}

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return EMPTY_DB();
  try {
    return readDBFile(DB_FILE);
  } catch (err) {
    /* Never fall through to an empty DB here. Returning {} on a bad read is
       what silently destroyed the file: the next save wrote the emptiness
       straight back. Quarantine the bad copy and recover from the backup. */
    const bad = `${DB_FILE}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(DB_FILE, bad); } catch {}
    if (fs.existsSync(BAK_FILE)) {
      try {
        const recovered = readDBFile(BAK_FILE);
        console.error(`  db.json unreadable (${err.message}).`);
        console.error(`  Bad copy kept at ${path.basename(bad)}; recovered ${recovered.tasks.length} tasks from db.bak.json`);
        return recovered;
      } catch {}
    }
    throw Object.assign(
      new Error(`db.json is unreadable (${err.message}) and no usable backup exists. A copy is at ${bad} — repair or delete it, then restart.`),
      { fatalDB: true });
  }
}

let writeSeq = 0;
function saveDB(db) {
  if (!db || !Array.isArray(db.tasks)) throw new Error('refusing to save a malformed database');
  // roll the last good file aside before overwriting it
  if (fs.existsSync(DB_FILE)) { try { fs.copyFileSync(DB_FILE, BAK_FILE); } catch {} }
  // process-unique temp name; a shared one is what let two writers collide
  const tmp = `${DB_FILE}.${process.pid}.${++writeSeq}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ────────────────────────────────────────────────────────────
   Activity log — what happened to a to do and when.
   Recorded here rather than in the browser so it survives
   reloads and reflects what actually hit the database.
   ──────────────────────────────────────────────────────────── */
const ACTIVITY_LIMIT = 300;

function logActivity(db, entry) {
  db.activity = db.activity || [];
  db.activity.unshift({ id: randomUUID(), at: new Date().toISOString(), ...entry });
  if (db.activity.length > ACTIVITY_LIMIT) db.activity.length = ACTIVITY_LIMIT;
}

function hoursLabel(h) {
  const n = Number(h) || 0;
  if (!n) return 'no estimate';
  if (Number.isInteger(n)) return n + 'h';
  const whole = Math.floor(n), mins = Math.round((n - whole) * 60);
  return whole ? `${whole}h ${mins}m` : `${mins}m`;
}
function timeLabel(t) {
  if (!t) return null;
  const [H, M] = String(t).split(':').map(Number);
  const ap = H < 12 ? 'am' : 'pm';
  return `${H % 12 === 0 ? 12 : H % 12}:${String(M || 0).padStart(2, '0')}${ap}`;
}

/** the human-readable diff between a task before and after a PATCH */
function describeChanges(a, b) {
  const out = [];
  if ((a.title || '') !== (b.title || ''))
    out.push({ kind: 'renamed', detail: `“${a.title || 'Untitled'}” → “${b.title || 'Untitled'}”` });
  if (!a.done && b.done)  out.push({ kind: 'completed', detail: '' });
  if (a.done && !b.done)  out.push({ kind: 'reopened',  detail: '' });
  if ((a.day || null) !== (b.day || null))
    out.push({ kind: 'moved', detail: b.day ? `to ${b.day}` : 'to My items' });
  if (Number(a.hours || 0) !== Number(b.hours || 0))
    out.push({ kind: 'hours', detail: `${hoursLabel(a.hours)} → ${hoursLabel(b.hours)}` });
  if ((a.startTime || null) !== (b.startTime || null))
    out.push({ kind: 'time', detail: b.startTime ? `starts ${timeLabel(b.startTime)}` : 'start time cleared' });
  if (!a.starred && b.starred) out.push({ kind: 'starred',   detail: '' });
  if (a.starred && !b.starred) out.push({ kind: 'unstarred', detail: '' });
  if (JSON.stringify(a.recurring || null) !== JSON.stringify(b.recurring || null))
    out.push({ kind: 'repeat', detail: b.recurring ? `repeats ${b.recurring.freq}` : 'repeat removed' });
  return out;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/tasks', (req, res) => {
  res.json(loadDB().tasks);
});

app.post('/api/tasks', (req, res) => {
  const db = loadDB();
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    title: 'Untitled',
    notes: '',
    hours: 0,
    color: 'blue',
    day: null,
    position: db.tasks.filter(t => (t.day ?? null) === (req.body.day ?? null) && !t.done).length,
    done: false,
    doneAt: null,
    createdAt: now,
    updatedAt: now,
    recurring: null,
    parentId: null,
    gcalEventId: null,
    starred: false,
    ...req.body,
  };
  db.tasks.push(task);
  logActivity(db, {
    kind: 'created', taskId: task.id, title: task.title,
    detail: task.day ? `on ${task.day}` : 'in My items',
  });
  saveDB(db);
  res.json(task);
});

app.patch('/api/tasks/:id', (req, res) => {
  const db = loadDB();
  const t = db.tasks.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const before = { ...t };
  const prevDone = t.done;
  Object.assign(t, req.body, { updatedAt: new Date().toISOString() });
  if (!prevDone && t.done) t.doneAt = new Date().toISOString();
  if (prevDone && !t.done) t.doneAt = null;
  for (const c of describeChanges(before, t)) {
    logActivity(db, { kind: c.kind, taskId: t.id, title: t.title, detail: c.detail });
  }

  /* Re-anchoring a series: if the parent's start date or its repeat rule
     changed, the occurrences generated off the old anchor are wrong. Drop the
     unfinished ones and let materialize rebuild them from the new start.
     Completed ones stay — they are a record of work actually done. */
  const wasSeries = !!before.recurring;
  const isSeries  = !!t.recurring;
  const anchorMoved = (before.day || null) !== (t.day || null);
  const ruleChanged = JSON.stringify(before.recurring || null) !== JSON.stringify(t.recurring || null);

  if ((wasSeries || isSeries) && (anchorMoved || ruleChanged)) {
    const stale = db.tasks.filter(x => x.parentId === t.id && !x.done).length;
    db.tasks = db.tasks.filter(x => !(x.parentId === t.id && !x.done));
    if (stale) {
      logActivity(db, {
        kind: 'repeat', taskId: t.id, title: t.title,
        detail: isSeries
          ? `start moved — ${stale} upcoming occurrence${stale > 1 ? 's' : ''} rebuilt`
          : `repeat removed — ${stale} upcoming occurrence${stale > 1 ? 's' : ''} dropped`,
      });
    }
  }

  saveDB(db);
  res.json(t);
});

app.delete('/api/tasks/:id', (req, res) => {
  const db = loadDB();
  const cascade = req.query.cascade === '1';
  const gone = db.tasks.find(t => t.id === req.params.id);
  const extra = cascade ? db.tasks.filter(t => t.parentId === req.params.id).length : 0;
  db.tasks = db.tasks.filter(t => t.id !== req.params.id && (!cascade || t.parentId !== req.params.id));
  if (gone) {
    logActivity(db, {
      kind: 'deleted', taskId: gone.id, title: gone.title,
      detail: extra ? `and ${extra} future occurrence${extra > 1 ? 's' : ''}` : '',
    });
  }
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/tasks/reorder', (req, res) => {
  const db = loadDB();
  const updates = req.body.updates || [];
  const now = new Date().toISOString();
  for (const u of updates) {
    const t = db.tasks.find(x => x.id === u.id);
    if (!t) continue;
    if ('day' in u) t.day = u.day;
    if ('position' in u) t.position = u.position;
    t.updatedAt = now;
  }
  saveDB(db);
  res.json({ ok: true });
});

/* ── bulk replace: the primitive undo/redo restores through ──── */
app.put('/api/tasks', (req, res) => {
  if (!Array.isArray(req.body?.tasks)) return res.status(400).json({ error: 'tasks[] required' });
  const db = loadDB();
  db.tasks = req.body.tasks;
  if (req.body.note) logActivity(db, { kind: 'undo', title: '', detail: req.body.note });
  saveDB(db);
  res.json({ ok: true, count: db.tasks.length });
});

/* ── bulk edit: one write, not N round trips ─────────────────── */
app.post('/api/tasks/bulk', (req, res) => {
  const { ids = [], action, patch = {} } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids[] required' });

  const db  = loadDB();
  const set = new Set(ids);
  const now = new Date().toISOString();
  let n = 0;

  if (action === 'delete') {
    n = db.tasks.filter(t => set.has(t.id)).length;
    db.tasks = db.tasks.filter(t => !set.has(t.id));
    logActivity(db, { kind: 'deleted', title: `${n} to do${n > 1 ? 's' : ''}`, detail: 'bulk delete' });

  } else if (action === 'shift') {
    const days = Number(patch.days) || 0;
    for (const t of db.tasks) {
      if (!set.has(t.id) || !t.day) continue;
      const d = parseYMD(t.day);
      d.setDate(d.getDate() + days);
      t.day = ymd(d);
      t.updatedAt = now;
      n++;
    }
    logActivity(db, {
      kind: 'moved', title: `${n} to do${n > 1 ? 's' : ''}`,
      detail: `shifted ${days > 0 ? '+' : ''}${days} day${Math.abs(days) === 1 ? '' : 's'}`,
    });

  } else if (action === 'patch') {
    for (const t of db.tasks) {
      if (!set.has(t.id)) continue;
      const was = t.done;
      Object.assign(t, patch, { updatedAt: now });
      if (!was && t.done) t.doneAt = now;
      if (was && !t.done) t.doneAt = null;
      n++;
    }
    const bits = [];
    if ('day' in patch)     bits.push(patch.day ? `moved to ${patch.day}` : 'moved to My items');
    if ('done' in patch)    bits.push(patch.done ? 'completed' : 'reopened');
    if ('starred' in patch) bits.push(patch.starred ? 'starred' : 'unstarred');
    if ('color' in patch)   bits.push(`recoloured ${patch.color}`);
    if ('hours' in patch)   bits.push(`set to ${hoursLabel(patch.hours)}`);
    logActivity(db, { kind: 'moved', title: `${n} to do${n > 1 ? 's' : ''}`, detail: bits.join(', ') || 'bulk edit' });

  } else {
    return res.status(400).json({ error: 'unknown action' });
  }

  saveDB(db);
  res.json({ ok: true, count: n });
});

/* ── activity log ────────────────────────────────────────────── */
app.get('/api/activity', (req, res) => res.json(loadDB().activity || []));

app.delete('/api/activity', (req, res) => {
  const db = loadDB();
  db.activity = [];
  saveDB(db);
  res.json({ ok: true });
});

/* ── settings ────────────────────────────────────────────────── */
const DEFAULT_SETTINGS = { capacityHours: 8, dayStart: '09:00', pxPerHour: 34 };
app.get('/api/settings', (req, res) => {
  res.json({ ...DEFAULT_SETTINGS, ...(loadDB().settings || {}) });
});
app.put('/api/settings', (req, res) => {
  const db = loadDB();
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}), ...req.body };
  saveDB(db);
  res.json(db.settings);
});

/* ── quick-add templates ─────────────────────────────────────── */
app.get('/api/templates', (req, res) => res.json(loadDB().templates || []));

app.post('/api/templates', (req, res) => {
  const db = loadDB();
  db.templates = db.templates || [];
  const tpl = {
    id: randomUUID(),
    title: 'Untitled',
    notes: '', hours: 0, color: 'navy',
    startTime: null, recurring: null, hideNotes: false,
    ...req.body,
  };
  db.templates.push(tpl);
  saveDB(db);
  res.json(tpl);
});

app.delete('/api/templates/:id', (req, res) => {
  const db = loadDB();
  db.templates = (db.templates || []).filter(t => t.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

/* ── backup / restore ────────────────────────────────────────── */
app.get('/api/backup', (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="flow-backup-${stamp}.json"`);
  res.send(JSON.stringify(loadDB(), null, 2));
});

app.post('/api/restore', (req, res) => {
  const incoming = req.body;
  if (!incoming || !Array.isArray(incoming.tasks)) {
    return res.status(400).json({ error: "That file isn't a Flow backup (no tasks array)." });
  }
  saveDB({
    tasks: incoming.tasks,
    settings: incoming.settings || {},
    templates: incoming.templates || [],
    activity: incoming.activity || [],
  });
  res.json({ ok: true, count: incoming.tasks.length });
});

function ymd(d) {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${da}`;
}
function parseYMD(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function nextDate(dateStr, freq) {
  const d = parseYMD(dateStr);
  if (freq === 'daily') d.setDate(d.getDate() + 1);
  else if (freq === 'weekdays') {
    do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  }
  else if (freq === 'weekly') d.setDate(d.getDate() + 7);
  else if (freq === 'biweekly') d.setDate(d.getDate() + 14);
  else if (freq === 'monthly') d.setMonth(d.getMonth() + 1);
  else return null;
  return ymd(d);
}

app.post('/api/tasks/materialize', (req, res) => {
  const db = loadDB();
  const untilStr = req.body.until || ymd(addDays(new Date(), 60));
  const created = [];
  const now = new Date().toISOString();
  const parents = db.tasks.filter(t => t.recurring && !t.parentId && t.day);
  for (const p of parents) {
    let cur = p.day;
    let guard = 0;
    while (guard++ < 500) {
      const next = nextDate(cur, p.recurring.freq);
      if (!next) break;
      if (next > untilStr) break;
      if (p.recurring.until && next > p.recurring.until) break;
      const exists = db.tasks.find(t => t.parentId === p.id && t.day === next);
      if (!exists) {
        const instance = {
          id: randomUUID(),
          title: p.title,
          notes: p.notes,
          hours: p.hours,
          color: p.color,
          day: next,
          position: 999,
          done: false,
          doneAt: null,
          createdAt: now,
          updatedAt: now,
          recurring: null,
          parentId: p.id,
          gcalEventId: null,
        };
        db.tasks.push(instance);
        created.push(instance);
      }
      cur = next;
    }
  }
  saveDB(db);
  res.json({ created: created.length });
});

/** a task's real start instant — its own startTime, or 9am if unset */
function startFor(t, fallback = '09:00') {
  const d = parseYMD(t.day);
  const [H, M] = String(t.startTime || fallback || '09:00').split(':').map(Number);
  d.setHours(Number.isFinite(H) ? H : 9, Number.isFinite(M) ? M : 0, 0, 0);
  return d;
}

function escapeICS(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
function fmtICSLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}
function fmtICSUTC(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

app.get('/calendar.ics', (req, res) => {
  const db = loadDB();
  const nowStamp = fmtICSUTC(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//streamtime-clone//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Flow — To Do',
  ];
  for (const t of db.tasks) {
    if (!t.day) continue;
    const hours = Math.max(0.25, Number(t.hours) || 1);
    const start = startFor(t, db.settings?.dayStart);
    const end = new Date(start.getTime() + hours * 3600000);
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${t.id}@flow.local`);
    lines.push(`DTSTAMP:${nowStamp}`);
    lines.push(`DTSTART:${fmtICSLocal(start)}`);
    lines.push(`DTEND:${fmtICSLocal(end)}`);
    lines.push(`SUMMARY:${(t.done ? '✓ ' : '') + escapeICS(t.title || 'Task')}`);
    if (t.notes) lines.push(`DESCRIPTION:${escapeICS(t.notes)}`);
    if (t.done) lines.push('STATUS:CONFIRMED');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="flow.ics"');
  res.send(lines.join('\r\n'));
});

let googleModule = null;
async function getGoogle() {
  if (!googleModule) {
    try { googleModule = (await import('googleapis')).google; }
    catch { googleModule = null; }
  }
  return googleModule;
}

function getOAuthClient(google) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth/google/callback`
  );
}

app.get('/api/gcal/status', (req, res) => {
  res.json({
    configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    connected: fs.existsSync(TOKENS_FILE),
  });
});

app.get('/oauth/google', async (req, res) => {
  const google = await getGoogle();
  if (!google || !process.env.GOOGLE_CLIENT_ID) {
    return res.status(400).send('<h1>Google OAuth not configured</h1><p>Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your .env file and restart.</p>');
  }
  const oauth = getOAuthClient(google);
  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
  });
  res.redirect(url);
});

app.get('/oauth/google/callback', async (req, res) => {
  try {
    const google = await getGoogle();
    const oauth = getOAuthClient(google);
    const { tokens } = await oauth.getToken(req.query.code);
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
    res.send('<h1>✓ Connected to Google Calendar</h1><p>You can close this tab and go back to Flow.</p><script>setTimeout(()=>window.close(),1500)</script>');
  } catch (e) {
    res.status(500).send('<h1>OAuth failed</h1><pre>' + String(e.message) + '</pre>');
  }
});

app.post('/api/gcal/disconnect', (req, res) => {
  if (fs.existsSync(TOKENS_FILE)) fs.unlinkSync(TOKENS_FILE);
  res.json({ ok: true });
});

app.post('/api/gcal/sync', async (req, res) => {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return res.status(400).json({ error: 'Not connected' });
    const google = await getGoogle();
    const oauth = getOAuthClient(google);
    oauth.setCredentials(JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')));
    const cal = google.calendar({ version: 'v3', auth: oauth });
    const db = loadDB();
    let pushed = 0, updated = 0, removed = 0;
    for (const t of db.tasks) {
      const hasDate = !!t.day;
      const shouldExist = hasDate;
      if (!shouldExist && t.gcalEventId) {
        try { await cal.events.delete({ calendarId: 'primary', eventId: t.gcalEventId }); removed++; } catch {}
        t.gcalEventId = null;
        continue;
      }
      if (!shouldExist) continue;
      const hours = Math.max(0.25, Number(t.hours) || 1);
      const start = startFor(t, db.settings?.dayStart);
      const end = new Date(start.getTime() + hours * 3600000);
      const body = {
        summary: (t.done ? '✓ ' : '') + (t.title || 'Task'),
        description: t.notes || '',
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
      };
      try {
        if (t.gcalEventId) {
          await cal.events.update({ calendarId: 'primary', eventId: t.gcalEventId, requestBody: body });
          updated++;
        } else {
          const r = await cal.events.insert({ calendarId: 'primary', requestBody: body });
          t.gcalEventId = r.data.id;
          pushed++;
        }
      } catch (e) {
        console.error('Sync error for', t.title, e.message);
      }
    }
    saveDB(db);
    res.json({ pushed, updated, removed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/gcal/pull', async (req, res) => {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return res.status(400).json({ error: 'Not connected' });
    const google = await getGoogle();
    const oauth = getOAuthClient(google);
    oauth.setCredentials(JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')));
    const cal = google.calendar({ version: 'v3', auth: oauth });
    const db = loadDB();
    const idMap = new Map(db.tasks.filter(t => t.gcalEventId).map(t => [t.gcalEventId, t]));
    let updated = 0;
    for (const [eid, t] of idMap) {
      try {
        const { data } = await cal.events.get({ calendarId: 'primary', eventId: eid });
        if (data.status === 'cancelled') { t.gcalEventId = null; continue; }
        if (data.start?.dateTime) {
          const startD = new Date(data.start.dateTime);
          t.day = ymd(startD);
          t.startTime = `${String(startD.getHours()).padStart(2, '0')}:${String(startD.getMinutes()).padStart(2, '0')}`;
          const endD = new Date(data.end.dateTime);
          t.hours = Math.round(((endD - startD) / 3600000) * 4) / 4;
        }
        if (data.summary) t.title = data.summary.replace(/^✓\s*/, '');
        updated++;
      } catch {}
    }
    saveDB(db);
    res.json({ updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

/* surface storage failures clearly instead of dying with a bare stack */
app.use((err, req, res, _next) => {
  console.error(err.fatalDB ? `\n  STORAGE ERROR: ${err.message}\n` : err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n  Flow (streamtime-clone) running at http://localhost:${PORT}\n`);
});
