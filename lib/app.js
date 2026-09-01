import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import { loadDB, saveDB, loadTokens, saveTokens, clearTokens, describe, DRIVER } from './store.js';
// The single copy of the domain rules. It lives under public/ because the
// browser must be able to load it too when Flow runs with no server; Node
// imports the very same file, so the two can never drift apart.
import * as D from '../public/lib/domain.js';
import { authEnabled, requireAuth, hasSession, checkPassword, issueSession,
         clearSession, calendarAllowed, assertProductionSafe } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

assertProductionSafe();

/** Express 4 drops a rejected promise on the floor and the request hangs.
 *  Every async handler goes through here so failures reach the error handler. */
const A = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(ROOT, 'public')));

/* ── access gate ──────────────────────────────────────────────
   The HTML shell is public — it holds no to dos, and on Vercel it
   is served straight off the CDN without touching this function.
   Everything that carries data goes through requireAuth.
   ─────────────────────────────────────────────────────────── */

app.get('/api/session', (req, res) => {
  res.json({ authRequired: authEnabled(), signedIn: hasSession(req) });
});

app.post('/api/session', (req, res) => {
  if (!authEnabled()) return res.json({ signedIn: true });
  // a wrong password should not be worth grinding at over the network
  if (!checkPassword(req.body?.password)) {
    return setTimeout(() => res.status(401).json({ error: 'Wrong password' }), 400);
  }
  issueSession(res);
  res.json({ signedIn: true });
});

app.delete('/api/session', (req, res) => { clearSession(res); res.json({ signedIn: false }); });

app.get('/api/health', A(async (req, res) => {
  res.json({ ok: true, storage: await describe(), auth: authEnabled() ? 'on' : 'off' });
}));

// calendar clients cannot sign in, so the feed takes a key in the query instead
app.get('/calendar.ics', (req, res, next) => {
  if (calendarAllowed(req)) return next();
  res.status(401).type('text/plain').send('This calendar feed is private. Append ?key=<CALENDAR_KEY>.');
});

app.use('/api', (req, res, next) => {
  if (req.path === '/session' || req.path === '/health') return next();
  return requireAuth(req, res, next);
});
app.use('/oauth', requireAuth);

app.get('/api/tasks', A(async (req, res) => {
  res.json((await loadDB()).tasks);
}));

app.post('/api/tasks', A(async (req, res) => {
  const db = await loadDB();
  const task = D.createTask(db, req.body);
  await saveDB(db);
  res.json(task);
}));

app.patch('/api/tasks/:id', A(async (req, res) => {
  const db = await loadDB();
  const t = D.patchTask(db, req.params.id, req.body);
  if (!t) return res.status(404).json({ error: 'not found' });
  await saveDB(db);
  res.json(t);
}));

app.delete('/api/tasks/:id', A(async (req, res) => {
  const db = await loadDB();
  const out = D.deleteTask(db, req.params.id, req.query.cascade === '1');
  await saveDB(db);
  res.json(out);
}));

app.post('/api/tasks/reorder', A(async (req, res) => {
  const db = await loadDB();
  const out = D.reorderTasks(db, req.body.updates || []);
  await saveDB(db);
  res.json(out);
}));

/* ── bulk replace: the primitive undo/redo restores through ──── */
app.put('/api/tasks', A(async (req, res) => {
  if (!Array.isArray(req.body?.tasks)) return res.status(400).json({ error: 'tasks[] required' });
  const db = await loadDB();
  const out = D.replaceTasks(db, req.body.tasks, req.body.note);
  await saveDB(db);
  res.json(out);
}));

