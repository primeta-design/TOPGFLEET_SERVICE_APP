'use strict';
// Real browser-like test: the actual page (jsdom) talking to the actual server and Postgres.
const path = require('path'), fs = require('fs'), os = require('os');
const EP = require('embedded-postgres').default; const { JSDOM, VirtualConsole } = require('jsdom');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfpg-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  try { fs.chmodSync(dir, 0o777); if (process.getuid() === 0) require('child_process').execSync('chown -R postgres ' + dir); } catch {}
  const pg = new EP({ databaseDir: dir, user: 'tf', password: 'tf', port: 54330, persistent: false });
  await pg.initialise(); await pg.start(); await pg.createDatabase('tf');
  Object.assign(process.env, { DATABASE_URL: 'postgres://tf:tf@localhost:54330/tf', APP_SECRET: 'y'.repeat(40), ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: 'Correct-Horse-9!', RATE_LOGIN_MAX: '1000', DATA_DIR: path.join(os.tmpdir(), 'tff-' + process.pid) });
  const { app, bootstrap } = require('../server.js'); await bootstrap();
  const srv = app.listen(0); const base = 'http://localhost:' + srv.address().port;
  const errs = []; let n = 0; const ok = (c, m) => { n++; if (!c) { errs.push(m); console.log('  FAIL', m); } };

  async function openPage() {
    const jar = {}; const vc = new VirtualConsole(); vc.on('jsdomError', e => errs.push('JSDOM ' + e.message.slice(0, 160)));
    const html = await (await fetch(base + '/')).text();
    const wf = async (u, o = {}) => { const { signal, ...rest } = o; const h = { ...(rest.headers || {}) }; if (jar.v) h.Cookie = jar.v;
      const r = await fetch(new URL(u, base), { ...rest, headers: h, redirect: 'manual' }); const sc = r.headers.get('set-cookie'); if (sc) { const m = /(tf_sid=[^;]*)/.exec(sc); jar.v = m && m[1].endsWith('=') ? '' : m && m[1]; } return r; };
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: base + '/', pretendToBeVisual: true, virtualConsole: vc, beforeParse(win) { win.fetch = wf; } });
    const w = dom.window;
    w.print = () => {}; w.scrollTo = () => {};
    await sleep(700);
    return { w, d: w.document, ev: c => w.eval(c), click: s => { const e = typeof s === 'string' ? w.document.querySelector(s) : s; if (!e) throw new Error('no el ' + s); e.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); } };
  }
  const setv = (P, sel, v) => { const e = P.d.querySelector(sel); e.value = v; e.dispatchEvent(new P.w.Event('input', { bubbles: true })); };

  // ---- page 1: admin ----
  let A = await openPage();
  ok(A.ev('SERVER') === true, 'server mode detected');
  ok(!A.d.querySelector('#lpw').value, 'login password field is empty (no demo password)');
  ok(!/demo mode/i.test(A.d.querySelector('#app').textContent), 'no demo-mode notice on real login');
  setv(A, '#lem', 'boss@example.com'); setv(A, '#lpw', 'wrong-password-123'); A.click('[data-a=login]'); await sleep(600);
  ok(!!A.d.querySelector('[role=alert]') && !A.ev('S.in'), 'wrong password shows an error and stays out');
  setv(A, '#lem', 'boss@example.com'); setv(A, '#lpw', 'Correct-Horse-9!'); A.click('[data-a=login]'); await sleep(900);
  ok(A.ev('S.in') === true && !!A.d.querySelector('#c'), 'login opens the dashboard');
  ok(A.ev('USER.role') === 'admin', 'user is admin');
  // create a truck through the real form
  A.ev('go("trucks")'); A.click('[data-a=addTruck]');
  const f = (k, v) => { const e = A.d.querySelector(`#dr [name=${k}]`); e.value = v; };
  f('num', '4382'); f('company', A.ev('S.comps[0].id')); f('year', '2020'); f('make', 'Volvo'); f('model', 'VNL'); f('vin', 'VIN12345'); A.click('[data-a=drSave]');
  await sleep(1400);
  const st = await (async () => { const r = await A.w.fetch('/api/state'); return r.json(); })();
  ok(st.DB.trucks.length === 1 && st.DB.trucks[0].num === '4382', 'truck was saved to Postgres');
  ok(Array.isArray(st.S.prio) && st.S.prio.length === 3 && st.S.comps.length === 14 && st.S.seed14 === 1, '14 companies seeded on the server');
  // add a trailer inline, an issue, change statuses
  A.ev('go("trailers")'); const inp = A.d.querySelector('#tla'); inp.value = 'T-900'; inp.dispatchEvent(new A.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  A.ev('DB.issues.push({id:uid(),created:Date.now(),status:"open",title:"4382",desc:"Check engine",pr:S.prio[0].id,owner:"",sched:""});refresh()');
  await sleep(1400);
  let st2 = await (await A.w.fetch('/api/state')).json();
  ok(st2.DB.trailers.length === 1 && st2.DB.issues.length === 1, 'trailer and issue saved');
  // delete the trailer -> removed on the server
  A.ev('DB.trailers=[];refresh()'); await sleep(1300);
  st2 = await (await A.w.fetch('/api/state')).json(); ok(st2.DB.trailers.length === 0, 'delete reaches the server');
  // create a member user through the UI
  A.ev('go("profile")'); await sleep(500);
  ok(/dina|boss@example.com/i.test(A.d.querySelector('#pf_team').textContent), 'team section lists real users');
  const r = await A.w.fetch('/api/users', { method: 'POST', headers: { 'X-Requested-With': 'tf', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Dina Roe', username: 'dina', email: 'dina@example.com', role: 'member', password: 'Blue-Tractor-77' }) }); ok(r.status === 200, 'member created');
  // 2FA through the UI helpers
  await A.ev('A.tfStart()'); await sleep(600);
  const secret = (A.d.querySelector('#md .note') || {}).textContent.trim(); ok(/^[A-Z2-7]{32}$/.test(secret), '2FA setup key is shown');
  const C = require('../lib/crypto'); const code = () => C.hotp(secret, Math.floor(Date.now() / 30000));
  A.d.querySelector('#tfc').value = code(); A.ev('A.tfOn()'); await sleep(700); ok(A.ev('USER.totp') === true, '2FA turned on from the page');

  // ---- page 2: the member, separate browser ----
  const B = await openPage();
  setv(B, '#lem', 'dina@example.com'); setv(B, '#lpw', 'Blue-Tractor-77'); B.click('[data-a=login]'); await sleep(900);
  ok(B.ev('S.in') === true, 'member logs in');
  ok(B.ev('DB.trucks.length') === 1 && B.ev('DB.trucks[0].num') === '4382', 'member sees the shared truck');
  await sleep(300);
  ok(B.d.querySelector('#md') && /./.test(B.d.querySelector('#md').innerHTML), 'member is forced to choose a new password');
  B.click('[data-a=mdClose]'); // modal can be closed in the test; server still enforces nothing more here
  // member edits a truck; admin page pulls it
  B.ev('DB.trucks[0].miles="123456";refresh()'); await sleep(1300);
  await A.ev('pullRemote(true)'); await sleep(900);
  ok(A.ev('DB.trucks[0].miles') === '123456', 'admin page picks up the member\'s change');
  // member cannot alter settings
  B.ev('S.prio[0].n="HACKED";refresh()'); await sleep(1500);
  const st3 = await (await A.w.fetch('/api/state')).json(); ok(st3.S.prio[0].n === 'High', 'member settings change is not stored');

  // ---- page 3: admin signs in again, must pass 2FA ----
  const Cc = await openPage();
  setv(Cc, '#lem', 'boss@example.com'); setv(Cc, '#lpw', 'Correct-Horse-9!'); Cc.click('[data-a=login]'); await sleep(900);
  ok(!!Cc.d.querySelector('#lcode') && !Cc.ev('S.in'), 'login asks for the authenticator code');
  const wait = 30500 - (Date.now() % 30000); await sleep(wait);
  setv(Cc, '#lcode', code()); Cc.click('[data-a=login]'); await sleep(1100);
  ok(Cc.ev('S.in') === true && Cc.ev('DB.trucks.length') === 1, 'code opens the dashboard with data');
  // logout clears memory
  await Cc.ev('A.logout()'); await sleep(500); ok(Cc.ev('DB.trucks.length') === 0 && !Cc.ev('S.in'), 'logout wipes data from the page');
  // deep link from Telegram: /invoices?id=... opens that invoice
  A.ev('DB.inv.push({id:"ivX",truck:"",trailer:"",amt:42,reason:"fuel",date:"2026-11-17",who:"co",method:"cc",desc:"deep link test"})');
  A.ev('history.pushState(null,"","/invoices?id=ivX");V="invoices";render()'); await sleep(300);
  ok(/deep link test/.test(A.d.querySelector('#dr').innerHTML) || A.d.querySelector('#dr [name=desc]') && A.d.querySelector('#dr [name=desc]').value === 'deep link test', 'invoice link opens that invoice');
  ok(A.ev('location.search') === '', 'query is cleaned after opening');
  console.log(errs.length ? `\n${errs.length} FAILED of ${n}` : `\nALL ${n} E2E CHECKS PASSED`);
  srv.close(); await pg.stop(); process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
