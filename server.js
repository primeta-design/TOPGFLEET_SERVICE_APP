'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const { pool, q, migrate } = require('./lib/db');
const C = require('./lib/crypto');
const TG = require('./lib/telegram');

const PROD = process.env.NODE_ENV === 'production';
const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOGIN_MAX = +process.env.RATE_LOGIN_MAX || 12;
const SESSION_HOURS = 12, PW_STAGE_MIN = 10, LOCK_AFTER = 5, LOCK_MIN = 15;
const COLLS = new Set(['trucks', 'trailers', 'drivers', 'issues', 'plans', 'svc', 'docs', 'inv', 'vend', 'links', 'hist', 'insp']);
const KV_FLEET = new Set(['pti', 'ck', 'ph']);          // fleet-wide documents (members may write)
const SETTING_KEYS = ['prio', 'comps', 'stat', 'tg', 'tpl', 'ptiOff', 'tmAcc', 'seed14'];   // admin-only
const ROLES = new Set(['admin', 'member', 'driver']);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------- security headers ----------
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
if (PROD) app.use((req, res, next) => (req.secure || req.path === '/healthz') ? next() : res.redirect(308, 'https://' + req.headers.host + req.originalUrl));

// ---------- tiny rate limiter (per IP, in memory) ----------
const hits = new Map();
function limit(name, max, windowMs) {
  return (req, res, next) => {
    const k = name + ':' + req.ip, now = Date.now();
    const a = (hits.get(k) || []).filter(t => now - t < windowMs);
    if (a.length >= max) { res.setHeader('Retry-After', Math.ceil(windowMs / 1000)); return res.status(429).json({ error: 'rate' }); }
    a.push(now); hits.set(k, a); next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.length || now - a[a.length - 1] > 3600e3) hits.delete(k); }, 600e3).unref();

app.use('/api', limit('api', 600, 60e3));
app.use(express.json({ limit: '2mb' }));

// ---------- CSRF: JSON API only accepts same-origin requests carrying our header ----------
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.headers['x-requested-with'] !== 'tf') return res.status(403).json({ error: 'csrf' });
  const o = req.headers.origin;
  if (o) { try { if (new URL(o).host !== req.headers.host) return res.status(403).json({ error: 'csrf' }); } catch { return res.status(403).json({ error: 'csrf' }); } }
  next();
});

