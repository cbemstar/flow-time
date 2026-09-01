/* ============================================================
   Flow — Streamtime-style To Do / Done
   ============================================================ */

import { stagger, collapse } from '/anim.js';
import { confirmInline, closeConfirm } from '/confirm.js';

let   PX_HOUR   = 34;    // pixels per hour — set from settings.pxPerHour
const MIN_H     = 26;    // smallest block in px
const NO_EST_H  = 40;    // height for a block with no estimate
const MIN_HOURS = 0.25;  // snap floor (15 min)

const PALETTE = [
  { key: 'navy',   hex: '#12658F', light: false },
  { key: 'blue',   hex: '#1E88C4', light: false },
  { key: 'teal',   hex: '#2FB6B2', light: false },
  { key: 'sky',    hex: '#8FD1F0', light: true  },
  { key: 'mint',   hex: '#9AD3A8', light: true  },
  { key: 'yellow', hex: '#F7D046', light: true  },
  { key: 'sand',   hex: '#D9C9A3', light: true  },
  { key: 'orange', hex: '#F0894E', light: false },
  { key: 'coral',  hex: '#E06A55', light: false },
  { key: 'pink',   hex: '#E58AA6', light: false },
  { key: 'purple', hex: '#8E7CC3', light: false },
  { key: 'slate',  hex: '#7A8790', light: false },
];
const COLOR = Object.fromEntries(PALETTE.map(p => [p.key, p]));
const fallback = COLOR.navy;

/* ── state ─────────────────────────────────────────────────── */
let tasks        = [];
let weekStart    = startOfWeek(new Date());
let showWeekend  = false;
let selectedDay  = ymd(new Date());
let editingId    = null;
let pickedColor  = 'navy';
let searchTerm   = '';
let dragging     = false;
let suppressClick = false;
let settings     = { capacityHours: 8, dayStart: '09:00', pxPerHour: 34 };
let templates    = [];

const sortables = [];

/* ── undo / redo ───────────────────────────────────────────────
   Snapshot-based: the whole task list is small, so the safest
   undo is "put the previous list back" via PUT /api/tasks.
   ──────────────────────────────────────────────────────────── */
const UNDO_LIMIT = 40;
const undoStack = [];
const redoStack = [];

function snapshot() { return JSON.parse(JSON.stringify(tasks)); }

function pushUndo(label) {
  undoStack.push({ label, tasks: snapshot() });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

async function applyStack(from, to, verb) {
  if (!from.length) return toast(`Nothing to ${verb}`);
  const entry = from.pop();
  to.push({ label: entry.label, tasks: snapshot() });
  await api.replace(entry.tasks, `${verb === 'undo' ? 'Undid' : 'Redid'} ${entry.label}`);
  tasks = await api.list();          // deliberately not refresh(): materialising
  clampSelectedDay();                // here would re-add what we just undid
  render();
  toast(`${verb === 'undo' ? 'Undid' : 'Redid'} ${entry.label}`);
}
const undo = () => applyStack(undoStack, redoStack, 'undo');
const redo = () => applyStack(redoStack, undoStack, 'redo');

const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ── api ───────────────────────────────────────────────────── */
const J = { 'Content-Type': 'application/json' };

/* A deployed Flow sits behind a password. Any request can come back 401 —
   a session expiring mid-use looks exactly like a dead app otherwise, so
   the sign-in panel is raised from one place rather than per call site. */
const _fetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const res = await _fetch(input, init);
  if (res.status === 401 && String(input).startsWith('/api')) showSignIn();
  return res;
};

function showSignIn(message) {
  const el = document.getElementById('signIn');
  if (!el || !el.hidden) return;
  el.hidden = false;
  if (message) document.getElementById('signInError').textContent = message;
  setTimeout(() => document.getElementById('signInPw')?.focus(), 60);
}

/* The remote backend: this app talking to its own server. */
const remoteBackend = {
  mode: 'server',
  list:      ()          => fetch('/api/tasks').then(r => r.json()),
  create:    (t)         => fetch('/api/tasks', { method: 'POST', headers: J, body: JSON.stringify(t) }).then(r => r.json()),
  update:    (id, patch) => fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: J, body: JSON.stringify(patch) }).then(r => r.json()),
  del:       (id, casc)  => fetch(`/api/tasks/${id}${casc ? '?cascade=1' : ''}`, { method: 'DELETE' }).then(r => r.json()),
  reorder:   (updates)   => fetch('/api/tasks/reorder', { method: 'POST', headers: J, body: JSON.stringify({ updates }) }),
  materialize:(until)    => fetch('/api/tasks/materialize', { method: 'POST', headers: J, body: JSON.stringify({ until }) }).then(r => r.json()),
  gcalStatus:()          => fetch('/api/gcal/status').then(r => r.json()),
  gcalPush:  ()          => fetch('/api/gcal/sync', { method: 'POST' }).then(r => r.json()),
  gcalPull:  ()          => fetch('/api/gcal/pull', { method: 'POST' }).then(r => r.json()),
  gcalOff:   ()          => fetch('/api/gcal/disconnect', { method: 'POST' }).then(r => r.json()),
  replace:  (list, note) => fetch('/api/tasks', { method: 'PUT', headers: J, body: JSON.stringify({ tasks: list, note }) }).then(r => r.json()),
  settings:     ()     => fetch('/api/settings').then(r => r.json()),
  saveSettings: (s)    => fetch('/api/settings', { method: 'PUT', headers: J, body: JSON.stringify(s) }).then(r => r.json()),
  templates:    ()     => fetch('/api/templates').then(r => r.json()),
  addTemplate:  (t)    => fetch('/api/templates', { method: 'POST', headers: J, body: JSON.stringify(t) }).then(r => r.json()),
  delTemplate:  (id)   => fetch(`/api/templates/${id}`, { method: 'DELETE' }).then(r => r.json()),
  activity:     ()     => fetch('/api/activity').then(r => r.json()),
  clearActivity:()     => fetch('/api/activity', { method: 'DELETE' }).then(r => r.json()),
  bulk: (ids, action, patch) => fetch('/api/tasks/bulk', { method: 'POST', headers: J, body: JSON.stringify({ ids, action, patch }) }).then(r => r.json()),
  restore:      (d)    => fetch('/api/restore', { method: 'POST', headers: J, body: JSON.stringify(d) }).then(r => r.json()),
  backup:       ()     => fetch('/api/backup').then(r => r.json()),
};

/* The local backend speaks the same names but stores in IndexedDB. Adapted
   here rather than in local-store.js so that file stays a plain description
   of the storage, with the app's own vocabulary kept in one place. */
function adaptLocal(L) {
  return {
    mode: 'local',
    list: L.list, create: L.create, update: L.update, del: L.del,
    reorder: L.reorder, materialize: L.materialize,
    replace: (list, note) => L.replace(list, note),
    settings: L.settings,
    saveSettings: L.putSettings,
    templates: L.templates,
    addTemplate: L.addTemplate,
    delTemplate: L.removeTemplate,
    activity: L.activity,
    clearActivity: L.clearActivity,
    bulk: (ids, action, patch) => L.bulk({ ids, action, patch }),
    restore: L.restore,
    backup: L.backup,
    ics: L.ics,
    importAll: L.importAll,
    isEmpty: L.isEmpty,
    gcalStatus: L.gcalStatus,
    gcalPush: async () => ({ error: 'Google sync needs the Flow server' }),
    gcalPull: async () => ({ error: 'Google sync needs the Flow server' }),
    gcalOff:  async () => ({ ok: true }),
  };
}

/* `api` is rebound at boot once we know which backend is live. Everything
   downstream calls api.* and never learns which one it got. */
let api = remoteBackend;
let STORAGE_MODE = 'server';

/** Does a Flow server actually answer here? Static hosting will not. */
async function serverAvailable() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    return r.ok;
  } catch { return false; }
}

async function chooseBackend() {
  const wanted = localStorage.getItem('flow.storage');     // 'local' | 'server' | null
  const canServe = await serverAvailable();
  const useLocal = wanted === 'local' || !canServe;
  if (useLocal) {
    const { localBackend } = await import('/local-store.js');
    api = adaptLocal(localBackend);
    STORAGE_MODE = 'local';
  } else {
    api = remoteBackend;
    STORAGE_MODE = 'server';
  }
  document.body.dataset.storage = STORAGE_MODE;
  return STORAGE_MODE;
}

const REP_SVG = `<svg viewBox="0 0 24 24"><polyline points="16.5 2.6 20.6 6.7 16.5 10.8"/><path d="M3.4 12.6v-1.9a4 4 0 0 1 4-4h13.2"/><polyline points="7.5 21.4 3.4 17.3 7.5 13.2"/><path d="M20.6 11.4v1.9a4 4 0 0 1-4 4H3.4"/></svg>`;

/* Wiring helper: one stale selector should never blank the entire app,
   which is exactly what a bare $('#gone').addEventListener does. */
function on(sel, ev, fn, opts) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) { console.warn('[flow] no element matches', sel, '— skipping', ev); return; }
  el.addEventListener(ev, fn, opts);
}

