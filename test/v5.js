'use strict';
// v5 features end to end: truck side panel + page, mileage history, service log, maintenance groups, roadside QR, Telegram link.
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const EP = require('embedded-postgres').default; const { JSDOM, VirtualConsole } = require('jsdom');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfpg5-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// fake Telegram API (no network)
const SENT = []; const realFetch = global.fetch;
global.fetch = async (u, o) => { if (String(u).startsWith('https://api.telegram.org/bot')) { const m = String(u).split('/').pop(); const b = o && typeof o.body === 'string' ? JSON.parse(o.body) : {}; SENT.push({ m, b }); return { json: async () => m === 'getMe' ? { ok: true, result: { username: 'testbot', id: 7 } } : { ok: true, result: { message_id: 1 } } }; } return realFetch(u, o); };
(async () => {
  try { fs.chmodSync(dir, 0o777); if (process.getuid() === 0) require('child_process').execSync('chown -R postgres ' + dir); } catch {}
  const pg = new EP({ databaseDir: dir, user: 'tf', password: 'tf', port: 54332, persistent: false });
  await pg.initialise(); await pg.start(); await pg.createDatabase('tf');
  Object.assign(process.env, { DATABASE_URL: 'postgres://tf:tf@localhost:54332/tf', APP_SECRET: 'z'.repeat(40), ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: 'Correct-Horse-9!', RATE_LOGIN_MAX: '1000', DATA_DIR: path.join(os.tmpdir(), 'tff5-' + process.pid), TELEGRAM_BOT_TOKEN: '123:TESTTOKEN', TELEGRAM_WEBHOOK_SECRET: 'hooksecret-hooksecret-1234567890' });
  const { app, bootstrap } = require('../server.js'); await bootstrap();
  const srv = app.listen(0); const port = srv.address().port, base = 'http://localhost:' + port;
  const errs = []; let n = 0; const ok = (c, m) => { n++; if (!c) { errs.push(m); console.log('  FAIL', m); } };

  async function openPage(p = '/') {
    const jar = {}; const vc = new VirtualConsole(); vc.on('jsdomError', e => errs.push('JSDOM ' + e.message.slice(0, 200)));
    const html = await (await realFetch(base + p)).text();
    const wf = async (u, o = {}) => { const { signal, ...rest } = o; const h = { ...(rest.headers || {}) }; if (jar.v) h.Cookie = jar.v;
      const r = await realFetch(new URL(u, base), { ...rest, headers: h, redirect: 'manual' }); const sc = r.headers.get('set-cookie'); if (sc) { const m = /(tf_sid=[^;]*)/.exec(sc); jar.v = m && m[1].endsWith('=') ? '' : m && m[1]; } return r; };
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: base + p, pretendToBeVisual: true, virtualConsole: vc, beforeParse(win) { win.fetch = wf; win.print = () => {}; win.scrollTo = () => {}; } });
    const w = dom.window; await sleep(800);
    return { w, d: w.document, jar, ev: c => w.eval(c), click: s => { const e = typeof s === 'string' ? w.document.querySelector(s) : s; if (!e) throw new Error('no el ' + s); e.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); } };
  }
  const setv = (P, sel, v) => { const e = P.d.querySelector(sel); e.value = v; e.dispatchEvent(new P.w.Event('input', { bubbles: true })); };
  const state = async P => (await P.w.fetch('/api/state')).json();

  let A = await openPage();
  setv(A, '#lem', 'boss@example.com'); setv(A, '#lpw', 'Correct-Horse-9!'); A.click('[data-a=login]'); await sleep(1100);
  ok(A.ev('S.in') === true, 'logged in');
  ok(/Geist/.test(A.w.getComputedStyle(A.d.body).fontFamily), 'Falcon font (Geist) on the body');
  A.ev(`(()=>{const c=S.comps[0].id;DB.trucks.push({id:"t1",num:"1965",company:c,status:S.stat[0].id,year:2022,make:"Freightliner",model:"Cascadia",vin:"3AKJHHDR2NSNA6660",plate:"P1345928",cab:"2027-03-31",ins:"cov",own:"co",owner:"Cruz Kenelson",miles:"529"},{id:"t2",num:"222",company:c,status:S.stat[0].id,year:2022,make:"FRHT",model:"Cascadia",vin:"V2"});
   DB.plans.push({id:"p1",truck:"t1",name:"Oil change",everyMi:"10000",everyDays:"",lastMi:"",lastDate:""});refresh()})()`);
  await sleep(1500);

  // ---- side panel instead of the edit form ----
  A.ev('go("trucks")'); await sleep(300);
  ok(/--sc:/.test(A.d.querySelector('.tc').getAttribute('style') || ''), 'truck card is tinted by its status colour');
  A.click('.tc[data-id=t1]'); await sleep(200);
  const dr = () => A.d.querySelector('#dr');
  ok(!!dr().querySelector('.kvt') && !dr().querySelector('[name=num]'), 'clicking a card opens the read-only panel, not the form');
  ok(/3AKJHHDR2NSNA6660/.test(dr().textContent) && /Cruz Kenelson/.test(dr().textContent) && /Oil change/.test(dr().textContent), 'panel shows VIN, owner and the next PM');
  ok(!!dr().querySelector('[data-a=tpOpen]') && !!dr().querySelector('[data-a=tpHist]') && !!dr().querySelector('[data-a=tpEdit]'), 'panel buttons: service history, edit, open page');
  A.click('#dr [data-a=tvIns][data-v=unc]'); await sleep(200);
  ok(A.ev('byId(DB.trucks,"t1").ins') === 'unc' && dr().querySelector('[data-a=tvIns].on').dataset.v === 'unc', 'insurance can be set from the panel');
  A.click('#dr [data-a=tpEdit]'); await sleep(200);
  ok(!!dr().querySelector('[name=num]') && !dr().querySelector('[data-a=drDel]'), 'edit form has no Delete button any more');
  A.ev('closeDr()');

  // ---- truck page ----
  A.ev('TRK="t1";go("truck")'); await sleep(300);
  ok(A.w.location.pathname === '/fleet/t1', 'page lives at /fleet/<id>');
  const c = () => A.d.querySelector('#c').textContent;
  ok(/Unit #1965 \(C\)/.test(c()) && /Telegram PTI/.test(c()) && /Mileage history/.test(c()) && /Truck history/.test(c()) && /Maintenance plans/.test(c()), 'truck page has every section');
  ok(A.d.querySelector('.nv.on') && A.d.querySelector('.nv.on').dataset.v === 'trucks', 'sidebar keeps Trucks highlighted');
  ok(!!A.d.querySelector('#tpm [data-a=tpDel]') && !!A.d.querySelector('#tpm [data-a=rsQr]') && !!A.d.querySelector('#tpm [data-a=tpEdit]'), '"…" menu holds Edit, Roadside QR and Delete');
  const r0 = await realFetch(base + '/fleet/t1'); ok(r0.status === 200 && /<html/i.test(await r0.text()), 'server serves /fleet/<id>');
  const A2 = await openPage('/fleet/t1'); ok(A2.ev('V') === 'truck' || A2.ev('S.in') === false, 'opening /fleet/<id> directly routes to the truck page');

  // ---- mileage history ----
  A.click('[data-a=umOpen]'); await sleep(150); A.d.querySelector('#um_v').value = '1200'; A.d.querySelector('#um_s').click(); await sleep(1500);
  let st = await state(A); let t1 = st.DB.trucks.find(x => x.id === 't1');
  ok(t1.miles === '1200' && Array.isArray(t1.mh) && t1.mh.length === 2 && t1.mh[0].mi === 1200 && t1.mh[0].src === 'manual' && t1.mh[1].mi === 529, 'update mileage keeps the old reading and saves to the server');
  A.ev('openTruck("t1")'); await sleep(150); A.d.querySelector('#dr [name=miles]').value = '1500'; A.click('#dr [data-a=drSave]'); await sleep(1500);
  st = await state(A); t1 = st.DB.trucks.find(x => x.id === 't1'); ok(t1.miles === '1500' && t1.mh.length === 3 && t1.mh[0].src === 'edit', 'changing miles in the form adds a reading');
  ok(/1,500/.test(c()) && A.d.querySelectorAll('.tpt2 tr').length === 4, 'mileage history table lists every reading');

  // ---- service log ----
  A.click('[data-a=lsOpen]'); await sleep(150);
  ok(A.d.querySelector('#ls_ty').value === 'p:p1', 'log service offers the truck\'s plans');
  A.d.querySelector('#ls_mi').value = '1800'; A.d.querySelector('#ls_c').value = '250'; A.d.querySelector('#ls_v').value = 'EZ truck repair';
  A.d.querySelector('.mdl').dispatchEvent(new A.w.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); await sleep(1500);
  st = await state(A); t1 = st.DB.trucks.find(x => x.id === 't1');
  ok(st.DB.svc.length === 1 && st.DB.svc[0].plan === 'Oil change' && st.DB.svc[0].cost === '250', 'Ctrl+Enter saves the service record');
  ok(st.DB.plans[0].lastMi === '1800' && !!st.DB.plans[0].lastDate && t1.miles === '1800' && t1.mh[0].src === 'service', 'service updates the plan and the mileage');
  ok(/EZ truck repair/.test(c()) && /\$250\.00/.test(c()), 'truck history shows the service');
  A.click('[data-a=lsOpen]'); await sleep(150); A.ev('(()=>{const s=document.querySelector("#ls_ty");s.value="";s.onchange()})()'); A.d.querySelector('#ls_s').click(); await sleep(100);
  ok(!!A.d.querySelector('.mdl') && /note/i.test(A.d.querySelector('#ts').textContent), 'empty note-only service is refused'); A.ev('closeMd()');
  A.ev('DB.inv.push({id:"iv1",truck:"t1",trailer:"",amt:300,reason:"truck",date:"2026-11-18",who:"co",method:"cc",desc:"truck hood repair",split:[]});refresh()'); await sleep(300);
  ok(/truck hood repair/.test(c()) && !!A.d.querySelector('#tph [data-a=openInv][data-id=iv1]'), 'invoices of the truck appear in its history and open');

  // ---- maintenance groups ----
  A.ev('go("maintenance")'); await sleep(300);
  ok(A.d.querySelectorAll('.mtg').length === 4 && /No service on record/.test(c()) && /Up to date/.test(c()), 'maintenance shows the four Falcon groups');
  ok(/Set a starting point for 1 truck/.test(c()), 'truck without a plan is listed under No service on record');
  A.click('[data-a=mtStart]'); await sleep(150);
  A.d.querySelector('[data-ms=d][data-id=t2]').value = '2026-10-01'; A.d.querySelector('[data-ms=m][data-id=t2]').value = '400000'; A.d.querySelector('#ms_s').click(); await sleep(1500);
  st = await state(A); const p2 = st.DB.plans.find(p => p.truck === 't2');
  ok(p2 && p2.lastMi === '400000' && p2.lastDate === '2026-10-01' && +p2.everyMi > 0, 'starting point creates a PM plan with the last service');
  ok(!/Set a starting point/.test(c()), 'nothing left without a starting point');

  // ---- roadside QR ----
  A.ev('DB.docs.push({id:"d1",kind:"truck",uid:"t1",type:"reg",title:"Registration",exp:"2027-01-01",vis:true,files:[]},{id:"d2",kind:"truck",uid:"t1",type:"other",title:"Private",vis:false,files:[]});refresh()'); await sleep(300);
  const up = await new Promise(z => { const buf = Buffer.from('%PDF-1.4\n%t\n'); const rq = http.request({ port, method: 'POST', path: '/api/files', headers: { Host: 'localhost:' + port, 'X-Requested-With': 'tf', 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'X-Filename': 'reg.pdf', Cookie: A.jar.v } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => z(JSON.parse(b))); }); rq.end(buf); });
  const up2 = await new Promise(z => { const buf = Buffer.from('%PDF-1.4\n%x\n'); const rq = http.request({ port, method: 'POST', path: '/api/files', headers: { Host: 'localhost:' + port, 'X-Requested-With': 'tf', 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'X-Filename': 'other.pdf', Cookie: A.jar.v } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => z(JSON.parse(b))); }); rq.end(buf); });
  A.ev(`byId(DB.docs,"d1").files=[{id:${JSON.stringify(up.id)},name:"reg.pdf",type:"application/pdf"}];refresh()`); await sleep(300);
  A.ev('TRK="t1";go("truck")'); await sleep(300);
  A.click('#tpm [data-a=rsQr]'); await sleep(1500);
  const tok = A.ev('byId(DB.trucks,"t1").rsTok');
  ok(/^[A-Za-z0-9_-]{32}$/.test(tok || '') && !!A.d.querySelector('.rsq svg path'), 'roadside QR makes a secret link and draws the code');
  ok(A.d.querySelector('#rs_u').value.endsWith('/r/' + tok), 'the link points at /r/<token>');
  let r = await realFetch(base + '/api/roadside/' + tok); let j = await r.json();
  ok(r.status === 200 && j.unit.num === '1965' && j.unit.vin === '3AKJHHDR2NSNA6660' && j.docs.length === 1 && j.docs[0].files[0].id === up.id, 'roadside API (no login) shows the truck and only its visible documents');
  ok(!JSON.stringify(j).includes('Cruz') && !JSON.stringify(j).includes('rsTok'), 'roadside API does not leak the owner or the token');
  r = await realFetch(base + '/api/roadside/' + tok + '/f/' + up.id); ok(r.status === 200 && r.headers.get('content-type') === 'application/pdf', 'its document file opens without login');
  r = await realFetch(base + '/api/roadside/' + tok + '/f/' + up2.id); ok(r.status === 404, 'any other file is refused');
  r = await realFetch(base + '/api/roadside/' + 'x'.repeat(32)); ok(r.status === 404, 'a wrong token gets nothing');
  r = await realFetch(base + '/api/roadside/short'); ok(r.status === 404, 'a short token gets nothing');
  const R = await openPage('/r/' + tok); await sleep(600);
  ok(/Unit #1965/.test(R.d.body.textContent) && /Registration/.test(R.d.body.textContent) && !!R.d.querySelector(`a[href*="/api/roadside/${tok}/f/"]`) && !R.d.querySelector('#lpw'), 'the /r/<token> page shows the documents without a login');
  const Rb = await openPage('/r/' + 'y'.repeat(32)); await sleep(600); ok(/no longer works/.test(Rb.d.body.textContent), 'a dead roadside link says so');
  A.click('[data-a=rsNew]'); await sleep(150); A.d.querySelector('#askY').click(); await sleep(1500);
  const tok2 = A.ev('byId(DB.trucks,"t1").rsTok'); r = await realFetch(base + '/api/roadside/' + tok);
  ok(tok2 !== tok && r.status === 404, 'making a new link kills the old QR'); A.ev('closeMd()');

  // ---- Telegram: one-click link through the bot ----
  r = await A.w.fetch('/api/tg/truck-link', { method: 'POST', headers: { 'X-Requested-With': 'tf', 'Content-Type': 'application/json' }, body: JSON.stringify({ truck: 't1' }) }); j = await r.json();
  ok(r.status === 200 && /^T[A-Z0-9]{10}$/.test(j.code) && j.link === 'https://t.me/testbot?startgroup=' + j.code, 'truck link code issued');
  const hook = (text, chat, type) => new Promise(z => { const data = JSON.stringify({ update_id: 1, message: { text, chat: { id: chat, type }, from: { id: 999 } } }); const rq = http.request({ port, method: 'POST', path: '/tg/hook', headers: { Host: 'localhost:' + port, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Telegram-Bot-Api-Secret-Token': 'hooksecret-hooksecret-1234567890' } }, res => { res.resume(); res.on('end', () => z(res.statusCode)); }); rq.end(data); });
  SENT.length = 0; await hook('/start@testbot TWRONGCODE1', -100555, 'supergroup'); await sleep(300); ok(SENT.filter(x => x.m === 'sendMessage').length === 0, 'a wrong code in a group gets no reply');
  await hook('/start@testbot ' + j.code, -100777, 'supergroup'); await sleep(400);
  st = await state(A); ok(st.DB.trucks.find(x => x.id === 't1').tg === '-100777', 'adding the bot with the link connects the truck to that group');
  ok(SENT.some(x => x.m === 'sendMessage' && String(x.b.chat_id) === '-100777' && /1965/.test(x.b.text)), 'the bot confirms in the group');
  SENT.length = 0; await hook('/start@testbot ' + j.code, -100888, 'supergroup'); await sleep(300);
  st = await state(A); ok(st.DB.trucks.find(x => x.id === 't1').tg === '-100777' && SENT.length === 0, 'the link works only once');
  A.ev('pullRemote(true)'); await sleep(900); A.ev('page()'); await sleep(200);
  ok(/Connected/.test(c()) && !!A.d.querySelector('[data-a=tgDisc]'), 'truck page shows the group as connected');
  // a member restricted to another company cannot link this truck
  await A.w.fetch('/api/sync', { method: 'POST', headers: { 'X-Requested-With': 'tf', 'Content-Type': 'application/json' }, body: JSON.stringify({ kv: { comps: [{ id: 'cX', n: 'X', c: '#111111' }, ...A.ev('JSON.stringify(S.comps)') && JSON.parse(A.ev('JSON.stringify(S.comps)'))] } }) });
  await A.w.fetch('/api/users', { method: 'POST', headers: { 'X-Requested-With': 'tf', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cora', username: 'cora', email: 'cora@example.com', role: 'member', password: 'Purple-Anchor-42', companies: ['cX'] }) });
  const M = await openPage(); setv(M, '#lem', 'cora@example.com'); setv(M, '#lpw', 'Purple-Anchor-42'); M.click('[data-a=login]'); await sleep(1100);
  r = await M.w.fetch('/api/tg/truck-link', { method: 'POST', headers: { 'X-Requested-With': 'tf', 'Content-Type': 'application/json' }, body: JSON.stringify({ truck: 't1' }) });
  ok(r.status === 403 || r.status === 404, 'member of another company cannot link the truck (' + r.status + ')');

  // ---- delete lives in the "…" menu ----
  A.ev('TRK="t2";go("truck")'); await sleep(300); A.click('#tpm [data-a=tpDel]'); await sleep(150); A.d.querySelector('#askY').click(); await sleep(1500);
  st = await state(A); ok(!st.DB.trucks.some(x => x.id === 't2') && !st.DB.plans.some(p => p.truck === 't2') && A.ev('V') === 'trucks', 'delete from the menu removes the truck and its plans');
  A.ev('TRK="gone1";go("truck")'); await sleep(200); ok(/not found/.test(c()), 'a missing truck shows a clear message');
  // ---- page size: automatic on wide screens, user size up to 150% ----
  ok(/--uz:1\.36/.test(A.d.querySelector('style').textContent) && /html\{zoom:var\(--uz\)\}/.test(A.d.querySelector('style').textContent), 'automatic page size rules are in place');
  r = await A.w.fetch('/api/me', { method: 'PATCH', headers: { 'X-Requested-With': 'tf', 'Content-Type': 'application/json' }, body: JSON.stringify({ prefs: { sz: { fz: 100, mz: 140, pz: 150 } } }) }); j = await r.json();
  ok(r.status === 200 && j.user.prefs.sz.pz === 150 && j.user.prefs.sz.mz === 140, 'page and menu size can go up to 150%');
  await A.w.fetch('/api/me', { method: 'PATCH', headers: { 'X-Requested-With': 'tf', 'Content-Type': 'application/json' }, body: JSON.stringify({ prefs: { sz: { fz: 100, mz: 100, pz: 100 } } }) });
  // ---- vendors: full-page map, floating search, collapsible list, links to invoices ----
  A.ev('DB.vend.push({id:"vA",name:"EZ Truck Repair",addr:"Joliet, IL",lat:41.5,lng:-88.1});DB.inv.push({id:"ivV",truck:"t1",trailer:"",amt:99,reason:"truck",date:"2026-11-19",who:"co",method:"cc",desc:"brakes",vendor:"EZ Truck Repair",split:[]});refresh()'); await sleep(300);
  A.ev('go("vendors")'); await sleep(400);
  ok(!!A.d.querySelector('#c > #vpage.vnP') && !!A.d.querySelector('#vpage > #vbox') && !!A.d.querySelector('#vpage > .vnTop #vmq') && !!A.d.querySelector('#vpage > .vnAct') && !A.d.querySelector('[data-a=addVendor]'), 'vendors page: map fills the page, search and buttons float on it');
  const sideBefore = A.d.querySelector('#vpage').classList.contains('side'); A.click('#vhandle'); await sleep(100);
  ok(A.d.querySelector('#vpage').classList.contains('side') !== sideBefore && A.ev('ld("tf_vnside",null)') === !sideBefore, 'the list slides in and out and the choice is remembered');
  ok(!!A.d.querySelector('#vlist [data-a=vnInv][data-id=vA]') && !!A.d.querySelector('#vlist [data-a=vnShow][data-id=vA]'), 'each vendor has Show on the map and Its invoices');
  A.click('#vlist [data-a=vnInv][data-id=vA]'); await sleep(300);
  ok(A.ev('V') === 'invoices' && A.d.querySelectorAll('.ivt tr.rw').length === 1 && /brakes/.test(A.d.querySelector('.ivt').textContent), 'Its invoices opens the invoices of that vendor');
  ok(/View/.test(A.d.querySelector('.ivt [data-a=ivView]').textContent) && !!A.d.querySelector('.ivt .vnd'), 'invoice table: labelled View button, vendor kept to two lines');
  // ---- invoices: the server writes who added a new invoice ----
  await A.w.fetch('/api/sync', { method: 'POST', headers: { 'X-Requested-With': 'tf', 'Content-Type': 'application/json' }, body: JSON.stringify({ upserts: [{ c: 'inv', id: 'ivNoBy', d: { truck: 't1', amt: 5, reason: 'truck', method: 'cc', who: 'co', date: '2026-11-21' } }] }) });
  st = await state(A); const nb = st.DB.inv.find(x => x.id === 'ivNoBy'); ok(nb && nb.by && /^\d{4}-\d\d-\d\d$/.test(nb.byAt), 'a new invoice always gets Added by (' + (nb && nb.by) + ')');
  await A.w.fetch('/api/sync', { method: 'POST', headers: { 'X-Requested-With': 'tf', 'Content-Type': 'application/json' }, body: JSON.stringify({ upserts: [{ c: 'inv', id: 'ivNoBy', d: { truck: 't1', amt: 6, reason: 'truck', method: 'cc', who: 'co', date: '2026-11-21', by: 'Someone', byAt: '2026-01-01' } }] }) });
  st = await state(A); ok(st.DB.inv.find(x => x.id === 'ivNoBy').by === 'Someone', 'editing keeps the original author');
  // languages still complete for the new screens
  for (const lg of ['uz', 'ru']) { A.ev(`S.lang="${lg}";TRK="t1";go("truck")`); await sleep(200); ok(!/\b(tp_|tv_|mh_|ls_|th_|tg_|rs_|mt_|um_)[a-z0-9]+\b/.test(A.d.querySelector('#c').textContent), lg + ': no missing translations on the truck page'); }
  A.ev('S.lang="en"');

  console.log(errs.length ? `\n${errs.length} FAILED of ${n}` : `\nALL ${n} V5 CHECKS PASSED`);
  srv.close(); await pg.stop(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