// ---------- helpers ----------
const COOKIE = 'tf_sid';
function readCookie(req) {
  const m = /(?:^|;\s*)tf_sid=([A-Za-z0-9_-]{20,80})/.exec(req.headers.cookie || '');
  return m && m[1];
}
function setCookie(req, res, tok, maxAgeSec) {
  const secure = PROD || req.secure;
  res.setHeader('Set-Cookie', `${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}
const clearCookie = (req, res) => setCookie(req, res, '', 0);
const audit = (userId, action, target, detail, ip) =>
  q('INSERT INTO audit(user_id,action,target,detail,ip) VALUES($1,$2,$3,$4,$5)', [userId || null, action, target || null, detail ? JSON.stringify(detail) : null, ip || null]).catch(e => console.error('audit', e.message));
let REQ2FA = false;
const cleanAvatar = x => { if (x === null || x === '') return null; x = String(x); return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(x) && x.length <= 220000 ? x : undefined; };
const THEMES = new Set(['charcoal', 'midnight', 'forest', 'daylight', 'paper', 'mist']), LANGS = new Set(['en', 'uz', 'ru']);   // policy: staff sign in only with a code from the OWNER's authenticator (owner approves every sign-in)
const viaOwner = u => REQ2FA && !u.is_owner && u.role !== 'driver';
const publicUser = u => ({ prefs: u.prefs || {}, avatar: u.avatar || null, avLock: !!u.av_lock, need2fa: REQ2FA && !!u.is_owner && !u.totp_on, viaOwner: viaOwner(u), id: u.id, email: u.email, username: u.username, name: u.name, role: u.role, owner: u.is_owner, totp: u.totp_on, mustChange: u.must_change, color: u.color || null, noMail: /@no-email\.local$/i.test(u.email), companies: u.role === 'admin' ? null : (u.companies || null), test: !!u.is_test });
const okId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s);
const cleanCompanies = v => v === null ? null : (Array.isArray(v) && v.length <= 200 && v.every(okId) ? [...new Set(v)] : undefined);
const allowedOf = u => (u.role !== 'admin' && Array.isArray(u.companies)) ? new Set(u.companies) : null;   // null = sees everything
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => { console.error(e); res.status(500).json({ error: 'server' }); });

async function newSession(req, res, userId, stage) {
  const tok = C.token(), ttl = stage === 'pw' ? PW_STAGE_MIN * 60 : SESSION_HOURS * 3600;
  await q(`INSERT INTO sessions(token_hash,user_id,stage,expires_at,ip,ua) VALUES($1,$2,$3,now()+make_interval(secs => $4::int),$5,$6)`,
    [C.sha(tok), userId, stage, ttl, req.ip, String(req.headers['user-agent'] || '').slice(0, 200)]);
  setCookie(req, res, tok, ttl);
}
async function sessionOf(req) {
  const tok = readCookie(req); if (!tok) return null;
  const r = await q(`SELECT s.token_hash,s.stage,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled`, [C.sha(tok)]);
  return r.rows[0] || null;
}
const auth = (stage = 'full') => wrap(async (req, res, next) => {
  const s = await sessionOf(req);
  if (!s || s.stage !== stage) return res.status(401).json({ error: 'auth' });
  if (REQ2FA && s.is_owner && !s.totp_on && stage === 'full' && !(req.path === '/api/me' && req.method === 'GET') && !req.path.startsWith('/api/2fa/') && req.path !== '/api/password') return res.status(403).json({ error: '2fa_setup' });
  req.u = s; req.sh = s.token_hash; next();
});
const need = (...roles) => (req, res, next) => roles.includes(req.u.role) ? next() : res.status(403).json({ error: 'role' });
const staff = need('admin', 'member');
const admin = need('admin');

// tell the owner on Telegram who signs in / out (only if the owner linked a private chat)
async function notifyOwner(u, what, req) {
  try {
    if (!TG.enabled()) return;
    const rows = (await q("SELECT c.chat_id FROM tg_chats c JOIN users o ON o.id=c.user_id WHERE o.is_owner AND NOT o.disabled")).rows; if (!rows.length) return;
    const esc = x => String(x || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]), ua = String(req.headers['user-agent'] || '');
    const dev = (/iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'device') + (/Edg\//.test(ua) ? ' · Edge' : /Chrome\//.test(ua) ? ' · Chrome' : /Firefox\//.test(ua) ? ' · Firefox' : /Safari\//.test(ua) ? ' · Safari' : '');
    for (const r of rows) await TG.send(r.chat_id, `${what === 'signed in' ? '🟢' : '⚪️'} <b>${esc(u.name)}</b> ${what}\n${esc(dev)} · ${esc(req.ip)}`);
  } catch (e) { console.error('notifyOwner', e.message); }
}

// ---------- login ----------
app.post('/api/login', limit('login', LOGIN_MAX, 10 * 60e3), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200), pw = String(req.body.password || '').slice(0, 300);
  const r = await q('SELECT * FROM users WHERE lower(email)=$1 OR lower(username)=$1', [email]);
  const u = r.rows[0];
  if (!u) { await C.dummyVerify(pw); audit(null, 'login.fail', email, { why: 'unknown' }, req.ip); return res.status(401).json({ error: 'creds' }); }
  if (u.disabled) { await C.dummyVerify(pw); return res.status(401).json({ error: 'creds' }); }
  if (u.locked_until && new Date(u.locked_until) > new Date()) { audit(u.id, 'login.locked', u.email, null, req.ip); return res.status(429).json({ error: 'locked' }); }
  const ok = await C.verifyPassword(pw, u.pass_hash);
  if (!ok) {
    const f = u.failed + 1;
    await q('UPDATE users SET failed=$2::int, locked_until=CASE WHEN $2::int>=$3::int THEN now()+make_interval(mins => $4::int) ELSE locked_until END WHERE id=$1', [u.id, f, LOCK_AFTER, LOCK_MIN]);
    audit(u.id, 'login.fail', u.email, { failed: f }, req.ip);
    return res.status(401).json({ error: 'creds' });
  }
  await q('UPDATE users SET failed=0, locked_until=NULL WHERE id=$1', [u.id]);
  if (u.totp_on || viaOwner(u)) { await newSession(req, res, u.id, 'pw'); return res.json({ next: 'totp', owner: viaOwner(u) }); }
  await newSession(req, res, u.id, 'full');
  audit(u.id, 'login.ok', u.email, { totp: false }, req.ip); if (!u.is_owner) notifyOwner(u, 'signed in', req);
  res.json({ user: publicUser(u) });
}));

app.post('/api/login/totp', limit('totp', LOGIN_MAX, 10 * 60e3), auth('pw'), wrap(async (req, res) => {
  const u = req.u;
  if (u.locked_until && new Date(u.locked_until) > new Date()) return res.status(429).json({ error: 'locked' });
  let secret = u.totp_secret;
  if (viaOwner(u)) { const o = (await q('SELECT totp_secret FROM users WHERE is_owner AND totp_on AND NOT disabled LIMIT 1')).rows[0]; if (!o) return res.status(409).json({ error: 'noowner' }); secret = o.totp_secret; }
  const step = C.totpCheck(C.unseal(secret), req.body.code, +u.totp_last);
  if (!step) {
    const f = u.failed + 1;
    await q('UPDATE users SET failed=$2::int, locked_until=CASE WHEN $2::int>=$3::int THEN now()+make_interval(mins => $4::int) ELSE locked_until END WHERE id=$1', [u.id, f, LOCK_AFTER, LOCK_MIN]);
    audit(u.id, 'login.totp_fail', u.email, null, req.ip);
    return res.status(401).json({ error: 'code' });
  }
  await q('UPDATE users SET totp_last=$2, failed=0 WHERE id=$1', [u.id, step]);
  await q('DELETE FROM sessions WHERE token_hash=$1', [req.sh]);       // new token after the second step
  await newSession(req, res, u.id, 'full');
  audit(u.id, 'login.ok', u.email, { totp: true, viaOwner: viaOwner(u) }, req.ip); if (!u.is_owner) notifyOwner(u, 'signed in', req);
  res.json({ user: publicUser(u) });
}));

app.post('/api/logout', wrap(async (req, res) => {
  const tok = readCookie(req); if (tok) { const so = await sessionOf(req); if (so && so.stage === 'full' && !so.is_owner) notifyOwner(so, 'signed out', req); await q('DELETE FROM sessions WHERE token_hash=$1', [C.sha(tok)]); }
  clearCookie(req, res); res.json({ ok: true });
}));
app.get('/api/me', auth(), (req, res) => res.json({ user: publicUser(req.u) }));


app.patch('/api/me', limit('login', LOGIN_MAX, 10 * 60e3), auth(), wrap(async (req, res) => {
  const b = req.body || {}, u = req.u, set = {};
  if (b.name !== undefined) { const n = String(b.name).trim(); if (!n || n.length > 100) return res.status(400).json({ error: 'bad' }); set.name = n; }
  if (b.username !== undefined) { const x = String(b.username).trim().toLowerCase(); if (!/^[a-z0-9._-]{3,30}$/.test(x)) return res.status(400).json({ error: 'bad' }); set.username = x; }
  if (b.email !== undefined) {
    const e = String(b.email).trim().toLowerCase(); if (!/^[^@\s]{1,64}@[^@\s]{1,200}$/.test(e)) return res.status(400).json({ error: 'bad' });
    if (e !== u.email) { if (!(await C.verifyPassword(String(b.current || ''), u.pass_hash))) return res.status(401).json({ error: 'creds' }); set.email = e; }
  }
  if (b.color !== undefined) { if (!/^#[0-9a-fA-F]{6}$/.test(String(b.color))) return res.status(400).json({ error: 'bad' }); set.color = String(b.color).toLowerCase(); }
  if (b.avatar !== undefined) { if (u.av_lock && !u.is_owner) return res.status(403).json({ error: 'locked' }); const a = cleanAvatar(b.avatar); if (a === undefined) return res.status(400).json({ error: 'bad' }); set.avatar = a; }
  if (b.prefs && typeof b.prefs === 'object') { const pr = { ...(u.prefs || {}) }; if (THEMES.has(b.prefs.theme)) pr.theme = b.prefs.theme; if (LANGS.has(b.prefs.lang)) pr.lang = b.prefs.lang; set.prefs = JSON.stringify(pr); }
  const keys = Object.keys(set); if (!keys.length) return res.json({ user: publicUser(u) });
  try {
    const r = await q(`UPDATE users SET ${keys.map((k, i) => k + '=$' + (i + 2)).join(',')} WHERE id=$1 RETURNING *`, [u.id, ...keys.map(k => set[k])]);
    audit(u.id, 'profile.update', u.email, { fields: keys }, req.ip); res.json({ user: publicUser(r.rows[0]) });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'dupe' }); throw e; }
}));

// ---------- 2FA + password ----------
app.post('/api/2fa/start', auth(), wrap(async (req, res) => {
  if (req.u.totp_on) return res.status(409).json({ error: 'already' });
  const secret = C.newTotpSecret();
  await q('UPDATE users SET totp_secret=$2 WHERE id=$1', [req.u.id, C.seal(secret)]);
  res.json({ secret, uri: C.totpUri(secret, req.u.email) });
}));
app.post('/api/2fa/enable', limit('totp', LOGIN_MAX, 10 * 60e3), auth(), wrap(async (req, res) => {
  if (!req.u.totp_secret) return res.status(400).json({ error: 'start' });
  const step = C.totpCheck(C.unseal(req.u.totp_secret), req.body.code, 0);
  if (!step) return res.status(401).json({ error: 'code' });
  await q('UPDATE users SET totp_on=TRUE, totp_last=$2 WHERE id=$1', [req.u.id, step]);
  audit(req.u.id, '2fa.enable', req.u.email, null, req.ip); res.json({ ok: true });
}));
app.get('/api/2fa/policy', auth(), (req, res) => res.json({ on: REQ2FA }));
app.post('/api/2fa/policy', limit('login', LOGIN_MAX, 10 * 60e3), auth(), wrap(async (req, res) => {
  if (!req.u.is_owner) return res.status(403).json({ error: 'role' });
  const on = !!(req.body && req.body.on); if (on && !req.u.totp_on) return res.status(409).json({ error: 'ownerfirst' });
  await q("INSERT INTO kv(key,value,updated_by) VALUES('req2fa',$1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by", [JSON.stringify(on), req.u.id]);
  REQ2FA = on; audit(req.u.id, on ? '2fa.require_on' : '2fa.require_off', null, null, req.ip); res.json({ on });
}));
app.post('/api/2fa/disable', limit('login', LOGIN_MAX, 10 * 60e3), auth(), wrap(async (req, res) => {
  if (REQ2FA) return res.status(403).json({ error: 'required' });
  if (!(await C.verifyPassword(String(req.body.password || ''), req.u.pass_hash))) return res.status(401).json({ error: 'creds' });
  const step = req.u.totp_on ? C.totpCheck(C.unseal(req.u.totp_secret), req.body.code, +req.u.totp_last) : 1;
  if (!step) return res.status(401).json({ error: 'code' });
  await q('UPDATE users SET totp_on=FALSE, totp_secret=NULL WHERE id=$1', [req.u.id]);
  audit(req.u.id, '2fa.disable', req.u.email, null, req.ip); res.json({ ok: true });
}));
app.post('/api/password', limit('login', LOGIN_MAX, 10 * 60e3), auth(), wrap(async (req, res) => {
  const { current, next } = req.body;
  if (!(await C.verifyPassword(String(current || ''), req.u.pass_hash))) return res.status(401).json({ error: 'creds' });
  const bad = C.passwordProblem(next, req.u); if (bad) return res.status(400).json({ error: 'weak', why: bad });
  await q('UPDATE users SET pass_hash=$2, must_change=FALSE WHERE id=$1', [req.u.id, await C.hashPassword(next)]);
  await q('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [req.u.id, req.sh]);
  audit(req.u.id, 'password.change', req.u.email, null, req.ip); res.json({ ok: true });
}));

// ---------- users (admin) ----------
app.get('/api/users', auth(), admin, wrap(async (req, res) => {
  const r = await q('SELECT * FROM users ORDER BY created_at'), sx = (await q("SELECT user_id, count(*)::int n, max(created_at) last, (array_agg(ip ORDER BY created_at DESC))[1] ip, (array_agg(ua ORDER BY created_at DESC))[1] ua FROM sessions WHERE stage='full' AND expires_at>now() GROUP BY user_id")).rows, sm = Object.fromEntries(sx.map(x => [x.user_id, x]));
  res.json({ users: r.rows.map(u => ({ ...publicUser(u), disabled: u.disabled, online: (sm[u.id] || {}).n || 0, lastIn: (sm[u.id] || {}).last || null, lastIp: (sm[u.id] || {}).ip || null, lastUa: String((sm[u.id] || {}).ua || '').slice(0, 120) })) });
}));
app.post('/api/users/:id/signout', auth(), admin, wrap(async (req, res) => {
  const t = (await q('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0]; if (!t) return res.status(404).json({ error: 'none' });
  if (t.is_owner) return res.status(400).json({ error: 'owner' });
  await q('DELETE FROM sessions WHERE user_id=$1', [t.id]); audit(req.u.id, 'user.signout', t.email, null, req.ip); res.json({ ok: true });
}));
app.post('/api/users', auth(), admin, wrap(async (req, res) => {
  const b = req.body, username = String(b.username || '').trim().toLowerCase(), name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase() || (username + '@no-email.local');
  if (!/^[^@\s]{1,64}@[^@\s]{1,200}$/.test(email) || !/^[a-z0-9._-]{3,30}$/.test(username) || !name || name.length > 100 || !ROLES.has(b.role)) return res.status(400).json({ error: 'bad' });
  const bad = C.passwordProblem(b.password, { email, username, name }); if (bad) return res.status(400).json({ error: 'weak', why: bad });
  try {
    const id = C.uid();
    const cos = b.companies === undefined ? null : cleanCompanies(b.companies); if (cos === undefined) return res.status(400).json({ error: 'bad' });
    await q('INSERT INTO users(id,email,username,name,role,pass_hash,must_change,is_test,companies,color) VALUES($1,$2,$3,$4,$5,$6,TRUE,$7,$8,$9)', [id, email, username, name, b.role, await C.hashPassword(b.password), !!b.test, cos ? JSON.stringify(cos) : null, /^#[0-9a-fA-F]{6}$/.test(String(b.color || '')) ? b.color : null]);
    audit(req.u.id, 'user.create', email, { role: b.role }, req.ip); res.json({ id });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'dupe' }); throw e; }
}));
app.patch('/api/users/:id', auth(), admin, wrap(async (req, res) => {
  const t = (await q('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0]; if (!t) return res.status(404).json({ error: 'none' });
  if (t.is_owner && (req.body.disabled || (req.body.role && req.body.role !== 'admin'))) return res.status(400).json({ error: 'owner' });
  if (t.id === req.u.id && req.body.disabled) return res.status(400).json({ error: 'self' });
  const role = req.body.role && ROLES.has(req.body.role) ? req.body.role : t.role, disabled = typeof req.body.disabled === 'boolean' ? req.body.disabled : t.disabled;
  const name = req.body.name ? String(req.body.name).trim().slice(0, 100) : t.name;
  let cos = t.companies; if (req.body.companies !== undefined) { cos = cleanCompanies(req.body.companies); if (cos === undefined) return res.status(400).json({ error: 'bad' }); }
  const color = req.body.color !== undefined && /^#[0-9a-fA-F]{6}$/.test(String(req.body.color)) ? String(req.body.color).toLowerCase() : t.color;
  let email = t.email;
  if (req.body.email !== undefined) {
    const e = String(req.body.email || '').trim().toLowerCase().slice(0, 200), nxt = e || (t.username + '@no-email.local');
    if (!/^[^@\s]{1,64}@[^@\s]{1,200}$/.test(nxt)) return res.status(400).json({ error: 'bad' });
    if (nxt !== t.email) { const d = await q('SELECT 1 FROM users WHERE lower(email)=$1 AND id<>$2', [nxt, t.id]); if (d.rows.length) return res.status(409).json({ error: 'dupe' }); email = nxt; }
  }
  let avatar = t.avatar; if (req.body.avatar !== undefined) { avatar = cleanAvatar(req.body.avatar); if (avatar === undefined) return res.status(400).json({ error: 'bad' }); }
  let avLock = !!t.av_lock; if (typeof req.body.avLock === 'boolean') { if (!req.u.is_owner || t.is_owner) return res.status(403).json({ error: 'role' }); avLock = req.body.avLock; }
  await q('UPDATE users SET role=$2, disabled=$3, name=$4, companies=$5, color=$6, email=$7, avatar=$8, av_lock=$9 WHERE id=$1', [t.id, role, disabled, name, cos ? JSON.stringify(cos) : null, color, email, avatar, avLock]);
  if (disabled || role !== t.role) await q('DELETE FROM sessions WHERE user_id=$1', [t.id]);
  audit(req.u.id, 'user.update', t.email, { role, disabled }, req.ip); res.json({ ok: true });
}));
app.post('/api/users/:id/reset', auth(), admin, wrap(async (req, res) => {
  const t = (await q('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0]; if (!t) return res.status(404).json({ error: 'none' });
  const bad = C.passwordProblem(req.body.password, t); if (bad) return res.status(400).json({ error: 'weak', why: bad });
  await q('UPDATE users SET pass_hash=$2, must_change=TRUE, failed=0, locked_until=NULL, totp_on=FALSE, totp_secret=NULL WHERE id=$1', [t.id, await C.hashPassword(req.body.password)]);
  await q('DELETE FROM sessions WHERE user_id=$1', [t.id]);
  audit(req.u.id, 'user.reset', t.email, null, req.ip); res.json({ ok: true });
}));
app.delete('/api/users/:id', auth(), admin, wrap(async (req, res) => {
  const t = (await q('SELECT * FROM users WHERE id=$1', [req.params.id])).rows[0]; if (!t) return res.status(404).json({ error: 'none' });
  if (t.is_owner || t.id === req.u.id) return res.status(400).json({ error: 'owner' });
  await q('DELETE FROM users WHERE id=$1', [t.id]); audit(req.u.id, 'user.delete', t.email, null, req.ip); res.json({ ok: true });
}));

// ---------- fleet data ----------
// narrow the data a company-restricted member is allowed to see
function scopeState(DB, A) {
  const low = x => String(x || '').trim().toLowerCase();
  const allT = DB.trucks, allR = DB.trailers;
  const trucks = allT.filter(x => A.has(x.company)), trailers = allR.filter(x => A.has(x.company));
  const tids = new Set(trucks.map(x => x.id)), rids = new Set(trailers.map(x => x.id));
  const okNums = new Set([...trucks, ...trailers].map(x => low(x.num)));
  const knownNums = new Set([...allT, ...allR].map(x => low(x.num)));
  const unitOk = n => !knownNums.has(low(n)) || okNums.has(low(n));      // text that names no unit stays visible
  const out = { ...DB, trucks, trailers };
  out.drivers = DB.drivers.filter(x => !x.truck || tids.has(x.truck));
  out.issues = DB.issues.filter(x => unitOk(x.title));
  out.plans = DB.plans.filter(x => tids.has(x.truck));
  out.svc = DB.svc.filter(x => tids.has(x.truck));
  out.docs = DB.docs.filter(x => x.kind === 'truck' ? tids.has(x.uid) : rids.has(x.uid));
  out.inv = DB.inv.filter(x => (!x.truck || tids.has(x.truck)) && (!x.trailer || rids.has(x.trailer)));
  out.links = DB.links.filter(x => rids.has(x.trailer));
  out.hist = DB.hist.filter(x => rids.has(x.trailer));
  out.insp = DB.insp.filter(x => unitOk(x.unit));
  if (DB.pti) out.pti = Object.fromEntries(Object.entries(DB.pti).filter(([k]) => tids.has(k)));
  return out;
}
async function loadAll() {
  const [rec, kv] = await Promise.all([q('SELECT coll,data FROM records'), q('SELECT key,value FROM kv')]);
  const DB = {}; COLLS.forEach(c => DB[c] = []);
  rec.rows.forEach(r => DB[r.coll] && DB[r.coll].push(r.data));
  const S = {}; kv.rows.forEach(r => { if (KV_FLEET.has(r.key)) DB[r.key] = r.value; else if (SETTING_KEYS.includes(r.key)) S[r.key] = r.value; });
  return { DB, S };
}
app.get('/api/state', auth(), staff, wrap(async (req, res) => {
  let { DB, S } = await loadAll();
  const A = allowedOf(req.u); if (A) DB = scopeState(DB, A);
  const tm = (await q("SELECT id,name,username,email,role,is_owner,color,companies,is_test,avatar FROM users WHERE role<>'driver' AND NOT disabled ORDER BY created_at")).rows;
  const team = tm.map(u => ({ id: u.id, n: u.name, u: u.username, m: req.u.role === 'admin' ? u.email : '', r: u.role, owner: u.is_owner, c: u.color, av: u.avatar || null, co: u.role === 'admin' ? null : (u.companies || null), test: u.is_test }));
  res.json({ DB, S, team, user: publicUser(req.u) });
}));

app.post('/api/sync', limit('sync', 240, 60e3), auth(), staff, wrap(async (req, res) => {
  const { upserts = [], deletes = [], kv = {} } = req.body || {};
  if (!Array.isArray(upserts) || !Array.isArray(deletes) || typeof kv !== 'object' || upserts.length + deletes.length > 2000) return res.status(400).json({ error: 'bad' });
  for (const x of upserts) if (!COLLS.has(x.c) || !okId(x.id) || typeof x.d !== 'object' || !x.d || JSON.stringify(x.d).length > 100000) return res.status(400).json({ error: 'bad' });
  for (const x of deletes) if (!COLLS.has(x.c) || !okId(x.id)) return res.status(400).json({ error: 'bad' });
  const kvKeys = Object.keys(kv);
  for (const k of kvKeys) {
    if (KV_FLEET.has(k)) { if (JSON.stringify(kv[k]).length > 400000) return res.status(400).json({ error: 'bad' }); }
    else if (SETTING_KEYS.includes(k)) { if (req.u.role !== 'admin') return res.status(403).json({ error: 'role' }); if (JSON.stringify(kv[k]).length > 100000) return res.status(400).json({ error: 'bad' }); }
    else return res.status(400).json({ error: 'bad' });
  }
  const A = allowedOf(req.u);
  if (A) {
    for (const x of upserts) if ((x.c === 'trucks' || x.c === 'trailers') && !A.has(x.d.company)) return res.status(403).json({ error: 'scope' });
    const guard = [...upserts, ...deletes].filter(x => x.c === 'trucks' || x.c === 'trailers');
    for (const x of guard) {
      const ex = (await q('SELECT data FROM records WHERE coll=$1 AND id=$2', [x.c, x.id])).rows[0];
      if (ex && !A.has(ex.data.company)) return res.status(403).json({ error: 'scope' });
    }
    if (kv.pti) {   // keep the PTI of trucks this member cannot see
      const old = (await q("SELECT value FROM kv WHERE key='pti'")).rows[0], oldV = old ? old.value : {};
      const trucks = (await q("SELECT id,data FROM records WHERE coll='trucks'")).rows, mine = new Set(trucks.filter(r => A.has(r.data.company)).map(r => r.id));
      const merged = {}; for (const k of Object.keys(oldV)) if (!mine.has(k)) merged[k] = oldV[k];
      for (const k of Object.keys(kv.pti)) if (mine.has(k)) merged[k] = kv.pti[k];
      kv.pti = merged;
    }
  }
  const issueUps = upserts.filter(x => x.c === 'issues'), invUps = upserts.filter(x => x.c === 'inv');
  const existing = async (coll, L) => L.length ? new Set((await q('SELECT id FROM records WHERE coll=$1 AND id=ANY($2)', [coll, L.map(x => x.id)])).rows.map(r => r.id)) : new Set();
  const had = await existing('issues', issueUps), hadInv = await existing('inv', invUps);
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    for (const x of upserts) {
      x.d.id = x.id;
      await cl.query(`INSERT INTO records(coll,id,data,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data, updated_at=now(), updated_by=EXCLUDED.updated_by`, [x.c, x.id, JSON.stringify(x.d), req.u.id]);
    }
    for (const x of deletes) await cl.query('DELETE FROM records WHERE coll=$1 AND id=$2', [x.c, x.id]);
    for (const k of kvKeys) await cl.query(`INSERT INTO kv(key,value,updated_by) VALUES($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`, [k, JSON.stringify(kv[k]), req.u.id]);
    await cl.query('COMMIT');
  } catch (e) { await cl.query('ROLLBACK').catch(() => {}); throw e; } finally { cl.release(); }
  if (upserts.length || deletes.length || kvKeys.length)
    audit(req.u.id, 'sync', null, { up: upserts.slice(0, 50).map(x => x.c + '/' + x.id), upN: upserts.length, del: deletes.slice(0, 50).map(x => x.c + '/' + x.id), delN: deletes.length, kv: kvKeys }, req.ip);
  const fresh = issueUps.filter(x => !had.has(x.id)).map(x => x.d); if (fresh.length) TG.notifyNewIssues(fresh);
  const freshInv = invUps.filter(x => !hadInv.has(x.id)).map(x => x.d); if (freshInv.length) TG.notifyNewInvoices(freshInv, 'https://' + req.get('host'));
  res.json({ ok: true });
}));

app.get('/api/audit', auth(), admin, wrap(async (req, res) => {
  const r = await q('SELECT a.id,a.at,a.action,a.target,a.detail,a.ip,u.email AS who FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300'); res.json({ rows: r.rows });
}));

// ---------- files (stored on the Railway volume) ----------
const MAGIC = { 'application/pdf': b => b.slice(0, 5).toString() === '%PDF-', 'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8, 'image/png': b => b.slice(1, 4).toString() === 'PNG' };
app.post('/api/files', auth(), staff, express.raw({ type: Object.keys(MAGIC), limit: '20mb' }), wrap(async (req, res) => {
  const mime = (req.headers['content-type'] || '').split(';')[0];
  if (!MAGIC[mime] || !Buffer.isBuffer(req.body) || !req.body.length || !MAGIC[mime](req.body)) return res.status(400).json({ error: 'type' });
  const id = C.uid(); fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, id), req.body, { mode: 0o600 });
  const name = decodeURIComponent(String(req.headers['x-filename'] || 'file')).replace(/[^\w.\- ]/g, '_').slice(0, 120);
  await q('INSERT INTO files(id,name,mime,size,path,uploaded_by) VALUES($1,$2,$3,$4,$5,$6)', [id, name, mime, req.body.length, id, req.u.id]);
  audit(req.u.id, 'file.upload', id, { name, size: req.body.length }, req.ip); res.json({ id, name });
}));
app.get('/api/files/:id', auth(), wrap(async (req, res) => {
  if (!okId(req.params.id)) return res.status(404).end();
  const f = (await q('SELECT * FROM files WHERE id=$1', [req.params.id])).rows[0]; if (!f) return res.status(404).end();
  res.setHeader('Content-Type', f.mime); res.setHeader('Content-Disposition', `inline; filename="${f.name.replace(/"/g, '')}"`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  fs.createReadStream(path.join(DATA_DIR, f.path)).on('error', () => res.status(404).end()).pipe(res);
}));