/** mix a hex toward white — `amt` is how much of the colour survives */
function wash(hex, amt) {
  const n = parseInt(String(hex).slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const m = (c) => Math.round(c * amt + 255 * (1 - amt));
  return `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
}

/* ── date helpers ──────────────────────────────────────────── */
function startOfWeek(d) {
  const x = new Date(d);
  const wd = x.getDay();
  x.setDate(x.getDate() + (wd === 0 ? -6 : 1 - wd));
  x.setHours(0, 0, 0, 0);
  return x;
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseYMD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/* ── misc helpers ──────────────────────────────────────────── */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function fmtHours(h) {
  const n = Number(h) || 0;
  if (!n) return '';
  if (Number.isInteger(n)) return n + 'h';
  const whole = Math.floor(n);
  const mins  = Math.round((n - whole) * 60);
  return whole ? `${whole}h ${mins}m` : `${mins}m`;
}
function fmtTotal(h) {
  const n = Number(h) || 0;
  if (!n) return '';
  return (Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')) + 'h';
}
/** "45m" · "1h" · "1h 30m" · "1.5" · "" → hours, snapped to 15 min */
function parseDuration(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 0;
  let total = 0, matched = false;
  const h = s.match(/(\d+(?:\.\d+)?)\s*h/);
  if (h) { total += parseFloat(h[1]); matched = true; }
  const m = s.match(/(\d+(?:\.\d+)?)\s*m/);
  if (m) { total += parseFloat(m[1]) / 60; matched = true; }
  if (!matched) {
    const n = parseFloat(s);            // a bare number means hours
    if (!Number.isNaN(n)) total = n;
  }
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(24, Math.round(total * 4) / 4);
}

/** "09:00" → "9:00am" */
function fmtTime(t) {
  if (!t) return '';
  const [H, M] = String(t).split(':').map(Number);
  if (Number.isNaN(H)) return '';
  const ap  = H < 12 ? 'am' : 'pm';
  const h12 = H % 12 === 0 ? 12 : H % 12;
  return `${h12}:${String(M || 0).padStart(2, '0')}${ap}`;
}
/** current clock time snapped to the nearest 15 min, as "HH:MM" */
function nowHHMM() {
  const d = new Date();
  d.setMinutes(Math.round(d.getMinutes() / 15) * 15, 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDatePill(s) {
  if (!s) return 'Unscheduled';
  const d = parseYMD(s);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
}

function heightFor(hours) {
  const h = Number(hours) || 0;
  if (!h) return NO_EST_H;
  return Math.max(MIN_H, Math.round(h * PX_HOUR));
}
function hoursFor(px) {
  return Math.max(MIN_HOURS, Math.round((px / PX_HOUR) * 4) / 4);
}
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2400);
}
function visibleDays() {
  const n = showWeekend ? 7 : 5;
  return Array.from({ length: n }, (_, i) => ymd(addDays(weekStart, i)));
}

/* ============================================================
   RENDER
   ============================================================ */
function render() {
  document.documentElement.style.setProperty('--days', showWeekend ? 7 : 5);
  renderHeader();
  renderStrip();
  renderOverdue();
  renderZones();
  renderSidebar();
  paintPicked();
}

function renderHeader() {
  const days = visibleDays();
  const end  = parseYMD(days[days.length - 1]);
  const M = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  $('#weekLabel').textContent = weekStart.getMonth() === end.getMonth()
    ? `${M[weekStart.getMonth()]} ${weekStart.getDate()}–${end.getDate()}, ${end.getFullYear()}`
    : `${M[weekStart.getMonth()]} ${weekStart.getDate()} – ${M[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;

  const total = tasks
    .filter(t => !t.done && days.includes(t.day))
    .reduce((s, t) => s + (Number(t.hours) || 0), 0);
  $('#weekTotal').textContent = total ? `${fmtTotal(total)} planned` : '';
}

function renderStrip() {
  const strip = $('#dayStrip');
  strip.innerHTML = '';
  const today = ymd(new Date());
  const N     = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const NLONG = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const cap   = Number(settings.capacityHours) || 8;

  for (const key of visibleDays()) {
    const d = parseYMD(key);
    const hrs = tasks
      .filter(t => t.day === key && !t.done)
      .reduce((s, t) => s + (Number(t.hours) || 0), 0);
    const isSel = key === selectedDay;
    const over  = hrs > cap + 0.001;

    const b = document.createElement('button');
    b.className = 'day-tab'
      + (key === today ? ' is-today' : '')
      + (isSel ? ' is-selected' : '')
      + (over ? ' is-over' : '');
    b.dataset.day = key;
    b.title = `${NLONG[d.getDay()]} — ${fmtTotal(hrs) || '0h'} of ${cap}h`;
    b.innerHTML = `
      <span>${isSel ? NLONG[d.getDay()] : N[d.getDay()]}</span>
      <span class="d-num">${d.getDate()}</span>
      ${hrs ? `<span class="d-hrs">${fmtTotal(hrs)}</span>` : ''}
      <span class="day-load"><i style="width:${Math.min(100, (hrs / cap) * 100)}%"></i></span>`;
    b.addEventListener('click', () => { selectedDay = key; render(); });
    strip.appendChild(b);
  }
}

function renderOverdue() {
  const today = ymd(new Date());
  const late  = tasks.filter(t => !t.done && t.day && t.day < today);
  const pill  = $('#overduePill');
  pill.hidden = late.length === 0;
  if (!late.length) return;
  pill.textContent = `${late.length} overdue → today`;
  pill.title = `Move ${late.length} unfinished to do${late.length > 1 ? 's' : ''} from earlier days to today`;
  pill.onclick = async () => {
    pushUndo('carry over');
    for (const t of late) await api.update(t.id, { day: today });
    weekStart = startOfWeek(new Date());
    selectedDay = today;
    await refresh();
    alignStrip();
    toast(`Moved ${late.length} to today — ⌘Z to undo`);
  };
}

let lastZoneKey = '';

function renderZones() {
  sortables.forEach(s => { try { s.destroy(); } catch {} });
  sortables.length = 0;

  renderAnytimeBand();

  const todo = $('#todoCols');
  const done = $('#doneCols');
  todo.innerHTML = '';
  done.innerHTML = '';

  for (const key of visibleDays()) {
    todo.appendChild(buildCol(key, 'todo'));
    done.appendChild(buildCol(key, 'done'));
  }

  // Stagger the blocks in, but only when the board actually changed shape.
  // renderZones() also runs on every refresh, and re-animating settled
  // blocks on each save reads as a flicker rather than as motion.
  const shape = visibleDays().join() + '|' + weekStart + '|' +
    tasks.filter(t => !t.done).length + '|' + tasks.length;
  if (shape !== lastZoneKey) {
    lastZoneKey = shape;
    stagger($$('#todoCols .block, #anytimeBand .block'));
    stagger($$('#doneCols .block'), { y: -6 });
  }

  // sidebar sortable is registered in renderSidebar()
}

/* ── Anytime band ──────────────────────────────────────────────
   One row across the top of the To Do zone, on the same column
   grid as the days below it — the way an all-day band works in a
   calendar. Separated from the timed pile by a hairline, not a
   heavy rule, so it never competes with the day strip.
   ─────────────────────────────────────────────────────────── */
function renderAnytimeBand() {
  const band = $('#anytimeBand');
  band.innerHTML = '';
  let count = 0;

  for (const key of visibleDays()) {
    const cell = document.createElement('div');
    cell.className = 'any-col';
    cell.dataset.day  = key;
    cell.dataset.zone = 'untimed';

    const untimed = tasks
      .filter(t => t.day === key && !t.done && t.anytime)
      .sort((a, b) => a.position - b.position);
    count += untimed.length;
    untimed.forEach(t => cell.appendChild(blockEl(t, 'todo', { chip: true })));

    cell.addEventListener('dblclick', (e) => {
      if (e.target !== cell) return;
      selectedDay = key;
      startInlineAdd(key, 0);
    });

    band.appendChild(cell);
    sortables.push(Sortable.create(cell, {
      group: 'flow',
      draggable: '.block',
      animation: 130,
      filter: '.block-check',
      preventOnFilter: false,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onStart: onDragStart,
      onEnd: onDragEnd,
    }));
  }
  $('#anytimeWrap').classList.toggle('is-empty', count === 0);
}

function buildCol(dayKey, zone) {
  const col = document.createElement('div');
  col.className = 'col' + (dayKey === selectedDay ? ' is-selected' : '');
  col.dataset.day  = dayKey;
  col.dataset.zone = zone;

  // The pile is bottom-anchored to the strip, but reading order stays
  // top→bottom by position — same as the reference.
  const list = zone === 'todo'
    ? tasks.filter(t => t.day === dayKey && !t.done).sort((a, b) => a.position - b.position)
    : tasks.filter(t => t.day === dayKey && t.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));

  if (zone === 'todo') {
    /* Anytime is an explicit choice, not "happens to have no estimate" — a
       to do with no hours still belongs on the time axis unless you said
       otherwise (see renderAnytimeBand). */
    const timed = list.filter(t => !t.anytime);

    // blocks interleaved with insert points: ins[0] block[0] ins[1] block[1] … ins[n]
    const kids = [];
    timed.forEach((t, i) => { kids.push(insEl(dayKey, i)); kids.push(blockEl(t, zone)); });
    kids.push(insEl(dayKey, timed.length));
    const list_ = timed;

    if (inlineAdd && inlineAdd.day === dayKey) {
      const at = Math.max(0, Math.min(list_.length, inlineAdd.index));
      kids.splice(at * 2 + 1, 0, inlineAddEl(dayKey, at));
    }
    kids.forEach(k => col.appendChild(k));
    if (!list_.length) col.classList.add('is-empty');

    // clicking the bare column drops a new to do at the top of that day's pile
    col.addEventListener('click', (e) => {
      if (e.target !== col) return;
      selectedDay = dayKey;
      startInlineAdd(dayKey, 0);
    });
  } else {
    list.forEach(t => col.appendChild(blockEl(t, zone)));
  }

  sortables.push(Sortable.create(col, {
    group: 'flow',
    draggable: '.block',              // insert points and the inline input stay put
    animation: 130,
    filter: '.rs, .block-check',
    preventOnFilter: false,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    onStart: onDragStart,
    onEnd: onDragEnd,
  }));

  return col;
}

/* ============================================================
   INLINE ADD  —  create a to do straight in the day column
   ============================================================ */
let inlineAdd = null;   // { day, index }

/** "Sales call 9am 45m" → { title:'Sales call', startTime:'09:00', hours:0.75 } */
function parseQuickEntry(raw) {
  let s = String(raw).trim();
  let startTime = null, hours = 0;

  const timeRe = /(?:^|\s)(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)|(\d{1,2}):(\d{2}))(?=\s|$)/i;
  const tm = s.match(timeRe);
  if (tm) {
    let H, M;
    if (tm[3]) {
      H = Number(tm[1]) % 12;
      if (tm[3].toLowerCase() === 'pm') H += 12;
      M = Number(tm[2] || 0);
    } else {
      H = Number(tm[4]); M = Number(tm[5]);
    }
    if (H >= 0 && H < 24 && M >= 0 && M < 60) {
      startTime = `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`;
      s = (s.slice(0, tm.index) + ' ' + s.slice(tm.index + tm[0].length)).trim();
    }
  }

  const durRe = /(?:^|\s)(\d+(?:\.\d+)?\s*h(?:\s*\d+\s*m)?|\d+(?:\.\d+)?\s*m)(?=\s|$)/i;
  const dm = s.match(durRe);
  if (dm) {
    hours = parseDuration(dm[1]);
    s = (s.slice(0, dm.index) + ' ' + s.slice(dm.index + dm[0].length)).trim();
  }

  return { title: s.replace(/\s{2,}/g, ' ').trim(), hours, startTime };
}

function insEl(day, index) {
  const el = document.createElement('div');
  el.className = 'ins';
  el.title = 'Add a to do here';
  el.innerHTML = `<span class="ins-bar"></span><span class="ins-plus">+</span>`;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    selectedDay = day;
    startInlineAdd(day, index);
  });
  return el;
}

function inlineAddEl(day, index) {
  const wrap = document.createElement('div');
  wrap.className = 'inline-add';
  wrap.innerHTML = `
    <input placeholder="What needs doing?" autocomplete="off" spellcheck="false" aria-label="New to do">
    <span class="inline-hint">“Sales call 9am 45m” · ⏎ save · esc cancel</span>`;
  const input = wrap.querySelector('input');
  let settled = false;

  async function commit(keepGoing) {
    if (settled) return;
    const raw = input.value.trim();
    if (!raw) { closeInlineAdd(); return; }
    settled = true;
    const { title, hours, startTime } = parseQuickEntry(raw);
    pushUndo('add');
    await api.create({
      title: title || 'Untitled',
      hours: hours || 1,           // the pile is the time axis — it needs to occupy space
      startTime,
      anytime: false,              // Anytime is opt-in, via the editor or a drag
      color: pickedColor,
      day,
      position: index - 0.5,       // slots between index-1 and index
    });
    inlineAdd = keepGoing ? { day, index: index + 1 } : null;
    await refresh();
    if (inlineAdd) focusInline();
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter')  { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); closeInlineAdd(); }
  });
  input.addEventListener('blur', () => {
    // a re-render pulls this node out from under us — settled guards that
    setTimeout(() => { if (!settled && inlineAdd) commit(false); }, 120);
  });
  return wrap;
}

function startInlineAdd(day, index) {
  inlineAdd = { day, index };
  render();
  focusInline();
}
function closeInlineAdd() {
  if (!inlineAdd) return;
  inlineAdd = null;
  renderZones();
}
function focusInline() {
  requestAnimationFrame(() => {
    const el = document.querySelector('.inline-add input');
    if (el) el.focus();
  });
}

