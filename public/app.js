'use strict';
(() => {
  const state = { me: null, portalName: 'SCM SERVICE PORTAL', staffTypes: ['Operations', 'Facility'], priorities: ['Low', 'Medium', 'High', 'Urgent'], notes: [], filters: { status: '', category: '', q: '' }, formFilter: { q: '', cat: '' } };
  const FULL = ['admin', 'supervisor', 'client'];
  const ROLE_LABEL = { admin: 'Admin', supervisor: 'Supervisor', client: 'Client', staff: 'Staff' };
  const STATUSES = ['New', 'Assigned', 'In Progress', 'Resolved', 'Closed'];
  const root = document.getElementById('root');

  /* ---------- helpers ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let value;
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') value = v;
      else if (['checked', 'disabled', 'selected'].includes(k)) el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat(Infinity)) { if (k == null || k === false) continue; el.append(k.nodeType ? k : document.createTextNode(String(k))); }
    if (value !== undefined) el.value = value;
    return el;
  }
  const fmt = (d) => new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const cls = (s) => String(s).replace(/\s+/g, '');
  async function api(url, method = 'GET', body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401 && state.me) { state.me = null; showLogin('Your session ended. Sign in again.'); }
      throw new Error(d.error || 'Request failed.');
    }
    return d;
  }
  function toast(msg, isErr) {
    const t = h('div', { class: 'toast' + (isErr ? ' err' : ''), role: 'status' }, msg);
    document.body.append(t); setTimeout(() => t.remove(), 3200);
  }
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  function modal(title, content, buttons) {
    const err = h('p', { class: 'error', role: 'alert' });
    const close = () => { ov.remove(); document.removeEventListener('keydown', esc); };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    const ov = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === ov) close(); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h2', null, title), content, err,
        h('div', { class: 'row end' }, buttons.map((b) => h('button', {
          type: 'button', class: 'btn ' + (b.kind || ''),
          onclick: async (e) => {
            if (b.close) return close();
            err.textContent = ''; e.target.disabled = true;
            try { if ((await b.run()) !== false) close(); } catch (x) { err.textContent = x.message; }
            e.target.disabled = false;
          },
        }, b.label)))));
    document.addEventListener('keydown', esc);
    document.body.append(ov);
    const first = ov.querySelector('input,select,textarea'); if (first) first.focus();
    return close;
  }
  const field = (label, input, hint) => h('div', { class: 'field' }, h('label', null, label, input), hint && h('span', { class: 'muted small' }, hint));
  // label wraps input so clicking the label focuses it
  const fld = (label, input, hint) => h('div', { class: 'field' }, h('label', { class: 'lbl' }, label), input, hint && h('span', { class: 'muted small' }, hint));
  const opts = (list, sel) => list.map((o) => h('option', { value: o, selected: o === sel }, o));
  function confirmBox(title, text, label, run) {
    modal(title, h('p', null, text), [{ label: 'Cancel', close: true }, { label, kind: 'danger', run }]);
  }

  /* ---------- login ---------- */
  function showLogin(msg) {
    document.title = state.portalName;
    const err = h('p', { class: 'error', role: 'alert' }, msg || '');
    const u = h('input', { type: 'text', id: 'lu', autocomplete: 'username', required: true });
    const p = h('input', { type: 'password', id: 'lp', autocomplete: 'current-password', required: true });
    const form = h('form', { class: 'login-card', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try { await api('/api/login', 'POST', { username: u.value, password: p.value }); await boot(); } catch (x) { err.textContent = x.message; p.value = ''; p.focus(); }
    } },
    h('h2', null, 'Sign in'),
    h('div', { class: 'field' }, h('label', { for: 'lu' }, 'Username'), u),
    h('div', { class: 'field' }, h('label', { for: 'lp' }, 'Password'), p),
    err, h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'));
    root.replaceChildren(h('div', { class: 'login-wrap' },
      h('div', { class: 'login-side' }, h('div', { class: 'stripe' }),
        h('div', null, h('h1', null, state.portalName), h('p', null, 'Open your forms, register complaints and follow them through to resolution.')),
        h('span', { class: 'muted small' }, 'Accounts are created by the administrator.')),
      h('div', { class: 'login-main' }, form)));
    u.focus();
  }

  /* ---------- shell & routing ---------- */
  const isAdmin = () => state.me.role === 'admin';
  const navItems = () => [
    ['#/forms', 'Forms'], ['#/complaints', 'Complaints'],
    ...(isAdmin() ? [['sec', 'Administration'], ['#/manage', 'Manage forms'], ['#/users', 'Users']] : []),
  ];
  function shell() {
    const main = h('main', { class: 'main', id: 'main' });
    const nav = h('nav', { class: 'nav', 'aria-label': 'Main' });
    root.replaceChildren(h('div', { class: 'shell' },
      h('aside', { class: 'side' },
        h('div', { class: 'brand' }, state.portalName),
        nav,
        h('div', { class: 'me' }, h('strong', null, state.me.name), h('span', null, ROLE_LABEL[state.me.role] + (state.me.role === 'staff' ? ' · ' + state.me.staffType : '')),
          h('button', { type: 'button', onclick: async () => { await disablePush(); await api('/api/logout', 'POST'); state.me = null; alerts.push = false; showLogin(); } }, 'Sign out'))),
      main));
    return { main, nav };
  }
  let ui = null;
  async function route() {
    if (!state.me) return;
    if (!ui || !document.body.contains(ui.main)) ui = shell();
    const hash = location.hash || '#/forms';
    const [, page, arg] = hash.split('/');
    const current = '#/' + page;
    ui.nav.replaceChildren(...navItems().map(([href, label]) => href === 'sec' ? h('div', { class: 'sec' }, label) : h('a', { href, 'aria-current': href === current ? 'page' : null }, label)));
    refreshIndicators();
    checkStorage();
    const pages = { forms: pageForms, complaints: pageComplaints, manage: pageManage, users: pageUsers };
    const fn = pages[page] || pageForms;
    if ((page === 'manage' || page === 'users') && !isAdmin()) { location.hash = '#/forms'; return; }
    ui.main.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try { await fn(ui.main, arg); } catch (e) { ui.main.replaceChildren(h('div', { class: 'empty-state' }, h('strong', null, 'Could not load this page'), e.message)); }
    ui.main.focus({ preventScroll: true });
    refreshIndicators();
  }
  window.addEventListener('hashchange', route);

  /* ---- admin: red warning if saving to GitHub fails ---- */
  async function checkStorage() {
    if (!state.me || !isAdmin()) return;
    let b = document.getElementById('storage-banner');
    try {
      const s = await api('/api/storage');
      if (s.enabled && !s.ok) {
        if (!b) { b = h('div', { id: 'storage-banner', class: 'storage-banner', role: 'alert' }); document.body.prepend(b); }
        b.replaceChildren(h('strong', null, 'Data is NOT being saved to GitHub. '), (s.lastError || 'Unknown error') + ' ',
          h('a', { href: '/api/backup/download', download: '' }, 'Download a backup now'));
      } else if (b) b.remove();
    } catch (e) { /* ignore */ }
  }
  setInterval(checkStorage, 30000);

  function topbar(title, sub, ...actions) {
    return h('div', { class: 'top' }, h('div', null, h('h1', null, title), sub && h('p', null, sub)), h('div', { class: 'row' }, ...actions, alertsButton(), bell()));
  }

  /* ---------- notifications ---------- */
  function bell() {
    const unread = state.notes.filter((n) => !n.read).length;
    const wrap = h('div', { class: 'bell-wrap' });
    const btn = h('button', { class: 'btn bell', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, 'Notifications', unread ? h('span', { class: 'badge' }, unread) : null);
    let drop = null;
    const closeDrop = () => { if (drop) { drop.remove(); drop = null; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', outside, true); } };
    const outside = (e) => { if (!wrap.contains(e.target)) closeDrop(); };
    btn.addEventListener('click', guard(async () => {
      if (drop) return closeDrop();
      state.notes = await api('/api/notifications');
      if (alerts.seen) state.notes.forEach((n) => alerts.seen.add(n.id));
      drop = h('div', { class: 'drop' }, state.notes.length ? state.notes.map((n) => h('button', { class: 'item' + (n.read ? '' : ' unread'), type: 'button', onclick: () => { closeDrop(); if (n.complaintId) location.hash = '#/complaints/' + n.complaintId; } },
        h('div', null, n.text), h('div', { class: 'muted small' }, fmt(n.at)))) : h('div', { class: 'empty' }, 'No notifications yet.'));
      wrap.append(drop); btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', outside, true);
      if (unread) { await api('/api/notifications/read', 'POST'); state.notes.forEach((n) => { n.read = true; }); refreshIndicators(); }
    }));
    wrap.append(btn);
    return wrap;
  }
  /* ---- alerts: count in tab title and menu, sound, pop-up ---- */
  const alerts = { seen: null, audio: null, push: false };
  const unreadCount = () => state.notes.filter((n) => !n.read).length;
  const freshComplaintIds = () => new Set(state.notes.filter((n) => !n.read && n.complaintId).map((n) => n.complaintId));
  function refreshIndicators() {
    const n = unreadCount();
    document.title = (n ? `(${n}) ` : '') + state.portalName;
    const setBadge = (host, count) => {
      if (!host) return;
      let b = host.querySelector('.badge');
      if (count) { if (!b) { b = h('span', { class: 'badge' }); host.append(b); } b.textContent = count; } else if (b) b.remove();
    };
    setBadge(document.querySelector('.bell'), n);
    setBadge(document.querySelector('.nav a[href="#/complaints"]'), freshComplaintIds().size);
  }
  function unlockAudio() {
    try {
      if (!alerts.audio) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) alerts.audio = new AC(); }
      if (alerts.audio && alerts.audio.state === 'suspended') alerts.audio.resume();
    } catch (e) { /* ignore */ }
  }
  document.addEventListener('click', unlockAudio);
  document.addEventListener('keydown', unlockAudio);
  function beep() {
    try {
      const a = alerts.audio; if (!a || a.state !== 'running') return;
      [0, 0.28].forEach((d, i) => {
        const o = a.createOscillator(), g = a.createGain(), t = a.currentTime + d;
        o.type = 'sine'; o.frequency.value = i ? 988 : 784;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
        o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + 0.26);
      });
    } catch (e) { /* ignore */ }
  }
  async function popup(n) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const opts = { body: n.text, tag: n.id, data: { complaintId: n.complaintId } };
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg && reg.showNotification) return await reg.showNotification(state.portalName, opts);
    } catch (e) { /* fall back below */ }
    try { const x = new Notification(state.portalName, opts); x.onclick = () => { window.focus(); if (n.complaintId) location.hash = '#/complaints/' + n.complaintId; x.close(); }; } catch (e) { /* ignore */ }
  }
  const b64uToBytes = (str) => Uint8Array.from(atob((str + '='.repeat((4 - str.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const sameBytes = (a, b) => a && b && a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === new Uint8Array(b)[i]);
  // Registers this phone/browser for notifications that arrive even when the portal is closed.
  async function enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('/api/push/key');
    const want = b64uToBytes(key);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameBytes(sub.options.applicationServerKey, want.buffer)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
    await api('/api/push/subscribe', 'POST', sub.toJSON());
    alerts.push = true;
    return true;
  }
  async function disablePush() {
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) await api('/api/push/unsubscribe', 'POST', { endpoint: sub.endpoint });
    } catch (e) { /* ignore */ }
  }
  function alertsButton() {
    if (!('Notification' in window) || Notification.permission !== 'default') return null;
    return h('button', { class: 'btn', type: 'button', onclick: async (e) => {
      unlockAudio();
      const btn = e.currentTarget;
      try {
        const r = await Notification.requestPermission();
        if (r !== 'granted') toast('Notifications stay off. You can allow them in the browser or phone settings.');
        else {
          let pushed = false;
          try { pushed = await enablePush(); } catch (x) { /* shown below */ }
          toast(pushed ? 'Notifications are on. You will get alerts on this device even when the portal is closed.' : 'Pop-ups are on while the portal is open. Phone alerts need the portal on a secure (https) address.');
        }
      } catch (x) { /* ignore */ }
      btn.remove();
    } }, 'Turn on notifications');
  }
  function markComplaintRead(id) {
    api('/api/notifications/read', 'POST', { complaintId: id }).then(() => { state.notes.forEach((n) => { if (n.complaintId === id) n.read = true; }); refreshIndicators(); }).catch(() => {});
  }
  async function pollNotes() {
    if (!state.me) return;
    try {
      const list = await api('/api/notifications');
      const fresh = alerts.seen ? list.filter((n) => !n.read && !alerts.seen.has(n.id)) : [];
      alerts.seen = new Set(list.map((n) => n.id));
      state.notes = list;
      refreshIndicators();
      if (fresh.length) {
        beep();
        toast(fresh.length === 1 ? fresh[0].text : `${fresh.length} new notifications`);
        if (document.hidden && !alerts.push) fresh.slice(0, 3).forEach(popup);
        if (location.hash === '#/complaints' && !document.querySelector('.modal')) route();
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------- forms page ---------- */
  async function pageForms(main) {
    const list = await api('/api/contents');
    const cats = [...new Set(list.map((c) => c.category))].sort();
    const out = h('div', { class: 'panel formlist' });
    const draw = () => {
      const q = state.formFilter.q.toLowerCase(), cat = state.formFilter.cat;
      const rows = list.filter((c) => (!cat || c.category === cat) && (!q || (c.title + ' ' + c.description).toLowerCase().includes(q)));
      out.replaceChildren(...(rows.length ? rows.map((c) => h('div', { class: 'formrow' + (c.active ? '' : ' off') },
        h('div', null, h('h3', null, c.title), c.description && h('p', null, c.description), h('p', null, h('span', { class: 'tag' }, c.category), !c.active && h('span', { class: 'tag' }, 'Hidden from users'))),
        h('a', { class: 'btn primary', href: c.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open form'))) : [
        h('div', { class: 'empty-state' }, list.length ? h('strong', null, 'No forms match your search') : [h('strong', null, 'No forms available yet'), state.me.role === 'staff' ? 'Ask the administrator to give you access to the forms you need.' : 'The administrator can add forms under Manage forms.'])]));
    };
    const search = h('input', { type: 'search', placeholder: 'Search forms', 'aria-label': 'Search forms', value: state.formFilter.q, oninput: (e) => { state.formFilter.q = e.target.value; draw(); } });
    const chips = h('div', { class: 'chips' });
    const drawChips = () => chips.replaceChildren(...['', ...cats].map((c) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(state.formFilter.cat === c), onclick: () => { state.formFilter.cat = c; drawChips(); draw(); } }, c || 'All')));
    drawChips(); draw();
    main.replaceChildren(topbar('Forms', list.length ? `${list.length} available to you` : null), h('div', { class: 'toolbar' }, search, cats.length > 1 ? chips : null), out);
  }

  /* ---------- manage forms (admin) ---------- */
  async function pageManage(main) {
    const [list, users] = await Promise.all([api('/api/contents'), api('/api/users')]);
    const staffCount = users.filter((u) => u.role === 'staff').length;
    const body = list.length ? h('div', { class: 'panel scroll' }, h('table', null,
      h('thead', null, h('tr', null, ['Form', 'Category', 'Visible', 'Staff with access', ''].map((t) => h('th', null, t)))),
      h('tbody', null, list.map((c) => h('tr', null,
        h('td', null, h('strong', null, c.title), h('div', { class: 'muted small' }, c.description || ''), h('a', { class: 'small', href: c.url, target: '_blank', rel: 'noopener noreferrer' }, 'Test link')),
        h('td', null, c.category), h('td', null, c.active ? 'Yes' : 'Hidden'),
        h('td', null, `${c.userCount} of ${staffCount}`),
        h('td', null, h('div', { class: 'actions' },
          h('button', { class: 'btn small', onclick: () => accessModal(c, users) }, 'Access'),
          h('button', { class: 'btn small', onclick: () => formModal(c) }, 'Edit'),
          h('button', { class: 'btn small danger', onclick: () => confirmBox('Delete form', `Delete "${c.title}"? Everyone loses access to it. The MS Form itself is not affected.`, 'Delete form', async () => { await api('/api/contents/' + c.id, 'DELETE'); toast('Form deleted'); route(); }) }, 'Delete'))))))))
      : h('div', { class: 'panel empty-state' }, h('strong', null, 'No forms yet'), 'Add your first MS Form to list it in the portal.');
    main.replaceChildren(topbar('Manage forms', 'Admins, supervisors and clients see every visible form. Staff see only the forms you give them access to.', h('button', { class: 'btn primary', onclick: () => formModal() }, 'Add form')),
      body);
  }
  function formModal(c) {
    const title = h('input', { type: 'text', value: c?.title || '', maxlength: 120 });
    const link = h('input', { type: 'url', value: c?.url || '', placeholder: 'https://forms.office.com/…' });
    const cat = h('input', { type: 'text', value: c?.category || '', list: 'cats', maxlength: 40, placeholder: 'e.g. Safety, HR, Inspection' });
    const desc = h('textarea', { maxlength: 400 }); desc.value = c?.description || '';
    const active = h('input', { type: 'checkbox', checked: c ? c.active : true });
    modal(c ? 'Edit form' : 'Add form', h('div', null,
      fld('Title', title), fld('MS Forms link', link, 'Paste the share link from MS Forms.'), fld('Category', cat), fld('Description', desc),
      h('label', { class: 'check' }, active, 'Show this form to users with access')),
    [{ label: 'Cancel', close: true }, { label: c ? 'Save changes' : 'Add form', kind: 'primary', run: async () => {
      const b = { title: title.value, url: link.value, category: cat.value || 'General', description: desc.value, active: active.checked };
      const saved = await api(c ? '/api/contents/' + c.id : '/api/contents', c ? 'PUT' : 'POST', b);
      toast(c ? 'Form saved' : 'Form added'); await route();
      if (!c && (await api('/api/users')).some((u) => u.role === 'staff')) accessModal(saved, await api('/api/users'));
    } }]);
  }
  async function accessModal(c, users) {
    const staff = users.filter((u) => u.role === 'staff' && u.active);
    const granted = new Set(await api(`/api/contents/${c.id}/access`));
    const boxes = staff.map((u) => ({ u, el: h('input', { type: 'checkbox', checked: granted.has(u.id) }) }));
    modal('Who can open this form', h('div', null, h('p', { class: 'muted small' }, `"${c.title}" · Supervisors and clients always see it.`),
      staff.length ? h('div', { class: 'checklist' }, boxes.map(({ u, el }) => h('label', { class: 'check' }, el, h('span', null, u.name, h('span', { class: 'muted small' }, ` · ${u.staffType}`))))) : h('p', { class: 'muted' }, 'No staff accounts yet. Create them under Users.')),
    [{ label: 'Cancel', close: true }, { label: 'Save access', kind: 'primary', run: async () => { await api(`/api/contents/${c.id}/access`, 'PUT', { userIds: boxes.filter((b) => b.el.checked).map((b) => b.u.id) }); toast('Access saved'); route(); } }]);
  }

  /* ---------- users (admin) ---------- */
  async function pageUsers(main) {
    const [users, contents] = await Promise.all([api('/api/users'), api('/api/contents')]);
    const rows = users.map((u) => h('tr', null,
      h('td', null, h('strong', null, u.name), h('div', { class: 'muted small' }, u.username)),
      h('td', null, ROLE_LABEL[u.role]), h('td', null, u.staffType || '—'),
      h('td', null, u.role === 'staff' ? `${u.contentIds.length} of ${contents.length}` : 'All'),
      h('td', null, u.active ? 'Active' : h('span', { class: 'pill s-Closed' }, 'Disabled')),
      h('td', null, h('div', { class: 'actions' },
        h('button', { class: 'btn small', onclick: () => userModal(u, contents) }, 'Edit'),
        h('button', { class: 'btn small danger', onclick: () => confirmBox('Delete user', `Delete ${u.name}? They lose access immediately. Complaints they registered stay in the portal.`, 'Delete user', async () => { await api('/api/users/' + u.id, 'DELETE'); toast('User deleted'); route(); }) }, 'Delete')))));
    const counts = ['supervisor', 'client', 'staff'].map((r) => h('span', null, h('b', null, users.filter((u) => u.role === r).length), ROLE_LABEL[r]));
    main.replaceChildren(topbar('Users', 'The built-in admin login is fixed and is not listed here.', h('a', { class: 'btn', href: '/api/export/users.csv', download: '' }, 'Download users (Excel)'), h('button', { class: 'btn', onclick: liveLinkModal }, 'Live link for Excel'), h('a', { class: 'btn', href: '/api/backup/download', download: '', title: 'Full copy of all users, forms and complaints. Keep it on your phone or in email.' }, 'Download backup'), h('button', { class: 'btn primary', onclick: () => userModal(null, contents) }, 'Add user')),
      h('div', { class: 'stats' }, counts),
      users.length ? h('div', { class: 'panel scroll' }, h('table', null, h('thead', null, h('tr', null, ['Name', 'Role', 'Staff category', 'Forms', 'Status', ''].map((t) => h('th', null, t)))), h('tbody', null, rows)))
        : h('div', { class: 'panel empty-state' }, h('strong', null, 'No users yet'), 'Create accounts for your supervisors, clients and staff.'));
  }
  function liveLinkModal() {
    const box = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
    const show = (key) => {
      const base = location.origin + '/api/export/';
      const input = (label, path) => h('div', { class: 'field' }, h('span', { class: 'lbl' }, label), h('input', { type: 'text', readonly: true, value: `${base}${path}?key=${key}`, 'aria-label': label, onfocus: (e) => e.target.select() }));
      box.replaceChildren(
        input('Complaints', 'complaints.csv'), input('Users', 'users.csv'),
        h('p', null, 'In Excel: Data > Get Data > From Other Sources > From Web. Paste a link, then Load. To refresh by itself: Data > Queries & Connections, right-click the query > Properties > Refresh every 5 minutes.'),
        h('p', { class: 'muted small' }, 'Anyone with these links can read this data, so share them only with people who should see it. Excel must be able to open the portal address. If you change the link, the old one stops working.'));
    };
    api('/api/export/info').then((i) => show(i.key)).catch((e) => box.replaceChildren(h('p', { class: 'error' }, e.message)));
    modal('Live link for Excel', box, [{ label: 'Close', close: true }, { label: 'Make new links', kind: 'danger', run: async () => { const r = await api('/api/export/regenerate', 'POST'); show(r.key); toast('New links created'); return false; } }]);
  }
  function userModal(u, contents) {
    const name = h('input', { type: 'text', value: u?.name || '', maxlength: 80 });
    const username = h('input', { type: 'text', value: u?.username || '', disabled: !!u, autocomplete: 'off', maxlength: 40 });
    const role = h('select', null, ['staff', 'supervisor', 'client'].map((r) => h('option', { value: r, selected: (u?.role || 'staff') === r }, ROLE_LABEL[r])));
    const type = h('select', null, opts(state.staffTypes, u?.staffType));
    const pw = h('input', { type: 'text', autocomplete: 'new-password', placeholder: u ? 'Leave blank to keep the current password' : 'At least 8 characters' });
    const active = h('input', { type: 'checkbox', checked: u ? u.active : true });
    const granted = new Set(u?.contentIds || []);
    const boxes = contents.map((c) => ({ c, el: h('input', { type: 'checkbox', checked: granted.has(c.id) }) }));
    const typeF = fld('Staff category', type, 'Complaints are matched to this category when assigning.');
    const accessF = h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Forms this user can open'),
      contents.length ? h('div', { class: 'checklist' }, boxes.map(({ c, el }) => h('label', { class: 'check' }, el, h('span', null, c.title, h('span', { class: 'muted small' }, ` · ${c.category}`))))) : h('p', { class: 'muted small' }, 'Add forms first, then give access.'));
    const note = h('p', { class: 'muted small' }, 'Supervisors and clients see every form automatically.');
    const sync = () => { const s = role.value === 'staff'; typeF.hidden = !s; accessF.hidden = !s; note.hidden = s; };
    role.addEventListener('change', sync); sync();
    modal(u ? 'Edit user' : 'Add user', h('div', null,
      fld('Full name', name), fld('Username', username, u ? 'Usernames cannot be changed.' : 'Letters, numbers, dots, dashes and underscores.'),
      fld('Role', role), typeF, fld(u ? 'New password' : 'Password', pw),
      u && h('label', { class: 'check' }, active, 'Account is active'), accessF, note),
    [{ label: 'Cancel', close: true }, { label: u ? 'Save changes' : 'Create user', kind: 'primary', run: async () => {
      const b = { name: name.value, role: role.value, staffType: role.value === 'staff' ? type.value : null, password: pw.value, active: active.checked, contentIds: role.value === 'staff' ? boxes.filter((x) => x.el.checked).map((x) => x.c.id) : [] };
      if (!u) b.username = username.value;
      await api(u ? '/api/users/' + u.id : '/api/users', u ? 'PUT' : 'POST', b);
      toast(u ? 'User saved' : 'User created'); route();
    } }]);
  }

  /* ---------- complaints ---------- */
  const statusPill = (s) => h('span', { class: 'pill s-' + cls(s) }, s);
  const prioPill = (p) => h('span', { class: 'pill p-' + p }, p);
  async function pageComplaints(main, id) {
    const all = await api('/api/complaints');
    const fresh = freshComplaintIds();
    const f = state.filters;
    const list = all.filter((c) => (!f.status || c.status === f.status) && (!f.category || c.category === f.category) && (!f.q || (c.ref + ' ' + c.title + ' ' + c.location).toLowerCase().includes(f.q.toLowerCase())));
    const open = all.filter((c) => c.status !== 'Closed' && c.status !== 'Resolved').length;
    const unassigned = all.filter((c) => !c.assignedTo && c.status !== 'Closed').length;
    const listEl = h('div', { class: 'panel clist' }, list.length ? list.map((c) => h('a', { class: 'citem' + (fresh.has(c.id) && c.id !== id ? ' fresh' : ''), href: '#/complaints/' + c.id, 'aria-current': c.id === id ? 'true' : null },
      h('div', { class: 'row' }, h('span', { class: 'ref' }, c.ref), statusPill(c.status), prioPill(c.priority), fresh.has(c.id) && c.id !== id && h('span', { class: 'pill newtag' }, 'New')),
      h('div', { class: 't' }, c.title),
      h('div', { class: 'muted small' }, `${c.category} · ${c.assignedToName ? 'Assigned to ' + c.assignedToName : 'Not assigned'} · ${fmt(c.createdAt)}`)))
      : h('div', { class: 'empty-state' }, all.length ? [h('strong', null, 'No complaints match these filters')] : [h('strong', null, 'No complaints yet'), 'Use Register complaint to log the first one.']));
    const detailCol = h('div', { class: 'detailcol' });
    const grid = h('div', { class: 'cgrid' + (id ? ' has-detail' : '') }, h('div', { class: 'listcol' },
      h('div', { class: 'toolbar' },
        h('input', { type: 'search', placeholder: 'Search complaints', 'aria-label': 'Search complaints', value: f.q, onchange: (e) => { f.q = e.target.value; route(); } }),
        h('select', { 'aria-label': 'Filter by status', onchange: (e) => { f.status = e.target.value; route(); } }, h('option', { value: '' }, 'All statuses'), opts(STATUSES, f.status)),
        h('select', { 'aria-label': 'Filter by category', onchange: (e) => { f.category = e.target.value; route(); } }, h('option', { value: '' }, 'All categories'), opts(state.staffTypes, f.category))), listEl), detailCol);
    if (id) {
      try { detailCol.append(await complaintDetail(id)); }
      catch (e) { detailCol.append(h('div', { class: 'panel empty-state' }, h('strong', null, 'Complaint not found'), 'It may have been removed, or it is not assigned to you.')); }
    } else detailCol.append(h('div', { class: 'panel empty-state' }, h('strong', null, 'Select a complaint'), 'Pick one from the list to see details and updates.'));
    if (id && fresh.has(id)) markComplaintRead(id);
    main.replaceChildren(topbar('Complaints', FULL.includes(state.me.role) ? `${open} open · ${unassigned} not assigned` : 'Complaints assigned to you or registered by you', h('button', { class: 'btn primary', onclick: complaintModal }, 'Register complaint'), FULL.includes(state.me.role) && h('a', { class: 'btn', href: '/api/export/complaints.csv', download: '' }, 'Download complaints (Excel)'), isAdmin() && h('button', { class: 'btn', onclick: liveLinkModal }, 'Live link for Excel')), grid);
  }
  function complaintModal() {
    const title = h('input', { type: 'text', maxlength: 120 });
    const cat = h('select', null, opts(state.staffTypes));
    const prio = h('select', null, opts(state.priorities, 'Medium'));
    const loc = h('input', { type: 'text', maxlength: 120, placeholder: 'Building, floor, room or area' });
    const desc = h('textarea', { maxlength: 3000 });
    modal('Register complaint', h('div', null, fld('Title', title, 'A short summary, e.g. "Water leak in corridor".'), fld('Category', cat, 'Operations or Facility. This decides which staff can be assigned.'),
      fld('Priority', prio), fld('Location', loc), fld('What happened?', desc)),
    [{ label: 'Cancel', close: true }, { label: 'Register complaint', kind: 'primary', run: async () => {
      const c = await api('/api/complaints', 'POST', { title: title.value, category: cat.value, priority: prio.value, location: loc.value, description: desc.value });
      toast(`${c.ref} registered`); location.hash = '#/complaints/' + c.id;
    } }]);
  }
  async function complaintDetail(id) {
    const c = await api('/api/complaints/' + id);
    const me = state.me, canManage = FULL.includes(me.role), mine = me.role === 'staff' && c.assignedTo === me.id;
    const setStatus = guard(async (s) => { await api(`/api/complaints/${id}/status`, 'POST', { status: s }); toast('Status updated'); route(); });
    let manage = null;
    if (canManage && c.status === 'Closed') {
      manage = h('div', { class: 'manage' }, h('div', { class: 'row' }, h('span', { class: 'muted' }, 'This complaint is closed.'), h('button', { class: 'btn small', onclick: () => setStatus('In Progress') }, 'Reopen')));
    } else if (canManage) {
      const staff = await api('/api/staff');
      const sel = h('select', { 'aria-label': 'Assign to staff member' }, h('option', { value: '' }, 'Choose staff member'),
        [c.category, ...state.staffTypes.filter((t) => t !== c.category)].map((t) => { const g = staff.filter((s) => s.staffType === t); return g.length ? h('optgroup', { label: t + (t === c.category ? ' (matches category)' : '') }, g.map((s) => h('option', { value: s.id, selected: s.id === c.assignedTo }, s.name))) : null; }));
      manage = h('div', { class: 'manage' },
        h('div', { class: 'row' }, h('div', { class: 'grow' }, sel),
          h('button', { class: 'btn primary', onclick: guard(async () => { if (!sel.value) throw new Error('Choose a staff member first.'); await api(`/api/complaints/${id}/assign`, 'POST', { staffId: sel.value }); toast('Complaint assigned'); route(); }) }, c.assignedTo ? 'Reassign' : 'Assign')),
        !staff.length && h('span', { class: 'muted small' }, 'There are no active staff accounts to assign yet.'),
        h('div', { class: 'row' }, c.status !== 'In Progress' && c.assignedTo && c.status !== 'Closed' && h('button', { class: 'btn small', onclick: () => setStatus('In Progress') }, 'Mark in progress'),
          c.status !== 'Resolved' && c.status !== 'Closed' && h('button', { class: 'btn small', onclick: () => setStatus('Resolved') }, 'Mark resolved'),
          c.status !== 'Closed' && h('button', { class: 'btn small', onclick: () => setStatus('Closed') }, 'Close complaint'),
          c.status === 'Closed' && h('button', { class: 'btn small', onclick: () => setStatus('In Progress') }, 'Reopen')));
    } else if (mine && c.status !== 'Closed') {
      manage = h('div', { class: 'manage' }, h('div', { class: 'row' },
        c.status !== 'In Progress' && h('button', { class: 'btn small', onclick: () => setStatus('In Progress') }, 'Start work'),
        c.status !== 'Resolved' && h('button', { class: 'btn primary small', onclick: () => setStatus('Resolved') }, 'Mark resolved')));
    }
    const note = h('textarea', { 'aria-label': 'Add a comment', placeholder: 'Add a comment or update', maxlength: 1000 });
    note.style.minHeight = '70px';
    return h('div', { class: 'panel detail' },
      h('a', { class: 'btn back', href: '#/complaints' }, 'All complaints'),
      h('div', { class: 'row' }, h('span', { class: 'ref' }, c.ref), statusPill(c.status), prioPill(c.priority)),
      h('h2', null, c.title),
      h('dl', { class: 'meta' }, [['Category', c.category], ['Location', c.location || 'Not given'], ['Registered by', `${c.createdByName}`], ['Registered on', fmt(c.createdAt)], ['Assigned to', c.assignedToName || 'Not assigned yet'], ['Last update', fmt(c.updatedAt)]].map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v)))),
      h('p', { class: 'desc' }, c.description), manage,
      h('h3', null, 'Activity'),
      h('ul', { class: 'timeline' }, c.history.map((x) => h('li', { class: x.type }, h('div', null, h('span', { class: 'who' }, x.by), h('span', { class: 'muted small' }, ` · ${ROLE_LABEL[x.byRole]} · ${fmt(x.at)}`)), h('div', { class: 'txt' }, x.text)))),
      h('div', { class: 'field' }, note, h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: guard(async () => { await api(`/api/complaints/${id}/comments`, 'POST', { text: note.value }); route(); }) }, 'Post comment'))));
  }

  /* ---------- boot ---------- */
  async function boot() {
    try {
      const me = await api('/api/me');
      state.me = me.user; state.portalName = me.portalName; state.staffTypes = me.staffTypes; state.priorities = me.priorities;
      document.title = state.portalName; ui = null;
      state.notes = await api('/api/notifications');
      alerts.seen = new Set(state.notes.map((n) => n.id));
      if ('Notification' in window && Notification.permission === 'granted') enablePush().catch(() => {});
      if (!location.hash) location.hash = '#/forms';
      await route();
    } catch (e) { state.me = null; showLogin(); }
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  setInterval(pollNotes, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollNotes(); });
  boot();
})();