// ---------- Telegram ----------
app.post('/tg/hook', express.json({ limit: '1mb' }), (req, res) => { if (!TG.verify(req)) return res.sendStatus(403); res.sendStatus(200); TG.handleUpdate(req.body); });
app.get('/api/tg/info', auth(), staff, wrap(async (req, res) => {
  const i = await TG.info(), mine = (await q('SELECT chat_id,digest FROM tg_chats WHERE user_id=$1', [req.u.id])).rows;
  res.json({ enabled: i.enabled, bot: i.bot || null, webhook: req.u.role === 'admin' ? i.webhook : undefined, linked: mine.length > 0, digest: mine.length ? mine[0].digest : null });
}));
app.post('/api/tg/code', limit('tgcode', 20, 10 * 60e3), auth(), staff, wrap(async (req, res) => {
  if (!TG.enabled()) return res.status(503).json({ error: 'off' }); const b = await TG.me(); if (!b) return res.status(503).json({ error: 'off' });
  const code = await TG.linkCode(req.u.id); res.json({ code, bot: b.username, link: `https://t.me/${b.username}?start=${code}`, minutes: 10 });
}));
app.post('/api/tg/unlink', auth(), staff, wrap(async (req, res) => { await q('DELETE FROM tg_chats WHERE user_id=$1', [req.u.id]); res.json({ ok: true }); }));
app.post('/api/tg/digest', auth(), staff, wrap(async (req, res) => { await q('UPDATE tg_chats SET digest=$2 WHERE user_id=$1', [req.u.id, !!(req.body || {}).on]); res.json({ ok: true }); }));
app.post('/api/tg/reconnect', limit('tgre', 10, 10 * 60e3), auth(), admin, wrap(async (req, res) => {
  const r = await TG.setWebhook('https://' + req.get('host')); audit(req.u.id, 'telegram.webhook', req.get('host'), { ok: !!r.ok }, req.ip); res.json({ ok: !!r.ok, error: r.ok ? null : r.description });
}));
app.post('/api/tg/test', limit('tgtest', 20, 10 * 60e3), auth(), admin, wrap(async (req, res) => {
  if (!TG.enabled()) return res.status(503).json({ error: 'off' });
  const { S } = await loadAll(), g = S.tg || {}, out = [];
  for (const [k, id] of [['managers', g.mgr], ['workers', g.work], ['invoices', g.inv]]) if (id) { const r = await TG.send(id, '✅ TOPGFLEET test message'); out.push({ group: k, ok: !!r.ok, error: r.ok ? null : r.description }); }
  const mine = (await q('SELECT chat_id FROM tg_chats WHERE user_id=$1', [req.u.id])).rows; for (const m of mine) { const r = await TG.send(m.chat_id, '✅ TOPGFLEET test message'); out.push({ group: 'you', ok: !!r.ok, error: r.ok ? null : r.description }); }
  res.json({ results: out });
}));
app.post('/api/tg/send-now', limit('tgnow', 20, 10 * 60e3), auth(), admin, wrap(async (req, res) => {
  if (!TG.enabled()) return res.status(503).json({ error: 'off' }); const { DB, S } = await loadAll(); const r = await TG.sendWorkersList(S, DB, true); res.json({ ok: !!r.ok, error: r.ok ? null : r.description });
}));

