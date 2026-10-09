// Woodshed — habit hours tracker. Plain JS, no build step, data saved on this device.
'use strict';

const KEY = 'woodshed.v1';
const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DEFAULT_HABITS = ['Sax', 'Piano', 'Production', 'Writing', 'Gym', 'Running'];

// ---------- storage (swap this section for a sync backend later) ----------
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function blankHabit(name, order) {
  return { id: uid(), name, order, retired: false, targets: [null, null, null, null, null, null, null] };
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.v === 1) return s;
  } catch (e) { /* fall through to a fresh state */ }
  return { v: 1, habits: DEFAULT_HABITS.map(blankHabit), sessions: [], marks: {}, timer: null };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { toast('Could not save on this device'); }
}
// tell sync.js a record changed (no-op if sync isn't loaded)
function pend(t, id) { if (window.Sync) Sync.pend(t, id); }
let S = load();

// ---------- dates (device local time) ----------
const pad = n => String(n).padStart(2, '0');
function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function fromKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function wd(d) { return (d.getDay() + 6) % 7; } // Mon = 0
function monday(d) { const m = new Date(d.getFullYear(), d.getMonth(), d.getDate()); m.setDate(m.getDate() - wd(m)); return m; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - y) / 864e5 - 3 + ((y.getUTCDay() + 6) % 7)) / 7);
}
const fmtDate = d => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

function fm(m) {
  m = Math.round(m);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + pad(m % 60) : '');
}
function clock(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return (h ? h + ':' + pad(m) : m) + ':' + pad(s);
}

// ---------- data helpers ----------
const active = () => S.habits.filter(h => !h.retired).sort((a, b) => a.order - b.order);
const habit = id => S.habits.find(h => h.id === id);
function minutesOn(habitId, key) {
  let m = 0;
  for (const s of S.sessions) if (!s.deleted && s.habit === habitId && s.date === key) m += s.minutes;
  return m;
}
function target(h, key) { return h.targets[wd(fromKey(key))]; }
function isDone(h, key) {
  const mk = key + '|' + h.id;
  const v = S.marks[mk];
  if (v === true || v === false) return v;
  const t = target(h, key);
  return !!t && minutesOn(h.id, key) >= t;
}
// stamped = what the week grid stamps: target hit, or any time on a day with no target (a manual mark wins)
function stamped(h, key, mins) {
  const v = S.marks[key + '|' + h.id];
  if (v === true || v === false) return v;
  const t = target(h, key), m = mins === undefined ? minutesOn(h.id, key) : mins;
  return t ? m >= t : m > 0;
}

// ---------- streaks ----------
// days: stamped days in a row, ending today (or yesterday while today is still open)
// weeks: Mon–Sun weeks in a row that hold 3+ stamped days in a row
const STREAK_MIN_DAYS = 3;
function minutesMap() {
  const mm = {};
  for (const s of S.sessions) if (!s.deleted) mm[s.habit + '|' + s.date] = (mm[s.habit + '|' + s.date] || 0) + s.minutes;
  return mm;
}
function streaks(h, mm) {
  const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const st = d => stamped(h, dayKey(d), mm[h.id + '|' + dayKey(d)] || 0);
  const todayDone = st(today);
  let d = todayDone ? today : addDays(today, -1), days = 0;
  while (days < 3660 && st(d)) { days++; d = addDays(d, -1); }
  const weekOk = mon => {
    let run = 0;
    for (let i = 0; i < 7; i++) {
      const day = addDays(mon, i);
      if (day > today) break;
      run = st(day) ? run + 1 : 0;
      if (run >= STREAK_MIN_DAYS) return true;
    }
    return false;
  };
  let mon = monday(today), weeks = 0;
  if (!weekOk(mon)) mon = addDays(mon, -7);
  while (weeks < 520 && weekOk(mon)) { weeks++; mon = addDays(mon, -7); }
  return { days, weeks, todayDone };
}
function streakTags(h, mm) {
  const r = streaks(h, mm), out = [];
  if (r.days >= STREAK_MIN_DAYS) out.push('<span class="sk' + (r.todayDone ? '' : ' open') + '" title="' + (r.todayDone ? 'Stamped today' : 'Log today to keep it') + '"><b>' + r.days + '</b> days in a row</span>');
  if (r.weeks) out.push('<span class="sk wk"><b>' + r.weeks + '</b> week' + (r.weeks > 1 ? 's' : '') + ' in a row</span>');
  return out.length ? '<p class="streaks">' + out.join('') + '</p>' : '';
}

