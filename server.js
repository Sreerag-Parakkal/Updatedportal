'use strict';
// Service Portal server: no external packages needed (Node 18+).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createPush } = require('./webpush');
const { createStore } = require('./github-store');

(async () => {

let cfg = {};
try { cfg = require('./config.js'); } catch (e) { /* defaults below */ }
const PORT = Number(process.env.PORT || cfg.port || 3000);
const PORTAL_NAME = cfg.portalName || 'SCM SERVICE PORTAL';
const ADMIN_USER = process.env.ADMIN_USERNAME || cfg.adminUsername || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || cfg.adminPassword || 'Admin@12345';
// Data lives OUTSIDE the program folder (in "SCM-Portal-Data" in your user folder), so installing a new
// version never touches it. Set DATA_DIR to choose another place (needed on most web hosts).
const os = require('os');
const LEGACY_DIR = path.join(__dirname, 'data');
let DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), 'SCM-Portal-Data');
if (!process.env.DATA_DIR) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(path.join(LEGACY_DIR, 'db.json')) && !fs.existsSync(path.join(DATA_DIR, 'db.json'))) {
      fs.cpSync(LEGACY_DIR, DATA_DIR, { recursive: true });
      console.log(`Moved your existing data from ${LEGACY_DIR} to ${DATA_DIR}`);
    }
  } catch (e) { DATA_DIR = LEGACY_DIR; }
}
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');


const ROLES = ['admin', 'supervisor', 'client', 'staff'];
const FULL = ['admin', 'supervisor', 'client'];
const MANAGE = ['admin', 'supervisor', 'client']; // can assign, update status and close complaints
const STAFF_TYPES = ['Operations', 'Facility'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

/* ---------- storage ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
// Permanent copy in a private GitHub repository (only when GITHUB_TOKEN and GITHUB_REPO are set).
for (const [k, v] of [['GITHUB_TOKEN', cfg.githubToken], ['GITHUB_REPO', cfg.githubRepo], ['GITHUB_BRANCH', cfg.githubBranch]]) if (v && !process.env[k]) process.env[k] = v;
const store = createStore({ dir: DATA_DIR, files: ['db.json', 'vapid.json'] });
if (store.enabled) {
  console.log('Connecting to GitHub storage...');
  await store.init(); // downloads db.json / vapid.json; stops the start-up if GitHub cannot be reached, so empty data never overwrites real data
  console.log(`GitHub storage is on (${store.status().repo}${store.status().privateRepo === false ? ' - WARNING: this repository is PUBLIC, make it private!' : ''}).`);
} else console.log('GitHub storage is OFF: data is only on this computer/disk. See README to turn it on.');
let db = { users: [], contents: [], grants: [], complaints: [], notifications: [], seq: { complaint: 0 } };
if (fs.existsSync(DB_FILE)) db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
db.pushSubs = db.pushSubs || [];
const push = createPush({ dir: DATA_DIR, contact: process.env.PUSH_CONTACT || cfg.pushContact || 'mailto:portal@example.com' });
store.changed('vapid.json'); // sends the push keys once, so they survive a disk wipe too
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
  store.changed('db.json');
}
db.settings = db.settings || {};
if (!db.settings.exportKey) { db.settings.exportKey = crypto.randomBytes(24).toString('base64url'); save(); }

// Daily backup copies in data/backups (the newest 14 are kept).
function backup() {
  try {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `db-${new Date().toISOString().slice(0, 10)}.json`);
    if (!fs.existsSync(file) && fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, file);
    const all = fs.readdirSync(dir).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    all.slice(0, Math.max(0, all.length - 14)).forEach((f) => fs.unlinkSync(path.join(dir, f)));
  } catch (e) { console.error('Backup failed: ' + e.message); }
}
backup();
setInterval(backup, 6 * 3600 * 1000).unref();

const uid = () => crypto.randomBytes(8).toString('hex');
const now = () => new Date().toISOString();

/* ---------- passwords & sessions ---------- */
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPw(pw, u) {
  const a = crypto.scryptSync(pw, u.salt, 64), b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

const sessions = new Map(); // token -> { userId, exp }
const SESSION_MS = 12 * 3600 * 1000;
const fails = new Map(); // ip -> [timestamps]

const ADMIN = { id: 'admin', username: ADMIN_USER, name: 'Administrator', role: 'admin', active: true, builtin: true };

function userById(id) {
  if (id === 'admin') return ADMIN;
  return db.users.find((u) => u.id === id && u.active) || null;
}
const pub = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, staffType: u.staffType || null, active: u.active, builtin: !!u.builtin });