app.post('/api/invoices/:id/telegram', limit('tginv', 30, 10 * 60e3), auth(), staff, wrap(async (req, res) => {
  if (!TG.enabled()) return res.json({ ok: false, error: 'off' });
  let { DB, S } = await loadAll(); const A = allowedOf(req.u); if (A) DB = scopeState(DB, A);
  const inv = (DB.inv || []).find(x => x.id === req.params.id); if (!inv) return res.status(404).json({ error: 'none' });
  const tU = (DB.trucks || []).find(x => x.id === inv.truck), lU = (DB.trailers || []).find(x => x.id === inv.trailer), cU = (S.comps || []).find(c => c.id === ((tU && tU.company) || (lU && lU.company)));
  if (!((cU && cU.inv) || (S.tg && S.tg.inv))) return res.json({ ok: false, error: 'nogroup' });
  const sent = await TG.notifyNewInvoices([inv], 'https://' + req.get('host')); audit(req.u.id, 'invoice.telegram', inv.id, null, req.ip);
  if (!sent.length) return res.json({ ok: false, error: 'fail' });
  res.json({ ok: true, tg: sent[0].at, tgm: sent[0] });
}));
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use('/api', (req, res) => res.status(404).json({ error: 'none' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0, setHeaders: r => r.setHeader('Cache-Control', 'no-cache') }));
const PAGES = new Set(['dashboard', 'alerts', 'fleet', 'trailers', 'hook-drop', 'drivers', 'maintenance', 'pti', 'inspections', 'documents', 'violation-report', 'invoices', 'vendors', 'profile', 'companies']);
app.get('/:page', (req, res, next) => PAGES.has(req.params.page) ? (res.setHeader('Cache-Control', 'no-cache'), res.sendFile(path.join(__dirname, 'public', 'index.html'))) : next());
app.use((req, res) => res.status(404).type('text').send('Not found'));

