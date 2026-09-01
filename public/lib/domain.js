/* ============================================================
   Flow — domain logic
   Every rule about what a to do *is* lives here: defaults,
   recurrence, the activity log, bulk edits, the calendar feed.

   Deliberately free of Express, Node and the filesystem. The
   server imports it, and so does the browser when Flow runs with
   no server at all (public/local-store.js). One implementation,
   so a task created offline is identical to one created online.

   Every function takes a plain `db` document and mutates it, then
   the caller persists. Both callers hold the whole document, so
   there is nothing to gain from a finer-grained interface.
   ============================================================ */

export const ACTIVITY_LIMIT  = 300;
export const DEFAULT_SETTINGS = { capacityHours: 8, dayStart: '09:00', pxPerHour: 34 };

export const EMPTY_DB = () => ({ tasks: [], settings: {}, templates: [], activity: [] });

/** Available in browsers (secure contexts) and Node 19+. */
export const uid = () => globalThis.crypto.randomUUID();

const nowISO = () => new Date().toISOString();

/* ── dates ─────────────────────────────────────────────────── */

export function ymd(d) {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${da}`;
}
export function parseYMD(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
export function nextDate(dateStr, freq) {
  const d = parseYMD(dateStr);
  if (freq === 'daily') d.setDate(d.getDate() + 1);
  else if (freq === 'weekdays') {
    do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  }
  else if (freq === 'weekly')   d.setDate(d.getDate() + 7);
  else if (freq === 'biweekly') d.setDate(d.getDate() + 14);
  else if (freq === 'monthly')  d.setMonth(d.getMonth() + 1);
  else return null;
  return ymd(d);
}

/* ── schema ────────────────────────────────────────────────── */

/* Anytime used to be inferred from "hours === 0", which meant a to do with no
   estimate silently fell out of the timed pile. It is explicit now, so older
   rows need the flag stamped on to keep them where they sit. */
export function migrate(db) {
  if (db.schemaVersion >= 2) return db;
  for (const t of db.tasks) {
    if (typeof t.anytime !== 'boolean') t.anytime = !Number(t.hours);
  }
  db.schemaVersion = 2;
  return db;
}

export function sane(parsed) {
  if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('not a Flow database');
  return { ...EMPTY_DB(), ...parsed };
}

/* ── activity ──────────────────────────────────────────────── */

export function logActivity(db, entry) {
  db.activity = db.activity || [];
  db.activity.unshift({ id: uid(), at: nowISO(), ...entry });
  if (db.activity.length > ACTIVITY_LIMIT) db.activity.length = ACTIVITY_LIMIT;
}

export function hoursLabel(h) {
  const n = Number(h) || 0;
  if (!n) return 'no estimate';
  if (Number.isInteger(n)) return n + 'h';
  const whole = Math.floor(n), mins = Math.round((n - whole) * 60);
  return whole ? `${whole}h ${mins}m` : `${mins}m`;
}

export function timeLabel(t) {
  if (!t) return null;
  const [H, M] = String(t).split(':').map(Number);
  const ap = H < 12 ? 'am' : 'pm';
  return `${H % 12 === 0 ? 12 : H % 12}:${String(M || 0).padStart(2, '0')}${ap}`;
}

/** the human-readable diff between a task before and after a patch */
export function describeChanges(a, b) {
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
  return out;
}

/* ── tasks ─────────────────────────────────────────────────── */

export function createTask(db, body = {}) {
  const now = nowISO();
  const task = {
    id: uid(),
    title: 'Untitled',
    notes: '',
    hours: 0,
    anytime: false,
    color: 'blue',
    day: null,
    position: db.tasks.filter(t => (t.day ?? null) === (body.day ?? null) && !t.done).length,
    done: false,
    doneAt: null,
    createdAt: now,
    updatedAt: now,
    recurring: null,
    parentId: null,
    gcalEventId: null,
    starred: false,
    ...body,
  };
  db.tasks.push(task);
  logActivity(db, {
    kind: 'created', taskId: task.id, title: task.title,
    detail: task.day ? `on ${task.day}` : 'in My items',
  });
  return task;
}

export function patchTask(db, id, patch = {}) {
  const t = db.tasks.find(x => x.id === id);
  if (!t) return null;
  const before = { ...t };
  const prevDone = t.done;
  Object.assign(t, patch, { updatedAt: nowISO() });
  if (!prevDone && t.done) t.doneAt = nowISO();
  if (prevDone && !t.done) t.doneAt = null;
  for (const c of describeChanges(before, t)) {
    logActivity(db, { kind: c.kind, taskId: t.id, title: t.title, detail: c.detail });
  }

  /* Re-anchoring a series: if the parent's start date or its repeat rule
     changed, the occurrences generated off the old anchor are wrong. Drop the
     unfinished ones and let materialize rebuild them from the new start.
     Completed ones stay — they are a record of work actually done. */
  const wasSeries   = !!before.recurring;
  const isSeries    = !!t.recurring;
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
  return t;
}

export function deleteTask(db, id, cascade = false) {
  const gone  = db.tasks.find(t => t.id === id);
  const extra = cascade ? db.tasks.filter(t => t.parentId === id).length : 0;
  db.tasks = db.tasks.filter(t => t.id !== id && (!cascade || t.parentId !== id));
  if (gone) {
    logActivity(db, {
      kind: 'deleted', taskId: gone.id, title: gone.title,
      detail: extra ? `and ${extra} future occurrence${extra > 1 ? 's' : ''}` : '',
    });
  }
  return { ok: true };
}

export function reorderTasks(db, updates = []) {
  const now = nowISO();
  for (const u of updates) {
    const t = db.tasks.find(x => x.id === u.id);
    if (!t) continue;
    if ('day' in u) t.day = u.day;
    if ('position' in u) t.position = u.position;
    t.updatedAt = now;
  }
  return { ok: true };
}

/** the primitive undo/redo restores through */
export function replaceTasks(db, tasks, note) {
  db.tasks = tasks;
  if (note) logActivity(db, { kind: 'undo', title: '', detail: note });
  return { ok: true, count: db.tasks.length };
}

export function bulk(db, { ids = [], action, patch = {} } = {}) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('ids[] required');
  const set = new Set(ids);
  const now = nowISO();
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
    throw new Error('unknown action');
  }
  return { ok: true, count: n };
}

/** Generate the occurrences of every repeating to do up to `until`. */
export function materialize(db, until) {
  const untilStr = until || ymd(addDays(new Date(), 60));
  const now = nowISO();
  let created = 0;
  const parents = db.tasks.filter(t => t.recurring && !t.parentId && t.day);
  for (const p of parents) {
    let cur = p.day;
    let guard = 0;
    while (guard++ < 500) {                       // a malformed rule must not spin forever
      const next = nextDate(cur, p.recurring.freq);
      if (!next) break;
      if (next > untilStr) break;
      if (p.recurring.until && next > p.recurring.until) break;
      if (!db.tasks.find(t => t.parentId === p.id && t.day === next)) {
        db.tasks.push({
          id: uid(),
          title: p.title, notes: p.notes, hours: p.hours, color: p.color,
          anytime: !!p.anytime,
          startTime: p.startTime ?? null,
          day: next, position: 999,
          done: false, doneAt: null,
          createdAt: now, updatedAt: now,
          recurring: null, parentId: p.id, gcalEventId: null,
          starred: false,
        });
        created++;
      }
      cur = next;
    }
  }
  return { created };
}

/* ── templates & settings ──────────────────────────────────── */

export function addTemplate(db, body = {}) {
  db.templates = db.templates || [];
  const tpl = {
    id: uid(),
    title: 'Untitled',
    notes: '', hours: 0, color: 'navy',
    startTime: null, recurring: null, hideNotes: false,
    ...body,
  };
  db.templates.push(tpl);
  return tpl;
}

export function removeTemplate(db, id) {
  db.templates = (db.templates || []).filter(t => t.id !== id);
  return { ok: true };
}

export const readSettings  = (db) => ({ ...DEFAULT_SETTINGS, ...(db.settings || {}) });
export function writeSettings(db, body = {}) {
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}), ...body };
  return db.settings;
}

export function restore(incoming) {
  if (!incoming || !Array.isArray(incoming.tasks)) {
    throw new Error("That file isn't a Flow backup (no tasks array).");
  }
  return {
    tasks:     incoming.tasks,
    settings:  incoming.settings  || {},
    templates: incoming.templates || [],
    activity:  incoming.activity  || [],
  };
}

/* ── calendar feed ─────────────────────────────────────────── */

/** a task's real start instant — its own startTime, or the day's start */
export function startFor(t, fallback = '09:00') {
  const d = parseYMD(t.day);
  const [H, M] = String(t.startTime || fallback || '09:00').split(':').map(Number);
  d.setHours(Number.isFinite(H) ? H : 9, Number.isFinite(M) ? M : 0, 0, 0);
  return d;
}

const escapeICS = (s) =>
  String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

const pad = (n) => String(n).padStart(2, '0');
const fmtICSLocal = (d) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const fmtICSUTC = (d) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/** The subscribed calendar feed.
 *  UIDs are `<task id>@flow.local` and must stay that way: a calendar client
 *  keys off the UID, so changing the scheme duplicates every event for anyone
 *  already subscribed. */
export function buildICS(db) {
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
    lines.push(`SUMMARY:${(t.done ? '\u2713 ' : '') + escapeICS(t.title || 'Task')}`);
    if (t.notes) lines.push(`DESCRIPTION:${escapeICS(t.notes)}`);
    if (t.done) lines.push('STATUS:CONFIRMED');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