/* ---------- helpers ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const forbid = () => new HttpError(403, 'You do not have access to this.');
const nf = () => new HttpError(404, 'Not found.');

function str(v, name, min, max) {
  if (typeof v !== 'string') throw bad(`${name} is required.`);
  v = v.trim();
  if (v.length < min) throw bad(min === 1 ? `${name} is required.` : `${name} must be at least ${min} characters.`);
  if (v.length > max) throw bad(`${name} must be at most ${max} characters.`);
  return v;
}
function oneOf(v, list, name) {
  if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}.`);
  return v;
}
function url(v) {
  v = str(v, 'Form link', 1, 2000);
  let u;
  try { u = new URL(v); } catch (e) { throw bad('Form link must be a full web address starting with https://'); }
  if (!['https:', 'http:'].includes(u.protocol)) throw bad('Form link must start with https://');
  return u.toString();
}
const requireRole = (user, ...roles) => { if (!roles.includes(user.role)) throw forbid(); };

function notify(userIds, text, complaintId) {
  for (const id of new Set(userIds)) {
    if (id) db.notifications.push({ id: uid(), userId: id, text, complaintId: complaintId || null, at: now(), read: false });
  }
  if (db.notifications.length > 5000) db.notifications = db.notifications.slice(-3000);
  pushTo([...new Set(userIds)].filter(Boolean), { title: PORTAL_NAME, body: text, url: complaintId ? `/#/complaints/${complaintId}` : '/', tag: complaintId || 'portal' });
}
// Phone / browser push: sends to every device the person has turned notifications on for.
function pushTo(userIds, payload) {
  for (const sub of db.pushSubs.filter((x) => userIds.includes(x.userId))) {
    push.send(sub, payload).then((status) => {
      if (status === 404 || status === 410) { db.pushSubs = db.pushSubs.filter((x) => x.endpoint !== sub.endpoint); save(); }
      else if (status >= 400) console.error(`Push to a device failed (status ${status}).`);
    }).catch((e) => console.error('Push failed: ' + e.message));
  }
}
const idsByRole = (...roles) => db.users.filter((u) => u.active && roles.includes(u.role)).map((u) => u.id);

/* ---------- access rules ---------- */
function visibleContents(user) {
  if (user.role === 'admin') return db.contents;
  if (FULL.includes(user.role)) return db.contents.filter((c) => c.active);
  const mine = new Set(db.grants.filter((g) => g.userId === user.id).map((g) => g.contentId));
  return db.contents.filter((c) => c.active && mine.has(c.id));
}
const canSeeComplaint = (user, c) => FULL.includes(user.role) || c.assignedTo === user.id || c.createdBy === user.id;
function setGrants(userId, contentIds) {
  const valid = new Set(db.contents.map((c) => c.id));
  const ids = [...new Set(contentIds)].filter((i) => valid.has(i));
  db.grants = db.grants.filter((g) => g.userId !== userId).concat(ids.map((contentId) => ({ userId, contentId })));
}

/* ---------- API routes ---------- */
const routes = [];
const route = (method, pattern, auth, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), auth, fn });

route('POST', '/api/login', false, ({ body, ip, res }) => {
  const recent = (fails.get(ip) || []).filter((t) => Date.now() - t < 10 * 60 * 1000);
  if (recent.length >= 10) throw new HttpError(429, 'Too many failed sign-in attempts. Try again in 10 minutes.');
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  let user = null;
  if (safeEq(username.toLowerCase(), ADMIN_USER.toLowerCase()) && safeEq(password, ADMIN_PASS)) user = ADMIN;
  else {
    const u = db.users.find((x) => x.username.toLowerCase() === username.toLowerCase());
    if (u) { const okPw = checkPw(password, u); if (okPw && u.active) user = u; else if (okPw) throw new HttpError(403, 'This account is disabled. Contact the administrator.'); }
    else crypto.scryptSync(password, 'x', 64); // keep timing similar
  }
  if (!user) { recent.push(Date.now()); fails.set(ip, recent); throw new HttpError(401, 'Wrong username or password.'); }
  fails.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, exp: Date.now() + SESSION_MS });
  res.setCookie(token, SESSION_MS / 1000);
  return { user: pub(user), portalName: PORTAL_NAME };
});
route('POST', '/api/logout', false, ({ token, res }) => { sessions.delete(token); res.setCookie('', 0); return { ok: true }; });
route('GET', '/api/me', true, ({ user }) => ({ user: pub(user), portalName: PORTAL_NAME, staffTypes: STAFF_TYPES, priorities: PRIORITIES }));