function addSession(habitId, key, minutes, at) {
  const s = { id: uid(), habit: habitId, date: key, minutes: Math.round(minutes), at: at || new Date().toISOString() };
  S.sessions.push(s);
  save(); pend('sessions', s.id);
  return s;
}
function removeSession(id) {
  const s = S.sessions.find(x => x.id === id);
  if (s) { s.deleted = true; save(); pend('sessions', id); }
}

// ---------- timer ----------
function startTimer(habitId) {
  if (S.timer) stopTimer();
  S.timer = { habit: habitId, start: Date.now() };
  save(); render();
}
function stopTimer() {
  const t = S.timer;
  if (!t) return;
  S.timer = null;
  const min = (Date.now() - t.start) / 60000;
  const h = habit(t.habit);
  if (min < 1) { save(); toast('Under a minute, not logged'); render(); return; }
  const s = addSession(t.habit, dayKey(new Date(t.start)), min, new Date(t.start).toISOString());
  toast(fm(min) + ' of ' + (h ? h.name : 'habit') + ' logged', () => { removeSession(s.id); render(); });
  render();
}

// ---------- toast with undo ----------
let toastTimer;
function toast(text, undo) {
  const el = document.getElementById('toast');
  document.getElementById('toastText').textContent = text;
  const u = document.getElementById('toastUndo');
  u.hidden = !undo;
  u.onclick = () => { if (undo) undo(); el.hidden = true; };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

// ---------- render ----------
const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  hide: '<svg viewBox="0 0 24 24"><path d="M4 12h16"/></svg>',
  show: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'
};
// rubber stamps for the week grid, picked from the habit's name (any habit works; unknown names get a check)
const STAMP = {
  sax: '<path d="M3.5 4l4.6-.6c1.4-.1 2 .7 2 2"/><path d="M10.1 6v9.3a3.4 3.4 0 0 0 6.8 0V12.5" stroke-width="3.2"/><path d="M14.6 11.4h5.4" stroke-width="2.6"/><g fill="#f5f7f8" stroke="none"><circle cx="10.1" cy="8.5" r=".75"/><circle cx="10.1" cy="11.3" r=".75"/><circle cx="10.1" cy="14.1" r=".75"/></g>',
  piano: '<rect x="3.5" y="5.5" width="17" height="13" rx="1"/><path d="M7.75 12.5v6M12 12.5v6M16.25 12.5v6"/><path d="M7 5.5v7h1.5v-7M11.25 5.5v7h1.5v-7M15.5 5.5v7h1.5v-7" fill="currentColor"/>',
  muscle: '<path d="M3 13c2-3.5 6.5-5.5 9.4-2.8l.6-2.6c-1.3-.3-1.8-1.8-1-2.8l1.2-1.4c.8-.9 2.3-.9 3.2 0l1.3 1.6c.6.8.6 1.6.3 2.4l-.4 7.6c.3 2-1 3.6-3 3.6H3z"/><path d="M12.4 10.2c.9 1 1.2 2.3 1 3.6"/>',
  clef: '<path d="M12.6 20.5c-.2 1.6-3.3 1.7-3.4-.1-.1-1.4 1.8-1.9 2.4-.8"/><path d="M12.6 20.5 11.4 3.8c-.1-1.5 2.5-1.6 2.6.4.1 2.9-5.7 5.4-5.7 9.6 0 2.6 2.2 4.1 4.4 4 2.1-.1 3.5-1.6 3.4-3.3-.1-1.8-1.5-2.9-3.1-2.8-1.7.1-2.6 1.4-2.5 2.6"/>',
  phones: '<path d="M4.5 15v-3a7.5 7.5 0 0 1 15 0v3"/><rect x="3.5" y="14" width="4" height="6.5" rx="1.4"/><rect x="16.5" y="14" width="4" height="6.5" rx="1.4"/>',
  shoe: '<path d="M3.5 17.5v-6.8c0-.6.6-1 1.2-.8 2 .7 3.7.4 4.6-1.6l.5-1.1c.2-.4.7-.6 1.1-.3 2.2 1.6 4.4 4 7.3 4.9 1.6.5 2.3 1.7 2.3 3.2v2.5z"/><path d="M3.5 15h17.1M12 9.6l-1.6 1.6M14 11.3l-1.6 1.6"/>',
  check: '<path d="M5.5 12.5l4.2 4.2L18.5 7.5"/>'
};
function stampFor(name) {
  const n = name.toLowerCase();
  if (/sax|horn|trumpet|trombone|clarinet|flute/.test(n)) return 'sax';
  if (/piano|keys|keyboard/.test(n)) return 'piano';
  if (/gym|lift|weight|strength|workout|muscle/.test(n)) return 'muscle';
  if (/writ|compos|song|arrang|chart/.test(n)) return 'clef';
  if (/produc|beat|mix|daw|record|ableton|logic/.test(n)) return 'phones';
  if (/run|jog|walk|cardio/.test(n)) return 'shoe';
  return 'check';
}
// each stamp lands at its own slight angle, same every time for the same cell
function tilt(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (Math.abs(h) % 19) - 9; }
function stamp(h, key, cls) {
  return '<span class="stamp ' + cls + '" style="--r:' + tilt(key + h.id) + 'deg"><svg viewBox="0 0 24 24">' + STAMP[stampFor(h.name)] + '</svg></span>';
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let weekOffset = 0;

function render() { renderHeader(); renderToday(); renderWeek(); }

function renderHeader() {
  const now = new Date(), key = dayKey(now);
  const mon = monday(now);
  let today = 0, week = 0;
  for (const s of S.sessions) {
    if (s.deleted) continue;
    if (s.date === key) today += s.minutes;
    const d = fromKey(s.date);
    if (d >= mon && d < addDays(mon, 7)) week += s.minutes;
  }
  const hs = active();
  const done = hs.filter(h => isDone(h, key)).length;
  const due = hs.filter(h => target(h, key)).length;
  document.getElementById('dayName').textContent = DAY_NAMES[wd(now)];
  document.getElementById('todaySub').innerHTML =
    now.getDate() + ' ' + now.toLocaleDateString('en-GB', { month: 'long' }) +
    ' · <b>' + fm(today) + '</b> today · ' + fm(week) + ' this week' +
    (due ? ' · ' + done + '/' + due + ' done' : '');
}

function renderToday() {
  const el = document.getElementById('today');
  const key = dayKey(new Date());
  const hs = active();
  if (!hs.length) {
    el.innerHTML = '<p class="empty">No habits yet. <button data-act="settings">Add one</button></p>';
    return;
  }
  const mm = minutesMap();
  el.innerHTML = hs.map(h => {
    const m = minutesOn(h.id, key), t = target(h, key), done = isDone(h, key);
    const running = S.timer && S.timer.habit === h.id;
    const p = t ? Math.min(100, m / t * 100) : 0;
    const meta = running
      ? '<p class="meta live" data-live>' + clock(Math.floor((Date.now() - S.timer.start) / 1000)) + '</p>'
      : '<p class="meta">' + fm(m) + (t ? ' / ' + fm(t) : h.targets.some(Boolean) ? ' · rest day' : ' · no target set') + '</p>';
    return '<div class="row">' +
      '<div class="nm"><p class="name">' + esc(h.name) + '</p>' + meta + streakTags(h, mm) +
      (t ? '<div class="bar"><i style="width:' + p + '%"></i></div>' : '') + '</div>' +
      '<button class="btn play' + (running ? ' on' : '') + '" data-act="timer" data-id="' + h.id + '" aria-label="' + (running ? 'Stop' : 'Start') + ' ' + esc(h.name) + ' timer">' + (running ? ICON.stop : ICON.play) + '</button>' +
      '<button class="btn" data-act="add" data-min="15" data-id="' + h.id + '" aria-label="Add 15 minutes of ' + esc(h.name) + '">+15</button>' +
      '<button class="btn" data-act="add" data-min="30" data-id="' + h.id + '" aria-label="Add 30 minutes of ' + esc(h.name) + '">+30</button>' +
      '<button class="done' + (done ? ' on' : '') + (t ? '' : ' rest') + '" data-act="mark" data-id="' + h.id + '" data-day="' + key + '" aria-label="' + (done ? 'Done' : 'Not done') + ': ' + esc(h.name) + '">' + (done ? ICON.check : '') + '</button>' +
      '</div>';
  }).join('');
}

function renderWeek() {
  const now = new Date(), todayKey = dayKey(now);
  const mon = addDays(monday(now), weekOffset * 7);
  const days = [...Array(7)].map((_, i) => addDays(mon, i));
  const keys = days.map(dayKey);
  const label = weekOffset === 0 ? 'This week' : weekOffset === -1 ? 'Last week' : 'Week ' + isoWeek(mon) + ' · ' + mon.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  document.getElementById('weekLabel').textContent = label;
  document.getElementById('nextWeek').style.visibility = weekOffset < 0 ? 'visible' : 'hidden';

  let g = '<div></div>' + days.map((d, i) =>
    '<div class="dh' + (keys[i] === todayKey ? ' t' : '') + '"><button data-act="day" data-day="' + keys[i] + '" aria-label="' + fmtDate(d) + '">' + DAYS[i] + '<small>' + d.getDate() + '</small></button></div>'
  ).join('') + '<div class="dh">Σ</div>';

  for (const h of active()) {
    g += '<div class="hl">' + esc(h.name) + '</div>';
    let wk = 0;
    keys.forEach((k, i) => {
      const m = minutesOn(h.id, k), t = h.targets[i];
      wk += m;
      const tc = k === todayKey ? ' tc' : '';
      const lbl = esc(h.name) + ', ' + fmtDate(days[i]) + ': ' + fm(m) + (t ? ' of ' + fm(t) : '');
      if (k > todayKey) { g += '<div class="c fut" aria-hidden="true"></div>'; return; }
      // stamped = did it (target hit, or any time on a no-target day); faint stamp = started, short of target
      const ok = stamped(h, k, m);
      const part = !ok && m > 0;
      const state = ok ? ', done' : part ? ', started' : '';
      g += '<button class="c' + (ok ? ' ok' : part ? ' part' : '') + tc + '" data-act="day" data-day="' + k + '" aria-label="' + lbl + state + '">' +
        (ok ? stamp(h, k, '') : part ? stamp(h, k, 'faint') : '') + '</button>';
    });
    g += '<div class="tot">' + (wk ? fm(wk) : '') + '</div>';
  }
  document.getElementById('grid').innerHTML = g;
}

// ---------- day sheet ----------
let openDay = null;
function showDay(key) {
  openDay = key;
  renderDay();
  const sel = document.getElementById('addHabit');
  sel.innerHTML = active().map(h => '<option value="' + h.id + '">' + esc(h.name) + '</option>').join('');
  const dlg = document.getElementById('dayDialog');
  if (!dlg.open) dlg.showModal();
}
function renderDay() {
  const key = openDay, d = fromKey(key);
  document.getElementById('dayTitle').textContent = fmtDate(d);
  const blocks = active().map(h => {
    const ss = S.sessions.filter(s => !s.deleted && s.habit === h.id && s.date === key);
    const m = ss.reduce((a, s) => a + s.minutes, 0), t = target(h, key);
    const rows = ss.map(s => {
      const at = new Date(s.at);
      const time = isNaN(at) ? '' : at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return '<div class="sess"><span>' + fm(s.minutes) + (time ? ' · ' + time : '') + '</span><button data-act="del" data-sid="' + s.id + '" aria-label="Delete this session">' + ICON.x + '</button></div>';
    }).join('');
    return '<div class="dhab"><div class="h">' + esc(h.name) + '<span>' + fm(m) + (t ? ' / ' + fm(t) : ' · rest') + (isDone(h, key) ? ' · done' : '') + '</span></div>' + rows + '</div>';
  });
  document.getElementById('dayList').innerHTML = blocks.length ? blocks.join('') : '<p class="nothing">No habits yet.</p>';
}

// ---------- settings sheet ----------
function showSettings() { renderSettings(); if (window.Sync) Sync.renderSync(); document.getElementById('settingsDialog').showModal(); }
function renderSettings() {
  const hs = [...S.habits].sort((a, b) => (a.retired - b.retired) || (a.order - b.order));
  document.getElementById('habitEditor').innerHTML = hs.map(h =>
    '<div class="hed' + (h.retired ? ' retired' : '') + '" data-id="' + h.id + '">' +
      '<div class="r1"><input value="' + esc(h.name) + '" data-f="name" aria-label="Habit name">' +
      (h.retired ? '' :
        '<button data-act="move" data-dir="-1" aria-label="Move up">' + ICON.up + '</button>' +
        '<button data-act="move" data-dir="1" aria-label="Move down">' + ICON.down + '</button>') +
      '<button data-act="retire" aria-label="' + (h.retired ? 'Bring back' : 'Retire') + ' ' + esc(h.name) + '" title="' + (h.retired ? 'Bring back' : 'Retire (keeps history)') + '">' + (h.retired ? ICON.show : ICON.hide) + '</button></div>' +
      (h.retired ? '' :
        '<div class="tg">' + DAYS.map((d, i) =>
          '<div><label for="t' + h.id + i + '">' + d + '</label><input id="t' + h.id + i + '" type="number" inputmode="numeric" min="0" max="720" placeholder="–" value="' + (h.targets[i] ?? '') + '" data-f="t" data-i="' + i + '"></div>'
        ).join('') + '</div><button class="copy" data-act="copyMon">Copy Monday to all days</button>') +
    '</div>'
  ).join('');
}

// ---------- events ----------
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  if (act === 'timer') { S.timer && S.timer.habit === id ? stopTimer() : startTimer(id); }
  else if (act === 'add') {
    const s = addSession(id, dayKey(new Date()), +b.dataset.min);
    toast('+' + b.dataset.min + 'm ' + habit(id).name, () => { removeSession(s.id); render(); });
    render();
  }
  else if (act === 'mark') {
    const h = habit(id), key = b.dataset.day, mk = key + '|' + id;
    const want = !isDone(h, key);
    S.marks[mk] = null;
    if (isDone(h, key) !== want) S.marks[mk] = want;
    save(); pend('marks', mk); render();
  }
  else if (act === 'day') showDay(b.dataset.day);
  else if (act === 'del') {
    const s = S.sessions.find(x => x.id === b.dataset.sid);
    removeSession(b.dataset.sid);
    toast('Session deleted', () => { s.deleted = false; save(); pend('sessions', s.id); renderDay(); render(); });
    renderDay(); render();
  }
  else if (act === 'settings') showSettings();
  else if (act === 'move' || act === 'retire' || act === 'copyMon') {
    const hid = b.closest('.hed').dataset.id, h = habit(hid);
    pend('habits', h.id);
    if (act === 'retire') { h.retired = !h.retired; if (!h.retired) h.order = Math.max(0, ...S.habits.map(x => x.order)) + 1; }
    if (act === 'copyMon') h.targets = h.targets.map(() => h.targets[0]);
    if (act === 'move') {
      const list = active(), i = list.indexOf(h), j = i + +b.dataset.dir;
      if (j >= 0 && j < list.length) { const o = list[j].order; list[j].order = h.order; h.order = o; pend('habits', list[j].id); }
      if (list[j] && list[j].order === h.order) h.order += +b.dataset.dir;
    }
    save(); renderSettings(); render();
  }
});

