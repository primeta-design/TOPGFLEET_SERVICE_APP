'use strict';
// Telegram bot test with a fake Telegram API (no network).
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const EP = require('embedded-postgres').default;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfpg2-')); try { fs.chmodSync(dir, 0o777); if (process.getuid() === 0) require('child_process').execSync('chown -R postgres ' + dir); } catch {}
const SENT = []; const realFetch = global.fetch;
global.fetch = async (u, o) => { if (String(u).startsWith('https://api.telegram.org/bot')) { const m = String(u).split('/').pop(); let b = {}; if (o && typeof o.body === 'string') b = JSON.parse(o.body); else if (o && o.body instanceof FormData) { const fd = o.body; b = { form: true, chat_id: fd.get('chat_id'), caption: fd.get('caption'), media: fd.get('media') ? JSON.parse(fd.get('media')) : null, files: [...fd.entries()].filter(([k, v]) => typeof v === 'object').map(([k, v]) => v.name) }; } SENT.push({ m, b }); return { json: async () => m === 'getMe' ? { ok: true, result: { username: 'testbot', id: 7 } } : m === 'getWebhookInfo' ? { ok: true, result: { url: 'https://x/tg/hook' } } : { ok: true, result: {} } }; } return realFetch(u, o); };
(async () => {
  const pg = new EP({ databaseDir: dir, user: 'tf', password: 'tf', port: 54331, persistent: false });
  await pg.initialise(); await pg.start(); await pg.createDatabase('tf');
  Object.assign(process.env, { DATABASE_URL: 'postgres://tf:tf@localhost:54331/tf', APP_SECRET: 'y'.repeat(40), RATE_LOGIN_MAX: '1000', ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: 'Correct-Horse-9!', DATA_DIR: path.join(os.tmpdir(), 'tff2-' + process.pid), TELEGRAM_BOT_TOKEN: '123:TESTTOKEN', TELEGRAM_WEBHOOK_SECRET: 'hooksecret-hooksecret-1234567890' });
  const { app, bootstrap } = require('../server.js'); await bootstrap();
  const srv = app.listen(0), port = srv.address().port; let jar = '', n = 0; const errs = [];
  const call = (method, url, body, h = {}) => new Promise(r => { const data = body === undefined ? null : JSON.stringify(body);
    const rq = http.request({ port, method, path: url, headers: { Host: 'localhost:' + port, 'X-Requested-With': 'tf', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(jar ? { Cookie: 'tf_sid=' + jar } : {}), ...h } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { const sc = res.headers['set-cookie']; if (sc) { const m = /tf_sid=([^;]*)/.exec(sc[0]); if (m) jar = m[1]; } let j; try { j = JSON.parse(b); } catch {} r({ s: res.statusCode, j }); }); }); if (data) rq.write(data); rq.end(); });
  const ok = (c, m) => { n++; if (!c) { errs.push(m); console.log('  FAIL', m); } };
  const sleep = ms => new Promise(z => setTimeout(z, ms));
  const hook = (text, chat = 555, type = 'private', secret = 'hooksecret-hooksecret-1234567890') => call('POST', '/tg/hook', { update_id: 1, message: { text, chat: { id: chat, type } } }, secret === null ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret });
  const last = () => SENT.filter(x => x.m === 'sendMessage').pop();
  let r = await call('POST', '/api/login', { email: 'boss@example.com', password: 'Correct-Horse-9!' }); ok(r.s === 200, 'admin login');
  r = await call('GET', '/api/tg/info'); ok(r.s === 200 && r.j.enabled && r.j.bot === 'testbot' && r.j.linked === false, 'info: bot enabled, not linked');
  const today = new Date().toISOString().slice(0, 10);
  r = await call('POST', '/api/sync', { kv: { prio: [{ id: 'p1', n: 'High' }, { id: 'p2', n: 'Medium' }, { id: 'p3', n: 'Low' }], stat: [{ id: 's1', n: 'Active', w: true }, { id: 's2', n: 'At shop', w: false }], tg: { mgr: '-100777', work: '-100888', inv: '', topic: '', times: [], tz: 'America/Chicago' } }, upserts: [{ c: 'trucks', id: 't1', d: { num: '4382', status: 's2', miles: 1000 } }, { c: 'trucks', id: 't2', d: { num: '4391', status: 's1', miles: 5 } }, { c: 'issues', id: 'i1', d: { title: '4382 brakes', desc: 'squealing', pr: 'p1', status: 'open' } }, { c: 'docs', id: 'd1', d: { kind: 'truck', uid: 't2', title: 'Registration', exp: '2020-01-01' } }] }); ok(r.s === 200, 'seed data');
  // webhook security
  r = await hook('/help', 555, 'private', null); ok(r.s === 403, 'webhook without secret refused');
  r = await hook('/help', 555, 'private', 'wrong'); ok(r.s === 403, 'webhook with wrong secret refused');
  await sleep(500); SENT.length = 0; r = await hook('/status'); await sleep(500); ok(r.s === 200 && last() && /not linked/i.test(last().b.text), 'unlinked chat gets link instructions');
  r = await hook('/chatid', 999, 'group'); await sleep(200); ok(/999/.test(last().b.text), '/chatid works anywhere');
  // link
  r = await call('POST', '/api/tg/code'); ok(r.s === 200 && /^[A-Z2-9]{8}$/.test(r.j.code) && r.j.link.includes('testbot?start=' + r.j.code), 'link code issued');
  const code = r.j.code;
  await hook('/start WRONGCODE'); await sleep(200); ok(/wrong or expired/.test(last().b.text), 'bad code refused');
  await hook('/start ' + code); await sleep(300); ok(/Linked to/.test(last().b.text), 'valid code links the chat');
  await hook('/start ' + code); await sleep(200); ok(/wrong or expired/.test(last().b.text), 'code is single-use');
  r = await call('GET', '/api/tg/info'); ok(r.j.linked === true, 'info shows linked');
  // commands
  await hook('/status'); await sleep(300); ok(/Trucks: 2/.test(last().b.text) && /At shop/.test(last().b.text), '/status lists trucks by status');
  await hook('/alerts'); await sleep(300); const al = last().b.text; ok(/4391: Registration/.test(al) && /4382: At shop/.test(al) && /brakes/.test(al), '/alerts shows expired doc, can’t-work truck, High issue');
  await hook('/digest off'); await sleep(200); r = await call('GET', '/api/tg/info'); ok(r.j.digest === false, '/digest off stored');
  // group commands only for configured groups
  await hook('/alerts', 4242, 'group'); await sleep(200); ok(/not configured/.test(last().b.text), 'unknown group refused');
  await hook('/alerts', -100777, 'supergroup'); await sleep(300); ok(/Alerts/.test(last().b.text) && String(last().b.chat_id) === '-100777', 'configured managers group gets alerts');
  // new High issue pings managers group
  SENT.length = 0; await call('POST', '/api/sync', { upserts: [{ c: 'issues', id: 'i2', d: { title: '4391 no lights', pr: 'p1', status: 'open' } }, { c: 'issues', id: 'i3', d: { title: 'wiper', pr: 'p3', status: 'open' } }] }); await sleep(500);
  const hot = SENT.filter(x => x.m === 'sendMessage' && x.b.chat_id === '-100777'); ok(hot.length === 1 && /no lights/.test(hot[0].b.text) && !/wiper/.test(hot[0].b.text), 'new High issue pings managers group (Low one does not)');
  SENT.length = 0; await call('POST', '/api/sync', { upserts: [{ c: 'issues', id: 'i2', d: { title: '4391 no lights', pr: 'p1', status: 'open', desc: 'edit' } }] }); await sleep(300); ok(SENT.filter(x => x.m === 'sendMessage').length === 0, 'editing an issue does not ping again');
  // new invoice goes to the invoice group
  r = await call('POST', '/api/sync', { kv: { tg: { mgr: '-100777', work: '-100888', inv: '-100999', topic: '', times: [], tz: 'America/Chicago' } } }); ok(r.s === 200, 'set invoice group');
  SENT.length = 0; await call('POST', '/api/sync', { upserts: [{ c: 'inv', id: 'v1', d: { truck: 't1', amt: 150, reason: 'truck', method: 'efs', who: 'sp', sby: 'pct', split: [{ p: 'co', v: 25 }, { p: 'dr', v: 75 }], desc: 'brake pads', num: '77', date: '2026-11-17' } }] }); await sleep(500);
  const iv = SENT.filter(x => x.m === 'sendMessage' && x.b.chat_id === '-100999'); ok(iv.length === 1 && /^Truck: 4382\nTrailer:\nDriver name:\nReason: Truck Issue — brake pads\nAmount: \$150\.00\nPayment method: EFS Money Code\nInvoice number: 77\nResponsible: Split charge \(Company 25%, Driver 75%\)\nDate: 2026-11-17\nLink: <a href="https:\/\/localhost:\d+\/invoices\?id=v1">Open invoice<\/a>$/.test(iv[0].b.text), 'new invoice is posted in the requested format');
  SENT.length = 0; await call('POST', '/api/sync', { upserts: [{ c: 'inv', id: 'v1', d: { truck: 't1', amt: 160, reason: 'truck', method: 'efs', who: 'co' } }] }); await sleep(300); ok(SENT.filter(x => x.m === 'sendMessage').length === 0, 'editing an invoice does not post again');
  // per-company invoice chat
  r = await call('POST', '/api/sync', { kv: { comps: [{ id: 'cA', n: 'Alpha', c: '#111', inv: '-100555' }, { id: 'cB', n: 'Beta', c: '#222' }] }, upserts: [{ c: 'trucks', id: 't7', d: { num: '7777', status: 's1', company: 'cA' } }, { c: 'trucks', id: 't8', d: { num: '8888', status: 's1', company: 'cB' } }] }); ok(r.s === 200, 'company chat set');
  SENT.length = 0; await call('POST', '/api/sync', { upserts: [{ c: 'inv', id: 'vA', d: { truck: 't7', amt: 10, reason: 'truck', method: 'efs', who: 'co', date: '2026-11-17' } }, { c: 'inv', id: 'vB', d: { truck: 't8', amt: 20, reason: 'truck', method: 'efs', who: 'co', date: '2026-11-17' } }] }); await sleep(700);
  ok(SENT.filter(x => x.m === 'sendMessage' && x.b.chat_id === '-100555' && /7777/.test(x.b.text)).length === 1, 'invoice of company A goes to company A chat');
  ok(SENT.filter(x => x.m === 'sendMessage' && x.b.chat_id === '-100555' && /8888/.test(x.b.text)).length === 0, 'company B invoice not in A chat');
  ok(SENT.filter(x => x.m === 'sendMessage' && x.b.chat_id === '-100999' && /8888/.test(x.b.text)).length === 1, 'company without chat falls back to general group');
  // attachments: upload a PDF, attach to an invoice, it follows the message into the group
  const pdfBuf = Buffer.from('%PDF-1.4\n%t\n'); const up = await new Promise(z => { const rq = http.request({ port, method: 'POST', path: '/api/files', headers: { Host: 'localhost:' + port, 'X-Requested-With': 'tf', 'Content-Type': 'application/pdf', 'Content-Length': pdfBuf.length, 'X-Filename': encodeURIComponent('bill 1.pdf'), Cookie: 'tf_sid=' + jar } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => z(JSON.parse(b))); }); rq.end(pdfBuf); });
  ok(up.id, 'file uploaded');
  SENT.length = 0; await call('POST', '/api/sync', { upserts: [{ c: 'inv', id: 'v2', d: { truck: 't1', amt: 10, reason: 'tow', method: 'cc', who: 'co', files: [{ id: up.id, name: 'bill 1.pdf', type: 'application/pdf', size: 12 }, { id: '../../etc/passwd', name: 'x' }, { id: 'nonexistent', name: 'y' }] } }] }); await sleep(700);
  const docs = SENT.filter(x => x.m === 'sendDocument' && x.b.chat_id === '-100999');
  ok(docs.length === 1 && docs[0].b.files[0] === 'bill 1.pdf' && /^Truck: 4382/.test(docs[0].b.caption) && SENT.filter(x => x.m === 'sendMessage' && x.b.chat_id === '-100999').length === 0, 'single file: one message, file with the invoice text as caption (bad ids ignored)');
  const up2 = await new Promise(z => { const rq = http.request({ port, method: 'POST', path: '/api/files', headers: { Host: 'localhost:' + port, 'X-Requested-With': 'tf', 'Content-Type': 'application/pdf', 'Content-Length': pdfBuf.length, 'X-Filename': encodeURIComponent('two.pdf'), Cookie: 'tf_sid=' + jar } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => z(JSON.parse(b))); }); rq.end(pdfBuf); });
  SENT.length = 0; await call('POST', '/api/sync', { upserts: [{ c: 'inv', id: 'v3', d: { truck: 't1', amt: 20, reason: 'tow', method: 'cc', who: 'co', files: [{ id: up.id }, { id: up2.id }] } }] }); await sleep(700);
  const alb = SENT.filter(x => x.m === 'sendMediaGroup');
  ok(alb.length === 1 && alb[0].b.media.length === 2 && alb[0].b.media[0].type === 'document' && /^Truck: 4382/.test(alb[0].b.media[0].caption) && !alb[0].b.media[1].caption && alb[0].b.files.join() === 'bill 1.pdf,two.pdf', 'several files: one album, text as the caption of the first');
  // admin actions
  r = await call('POST', '/api/tg/test'); ok(r.s === 200 && r.j.results.length >= 3 && r.j.results.every(x => x.ok), 'test message reaches groups and linked chat');
  SENT.length = 0; r = await call('POST', '/api/tg/send-now'); ok(r.s === 200 && r.j.ok && SENT.some(x => x.b.chat_id === '-100888' && /High priority/.test(x.b.text)), 'send-now posts the High list to workers group');
  r = await call('POST', '/api/tg/reconnect'); ok(r.s === 200 && r.j.ok && SENT.some(x => x.m === 'setWebhook' && x.b.secret_token && /\/tg\/hook$/.test(x.b.url)), 'reconnect registers webhook with secret');
  // unlink
  await hook('/stop'); await sleep(200); r = await call('GET', '/api/tg/info'); ok(r.j.linked === false, '/stop unlinks');
  // member role cannot use admin actions
  r = await call('POST', '/api/users', { name: 'Mem', username: 'mem', email: 'mem@example.com', role: 'member', password: 'Purple-Anchor-42' }); ok(r.s === 200, 'member created');
  jar = ''; await call('POST', '/api/login', { email: 'mem@example.com', password: 'Purple-Anchor-42' });
  r = await call('POST', '/api/tg/test'); ok(r.s === 403, 'member cannot send test'); r = await call('POST', '/api/tg/send-now'); ok(r.s === 403, 'member cannot send-now'); r = await call('POST', '/api/tg/reconnect'); ok(r.s === 403, 'member cannot reconnect');
  console.log(errs.length ? `\n${errs.length} FAILED of ${n}` : `\nALL ${n} TG CHECKS PASSED`);
  srv.close(); await pg.stop(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