function blockEl(t, zone, { chip = false } = {}) {
  const c = COLOR[t.color] || fallback;
  const h  = Number(t.hours) || 0;
  const px = heightFor(h);
  // very short blocks collapse to a single centred row so the title
  // and the hours read-out never collide
  const compact = px < 40;

  /* Split the available height between the title and the description.
     Without a note the title gets the extra lines instead. */
  const hasNote = !!(t.notes && !t.hideNotes);
  let titleLines, subLines = 0;
  if (px < 42)      { titleLines = 1; }
  else if (px < 48) { titleLines = 2; }
  else if (px < 68) { titleLines = hasNote ? 1 : 2; subLines = hasNote ? 1 : 0; }
  else if (px < 92) { titleLines = 2;               subLines = hasNote ? 1 : 0; }
  else              { titleLines = hasNote ? 2 : 3; subLines = hasNote ? 2 : 0; }

  const el = document.createElement('div');
  el.className = 'block'
    + (picked.has(t.id) ? ' is-picked' : '')
    + (c.light ? ' on-light' : '')
    + (t.done ? ' is-done' : '')
    + (compact ? ' compact' : '');
  el.dataset.id = t.id;
  el.style.setProperty('--bg', c.hex);
  if (chip) {
    el.classList.add('chip');
    el.style.setProperty('--chip-bg',   wash(c.hex, 0.13));
    el.style.setProperty('--chip-line', wash(c.hex, 0.32));
  } else {
    el.style.height = px + 'px';
  }

  const rep = (t.recurring || t.parentId)
    ? `<span class="block-rep" title="Recurring"><svg viewBox="0 0 24 24"><polyline points="16.5 2.6 20.6 6.7 16.5 10.8"/><path d="M3.4 12.6v-1.9a4 4 0 0 1 4-4h13.2"/><polyline points="7.5 21.4 3.4 17.3 7.5 13.2"/><path d="M20.6 11.4v1.9a4 4 0 0 1-4 4H3.4"/></svg></span>`
    : '';
  const time = t.startTime ? `<span class="block-time">${fmtTime(t.startTime)}</span>` : '';
  const star = t.starred ? `<span class="block-star" title="Starred">★</span>` : '';

  if (chip) {
    el.innerHTML = `
      <div class="block-check" title="${t.done ? 'Mark not done' : 'Mark done'}">${t.done ? '✓' : ''}</div>
      <div class="block-title">${star}${rep}${esc(t.title || 'Untitled')}</div>`;
  } else {
  el.innerHTML = `
    <div class="rs ${zone === 'todo' ? 'top' : 'bottom'}" title="Drag to change hours"></div>
    <div class="block-check" title="${t.done ? 'Mark not done' : 'Mark done'}">${t.done ? '✓' : ''}</div>
    <div class="block-title" style="-webkit-line-clamp:${titleLines}">${star}${rep}${time}${esc(t.title || 'Untitled')}</div>
    ${subLines ? `<div class="block-sub" style="-webkit-line-clamp:${subLines}">${esc(t.notes)}</div>` : ''}
    <div class="block-hours${h ? '' : ' zero'}">${fmtHours(h)}</div>
  `;
  }

  el.querySelector('.block-check').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDone(t);
  });
  el.addEventListener('click', (e) => {
    if (suppressClick || dragging) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey) { e.preventDefault(); togglePicked(t.id); return; }
    if (picked.size) { clearPicked(); return; }
    openEdit(t);
  });
  el.addEventListener('contextmenu', (e) => openCtx(e, t));

  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `${t.title || 'Untitled'}${h ? ', ' + fmtHours(h) : ''}`);
  // small blocks can't show much, so the whole thing is always on hover
  el.title = [
    t.title || 'Untitled',
    t.startTime ? fmtTime(t.startTime) : '',
    h ? fmtHours(h) : '',
  ].filter(Boolean).join('  ·  ') + (t.notes ? `\n\n${t.notes}` : '');
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(t); }
    if (e.key.toLowerCase() === 'd') { e.preventDefault(); toggleDone(t); }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); quickDelete(t); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'd') { e.preventDefault(); togglePicked(t.id); }
  });

  if (!chip) attachResize(el, t, zone);
  return el;
}

function renderSidebar() {
  const wrap = $('#col-backlog');
  wrap.innerHTML = '';

  let list = tasks.filter(t => !t.day && !t.done).sort((a, b) => a.position - b.position);
  $('#backlogCount').textContent = list.length;
  $('#backlogCountMini').textContent = list.length;

  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    list = list.filter(t =>
      (t.title || '').toLowerCase().includes(q) ||
      (t.notes || '').toLowerCase().includes(q));
  }

  if (!list.length) {
    wrap.innerHTML = `<div class="empty-side">${
      searchTerm ? 'No items match that search.' : 'Nothing unscheduled.<br>Drag a block here to park it.'
    }</div>`;
  } else {
    list.forEach(t => wrap.appendChild(itemEl(t)));
  }

  sortables.push(Sortable.create(wrap, {
    group: 'flow',
    draggable: '.item',
    animation: 130,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    onStart: onDragStart,
    onEnd: onDragEnd,
  }));
}

function itemEl(t) {
  const c = COLOR[t.color] || fallback;
  const el = document.createElement('div');
  el.className = 'item';
  el.dataset.id = t.id;
  el.style.setProperty('--bg', c.hex);

  const bits = [];
  if (t.hours) bits.push(fmtHours(t.hours));
  if (t.recurring) bits.push('repeats ' + t.recurring.freq);
  const sub = t.notes || bits.join(' · ') || 'No estimate';

  el.innerHTML = `
    <div class="item-title">${esc(t.title || 'Untitled')}</div>
    <div class="item-sub">${esc(sub)}</div>`;
  el.addEventListener('click', () => { if (!suppressClick && !dragging) openEdit(t); });
  el.addEventListener('contextmenu', (e) => openCtx(e, t));
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(t); }
  });
  return el;
}

/* ============================================================
   RESIZE  —  To Do grows upward (top handle),
              Done grows downward (bottom handle)
   ============================================================ */
function attachResize(el, task, zone) {
  const handle = el.querySelector('.rs');
  const dir = zone === 'todo' ? -1 : 1;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const startY = e.clientY;
    const startH = el.offsetHeight;
    let hours = Number(task.hours) || hoursFor(startH);
    let moved = false;

    el.classList.add('resizing');
    document.body.classList.add('is-resizing');
    // Pointer capture is a nicety, not a requirement — the move/up
    // listeners live on window so the drag survives it failing.
    try { handle.setPointerCapture(e.pointerId); } catch {}

    const badge  = $('#resizeBadge');
    const hoursEl = el.querySelector('.block-hours');
    badge.hidden = false;

    const move = (ev) => {
      // a few px of jitter is a click, not a resize — don't rewrite the estimate
      if (Math.abs(ev.clientY - startY) >= 5) moved = true;
      const px = Math.max(MIN_H, startH + (ev.clientY - startY) * dir);
      hours = hoursFor(px);
      const snapped = heightFor(hours);
      el.style.height = snapped + 'px';
      el.classList.toggle('compact', snapped < 40);
      hoursEl.classList.remove('zero');
      hoursEl.textContent = fmtHours(hours);
      badge.textContent = fmtHours(hours);
      badge.style.left = Math.min(window.innerWidth - 70, ev.clientX + 14) + 'px';
      badge.style.top  = Math.max(8, ev.clientY - 30) + 'px';
    };

    const up = async () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      el.classList.remove('resizing');
      document.body.classList.remove('is-resizing');
      badge.hidden = true;

      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 120);

      // a plain click on the grip (no drag) should still open the editor,
      // otherwise the top strip of every block is a dead zone
      if (!moved) { openEdit(task); return; }

      if (hours !== Number(task.hours)) {
        pushUndo('resize');    // snapshot before mutating the live object
        task.hours = hours;
        const saved = await api.update(task.id, { hours });
        const i = tasks.findIndex(x => x.id === task.id);
        if (i >= 0) tasks[i] = saved;
        renderHeader();
        renderStrip();
      }
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

/* ============================================================
   MARQUEE MULTI-SELECT
   Drag on empty canvas to rubber-band blocks, the way Finder
   selects files. ⌘/⇧-click toggles one. The context menu then
   acts on the whole selection.
   ============================================================ */
const picked = new Set();
let marquee = null;

function isPicked(id) { return picked.has(id); }

function setPicked(ids, { additive = false } = {}) {
  if (!additive) picked.clear();
  ids.forEach(id => picked.add(id));
  paintPicked();
}
function clearPicked() {
  if (!picked.size) return false;
  picked.clear();
  paintPicked();
  return true;
}
function togglePicked(id) {
  picked.has(id) ? picked.delete(id) : picked.add(id);
  paintPicked();
}

/** cheap repaint — no re-render, just the ring class */
function paintPicked() {
  $$('.block').forEach(b => b.classList.toggle('is-picked', picked.has(b.dataset.id)));
  const n = picked.size;
  const bar = $('#pickBar');
  bar.hidden = n < 2;
  if (n >= 2) $('#pickCount').textContent = `${n} selected`;
}

function blocksIntersecting(rect) {
  return $$('.block').filter(b => {
    const r = b.getBoundingClientRect();
    return !(r.right < rect.left || r.left > rect.right ||
             r.bottom < rect.top || r.top > rect.bottom);
  }).map(b => b.dataset.id);
}

on('#canvas', 'pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('.block, .item, .ins, .inline-add, .strip, .done-toggle')) return;

  const startX = e.clientX, startY = e.clientY;
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  const base = additive ? Array.from(picked) : [];
  let live = false;

  const move = (ev) => {
    if (!live) {
      if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return;
      live = true;
      marquee = document.createElement('div');
      marquee.className = 'marquee';
      document.body.appendChild(marquee);
      document.body.classList.add('is-marquee');
    }
    const rect = {
      left:   Math.min(startX, ev.clientX),
      right:  Math.max(startX, ev.clientX),
      top:    Math.min(startY, ev.clientY),
      bottom: Math.max(startY, ev.clientY),
    };
    Object.assign(marquee.style, {
      left:   rect.left + 'px',
      top:    rect.top + 'px',
      width:  (rect.right - rect.left) + 'px',
      height: (rect.bottom - rect.top) + 'px',
    });
    setPicked([...base, ...blocksIntersecting(rect)]);
  };

  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (marquee) { marquee.remove(); marquee = null; }
    document.body.classList.remove('is-marquee');
    // a plain click (no drag) clears a selection, or falls through to the
    // column's own click handler which opens the inline composer
    if (!live) clearPicked();
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

/* ============================================================
   RIGHT-CLICK CONTEXT MENU
   ============================================================ */
let ctxTaskId = null;

/** the tasks a menu action should apply to */
function ctxTargets() {
  if (picked.size > 1 && picked.has(ctxTaskId)) {
    return tasks.filter(t => picked.has(t.id));
  }
  const one = tasks.find(t => t.id === ctxTaskId);
  return one ? [one] : [];
}

function openCtx(e, task) {
  e.preventDefault();
  e.stopPropagation();
  if (!$('#taskModal').hidden) return;      // the card owns the screen while open

  ctxTaskId = task.id;
  // right-clicking outside the selection collapses it onto that one block
  if (!picked.has(task.id)) clearPicked();
  const n = ctxTargets().length;
  const many = n > 1 ? ` ${n}` : '';

  $('#ctxMenu').querySelector('[data-act="duplicate"] span').textContent = `Duplicate${many}`;
  $('#ctxMenu').querySelector('[data-act="move"] span').textContent      = `Move${many} to`;
  $('#ctxMenu').querySelector('[data-act="delete"] span').textContent    = `Delete${many}`;
  $('#ctxMenu').querySelector('[data-act="template"] span').textContent  = n > 1 ? `Save ${n} as templates` : 'Save as template';
  buildCtxSubs(task);
  $('#ctxLogLabel').textContent  = (task.done ? 'Un-log' : 'Log') + many;
  $('#ctxStarLabel').textContent = (task.starred ? 'Unstar' : 'Star') + many;

  const m = $('#ctxMenu');
  m.hidden = false;
  m.style.left = '0px';
  m.style.top  = '0px';                      // measure at a known origin first
  const r = m.getBoundingClientRect();
  const x = Math.max(8, Math.min(e.clientX, window.innerWidth  - r.width  - 8));
  const y = Math.max(8, Math.min(e.clientY, window.innerHeight - r.height - 8));
  m.style.left = x + 'px';
  m.style.top  = y + 'px';

  // fly the submenus left instead if there's no room on the right
  const flip = x + r.width + 190 > window.innerWidth;
  $$('.ctx-sub').forEach(s => s.classList.toggle('flip-left', flip));
}

function closeCtx() {
  $('#ctxMenu').hidden = true;
  ctxTaskId = null;
}

function ctxItem(label, note, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'menuitem');
  b.innerHTML = `<span>${esc(label)}</span>${note ? `<span class="ctx-note">${esc(note)}</span>` : ''}`;
  b.addEventListener('click', onClick);
  return b;
}