document.getElementById('habitEditor').addEventListener('change', e => {
  const inp = e.target, h = habit(inp.closest('.hed').dataset.id);
  if (inp.dataset.f === 'name') { const v = inp.value.trim(); if (v) h.name = v; else inp.value = h.name; }
  if (inp.dataset.f === 't') {
    const v = parseInt(inp.value, 10);
    h.targets[+inp.dataset.i] = v > 0 ? Math.min(v, 720) : null;
  }
  save(); pend('habits', h.id); render();
});

document.getElementById('newHabitForm').addEventListener('submit', e => {
  e.preventDefault();
  const inp = document.getElementById('newHabitName'), name = inp.value.trim();
  if (!name) return;
  const nh = blankHabit(name, Math.max(0, ...S.habits.map(h => h.order)) + 1);
  S.habits.push(nh);
  inp.value = '';
  save(); pend('habits', nh.id); renderSettings(); render();
});

document.getElementById('addForm').addEventListener('submit', e => {
  e.preventDefault();
  const min = parseInt(document.getElementById('addMin').value, 10);
  const hid = document.getElementById('addHabit').value;
  if (!(min > 0) || !hid) return;
  // a past-day session gets noon as its time; today's gets now
  const at = openDay === dayKey(new Date()) ? new Date() : (() => { const d = fromKey(openDay); d.setHours(12); return d; })();
  addSession(hid, openDay, Math.min(min, 720), at.toISOString());
  document.getElementById('addMin').value = '';
  renderDay(); render();
});

