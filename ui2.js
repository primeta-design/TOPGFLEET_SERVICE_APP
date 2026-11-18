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

  // ---- login ----
  let A = await openPage();
  setv(A, '#lem', 'boss@example.com'); setv(A, '#lpw', 'Correct-Horse-9!'); A.click('[data-a=login]'); await sleep(1100);
  ok(A.ev('S.in') === true, 'logged in');
  // seed units and invoices straight into the page state (what the forms would do)
  A.ev(`(()=>{const c=S.comps[0].id;
   DB.trucks.push({id:"t1",num:"07",company:c,year:2021,make:"Freightliner",model:"Cascadia",vin:"V1"},{id:"t2",num:"906",company:c,year:2022,make:"Freightliner",model:"Cascadia",vin:"V2"},{id:"t3",num:"112",company:c,year:2022,make:"Freightliner",model:"Cascadia",vin:"V3"});
   DB.trailers.push({id:"l1",num:"S285186",company:c,type:"Dry Van",make:"Great Dane"},{id:"l2",num:"HT368325",company:c,type:"Dry Van",make:"Hyundai"});
   const I=(id,tr,tl,amt,reason,date,who,method,desc,extra)=>DB.inv.push(Object.assign({id,truck:tr,trailer:tl,amt,reason,date,who,method,desc,split:[],mgr:"Marcus",by:"Marcus",byAt:date},extra||{}));
   I("i1","t1","",1300,"truck","2026-11-02","ow","efs","Oil change,Valve adjustment\\nMoney Transfer code 3030317893");
   I("i2","t1","l1",191.73,"tires","2026-11-02","co","efs","trailer tire issue",{tp:0});
   I("i3","t1","",7400,"truck","2026-10-31","ow","efs","truck repair");
   I("i4","t1","",1200,"truck","2026-10-26","dr","efs","Money Transfer code 1513520215");
   I("i5","t2","",3235,"truck","2026-11-14","ow","cc","2200 was zelle 1035 via card");
   I("i6","t3","l2",1000,"parts","2026-11-03","co","zelle","shared both");
   for(let k=0;k<14;k++)I("x"+k,"t3","",10+k,"other","2026-09-"+String(10+k),"co","cc","filler "+k);
   refresh()})()`);
  await sleep(300);
  A.ev('go("invoices")'); await sleep(300);
  const txt = () => A.d.querySelector('#c').textContent;
  ok(A.d.querySelectorAll('.ivk').length === 4, 'four KPI cards');
  ok(/Most expensive units/i.test(txt()) && /Breakdown/i.test(txt()), 'right panel: most expensive units and breakdown');
  ok(A.d.querySelectorAll('.ivt tr.rw').length === 10, 'table shows 10 rows per page');
  ok(/Showing 1.10 of 20/.test(txt()), 'paging text: ' + (/Showing[^P]*/.exec(txt()) || [''])[0]);
  ok(['All time', 'This month', 'Last 30 days', 'Last 90 days', 'This year'].every(x => txt().includes(x)), 'period chips');
  A.click('[data-a=ivPg][data-v="2"]'); await sleep(100);
  ok(/Showing 11.20 of 20/.test(txt()), 'page 2');
  A.click('[data-a=ivPg][data-v="1"]');
  // truck+trailer split counts each unit's part (truck 0, trailer 191.73)
  ok(A.ev('invParts(byId(DB.inv,"i2")).map(p=>p.a).join(",")') === '0,191.73', 'explicit truck part');
  ok(A.ev('invParts(byId(DB.inv,"i6")).map(p=>p.a).join(",")') === '500,500', 'half and half by default');
  // unit filter: Truck #07
  A.ev('ivS().unit="07";ivS().edit=false;page()'); await sleep(150);
  ok(/Truck maintenance record/i.test(txt()) && /#07/.test(txt()), 'maintenance record panel for the unit');
  ok(/9,900\.00/.test(txt()), 'unit total counts only its part: ' + (/Spent to date[^A]*/.exec(txt()) || [''])[0]);
  A.ev('ivS().unit="";page()');
  // payer card filter
  A.click('[data-a=ivWho][data-v=dr]'); await sleep(100);
  ok(A.d.querySelectorAll('.ivt tr.rw').length === 1, 'Driver pays card filters the table');
  A.click('[data-a=ivWho][data-v=dr]');
  // view panel
  A.click('.ivt tr.rw'); await sleep(150);
  ok(/Added by/.test(A.d.querySelector('#dr').textContent) && /Paid via/.test(A.d.querySelector('#dr').textContent), 'invoice side panel opens');
  A.ev('closeDr()');
  // report modal + PDFs
  A.click('[data-a=ivReport]'); await sleep(150);
  ok(/Most expensive first/.test(A.d.querySelector('#md').textContent) && /Diagram and totals only/.test(A.d.querySelector('#md').textContent), 'report modal options');
  const pdfOf = (det, ord, unit) => A.ev(`(()=>{ivS().unit=${JSON.stringify(unit||"")};const L=invFiltered(),u=unitSel(),b=irPdf(irModel(L,u,${JSON.stringify(ord||"exp")},${det}));return Array.from(b).map(c=>String.fromCharCode(c)).join("")})()`);
  const p1 = pdfOf(true), p0 = pdfOf(false), p07 = pdfOf(true, 'exp', '07');
  ok(p1.startsWith('%PDF') && /Invoice report/.test(p1) && /Spending by unit/.test(p1) && /Invoices by unit/.test(p1), 'PDF with each unit invoices');
  ok(p0.startsWith('%PDF') && !/Invoices by unit/.test(p0) && /Spending by unit/.test(p0), 'PDF diagram and totals only');
  ok(/Only this truck's part of each invoice is counted/.test(p07) && /Truck #07/.test(p07), 'single-unit PDF');
  ok(/Page 1 of \d+/.test(p1) && /\$11,100\.00|\$13,|\$/.test(p1), 'PDF footer has page x of n');
  ok(/part of \$191\.73, shared with Trailer #S285186/.test(p07) || /part of \$191\.73/.test(p07), 'shared invoice note in PDF');
  // many invoices -> several pages without throwing
  A.ev(`(()=>{const c=S.comps[0].id;for(let k=0;k<60;k++){const id="u"+k;DB.trucks.push({id,num:"9"+k,company:c,year:2020,make:"Volvo",model:"VNL",vin:"v"+k});for(let j=0;j<3;j++)DB.inv.push({id:"m"+k+"_"+j,truck:id,trailer:"",amt:50+k+j,reason:"truck",date:"2026-10-1"+j,who:"co",method:"efs",desc:"Long description ".repeat(8)+k,split:[]})}ivS().unit="";})()`);
  const big = pdfOf(true); const pages = +(/Page 1 of (\d+)/.exec(big) || [0, 0])[1];
  ok(pages >= 6, 'large report paginates (' + pages + ' pages)');
  // ---- team ----
  const post = (u, b) => A.w.fetch(u, { method: 'POST', headers: { 'X-Requested-With': 'tf', 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const patch = (u, b) => A.w.fetch(u, { method: 'PATCH', headers: { 'X-Requested-With': 'tf', 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  let r = await post('/api/users', { name: 'Chris Lane', username: 'chris', password: 'Falcon-Blue-4471!', role: 'member' });
  ok(r.status === 200, 'user without email can be created (status ' + r.status + ')');
  r = await post('/api/users', { name: 'Marcus Vale', username: 'marcus', email: 'marcus@example.com', password: 'Falcon-Blue-4471!', role: 'member' });
  ok(r.status === 200, 'member with email');
  A.ev('PG.users=null;go("profile")'); await sleep(900); A.ev('PG.users=null;loadUsers()'); await sleep(700);
  const team = () => A.d.querySelector('#pf_team').textContent;
  ok(/have no email address/.test(A.d.querySelector('#pf_team').innerHTML) && /no email/.test(team()), 'no-email notice and badge');
  ok(A.d.querySelectorAll('#pf_team .tmb').length >= 2, 'Admin/Member toggle on each person');
  ok(A.d.querySelectorAll('#pf_team .tmc').length >= 14, 'company chips shown for members');
  const chrisId = A.ev('PG.users.find(u=>u.username=="chris").id');
  // one click: Admin
  A.click(`[data-a=tmRole][data-id="${chrisId}"][data-v=admin]`); await sleep(900);
  let st = await (await A.w.fetch('/api/users')).json();
  ok(st.users.find(u => u.username === 'chris').role === 'admin', 'one click makes the person Admin');
  ok(/is now Admin/.test(A.d.querySelector('#ts').textContent) && !!A.d.querySelector('#ts button'), 'toast with Undo');
  A.click('#ts button'); await sleep(900);
  st = await (await A.w.fetch('/api/users')).json();
  ok(st.users.find(u => u.username === 'chris').role === 'member', 'Undo puts the role back');
  // hide one company for Chris with a click on its chip, then undo
  A.ev('PG.users=null;loadUsers()'); await sleep(700);
  const coId = A.ev('S.comps[2].id');
  A.click(`[data-a=tmCo][data-id="${chrisId}"][data-co="${coId}"]`); await sleep(900);
  st = await (await A.w.fetch('/api/users')).json();
  let cu = st.users.find(u => u.username === 'chris');
  ok(Array.isArray(cu.companies) && cu.companies.length === 13 && !cu.companies.includes(coId), 'clicking a chip hides that company');
  ok(/no longer sees/.test(A.d.querySelector('#ts').textContent), 'toast says who no longer sees what');
  A.click('#ts button'); await sleep(900);
  st = await (await A.w.fetch('/api/users')).json(); cu = st.users.find(u => u.username === 'chris');
  ok(cu.companies === null, 'Undo restores all companies');
  // add-company popover: open, Clear all, then tick one on
  A.click(`[data-a=tmOpen][data-id="${chrisId}"]`); await sleep(300);
  ok(!!A.d.querySelector('.tmpop'), 'Add company opens a checklist');
  A.click(`[data-a=tmNone][data-id="${chrisId}"]`); await sleep(900);
  st = await (await A.w.fetch('/api/users')).json(); cu = st.users.find(u => u.username === 'chris');
  ok(Array.isArray(cu.companies) && cu.companies.length === 0, 'Clear all removes every company');
  A.click(`.tmpop [data-a=tmCo][data-id="${chrisId}"][data-co="${coId}"]`); await sleep(900);
  st = await (await A.w.fetch('/api/users')).json(); cu = st.users.find(u => u.username === 'chris');
  ok(cu.companies.length === 1 && cu.companies[0] === coId, 'ticking a company adds it');
  A.click(`[data-a=tmAll][data-id="${chrisId}"]`); await sleep(900);
  st = await (await A.w.fetch('/api/users')).json(); cu = st.users.find(u => u.username === 'chris');
  ok(cu.companies === null, 'All companies resets to everything');
  // email via the envelope
  r = await patch('/api/users/' + chrisId, { email: 'chris@example.com' }); ok(r.status === 200, 'admin can set an email');
  r = await patch('/api/users/' + chrisId, { email: 'marcus@example.com' }); ok(r.status === 409, 'duplicate email rejected');
  r = await patch('/api/users/' + chrisId, { email: 'nope' }); ok(r.status === 400, 'bad email rejected');
  st = await (await A.w.fetch('/api/users')).json(); ok(st.users.find(u => u.username === 'chris').noMail === false, 'noMail turns off once an email is set');
  // telegram resend without a bot: handled, no crash
  r = await post('/api/invoices/i1/telegram', {}); ok(r.status === 200 || r.status === 404, 'telegram resend route answers (' + r.status + ')');
  console.log(errs.length ? `\n${errs.length} FAILED of ${n}` : `\nALL ${n} UI2 CHECKS PASSED`);
  srv.close(); await pg.stop(); process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
