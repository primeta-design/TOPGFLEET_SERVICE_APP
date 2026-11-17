'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

// ---- passwords: scrypt (built in, no native build needed) ----
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `s1$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  try {
    const [v, s, k] = String(stored).split('$');
    if (v !== 's1') return false;
    const salt = Buffer.from(s, 'base64'), want = Buffer.from(k, 'base64');
    const got = await scrypt(pw, salt, want.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(got, want);
  } catch { return false; }
}
// a fake verify so a wrong e-mail takes as long as a wrong password
const DUMMY = 's1$' + Buffer.alloc(16).toString('base64') + '$' + Buffer.alloc(64).toString('base64');
const dummyVerify = pw => verifyPassword(pw, DUMMY);

const COMMON = new Set(['password','12345678','123456789','qwertyuiop','11111111','iloveyou','admin123','welcome1','letmein1','password1','topgfleet','topgfleet1']);
function passwordProblem(pw, ctx = {}) {
  pw = String(pw || '');
  if (pw.length < 10) return 'short';
  if (pw.length > 200) return 'long';
  const low = pw.toLowerCase();
  if (COMMON.has(low)) return 'common';
  for (const w of [ctx.email && ctx.email.split('@')[0], ctx.username, ctx.name && ctx.name.split(' ')[0]]) {
    if (w && w.length >= 3 && low.includes(w.toLowerCase())) return 'personal';
  }
  if (/^(.)\1+$/.test(pw)) return 'common';
  return null;
}

// ---- sessions ----
const token = () => crypto.randomBytes(32).toString('base64url');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomBytes(9).toString('base64url');

// ---- secret encryption for TOTP seeds (AES-256-GCM, key from env) ----
function key() {
  const k = process.env.APP_SECRET;
  if (!k || k.length < 32) throw new Error('APP_SECRET must be set (32+ characters)');
  return crypto.createHash('sha256').update(k).digest();
}
function seal(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function unseal(blob) {
  const [iv, tag, enc] = String(blob).split('.').map(x => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function b32dec(s) {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) continue; bits += i.toString(2).padStart(5, '0'); }
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
const newTotpSecret = () => b32enc(crypto.randomBytes(20));
function hotp(secret, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
// returns the matched time step (so a code can't be used twice) or 0
function totpCheck(secret, code, lastStep = 0, now = Date.now()) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return 0;
  const step = Math.floor(now / 30000);
  for (const d of [-1, 0, 1]) {
    const s = step + d;
    if (s <= lastStep) continue;
    const a = Buffer.from(hotp(secret, s)), b = Buffer.from(code);
    if (crypto.timingSafeEqual(a, b)) return s;
  }
  return 0;
}
const totpUri = (secret, account, issuer = 'TOPGFLEET') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

module.exports = { hashPassword, verifyPassword, dummyVerify, passwordProblem, token, sha, uid, seal, unseal, newTotpSecret, totpCheck, totpUri, hotp };