// ---------- start ----------
async function bootstrap() {
  await migrate();
  try { const r = await q("SELECT value FROM kv WHERE key='req2fa'"); REQ2FA = !!(r.rows[0] && r.rows[0].value === true); } catch (e) {}
  TG.init({ q, loadAll, scopeState, allowedOf, audit, dataDir: DATA_DIR }, process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : ''));
  const n = +(await q('SELECT count(*) FROM users')).rows[0].count;
  if (!n) {
    const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase(), pw = process.env.ADMIN_PASSWORD || '';
    if (!email || !pw) { console.warn('No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in the environment and restart.'); return; }
    const username = (process.env.ADMIN_USERNAME || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30) || 'admin';
    const bad = C.passwordProblem(pw, { email, username }); if (bad) throw new Error('ADMIN_PASSWORD is too weak (' + bad + ')');
    await q('INSERT INTO users(id,email,username,name,role,is_owner,pass_hash) VALUES($1,$2,$3,$4,\'admin\',TRUE,$5)', [C.uid(), email, username, process.env.ADMIN_NAME || 'Owner', await C.hashPassword(pw)]);
    console.log('Owner account created for', email);
  }
}
setInterval(() => q('DELETE FROM sessions WHERE expires_at<now()').catch(() => {}), 3600e3).unref();

if (require.main === module) {
  C.seal('x'); // fail fast when APP_SECRET is missing
  bootstrap().then(() => app.listen(PORT, () => console.log('TOPGFLEET listening on', PORT))).catch(e => { console.error(e); process.exit(1); });
}
module.exports = { app, bootstrap };