document.getElementById('openSettings').onclick = showSettings;
document.getElementById('prevWeek').onclick = () => { weekOffset--; renderWeek(); };
document.getElementById('nextWeek').onclick = () => { if (weekOffset < 0) weekOffset++; renderWeek(); };

// close sheets by tapping the backdrop
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
}

// ---------- export / import ----------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
document.getElementById('exportJson').onclick = () =>
  download('woodshed-backup-' + dayKey(new Date()) + '.json', JSON.stringify(S, null, 2), 'application/json');
document.getElementById('exportCsv').onclick = () => {
  const rows = [['date', 'habit', 'minutes', 'logged_at']].concat(
    S.sessions.filter(s => !s.deleted).sort((a, b) => a.date.localeCompare(b.date))
      .map(s => [s.date, (habit(s.habit) || { name: s.habit }).name, s.minutes, s.at]));
  download('woodshed-sessions-' + dayKey(new Date()) + '.csv',
    rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n'), 'text/csv');
};
document.getElementById('importJson').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.v !== 1 || !Array.isArray(data.habits) || !Array.isArray(data.sessions)) throw new Error('bad file');
    if (!confirm('Replace everything on this device with this backup?')) return;
    S = data; save(); if (window.Sync) { Sync.pendAll(); Sync.schedule(300); } renderSettings(); render();
    toast('Backup imported');
  } catch (err) { toast('That file isn’t a Woodshed backup'); }
  e.target.value = '';
});

// ---------- live clock + day rollover ----------
let lastKey = dayKey(new Date());
setInterval(() => {
  const k = dayKey(new Date());
  if (k !== lastKey) { lastKey = k; render(); return; }
  if (S.timer) {
    const el = document.querySelector('[data-live]');
    if (el) el.textContent = clock(Math.floor((Date.now() - S.timer.start) / 1000));
  }
}, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { S = load(); render(); } });

render();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // when an update takes over, reload once so the new version shows right away
  const hadWorker = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadWorker && !reloaded) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}
