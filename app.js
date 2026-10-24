// Woodshed — habit hours tracker. Plain JS, no build step, data saved on this device.
'use strict';

const KEY = 'woodshed.v1';
const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DEFAULT_HABITS = ['Sax', 'Piano', 'Production', 'Writing', 'Gym', 'Run'];

// ---------- storage (swap this section for a sync backend later) ----------
// Old fields (targets, marks, timer) stay in the data so older backups and sync keep working; the app no longer uses them.
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
const fmtTime = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();

function fm(m) {
  m = Math.round(m);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + (m % 60 ? pad(m % 60) : '');
}

// ---------- data helpers ----------
const active = () => S.habits.filter(h => !h.retired).sort((a, b) => a.order - b.order);
const habit = id => S.habits.find(h => h.id === id);
function minutesMap() {
  const mm = {};
  for (const s of S.sessions) if (!s.deleted) mm[s.habit + '|' + s.date] = (mm[s.habit + '|' + s.date] || 0) + s.minutes;
  return mm;
}

// ---------- streaks ----------
// a day counts once any time is logged for that habit
// days: logged days in a row, ending today (or yesterday while today is still open)
// weeks: Mon–Sun weeks in a row that hold 3+ logged days in a row
const STREAK_MIN_DAYS = 3;
function streaks(h, mm) {
  const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const st = d => (mm[h.id + '|' + dayKey(d)] || 0) > 0;
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
  if (r.days >= STREAK_MIN_DAYS) out.push('<span class="sk' + (r.todayDone ? '' : ' open') + '" title="' + (r.todayDone ? 'Logged today' : 'Log today to keep it') + '">' + r.days + ' days</span>');
  if (r.weeks) out.push('<span class="sk wk">' + r.weeks + ' wk' + (r.weeks > 1 ? 's' : '') + '</span>');
  return out.join('');
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
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  hide: '<svg viewBox="0 0 24 24"><path d="M4 12h16"/></svg>',
  show: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'
};
// rubber stamps for the calendar, picked from the habit's name (any habit works; unknown names get a check)
const STAMP = {
  sax: '<path d="M2.6 4.4 8.4 3.2c1.4-.3 2.5.7 2.5 2" stroke-width="2"/><path d="M10.9 5.4v10.2a3.7 3.7 0 0 0 7.4 0V11" stroke-width="3.8"/><path d="M15.2 8.4h6.2l-1.5 3.1h-3.2z" fill="currentColor" stroke="none"/><g class="hole" stroke="none"><circle cx="10.9" cy="8.2" r=".9"/><circle cx="10.9" cy="11.1" r=".9"/><circle cx="10.9" cy="14" r=".9"/></g>',
  piano: '<rect x="2.5" y="5" width="19" height="14" rx="1" fill="currentColor" stroke="none"/><g class="hole" stroke="none"><rect x="4" y="12.6" width="3.2" height="5" rx=".3"/><rect x="8.2" y="12.6" width="3.2" height="5" rx=".3"/><rect x="12.6" y="12.6" width="3.2" height="5" rx=".3"/><rect x="16.8" y="12.6" width="3.2" height="5" rx=".3"/><rect x="4" y="6.4" width="2.2" height="5.4"/><rect x="9.3" y="6.4" width="2.2" height="5.4"/><rect x="12.5" y="6.4" width="2.2" height="5.4"/><rect x="17.8" y="6.4" width="2.2" height="5.4"/></g>',
  muscle: '<g transform="rotate(-32 12 12)"><path d="M7 12h10" stroke-width="2.8"/><g fill="currentColor" stroke="none"><rect x="2.4" y="6.6" width="2.8" height="10.8" rx=".7"/><rect x="5.5" y="8.3" width="2.2" height="7.4" rx=".6"/><rect x="16.3" y="8.3" width="2.2" height="7.4" rx=".6"/><rect x="18.8" y="6.6" width="2.8" height="10.8" rx=".7"/></g></g>',
  clef: '<path d="M8.6 17.2V6.6l10.2-2.8v10.8" stroke-width="2"/><path d="M8.6 6.6l10.2-2.8v3l-10.2 2.8z" fill="currentColor" stroke="none"/><g fill="currentColor" stroke="none"><ellipse cx="6.2" cy="17.4" rx="2.9" ry="2.1" transform="rotate(-22 6.2 17.4)"/><ellipse cx="16.4" cy="14.8" rx="2.9" ry="2.1" transform="rotate(-22 16.4 14.8)"/></g>',
  phones: '<path d="M4.6 14.5V12a7.4 7.4 0 0 1 14.8 0v2.5" stroke-width="2.6"/><g fill="currentColor" stroke="none"><rect x="2.6" y="13" width="5" height="8" rx="1.6"/><rect x="16.4" y="13" width="5" height="8" rx="1.6"/></g><g class="hole" stroke="none"><rect x="4" y="15" width="2.2" height="4" rx=".6"/><rect x="17.8" y="15" width="2.2" height="4" rx=".6"/></g>',
  shoe: '<path d="M6.5 18.5v-7c0-.6.6-1 1.2-.8 1.8.6 3.3.2 4.1-1.6l.5-1c.2-.4.7-.6 1.1-.3 2 1.6 3.8 3.8 6.4 4.6 1.4.5 2.2 1.6 2.2 3.1v3z" fill="currentColor" stroke="none"/><path d="M6.5 16.6h15.4" class="hole-line" stroke-width="1.3"/><path d="M12.4 11.2l1.6-1.4M14.2 12.6l1.6-1.4" class="hole-line" stroke-width="1.2"/><path d="M1 10.5h3.6M.4 13.5h3.8M1.4 16.5h3" stroke-width="1.8"/>',
  check: '<path d="M12 2.6l2.7 6.1 6.6.6-5 4.4 1.5 6.5L12 16.8l-5.8 3.4 1.5-6.5-5-4.4 6.6-.6z" fill="currentColor" stroke="none"/>'
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
// sleeve-style block: outline under an hour, solid blue from 1h, solid orange from 2h.
// the art grows with the hours (2h+ is cropped off the edge like a cover photo), and each cell gets its own angle and crop.
function stamp(h, key, m) {
  const lv = m >= 120 ? 3 : m >= 60 ? 2 : 1, r = tilt(key + h.id);
  const scale = [0, .66, .92, 1.55][lv];
  const dx = lv === 3 ? (r % 2 ? 3.5 : -3.5) : lv === 2 ? r / 6 : 0, dy = lv === 3 ? 3 : lv === 2 ? -r / 9 : 0;
  const rot = lv === 1 ? 0 : r * (lv === 3 ? 2 : 1);
  return '<span class="stamp lv' + lv + '"><svg viewBox="0 0 24 24"><g transform="translate(' + (12 + dx) + ' ' + (12 + dy) + ') rotate(' + rot + ') scale(' + scale + ') translate(-12 -12)">' +
    STAMP[stampFor(h.name)] + '</g></svg></span><i class="amt">' + fm(m) + '</i>';
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let weekOffset = 0;
let fresh = null; // cell that was just stamped, so it gets the thunk animation once

function render() { renderWeek(); }

function renderWeek() {
  const now = new Date(), todayKey = dayKey(now);
  const mon = addDays(monday(now), weekOffset * 7);
  const days = [...Array(7)].map((_, i) => addDays(mon, i));
  const keys = days.map(dayKey);
  const mm = minutesMap();
  const sun = days[6];
  const range = mon.getMonth() === sun.getMonth()
    ? mon.getDate() + '–' + sun.getDate() + ' ' + sun.toLocaleDateString('en-GB', { month: 'short' })
    : mon.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' – ' + sun.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  document.getElementById('weekLabel').textContent = weekOffset === 0 ? 'This week' : weekOffset === -1 ? 'Last week' : range;
  document.getElementById('nextWeek').style.visibility = weekOffset < 0 ? 'visible' : 'hidden';

  // header: the shown week's total, printed big
  const hs = active();
  let weekMin = 0, todayMin = 0;
  for (const h of hs) {
    keys.forEach(k => { weekMin += mm[h.id + '|' + k] || 0; });
    todayMin += mm[h.id + '|' + todayKey] || 0;
  }
  const big = weekMin ? fm(weekMin) : '0h';
  for (const s of document.querySelectorAll('#big span')) s.textContent = big;
  document.getElementById('big').setAttribute('aria-label', fm(weekMin) + ' this week');
  document.getElementById('kick').textContent = 'Vol. ' + isoWeek(mon) + ' · ' + range;
  document.getElementById('sub').innerHTML = fmtDate(now) + ' · <b>' + fm(todayMin) + '</b> today';

  let g = '<div class="dayrow">' + days.map((d, i) =>
    '<div class="dh' + (keys[i] === todayKey ? ' t' : '') + '">' + DAYS[i] + '<small>' + d.getDate() + '</small></div>'
  ).join('') + '</div>';

  if (!hs.length) g += '<p class="empty">No habits yet. <button data-act="settings">Add one</button></p>';
  for (const h of hs) {
    let wk = 0;
    const cells = keys.map((k, i) => {
      const m = mm[h.id + '|' + k] || 0;
      wk += m;
      const tc = k === todayKey ? ' tc' : '';
      if (k > todayKey) return '<div class="c fut" aria-hidden="true"></div>';
      const lbl = esc(h.name) + ', ' + fmtDate(days[i]) + ': ' + (m ? fm(m) : 'nothing yet');
      const fr = fresh === h.id + '|' + k ? ' fresh' : '';
      return '<button class="c' + (m ? ' ok' : '') + tc + fr + '" data-act="cell" data-id="' + h.id + '" data-day="' + k + '" aria-label="' + lbl + '">' +
        (m ? stamp(h, k, m) : '') + '</button>';
    }).join('');
    g += '<div class="hrow"><div class="hl"><span class="hn">' + esc(h.name) + '</span>' + streakTags(h, mm) +
      '<span class="tot">' + (wk ? fm(wk) : '') + '</span></div><div class="cells">' + cells + '</div></div>';
  }
  document.getElementById('grid').innerHTML = g;
  fresh = null;
}

// ---------- cell sheet: log time for one habit on one day ----------
let openCell = null;
function showCell(habitId, key) {
  openCell = { habit: habitId, day: key };
  renderCell();
  const dlg = document.getElementById('cellDialog');
  if (!dlg.open) dlg.showModal();
}
function renderCell() {
  const h = habit(openCell.habit), key = openCell.day;
  const ss = S.sessions.filter(s => !s.deleted && s.habit === h.id && s.date === key);
  const m = ss.reduce((a, s) => a + s.minutes, 0);
  document.getElementById('cellTitle').textContent = h.name;
  document.getElementById('cellSub').textContent = fmtDate(fromKey(key)) + (m ? ' · ' + fm(m) + ' logged' : '');
  document.getElementById('cellList').innerHTML = ss.map(s => {
    const at = new Date(s.at);
    return '<div class="sess"><span>' + fm(s.minutes) + (isNaN(at) ? '' : ' · ' + fmtTime(at)) + '</span><button data-act="del" data-sid="' + s.id + '" aria-label="Delete this session">' + ICON.x + '</button></div>';
  }).join('');
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
    '</div>'
  ).join('');
}

// ---------- events ----------
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'cell') showCell(b.dataset.id, b.dataset.day);
  else if (act === 'add') {
    const { habit: hid, day } = openCell, min = +b.dataset.min;
    // a past-day session gets noon as its time; today's gets now
    const at = day === dayKey(new Date()) ? new Date() : (() => { const d = fromKey(day); d.setHours(12); return d; })();
    const s = addSession(hid, day, min, at.toISOString());
    document.getElementById('cellDialog').close();
    fresh = hid + '|' + day;
    toast('+' + fm(min) + ' ' + habit(hid).name, () => { removeSession(s.id); render(); });
    render();
  }
  else if (act === 'del') {
    const s = S.sessions.find(x => x.id === b.dataset.sid);
    removeSession(b.dataset.sid);
    toast('Session deleted', () => { s.deleted = false; save(); pend('sessions', s.id); render(); });
    renderCell(); render();
  }
  else if (act === 'settings') showSettings();
  else if (act === 'move' || act === 'retire') {
    const hid = b.closest('.hed').dataset.id, h = habit(hid);
    pend('habits', h.id);
    if (act === 'retire') { h.retired = !h.retired; if (!h.retired) h.order = Math.max(0, ...S.habits.map(x => x.order)) + 1; }
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

// ---------- day rollover ----------
let lastKey = dayKey(new Date());
setInterval(() => {
  const k = dayKey(new Date());
  if (k !== lastKey) { lastKey = k; render(); }
}, 30000);
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