function buildCtxSubs(task) {
  const N = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  const move = $('#ctxMoveSub');
  move.innerHTML = '';
  for (const key of visibleDays()) {
    const d = parseYMD(key);
    move.appendChild(ctxItem(
      `${N[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`,
      key === task.day ? 'current' : '',
      () => ctxMoveTo(key)));
  }
  const sepA = document.createElement('div');
  sepA.className = 'ctx-sep';
  move.appendChild(sepA);

  // The submenu used to list this week only, which left no way to move a to do
  // across a week boundary short of finding the date field in the editor.
  const anchor = task.day ? parseYMD(task.day) : new Date();
  move.appendChild(ctxItem('Next week',      'same weekday', () => ctxMoveTo(ymd(addDays(anchor,  7)))));
  move.appendChild(ctxItem('Last week',      'same weekday', () => ctxMoveTo(ymd(addDays(anchor, -7)))));
  move.appendChild(ctxItem('Pick a date…',   '',             () => ctxPickDate(task)));

  const sepB = document.createElement('div');
  sepB.className = 'ctx-sep';
  move.appendChild(sepB);
  move.appendChild(ctxItem('My items', task.day ? '' : 'current', () => ctxMoveTo(null)));

  const del = $('#ctxDelSub');
  del.innerHTML = '';
  del.appendChild(ctxItem('Just this one', '', () => ctxDelete(false)));
  if (task.recurring) del.appendChild(ctxItem('This and all future', '', () => ctxDelete(true)));
}

/** Native date picker for "Move to → Pick a date…". */
function ctxPickDate(task) {
  const targets = ctxTargets();
  closeCtx();
  if (!targets.length) return;

  const inp = document.createElement('input');
  inp.type = 'date';
  inp.value = task.day || ymd(new Date());
  // kept in the layout but invisible: a display:none input cannot open a picker
  inp.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.appendChild(inp);

  let settled = false;
  const done = async () => {
    if (settled) return;
    settled = true;
    const day = inp.value || null;
    inp.remove();
    if (!day) return;
    pushUndo(targets.length > 1 ? `move ${targets.length}` : 'move');
    for (const t of targets) await api.update(t.id, { day });
    clearPicked();
    await refresh();
    revealDay(day);
    toast(`${targets.length > 1 ? targets.length + ' to dos' : 'Moved'} → ${fmtDatePill(day)}`);
  };
  inp.addEventListener('change', done);
  inp.addEventListener('blur', () => setTimeout(done, 150));
  if (inp.showPicker) { try { inp.showPicker(); } catch { inp.focus(); } } else inp.focus();
}

async function ctxMoveTo(day) {
  const targets = ctxTargets();
  closeCtx();
  if (!targets.length) return;
  pushUndo(targets.length > 1 ? `move ${targets.length}` : 'move');
  for (const t of targets) await api.update(t.id, { day });
  clearPicked();
  await refresh();
  const jumped = revealDay(day);
  const what = targets.length > 1 ? `${targets.length} to dos` : 'Moved';
  toast(day ? `${what} → ${fmtDatePill(day)}${jumped ? ' · jumped to that week' : ''}`
            : `${what} → My items`);
}

async function ctxDelete(cascade) {
  const targets = ctxTargets();
  closeCtx();
  if (!targets.length) return;
  pushUndo(targets.length > 1 ? `delete ${targets.length}` : (cascade ? 'series delete' : 'delete'));
  for (const t of targets) await api.del(t.id, cascade);
  clearPicked();
  await refresh();
  toast(`Deleted ${targets.length > 1 ? targets.length + ' to dos' : ''} — ⌘Z to undo`.replace('  ', ' '));
}

async function duplicateTask(id, { silent = false } = {}) {
  const src = tasks.find(t => t.id === id);
  if (!src) return null;
  if (!silent) pushUndo('duplicate');
  const { id: _i, createdAt, updatedAt, gcalEventId, parentId, doneAt,
          position: _p, ...rest } = src;   // let the server slot the copy after the original
  const copy = await api.create({
    ...rest,
    title: (src.title || 'Untitled') + ' copy',
    done: false,
  });
  tasks.push(copy);
  return copy;
}

$$('#ctxMenu > button').forEach(b => b.addEventListener('click', async () => {
  const act = b.dataset.act;
  const id  = ctxTaskId;
  const task = tasks.find(t => t.id === id);
  // Snapshot the targets first: closeCtx() clears ctxTaskId, which ctxTargets()
  // reads. Closing before resolving left every action iterating an empty list
  // while the toast still claimed it had worked.
  const targets = ctxTargets();
  closeCtx();
  if (!task) return;

  const many = targets.length > 1 ? ` ${targets.length}` : '';

  if (act === 'duplicate') {
    pushUndo(`duplicate${many}`);
    for (const t of targets) await duplicateTask(t.id, { silent: true });
    clearPicked();
    await refresh();
    toast(`Duplicated${many}`);
  }
  if (act === 'log') {
    pushUndo(`log${many}`);
    for (const t of targets) {
      await api.update(t.id, t.done ? { done: false } : { done: true, day: t.day || selectedDay });
    }
    clearPicked();
    await refresh();
    toast(task.done ? 'Moved back to To Do' : `Logged${many}`);
  }
  if (act === 'start') {
    pushUndo(`start${many}`);
    const at = nowHHMM();
    for (const t of targets) await api.update(t.id, { startTime: at, day: ymd(new Date()), done: false });
    clearPicked();
    weekStart = startOfWeek(new Date());
    selectedDay = ymd(new Date());
    await refresh();
    alignStrip();
    toast(`Starting ${fmtTime(at)} today`);
  }
  if (act === 'star') {
    const on = !task.starred;
    pushUndo(on ? `star${many}` : `unstar${many}`);
    for (const t of targets) await api.update(t.id, { starred: on });
    clearPicked();
    await refresh();
    toast(on ? `Starred${many}` : `Unstarred${many}`);
  }
  if (act === 'template') {
    for (const t of targets) {
      const { id: _i, day, done, doneAt, position, createdAt, updatedAt,
              gcalEventId, parentId, starred, ...keep } = t;
      await api.addTemplate(keep);
    }
    clearPicked();
    await loadTemplates();
    toast(targets.length > 1 ? `Saved ${targets.length} templates` : `“${task.title || 'Untitled'}” saved as a template`);
  }
}));

/** delete straight away — undo is the safety net, not a dialog */
async function quickDelete(t) {
  pushUndo(t.recurring ? 'series delete' : 'delete');
  await api.del(t.id, !!t.recurring);
  await refresh();
  toast(`Deleted “${t.title || 'Untitled'}” — ⌘Z to undo`);
}

document.addEventListener('click', () => { if (!$('#ctxMenu').hidden) closeCtx(); });
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.block, .item')) closeCtx();
});
window.addEventListener('blur', closeCtx);
window.addEventListener('resize', closeCtx);
on('#canvas', 'scroll', closeCtx, { passive: true });

/* ============================================================
   DRAG & DROP
   ============================================================ */
function onDragStart() {
  dragging = true;
  document.body.classList.add('is-dragging');
  $$('.col').forEach(c => c.classList.add('drop-hint'));
}

async function onDragEnd(evt) {
  dragging = false;
  document.body.classList.remove('is-dragging', 'side-peek');
  pushUndo('move');            // tasks[] is still pre-drag at this point
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 120);
  $$('.col').forEach(c => c.classList.remove('drop-hint'));

  const to   = evt.to;
  const from = evt.from;
  const id   = evt.item.dataset.id;

  const destZone = to.dataset.zone;
  const destDay  = destZone === 'backlog' ? null : to.dataset.day;

  // 1. state transitions
  const moved = tasks.find(t => t.id === id);
  let note = '';

  if (destZone === 'done') {
    await api.update(id, { done: true, day: destDay });

  } else if (destZone === 'untimed') {
    // the band is the no-duration lane, so landing there drops the estimate
    const hadHours = Number(moved?.hours) > 0;
    await api.update(id, { done: false, day: destDay, hours: 0, anytime: true, startTime: null });
    if (hadHours) note = 'Estimate cleared — it sits in Anytime now';

  } else if (destZone === 'todo') {
    // the pile is the time axis, so it needs some duration to occupy space
    const patch = { done: false, day: destDay, anytime: false };
    if (!Number(moved?.hours)) { patch.hours = 1; note = 'Given a 1h estimate — drag its top edge to adjust'; }
    await api.update(id, patch);

  } else {
    await api.update(id, { done: false, day: null });
  }

  // 2. ordering
  const orderOf = (container) => {
    const zone = container.dataset.zone;
    const day  = zone === 'backlog' ? null : container.dataset.day;
    return Array.from(container.children)
      .filter(c => c.dataset && c.dataset.id)
      .map((c, i) => ({ id: c.dataset.id, day, position: i }));
  };

  const updates = orderOf(to);
  if (from !== to && from.dataset.zone) updates.push(...orderOf(from));
  if (updates.length) await api.reorder(updates);

  await refresh();
  if (note) toast(note);
}

/* ============================================================
   TASK CRUD
   ============================================================ */
async function toggleDone(t) {
  pushUndo(t.done ? 'un-tick' : 'tick');
  const patch = t.done ? { done: false } : { done: true, day: t.day || selectedDay };
  const saved = await api.update(t.id, patch);
  const i = tasks.findIndex(x => x.id === t.id);
  if (i >= 0) tasks[i] = saved;
  render();
}

async function newTask(day = null) {
  const t = await api.create({ title: '', day, color: pickedColor, hours: day ? 1 : 0, anytime: false });
  tasks.push(t);
  render();
  openEdit(t, true);
}

function buildPicker() {
  const wrap = $('#mColorPicker');
  wrap.innerHTML = '';
  for (const p of PALETTE) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.color = p.key;
    b.style.background = p.hex;
    b.title = p.key;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      pickedColor = p.key;
      $$('#mColorPicker .swatch').forEach(s => s.classList.toggle('selected', s === b));
    });
    wrap.appendChild(b);
  }
}

/** keep the duration input + quick-pick pills in agreement */
function syncDuration(hours, { writeInput = true } = {}) {
  if (writeInput) $('#mHours').value = hours ? fmtHours(hours) : '';
  $$('.td-pill').forEach(p => p.classList.toggle('on', parseFloat(p.dataset.h) === hours));
}

function syncDatePill() {
  $('#tdDateLabel').textContent = fmtDatePill($('#mDay').value);
}

function syncStart(v) {
  $('#mStart').value = v || '';
  $$('.td-pill[data-t]').forEach(p => p.classList.toggle('on', p.dataset.t === v));
}

