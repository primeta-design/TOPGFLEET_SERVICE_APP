'use strict';
// Samsara integration with a fake Samsara API (no network): keys sealed on the server, GET-only, vehicles, mileage, find, safety events, UI.
const path = require('path'), fs = require('fs'), os = require('os');
const EP = require('embedded-postgres').default; const { JSDOM, VirtualConsole } = require('jsdom');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfpgT-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GOOD = 'samsara_api_GOODTOKEN1234567890abcd', SCOPELESS = 'samsara_api_NOSCOPE1234567890abcdef';
const CALLS = []; let ODO = 160934400;   // 100,000 mi in meters
const realFetch = global.fetch;
global.fetch = async (u, o = {}) => {
  const url = String(u);
  if (url.startsWith('https://api.samsara.com/') || url.startsWith('https://api.eu.samsara.com/')) {
    const auth = (o.headers || {}).Authorization || ''; CALLS.push({ url, method: o.method || 'GET', auth });
    const J = (st, body) => ({ ok: st < 400, status: st, json: async () => body });
    if (auth !== 'Bearer ' + GOOD && auth !== 'Bearer ' + SCOPELESS) return J(401, { message: 'Unauthorized' });
    const p = new URL(url);
    if (p.pathname === '/fleet/vehicles') {
      if (!p.searchParams.get('after')) return J(200, { data: [{ id: '281474', name: '1965', vin: '3akjhhdr2nsna6660', make: 'Freightliner', model: 'Cascadia', year: '2022', licensePlate: 'P1345928' }, { id: '281475', name: '777', vin: '1XKYD49X0LJ999999', make: 'Kenworth', model: 'T680', year: '2020', licensePlate: 'K777' }], pagination: { endCursor: 'c2', hasNextPage: true } });
      return J(200, { data: [{ id: '281476', name: '4382', vin: '4V4NC9EH7MN283746', make: 'Volvo', model: 'VNL', year: '2021' }], pagination: { endCursor: '', hasNextPage: false } });
    }
    if (p.pathname === '/fleet/vehicles/stats') { if (auth === 'Bearer ' + SCOPELESS) return J(403, { message: 'forbidden' });
      return J(200, { data: [{ id: '281474', name: '1965', obdOdometerMeters: { time: '2026-11-25T15:00:00Z', value: ODO }, gps: { latitude: 41.52, longitude: -88.08, time: '2026-11-25T15:00:00Z', reverseGeo: { formattedLocation: 'Joliet, IL' } } }, { id: '281476', name: '4382', gpsOdometerMeters: { time: '2026-11-25T15:00:00Z', value: 321868800 } }], pagination: { endCursor: '', hasNextPage: false } }); }
    if (p.pathname === '/fleet/safety-events') return J(200, { data: [{ id: 'ev1', time: '2026-11-24T14:03:00.000Z', vehicle: { id: '281474', name: '1965' }, driver: { id: 'd1', name: 'Ali Karimov' }, behaviorLabels: [{ label: 'harshBrake', name: 'Harsh Brake', source: 'automated' }], location: { latitude: 41.5, longitude: -88.1 }, maxAccelerationGForce: 0.52, downloadForwardVideoUrl: 'https://cdn.samsara.com/v.mp4' }], pagination: { endCursor: '', hasNextPage: false } });
    return J(404, {});
  }
  return realFetch(u, o);
};
(async () => {
  try { fs.chmodSync(dir, 0o777); if (process.getuid() === 0) require('child_process').execSync('chown -R postgres ' + dir); } catch {}
  const pg = new EP({ databaseDir: dir, user: 'tf', password: 'tf', port: 54334, persistent: false });
  await pg.initialise(); await pg.start(); await pg.createDatabase('tf');
  Object.assign(process.env, { DATABASE_URL: 'postgres://tf:tf@localhost:54334/tf', APP_SECRET: 'q'.repeat(40), ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: 'Correct-Horse-9!', RATE_LOGIN_MAX: '1000', DATA_DIR: path.join(os.tmpdir(), 'tffT-' + process.pid) });
  const { app, bootstrap } = require('../server.js'); await bootstrap();
  const srv = app.listen(0); const base = 'http://localhost:' + srv.address().port;
  const errs = []; let n = 0; const ok = (c, m) => { n++; if (!c) { errs.push(m); console.log('  FAIL', m); } };
  async function openPage(p = '/') {
    const jar = {}; const vc = new VirtualConsole(); vc.on('jsdomError', e => errs.push('JSDOM ' + e.message.slice(0, 200)));
    const html = await (await realFetch(base + p)).text();
    const wf = async (u, o = {}) => { const { signal, ...rest } = o; const h = { ...(rest.headers || {}) }; if (jar.v) h.Cookie = jar.v; const r = await realFetch(new URL(u, base), { ...rest, headers: h, redirect: 'manual' }); const sc = r.headers.get('set-cookie'); if (sc) { const m = /(tf_sid=[^;]*)/.exec(sc); jar.v = m && m[1].endsWith('=') ? '' : m && m[1]; } return r; };
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: base + p, pretendToBeVisual: true, virtualConsole: vc, beforeParse(win) { win.fetch = wf; win.print = () => {}; win.scrollTo = () => {}; } });
    const w = dom.window; await sleep(800);
    return { w, d: w.document, ev: c => w.eval(c), click: s => { const e = typeof s === 'string' ? w.document.querySelector(s) : s; if (!e) throw new Error('no el ' + s); e.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); } };
  }
  const setv = (P, sel, v) => { const e = P.d.querySelector(sel); e.value = v; e.dispatchEvent(new P.w.Event('input', { bubbles: true })); };
  const J = async (P, m, u, b) => { const r = await P.w.fetch(u, { method: m, headers: { 'X-Requested-With': 'tf', 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, j }; };

  const A = await openPage(); setv(A, '#lem', 'boss@example.com'); setv(A, '#lpw', 'Correct-Horse-9!'); A.click('[data-a=login]'); await sleep(1100);
  ok(A.ev('S.in') === true, 'logged in');
  const c0 = A.ev('S.comps[0].id'), c1 = A.ev('S.comps[1].id');
  A.ev(`DB.trucks.push({id:"t1",num:"1965",company:"${c0}",status:S.stat[0].id,vin:"3AKJHHDR2NSNA6660",year:2022,make:"Freightliner",model:"Cascadia",miles:"529"},{id:"t2",num:"4382",company:"${c0}",status:S.stat[0].id,vin:"",year:2021,make:"Volvo",model:"VNL"});refresh()`); await sleep(1400);

  // ---- adding an account: checked against Samsara, sealed, never shown again ----
  let r = await J(A, 'POST', '/api/telem', { p: 'samsara', n: 'ESL Samsara', key: 'samsara_api_WRONGTOKEN123456789012', co: c0 }); ok(r.s === 400 && r.j.error === 'key', 'a wrong token is refused (key)');
  r = await J(A, 'POST', '/api/telem', { p: 'samsara', n: 'X', key: 'short' }); ok(r.s === 400 && r.j.error === 'bad', 'a short token is refused');
  r = await J(A, 'POST', '/api/telem', { p: 'motive', n: 'M', key: GOOD }); ok(r.s === 400 && r.j.error === 'soon', 'Motive says coming soon');
  r = await J(A, 'POST', '/api/telem', { p: 'samsara', n: 'ESL Samsara', key: GOOD, co: c0 });
  ok(r.s === 200 && r.j.account.cnt === 3 && r.j.account.last4 === 'abcd' && !('key' in r.j.account), 'a good token is checked (3 vehicles over 2 pages) and saved');
  const accId = r.j.account.id;
  const st = await (await A.w.fetch('/api/state')).text(); ok(!st.includes(GOOD) && !st.includes('GOODTOKEN'), 'the token is not in /api/state');
  const { q } = require('../lib/db'); const raw = JSON.stringify((await q("SELECT value FROM kv WHERE key='telem'")).rows[0].value); ok(!raw.includes(GOOD) && /"key":"[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+"/.test(raw), 'the token is stored sealed, not in plain text');
  r = await J(A, 'GET', '/api/telem'); ok(r.s === 200 && r.j.accounts.length === 1 && !JSON.stringify(r.j).includes('GOODTOKEN'), 'account list never carries the token');
  r = await J(A, 'POST', '/api/sync', { kv: { telem: [] } }); ok(r.s === 400 || r.s === 403, 'the site cannot overwrite the stored keys through sync');
  ok(CALLS.every(c => c.method === 'GET'), 'only GET requests go to Samsara (read-only)');

  // ---- vehicles / find / mileage ----
  r = await J(A, 'GET', '/api/telem/vehicles');
  ok(r.s === 200 && r.j.vehicles.length === 3 && r.j.vehicles.find(v => v.name === '1965').truck === 't1' && r.j.vehicles.find(v => v.name === '4382').truck === 't2' && !r.j.vehicles.find(v => v.name === '777').truck, 'vehicles are matched to trucks by VIN or unit number');
  ok(r.j.vehicles.find(v => v.name === '1965').mi === 100000, 'odometer meters become miles');
  r = await J(A, 'GET', '/api/telem/find?q=777'); ok(r.s === 200 && r.j.matches[0].vin === '1XKYD49X0LJ999999' && r.j.matches[0].make === 'Kenworth', 'find by unit number');
  r = await J(A, 'GET', '/api/telem/find?q=LJ999999'); ok(r.s === 200 && r.j.matches[0].name === '777', 'find by the end of the VIN');
  r = await J(A, 'POST', '/api/telem/sync-miles', {}); ok(r.s === 200 && r.j.updated === 2 && r.j.unmatched === 1, 'sync mileage updates the matched trucks (' + JSON.stringify(r.j) + ')');
  let s2 = await J(A, 'GET', '/api/state'); let t1 = s2.j.DB.trucks.find(x => x.id === 't1'), t2 = s2.j.DB.trucks.find(x => x.id === 't2');
  ok(t1.miles === '100000' && t1.loc === 'Joliet, IL' && t1.tsid === '281474' && t1.mh[0].src === 'samsara' && t1.mh.some(m => m.mi === 529), 'truck gets miles, location, Samsara id and a history entry (old value kept)');
  ok(t2.miles === '200000', 'GPS odometer is used when there is no OBD one');
  ODO += 16093.44 * 10; r = await J(A, 'POST', '/api/telem/sync-miles', {});
  s2 = await J(A, 'GET', '/api/state'); t1 = s2.j.DB.trucks.find(x => x.id === 't1');
  ok(t1.miles === '100100' && t1.mh.filter(m => m.src === 'samsara').length === 1, 'the same day keeps one Samsara reading (replaced, not piled up)');

  // ---- safety events ----
  r = await J(A, 'GET', '/api/telem/violations?from=2026-11-24T00:00:00Z&to=2026-11-25T00:00:00Z');
  ok(r.s === 200 && r.j.events.length === 1 && r.j.events[0].num === '1965' && r.j.events[0].labels[0] === 'Harsh Brake' && r.j.events[0].driver === 'Ali Karimov', 'safety events come with truck, driver and label');
  r = await J(A, 'GET', '/api/telem/violations?from=2026-01-01T00:00:00Z&to=2026-11-25T00:00:00Z'); ok(r.s === 400, 'more than 31 days is refused');

  // ---- who may do what ----
  await J(A, 'POST', '/api/users', { name: 'Cora', username: 'cora', email: 'cora@example.com', role: 'member', password: 'Purple-Anchor-42', companies: [c1] });
  await J(A, 'POST', '/api/users', { name: 'Mia', username: 'mia', email: 'mia@example.com', role: 'member', password: 'Silver-Pencil-3380', companies: [c0] });
  const M = await openPage(); setv(M, '#lem', 'cora@example.com'); setv(M, '#lpw', 'Purple-Anchor-42'); M.click('[data-a=login]'); await sleep(1100);
  r = await J(M, 'POST', '/api/telem', { p: 'samsara', n: 'Mine', key: GOOD }); ok(r.s === 403, 'a member without Integrations access cannot add a key');
  r = await J(M, 'GET', '/api/telem'); ok(r.s === 200 && r.j.accounts.length === 0, 'a member of another company does not see the account');
  r = await J(M, 'GET', '/api/telem/vehicles'); ok(r.s === 200 && r.j.accounts === 0 && r.j.vehicles.length === 0, '… nor its vehicles');
  const N = await openPage(); setv(N, '#lem', 'mia@example.com'); setv(N, '#lpw', 'Silver-Pencil-3380'); N.click('[data-a=login]'); await sleep(1100);
  r = await J(N, 'GET', '/api/telem/vehicles'); ok(r.s === 200 && r.j.vehicles.length === 3, 'a member of that company can use it');
  r = await J(N, 'POST', `/api/telem/${accId}/test`, {}); ok(r.s === 403, 'but cannot test or change it');

  // ---- the site ----
  A.ev('PG.users=null;go("profile")'); await sleep(900);
  ok(/ESL Samsara/.test(A.d.querySelector('#c').textContent) && /••••abcd/.test(A.d.querySelector('#c').textContent) && /3 vehicles/.test(A.d.querySelector('#c').textContent), 'Profile → Integrations shows the account with its status');
  A.click('[data-a=tmAdd]'); await sleep(150); setv(A, '#tln', 'Bad'); setv(A, '#tlk', 'samsara_api_WRONGTOKEN123456789012'); A.d.querySelector('#tls').click(); await sleep(700);
  ok(!A.d.querySelector('#tlm').classList.contains('hide') && /rejected/.test(A.d.querySelector('#tlm').textContent), 'a wrong token shows a clear message in the form'); A.ev('closeMd()');
  A.ev('go("trucks")'); await sleep(300); A.ev('A.syncV()'); await sleep(900);
  ok(/3 vehicles · 1 not on the site yet/.test(A.d.querySelector('.mdl').textContent) && A.d.querySelectorAll('[data-sv]').length === 1, 'Sync vehicles lists what is new');
  A.d.querySelector('[data-sv]').checked = true; A.d.querySelector('[data-sv]').dispatchEvent(new A.w.Event('change')); A.d.querySelector('#sv_go').click(); await sleep(1500);
  s2 = await J(A, 'GET', '/api/state'); const t7 = s2.j.DB.trucks.find(x => x.num === '777');
  ok(t7 && t7.vin === '1XKYD49X0LJ999999' && t7.company === c0 && t7.tsid === '281475', 'the new truck is added with its Samsara data and company');
  A.ev('openTruck()'); await sleep(150); A.d.querySelector('#trf').value = '4382'; A.ev('A.trFind()'); await sleep(700);
  ok(A.d.querySelector('#dr [name=vin]').value === '4V4NC9EH7MN283746' && A.d.querySelector('#dr [name=make]').value === 'Volvo' && A.d.querySelector('#dr [name=tsid]').value === '281476', 'Find at Samsara fills the Add truck form'); A.ev('closeDr()');
  A.ev('go("violations")'); await sleep(200); A.ev('PG.vp="c";PG.vpA="2026-11-24";PG.vpB="2026-11-24";PG.vrKey=null;vpLoad()'); await sleep(900);
  ok(/Harsh Brake/.test(A.d.querySelector('#c').textContent) && /Ali Karimov/.test(A.d.querySelector('#c').textContent) && !!A.d.querySelector('#c [data-a=tvOpen][data-id=t1]'), 'Violation Report shows the events and opens the truck');
  for (const lg of ['uz', 'ru']) { A.ev(`S.lang="${lg}";page()`); await sleep(150); ok(!/\b(tl_|sv_|sm_|tf_|vr_)[a-z0-9]+\b/.test(A.d.querySelector('#c').textContent), lg + ': no missing translations'); }
  A.ev('S.lang="en"');
  r = await J(A, 'DELETE', '/api/telem/' + accId); r = await J(A, 'GET', '/api/telem'); ok(r.j.accounts.length === 0, 'the account can be removed');
  ok(CALLS.every(c => c.method === 'GET'), 'still: only GET requests went to Samsara');
  console.log(errs.length ? `\n${errs.length} FAILED of ${n}` : `\nALL ${n} TELEM CHECKS PASSED`);
  srv.close(); await pg.stop(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
