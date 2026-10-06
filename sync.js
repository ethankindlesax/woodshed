// Woodshed sync — keeps this device and your Supabase database in step.
// The app always works from local data; this pushes local changes up and pulls other devices' changes down.
'use strict';
(function () {
  const SKEY = 'woodshed.sync';
  const BASE = WOODSHED_CONFIG.url.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const APIKEY = WOODSHED_CONFIG.key;
  const TABLES = ['habits', 'sessions', 'marks'];

  function blank() { return { auth: null, cursor: null, pending: { habits: {}, sessions: {}, marks: {} }, last: null, error: null, seq: 0 }; }
  function loadZ() {
    try { const z = JSON.parse(localStorage.getItem(SKEY)); if (z && z.pending) return z; } catch (e) { /* fresh */ }
    return blank();
  }
  let Z = loadZ();
  function saveZ() { try { localStorage.setItem(SKEY, JSON.stringify(Z)); } catch (e) { /* storage full or blocked */ } }
  function saveLocal() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } }

  // ---------- pending changes ----------
  function pend(t, id) { Z.pending[t][id] = ++Z.seq; saveZ(); schedule(); }
  function pendAll() {
    S.habits.forEach(h => { Z.pending.habits[h.id] = ++Z.seq; });
    S.sessions.forEach(s => { Z.pending.sessions[s.id] = ++Z.seq; });
    Object.keys(S.marks).forEach(k => { Z.pending.marks[k] = ++Z.seq; });
    saveZ();
  }
  const pendingCount = () => TABLES.reduce((n, t) => n + Object.keys(Z.pending[t]).length, 0);

  // ---------- http ----------
  async function api(path, opts, auth) {
    opts = opts || {};
    const headers = Object.assign({ apikey: APIKEY, 'Content-Type': 'application/json' }, opts.headers || {});
    if (auth !== false) headers.Authorization = 'Bearer ' + Z.auth.access_token;
    const r = await fetch(BASE + path, Object.assign({}, opts, { headers }));
    const txt = await r.text();
    let body = null;
    try { body = txt ? JSON.parse(txt) : null; } catch (e) { body = txt; }
    if (!r.ok) {
      const msg = body && (body.msg || body.message || body.error_description || body.error);
      const err = new Error(msg || 'HTTP ' + r.status);
      err.status = r.status;
      throw err;
    }
    return body;
  }

  // ---------- auth ----------
  function setAuth(b) {
    Z.auth = {
      access_token: b.access_token, refresh_token: b.refresh_token,
      expires_at: Date.now() + (b.expires_in || 3600) * 1000,
      user: { id: b.user.id, email: b.user.email }
    };
    saveZ();
  }
  async function refresh() {
    const b = await api('/auth/v1/token?grant_type=refresh_token',
      { method: 'POST', body: JSON.stringify({ refresh_token: Z.auth.refresh_token }) }, false);
    setAuth(b);
  }
  async function signIn(email, password) {
    const b = await api('/auth/v1/token?grant_type=password',
      { method: 'POST', body: JSON.stringify({ email, password }) }, false);
    setAuth(b);
    Z.cursor = null; Z.error = null; saveZ();
    await sync();
  }
  async function signUp(email, password) {
    const b = await api('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email, password }) }, false);
    if (b && b.access_token) { setAuth(b); Z.cursor = null; saveZ(); await sync(); return 'in'; }
    return 'confirm';
  }
  function signOut() { Z.auth = null; Z.cursor = null; Z.error = null; saveZ(); renderSync(); }

  // ---------- local <-> row ----------
  const me = () => Z.auth.user.id;
  const getLocal = {
    habits: id => S.habits.find(h => h.id === id),
    sessions: id => S.sessions.find(s => s.id === id),
    marks: id => (id in S.marks ? { id } : null)
  };
  const toRow = {
    habits: h => ({ user_id: me(), id: h.id, name: h.name, ord: h.order, retired: !!h.retired, targets: h.targets, deleted: false }),
    sessions: s => ({ user_id: me(), id: s.id, habit: s.habit, date: s.date, minutes: s.minutes, at: s.at || null, deleted: !!s.deleted }),
    marks: m => ({ user_id: me(), id: m.id, value: S.marks[m.id] == null ? null : S.marks[m.id] })
  };
  function apply(t, row) {
    if (Z.pending[t][row.id]) return; // local edit not pushed yet wins
    if (t === 'habits') {
      if (row.deleted) { S.habits = S.habits.filter(h => h.id !== row.id); return; }
      const v = { id: row.id, name: row.name, order: row.ord, retired: row.retired, targets: row.targets };
      const h = S.habits.find(x => x.id === row.id);
      h ? Object.assign(h, v) : S.habits.push(v);
    } else if (t === 'sessions') {
      const v = { id: row.id, habit: row.habit, date: row.date, minutes: row.minutes, at: row.at, deleted: row.deleted };
      const s = S.sessions.find(x => x.id === row.id);
      if (s) Object.assign(s, v); else if (!row.deleted) S.sessions.push(v);
    } else {
      S.marks[row.id] = row.value;
    }
  }

  // first sign-in on a device: fold local habits into same-named habits already on the server
  function firstMerge(rows) {
    const server = rows.habits.filter(h => !h.deleted);
    const serverIds = new Set(server.map(h => h.id));
    const used = new Set();
    for (const h of [...S.habits]) {
      if (serverIds.has(h.id)) continue;
      const match = server.find(x => !used.has(x.id) && x.name.trim().toLowerCase() === h.name.trim().toLowerCase());
      if (!match) continue;
      used.add(match.id);
      S.sessions.forEach(s => { if (s.habit === h.id) s.habit = match.id; });
      for (const k of Object.keys(S.marks)) {
        const [d, hid] = k.split('|');
        if (hid !== h.id) continue;
        const nk = d + '|' + match.id;
        if (!(nk in S.marks)) S.marks[nk] = S.marks[k];
        delete S.marks[k];
      }
      if (S.timer && S.timer.habit === h.id) S.timer.habit = match.id;
      S.habits = S.habits.filter(x => x.id !== h.id);
    }
  }

  // ---------- push / pull ----------
  async function push() {
    for (const t of TABLES) {
      const snap = Object.entries(Z.pending[t]);
      if (!snap.length) continue;
      const rows = snap.map(([id]) => getLocal[t](id)).filter(Boolean).map(toRow[t]);
      for (let i = 0; i < rows.length; i += 500) {
        await api('/rest/v1/' + t + '?on_conflict=user_id,id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows.slice(i, i + 500))
        });
      }
      // clear only what we sent; anything changed mid-push stays pending
      for (const [id, n] of snap) if (Z.pending[t][id] === n) delete Z.pending[t][id];
    }
    saveZ();
  }
  async function pull(since) {
    const out = {};
    for (const t of TABLES) {
      out[t] = [];
      for (let off = 0; ; off += 1000) {
        const q = '/rest/v1/' + t + '?select=*&order=updated_at.asc&limit=1000&offset=' + off +
          (since ? '&updated_at=gt.' + encodeURIComponent(since) : '');
        const page = await api(q, { method: 'GET' });
        out[t].push(...page);
        if (page.length < 1000) break;
      }
    }
    return out;
  }
  function newest(rows, prev) {
    let m = prev ? new Date(prev).getTime() : 0;
    for (const t of TABLES) for (const r of rows[t]) m = Math.max(m, new Date(r.updated_at).getTime());
    return m ? new Date(m).toISOString() : null;
  }

  // ---------- sync loop ----------
  let timer = null, busy = false, again = false;
  function schedule(ms) {
    if (!Z.auth) return;
    clearTimeout(timer);
    timer = setTimeout(sync, ms == null ? 1500 : ms);
  }
  async function sync(retried) {
    if (!Z.auth) return;
    if (busy) { again = true; return; }
    if (!navigator.onLine) { renderSync(); return; }
    busy = true; setDot('busy');
    try {
      if (Z.auth.expires_at - 60000 < Date.now()) await refresh();
      if (!Z.cursor) {
        const rows = await pull(null);
        firstMerge(rows);
        pendAll();
        TABLES.forEach(t => rows[t].forEach(r => apply(t, r)));
        saveLocal(); render();
        await push();
        Z.cursor = newest(rows) || new Date(0).toISOString();
      } else {
        await push();
        // re-read a 5-minute overlap so a slow write from another device is never skipped
        const since = new Date(new Date(Z.cursor).getTime() - 5 * 60000).toISOString();
        const rows = await pull(since);
        TABLES.forEach(t => rows[t].forEach(r => apply(t, r)));
        Z.cursor = newest(rows, Z.cursor);
        saveLocal(); render();
      }
      Z.last = Date.now(); Z.error = null;
    } catch (e) {
      if (e.status === 401 && !retried && Z.auth) {
        busy = false;
        try { await refresh(); await sync(true); return; }
        catch (e2) { Z.auth = null; Z.cursor = null; Z.error = 'Signed out. Sign in again to keep syncing.'; }
      } else if (e instanceof TypeError) {
        Z.error = 'Offline. Will sync when you’re back online.';
      } else {
        Z.error = e.message;
      }
    } finally {
      busy = false; saveZ(); renderSync();
      if (again) { again = false; schedule(300); }
    }
  }

  // ---------- UI ----------
  function setDot(state) {
    const d = document.getElementById('syncDot');
    if (d) d.className = 'syncdot ' + state;
  }
  function renderSync() {
    const box = document.getElementById('syncBox');
    const n = pendingCount();
    setDot(!Z.auth ? 'off' : Z.error ? 'err' : n ? 'busy' : 'ok');
    if (!box) return;
    const err = Z.error ? '<p class="syncerr">' + esc(Z.error) + '</p>' : '';
    if (!Z.auth) {
      box.innerHTML =
        '<p class="hint">Sign in on each device to keep your phone and Mac in step. Your logs on this device are kept and uploaded.</p>' + err +
        '<form id="authForm" class="authform">' +
          '<input id="authEmail" type="email" autocomplete="username" placeholder="Email" aria-label="Email" required>' +
          '<input id="authPw" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" minlength="6" required>' +
          '<div class="fields"><button class="solid" type="submit">Sign in</button>' +
          '<button class="line" type="button" data-sync="signup">Create account</button></div>' +
        '</form>';
      return;
    }
    const when = Z.last ? new Date(Z.last).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'not yet';
    box.innerHTML =
      '<p class="hint">Signed in as <b>' + esc(Z.auth.user.email) + '</b><br>Last synced ' + when +
      (n ? ' · ' + n + ' change' + (n === 1 ? '' : 's') + ' waiting' : '') + '</p>' + err +
      '<div class="fields wrap"><button class="line" data-sync="now">Sync now</button>' +
      '<button class="line" data-sync="out">Sign out</button></div>';
  }
  async function withForm(fn) {
    const email = document.getElementById('authEmail').value.trim();
    const pw = document.getElementById('authPw').value;
    if (!email || pw.length < 6) { Z.error = 'Enter your email and a password of 6+ characters.'; renderSync(); return; }
    try { await fn(email, pw); }
    catch (e) { Z.error = e.status === 400 ? 'Wrong email or password, or the email isn’t confirmed yet.' : e.message; saveZ(); renderSync(); }
  }
  document.addEventListener('submit', e => {
    if (e.target.id !== 'authForm') return;
    e.preventDefault();
    withForm(signIn);
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-sync]');
    if (!b) return;
    const a = b.dataset.sync;
    if (a === 'now') sync();
    if (a === 'out') { if (confirm('Sign out? Your logs stay on this device.')) signOut(); }
    if (a === 'signup') withForm(async (email, pw) => {
      const r = await signUp(email, pw);
      if (r === 'confirm') { Z.error = null; saveZ(); renderSync(); toast('Check your email to confirm, then sign in here'); }
    });
  });

  window.addEventListener('online', () => schedule(200));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(400); });
  setInterval(() => { if (!document.hidden) schedule(0); }, 60000);

  window.Sync = { pend, pendAll, schedule, renderSync };
  renderSync();
  schedule(300);
})();
