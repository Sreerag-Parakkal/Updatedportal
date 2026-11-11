'use strict';
// Web Push (RFC 8030 / 8291 / 8292) with no packages. Sends notifications to phones and browsers
// through their own push service (Google, Apple, Mozilla, Microsoft). Free, no account needed.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

function loadKeys(dir) {
  const file = path.join(dir, 'vapid.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const keys = {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])),
  };
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

// RFC 8291 message encryption (aes128gcm). eph and salt are only passed in by tests.
function encrypt(sub, payload, eph, salt) {
  const uaPub = unb64u(sub.keys.p256dh);
  const auth = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (eph) ecdh.setPrivateKey(eph); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPub);
  salt = salt || crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const plain = Buffer.concat([Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload)), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, body]);
}

// Only real push services are accepted, so the server cannot be pointed at internal addresses.
const ALLOWED_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
function isAllowedEndpoint(endpoint) {
  if (process.env.PUSH_ALLOW_ANY_HOST === '1') return /^https?:\/\//.test(endpoint); // tests only
  try { const u = new URL(endpoint); return u.protocol === 'https:' && !u.port && ALLOWED_HOSTS.some((re) => re.test(u.hostname)); } catch (e) { return false; }
}

function createPush({ dir, contact }) {
  const keys = loadKeys(dir);
  const privateKey = crypto.createPrivateKey(keys.privatePem);
  function vapid(endpoint) {
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact }));
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
  }
  // Resolves with the HTTP status from the push service (201 = accepted, 404/410 = device is gone).
  async function send(sub, payload) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(sub.endpoint, {
        method: 'POST', signal: ctl.signal, body: encrypt(sub, payload),
        headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high', Authorization: vapid(sub.endpoint) },
      });
      return r.status;
    } finally { clearTimeout(timer); }
  }
  return { publicKey: keys.publicKey, send, isAllowedEndpoint, validKeys: (k) => !!k && unb64u(k.p256dh || '').length === 65 && unb64u(k.auth || '').length >= 8 };
}

module.exports = { createPush, encrypt, b64u, unb64u };