function openEdit(t, isNew = false) {
  editingId = t.id;
  $('#mTitle').value  = t.title || '';
  $('#mNotes').value  = t.notes || '';
  $('#mDay').value    = t.day || '';
  $('#mDone').checked = !!t.done;
  $('#mHideNotes').checked = !!t.hideNotes;
  $('#mAnytime').checked = !!t.anytime;
  syncDuration(Number(t.hours) || 0);
  syncStart(t.startTime || '');
  syncDatePill();

  const freq = t.recurring?.freq || '';
  $('#mRecurring').value = freq;
  $('#mUntil').value = t.recurring?.until || '';
  $('#mUntilWrap').hidden = !freq;

  /* make the series relationship explicit — changing the date on a parent
     re-anchors every occurrence, which is worth saying out loud */
  const note = $('#tdSeries'), noteText = $('#tdSeriesText'), noteGo = $('#tdSeriesGo');
  if (t.recurring) {
    note.hidden = false; noteGo.hidden = true;
    noteText.innerHTML = `This is the <b>start of a repeating series</b> (${esc(t.recurring.freq)}). ` +
      `Change the date above and every upcoming occurrence moves with it.`;
  } else if (t.parentId) {
    const parent = tasks.find(x => x.id === t.parentId);
    note.hidden = false;
    noteText.innerHTML = parent
      ? `One occurrence of a repeating to do. Editing here affects only this day.`
      : `This occurrence has lost its series — the original repeating to do was deleted.`;
    noteGo.hidden = !parent;
    noteGo.onclick = () => { if (parent) openEdit(parent); };
  } else {
    note.hidden = true;
  }

  $('#tdHeadingText').textContent = isNew ? 'New To Do' : 'Edit To Do';
  $('#mDelete').querySelector('span').textContent = isNew ? 'Discard' : 'Delete';
  $('#tdMenuPop').hidden = true;
  $('#taskModal').dataset.new = isNew ? '1' : '';

  pickedColor = COLOR[t.color] ? t.color : 'navy';
  $$('#mColorPicker .swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === pickedColor));

  $('#taskModal').hidden = false;
  setTimeout(() => { $('#mTitle').focus(); $('#mTitle').select(); }, 20);
}

async function closeEdit() {
  closeConfirm();          // never strand a bubble over a dismissed card
  const modal = $('#taskModal');
  const wasNew = modal.dataset.new === '1';
  const id = editingId;
  modal.hidden = true;
  modal.dataset.new = '';
  editingId = null;
  // an untouched brand-new task is discarded rather than left as "Untitled"
  if (wasNew && id) {
    const t = tasks.find(x => x.id === id);
    if (t && !t.title) { await api.del(id); await refresh(); }
  }
}

async function saveEdit(opts = {}) {
  if (!editingId) return;
  const freq  = $('#mRecurring').value;
  const until = $('#mUntil').value;
  const day   = $('#mDay').value || null;
  const done  = opts.markDone ? true : $('#mDone').checked;
  const anytime = $('#mAnytime').checked;
  const patch = {
    title: $('#mTitle').value.trim() || 'Untitled',
    notes: $('#mNotes').value,
    // a timed block has to occupy space on the axis; an Anytime chip must not
    hours: anytime ? 0 : (parseDuration($('#mHours').value) || 1),
    anytime,
    startTime: anytime ? null : ($('#mStart').value || null),
    color: pickedColor,
    day:   done && !day ? selectedDay : day,   // a completed to do needs a day to land on
    done,
    hideNotes: $('#mHideNotes').checked,
    recurring: freq ? { freq, until: until || null } : null,
  };
  const movedWeek = patch.day && !visibleDays().includes(patch.day);
  pushUndo('edit');
  const saved = await api.update(editingId, patch);
  const i = tasks.findIndex(t => t.id === editingId);
  if (i >= 0) tasks[i] = saved;
  $('#taskModal').hidden = true;
  $('#taskModal').dataset.new = '';
  editingId = null;
  await refresh();
  if (movedWeek && revealDay(patch.day)) toast(`Moved to ${fmtDatePill(patch.day)}`);
}

async function deleteTask() {
  if (!editingId) return;
  const t = tasks.find(x => x.id === editingId);
  const isNew = $('#taskModal').dataset.new === '1';
  let cascade = false;

  if (!isNew) {
    const btn = $('#mDelete');
    if (t?.recurring) {
      // a series needs three answers, not OK/Cancel — the old confirm()
      // hid "just this one" behind the Cancel button, which read as "abort"
      const pick = await confirmInline(btn, {
        prompt: 'Delete repeating to do?',
        choices: [
          { label: 'Just this one',    value: 'one' },
          { label: 'This and future',  value: 'all', danger: true },
        ],
      });
      if (!pick) return;
      cascade = pick === 'all';
    } else if (!await confirmInline(btn, { prompt: 'Delete this to do?' })) {
      return;
    }
  }
  await api.del(editingId, cascade);
  $('#taskModal').hidden = true;
  $('#taskModal').dataset.new = '';
  editingId = null;
  await refresh();
  if (!isNew) toast('Deleted');
}

/* ============================================================
   LOAD
   ============================================================ */
async function refresh() {
  await api.materialize(ymd(addDays(new Date(), 90)));
  tasks = await api.list();
  clampSelectedDay();
  render();
  if (!$('#activityPanel').hidden) { await loadActivity(); renderActivity(); }
}

/**
 * Bring `day` on screen, jumping weeks if it falls outside the current view.
 * Moving a to do to another week used to look like a delete: it saved, then
 * vanished, because the board stayed put. Returns true if the week changed.
 */
function revealDay(day) {
  if (!day || visibleDays().includes(day)) return false;
  weekStart = startOfWeek(parseYMD(day));
  selectedDay = day;
  render();
  alignStrip();
  return true;
}

function clampSelectedDay() {
  if (!visibleDays().includes(selectedDay)) selectedDay = ymd(weekStart);
}

function alignStrip() {
  const canvas = $('#canvas');
  const strip  = $('#dayStrip');
  requestAnimationFrame(() => {
    const target = strip.offsetTop - canvas.clientHeight * 0.62;
    if (target > 0) canvas.scrollTop = target;
  });
}

function gotoWeek(delta) {
  weekStart = delta === 0 ? startOfWeek(new Date()) : addDays(weekStart, delta * 7);
  selectedDay = delta === 0 ? ymd(new Date()) : ymd(weekStart);
  clampSelectedDay();
  render();
  alignStrip();
}

/* ============================================================
   ACTIVITY PANEL
   ============================================================ */
let actTab   = 'starred';
let activity = [];
let gcalState = { configured: false, connected: false };

const ACT_KIND = {
  created:   { verb: 'created',            dot: '#12B2A6' },
  deleted:   { verb: 'deleted',            dot: '#A8392C' },
  completed: { verb: 'completed',          dot: '#4E9377' },
  reopened:  { verb: 'moved back to To Do',dot: '#7A8790' },
  moved:     { verb: 'moved',              dot: '#1E88C4' },
  hours:     { verb: 'duration changed',   dot: '#C9A227' },
  time:      { verb: 'start time set',     dot: '#1E88C4' },
  renamed:   { verb: 'renamed',            dot: '#7A8790' },
  starred:   { verb: 'starred',            dot: '#F7D046' },
  unstarred: { verb: 'unstarred',          dot: '#7A8790' },
  repeat:    { verb: 'repeat changed',     dot: '#8E7CC3' },
  undo:      { verb: '',                   dot: '#7A8790' },
};

function fmtAgo(iso) {
  const then = new Date(iso), now = new Date();
  const mins = Math.round((now - then) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24 && then.toDateString() === now.toDateString()) return `${hrs}h ago`;
  if (then.toDateString() === addDays(now, -1).toDateString()) return 'yesterday';
  return `${then.getDate()} ${MONTHS_SHORT[then.getMonth()]}`;
}

async function loadActivity() {
  try { activity = await api.activity(); } catch { activity = []; }
}

function emptyState(text, icon) {
  return `<div class="act-empty">
    <div class="act-art">${icon}</div>
    <p>${text}</p>
  </div>`;
}

function renderActivity() {
  if ($('#activityPanel').hidden) { updateAlertDot(); return; }
  const body = $('#actBody');
  body.innerHTML = '';

  if (actTab === 'starred')      renderStarredTab(body);
  else if (actTab === 'log')     renderLogTab(body);
  else                           renderAlertsTab(body);
  stagger(body.children, { y: 8, delay: 0.016 });

  renderActFooter();
  updateAlertDot();
}

function renderStarredTab(body) {
  const starred = tasks.filter(t => t.starred);
  const head = document.createElement('div');
  head.className = 'act-section';
  head.textContent = 'Starred';
  body.appendChild(head);

  if (!starred.length) {
    body.insertAdjacentHTML('beforeend', emptyState(
      'Nothing starred yet. Right-click any to do and choose <b>Star</b> to keep it here.',
      `<svg viewBox="0 0 24 24"><polygon points="12 3 14.6 8.6 20.8 9.4 16.2 13.7 17.4 19.8 12 16.8 6.6 19.8 7.8 13.7 3.2 9.4 9.4 8.6"/></svg>`));
    return;
  }
  starred
    .sort((a, b) => (a.day || '9999').localeCompare(b.day || '9999'))
    .forEach(t => body.appendChild(taskRow(t)));
}

function taskRow(t) {
  const c = COLOR[t.color] || fallback;
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'act-row' + (t.done ? ' is-done' : '');
  row.innerHTML = `
    <span class="a-dot" style="background:${c.hex}"></span>
    <span class="a-body">
      <span class="a-title">${esc(t.title || 'Untitled')}</span>
      <span class="a-meta">${t.day ? fmtDatePill(t.day) : 'My items'}${t.startTime ? ' · ' + fmtTime(t.startTime) : ''}${t.hours ? ' · ' + fmtHours(t.hours) : ''}</span>
    </span>`;
  row.addEventListener('click', () => jumpToTask(t));
  return row;
}

function renderLogTab(body) {
  const head = document.createElement('div');
  head.className = 'act-section';
  head.textContent = 'History';
  body.appendChild(head);

  if (!activity.length) {
    body.insertAdjacentHTML('beforeend', emptyState(
      'Nothing has happened yet. Create, move or re-time a to do and it will show up here.',
      `<svg viewBox="0 0 24 24"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><polyline points="3.2 4.4 3.2 9.2 8 9.2"/><polyline points="12 7.6 12 12 15 13.8"/></svg>`));
    return;
  }

  for (const a of activity.slice(0, 120)) {
    const meta = ACT_KIND[a.kind] || { verb: a.kind, dot: '#7A8790' };
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'act-row';
    const detail = [meta.verb, a.detail].filter(Boolean).join(' ');
    row.innerHTML = `
      <span class="a-dot" style="background:${meta.dot}"></span>
      <span class="a-body">
        <span class="a-title">${esc(a.title || 'Flow')}</span>
        <span class="a-meta">${esc(detail)}</span>
        <span class="a-when">${fmtAgo(a.at)}</span>
      </span>`;
    row.addEventListener('click', () => {
      const t = tasks.find(x => x.id === a.taskId);
      if (t) jumpToTask(t); else toast('That to do no longer exists');
    });
    body.appendChild(row);
  }

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'act-clear';
  clear.textContent = 'Clear history';
  clear.addEventListener('click', async () => {
    if (!await confirmInline(clear, { prompt: 'Clear history?', confirmLabel: 'Clear' })) return;
    await api.clearActivity();
    await loadActivity();
    renderActivity();
  });
  body.appendChild(clear);
}

function buildAlerts() {
  const out = [];
  const today = ymd(new Date());
  const cap   = Number(settings.capacityHours) || 8;
  const NLONG = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  const late = tasks.filter(t => !t.done && t.day && t.day < today);
  if (late.length) out.push({
    level: 'bad',
    title: `${late.length} to do${late.length > 1 ? 's' : ''} overdue`,
    meta: 'Still open on days that have already passed.',
    act: () => $('#overduePill').click(),
    actLabel: 'Move to today',
  });

  for (const key of visibleDays()) {
    const h = tasks.filter(t => t.day === key && !t.done).reduce((s, t) => s + (Number(t.hours) || 0), 0);
    if (h > cap + 0.001) out.push({
      level: 'warn',
      title: `${NLONG[parseYMD(key).getDay()]} is over capacity`,
      meta: `${fmtTotal(h)} planned against a ${cap}h day.`,
      act: () => { selectedDay = key; render(); },
      actLabel: 'Show me',
    });
  }

  const noEstimate = tasks.filter(t => !t.done && t.day && !t.hours).length;
  if (noEstimate) out.push({
    level: 'info',
    title: `${noEstimate} scheduled to do${noEstimate > 1 ? 's have' : ' has'} no estimate`,
    meta: 'They take up no space on the day and are excluded from totals.',
  });

  if (gcalState.configured && !gcalState.connected) out.push({
    level: 'info',
    title: 'Google Calendar is set up but not connected',
    meta: 'Connect it to push your to dos into your calendar.',
    act: openSettings, actLabel: 'Open sync',
  });

  return out;
}

function renderAlertsTab(body) {
  const head = document.createElement('div');
  head.className = 'act-section';
  head.textContent = 'Needs attention';
  body.appendChild(head);

  const alerts = buildAlerts();
  if (!alerts.length) {
    body.insertAdjacentHTML('beforeend', emptyState(
      'All clear — nothing overdue, nothing over capacity.',
      `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="8 12.4 11 15.4 16 9.4"/></svg>`));
    return;
  }
  for (const a of alerts) {
    const row = document.createElement(a.act ? 'button' : 'div');
    if (a.act) row.type = 'button';
    row.className = `act-row act-alert ${a.level}`;
    row.innerHTML = `
      <span class="a-body">
        <span class="a-title">${esc(a.title)}</span>
        <span class="a-meta">${esc(a.meta)}${a.actLabel ? ` <span class="act-verb">${esc(a.actLabel)} →</span>` : ''}</span>
      </span>`;
    if (a.act) row.addEventListener('click', a.act);
    body.appendChild(row);
  }
}

function updateAlertDot() {
  const urgent = buildAlerts().filter(a => a.level !== 'info').length;
  $('#actDot').hidden = urgent === 0;
}

function renderActFooter() {
  const foot = $('#actFoot');
  const cap  = Number(settings.capacityHours) || 8;
  const days = visibleDays();
  const weekCap = cap * days.length;
  const planned = tasks.filter(t => !t.done && days.includes(t.day))
                       .reduce((s, t) => s + (Number(t.hours) || 0), 0);
  const doneThisWeek = tasks.filter(t => t.done && days.includes(t.day)).length;
  const openThisWeek = tasks.filter(t => !t.done && days.includes(t.day)).length;
  const total = doneThisWeek + openThisWeek;

  const loadPct = weekCap ? (planned / weekCap) * 100 : 0;
  const loadCls = loadPct > 100 ? 'bad' : loadPct > 85 ? 'warn' : '';

  foot.innerHTML = `
    <div class="act-stat ${loadCls}">
      <div class="act-stat-top"><span>Planned this week</span><b>${fmtTotal(planned) || '0h'} / ${weekCap}h</b></div>
      <div class="act-bar"><i style="width:${Math.min(100, loadPct)}%"></i></div>
    </div>
    <div class="act-stat">
      <div class="act-stat-top"><span>Done this week</span><b>${doneThisWeek}/${total}</b></div>
      <div class="act-bar"><i style="width:${total ? (doneThisWeek / total) * 100 : 0}%"></i></div>
    </div>`;
}

async function toggleActivityPanel(force) {
  const panel = $('#activityPanel');
  const open  = force !== undefined ? force : panel.hidden;
  panel.hidden = !open;
  $('#railActivity').classList.toggle('is-panel', open);
  $('#railActivity').setAttribute('aria-expanded', String(open));
  localStorage.setItem('flow.activity', open ? '1' : '0');
  if (open) {
    await loadActivity();
    try { gcalState = await api.gcalStatus(); } catch {}
    renderActivity();
  }
}

/* ============================================================
   QUICK-ADD TEMPLATES  ("Add New")
   ============================================================ */
async function loadTemplates() {
  try { templates = await api.templates(); } catch { templates = []; }
  renderAddNew();
}

function renderAddNew() {
  const list = $('#addNewList');
  list.innerHTML = '';
  if (!templates.length) {
    list.innerHTML = `<div class="addnew-empty">No templates yet.<br>
      Right-click any to do → <b>Save as template</b>.</div>`;
    return;
  }
  for (const tpl of templates) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'addnew-row';
    row.innerHTML = `
      ${tpl.recurring ? `<span class="t-rep" title="Recurring">${REP_SVG}</span>` : ''}
      ${tpl.startTime ? `<span class="t-time">${fmtTime(tpl.startTime)}</span>` : ''}
      <span class="t-title">${esc(tpl.title || 'Untitled')}</span>
      ${tpl.hours ? `<span class="t-dur">${fmtHours(tpl.hours)}</span>` : ''}
      <span class="t-kill" title="Remove this template" role="button">×</span>`;

    row.addEventListener('click', async (e) => {
      if (e.target.closest('.t-kill')) {
        e.stopPropagation();
        await api.delTemplate(tpl.id);
        await loadTemplates();
        toast('Template removed');
        return;
      }
      closeAddNew();
      pushUndo('add');
      const { id, ...rest } = tpl;
      await api.create({ ...rest, day: selectedDay });
      await refresh();
      toast(`Added “${tpl.title || 'Untitled'}”`);
    });
    list.appendChild(row);
  }
}