/* users (admin) */
route('GET', '/api/users', true, ({ user }) => {
  requireRole(user, 'admin');
  return db.users.map((u) => ({ ...pub(u), createdAt: u.createdAt, contentIds: db.grants.filter((g) => g.userId === u.id).map((g) => g.contentId) }));
});
route('GET', '/api/staff', true, ({ user }) => {
  requireRole(user, ...MANAGE);
  return db.users.filter((u) => u.role === 'staff' && u.active).map(pub);
});
function readUserFields(b, creating) {
  const out = { name: str(b.name, 'Full name', 1, 80), role: oneOf(b.role, ROLES.filter((r) => r !== 'admin' || false), 'Role') };
  if (out.role === 'staff') out.staffType = oneOf(b.staffType, STAFF_TYPES, 'Staff category'); else out.staffType = null;
  if (creating || (b.password && b.password.length)) out.password = str(b.password, 'Password', 8, 100);
  return out;
}
route('POST', '/api/users', true, ({ user, body }) => {
  requireRole(user, 'admin');
  const username = str(body.username, 'Username', 3, 40);
  if (!/^[A-Za-z0-9._-]+$/.test(username)) throw bad('Username can use letters, numbers, dots, dashes and underscores only.');
  if (username.toLowerCase() === ADMIN_USER.toLowerCase() || db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw bad('That username is already taken.');
  const f = readUserFields(body, true);
  const u = { id: uid(), username, name: f.name, role: f.role, staffType: f.staffType, active: true, createdAt: now(), ...hashPw(f.password) };
  db.users.push(u);
  if (Array.isArray(body.contentIds)) setGrants(u.id, body.contentIds);
  save();
  return pub(u);
});
route('PUT', '/api/users/:id', true, ({ user, body, params }) => {
  requireRole(user, 'admin');
  const u = db.users.find((x) => x.id === params.id); if (!u) throw nf();
  const f = readUserFields(body, false);
  u.name = f.name; u.role = f.role; u.staffType = f.staffType;
  if (typeof body.active === 'boolean') u.active = body.active;
  if (f.password) Object.assign(u, hashPw(f.password));
  if (Array.isArray(body.contentIds)) setGrants(u.id, body.contentIds);
  if (!u.active || f.password) for (const [t, s] of sessions) if (s.userId === u.id) sessions.delete(t);
  save();
  return pub(u);
});
route('DELETE', '/api/users/:id', true, ({ user, params }) => {
  requireRole(user, 'admin');
  const i = db.users.findIndex((x) => x.id === params.id); if (i < 0) throw nf();
  const id = db.users[i].id;
  db.users.splice(i, 1);
  db.grants = db.grants.filter((g) => g.userId !== id);
  db.pushSubs = db.pushSubs.filter((x) => x.userId !== id);
  for (const [t, s] of sessions) if (s.userId === id) sessions.delete(t);
  save();
  return { ok: true };
});

/* contents */
route('GET', '/api/contents', true, ({ user }) => {
  const list = visibleContents(user).map((c) => ({ ...c }));
  if (user.role === 'admin') for (const c of list) c.userCount = db.grants.filter((g) => g.contentId === c.id).length;
  return list;
});
function readContent(b) {
  return {
    title: str(b.title, 'Title', 1, 120),
    description: typeof b.description === 'string' ? str(b.description || ' ', 'Description', 0, 400) : '',
    category: str(b.category || 'General', 'Category', 1, 40),
    url: url(b.url),
    active: b.active !== false,
  };
}
route('POST', '/api/contents', true, ({ user, body }) => {
  requireRole(user, 'admin');
  const c = { id: uid(), ...readContent(body), createdAt: now() };
  db.contents.push(c); save(); return c;
});
route('PUT', '/api/contents/:id', true, ({ user, body, params }) => {
  requireRole(user, 'admin');
  const c = db.contents.find((x) => x.id === params.id); if (!c) throw nf();
  Object.assign(c, readContent(body)); save(); return c;
});
route('DELETE', '/api/contents/:id', true, ({ user, params }) => {
  requireRole(user, 'admin');
  const i = db.contents.findIndex((x) => x.id === params.id); if (i < 0) throw nf();
  db.contents.splice(i, 1);
  db.grants = db.grants.filter((g) => g.contentId !== params.id);
  save(); return { ok: true };
});
route('GET', '/api/contents/:id/access', true, ({ user, params }) => {
  requireRole(user, 'admin');
  return db.grants.filter((g) => g.contentId === params.id).map((g) => g.userId);
});
route('PUT', '/api/contents/:id/access', true, ({ user, params, body }) => {
  requireRole(user, 'admin');
  if (!db.contents.some((c) => c.id === params.id)) throw nf();
  const ids = new Set(Array.isArray(body.userIds) ? body.userIds : []);
  const valid = new Set(db.users.map((u) => u.id));
  db.grants = db.grants.filter((g) => g.contentId !== params.id)
    .concat([...ids].filter((i) => valid.has(i)).map((userId) => ({ userId, contentId: params.id })));
  save(); return { ok: true };
});

/* complaints */
const STATUS_TARGETS_MANAGER = ['In Progress', 'Resolved', 'Closed'];
const STATUS_TARGETS_STAFF = ['In Progress', 'Resolved'];
function view(c) { return c; }
function addHistory(c, user, type, text) { c.history.push({ id: uid(), at: now(), by: user.name, byRole: user.role, type, text }); c.updatedAt = now(); }

route('GET', '/api/complaints', true, ({ user }) =>
  db.complaints.filter((c) => canSeeComplaint(user, c)).map(({ history, ...rest }) => ({ ...rest, comments: history.filter((h) => h.type === 'comment').length }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
route('GET', '/api/complaints/:id', true, ({ user, params }) => {
  const c = db.complaints.find((x) => x.id === params.id);
  if (!c || !canSeeComplaint(user, c)) throw nf();
  return view(c);
});
route('POST', '/api/complaints', true, ({ user, body }) => {
  const c = {
    id: uid(),
    ref: 'CMP-' + String(++db.seq.complaint).padStart(4, '0'),
    title: str(body.title, 'Title', 3, 120),
    category: oneOf(body.category, STAFF_TYPES, 'Category'),
    priority: oneOf(body.priority || 'Medium', PRIORITIES, 'Priority'),
    location: typeof body.location === 'string' ? str(body.location || ' ', 'Location', 0, 120) : '',
    description: str(body.description, 'Description', 5, 3000),
    status: 'New',
    createdBy: user.id, createdByName: user.name, createdByRole: user.role,
    assignedTo: null, assignedToName: null,
    createdAt: now(), updatedAt: now(), history: [],
  };
  addHistory(c, user, 'created', 'Complaint registered');
  db.complaints.push(c);
  notify([...idsByRole('supervisor', 'client'), 'admin'].filter((i) => i !== user.id), `New ${c.priority.toLowerCase()} priority complaint ${c.ref}: ${c.title}`, c.id);
  save(); return view(c);
});
route('POST', '/api/complaints/:id/assign', true, ({ user, body, params }) => {
  requireRole(user, ...MANAGE);
  const c = db.complaints.find((x) => x.id === params.id); if (!c) throw nf();
  const s = db.users.find((u) => u.id === body.staffId && u.role === 'staff' && u.active);
  if (!s) throw bad('Choose an active staff member.');
  if (c.status === 'Closed') throw bad('This complaint is closed. Reopen it before assigning.');
  c.assignedTo = s.id; c.assignedToName = s.name;
  if (c.status === 'New' || c.status === 'Resolved') c.status = 'Assigned';
  addHistory(c, user, 'assigned', `Assigned to ${s.name} (${s.staffType})`);
  notify([s.id], `You were assigned ${c.ref}: ${c.title}`, c.id);
  save(); return view(c);
});
route('POST', '/api/complaints/:id/status', true, ({ user, body, params }) => {
  const c = db.complaints.find((x) => x.id === params.id);
  if (!c || !canSeeComplaint(user, c)) throw nf();
  const target = String(body.status || '');
  if (MANAGE.includes(user.role)) oneOf(target, STATUS_TARGETS_MANAGER, 'Status');
  else if (user.role === 'staff' && c.assignedTo === user.id) { oneOf(target, STATUS_TARGETS_STAFF, 'Status'); if (c.status === 'Closed') throw forbid(); }
  else throw forbid();
  if (!c.assignedTo && target === 'In Progress') throw bad('Assign this complaint to a staff member first.');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
  c.status = target;
  addHistory(c, user, 'status', `Status changed to ${target}` + (note ? `: ${note}` : ''));
  notify([...idsByRole('supervisor', 'client'), 'admin', c.createdBy].filter((i) => i !== user.id), `${c.ref} is now ${target}`, c.id);
  save(); return view(c);
});
route('POST', '/api/complaints/:id/comments', true, ({ user, body, params }) => {
  const c = db.complaints.find((x) => x.id === params.id);
  if (!c || !canSeeComplaint(user, c)) throw nf();
  addHistory(c, user, 'comment', str(body.text, 'Comment', 1, 1000));
  notify([c.assignedTo, c.createdBy, ...idsByRole('supervisor')].filter((i) => i && i !== user.id), `New comment on ${c.ref} from ${user.name}`, c.id);
  save(); return view(c);
});

/* phone / browser push */
route('GET', '/api/push/key', true, () => ({ key: push.publicKey }));
route('POST', '/api/push/subscribe', true, ({ user, body }) => {
  const endpoint = String(body.endpoint || '');
  if (!push.isAllowedEndpoint(endpoint)) throw bad('This browser uses a push service that is not supported.');
  if (!push.validKeys(body.keys)) throw bad('Invalid notification details from the browser.');
  db.pushSubs = db.pushSubs.filter((x) => x.endpoint !== endpoint);
  db.pushSubs.push({ userId: user.id, endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth }, at: now() });
  const mine = db.pushSubs.filter((x) => x.userId === user.id);
  if (mine.length > 10) db.pushSubs = db.pushSubs.filter((x) => x.userId !== user.id || mine.slice(-10).includes(x));
  save(); return { ok: true };
});
route('POST', '/api/push/unsubscribe', true, ({ user, body }) => {
  db.pushSubs = db.pushSubs.filter((x) => !(x.endpoint === body.endpoint && x.userId === user.id));
  save(); return { ok: true };
});
route('POST', '/api/push/test', true, ({ user }) => {
  const n = db.pushSubs.filter((x) => x.userId === user.id).length;
  if (!n) throw bad('Notifications are not turned on for this device yet.');
  pushTo([user.id], { title: PORTAL_NAME, body: 'Test notification. Phone alerts are working.', url: '/', tag: 'test' });
  return { devices: n };
});

/* Excel export (CSV opens in Excel; the live link lets Excel refresh it by itself) */
const TZ = cfg.timeZone || 'Asia/Dubai';
const fmtDT = (iso) => (iso ? new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '');
function csv(rows) {
  const cell = (v) => { let t = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
function exportAccess(token, query, roles) {
  const key = query.get('key');
  if (key && safeEq(key, db.settings.exportKey)) return;
  const sess = token && sessions.get(token);
  const u = sess && sess.exp > Date.now() ? userById(sess.userId) : null;
  if (u && roles.includes(u.role)) return;
  throw new HttpError(401, 'Sign in first, or use the live link from the admin page.');
}
route('GET', '/api/export/complaints.csv', false, ({ token, query }) => {
  exportAccess(token, query, FULL);
  const rows = [['Reference', 'Title', 'Category', 'Priority', 'Status', 'Location', 'Description', 'Registered by', 'Registered on', 'Assigned to', 'Closed on', 'Last update', 'Comments']];
  for (const c of [...db.complaints].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const closed = [...c.history].reverse().find((h) => h.type === 'status' && h.text.startsWith('Status changed to Closed'));
    rows.push([c.ref, c.title, c.category, c.priority, c.status, c.location, c.description, c.createdByName, fmtDT(c.createdAt), c.assignedToName || '', c.status === 'Closed' && closed ? fmtDT(closed.at) : '', fmtDT(c.updatedAt), c.history.filter((h) => h.type === 'comment').length]);
  }
  return { __file: { name: 'complaints.csv', body: csv(rows) } };
});
route('GET', '/api/export/users.csv', false, ({ token, query }) => {
  exportAccess(token, query, ['admin']);
  const title = new Map(db.contents.map((c) => [c.id, c.title]));
  const rows = [['Name', 'Username', 'Role', 'Staff category', 'Status', 'Created on', 'Forms with access']];
  for (const u of db.users) {
    const forms = u.role === 'staff' ? db.grants.filter((g) => g.userId === u.id).map((g) => title.get(g.contentId)).filter(Boolean).join('; ') : 'All forms';
    rows.push([u.name, u.username, u.role, u.staffType || '', u.active ? 'Active' : 'Disabled', fmtDT(u.createdAt), forms]);
  }
  return { __file: { name: 'users.csv', body: csv(rows) } };
});
route('GET', '/api/export/info', true, ({ user }) => { requireRole(user, 'admin'); return { key: db.settings.exportKey }; });
route('POST', '/api/export/regenerate', true, ({ user }) => {
  requireRole(user, 'admin');
  db.settings.exportKey = crypto.randomBytes(24).toString('base64url'); save();
  return { key: db.settings.exportKey };
});

/* storage status and backup (admin) */
route('GET', '/api/storage', true, ({ user }) => { requireRole(user, 'admin'); return store.status(); });
route('GET', '/api/backup/download', true, ({ user }) => {
  requireRole(user, 'admin');
  const stamp = new Date().toISOString().slice(0, 10);
  return { __file: { name: `portal-backup-${stamp}.json`, type: 'application/json; charset=utf-8', body: JSON.stringify(db, null, 1) } };
});

/* notifications */
route('GET', '/api/notifications', true, ({ user }) =>
  db.notifications.filter((n) => n.userId === user.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40));
route('POST', '/api/notifications/read', true, ({ user, body }) => {
  db.notifications.forEach((n) => { if (n.userId === user.id && (!body.complaintId || n.complaintId === body.complaintId)) n.read = true; });
  save(); return { ok: true };
});

/* ---------- http plumbing ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 100_000) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); } catch (e) { reject(bad('Invalid request.')); }
    });
    req.on('error', reject);
  });
}
function parseCookies(h) {
  const o = {}; (h || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return o;
}
function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, { ...SEC, ...headers });
  res.end(body);
}

async function handleApi(req, res, pathname) {
  const token = parseCookies(req.headers.cookie).sid;
  const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
  res.setCookie = (val, maxAge) => res.setHeader('Set-Cookie', `sid=${val}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAge)}${secure ? '; Secure' : ''}`);
  const json = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (!r) throw nf();
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw forbid();
    }
    let user = null;
    if (r.auth) {
      const s = token && sessions.get(token);
      if (!s || s.exp < Date.now()) { if (s) sessions.delete(token); throw new HttpError(401, 'Please sign in.'); }
      user = userById(s.userId);
      if (!user) { sessions.delete(token); throw new HttpError(401, 'Please sign in.'); }
      s.exp = Date.now() + SESSION_MS;
    }
    const body = req.method === 'GET' ? {} : await readBody(req);
    const params = pathname.match(r.re).groups || {};
    const out = await r.fn({ req, res, user, body, params, token, ip: req.socket.remoteAddress, query: new URL(req.url, 'http://x').searchParams });
    const h = { ...json }; const sc = res.getHeader('Set-Cookie'); if (sc) h['Set-Cookie'] = sc;
    if (out && out.__file) return send(res, 200, out.__file.type ? out.__file.body : '\ufeff' + out.__file.body, { 'Content-Type': out.__file.type || 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.__file.name}"`, 'Cache-Control': 'no-store' });
    send(res, 200, out, h);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Something went wrong on the server.' }, json);
  }
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); });

http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
  serveStatic(req, res, pathname);
}).listen(PORT, () => {
  console.log(`${PORTAL_NAME} running on http://localhost:${PORT}`);
  console.log(`Data is stored in: ${DATA_DIR}  (${db.users.length} users, ${db.complaints.length} complaints, ${db.contents.length} forms)`);
  if (ADMIN_PASS === 'Admin@12345') console.log('WARNING: default admin password in use. Change it in config.js.');
});
})().catch((e) => { console.error('\nThe portal could not start: ' + e.message); process.exit(1); });
