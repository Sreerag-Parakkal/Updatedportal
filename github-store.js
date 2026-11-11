'use strict';
// Permanent storage in a private GitHub repository (no packages needed, Node 18+).
// Local files in DATA_DIR stay the working copy; every change is also pushed to GitHub in the
// background (grouped, retried until it works). On start-up the files are pulled back from GitHub,
// so a host that wipes its disk loses nothing.
//
// Settings (environment variables):
//   GITHUB_TOKEN   fine-grained token with "Contents: Read and write" on ONE private repository
//   GITHUB_REPO    owner/name, for example  yourname/scm-portal-data
//   GITHUB_BRANCH  optional, default: the repository's default branch
//   GITHUB_FOLDER  optional, folder inside the repository, default: data
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const DEBOUNCE_MS = 3000;
const RETRY_MS = [5000, 15000, 60000, 300000]; // then every 5 minutes

function createStore({ dir, files, log = console }) {
  const token = (process.env.GITHUB_TOKEN || '').trim();
  const repo = (process.env.GITHUB_REPO || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  const enabled = !!(token && repo);
  const folder = (process.env.GITHUB_FOLDER || 'data').replace(/^\/+|\/+$/g, '');
  let branch = (process.env.GITHUB_BRANCH || '').trim();

  const st = { enabled, ok: true, ready: !enabled, lastSaved: null, lastError: null, lastErrorAt: null, pending: 0, repo: enabled ? repo : null, privateRepo: null };
  const shas = {};      // remote blob sha per file
  const pushed = {};    // hash of content last known to be on GitHub
  const dirty = new Set();
  let timer = null, running = false, attempt = 0;

  const remotePath = (name) => (folder ? folder + '/' : '') + name;
  const localPath = (name) => path.join(dir, name);
  const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

  async function gh(method, url, body, accept) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try {
      return await fetch(API + url, {
        method, signal: ctl.signal,
        headers: {
          Authorization: 'Bearer ' + token, Accept: accept || 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'scm-service-portal',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } finally { clearTimeout(t); }
  }
  async function errText(r) {
    let m = ''; try { m = (await r.json()).message || ''; } catch (e) { /* ignore */ }
    if (r.status === 401) return 'GitHub rejected the token (it may have expired or been revoked). Make a new token and update GITHUB_TOKEN.';
    if (r.status === 403 && /rate limit/i.test(m)) return 'GitHub rate limit reached; will retry.';
    if (r.status === 403) return 'The token is not allowed to write to the repository (needs Contents: Read and write).';
    if (r.status === 404) return 'Repository not found, or the token cannot see it. Check GITHUB_REPO and the token.';
    return `GitHub error ${r.status}${m ? ': ' + m : ''}`;
  }

  // Returns { content: Buffer, sha } or null when the file does not exist yet.
  async function getRemote(name) {
    const r = await gh('GET', `/repos/${repo}/contents/${remotePath(name).split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(await errText(r));
    const j = await r.json();
    let content;
    if (j.encoding === 'base64' && typeof j.content === 'string' && (j.content.length || j.size === 0)) content = Buffer.from(j.content, 'base64');
    else { // larger than 1 MB: ask for the raw file
      const raw = await gh('GET', `/repos/${repo}/contents/${remotePath(name).split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`, null, 'application/vnd.github.raw+json');
      if (!raw.ok) throw new Error(await errText(raw));
      content = Buffer.from(await raw.arrayBuffer());
    }
    return { content, sha: j.sha };
  }

  async function putRemote(name, buf) {
    const url = `/repos/${repo}/contents/${remotePath(name).split('/').map(encodeURIComponent).join('/')}`;
    for (let tries = 0; tries < 3; tries++) {
      const r = await gh('PUT', url, {
        message: `Portal data ${name} ${new Date().toISOString()}`,
        content: buf.toString('base64'), branch, ...(shas[name] ? { sha: shas[name] } : {}),
      });
      if (r.ok) { const j = await r.json(); shas[name] = j.content.sha; return; }
      if (r.status === 409 || r.status === 422) { // our copy of the file id is out of date: refresh and try again
        const cur = await getRemote(name).catch(() => null);
        shas[name] = cur ? cur.sha : undefined;
        if (cur && hash(cur.content) === hash(buf)) return;
        continue;
      }
      throw new Error(await errText(r));
    }
    throw new Error('GitHub kept refusing the save (conflict). Will retry.');
  }

  // Run once before the portal starts: check access, then bring the files down from GitHub.
  async function init() {
    if (!enabled) return;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPO must look like  owner/name  (for example  yourname/scm-portal-data).');
    let lastErr;
    for (let i = 0; i < 4; i++) {
      try {
        const r = await gh('GET', `/repos/${repo}`);
        if (!r.ok) throw new Error(await errText(r));
        const j = await r.json();
        if (j.permissions && j.permissions.push === false) throw new Error('The token can read but not write to the repository (needs Contents: Read and write).');
        st.privateRepo = !!j.private;
        if (!branch) branch = j.default_branch || 'main';
        for (const name of files) {
          const remote = await getRemote(name);
          if (remote) {
            shas[name] = remote.sha; pushed[name] = hash(remote.content);
            fs.mkdirSync(dir, { recursive: true });
            const tmp = localPath(name) + '.tmp';
            fs.writeFileSync(tmp, remote.content, { mode: name === 'vapid.json' ? 0o600 : 0o644 });
            fs.renameSync(tmp, localPath(name));
          } else if (fs.existsSync(localPath(name))) dirty.add(name); // first run: send existing local data up
        }
        st.ready = true; st.ok = true;
        if (dirty.size) schedule(500);
        return;
      } catch (e) {
        lastErr = e;
        if (/rejected the token|not allowed|not found|must look like|read but not write/i.test(e.message)) break; // retrying will not help
        await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
      }
    }
    st.ok = false; st.lastError = lastErr.message; st.lastErrorAt = new Date().toISOString();
    throw lastErr;
  }

  function schedule(ms) {
    if (!enabled || !st.ready) return;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
    if (timer.unref) timer.unref();
  }

  // Tell the store a local file changed; it is sent to GitHub shortly (changes within 3 s are grouped).
  function changed(name) {
    if (!enabled) return;
    dirty.add(name); st.pending = dirty.size;
    schedule(DEBOUNCE_MS);
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      for (const name of [...dirty]) {
        if (!fs.existsSync(localPath(name))) { dirty.delete(name); continue; }
        const buf = fs.readFileSync(localPath(name));
        if (hash(buf) !== pushed[name]) await putRemote(name, buf);
        pushed[name] = hash(buf);
        // if the file changed while we were sending, keep it dirty
        const again = fs.existsSync(localPath(name)) ? hash(fs.readFileSync(localPath(name))) : null;
        if (again === pushed[name]) dirty.delete(name);
      }
      st.pending = dirty.size; st.ok = true; st.lastError = null; st.lastSaved = new Date().toISOString(); attempt = 0;
      if (dirty.size) schedule(DEBOUNCE_MS);
    } catch (e) {
      st.ok = false; st.lastError = e.message; st.lastErrorAt = new Date().toISOString(); st.pending = dirty.size;
      log.error('GitHub save failed: ' + e.message);
      schedule(RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
    } finally { running = false; }
  }

  // Send everything that is waiting right now (used when the portal is being shut down).
  async function flush() { if (enabled && dirty.size) { clearTimeout(timer); await run(); } }

  return { enabled, init, changed, flush, status: () => ({ ...st, pending: dirty.size }) };
}

module.exports = { createStore };
