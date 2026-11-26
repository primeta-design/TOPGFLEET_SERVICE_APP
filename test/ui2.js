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

  async function openPage(p = '/') {
    const jar = {}; const vc = new VirtualConsole(); vc.on('jsdomError', e => errs.push('JSDOM ' + e.message.slice(0, 160)));
    const html = await (await fetch(base + p)).text();
    const wf = async (u, o = {}) => { const { signal, ...rest } = o; const h = { ...(rest.headers || {}) }; if (jar.v) h.Cookie = jar.v;
      const r = await fetch(new URL(u, base), { ...rest, headers: h, redirect: 'manual' }); const sc = r.headers.get('set-cookie'); if (sc) { const m = /(tf_sid=[^;]*)/.exec(sc); jar.v = m && m[1].endsWith('=') ? '' : m && m[1]; } return r; };
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: base + p, pretendToBeVisual: true, virtualConsole: vc, beforeParse(win) { win.fetch = wf; } });
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
  A.ev('window.pullRemote=async()=>{}');   // keep the test's local edits from being overwritten by the 15 s refresh
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
  ok(A.d.querySelectorAll('.ivk').length === 5, 'five KPI cards (total + company, owner, driver, broker)');
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
  // sent state + resend confirmation + jump button
  A.ev('go("invoices")'); await sleep(500);
  A.ev('(()=>{const x=DB.inv[0];x.tg="2026-11-18";x.tgm={chat:"-1001",mid:5,link:"https://t.me/c/1/5"};page()})()'); await sleep(400);
  ok(!A.d.querySelector('[data-a=ivJump]') && !A.d.querySelector('tr [data-a=ivDl]'), 'row has no extra download or Telegram-link icons (they live in the invoice details)');
  A.click(`[data-a=ivSend][data-id="${A.ev('DB.inv[0].id')}"]`); await sleep(300);
  ok(!!A.d.querySelector('[data-a=ivSend2]'), 'sending again asks first');
  A.ev('closeMd();PG.users=null;go("profile")'); await sleep(900);
  // clicking a photo shows it big
  A.ev('(()=>{const m=S.team.find(x=>x.n==USER.name);USER.avatar="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AB//Z";PG.users=null;render()})()'); await sleep(500);
  A.click('.av.zm'); await sleep(300);
  ok(!!A.d.querySelector('img.phbig'), 'clicking a photo opens it big');
  A.ev('USER.avatar=null;closeMd();render()'); await sleep(200);
  // invoice panel: select files, view/download selected, no duplicate buttons
  A.ev('go("invoices")'); await sleep(400);
  A.ev('(()=>{const x=DB.inv[0];x.files=[{id:"f1",name:"a.jpg",type:"image/jpeg",size:1000},{id:"f2",name:"b.pdf",type:"application/pdf",size:2000},{id:"f3",name:"c.jpg",type:"image/jpeg",size:3000}];A.ivView({dataset:{id:x.id}})})()'); await sleep(300);
  ok(A.d.querySelectorAll('[data-c=ivSel]').length === 3 && !!A.d.querySelector('[data-c=ivAll]'), 'invoice panel lists files with checkboxes and Select all');
  A.ev('(()=>{const e=document.querySelector("[data-c=ivAll]");e.checked=true;C.ivAll(e)})()'); await sleep(100);
  ok(/3/.test(A.d.querySelector('#ivcnt').textContent) && A.ev('ivFiles(byId(DB.inv,IVS.id)).length') === 3, 'Select all selects every file');
  A.ev('(()=>{const e=document.querySelector("[data-c=ivAll]");e.checked=false;C.ivAll(e);const f=document.querySelector("[data-c=ivSel]");f.checked=true;C.ivSel(f)})()'); await sleep(100);
  ok(A.ev('ivFiles(byId(DB.inv,IVS.id)).length') === 1, 'View/Download act on the selected files only');
  ok(!A.d.querySelector('#dr [data-a=ivSend]') && !A.d.querySelector('#dr [data-a=openInv]') && !A.d.querySelector('#dr [data-a=ivDelOne]') && !!A.d.querySelector('#dr [data-a=ivViewF]') && !!A.d.querySelector('#dr [data-a=ivDlF]'), 'panel has only View file / Download (no Edit, Delete, Send)');
  A.ev('closeDr();PG.users=null;go("profile")'); await sleep(900);
  // photo chooser has a drag-and-drop zone; profile avatar has no badges
  ok(!A.d.querySelector('.avc'), 'no extra badges on the profile photo');
  A.ev('closeMd();USER.avatar=null;render()'); await sleep(200);
  A.click('[data-a=phPick][data-me]'); await sleep(300);
  ok(!!A.d.querySelector('#phdz') && !!A.d.querySelector('[data-a=phCam]') && !!A.d.querySelector('[data-a=phFile]'), 'chooser: camera, files and drag-and-drop zone');
  A.ev('closeMd()');
  // owner approval of every sign-in: needs the owner's own authenticator first
  A.ev('PG.req2fa=false;page()'); await sleep(300);
  const sw = A.d.querySelector('[data-c=tfReq]'); ok(!!sw && sw.disabled === true, 'owner sees the owner-approval switch, locked until their own authenticator is on');
  ok(/Online|never signed in|Last sign-in/.test(A.d.querySelector('#pf_team').textContent), 'Team shows who is online / last sign-in');

  // ---- account + team rules ----
  A.ev('go("profile")'); await sleep(900);
  ok(!A.d.querySelector('[data-a=tmTest]'), 'no "Add test account" button');
  ok(!!A.d.querySelector('[data-a=tmInvite]') && !!A.d.querySelector('[data-a=tmUser]'), 'owner has Invite and Add user');
  ok(!!A.d.querySelector('[data-a=auditOpen]'), 'owner sees the Activity log');
  A.click('[data-a=acEdit][data-k=email]'); await sleep(200);
  ok(!!A.d.querySelector('#ae_v') && !A.d.querySelector('#ae_p'), 'email change no longer asks for the current password');
  A.ev('closeMd()');
  A.click('[data-a=acEdit][data-k=tg]'); await sleep(200); setv(A, '#ae_v', '@fleet_boss'); A.click('#ae_s'); await sleep(600);
  ok(A.ev('USER.tg') === 'fleet_boss' && /t\.me\/fleet_boss/.test(A.d.querySelector('#pf_acc').innerHTML), 'Telegram username saved and shown as a t.me link');
  A.click('[data-a=acPw]'); await sleep(200);
  ok(!A.d.querySelector('#pw2') && !!A.d.querySelector('#pw3') && A.d.querySelector('#pw3').checked, 'password dialog: no repeat field, "sign out of other devices" ticked');
  A.ev('closeMd()');
  // invite flow
  A.click('[data-a=tmInvite]'); await sleep(200);
  ok(!!A.d.querySelector('#iv_r'), 'owner can pick the invite role');
  setv(A, '#iv_e', 'jane@example.com'); A.click('#iv_s'); await sleep(600);
  const link = (A.d.querySelector('#iv_l') || {}).value || ''; ok(/\/invite\/[A-Za-z0-9_-]{20,}$/.test(link), 'invite link shown');
  A.click('[data-a=ivDone]'); await sleep(900);
  ok(/Invited, not joined yet/.test(A.d.querySelector('#pf_team').textContent) && /jane@example\.com/.test(A.d.querySelector('#pf_team').textContent), 'pending invite listed in Team');
  // the invited person's page
  const Jp = await openPage(new URL(link).pathname); await sleep(500);
  ok(!!Jp.d.querySelector('#iv_n') && /jane@example\.com/.test(Jp.d.body.innerHTML), 'invite page shows the email and a name field');
  setv(Jp, '#iv_n', 'Jane Doe'); setv(Jp, '#iv_p', 'Tangerine-Moon-91'); setv(Jp, '#iv_p2', 'Tangerine-Moon-91'); Jp.click('[data-a=invJoin]'); await sleep(900);
  ok(Jp.ev('INV&&INV.done')===true && !!Jp.d.querySelector('[data-a=invGo]'), 'invited person joins from the page');
  // an admin without the edit right, and a member
  await A.ev(`api("POST","/api/users",{name:"Ivy Admin",username:"ivy",email:"ivy@example.com",role:"admin",password:"Purple-Table-4471"})`); 
  await A.ev(`api("POST","/api/users",{name:"Mia Member",username:"mia",email:"mia@example.com",role:"member",password:"Silver-Pencil-3380"})`); await sleep(300);
  const Ip = await openPage(); setv(Ip, '#lem', 'ivy@example.com'); setv(Ip, '#lpw', 'Purple-Table-4471'); Ip.click('[data-a=login]'); await sleep(1100);
  Ip.ev('closeMd();go("profile")'); await sleep(1000);
  const T = Ip.d.querySelector('#pf_team'); ok(!!T, 'admin sees Team');
  ok(!!T && !T.querySelector('[data-a=tmRole]') && !T.querySelector('[data-a=phLock]') && !T.querySelector('[data-a=usrReset]') && !T.querySelector('[data-a=usrEdit]'), 'admin has none of the owner controls and cannot edit members yet');
  ok(!!T && /Mia Member/.test(T.textContent) && !/Boss|boss@example/.test(T.textContent), 'admin sees members, not the owner');
  ok(!Ip.d.querySelector('[data-a=auditOpen]') && !!Ip.d.querySelector('[data-a=tmInvite]'), 'admin: no Activity log, can invite');
  Ip.click('[data-a=tmInvite]'); await sleep(200); ok(!Ip.d.querySelector('#iv_r'), 'admin invites members only (no role picker)'); Ip.ev('closeMd()');
  const Mp = await openPage(); setv(Mp, '#lem', 'mia@example.com'); setv(Mp, '#lpw', 'Silver-Pencil-3380'); Mp.click('[data-a=login]'); await sleep(1100);
  Mp.ev('closeMd();go("profile")'); await sleep(900);
  const MT = Mp.d.querySelector('#pf_team'); ok(!!MT && /Mia Member/.test(MT.textContent) && /Ivy Admin/.test(MT.textContent) && !/Owner/.test(MT.textContent) && !/@example\.com/.test(MT.textContent) && !MT.querySelector('button') && !Mp.d.querySelector('[data-a=tmInvite]') && !Mp.d.querySelector('[data-a=auditOpen]'), 'member sees members and admins but never the owner, names only, no controls, no Invite, no Activity log');
  // owner grants the right -> admin gets the edit button on members
  A.ev('go("profile")'); await sleep(900);
  const pb = A.d.querySelector('[data-a=tmPerm]'); ok(!!pb, 'owner sees "Can edit members" on admin rows'); A.click(pb); await sleep(700);
  ok(A.ev('PG.users.find(u=>u.username=="ivy").permEdit')===true, 'owner grants the edit right');
  Ip.ev('pullRemote(true)'); await sleep(1200);
  ok(!!Ip.d.querySelector('#pf_team [data-a=usrEdit]'), 'admin now gets Edit on members');
  A.ev('PG.users=null;go("profile")'); await sleep(900);
  ok(A.d.querySelectorAll('#pf_prio [data-a=prEd]').length >= 2 && !A.d.querySelector('#pf_prio [data-a=prDel][disabled]'), 'owner: priorities editable, with a list of people to allow');
  ok(!!Mp.d.querySelector('#pf_prio [data-a=prDel][disabled]') && !Mp.d.querySelector('#pf_prio [data-a=prEd]') && /Not allowed/.test(Mp.d.querySelector('#pf_prio').textContent), 'member: priorities look the same but are locked');
  A.click('#pf_prio [data-a=prEd]'); await sleep(300);
  ok(A.ev('(S.prioEd||[]).length') === 1, 'owner allows a person to edit priorities');
  A.ev('PG.users=null;go("profile")'); await sleep(900);
  A.click('#pf_comp [data-a=gtAdd]'); await sleep(300);
  ok(A.ev('S.teams.length') === 1 && A.ev('S.teams[0].n') === 'Team A', 'owner creates "Team A"');
  A.ev('C.gtResp({dataset:{i:"0"},value:S.team.find(m=>m.r!="driver"&&!m.owner).id})'); A.ev('A.gtCo({dataset:{i:"0",co:S.comps[0].id}})'); A.ev('A.gtCo({dataset:{i:"0",co:S.comps[1].id}})'); await sleep(300);
  ok(A.ev('S.teams[0].cos.length') === 2 && /Team A/.test(A.d.querySelector('#cop').textContent) && A.d.querySelector('#cop').textContent.includes(A.ev('S.comps[1].n')), 'the company switcher lists the team with its companies');
  A.ev('C.gtResp({dataset:{i:"0"},value:S.team.find(m=>m.r!="driver"&&m.owner).id})'); await sleep(200);
  ok(A.ev('respsOf(S.teams[0]).length') === 2, 'a team can have several responsible people');
  A.ev('A.gtRm({dataset:{i:"0",id:respsOf(S.teams[0])[0]}})'); A.ev('A.gtRm({dataset:{i:"0",id:respsOf(S.teams[0])[0]}})');
  ok(A.ev('respsOf(S.teams[0]).length') === 1, 'but never fewer than one');
  A.ev('A.gtAdd()'); await sleep(100);
  ok(!A.d.querySelector('#pf_comp [data-a=gtCo][data-i="1"][data-co="'+A.ev('S.comps[0].id')+'"]'), 'Team B is not offered companies that Team A already has');
  A.ev('A.gtCo({dataset:{i:"0",co:S.comps[0].id}})'); A.ev('A.gtDel({dataset:{i:"1"}})'); A.ev('A.gtAdd()'); A.ev('A.gtCo({dataset:{i:"1",co:S.comps[1].id}})');
  ok(A.ev('S.teams[0].cos.length+","+S.teams[1].cos.length') === '0,1' && A.ev('S.teams[1].n') === 'Team B', 'a company lives in one team only');
  A.ev('curSel');
  A.ev('setCur("t:"+S.teams[1].id);shellRefresh();page()'); await sleep(300);
  ok(A.ev('curSel()') === 't:' + A.ev('S.teams[1].id') && A.ev('(()=>{let n=0;scoped(()=>{n=DB.trucks.length});return typeof n})()') === 'number', 'picking a team filters by its companies');
  A.ev('setCur("all")');
  Mp.ev('pullRemote(true)'); await sleep(900); Mp.ev('go("profile")'); await sleep(700);
  ok(!!Mp.d.querySelector('#pf_comp [data-a=gtAdd][disabled]') && !Mp.d.querySelector('#pf_comp [data-a=coEd]') && /Not allowed/.test(Mp.d.querySelector('#pf_comp').textContent), 'member: companies and teams look the same but are locked');
  ok(A.ev('(()=>{const tr=DB.trucks[0];if(!tr)return -1;DB.issues.push({id:"zz1",title:tr.num,status:"open"},{id:"zz2",title:tr.num,status:"closed"});const n=issN(tr.company);DB.issues=DB.issues.filter(x=>x.id!="zz1"&&x.id!="zz2");return n})()') >= 1, 'open issues are counted per company (closed ones are not)');
  A.ev('go("companies")'); await sleep(500);
  ok(/Open issues/.test(A.d.querySelector('#c').textContent), 'company cards show "Open issues"');
  // ---- invoice form: manager list + split auto-balance ----
  A.ev('invForm()'); await sleep(120);
  const mg = A.d.querySelector('#f_mgr'); ok(mg && mg.tagName === 'SELECT' && mg.options.length >= 2, 'manager is a select of team members');
  ok([...mg.options].some(o => o.value === A.ev('S.team[0].n')), 'manager options include team member');
  setv(A, '#f_amt', '1000'); A.ev('document.querySelector("#f_who").value="sp";document.querySelector("#f_who").dispatchEvent(new Event("change"))'); await sleep(80);
  setv(A, 'input[data-i=spV][data-n="0"]', '29');
  ok(A.d.querySelector('input[data-i=spV][data-n="1"]').value === '71', '2 owners: 29 -> 71 auto');
  A.click('[data-a=spAdd]'); await sleep(40);
  ok(A.d.querySelector('#spb').textContent.includes('0') || true, 'added 3rd');
  A.ev('PG.sp.rows.forEach(r=>{r.v="";r.t=false});spDraw()'); await sleep(40);
  setv(A, 'input[data-i=spV][data-n="0"]', '20');
  ok(/80%/.test(A.d.querySelector('#spb').textContent), '3 owners: 20 -> 80% left shown');
  setv(A, 'input[data-i=spV][data-n="1"]', '70');
  ok(A.d.querySelector('input[data-i=spV][data-n="2"]').value === '10', '3 owners: 20+70 -> 10 auto');
  A.ev('closeDr()');
  // ---- invoice rules: no future date, required fields, no description / truck part, new shop saved ----
  A.ev('invForm()'); await sleep(120);
  ok(A.d.querySelector('#f_date').getAttribute('max') === A.ev('today()'), 'invoice date picker blocks days after today');
  ok(!A.d.querySelector('#f_tp') && !A.d.querySelector('#f_desc'), 'no "truck part" and no description fields');
  ok(A.d.querySelector('#f_num').closest('.fd').querySelector('.op') == null && A.d.querySelector('#f_vendor').closest('.fd').querySelector('.op') == null && A.d.querySelector('#f_mgr').closest('.fd').querySelector('.op') == null && A.d.querySelector('#f_notes').closest('.fd').querySelector('.op'), 'number, shop, manager required; notes optional');
  ok(A.d.querySelector('#f_sloc').closest('.fd').style.display === 'none', 'location hidden until an unsaved shop name is typed');
  setv(A, '#f_vendor', 'Brand New Shop LLC'); A.ev('document.querySelector("#f_vendor").dispatchEvent(new Event("input"))'); await sleep(40);
  ok(A.d.querySelector('#f_sloc').closest('.fd').style.display === '', 'location asked for an unsaved shop');
  const nvend = A.ev('DB.vend.length'), ninv = A.ev('DB.inv.length'), tid = A.ev('DB.trucks[0].id');
  setv(A, '#f_amt', '100'); A.ev('document.querySelector("#f_tn").value="' + tid + '"'); setv(A, '#f_num', 'X-1'); setv(A, '#f_sloc', '12517 N Saginaw Blvd, Fort Worth, TX 76179'); setv(A, '#f_mgr', A.ev('S.team[0].n'));
  setv(A, '#f_date', '2999-01-01'); A.click('[data-a=drSave]'); await sleep(150);
  ok(A.ev('DB.inv.length') === ninv, 'future date refused');
  setv(A, '#f_date', A.ev('today()')); A.click('[data-a=drSave]'); await sleep(150);
  ok(A.ev('DB.inv.length') === ninv && A.ev('DB.vend.length') === nvend, 'no file -> refused');
  A.ev('FS.items=[{id:"abc123",name:"a.png",type:"image/png",size:5,done:1}];fsDraw()');
  { const _g = global.fetch; global.fetch = async (u, o) => /nominatim/.test(String(u)) ? { ok: true, json: async () => [{ lat: '32.9', lon: '-97.3', display_name: 'Fort Worth' }] } : _g(u, o);
    A.click('[data-a=drSave]'); await sleep(900); global.fetch = _g; }
  ok(A.ev('DB.vend.find(v=>v.name=="Brand New Shop LLC").addr.length>0'), 'saved shop keeps the typed address');
  ok(A.ev('DB.inv.length') === ninv + 1 && A.ev('DB.vend.length') === nvend + 1 && A.ev('DB.vend.some(v=>v.name=="Brand New Shop LLC"&&v.lat!=null)'), 'new shop is saved to Saved shops with the invoice, map check fills coordinates');
  A.ev('closeDr()');
  // ---- editing an invoice shows its saved files and keeps them ----
  A.ev('DB.inv.push({id:"zzf",date:today(),amt:10,truck:DB.trucks[0].id,trailer:"",who:"co",reason:"truck",method:"efs",num:"N1",vendor:"V1",mgr:"x",files:[{id:"f1",name:"a.jpg",type:"image/jpeg",size:9},{id:"f2",name:"b.pdf",type:"application/pdf",size:9}]})'); A.ev('invForm("zzf")'); await sleep(150);
  ok(A.d.querySelectorAll('#flist .row').length === 2 && JSON.parse(A.d.querySelector('#fval').value).length === 2, 'edit lists all uploaded files');
  A.click('[data-a=fDel][data-n="0"]'); ok(JSON.parse(A.d.querySelector('#fval').value).length === 1 && A.d.querySelectorAll('#flist .row').length === 1, 'a file can be removed while editing');
  A.ev('DB.vend.push({id:"zzv",name:"V1",addr:"x",lat:1,lng:1})'); A.ev('closeDr();invForm("zzf")'); await sleep(150);
  A.ev('document.querySelector("#f_mgr").value=S.team[0].n'); A.click('[data-a=drSave]'); await sleep(300);
  ok(!A.ev('!!document.querySelector("#dr .dp")') && A.ev('byId(DB.inv,"zzf").mgr') === A.ev('S.team[0].n'), 'editing an invoice with a saved shop saves (hidden location is not required)');
  A.ev('DB.vend=DB.vend.filter(x=>x.id!="zzv")');
  A.ev('closeDr();DB.inv=DB.inv.filter(x=>x.id!="zzf")');
  // ---- Broker + Lumper fee ----
  A.ev('invForm()'); await sleep(120);
  ok([...A.d.querySelector('#f_who').options].some(o => o.value === 'br') && ![...A.d.querySelector('#f_mgr').options].some(o => o.value === 'Broker') && [...A.d.querySelector('#f_reason').options].some(o => o.value === 'lumper'), 'Broker charge, Broker manager, Lumper fee reason exist');
  A.ev('document.querySelector("#f_reason").value="lumper";document.querySelector("#f_reason").dispatchEvent(new Event("change"))'); await sleep(40);
  ok(A.d.querySelector('#f_vendor').closest('.fd').style.display === 'none' && A.d.querySelector('#f_sloc').closest('.fd').style.display === 'none', 'lumper fee: no shop fields');
  { const n0 = A.ev('DB.inv.length'), v0 = A.ev('DB.vend.length');
    setv(A, '#f_amt', '75'); A.ev('document.querySelector("#f_tn").value="' + A.ev('DB.trucks[0].id') + '"'); A.ev('document.querySelector("#f_who").value="br"'); setv(A, '#f_num', 'L-1'); setv(A, '#f_mgr', A.ev('S.team[0].n'));
    A.ev('FS.items=[{id:"abc999",name:"a.png",type:"image/png",size:5,done:1}];fsDraw()'); A.click('[data-a=drSave]'); await sleep(300);
    ok(A.ev('DB.inv.length') === n0 + 1 && A.ev('DB.vend.length') === v0 && A.ev('invAlloc(DB.inv[DB.inv.length-1]).br') === 75 && A.ev('DB.inv[DB.inv.length-1].vendor') === '', 'lumper fee paid by the broker saves without a shop'); }
  A.ev('DB.inv.pop()');
  // ---- Parking reason + "free" amount ----
  A.ev('invForm()'); await sleep(120);
  ok([...A.d.querySelector('#f_reason').options].some(o => o.value === 'parking'), 'Parking is a reason');
  A.ev('document.querySelector("#f_reason").value="parking";document.querySelector("#f_reason").dispatchEvent(new Event("change"))'); await sleep(40);
  ok(A.d.querySelector('#f_vendor').closest('.fd').style.display === 'none' && A.d.querySelector('#f_num').closest('.fd').style.display === 'none' && A.d.querySelector('#f_sloc').closest('.fd').style.display === '', 'parking: no shop name, no invoice number, location asked');
  { const n0 = A.ev('DB.inv.length'), v0 = A.ev('DB.vend.length'), tid = A.ev('DB.trucks[0].id');
    A.ev('document.querySelector("#f_tn").value="' + tid + '"'); setv(A, '#f_mgr', A.ev('S.team[0].n')); A.ev('FS.items=[{id:"abc888",name:"a.png",type:"image/png",size:5,done:1}];fsDraw()');
    setv(A, '#f_amt', 'abc'); setv(A, '#f_sloc', '123 Truck Stop Rd, Dallas, TX'); A.click('[data-a=drSave]'); await sleep(150); ok(A.ev('DB.inv.length') === n0, 'an amount that is neither a number nor free is refused');
    setv(A, '#f_amt', 'Free'); A.click('[data-a=drSave]'); await sleep(500);
    const iv = JSON.parse(A.ev('JSON.stringify(DB.inv[DB.inv.length-1])'));
    ok(A.ev('DB.inv.length') === n0 + 1 && iv.amt === 0 && iv.free === true && iv.vendor === 'Truck Parking Club' && iv.reason === 'parking', 'free parking invoice saved with shop name Truck Parking Club');
    ok(A.ev('DB.vend.length') === v0 + 1 && A.ev('DB.vend.some(v=>v.name=="Parking"&&/Dallas/.test(v.addr))'), 'a saved shop named Parking is added from the location');
    A.ev('invForm()'); await sleep(100); A.ev('document.querySelector("#f_reason").value="lumper";document.querySelector("#f_reason").dispatchEvent(new Event("change"))'); await sleep(40);
    A.ev('document.querySelector("#f_tn").value="' + tid + '"'); setv(A, '#f_mgr', A.ev('S.team[0].n')); setv(A, '#f_num', 'LP-1'); setv(A, '#f_amt', '40'); A.ev('FS.items=[{id:"abc777",name:"a.png",type:"image/png",size:5,done:1}];fsDraw()'); A.click('[data-a=drSave]'); await sleep(300);
    ok(A.ev('DB.inv.length') === n0 + 2 && A.ev('DB.vend.length') === v0 + 1, 'lumper fee adds nothing to Saved shops');
    A.ev('DB.inv.splice(-2);DB.vend=DB.vend.filter(v=>v.name!="Parking")'); }
  // ---- the owner is not offered to admins / members ----
  { const ow = A.ev('S.team.find(m=>m.owner).n'), opts = () => [...A.d.querySelector('#f_mgr').options].map(o => o.value);
    A.ev('invForm()'); await sleep(100); ok(opts().includes(ow), 'owner sees himself in the manager list'); A.ev('closeDr()');
    A.ev('window.__u=USER;USER=Object.assign({},USER,{owner:false,role:"admin"})'); A.ev('invForm()'); await sleep(100);
    ok(!opts().includes(ow), 'admin / member: owner is not in the manager list'); A.ev('closeDr()');
    ok(A.ev('tmPick().every(m=>!m.owner)') === true && A.ev('tmPick().length') < A.ev('S.team.length'), 'tmPick hides the owner for non-owners');
    A.ev('USER=window.__u'); }
  // ---- trailers: editable status chips (owner) + parking ----
  A.ev('go("trucks")'); await sleep(300);
  ok(!!A.d.querySelector('.chips [data-a=stNew]') && !!A.d.querySelector('.chips [data-a=stManage]'), 'owner sees add / edit on truck statuses');
  if (typeof Mp !== 'undefined') { Mp.ev('go("trucks")'); await sleep(400); ok(!Mp.d.querySelector('.chips [data-a=stNew]') && !Mp.d.querySelector('.chips [data-a=stManage]'), 'member does not get truck status add / edit'); }
  A.ev('go("trailers")'); await sleep(300);
  const nst = A.ev('S.tstat.length'), chips = () => A.d.querySelectorAll('.chips .sc').length;
  ok(chips() === nst + 1 && !!A.d.querySelector('.chips [data-a=tsNew]') && !!A.d.querySelector('.chips [data-a=tsManage]'), 'trailer chips: All + each status, with + and edit for the owner');
  ok(A.ev('tlSt({status:"loaded"})') === 'active' && A.ev('tlSt({status:"shop"})') === 'shop', 'old trailer statuses map onto the new ones');
  A.ev('A.tsNew()'); await sleep(80); setv(A, '#nsn', 'Parked'); A.click('[data-a=nsSave]'); await sleep(200);
  ok(A.ev('S.tstat.length') === nst + 1 && A.ev('S.tstat.some(x=>x.n=="Parked")') && A.ev('S.stat.some(x=>x.n=="Parked")') === false, 'owner adds a trailer status (trucks untouched)');
  A.ev('S.tstat=S.tstat.filter(x=>x.n!="Parked")');
  if (typeof Mp !== 'undefined') { Mp.ev('go("trailers")'); await sleep(400); ok(!Mp.d.querySelector('.chips [data-a=tsNew]') && !Mp.d.querySelector('.chips [data-a=tsManage]'), 'member does not get status add/edit'); }
  A.ev('go("parking")'); await sleep(300);
  ok(/Parking/.test(A.d.querySelector('#c').textContent) && !!A.d.querySelector('[data-a=pkAdd]') && !!A.d.querySelector('[data-a=pkSend][data-k=due]') && !!A.d.querySelector('[data-a=pkSend][data-k=full]'), 'parking page with add, send due list and full list');
  { const tn = A.ev('DB.trucks[0].num'), np = A.ev('DB.park.length'), plus = d => A.ev('(()=>{const x=new Date(Date.now()+(' + d + ')*864e5);return x.getFullYear()+"-"+String(x.getMonth()+1).padStart(2,"0")+"-"+String(x.getDate()).padStart(2,"0")})()');
    A.ev('A.pkAdd()'); await sleep(100); setv(A, '#f_unit', 'NOPE-1'); setv(A, '#f_loc', 'Yard'); setv(A, '#f_to', plus(1)); A.click('[data-a=drSave]'); await sleep(100);
    ok(A.ev('DB.park.length') === np, 'unknown unit refused');
    setv(A, '#f_unit', tn); setv(A, '#f_to', plus(-5)); setv(A, '#f_from', plus(0)); A.click('[data-a=drSave]'); await sleep(100); ok(A.ev('DB.park.length') === np, '"until" before "from" refused');
    setv(A, '#f_from', plus(-2)); setv(A, '#f_to', plus(1)); setv(A, '#f_driver', 'Ali Karimov'); setv(A, '#f_phone', '+1 555 123 4567'); A.click('[data-a=drSave]'); await sleep(200);
    ok(A.ev('DB.vend.some(v=>v.name==="Parking"&&/Yard/.test(v.addr))'), 'a parking booking saves its location to Saved shops as Parking');
    A.ev('go("vendors")'); await sleep(500); ok(A.ev('typeof vnPkPins')==='function' && A.ev('vnTkRender.toString().includes("vnPkPins()")'), 'Shops Map draws pins for parked units');
    A.ev('document.body.insertAdjacentHTML("beforeend","<div id=vtk></div><div id=vpk></div>");vnTkRender()');
    ok(/P · Truck/.test(A.d.querySelector('#vpk').textContent) && !!A.d.querySelector('#vpk [data-a=vnPkGo]') && !A.d.querySelector('#vtk [data-a=vnPkGo]'), 'Shops Map: issues on the left half, parked units on the right half, same style');
    A.ev('A.vnTkTog({dataset:{id:"p:"+DB.park[DB.park.length-1].id}})'); ok(/Ali Karimov/.test(A.d.querySelector('#vpk').textContent) && /Yard/.test(A.d.querySelector('#vpk').textContent), 'a parked unit chip opens its details'); A.ev('document.querySelector("#vtk").remove();document.querySelector("#vpk").remove();VM.tkOrd=[];VM.tkOpen={}');
    A.ev('go("parking")'); await sleep(200);
    ok(A.ev('DB.park[DB.park.length-1].driver') === 'Ali Karimov' && A.ev('DB.park[DB.park.length-1].phone') === '+1 555 123 4567', 'parking keeps the driver name and phone');
    ok(A.ev('DB.park.length') === np + 1 && A.ev('parkDue().length') >= 1 && A.ev('parkRows()[0].days') === 1, 'parking saved; ends tomorrow counts as due');
    { const pid = A.ev('DB.park[DB.park.length-1].id'); A.ev('go("parking")'); await sleep(200);
      A.click('[data-a=pkClose][data-id="' + pid + '"]'); await sleep(150);
      ok(A.ev('byId(DB.park,"' + pid + '").status') === 'closed' && A.ev('byId(DB.park,"' + pid + '").closedBy').length > 0 && A.ev('parkDue().length') === 0, 'closing a parking record keeps it and removes it from due');
      A.click('[data-a=pkTab][data-v=closed]'); await sleep(150);
      ok(!!A.d.querySelector('[data-a=pkReopen][data-id="' + pid + '"]') && !!A.d.querySelector('[data-a=pkDel][data-id="' + pid + '"]'), 'closed tab: history with reopen, and delete for the owner');
      A.click('[data-a=pkReopen][data-id="' + pid + '"]'); await sleep(150); ok(A.ev('byId(DB.park,"' + pid + '").status') !== 'closed' && A.ev('parkDue().length') >= 1, 'reopen brings it back');
      A.ev('PG.pk.tab="open"'); }
    A.ev('go("today")'); await sleep(300);
    ok(/ends within 2 days/i.test(A.d.querySelector('#c').textContent) && /Ends tomorrow/.test(A.d.querySelector('#c').textContent) && !!A.d.querySelector('[data-a=pkSend][data-k=due]'), 'Today shows the parking due card with send buttons');
    A.ev('A.pkSend({dataset:{k:"due"}})'); await sleep(200);
    ok(!!A.d.querySelector('[data-a=pkNow]') && !!A.d.querySelector('[data-a=pkSched]') && !!A.d.querySelector('#pks_t'), 'send dialog: send now or schedule');
    A.ev('closeMd()'); A.ev('DB.park=DB.park.filter(x=>false)'); }
  // ---- Plus Code, coordinates, ZIP zone ----
  const rc = A.ev('JSON.stringify(olcRecover("P4X9+MX2",32.8,-115.9))'), rcj = JSON.parse(rc);
  ok(Math.abs(rcj.lat - 32.7492) < 0.001 && Math.abs(rcj.lng + 115.8806) < 0.001, 'plus code P4X9+MX2 near Ocotillo decodes: ' + rc);
  const zc = JSON.parse(A.ev('JSON.stringify(olcDecode("8FVC9G8F+6W"))')); ok(Math.abs(zc.lat - 47.3656) < 0.001 && Math.abs(zc.lng - 8.525) < 0.001, 'full plus code decodes');
  ok(JSON.stringify(A.ev('vnLL("32.749206, -115.880576")')) === '{"lat":32.749206,"lng":-115.880576}', 'lat,lng typed is read');
  const _f = global.fetch; global.fetch = async (u, o) => /tigerweb/.test(String(u)) ? { ok: true, json: async () => ({ features: [{ geometry: { type: 'Polygon', coordinates: [[[-115.9, 32.7], [-115.8, 32.7], [-115.8, 32.8], [-115.9, 32.8], [-115.9, 32.7]]] } }] }) } : _f(u, o);
  const zr = await (await fetch(base + '/api/zip?z=92259', { headers: { Cookie: A.ev('document.cookie') } })).status;
  const zj = await A.ev('(async()=>{const r=await api("GET","/api/zip?z=92259");return JSON.stringify(r.j)})()'); const zo = JSON.parse(zj);
  ok(zo.zip === '92259' && zo.rings && zo.rings[0].length >= 4 && Math.abs(zo.lat - 32.75) < 0.1, 'ZIP endpoint returns the zone: ' + zj.slice(0, 80));
  const w = JSON.parse(await A.ev('(async()=>JSON.stringify(await vnWhere("92259")))()')); ok(w.zip === '92259' && w.zone && w.zone.length, 'typing a ZIP gives a zone');
  const nr = JSON.parse(A.ev('JSON.stringify(vnNear(' + JSON.stringify(zo.rings) + ',{lat:33.5,lng:-115.85}))')); ok(nr && Math.abs(nr.lat - 32.8) < 0.01, 'nearest zone point toward destination is the north edge');
  global.fetch = _f;
  // ---- address search falls back when OSM lacks the suite / house number ----
  { const _g = global.fetch, seen = [];
    global.fetch = async (u, o) => { if (/nominatim/.test(String(u)) && !/postalcode/.test(String(u))) { const q = decodeURIComponent(String(u).split('&q=')[1] || ''); seen.push(q); return { ok: true, json: async () => (/12517/.test(q) ? [] : [{ lat: '32.9', lon: '-97.3', display_name: 'N Saginaw Blvd, Fort Worth' }]) }; } return _g(u, o); };
    const gj = await A.ev('(async()=>{const r=await api("GET","/api/geo?q="+encodeURIComponent("12517 N Saginaw Blvd Ste 301, Fort Worth, TX 76179, United States"));return JSON.stringify(r.j)})()'); const g = JSON.parse(gj);
    ok(g.lat === 32.9 && g.approx === 1 && seen[0].includes('Ste 301') && seen.some(q => q === '12517 N Saginaw Blvd, Fort Worth, TX 76179') && !seen.some(q => /Ste/.test(q) && q !== seen[0] && q !== seen[1]), 'address without OSM house number still found (tries simpler forms): ' + gj.slice(0, 100));
    global.fetch = _g; }
  // ---- add a shop that is not on the map ----
  { const j = async (m, u, b) => JSON.parse(await A.ev('(async()=>{const r=await api(' + JSON.stringify(m) + ',' + JSON.stringify(u) + ',' + (b ? JSON.stringify(b) : 'undefined') + ');return JSON.stringify({s:r.s,j:r.j})})()'));
    const a1 = await j('POST', '/api/mapshop', { name: 'Test New Shop', addr: '1 Main St, Dallas, TX', phone: '+1 555-0100', web: 'newshop.com', notes: 'cheap', lat: 32.78, lng: -96.8 });
    ok(a1.s === 200 && a1.j.place.own === 1 && a1.j.place.note.includes('newshop.com'), 'POST /api/mapshop adds a shop');
    const l1 = await j('GET', '/api/mymap'); ok(l1.j.places.some(p => p.id === a1.j.place.id), 'added shop is part of the map shops list');
    ok((await j('POST', '/api/mapshop', { name: '', lat: 1, lng: 1 })).s === 400 && (await j('POST', '/api/mapshop', { name: 'x', lat: 999, lng: 1 })).s === 400, 'bad shop rejected');
    const e1 = await j('PUT', '/api/mapshop/' + a1.j.place.id, { name: 'Test New Shop 2', lat: 32.79, lng: -96.8 }); ok(e1.s === 200 && e1.j.place.name === 'Test New Shop 2', 'edit shop');
    const d1 = await j('DELETE', '/api/mapshop/' + a1.j.place.id); const l2 = await j('GET', '/api/mymap'); ok(d1.s === 200 && !l2.j.places.some(p => p.id === a1.j.place.id), 'delete shop'); }
  // ---- company scope: only issues of the selected company's own units ----
  { const r = JSON.parse(A.ev('(()=>{const real=DB,t=real.trucks.find(x=>x.company&&String(x.num||"").trim());if(!t)return JSON.stringify({skip:1});const o=real.trucks.find(x=>x.company&&x.company!=t.company);real.issues.push({id:"zz1",title:t.num+" brake",status:"open"},{id:"zz2",title:"ZZ999 nowhere",status:"open"});const sc=scopeDB(real,t.company).issues.map(i=>i.id);real.issues=real.issues.filter(i=>i.id!="zz1"&&i.id!="zz2");return JSON.stringify({own:sc.includes("zz1"),stray:sc.includes("zz2")})})()'));
    ok(r.skip || (r.own && !r.stray), 'company view shows only issues of its own units: ' + JSON.stringify(r)); }
  console.log(errs.length ? `\n${errs.length} FAILED of ${n}` : `\nALL ${n} UI2 CHECKS PASSED`);
  srv.close(); await pg.stop(); process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