function openAddNew() {
  renderAddNew();
  $('#addNewMenu').hidden = false;
  $('#addNewBtn').setAttribute('aria-expanded', 'true');
}
function closeAddNew() {
  $('#addNewMenu').hidden = true;
  $('#addNewBtn').setAttribute('aria-expanded', 'false');
}

/* ============================================================
   GLOBAL SEARCH  (⌘K)
   ============================================================ */
function openSearch() {
  closeAddNew();
  $('#searchModal').hidden = false;
  $('#searchInput').value = '';
  renderSearch('');
  setTimeout(() => $('#searchInput').focus(), 20);
}

function jumpToTask(t) {
  $('#searchModal').hidden = true;
  if (t.day) {
    weekStart = startOfWeek(parseYMD(t.day));
    const dow = parseYMD(t.day).getDay();
    if ((dow === 0 || dow === 6) && !showWeekend) {
      showWeekend = true;
      $('#showWeekend').checked = true;
      localStorage.setItem('flow.weekend', '1');
    }
    selectedDay = t.day;
    render();
    alignStrip();
  }
  openEdit(t);
}

function renderSearch(q) {
  const res  = $('#searchResults');
  const term = q.trim().toLowerCase();
  res.innerHTML = '';

  const list = term
    ? tasks.filter(t => (t.title || '').toLowerCase().includes(term) ||
                        (t.notes || '').toLowerCase().includes(term))
    : tasks.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 12);

  if (!list.length) {
    res.innerHTML = `<div class="search-empty">${term ? 'Nothing matches that.' : 'No to dos yet.'}</div>`;
    return;
  }
  if (!term) {
    const h = document.createElement('div');
    h.className = 'search-empty';
    h.style.cssText = 'padding:8px 16px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em';
    h.textContent = 'Recent';
    res.appendChild(h);
  }

  list.slice(0, 40).forEach((t, i) => {
    const c = COLOR[t.color] || fallback;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'search-row' + (t.done ? ' is-done' : '') + (i === 0 && term ? ' sel' : '');
    row.innerHTML = `
      <span class="s-dot" style="background:${c.hex}"></span>
      <span class="s-title">${esc(t.title || 'Untitled')}</span>
      <span class="s-when">${t.day ? fmtDatePill(t.day) : 'My items'}${t.hours ? ' · ' + fmtHours(t.hours) : ''}</span>`;
    row.addEventListener('click', () => jumpToTask(t));
    res.appendChild(row);
  });
  stagger(res.children, { y: 6, delay: 0.01 });
}

/* ============================================================
   BULK MANAGER
   Find to dos across every date and edit them in one go, so you
   never have to click through months to fix a series.
   ============================================================ */
const mgPicked = new Set();
let mgRows = [];

function mgFilters() {
  return {
    q:      $('#mgSearch').value.trim().toLowerCase(),
    from:   $('#mgFrom').value || '',
    to:     $('#mgTo').value || '',
    status: $('#mgStatus').value,
    kind:   $('#mgKind').value,
  };
}

/** an occurrence whose parent series no longer exists */
function isOrphan(t) {
  return !!t.parentId && !tasks.some(p => p.id === t.parentId);
}

