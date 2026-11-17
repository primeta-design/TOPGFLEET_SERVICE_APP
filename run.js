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
  console.log(errs.length ? `\n${errs.length} FAILED of ${n}` : `\nALL ${n} CHECKS PASSED`);
  srv.close(); await pg.stop(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
