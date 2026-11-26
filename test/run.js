'use strict';
// Integration test: starts a throw-away Postgres, boots the server, exercises auth + sync + security.
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
let EP; try { EP = require('embedded-postgres').default; } catch { console.error('embedded-postgres missing'); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfpg-')); try { fs.chmodSync(dir, 0o777); if (process.getuid() === 0) require('child_process').execSync('chown -R postgres ' + dir); } catch {}
(async () => {
  const pg = new EP({ databaseDir: dir, user: 'tf', password: 'tf', port: 54329, persistent: false });
  await pg.initialise(); await pg.start(); await pg.createDatabase('tf');
  process.env.DATABASE_URL = 'postgres://tf:tf@localhost:54329/tf';
  process.env.APP_SECRET = 'x'.repeat(40); process.env.RATE_LOGIN_MAX = '1000'; process.env.ADMIN_EMAIL = 'boss@example.com'; process.env.ADMIN_PASSWORD = 'Correct-Horse-9!';
  process.env.DATA_DIR = path.join(os.tmpdir(), 'tffiles-' + process.pid);
  const { app, bootstrap } = require('../server.js'); const C = require('../lib/crypto');
  await bootstrap();
  const srv = app.listen(0); const port = srv.address().port;
  let jar = {}; const errs = []; let n = 0;
  const call = (method, url, body, o = {}) => new Promise(r => {
    const data = body === undefined ? null : (o.raw ? body : JSON.stringify(body));
    const h = { Host: 'localhost:' + port, ...(o.noHdr ? {} : { 'X-Requested-With': 'tf' }), ...(data ? { 'Content-Type': o.ct || 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(o.headers || {}) };
    const ck = o.jar === undefined ? jar : o.jar; if (ck.v) h.Cookie = 'tf_sid=' + ck.v;
    const rq = http.request({ port, method, path: url, headers: h }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => {
        const sc = res.headers['set-cookie']; if (sc && o.jar === undefined) { const m = /tf_sid=([^;]*)/.exec(sc[0]); jar = { v: m && m[1] || '' }; }
        let j; try { j = JSON.parse(b); } catch {} r({ s: res.statusCode, j, h: res.headers, b });
      });
    }); if (data) rq.write(data); rq.end();
  });
  const ok = (c, m) => { n++; if (!c) { errs.push(m); console.log('  FAIL', m); } };
  const J = s => s;

  // headers & static
  let r = await call('GET', '/healthz'); ok(r.s === 200, 'health');
  r = await call('GET', '/'); ok(r.s === 200 && /frame-ancestors 'none'/.test(r.h['content-security-policy']) && r.h['x-content-type-options'] === 'nosniff', 'security headers on /');
  // unauthenticated
  r = await call('GET', '/api/state'); ok(r.s === 401, 'state needs login');
  r = await call('POST', '/api/sync', { upserts: [] }, { noHdr: true }); ok(r.s === 403, 'csrf header required');
  r = await call('POST', '/api/login', { email: 'boss@example.com', password: 'x' }, { headers: { Origin: 'https://evil.example' } }); ok(r.s === 403, 'foreign origin refused');
  // login failures
  r = await call('POST', '/api/login', { email: 'nobody@example.com', password: 'whatever12345' }); ok(r.s === 401 && r.j.error === 'creds', 'unknown user generic error');
  r = await call('POST', '/api/login', { email: 'boss@example.com', password: 'wrong-password-1' }); ok(r.s === 401 && r.j.error === 'creds', 'wrong password generic error');
  // good login
  r = await call('POST', '/api/login', { email: 'boss@example.com', password: 'Correct-Horse-9!' }); ok(r.s === 200 && r.j.user && r.j.user.role === 'admin' && r.j.user.owner, 'admin login');
  const ck = r.h['set-cookie'][0]; ok(/HttpOnly/.test(ck) && /SameSite=Strict/.test(ck), 'cookie flags');
  r = await call('GET', '/api/me'); ok(r.s === 200 && r.j.user.email === 'boss@example.com', 'me');
  // sync
  const tid = 'trk1', iid = 'iss1';
  r = await call('POST', '/api/sync', { upserts: [{ c: 'trucks', id: tid, d: { num: '4382', miles: 100 } }, { c: 'issues', id: iid, d: { title: 'x', status: 'open' } }], kv: { pti: { [tid]: { '2026-11-16': 'yes' } }, prio: [{ id: 'p1', n: 'High', c: '#f00' }] } });
  ok(r.s === 200, 'sync write'); 
  r = await call('GET', '/api/state'); ok(r.j.DB.trucks.length === 1 && r.j.DB.trucks[0].num === '4382' && r.j.DB.trucks[0].id === tid && r.j.DB.pti[tid]['2026-11-16'] === 'yes' && r.j.S.prio[0].n === 'High', 'state round trip');
  r = await call('POST', '/api/sync', { deletes: [{ c: 'issues', id: iid }] }); r = await call('GET', '/api/state'); ok(r.j.DB.issues.length === 0, 'delete');
  r = await call('POST', '/api/sync', { upserts: [{ c: 'evil; DROP', id: 'a', d: {} }] }); ok(r.s === 400, 'bad collection rejected');
  r = await call('POST', '/api/sync', { upserts: [{ c: 'trucks', id: "a'b", d: {} }] }); ok(r.s === 400, 'bad id rejected');
  r = await call('POST', '/api/sync', { kv: { users: {} } }); ok(r.s === 400, 'bad kv key rejected');
  // weak password / user create / roles
  r = await call('POST', '/api/users', { name: 'Dina', username: 'dina', email: 'dina@example.com', role: 'member', password: 'short' }); ok(r.s === 400 && r.j.error === 'weak', 'weak password refused');
  r = await call('POST', '/api/users', { name: 'Dina', username: 'dina', email: 'dina@example.com', role: 'member', password: 'Blue-Tractor-77' }); ok(r.s === 200, 'create member');
  r = await call('POST', '/api/users', { name: 'Dina2', username: 'dina', email: 'dina2@example.com', role: 'member', password: 'Blue-Tractor-77' }); ok(r.s === 409, 'duplicate user refused');
  r = await call('POST', '/api/users', { name: 'Dr', username: 'drv', email: 'drv@example.com', role: 'driver', password: 'Green-Engine-55' }); ok(r.s === 200, 'create driver');
  const adminJar = jar;
  // member: can write fleet data, cannot touch settings or users
  jar = {}; r = await call('POST', '/api/login', { email: 'dina@example.com', password: 'Blue-Tractor-77' }); ok(r.s === 200 && r.j.user.mustChange, 'member login (must change flagged)');
  r = await call('POST', '/api/sync', { upserts: [{ c: 'trailers', id: 't1', d: { num: 'T-1' } }] }); ok(r.s === 200, 'member writes fleet data');
  r = await call('POST', '/api/sync', { kv: { prio: [] } }); ok(r.s === 403, 'member cannot change settings');
  r = await call('GET', '/api/users'); ok(r.s === 403, 'member cannot list users');
  r = await call('GET', '/api/audit'); ok(r.s === 403, 'member cannot read audit');
  r = await call('POST', '/api/password', { current: 'Blue-Tractor-77', next: 'dina12345678' }); ok(r.s === 400, 'password containing own name refused');
  r = await call('POST', '/api/password', { current: 'Blue-Tractor-77', next: 'Purple-Anchor-42' }); ok(r.s === 200, 'member changes password');
  // driver: no fleet access
  jar = {}; await call('POST', '/api/login', { email: 'drv@example.com', password: 'Green-Engine-55' });
  r = await call('GET', '/api/state'); ok(r.s === 403, 'driver cannot read fleet state');
  // 2FA
  jar = adminJar;
  r = await call('POST', '/api/2fa/start', {}); ok(r.s === 200 && /^[A-Z2-7]{32}$/.test(r.j.secret) && /^otpauth:/.test(r.j.uri), '2fa start');
  const secret = r.j.secret;
  r = await call('POST', '/api/2fa/enable', { code: '000000' }); ok(r.s === 401, '2fa wrong code refused');
  const code = () => C.hotp(secret, Math.floor(Date.now() / 30000));
  r = await call('POST', '/api/2fa/enable', { code: code() }); ok(r.s === 200, '2fa enabled');
  // RFC 6238 test vector (SHA-1, secret "12345678901234567890", T=59 -> 94287082 => 287082)
  const rfc = require('../lib/crypto'); const b32 = s => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const b of Buffer.from(s)) bits += b.toString(2).padStart(8, '0'); let o = ''; for (let i = 0; i < bits.length; i += 5) o += A[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return o; };
  ok(rfc.hotp(b32('12345678901234567890'), 1) === '287082', 'TOTP matches RFC 6238 vector');
  // new login now needs the second step
  jar = {}; r = await call('POST', '/api/login', { email: 'boss@example.com', password: 'Correct-Horse-9!' }); ok(r.s === 200 && r.j.next === 'totp' && !r.j.user, 'login asks for code');
  r = await call('GET', '/api/state'); ok(r.s === 401, 'half-logged-in session has no access');
  r = await call('POST', '/api/login/totp', { code: '123456' }); ok(r.s === 401, 'bad 2fa code refused');
  const pwJar = jar;
  // the code used at enable time must not be replayable
  r = await call('POST', '/api/login/totp', { code: code() }); ok(r.s === 401, 'used code cannot be replayed');
  // lockout after repeated failures
  jar = {}; for (let i = 0; i < 5; i++) await call('POST', '/api/login', { email: 'dina@example.com', password: 'nope-nope-nope-1' });
  r = await call('POST', '/api/login', { email: 'dina@example.com', password: 'Purple-Anchor-42' }); ok(r.s === 429 && r.j.error === 'locked', 'account locks after 5 failures');
  // logout kills the session
  jar = adminJar; r = await call('POST', '/api/logout', {}); r = await call('GET', '/api/me', undefined, { jar: adminJar }); ok(r.s === 401, 'logout invalidates session');
  // audit has history (login again with 2FA)
  jar = {}; await call('POST', '/api/login', { email: 'boss@example.com', password: 'Correct-Horse-9!' });
  await new Promise(z => setTimeout(z, 100));
  // wait to next step window so the code differs from the one consumed at enable
  const waitStep = () => new Promise(z => setTimeout(z, 30500 - (Date.now() % 30000)));
  await waitStep();
  r = await call('POST', '/api/login/totp', { code: code() }); ok(r.s === 200 && r.j.user, '2fa login with a fresh code');
  r = await call('GET', '/api/audit'); ok(r.s === 200 && r.j.rows.some(x => x.action === 'login.fail') && r.j.rows.some(x => x.action === 'sync'), 'audit log records events');
  // file upload
  const pdf = Buffer.from('%PDF-1.4\n%test\n');
  r = await call('POST', '/api/files', pdf, { raw: true, ct: 'application/pdf', headers: { 'X-Filename': 'a b.pdf' } }); ok(r.s === 200 && r.j.id, 'pdf upload');
  const fid = r.j && r.j.id;
  r = await call('POST', '/api/files', Buffer.from('<script>alert(1)</script>'), { raw: true, ct: 'application/pdf' }); ok(r.s === 400, 'fake pdf refused');
  r = await call('GET', '/api/files/' + fid); ok(r.s === 200 && r.h['content-type'] === 'application/pdf', 'file download when logged in');
  r = await call('GET', '/api/files/' + fid, undefined, { jar: {} }); ok(r.s === 401, 'file download needs login');
  // ---- v2: profile edit, company scope, routes
  const admJ = jar;
  r = await call('PATCH', '/api/me', { prefs: { sz: { fz: 500, mz: 10, pz: 90 } } }); ok(r.s === 200 && r.j.user.prefs.sz.fz === 150 && r.j.user.prefs.sz.mz === 50 && r.j.user.prefs.sz.pz === 90, 'prefs sz clamped and saved');
  r = await call('GET', '/api/me'); ok(r.j.user.prefs.sz.pz === 90, 'prefs sz persisted');
  r = await call('PATCH', '/api/me', { prefs: { sz: { fz: 100, mz: 100, pz: 100 } } }); ok(r.s === 200 && r.j.user.prefs.sz.fz === 100, 'prefs sz reset');
  r = await call('PATCH', '/api/me', { name: 'Boss Man', username: 'bossman' }); ok(r.s === 200 && r.j.user.name === 'Boss Man' && r.j.user.username === 'bossman', 'PATCH /api/me name+username');
  r = await call('PATCH', '/api/me', { username: 'a b!' }); ok(r.s === 400, 'bad username refused');
  r = await call('PATCH', '/api/me', { email: 'new@example.com' }); ok(r.s === 200 && r.j.user.email === 'new@example.com' && r.j.user.emailOk === false && r.j.email === 'applied', 'email change needs no password (unconfirmed while mail is not set up)');
  r = await call('PATCH', '/api/me', { email: 'boss2@example.com' }); ok(r.s === 200 && r.j.user.email === 'boss2@example.com', 'email change again');
  r = await call('PATCH', '/api/me', { tg: '@Cool_User1' }); ok(r.s === 200 && r.j.user.tg === 'Cool_User1', 'telegram username saved without @');
  r = await call('PATCH', '/api/me', { tg: 'a b' }); ok(r.s === 400, 'bad telegram username refused');
  r = await call('PATCH', '/api/me', { color: '#12ab34' }); ok(r.s === 200 && r.j.user.color === '#12ab34', 'own colour');
  r = await call('POST', '/api/sync', { kv: { comps: [{ id: 'cA', n: 'A', c: '#111111' }, { id: 'cB', n: 'B', c: '#222222' }] }, upserts: [{ c: 'trucks', id: 'tA', d: { num: '1', company: 'cA' } }, { c: 'trucks', id: 'tB', d: { num: '2', company: 'cB' } }, { c: 'drivers', id: 'dB', d: { name: 'Zed', truck: 'tB' } }, { c: 'drivers', id: 'dA', d: { name: 'Amy', truck: 'tA' } }] }); ok(r.s === 200, 'admin seeds two companies');
  r = await call('POST', '/api/users', { name: 'Cora', username: 'cora', email: 'cora@example.com', role: 'member', password: 'Purple-Anchor-42', companies: ['cA'], test: true }); ok(r.s === 200, 'create company-restricted user');
  jar = {}; r = await call('POST', '/api/login', { email: 'cora@example.com', password: 'Purple-Anchor-42' }); ok(r.s === 200, 'restricted user logs in');
  r = await call('GET', '/api/state'); ok(r.s === 200 && r.j.DB.trucks.length === 1 && r.j.DB.trucks[0].id === 'tA', 'restricted user sees only own company trucks');
  ok(r.j.DB.drivers.length === 1 && r.j.DB.drivers[0].id === 'dA', 'restricted user sees only own drivers');
  ok(r.j.user.companies && r.j.user.companies[0] === 'cA' && r.j.team.some(x => x.test), 'user carries company list; team flags test');
  r = await call('POST', '/api/sync', { upserts: [{ c: 'trucks', id: 'tX', d: { num: '9', company: 'cB' } }] }); ok(r.s === 403, 'cannot write truck into other company');
  r = await call('POST', '/api/sync', { upserts: [{ c: 'trucks', id: 'tB', d: { num: '2', company: 'cA' } }] }); ok(r.s === 403, 'cannot steal another company truck');
  r = await call('POST', '/api/sync', { deletes: [{ c: 'trucks', id: 'tB' }] }); ok(r.s === 403, 'cannot delete another company truck');
  r = await call('POST', '/api/sync', { upserts: [{ c: 'trucks', id: 'tA', d: { num: '1', company: 'cA', note: 'ok' } }] }); ok(r.s === 200, 'can edit own truck');
  r = await call('POST', '/api/sync', { kv: { comps: [] } }); ok(r.s === 403, 'member cannot change companies');
  jar = admJ; r = await call('GET', '/api/state'); ok(r.s === 200 && r.j.DB.trucks.some(x => x.id === 'tB') && r.j.DB.trucks.some(x => x.id === 'tA'), 'admin still sees everything');
  r = await call('GET', '/dashboard', undefined, { jar: {} }); ok(r.s === 200 && /<html/i.test(r.b), 'SPA route /dashboard');
  r = await call('GET', '/fleet', undefined, { jar: {} }); ok(r.s === 200, 'SPA route /fleet');
  r = await call('GET', '/nope', undefined, { jar: {} }); ok(r.s === 404, 'unknown path is 404');
  jar = admJ; r = await call('PATCH', '/api/me', { prefs: { theme: 'forest', lang: 'uz' } }); ok(r.s === 200 && r.j.user.prefs.theme === 'forest' && r.j.user.prefs.lang === 'uz', 'theme and language are saved on the account');
  r = await call('PATCH', '/api/me', { prefs: { theme: 'evil', lang: 'xx' } }); ok(r.s === 200 && r.j.user.prefs.theme === 'forest', 'invalid theme is ignored');
  r = await call('GET', '/api/me'); ok(r.s === 200 && r.j.user.prefs.theme === 'forest' && r.j.user.prefs.lang === 'uz', 'saved theme comes with the account (any device)');
  jar = admJ;
  // profile photos + owner can block them
  const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AB//Z';
  jar = admJ; r = await call('POST', '/api/users', { name: 'Ann', username: 'ann', email: 'ann@example.com', role: 'member', password: 'Silver-Rocket-63' }); const annId = r.j.id;
  r = await call('PATCH', '/api/me', { avatar: IMG }); ok(r.s === 200 && /^\/api\/avatar\//.test(r.j.user.avatar), 'owner sets their own photo'); const myAv = r.j.user.avatar;
  { const rr = await call('GET', myAv); ok(rr.s === 200, 'the photo is served as an image from its own address'); }
  r = await call('PATCH', '/api/me', { avatar: 'javascript:alert(1)' }); ok(r.s === 400, 'a non-image photo is refused');
  r = await call('PATCH', '/api/users/' + annId, { avatar: IMG }); ok(r.s === 200, 'owner sets Ann\'s photo');
  r = await call('GET', '/api/state'); ok(/^\/api\/avatar\//.test((r.j.team.find(x => x.u === 'ann') || {}).av || ''), 'everyone sees the photo in the team list');
  jar = {}; r = await call('POST', '/api/login', { email: 'ann@example.com', password: 'Silver-Rocket-63' }); ok(r.s === 200 && r.j.user, 'Ann signs in'); const aJ = jar;
  r = await call('PATCH', '/api/me', { avatar: null }); ok(r.s === 200 && r.j.user.avatar === null, 'Ann can change her own photo');
  r = await call('PATCH', '/api/me', { avatar: IMG }); ok(r.s === 200, 'Ann sets a photo');
  jar = admJ; r = await call('PATCH', '/api/users/' + annId, { avLock: true }); ok(r.s === 200, 'owner blocks Ann from changing her photo');
  jar = aJ; r = await call('PATCH', '/api/me', { avatar: null }); ok(r.s === 403 && r.j.error === 'locked', 'Ann is blocked');
  r = await call('PATCH', '/api/users/' + annId, { avLock: false }); ok(r.s === 403 || r.s === 401, 'a member cannot lift the block herself');
  jar = admJ; r = await call('PATCH', '/api/users/' + annId, { avatar: null }); ok(r.s === 200, 'owner can still change Ann\'s photo');
  r = await call('PATCH', '/api/users/' + annId, { avLock: false }); ok(r.s === 200, 'owner lifts the block');
  // policy: staff sign in only with a code from the OWNER's authenticator
  jar = admJ; r = await call('POST', '/api/users', { name: 'Zed', username: 'zed', email: 'zed@example.com', role: 'member', password: 'Orange-Window-58' }); ok(r.s === 200, 'create user for owner-approval policy');
  const zid = r.j.id;
  r = await call('POST', '/api/2fa/policy', { on: true }); ok(r.s === 200 && r.j.on === true, 'owner turns the policy on');
  r = await call('GET', '/api/state'); ok(r.s === 200, 'owner keeps working');
  const zJ = {}; jar = zJ; r = await call('POST', '/api/login', { email: 'zed@example.com', password: 'Orange-Window-58' }); ok(r.s === 200 && r.j.next === 'totp' && r.j.owner === true && !r.j.user, 'member is asked for the owner\'s code');
  r = await call('GET', '/api/state'); ok(r.s === 401, 'no data before the code');
  r = await call('POST', '/api/login/totp', { code: '000000' }); ok(r.s === 401, 'wrong code refused');
  r = await call('POST', '/api/login/totp', { code: code() }); ok(r.s === 200 && r.j.user && r.j.user.viaOwner === true, 'the owner\'s current code lets the member in');
  r = await call('GET', '/api/state'); ok(r.s === 200, 'data opens after the owner\'s code');
  r = await call('POST', '/api/2fa/policy', { on: false }); ok(r.s === 403, 'a member cannot change the policy');
  jar = admJ; r = await call('GET', '/api/users'); const zu = (r.j.users || []).find(x => x.username === 'zed'); ok(zu && zu.online >= 1 && zu.lastIp !== undefined, 'owner sees that Zed is online');
  r = await call('POST', '/api/users/' + zid + '/signout', {}); ok(r.s === 200, 'owner signs Zed out');
  jar = zJ; r = await call('GET', '/api/state'); ok(r.s === 401, 'Zed is out');
  jar = admJ; r = await call('POST', '/api/2fa/policy', { on: false }); ok(r.s === 200 && r.j.on === false, 'owner turns the policy off');
  jar = {}; r = await call('POST', '/api/login', { email: 'zed@example.com', password: 'Orange-Window-58' }); ok(r.s === 200 && r.j.user && !r.j.next, 'without the policy Zed signs in with the password only');

  // ---- roles: owner > admin > member ----
  const { q: qq } = require('../lib/db');
  jar = admJ; r = await call('POST', '/api/users', { name: 'Ivy Admin', username: 'ivy', email: 'ivy@example.com', role: 'admin', password: 'Purple-Table-4471' }); ok(r.s === 200, 'owner creates an admin'); const ivyId = r.j.id;
  jar = {}; r = await call('POST', '/api/login', { email: 'ivy@example.com', password: 'Purple-Table-4471' }); const ivyJ = jar; ok(r.s === 200 && r.j.user, 'admin signs in');
  jar = {}; r = await call('POST', '/api/login', { email: 'zed@example.com', password: 'Orange-Window-58' }); const zed2J = jar; ok(r.s === 200, 'member signs in');
  jar = ivyJ; r = await call('GET', '/api/users'); ok(r.s === 200 && !r.j.users.some(u => u.owner) && r.j.users.some(u => u.id === zid) && r.j.users.every(u => u.lastIp === null), 'admin sees members but not the owner, no IPs');
  jar = zed2J; r = await call('GET', '/api/users'); ok(r.s === 403, 'member sees nobody');
  jar = ivyJ; r = await call('PATCH', '/api/users/' + zid, { name: 'Zed Z' }); ok(r.s === 403, 'admin cannot edit members until the owner allows it');
  r = await call('PATCH', '/api/users/' + ivyId, { permEdit: true }); ok(r.s === 403, 'admin cannot give herself the right');
  jar = admJ; r = await call('PATCH', '/api/users/' + zid, { permEdit: true }); ok(r.s === 403, 'permission applies to admins only');
  r = await call('PATCH', '/api/users/' + ivyId, { permEdit: true }); ok(r.s === 200, 'owner lets Ivy edit members');
  const ownId0 = (await qq('SELECT id FROM users WHERE is_owner')).rows[0].id; jar = ivyJ; r = await call('PATCH', '/api/users/' + zid, { name: 'Zed Z', tg: 'zed_tg1', username: 'zed2' }); ok(r.s === 200, 'admin with the right edits a member');
  r = await call('GET', '/api/users'); const zz = r.j.users.find(u => u.id === zid); ok(zz.name === 'Zed Z' && zz.tg === 'zed_tg1' && zz.username === 'zed2', 'member details changed');
  r = await call('PATCH', '/api/users/' + zid, { role: 'admin' }); ok(r.s === 403, 'admin cannot change roles');
  r = await call('PATCH', '/api/users/' + zid, { disabled: true, name: 'X' }); ok(r.s === 403, 'admin cannot mix block with other role changes');
  r = await call('PATCH', '/api/users/' + zid, { disabled: true }); ok(r.s === 200, 'admin can deactivate a member');
  r = await call('PATCH', '/api/users/' + zid, { disabled: false }); ok(r.s === 200, 'admin can reactivate a member');
  r = await call('PATCH', '/api/users/' + ownId0, { disabled: true }); ok(r.s === 403 || r.s === 400, 'admin cannot deactivate the owner');
  r = await call('POST', '/api/users/' + zid + '/signout', {}); ok(r.s === 403, 'admin cannot sign people out');
  r = await call('POST', '/api/users/' + zid + '/reset', { password: 'Another-Long-Pass-77' }); ok(r.s === 403, 'admin cannot reset passwords');
  r = await call('DELETE', '/api/users/' + zid); ok(r.s === 403, 'only the owner can delete');
  const ownId = (await qq('SELECT id FROM users WHERE is_owner')).rows[0].id;
  r = await call('PATCH', '/api/users/' + ownId, { name: 'Hacked' }); ok(r.s === 403, 'admin cannot touch the owner');
  r = await call('POST', '/api/users', { name: 'Kai', username: 'kai1', email: 'kai@example.com', role: 'admin', password: 'Yellow-Garden-6620' }); ok(r.s === 403, 'admin cannot create admins');
  r = await call('POST', '/api/users', { name: 'Kai', username: 'kai1', email: 'kai@example.com', role: 'member', password: 'Yellow-Garden-6620' }); ok(r.s === 200, 'admin adds a member');
  r = await call('GET', '/api/audit'); ok(r.s === 403, 'admin cannot open the activity log');
  jar = {}; await call('POST', '/api/login', { email: 'zed@example.com', password: 'Orange-Window-58' }); const zed3J = jar;
  jar = zed3J; r = await call('GET', '/api/audit'); ok(r.s === 403, 'member cannot open the activity log');
  r = await call('POST', '/api/invites', { email: 'x@example.com' }); ok(r.s === 403, 'member cannot invite');
  jar = admJ; r = await call('GET', '/api/audit'); ok(r.s === 200 && r.j.rows.length > 5, 'owner opens the whole log');
  // ---- invites ----
  r = await call('POST', '/api/invites', { email: 'newbie@example.com', role: 'admin' }); ok(r.s === 200 && /\/invite\/[A-Za-z0-9_-]{20,}$/.test(r.j.link) && r.j.role === 'admin', 'owner creates an admin invite'); const tok = r.j.link.split('/invite/')[1], invId = r.j.id;
  r = await call('POST', '/api/invites', { email: 'newbie@example.com', role: 'member' }); ok(r.s === 200, 'inviting again replaces the old link'); const tok2 = r.j.link.split('/invite/')[1];
  jar = {}; r = await call('GET', '/api/invite/' + tok); ok(r.s === 404, 'the replaced link is dead');
  r = await call('GET', '/api/invite/' + tok2); ok(r.s === 200 && r.j.email === 'newbie@example.com' && r.j.role === 'member', 'invite details are public by token');
  r = await call('POST', '/api/invite/' + tok2 + '/accept', { name: 'Newbie', password: 'newbie1234' }); ok(r.s === 400 && r.j.error === 'weak', 'weak password refused on the invite page');
  r = await call('POST', '/api/invite/' + tok2 + '/accept', { name: 'Newbie', password: 'Tangerine-Moon-91' }); ok(r.s === 200, 'invited person joins');
  r = await call('POST', '/api/invite/' + tok2 + '/accept', { name: 'Again', password: 'Tangerine-Moon-91' }); ok(r.s === 404, 'the link works once');
  jar = {}; r = await call('POST', '/api/login', { email: 'newbie@example.com', password: 'Tangerine-Moon-91' }); ok(r.s === 200 && r.j.user.role === 'member' && r.j.user.name === 'Newbie', 'invited person signs in with the email');
  jar = ivyJ; r = await call('POST', '/api/invites', { email: 'second@example.com', role: 'admin' }); ok(r.s === 200 && r.j.role === 'member', 'an admin can only invite members');
  const ivId2 = r.j.id; r = await call('GET', '/api/invites'); ok(r.s === 200 && r.j.invites.some(x => x.id === ivId2), 'pending invites are listed');
  r = await call('POST', '/api/invites', { email: 'zed@example.com' }); ok(r.s === 409, 'cannot invite an existing email');
  r = await call('DELETE', '/api/invites/' + ivId2); ok(r.s === 200, 'invite cancelled');
  r = await call('GET', '/api/invites'); ok(!r.j.invites.some(x => x.id === ivId2), 'cancelled invite is gone');
  // ---- email confirmation link ----
  await qq("UPDATE users SET pend_email='zed.new@example.com', pend_tok=$1, pend_exp=now()+interval '1 day' WHERE id=$2", [C.sha('verifytoken1234567890abc'), zid]);
  jar = {}; r = await call('GET', '/verify/nonsense'); ok(r.s === 302 && /email=bad/.test(r.h.location), 'bad confirmation link');
  r = await call('GET', '/verify/verifytoken1234567890abc'); ok(r.s === 302 && /email=ok/.test(r.h.location), 'confirmation link accepted');
  const zrow = (await qq('SELECT email,email_ok,pend_email FROM users WHERE id=$1', [zid])).rows[0]; ok(zrow.email === 'zed.new@example.com' && zrow.email_ok === true && !zrow.pend_email, 'email changed after confirming');
  // ---- priorities: owner only, unless the owner allows a person ----
  const PR = [{ id: 'p1', n: 'High', c: '#ef4444' }, { id: 'p2', n: 'Low', c: '#22c55e' }];
  jar = ivyJ; r = await call('POST', '/api/sync', { kv: { prio: PR } }); ok(r.s === 403, 'an admin cannot edit priorities by default');
  jar = zed3J; r = await call('POST', '/api/sync', { kv: { prio: PR } }); ok(r.s === 403, 'a member cannot edit priorities by default');
  r = await call('POST', '/api/sync', { kv: { prioEd: [zid] } }); ok(r.s === 403, 'a member cannot grant the right');
  jar = ivyJ; r = await call('POST', '/api/sync', { kv: { prioEd: [zid] } }); ok(r.s === 403, 'an admin cannot grant the right');
  jar = admJ; r = await call('POST', '/api/sync', { kv: { prio: PR } }); ok(r.s === 200, 'owner edits priorities');
  r = await call('POST', '/api/sync', { kv: { prioEd: [zid, 'bad id!'] } }); ok(r.s === 400, 'bad editor list refused');
  r = await call('POST', '/api/sync', { kv: { prioEd: [zid] } }); ok(r.s === 200, 'owner allows Zed to edit priorities');
  jar = zed3J; r = await call('POST', '/api/sync', { kv: { prio: [{ id: 'p1', n: 'Urgent', c: '#ef4444' }, PR[1]] } }); ok(r.s === 200, 'allowed member edits priorities');
  r = await call('GET', '/api/state'); ok(r.j.S.prio[0].n === 'Urgent' && r.j.S.prioEd.includes(zid), 'everyone reads the same priorities and the editor list');
  jar = ivyJ; r = await call('POST', '/api/sync', { kv: { prio: PR } }); ok(r.s === 403, 'a person who was not allowed is still blocked');
  jar = admJ; r = await call('POST', '/api/sync', { kv: { prioEd: [] } }); ok(r.s === 200, 'owner takes the right back');
  jar = zed3J; r = await call('POST', '/api/sync', { kv: { prio: PR } }); ok(r.s === 403, 'Zed is blocked again');
  // ---- companies + teams: owner only, unless allowed ----
  const TM = [{ id: 'tmA', n: 'Team A', resp: zid, cos: ['cA'] }];
  jar = ivyJ; r = await call('POST', '/api/sync', { kv: { teams: TM } }); ok(r.s === 403, 'an admin cannot edit teams by default');
  r = await call('POST', '/api/sync', { kv: { comps: [{ id: 'cA', n: 'A', c: '#111111' }] } }); ok(r.s === 403, 'an admin cannot edit companies by default');
  jar = admJ; r = await call('POST', '/api/sync', { kv: { teams: [{ id: 'x', n: 'T', cos: ['bad id!'] }] } }); ok(r.s === 400, 'bad team data refused');
  r = await call('POST', '/api/sync', { kv: { teams: TM } }); ok(r.s === 200, 'owner saves a team');
  jar = zed3J; r = await call('POST', '/api/sync', { kv: { teams: [] } }); ok(r.s === 403, 'a member cannot edit teams by default');
  jar = admJ; r = await call('POST', '/api/sync', { kv: { compEd: [zid] } }); ok(r.s === 200, 'owner allows Zed to edit companies and teams');
  jar = zed3J; r = await call('POST', '/api/sync', { kv: { teams: [{ id: 'tmA', n: 'Team A', resp: zid, cos: ['cA', 'cB'] }] } }); ok(r.s === 200, 'allowed member edits teams');
  r = await call('POST', '/api/sync', { kv: { compEd: [] } }); ok(r.s === 403, 'allowed member cannot change the list');
  r = await call('GET', '/api/state'); ok(r.j.S.teams[0].cos.length === 2 && r.j.S.compEd.includes(zid), 'everyone reads the teams');
  jar = admJ; r = await call('POST', '/api/sync', { kv: { compEd: [] } }); ok(r.s === 200, 'owner takes the right back');
  console.log(errs.length ? `\n${errs.length} FAILED of ${n}` : `\nALL ${n} CHECKS PASSED`);
  srv.close(); await pg.stop(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