/* ── bulk edit: one write, not N round trips ─────────────────── */
app.post('/api/tasks/bulk', A(async (req, res) => {
  const db = await loadDB();
  let out;
  try { out = D.bulk(db, req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  await saveDB(db);
  res.json(out);
}));

/* ── activity log ────────────────────────────────────────────── */
app.get('/api/activity', A(async (req, res) => res.json((await loadDB()).activity || [])));

app.delete('/api/activity', A(async (req, res) => {
  const db = await loadDB();
  db.activity = [];
  await saveDB(db);
  res.json({ ok: true });
}));

/* ── settings ────────────────────────────────────────────────── */
app.get('/api/settings', A(async (req, res) => res.json(D.readSettings(await loadDB()))));
app.put('/api/settings', A(async (req, res) => {
  const db = await loadDB();
  const out = D.writeSettings(db, req.body);
  await saveDB(db);
  res.json(out);
}));

/* ── quick-add templates ─────────────────────────────────────── */
app.get('/api/templates', A(async (req, res) => res.json((await loadDB()).templates || [])));

app.post('/api/templates', A(async (req, res) => {
  const db = await loadDB();
  const tpl = D.addTemplate(db, req.body);
  await saveDB(db);
  res.json(tpl);
}));

app.delete('/api/templates/:id', A(async (req, res) => {
  const db = await loadDB();
  const out = D.removeTemplate(db, req.params.id);
  await saveDB(db);
  res.json(out);
}));

/* ── backup / restore ────────────────────────────────────────── */
app.get('/api/backup', A(async (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="flow-backup-${stamp}.json"`);
  res.send(JSON.stringify(await loadDB(), null, 2));
}));

app.post('/api/restore', A(async (req, res) => {
  let clean;
  try { clean = D.restore(req.body); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  await saveDB(clean);
  res.json({ ok: true, count: clean.tasks.length });
}));

app.post('/api/tasks/materialize', A(async (req, res) => {
  const db = await loadDB();
  const out = D.materialize(db, req.body.until);
  await saveDB(db);
  res.json(out);
}));

app.get('/calendar.ics', A(async (req, res) => {
  const db = await loadDB();
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="flow.ics"');
  res.send(D.buildICS(db));
}));

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

app.get('/api/gcal/status', A(async (req, res) => {
  res.json({
    configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    connected: !!(await loadTokens()),
  });
}));

app.get('/oauth/google', A(async (req, res) => {
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
}));

app.get('/oauth/google/callback', A(async (req, res) => {
  try {
    const google = await getGoogle();
    const oauth = getOAuthClient(google);
    const { tokens } = await oauth.getToken(req.query.code);
    await saveTokens(tokens);
    res.send('<h1>✓ Connected to Google Calendar</h1><p>You can close this tab and go back to Flow.</p><script>setTimeout(()=>window.close(),1500)</script>');
  } catch (e) {
    res.status(500).send('<h1>OAuth failed</h1><pre>' + String(e.message) + '</pre>');
  }
}));

app.post('/api/gcal/disconnect', A(async (req, res) => {
  await clearTokens();
  res.json({ ok: true });
}));

app.post('/api/gcal/sync', A(async (req, res) => {
  try {
    const saved = await loadTokens();
    if (!saved) return res.status(400).json({ error: 'Not connected' });
    const google = await getGoogle();
    const oauth = getOAuthClient(google);
    oauth.setCredentials(saved);
    const cal = google.calendar({ version: 'v3', auth: oauth });
    const db = await loadDB();
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
      const start = D.startFor(t, db.settings?.dayStart);
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
    await saveDB(db);
    res.json({ pushed, updated, removed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

app.post('/api/gcal/pull', A(async (req, res) => {
  try {
    const saved = await loadTokens();
    if (!saved) return res.status(400).json({ error: 'Not connected' });
    const google = await getGoogle();
    const oauth = getOAuthClient(google);
    oauth.setCredentials(saved);
    const cal = google.calendar({ version: 'v3', auth: oauth });
    const db = await loadDB();
    const idMap = new Map(db.tasks.filter(t => t.gcalEventId).map(t => [t.gcalEventId, t]));
    let updated = 0;
    for (const [eid, t] of idMap) {
      try {
        const { data } = await cal.events.get({ calendarId: 'primary', eventId: eid });
        if (data.status === 'cancelled') { t.gcalEventId = null; continue; }
        if (data.start?.dateTime) {
          const startD = new Date(data.start.dateTime);
          t.day = D.ymd(startD);
          t.startTime = `${String(startD.getHours()).padStart(2, '0')}:${String(startD.getMinutes()).padStart(2, '0')}`;
          const endD = new Date(data.end.dateTime);
          t.hours = Math.round(((endD - startD) / 3600000) * 4) / 4;
        }
        if (data.summary) t.title = data.summary.replace(/^✓\s*/, '');
        updated++;
      } catch {}
    }
    await saveDB(db);
    res.json({ updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

/* surface storage failures clearly instead of dying with a bare stack */
app.use((err, req, res, _next) => {
  console.error(err.fatalDB ? `\n  STORAGE ERROR: ${err.message}\n` : err);
  res.status(500).json({ error: err.message });
});

export default app;