function mgMatches(t, f) {
  if (f.status === 'open' && t.done) return false;
  if (f.status === 'done' && !t.done) return false;

  if (f.kind === 'repeat'      && !t.recurring) return false;
  if (f.kind === 'instance'    && !t.parentId) return false;
  if (f.kind === 'single'      && (t.recurring || t.parentId || !t.day)) return false;
  if (f.kind === 'noduration'  && (!t.day || Number(t.hours) > 0)) return false;
  if (f.kind === 'unscheduled' && t.day) return false;
  if (f.kind === 'orphan'      && !isOrphan(t)) return false;

  if (f.from && (!t.day || t.day < f.from)) return false;
  if (f.to   && (!t.day || t.day > f.to))   return false;

  if (f.q) {
    const hay = `${t.title || ''} ${t.notes || ''}`.toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

function renderManage() {
  const f    = mgFilters();
  const list = $('#mgList');
  mgRows = tasks.filter(t => mgMatches(t, f))
                .sort((a, b) => (a.day || '9999-99-99').localeCompare(b.day || '9999-99-99')
                             || (a.startTime || '').localeCompare(b.startTime || ''));
  list.innerHTML = '';

  // drop selections that the current filter hides
  const visible = new Set(mgRows.map(t => t.id));
  [...mgPicked].forEach(id => { if (!visible.has(id)) mgPicked.delete(id); });

  if (!mgRows.length) {
    list.innerHTML = `<div class="mg-empty">Nothing matches those filters.<br>Try widening the date range or switching Status to <b>All</b>.</div>`;
  } else {
    for (const t of mgRows) list.appendChild(mgRow(t));
    stagger(list.children, { y: 6, delay: 0.008 });
  }
  syncMgFooter();
}

function mgRow(t) {
  const c = COLOR[t.color] || fallback;
  const row = document.createElement('div');
  row.className = 'mg-row' + (t.done ? ' is-done' : '') + (mgPicked.has(t.id) ? ' is-on' : '');
  row.dataset.id = t.id;

  const tags = [
    t.recurring ? `<span class="mg-tag series">series</span>` : '',
    t.parentId && !isOrphan(t) ? `<span class="mg-tag occ">occurrence</span>` : '',
    isOrphan(t) ? `<span class="mg-tag orphan">orphaned</span>` : '',
    t.starred ? `<span class="mg-tag star">★</span>` : '',
  ].join('');

  row.innerHTML = `
    <label class="mg-check">
      <input type="checkbox" ${mgPicked.has(t.id) ? 'checked' : ''}>
      <span class="td-box sm" aria-hidden="true"><svg viewBox="0 0 14 14"><polyline points="2.6 7.2 5.6 10 11.2 4.2"/></svg></span>
    </label>
    <span class="mg-name">
      <span class="mg-swatch" style="background:${c.hex}"></span>
      <span class="mg-text">
        <span class="mg-t">${esc(t.title || 'Untitled')}${tags}</span>
        ${t.notes ? `<span class="mg-n">${esc(t.notes)}</span>` : ''}
      </span>
    </span>
    <span class="mg-day">${t.day ? fmtDatePill(t.day) : '—'}${t.startTime ? `<small>${fmtTime(t.startTime)}</small>` : ''}</span>
    <span class="mg-dur">${t.hours ? fmtHours(t.hours) : '—'}</span>`;

  row.addEventListener('click', (e) => {
    if (e.target.closest('.mg-check') && e.target.tagName !== 'INPUT') return;
    mgPicked.has(t.id) ? mgPicked.delete(t.id) : mgPicked.add(t.id);
    row.classList.toggle('is-on', mgPicked.has(t.id));
    row.querySelector('input').checked = mgPicked.has(t.id);
    syncMgFooter();
  });
  return row;
}

function syncMgFooter() {
  const n = mgPicked.size;
  $('#mgCount').textContent = n
    ? `${n} of ${mgRows.length} selected`
    : `${mgRows.length} to do${mgRows.length === 1 ? '' : 's'} — none selected`;
  $$('#mgActions button').forEach(b => b.disabled = n === 0);
  const all = $('#mgAll');
  all.checked = n > 0 && n === mgRows.length;
  all.indeterminate = n > 0 && n < mgRows.length;
}

/** label = what undo calls it ("delete 59"); verb = past tense for the toast */
async function mgApply(action, patch, label, verb) {
  const ids = [...mgPicked];
  if (!ids.length) return;
  pushUndo(label);
  const r = await api.bulk(ids, action, patch);
  if (r.error) return toast('Error: ' + r.error);
  mgPicked.clear();
  await refresh();
  renderManage();
  toast(`${verb} ${r.count} to do${r.count === 1 ? '' : 's'} — ⌘Z to undo`);
}

function openManage() {
  $('#manageModal').hidden = false;
  mgPicked.clear();
  renderManage();
  setTimeout(() => $('#mgSearch').focus(), 20);
}

/* ============================================================
   SETTINGS + BACKUP
   ============================================================ */
async function loadSettings() {
  try {
    settings = await api.settings();
    PX_HOUR = Number(settings.pxPerHour) || 34;
    $('#setCapacity').value = settings.capacityHours;
    $('#setDayStart').value = settings.dayStart || '09:00';
    $('#setScale').value    = String(PX_HOUR);
  } catch {}
}

async function persistSettings() {
  const cap   = parseFloat($('#setCapacity').value);
  const start = $('#setDayStart').value;
  settings = await api.saveSettings({
    capacityHours: Number.isFinite(cap) && cap > 0 ? cap : 8,
    dayStart: start || '09:00',
    pxPerHour: Number($('#setScale').value) || 34,
  });
  PX_HOUR = Number(settings.pxPerHour) || 34;
  render();
}

/* ============================================================
   EVENTS
   ============================================================ */
on('#newTaskBtn', 'click', () => newTask(selectedDay));
on('#addBacklog', 'click', () => newTask(null));
on('#railSearch', 'click', openSearch);

/* ── collapsible My items ──────────────────────────────────── */
function setSidebar(collapsed) {
  document.body.classList.toggle('side-collapsed', collapsed);
  localStorage.setItem('flow.sideCollapsed', collapsed ? '1' : '0');
}
on('#sideCollapse', 'click', () => setSidebar(true));
on('#sideExpand',   'click', () => setSidebar(false));

/* Peek the collapsed panel open on deliberate approach — hover, or a drag
   held over the spine — and close it again on the way out. */
(() => {
  const spine = $('#sideExpand');
  const side  = spine?.closest('.sidebar') || spine?.parentElement;
  if (!spine || !side) return;
  let hold;
  const peek = () => {
    clearTimeout(hold);
    if (document.body.classList.contains('side-collapsed')) document.body.classList.add('side-peek');
  };
  const unpeek = () => {
    clearTimeout(hold);
    hold = setTimeout(() => {
      if (!dragging && !side.matches(':hover')) document.body.classList.remove('side-peek');
    }, 220);
  };
  spine.addEventListener('mouseenter', peek);
  spine.addEventListener('dragover', peek);
  spine.addEventListener('pointerenter', () => { if (dragging) peek(); });
  side.addEventListener('mouseleave', unpeek);
})();

/* ── bulk manager ──────────────────────────────────────────── */
on('#manageBtn', 'click', openManage);
on('#mgClose', 'click', () => $('#manageModal').hidden = true);
['#mgSearch', '#mgFrom', '#mgTo', '#mgStatus', '#mgKind'].forEach(sel => {
  on(sel, 'input', renderManage);
  on(sel, 'change', renderManage);
});
on('#mgReset', 'click', () => {
  ['#mgSearch', '#mgFrom', '#mgTo'].forEach(sel => $(sel).value = '');
  $('#mgStatus').value = 'open';
  $('#mgKind').value = 'all';
  mgPicked.clear();
  renderManage();
});
on('#mgAll', 'change', (e) => {
  mgPicked.clear();
  if (e.target.checked) mgRows.forEach(t => mgPicked.add(t.id));
  renderManage();
});

$$('#mgActions button').forEach(b => b.addEventListener('click', async () => {
  const kind = b.dataset.bulk;
  const n = mgPicked.size;
  if (!n) return;

  if (kind === 'delete') {
    if (!await confirmInline(b, { prompt: `Delete ${n} to do${n > 1 ? 's' : ''}?` })) return;
    return mgApply('delete', {}, `delete ${n}`, 'Deleted');
  }
  if (kind === 'unschedule') return mgApply('patch', { day: null }, `move ${n}`, 'Moved');
  if (kind === 'done')       return mgApply('patch', { done: true }, `complete ${n}`, 'Completed');
  if (kind === 'open')       return mgApply('patch', { done: false }, `reopen ${n}`, 'Reopened');
  if (kind === 'move') {
    const d = prompt(`Move ${n} to do${n > 1 ? 's' : ''} to which date?  (YYYY-MM-DD)`, ymd(new Date()));
    if (!d) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return toast('Use the format YYYY-MM-DD');
    return mgApply('patch', { day: d }, `move ${n}`, 'Moved');
  }
  if (kind === 'hours') {
    const raw = prompt(`Set the duration for ${n} to do${n > 1 ? 's' : ''}.\n\nTry “45m”, “1h 30m” or “2”. Leave blank to clear the estimate.`, '1h');
    if (raw === null) return;
    const hours = parseDuration(raw);
    if (raw.trim() && !hours) return toast('Could not read that duration');
    return mgApply('patch', { hours }, `set duration on ${n}`, hours ? 'Set duration on' : 'Cleared duration on');
  }
  if (kind === 'shift') {
    const raw = prompt(`Shift ${n} to do${n > 1 ? 's' : ''} by how many days?  (negative moves earlier)`, '7');
    if (raw === null) return;
    const days = parseInt(raw, 10);
    if (!Number.isFinite(days) || days === 0) return toast('Enter a whole number of days');
    return mgApply('shift', { days }, `shift ${n}`, 'Shifted');
  }
}));
on('#pickClear', 'click', clearPicked);

/* ── activity panel ────────────────────────────────────────── */
on('#railActivity', 'click', () => toggleActivityPanel());
on('#actClose', 'click', () => toggleActivityPanel(false));
$$('.act-tab').forEach(tab => tab.addEventListener('click', () => {
  actTab = tab.dataset.tab;
  $$('.act-tab').forEach(t => {
    const on = t === tab;
    t.classList.toggle('is-on', on);
    t.setAttribute('aria-selected', String(on));
  });
  renderActivity();
}));
on('#prevWeek', 'click',  () => gotoWeek(-1));
on('#nextWeek', 'click',  () => gotoWeek(1));
on('#thisWeek', 'click',  () => gotoWeek(0));

on('#showWeekend', 'change', (e) => {
  showWeekend = e.target.checked;
  localStorage.setItem('flow.weekend', showWeekend ? '1' : '0');
  clampSelectedDay();
  render();
  alignStrip();
});

on('#colourMode', 'change', (e) => {
  localStorage.setItem('flow.colour', e.target.checked ? '1' : '0');
  document.body.classList.toggle('colour-blocks', e.target.checked);
});

/* restore view preferences */
(function restorePrefs() {
  showWeekend = localStorage.getItem('flow.weekend') === '1';
  $('#showWeekend').checked = showWeekend;
  const colour = localStorage.getItem('flow.colour') === '1';
  $('#colourMode').checked = colour;
  document.body.classList.toggle('colour-blocks', colour);
})();

on('#itemSearch', 'input', (e) => {
  searchTerm = e.target.value.trim();
  renderSidebar();
});

on('#mCancel', 'click', closeEdit);
on('#mSave', 'click', () => saveEdit());
on('#mLog', 'click', () => saveEdit({ markDone: true }));
on('#mDelete', 'click', deleteTask);
on('#mRecurring', 'change', (e) => {
  $('#mUntilWrap').hidden = !e.target.value;
});

/* ── to do card: duration, date pill, header tools ─────────── */
on('#mDay', 'change', syncDatePill);

$$('.td-pill').forEach(p => p.addEventListener('click', () => {
  const h = parseFloat(p.dataset.h);
  // tapping the active pill clears the estimate
  syncDuration(parseDuration($('#mHours').value) === h ? 0 : h);
}));
on('#mHours', 'input', () => {
  syncDuration(parseDuration($('#mHours').value), { writeInput: false });
});
on('#mHours', 'blur', () => {
  syncDuration(parseDuration($('#mHours').value));   // normalise "90m" → "1h 30m"
});

$$('.td-pill[data-t]').forEach(p => p.addEventListener('click', () => {
  syncStart($('#mStart').value === p.dataset.t ? '' : p.dataset.t);
  if ($('#mStart').value) $('#mAnytime').checked = false;
}));
on('#mClearStart', 'click', () => syncStart(''));
on('#mStart', 'change', () => syncStart($('#mStart').value));

/* Anytime and a start time are mutually exclusive — picking one clears the
   other rather than leaving the card in a state the board can't render. */
on('#mAnytime', 'change', () => {
  if ($('#mAnytime').checked) { syncStart(''); syncDuration(0); }
  else if (!parseDuration($('#mHours').value)) syncDuration(1);
});

on('#tdHelp', 'click', () => { $('#helpModal').hidden = false; });

on('#tdMenu', 'click', (e) => {
  e.stopPropagation();
  const pop = $('#tdMenuPop');
  pop.hidden = !pop.hidden;
  $('#tdMenu').setAttribute('aria-expanded', String(!pop.hidden));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.td-menu-wrap')) {
    $('#tdMenuPop').hidden = true;
    $('#tdMenu')?.setAttribute('aria-expanded', 'false');
  }
});

$$('#tdMenuPop button').forEach(b => b.addEventListener('click', async () => {
  const act = b.dataset.act;
  $('#tdMenuPop').hidden = true;
  if (act === 'clear')      return syncDuration(0);
  if (act === 'unschedule') { $('#mDay').value = ''; return syncDatePill(); }
  if (act === 'duplicate') {
    const made = await duplicateTask(editingId);
    if (!made) return;
    $('#taskModal').hidden = true;
    editingId = null;
    await refresh();
    toast('Duplicated');
  }
}));

$$('[data-close]').forEach(el => el.addEventListener('click', () => {
  if (!$('#taskModal').hidden) closeEdit();
  $('#settingsModal').hidden = true;
  $('#helpModal').hidden = true;
}));

on('#railHelp', 'click', () => { $('#helpModal').hidden = false; });

on('#signInForm', 'submit', async (e) => {
  e.preventDefault();
  const pw = $('#signInPw').value;
  const r = await fetch('/api/session', { method: 'POST', headers: J, body: JSON.stringify({ password: pw }) });
  if (!r.ok) { $('#signInError').textContent = 'That password did not work.'; return; }
  $('#signIn').hidden = true;
  $('#signInPw').value = '';
  $('#signInError').textContent = '';
  await boot();
});

/* ── add new / templates ───────────────────────────────────── */
on('#addNewBtn', 'click', (e) => {
  e.stopPropagation();
  $('#addNewMenu').hidden ? openAddNew() : closeAddNew();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#addNewMenu, #addNewBtn')) closeAddNew();
});

/* ── collapse Done ─────────────────────────────────────────── */
on('#doneToggle', 'click', () => {
  const zone = $('.zone-done');
  const collapsed = !document.body.classList.contains('done-collapsed');
  // Measure while the zone is still laid out, then let the class land at the
  // end of the animation so `display: none` never truncates it mid-flight.
  if (collapsed) {
    collapse(zone, false).then(() => document.body.classList.add('done-collapsed'));
  } else {
    document.body.classList.remove('done-collapsed');
    collapse(zone, true);
  }
  $('#doneToggle').setAttribute('aria-expanded', String(!collapsed));
  $('#doneToggle').title = collapsed ? 'Show Done' : 'Collapse Done';
  localStorage.setItem('flow.doneCollapsed', collapsed ? '1' : '0');
});

/* ── search ────────────────────────────────────────────────── */
on('#searchInput', 'input', (e) => renderSearch(e.target.value));
on('#searchInput', 'keydown', (e) => {
  if (e.key === 'Enter') {
    const first = $('#searchResults .search-row');
    if (first) first.click();
  }
});

/* ── settings + backup ─────────────────────────────────────── */
on('#setCapacity', 'change', persistSettings);
on('#setDayStart', 'change', persistSettings);
on('#setScale', 'change', persistSettings);
/* ── storage: where the to dos live ────────────────────────────
   Local keeps everything in this browser and needs no server at all.
   Server keeps it wherever the Flow server puts it. The backup file is
   the bridge: the same JSON restores into either.
   ─────────────────────────────────────────────────────────── */

function saveAs(name, obj) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function renderStoragePanel() {
  const where = $('#storageWhere');
  const swap  = $('#storageSwitch');
  const copy  = $('#storageCopy');
  const warn  = $('#storageWarn');
  if (!where) return;

  const serverThere = await serverAvailable();
  if (STORAGE_MODE === 'local') {
    where.innerHTML = 'On <span class="storage-here">this device only</span>, in this browser. ' +
      'Nothing is uploaded. Clearing site data, or a different browser, means different to dos.';
    swap.textContent = 'Use the server instead';
    swap.hidden = !serverThere;
    copy.hidden = true;
    warn.hidden = false;
    warn.textContent = 'Local storage has no backup. Download one regularly — it is the only copy.';
  } else {
    where.innerHTML = 'On the <span class="storage-here">Flow server</span> this page came from. ' +
      'Available from any browser that can sign in.';
    swap.textContent = 'Keep on this device instead';
    swap.hidden = false;
    copy.hidden = false;
    warn.hidden = true;
  }
}

on('#storageSwitch', 'click', async () => {
  const goingLocal = STORAGE_MODE === 'server';
  const ok = await confirmInline($('#storageSwitch'), {
    prompt: goingLocal ? 'Keep to dos on this device?' : 'Use the server instead?',
    confirmLabel: 'Switch',
  });
  if (!ok) return;
  localStorage.setItem('flow.storage', goingLocal ? 'local' : 'server');
  location.reload();
});

/* Copies the server's database into this browser, so switching to local
   does not look like every to do vanished. */
on('#storageCopy', 'click', async () => {
  const ok = await confirmInline($('#storageCopy'), {
    prompt: 'Copy the server data onto this device?',
    confirmLabel: 'Copy',
  });
  if (!ok) return;
  try {
    const doc = await fetch('/api/backup').then(r => r.json());
    const { localBackend } = await import('/local-store.js');
    await localBackend.importAll(doc);
    toast(`Copied ${doc.tasks.length} to dos to this device`);
  } catch (e) {
    toast('Copy failed: ' + e.message);
  }
});

on('#backupBtn', 'click', async () => {
  const doc = await api.backup();
  saveAs(`flow-backup-${ymd(new Date())}.json`, doc);
});

on('#restoreBtn', 'click', () => $('#restoreFile').click());
on('#restoreFile', 'change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { return toast('That file is not valid JSON'); }
  if (!Array.isArray(data.tasks)) return toast("That doesn't look like a Flow backup");
  if (!await confirmInline($('#restoreBtn'), {
        prompt: `Replace everything with ${data.tasks.length} to dos?`,
        confirmLabel: 'Replace' })) return;
  const r = await api.restore(data);
  if (r.error) return toast(r.error);
  undoStack.length = 0; redoStack.length = 0;
  await loadSettings();
  await loadTemplates();
  await refresh();
  toast(`Restored ${r.count} to dos`);
});

/* ── settings / sync ───────────────────────────────────────── */
async function openSettings() {
  $('#settingsModal').hidden = false;
  await renderStoragePanel();
  renderCalendarPanel();
  await refreshGcalUI();
}

/* A live subscription needs a URL something else can poll. On this device
   there is no server to poll, so the honest offer is a one-off export
   rather than a link that quietly 404s inside someone's calendar app. */
function renderCalendarPanel() {
  const local = STORAGE_MODE === 'local';
  $('#icsHeading').textContent = local ? 'Export to a calendar' : 'Subscribe (one-way, live)';
  $('#icsNote').textContent = local
    ? 'To dos on this device cannot be subscribed to — nothing is hosted for a calendar to poll. Export a snapshot instead, or switch to the server for a live feed.'
    : 'Add this URL in Apple Calendar → File → New Calendar Subscription. It polls and updates automatically.';
  $('#icsUrl').textContent = local ? '' : window.location.origin + '/calendar.ics';
  $('#icsUrl').hidden = local;
  $('#copyIcs').hidden = local;
}
on('#settingsBtn', 'click', openSettings);
on('#railSettings', 'click', openSettings);
on('#sClose', 'click', () => $('#settingsModal').hidden = true);

on('#downloadIcs', 'click', async () => {
  const text = STORAGE_MODE === 'local'
    ? await api.ics()
    : await fetch('/calendar.ics').then(r => r.text());
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'flow.ics';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Calendar exported');
});

on('#copyIcs', 'click', async () => {
  try { await navigator.clipboard.writeText($('#icsUrl').textContent); toast('Subscription URL copied'); }
  catch { toast('Copy failed — select the text manually'); }
});

async function refreshGcalUI() {
  const s = await api.gcalStatus();
  const set = (id, hidden) => $(id).hidden = hidden;
  if (!s.configured) {
    $('#gcalStatus').textContent = 'Not configured — follow the setup steps below, then restart the server.';
    ['#gcalConnect', '#gcalPush', '#gcalPull', '#gcalDisconnect'].forEach(i => set(i, true));
    return;
  }
  if (s.connected) {
    $('#gcalStatus').textContent = '✓ Connected to Google Calendar';
    set('#gcalConnect', true); set('#gcalPush', false); set('#gcalPull', false); set('#gcalDisconnect', false);
  } else {
    $('#gcalStatus').textContent = 'Configured, but not connected yet.';
    set('#gcalConnect', false); set('#gcalPush', true); set('#gcalPull', true); set('#gcalDisconnect', true);
  }
}

on('#gcalPush', 'click', async () => {
  toast('Pushing to Google Calendar…');
  const r = await api.gcalPush();
  toast(r.error ? 'Error: ' + r.error : `Created ${r.pushed} · updated ${r.updated} · removed ${r.removed}`);
});
on('#gcalPull', 'click', async () => {
  toast('Pulling from Google Calendar…');
  const r = await api.gcalPull();
  if (r.error) return toast('Error: ' + r.error);
  toast(`Updated ${r.updated} tasks`);
  await refresh();
});
on('#gcalDisconnect', 'click', async () => {
  if (!await confirmInline($('#gcalDisconnect'), { prompt: 'Disconnect Google Calendar?', confirmLabel: 'Disconnect' })) return;
  await api.gcalOff();
  await refreshGcalUI();
});

/* ── keyboard ──────────────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
  const taskOpen = !$('#taskModal').hidden;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  const meta = e.metaKey || e.ctrlKey;

  if (e.key === 'Escape') {
    if (taskOpen) closeEdit();
    $('#settingsModal').hidden = true;
    $('#helpModal').hidden = true;
    $('#searchModal').hidden = true;
    $('#manageModal').hidden = true;
    closeAddNew();
    closeCtx();
    closeInlineAdd();
    clearPicked();
    if (document.activeElement === $('#itemSearch')) $('#itemSearch').blur();
    return;
  }

  // ⌘K search / ⌘Z undo / ⇧⌘Z redo — available even while typing
  if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
  if (meta && e.key.toLowerCase() === 'a' && !typing) {
    e.preventDefault();
    setPicked($$('.block').map(b => b.dataset.id));
    return;
  }
  if (meta && e.key.toLowerCase() === 'z' && !taskOpen) {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (taskOpen && meta && e.key === 'Enter') {
    e.preventDefault();
    saveEdit({ markDone: e.shiftKey });   // ⇧⌘↵ logs it as done
    return;
  }
  if (taskOpen) return;

  if (meta && e.key.toLowerCase() === 'n') { e.preventDefault(); newTask(selectedDay); return; }
  if (typing) return;

  if ((e.key === 'Backspace' || e.key === 'Delete') && picked.size > 1) {
    e.preventDefault();
    (async () => {
      const targets = tasks.filter(t => picked.has(t.id));
      pushUndo(`delete ${targets.length}`);
      for (const t of targets) await api.del(t.id, false);
      clearPicked();
      await refresh();
      toast(`Deleted ${targets.length} to dos — ⌘Z to undo`);
    })();
    return;
  }
  if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); gotoWeek(-1); }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); gotoWeek(1); }
  if (e.altKey && e.key.toLowerCase() === 't') { e.preventDefault(); gotoWeek(0); }
});

/* ── boot ──────────────────────────────────────────────────── */
(function restoreSidebar() {
  if (localStorage.getItem('flow.sideCollapsed') === '1') {
    document.body.classList.add('side-collapsed');
  }
})();

(function restoreDoneCollapsed() {
  if (localStorage.getItem('flow.doneCollapsed') === '1') {
    document.body.classList.add('done-collapsed');
    $('#doneToggle').setAttribute('aria-expanded', 'false');
    $('#doneToggle').title = 'Show Done';
  }
})();

buildPicker();
async function boot() {
  await loadSettings();
  if (localStorage.getItem('flow.activity') === '1') await toggleActivityPanel(true);
  await loadTemplates();
  await refresh();
  alignStrip();
}

/* Ask the server whether this deployment wants a password before loading
   anything, so a signed-out visitor meets the sign-in panel rather than an
   empty week that silently failed to fetch. */
(async () => {
  const mode = await chooseBackend();
  // Local storage answers to nobody: there is no session to establish.
  if (mode === 'server') {
    try {
      const s = await fetch('/api/session').then(r => r.json());
      if (s.authRequired && !s.signedIn) return showSignIn();
    } catch { /* fall through and let boot surface the failure */ }
  }
  await boot();
})();
