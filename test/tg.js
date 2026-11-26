'use strict';
// Telegram bot test with a fake Telegram API (no network).
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const EP = require('embedded-postgres').default;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfpg2-')); try { fs.chmodSync(dir, 0o777); if (process.getuid() === 0) require('child_process').execSync('chown -R postgres ' + dir); } catch {}
const SENT = []; const AIREQ = []; const realFetch = global.fetch;
global.fetch = async (u, o) => { if (String(u).startsWith('https://api.telegram.org/bot')) { const m = String(u).split('/').pop(); let b = {}; if (o && typeof o.body === 'string') b = JSON.parse(o.body); else if (o && o.body instanceof FormData) { const fd = o.body; b = { form: true, chat_id: fd.get('chat_id'), caption: fd.get('caption'), media: fd.get('media') ? JSON.parse(fd.get('media')) : null, files: [...fd.entries()].filter(([k, v]) => typeof v === 'object').map(([k, v]) => v.name) }; } SENT.push({ m, b }); return { json: async () => m === 'getMe' ? { ok: true, result: { username: 'testbot', id: 7 } } : m === 'getWebhookInfo' ? { ok: true, result: { url: 'https://x/tg/hook' } } : { ok: true, result: m === 'sendMediaGroup' ? [{ message_id: 555 }, { message_id: 556 }] : { message_id: 555 } } }; } if (String(u).startsWith('https://nominatim.openstreetmap.org/')) return { ok: true, json: async () => [{ lat: '32.78', lon: '-96.8', display_name: 'Dallas, TX' }] }; if (String(u).startsWith('https://router.project-osrm.org/')) return { ok: true, json: async () => ({ routes: [{ distance: 160934, duration: 5400 }] }) }; if (String(u).startsWith('https://api.anthropic.com/')) { const b = JSON.parse(o.body); AIREQ.push({ key: o.headers['x-api-key'], b }); const last = b.messages[b.messages.length - 1]; let content, stop = 'end_turn';
    if (Array.isArray(last.content) && last.content[0].type === 'tool_result') content = [{ type: 'text', text: 'Done: ' + String(last.content[0].content).slice(0, 60) }];
    else if (/rename/.test(last.content)) { content = [{ type: 'tool_use', id: 'tu2', name: 'save_record', input: { coll: 'trucks', id: 't1', data: { notes: 'by ai' } } }]; stop = 'tool_use'; }
    else if (/trucks/.test(last.content)) { content = [{ type: 'tool_use', id: 'tu1', name: 'list_records', input: { coll: 'trucks' } }]; stop = 'tool_use'; }
    else content = [{ type: 'text', text: 'Hello owner' }];
    return { ok: true, status: 200, json: async () => ({ content, stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 100 } }) }; }
  return realFetch(u, o); };
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
  const hook = (text, chat = 555, type = 'private', secret = 'hooksecret-hooksecret-1234567890', from) => call('POST', '/tg/hook', { update_id: 1, message: { text, chat: { id: chat, type }, from: { id: from === undefined ? 555 : from } } }, secret === null ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret });
  const last = () => SENT.filter(x => x.m === 'sendMessage').pop();
  let r = await call('POST', '/api/login', { email: 'boss@example.com', password: 'Correct-Horse-9!' }); ok(r.s === 200, 'admin login');
  r = await call('GET', '/api/tg/info'); ok(r.s === 200 && r.j.enabled && r.j.bot === 'testbot' && r.j.linked === false, 'info: bot enabled, not linked');
  const today = new Date().toISOString().slice(0, 10);
  r = await call('POST', '/api/sync', { kv: { prio: [{ id: 'p1', n: 'High' }, { id: 'p2', n: 'Medium' }, { id: 'p3', n: 'Low' }], stat: [{ id: 's1', n: 'Active', w: true }, { id: 's2', n: 'At shop', w: false }], tg: { work: '-100888', topic: '', times: [], tz: 'America/Chicago' }, comps: [{ id: 'cM', n: 'Main', c: '#000', inv: '-100999', mgr: '-100777' }] }, upserts: [{ c: 'trucks', id: 't1', d: { num: '4382', status: 's2', miles: 1000, company: 'cM' } }, { c: 'trucks', id: 't2', d: { num: '4391', status: 's1', miles: 5, company: 'cM' } }, { c: 'issues', id: 'i1', d: { title: '4382 brakes', desc: 'squealing', pr: 'p1', status: 'open' } }, { c: 'docs', id: 'd1', d: { kind: 'truck', uid: 't2', title: 'Registration', exp: '2020-01-01' } }] }); ok(r.s === 200, 'seed data');
  // webhook security
  r = await hook('/help', 555, 'private', null); ok(r.s === 403, 'webhook without secret refused');
  r = await hook('/help', 555, 'private', 'wrong'); ok(r.s === 403, 'webhook with wrong secret refused');
  await sleep(500); SENT.length = 0; r = await hook('/status'); await sleep(500); ok(r.s === 200 && SENT.length === 0, 'unlinked chat gets NO reply');
  r = await hook('hello bot'); await sleep(300); ok(SENT.length === 0, 'unlinked free text gets NO reply');
  SENT.length = 0; r = await hook('/chatid', 999, 'group', undefined, 777); await sleep(200); ok(SENT.length === 0, '/chatid from a stranger gets no reply');
  // link
  r = await call('POST', '/api/tg/code'); ok(r.s === 200 && /^[A-Z2-9]{8}$/.test(r.j.code) && r.j.link.includes('testbot?start=' + r.j.code), 'link code issued');
  const code = r.j.code;
  SENT.length = 0; await hook('/start WRONGCODE'); await sleep(200); ok(SENT.length === 0, 'bad code from an unlinked person: silence');
  await hook('/start ' + code); await sleep(300); ok(/Linked to/.test(last().b.text), 'valid code links the chat');
  await hook('/start ' + code); await sleep(200); ok(/wrong or expired/.test(last().b.text), 'code is single-use (owner is told)');
  await hook('/chatid', 999, 'group'); await sleep(200); ok(/999/.test(last().b.text), 'owner can /chatid in a group');
  r = await call('GET', '/api/tg/info'); ok(r.j.linked === true, 'info shows linked');
  // AI assistant (owner only)
  SENT.length = 0; await hook('how many trucks'); await sleep(400); ok(/ANTHROPIC_API_KEY/.test(last().b.text) && AIREQ.length === 0, 'without a key the owner is told how to switch the AI on');
  process.env.ANTHROPIC_API_KEY = 'sk-test'; SENT.length = 0;
  await hook('how many trucks do I have'); await sleep(900); ok(AIREQ.length === 2 && AIREQ[0].key === 'sk-test' && AIREQ[0].b.tools.length >= 8 && /owner of TOPGFLEET/.test(AIREQ[0].b.system) && /4382/.test(JSON.stringify(AIREQ[1].b.messages)) && /^Done: /.test(last().b.text), 'free text goes to the AI, tool result is fed back, answer is sent');
  AIREQ.length = 0; await hook('rename note on 4382'); await sleep(900); r = await call('GET', '/api/state'); ok(r.j.DB.trucks.find(x => x.id === 't1').notes === 'by ai', 'AI tool call changed the record on the site');
  AIREQ.length = 0; await hook('hi again'); await sleep(600); ok(AIREQ.length === 1 && AIREQ[0].b.messages.length >= 3, 'conversation memory is kept');
  await hook('/new'); await sleep(200); AIREQ.length = 0; await hook('hi'); await sleep(500); ok(AIREQ[0].b.messages.length === 1, '/new clears the memory');
  SENT.length = 0; AIREQ.length = 0; await hook('how many trucks', 556, 'private', undefined, 556); await sleep(400); ok(SENT.length === 0 && AIREQ.length === 0, 'stranger gets nothing and costs no AI call');
  // commands
  await hook('/status'); await sleep(300); ok(/Trucks: 2/.test(last().b.text) && /At shop/.test(last().b.text), '/status lists trucks by status');
  await hook('/alerts'); await sleep(300); const al = last().b.text; ok(/4391: Registration/.test(al) && /4382: At shop/.test(al) && /brakes/.test(al), '/alerts shows expired doc, can’t-work truck, High issue');
  await hook('/digest off'); await sleep(200); r = await call('GET', '/api/tg/info'); ok(r.j.digest === false, '/digest off stored');
  // group commands only for configured groups
  await hook('/alerts', 4242, 'group'); await sleep(200); ok(/not configured/.test(last().b.text), 'unknown group refused');
  SENT.length = 0; await hook('/alerts', -100777, 'supergroup', undefined, 888); await sleep(200); ok(SENT.length === 0, 'non-owner in a configured group: no reply');
  await hook('/alerts', -100777, 'supergroup'); await sleep(300); ok(/Alerts/.test(last().b.text) && String(last().b.chat_id) === '-100777', 'configured managers group gets alerts');
  // new High issue pings managers group
  SENT.length = 0; await call('POST', '/api/sync', { upserts: [{ c: 'issues', id: 'i2', d: { title: '4391 no lights', pr: 'p1', status: 'open' } }, { c: 'issues', id: 'i3', d: { title: 'wiper', pr: 'p3', status: 'open' } }] }); await sleep(500);
  const hot = SENT.filter(x => x.m === 'sendMessage' && x.b.chat_id === '-100777'); ok(hot.length === 1 && /no lights/.test(hot[0].b.text) && !/wiper/.test(hot[0].b.text), 'new High issue pings the managers chat of ITS company (Low one does not)');
  SENT.length = 0; await call('POST', '/api/sync', { upserts: [{ c: 'issues', id: 'i2', d: { title: '4391 no lights', pr: 'p1', status: 'open', desc: 'edit' } }] }); await sleep(300); ok(SENT.filter(x => x.m === 'sendMessage').length === 0, 'editing an issue does not ping again');
  // new invoice goes to the invoice group
  r = await call('POST', '/api/sync', { kv: { tg: { work: '-100888', topic: '', times: [], tz: 'America/Chicago' } } }); ok(r.s === 200, 'set telegram settings');
  // ---- parking lists to the workers group + schedule + trailer statuses ----
  { const D1 = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
    r = await call('POST', '/api/sync', { upserts: [{ c: 'trucks', id: 'pk1', d: { id: 'pk1', num: 'P-1', company: 'c1', status: 's1' } }, { c: 'trailers', id: 'pk2', d: { id: 'pk2', num: 'P-9', company: 'c1', status: 'active' } }, { c: 'trailers', id: 'pk3', d: { id: 'pk3', num: 'P-5', company: 'c1', status: 'active' } },
      { c: 'park', id: 'a1', d: { id: 'a1', kind: 'truck', uid: 'pk1', loc: 'Dallas lot', driver: 'Ali K', phone: '+1555', from: D1(-3), to: D1(1) } }, { c: 'park', id: 'a2', d: { id: 'a2', kind: 'trailer', uid: 'pk2', loc: 'Far yard', from: D1(0), to: D1(9) } }, { c: 'park', id: 'a3', d: { id: 'a3', kind: 'trailer', uid: 'pk3', loc: 'Old yard', from: D1(-9), to: D1(-1) } }] }); ok(r.s === 200, 'parking records saved');
    SENT.length = 0; r = await call('POST', '/api/park/send', { kind: 'due', scope: 'all' }); await sleep(300); let m = last();
    ok(r.s === 200 && r.j.ok && m && m.b.chat_id === '-100888' && /due soon \(2\)/.test(m.b.text) && m.b.text.includes('P-1') && m.b.text.includes('ends tomorrow') && m.b.text.includes('Ali K · +1555') && m.b.text.includes('Truck unit:') && m.b.text.includes('Booking days:') && m.b.text.includes('(drop off)') && m.b.text.includes('Location:') && m.b.text.includes('P-5') && m.b.text.includes('overdue by 1 day') && !m.b.text.includes('P-9'), 'due list: ends within 2 days or overdue, goes to the workers group: ' + (m && m.b.text.slice(0, 160)));
    SENT.length = 0; r = await call('POST', '/api/park/send', { kind: 'full', scope: 'all' }); await sleep(300); m = last();
    ok(r.j.ok && m.b.text.includes('full list') && m.b.text.includes('P-9') && m.b.text.includes('Location:</b> Far yard') && m.b.text.includes('P-1'), 'full list has every unit');
    await call('POST', '/api/sync', { upserts: [{ c: 'park', id: 'a4', d: { id: 'a4', kind: 'truck', uid: 'pk1', loc: 'Closed yard', from: D1(-4), to: D1(0), status: 'closed' } }] });
    SENT.length = 0; r = await call('POST', '/api/park/send', { kind: 'full', scope: 'all' }); await sleep(300); ok(!last().b.text.includes('Closed yard'), 'closed parking is left out of the lists');
    SENT.length = 0; r = await call('POST', '/api/park/send', { kind: 'due', scope: 'c1' }); await sleep(300); ok(/P-1/.test(last().b.text), 'company scope keeps its own units');
    SENT.length = 0; r = await call('POST', '/api/park/send', { kind: 'due', scope: 'zzz' }); await sleep(300); ok(/Nothing ends/.test(last().b.text) && !/P-1/.test(last().b.text), 'another company: nothing due');
    r = await call('POST', '/api/park/sched', { kind: 'due', scope: 'all', date: D1(1), time: '08:30', daily: false }); ok(r.s === 200 && r.j.items.length === 1, 'schedule saved');
    const sid = r.j.items[0].id; r = await call('POST', '/api/park/sched', { kind: 'full', scope: 'c1', time: '07:00', daily: true }); ok(r.s === 200 && r.j.items.length === 2, 'daily schedule saved');
    r = await call('POST', '/api/park/sched', { kind: 'due', time: '99:99', date: D1(1) }); ok(r.s === 400, 'bad time refused');
    r = await call('GET', '/api/park/sched'); ok(r.s === 200 && r.j.items.length === 2, 'schedules listed');
    // a schedule that is due fires once and a one-time one disappears
    r = await call('POST', '/api/park/sched', { kind: 'due', scope: 'all', date: D1(-1), time: '00:00', daily: false }); SENT.length = 0;
    const dueId = (await call('GET', '/api/park/sched')).j.items.find(x => x.date === D1(-1)).id;
    await require('../lib/telegram.js').tick(); await sleep(400); r = await call('GET', '/api/park/sched');
    ok(!r.j.items.some(x => x.id === dueId) && SENT.some(x => x.m === 'sendMessage' && /Parking/.test(x.b.text)), 'a due one-time schedule is sent by the minute timer and removed');
    r = await call('DELETE', '/api/park/sched/' + sid); ok(r.s === 200 && !r.j.items.some(x => x.id === sid), 'schedule deleted');
    r = await call('POST', '/api/sync', { kv: { tstat: [{ id: 'active', n: 'Active', c: '#22c55e', ic: 'check' }, { id: 'x1', n: 'Parked', c: '#3b82f6', ic: 'pin' }] } }); ok(r.s === 200, 'owner can edit trailer statuses');
    r = await call('POST', '/api/sync', { kv: { tstat: [] } }); ok(r.s === 400, 'empty status list refused');
    r = await call('POST', '/api/sync', { kv: { stEd: ['u1'] } }); ok(r.s === 200, 'owner can allow people to edit trailer statuses'); }

  SENT.length = 0; await call('POST', '/api/sync', { upserts: [{ c: 'inv', id: 'v1', d: { truck: 't1', amt: 150, reason: 'truck', method: 'efs', who: 'sp', sby: 'pct', split: [{ p: 'co', v: 25 }, { p: 'dr', v: 75 }], desc: 'brake pads', num: '77', date: '2026-11-17' } }] }); await sleep(500);
  const iv = SENT.filter(x => x.m === 'sendMessage' && x.b.chat_id === '-100999'); ok(iv.length === 1 && /^Truck: 4382\nTrailer:\nDriver name:\nReason: Truck Issue — brake pads\nAmount: \$150\.00\nPayment method: EFS Money Code\nInvoice number: 77\nResponsible: Split charge \(Company 25%, Driver 75%\)\nDate: 2026-11-17\nLink: <a href="https:\/\/localhost:\d+\/invoices\?id=v1">Open invoice<\/a>$/.test(iv[0].b.text), 'new invoice is posted in the requested format');
  SENT.length = 0; await call('POST', '/api/sync', { upserts: [{ c: 'inv', id: 'v1', d: { truck: 't1', amt: 160, reason: 'truck', method: 'efs', who: 'co' } }] }); await sleep(300); ok(SENT.filter(x => x.m === 'sendMessage').length === 0, 'editing an invoice does not post again');
  // per-company invoice chat
  r = await call('POST', '/api/sync', { kv: { comps: [{ id: 'cM', n: 'Main', c: '#000', inv: '-100999', mgr: '-100777' }, { id: 'cA', n: 'Alpha', c: '#111', inv: '-100555' }, { id: 'cB', n: 'Beta', c: '#222' }] }, upserts: [{ c: 'trucks', id: 't7', d: { num: '7777', status: 's1', company: 'cA' } }, { c: 'trucks', id: 't8', d: { num: '8888', status: 's1', company: 'cB' } }] }); ok(r.s === 200, 'company chat set');
  SENT.length = 0; await call('POST', '/api/sync', { upserts: [{ c: 'inv', id: 'vA', d: { truck: 't7', amt: 10, reason: 'truck', method: 'efs', who: 'co', date: '2026-11-17' } }, { c: 'inv', id: 'vB', d: { truck: 't8', amt: 20, reason: 'truck', method: 'efs', who: 'co', date: '2026-11-17' } }] }); await sleep(700);
  ok(SENT.filter(x => x.m === 'sendMessage' && x.b.chat_id === '-100555' && /7777/.test(x.b.text)).length === 1, 'invoice of company A goes to company A chat');
  ok(SENT.filter(x => x.m === 'sendMessage' && x.b.chat_id === '-100555' && /8888/.test(x.b.text)).length === 0, 'company B invoice not in A chat');
  ok(SENT.filter(x => x.m === 'sendMessage' && /8888/.test(x.b.text)).length === 0, 'company without an invoice chat: nothing is sent (no general group any more)');
  r = await call('POST', '/api/invoices/vA/telegram', {}); ok(r.s === 200 && r.j.ok && r.j.tgm && r.j.tgm.link === 'https://t.me/c/555/555' && r.j.tg, 'send route returns the Telegram link of the posted message');
  r = await call('GET', '/api/state'); { const iv = (r.j.DB.inv || []).find(x => x.id === 'vA'); ok(iv && iv.tgm && iv.tgm.link === 'https://t.me/c/555/555' && iv.tg, 'the link and sent date are saved on the invoice'); }
  // attachments: upload a PDF, attach to an invoice, it follows the message into the group
  const pdfBuf = Buffer.from('%PDF-1.4\n%t\n'); const up = await new Promise(z => { const rq = http.request({ port, method: 'POST', path: '/api/files', headers: { Host: 'localhost:' + port, 'X-Requested-With': 'tf', 'Content-Type': 'application/pdf', 'Content-Length': pdfBuf.length, 'X-Filename': encodeURIComponent('bill 1.pdf'), Cookie: 'tf_sid=' + jar } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => z(JSON.parse(b))); }); rq.end(pdfBuf); });
  ok(up.id, 'file uploaded');
  SENT.length = 0; await call('POST', '/api/sync', { upserts: [{ c: 'inv', id: 'v2', d: { truck: 't1', amt: 10, reason: 'tow', method: 'cc', who: 'co', files: [{ id: up.id, name: 'bill 1.pdf', type: 'application/pdf', size: 12 }, { id: '../../etc/passwd', name: 'x' }, { id: 'nonexistent', name: 'y' }] } }] }); await sleep(700);
  const docs = SENT.filter(x => x.m === 'sendDocument' && x.b.chat_id === '-100999');
  ok(docs.length === 1 && docs[0].b.files[0] === 'bill 1.pdf' && /^Truck: 4382/.test(docs[0].b.caption) && SENT.filter(x => x.m === 'sendMessage' && x.b.chat_id === '-100999').length === 0, 'single file: one message, file with the invoice text as caption (bad ids ignored)');
  const up2 = await new Promise(z => { const rq = http.request({ port, method: 'POST', path: '/api/files', headers: { Host: 'localhost:' + port, 'X-Requested-With': 'tf', 'Content-Type': 'application/pdf', 'Content-Length': pdfBuf.length, 'X-Filename': encodeURIComponent('two.pdf'), Cookie: 'tf_sid=' + jar } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => z(JSON.parse(b))); }); rq.end(pdfBuf); });
  SENT.length = 0; await call('POST', '/api/sync', { upserts: [{ c: 'inv', id: 'v3', d: { truck: 't1', amt: 20, reason: 'tow', method: 'cc', who: 'co', files: [{ id: up.id }, { id: up2.id }] } }] }); await sleep(700);
  const alb = SENT.filter(x => x.m === 'sendMediaGroup');
  ok(alb.length === 1 && alb[0].b.media.length === 2 && alb[0].b.media[0].type === 'document' && /^Truck: 4382/.test(alb[0].b.media[1].caption) && !alb[0].b.media[0].caption && alb[0].b.files.join() === 'bill 1.pdf,two.pdf', 'several files: one album, text as the caption of the last file (bottom)');
  const upF = (buf, mime, name) => new Promise(z => { const rq = http.request({ port, method: 'POST', path: '/api/files', headers: { Host: 'localhost:' + port, 'X-Requested-With': 'tf', 'Content-Type': mime, 'Content-Length': buf.length, 'X-Filename': encodeURIComponent(name), Cookie: 'tf_sid=' + jar } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => z(JSON.parse(b))); }); rq.end(buf); });
  const jb = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]); const p1 = await upF(jb, 'image/jpeg', 'a.jpg'), p2 = await upF(jb, 'image/jpeg', 'b.jpg');
  SENT.length = 0; await call('POST', '/api/sync', { upserts: [{ c: 'inv', id: 'v4', d: { truck: 't1', amt: 30, reason: 'tow', method: 'cc', who: 'co', files: [{ id: up.id }, { id: p1.id }, { id: p2.id }] } }] }); await sleep(900);
  const seq = SENT.filter(x => /^send(MediaGroup|Document|Photo|Message)$/.test(x.m) && x.b.chat_id === '-100999');
  ok(seq.length === 1 && seq[0].m === 'sendMediaGroup' && seq[0].b.media.length === 3 && seq[0].b.media.every(m => m.type === 'document'), 'everything goes as ONE document album');
  ok(/^Truck: 4382/.test(seq[0].b.media[seq[0].b.media.length - 1].caption || '') && seq[0].b.media.filter(m => m.caption).length === 1, 'invoice text is the single caption of the album');
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
  // owner lets a member edit integrations
  { jar = ''; await call('POST', '/api/login', { email: 'boss@example.com', password: 'Correct-Horse-9!' }); const st = await call('GET', '/api/state'); const memId = st.j.team.find(x => x.u === 'mem').id;
    jar = ''; await call('POST', '/api/login', { email: 'mem@example.com', password: 'Purple-Anchor-42' });
    r = await call('POST', '/api/sync', { kv: { tg: { work: '-100111', topic: '', times: ['08:00'], tz: 'Asia/Tashkent' } } }); ok(r.s === 403, 'member cannot change Telegram settings by default');
    r = await call('POST', '/api/sync', { kv: { intEd: [memId] } }); ok(r.s === 403, 'member cannot grant themselves integrations access');
    jar = ''; await call('POST', '/api/login', { email: 'boss@example.com', password: 'Correct-Horse-9!' });
    r = await call('POST', '/api/sync', { kv: { intEd: [memId] } }); ok(r.s === 200, 'owner grants integrations access');
    jar = ''; await call('POST', '/api/login', { email: 'mem@example.com', password: 'Purple-Anchor-42' });
    r = await call('POST', '/api/sync', { kv: { tg: { work: '-100111', topic: '', times: ['08:00'], tz: 'Asia/Tashkent' } } }); ok(r.s === 200, 'allowed member can change Telegram settings');
    r = await call('POST', '/api/sync', { kv: { tg: { work: 'abc', times: [], tz: 'Asia/Tashkent' } } }); ok(r.s === 400, 'bad chat id refused');
    r = await call('POST', '/api/sync', { kv: { tg: { work: '', times: [], tz: 'Mars/Base' } } }); ok(r.s === 400, 'bad time zone refused');
    r = await call('POST', '/api/tg/test'); ok(r.s === 200, 'allowed member can send the test');
    r = await call('POST', '/api/sync', { kv: { comps: [{ id: 'cM', n: 'Main', inv: 'x1' }] } }); ok(r.s === 403 || r.s === 400, 'member without company access cannot edit companies / bad id refused');
  }
  // AI page: access for members, costs, log
  { const LI = async who => { jar = ''; await call('POST', '/api/login', who === 'owner' ? { email: 'boss@example.com', password: 'Correct-Horse-9!' } : { email: 'mem@example.com', password: 'Purple-Anchor-42' }); };
    await LI('owner'); const memId = (await call('GET', '/api/state')).j.team.find(x => x.u === 'mem').id;
    await LI('mem'); r = await call('POST', '/api/tg/code'); await hook('/start ' + r.j.code, 700, 'private', undefined, 700); await sleep(300);
    await LI('owner'); await call('POST', '/api/sync', { upserts: [{ c: 'trucks', id: 't1', d: { num: '4382', status: 's2', miles: 1000, company: 'cM', notes: 'x' } }] });
    SENT.length = 0; AIREQ.length = 0; await hook('how many trucks', 700, 'private', undefined, 700); await sleep(500); ok(SENT.length === 0 && AIREQ.length === 0, 'linked member without access: no reply, no AI call');
    r = await call('POST', '/api/ai/config', { users: { [memId]: 'read' } }); ok(r.s === 200, 'owner gives a member read-only access');
    SENT.length = 0; AIREQ.length = 0; await hook('rename note on 4382', 700, 'private', undefined, 700); await sleep(900);
    ok(AIREQ.length >= 1 && AIREQ[0].b.tools.length === 4 && !AIREQ[0].b.tools.some(t => t.name === 'save_record') && /NOT the owner/.test(AIREQ[0].b.system) && /READ-ONLY/.test(AIREQ[0].b.system), 'read-only member: only look-up tools, told who they are');
    r = await call('GET', '/api/state'); ok(r.j.DB.trucks.find(x => x.id === 't1').notes === 'x', 'read-only member cannot change data even if the model tries');
    await call('POST', '/api/ai/config', { users: { [memId]: 'edit' } }); AIREQ.length = 0; await hook('rename note on 4382', 700, 'private', undefined, 700); await sleep(900);
    r = await call('GET', '/api/state'); ok(AIREQ[0].b.tools.length === 5 && r.j.DB.trucks.find(x => x.id === 't1').notes === 'by ai', 'edit member can change records (no delete / settings tools)');
    r = await call('GET', '/api/ai/admin'); ok(r.s === 200 && r.j.users.some(u => u.id === memId && u.setting === 'edit' && u.n >= 1 && u.tot > 0) && r.j.recent.length >= 1 && r.j.rates.inp === 2, 'owner sees per-person usage and recent requests');
    r = await call('GET', '/api/ai/costs'); ok(r.s === 200 && r.j.month.n >= 5 && r.j.month.cost > 0 && r.j.days.length >= 1 && r.j.breakdown.parts.sys > 0 && r.j.top[0].q && r.j.forecast > 0 && r.j.byUser.length >= 2, 'owner sees the expenses with breakdown');
    r = await call('GET', '/api/ai/log?user=all'); ok(r.s === 200 && r.j.rows.length >= 5 && r.j.rows.some(x => /rename note/.test(x.q) && x.a), 'owner can read the full request log');
    r = await call('GET', '/api/ai/log?user=' + memId); ok(r.s === 200 && r.j.rows.length >= 2 && r.j.rows.every(x => x.who === 'Mem'), 'log can be filtered by person');
    await LI('mem');
    r = await call('GET', '/api/ai/costs'); ok(r.s === 403, 'member cannot see expenses by default');
    r = await call('GET', '/api/ai/log'); ok(r.s === 403, 'member cannot read the log');
    r = await call('GET', '/api/ai/admin'); ok(r.s === 403, 'member cannot open the admin data');
    r = await call('POST', '/api/ai/config', { open: true }); ok(r.s === 403, 'member cannot change the AI settings');
    r = await call('GET', '/api/state'); ok(r.j.user.ai.access === 'edit' && r.j.user.ai.costOk === false, 'state tells the member their access');
    await LI('owner'); await call('POST', '/api/ai/config', { costUsers: [memId] }); await LI('mem');
    r = await call('GET', '/api/ai/costs'); ok(r.s === 200 && r.j.top.every(x => x.q === null) && r.j.month.cost > 0, 'allowed member sees expenses, but not what people asked');
    await LI('owner'); r = await call('POST', '/api/ai/config', { cap: 0.01 }); ok(r.s === 200, 'budget cap set');
    SENT.length = 0; await hook('hi', 700, 'private', undefined, 700); await sleep(500); ok(/budget/i.test(last().b.text), 'member is stopped when the monthly budget is used up');
    await call('POST', '/api/ai/config', { cap: 0, on: false }); SENT.length = 0; AIREQ.length = 0; await hook('hi', 700, 'private', undefined, 700); await sleep(400); ok(SENT.length === 0 && AIREQ.length === 0, 'master switch off: member gets nothing');
    await call('POST', '/api/ai/config', { on: true, open: true, level: 'read', users: { [memId]: 'default' } }); AIREQ.length = 0; await hook('hi', 700, 'private', undefined, 700); await sleep(500); ok(AIREQ.length === 1 && AIREQ[0].b.tools.length === 4, '"open for everyone" gives linked staff read-only access');
    r = await call('POST', '/api/ai/config', { users: { [memId]: 'none' } }); AIREQ.length = 0; await hook('hi', 700, 'private', undefined, 700); await sleep(400); ok(AIREQ.length === 0, 'an explicit "no access" beats "open for everyone"');
    r = await call('POST', '/api/ai/config', { cap: -5 }); ok(r.s === 400, 'bad budget refused');
  }
  // section access
  { const LI = async who => { jar = ''; await call('POST', '/api/login', who === 'owner' ? { email: 'boss@example.com', password: 'Correct-Horse-9!' } : { email: 'mem@example.com', password: 'Purple-Anchor-42' }); };
    await LI('owner'); await call('POST', '/api/sync', { upserts: [{ c: 'park', id: 'pdel', d: { id: 'pdel', kind: 'truck', uid: 'pk1', loc: 'x', to: '2999-01-01', status: 'closed' } }] }); const memId2 = (await call('GET', '/api/state')).j.team.find(x => x.u === 'mem').id;
    await LI('mem'); r = await call('POST', '/api/sync', { deletes: [{ c: 'park', id: 'pdel' }] }); ok(r.s === 403, 'a member cannot delete parking records by default');
    await LI('owner'); r = await call('POST', '/api/sync', { kv: { pkDel: [memId2] } }); ok(r.s === 200, 'owner approves a person to delete parking');
    await LI('mem'); r = await call('POST', '/api/sync', { kv: { pkDel: [] } }); ok(r.s === 403, 'the member cannot grant it to themselves');
    r = await call('POST', '/api/sync', { deletes: [{ c: 'park', id: 'pdel' }] }); ok(r.s === 200, 'the approved member can delete');
    { const stat = (await call('GET', '/api/state')).j.S ? null : null;
      r = await call('POST', '/api/sync', { kv: { stat: [{ id: 's1', n: 'Active', c: '#22c55e', ic: 'check' }] } }); ok(r.s === 403, 'a member cannot change truck statuses by default');
      await LI('owner'); await call('POST', '/api/sync', { kv: { stEd: [memId2] } }); await LI('mem');
      r = await call('POST', '/api/sync', { kv: { stat: [{ id: 's1', n: 'Active', c: '#22c55e', ic: 'check' }] } }); ok(r.s === 200, 'an approved member can change truck statuses');
      r = await call('POST', '/api/sync', { kv: { tstat: [{ id: 'active', n: 'Active', c: '#22c55e', ic: 'check' }] } }); ok(r.s === 200, 'and trailer statuses');
      await LI('owner'); await call('POST', '/api/sync', { kv: { stEd: [] } }); await LI('mem');
      r = await call('POST', '/api/sync', { kv: { tstat: [{ id: 'active', n: 'Active', c: '#22c55e', ic: 'check' }] } }); ok(r.s === 403, 'approval can be taken back'); }
    await LI('owner'); const memId = (await call('GET', '/api/state')).j.team.find(x => x.u === 'mem').id;
    await call('POST', '/api/sync', { upserts: [{ c: 'inv', id: 'vS', d: { truck: 't1', amt: 5, reason: 'truck', method: 'efs', who: 'co', date: '2026-11-17' } }] });
    r = await call('POST', '/api/access', { user: memId, deny: ['invoices', 'maintenance'] }); ok(r.s === 200 && r.j.deny[memId].length === 2, 'owner blocks two sections for a member');
    r = await call('GET', '/api/geo?q=Dallas%20TX'); ok(r.s === 200 && r.j.lat === 32.78 && r.j.lng === -96.8, 'free geocode works');
    r = await call('GET', '/api/eta?a=32.78,-96.8&b=33.1,-97.2'); ok(r.s === 200 && r.j.mi === 100 && r.j.min === 90, 'free ETA works (100 mi, 90 min)');
    r = await call('GET', '/api/eta?a=x&b=y'); ok(r.s === 400, 'bad ETA input refused');
    r = await call('POST', '/api/access', { user: memId, deny: ['nonsense'] }); ok(r.s === 400, 'unknown section refused');
    await LI('mem'); r = await call('GET', '/api/state'); ok(r.j.user.deny.join() === 'invoices,maintenance' && r.j.DB.inv.length === 0, 'member state: deny list, invoices not sent');
    r = await call('POST', '/api/sync', { upserts: [{ c: 'inv', id: 'vX', d: { amt: 1 } }] }); ok(r.s === 403, 'blocked section: cannot write invoices');
    r = await call('POST', '/api/sync', { upserts: [{ c: 'plans', id: 'pX', d: { truck: 't1', name: 'oil' } }] }); ok(r.s === 403, 'blocked section: cannot write maintenance plans');
    r = await call('POST', '/api/sync', { upserts: [{ c: 'trucks', id: 't1', d: { num: '4382', status: 's2', miles: 1100, company: 'cM', notes: 'by ai' } }] }); ok(r.s === 200, 'other sections still work');
    r = await call('POST', '/api/invoices/vS/telegram', {}); ok(r.s === 403, 'blocked invoices: cannot post an invoice to Telegram');
    r = await call('POST', '/api/access', { user: memId, deny: [] }); ok(r.s === 403, 'member cannot change section access');
    r = await call('GET', '/api/access'); ok(r.s === 403, 'member cannot read section access');
    await LI('owner'); r = await call('POST', '/api/access', { user: memId, deny: [] }); ok(r.s === 200 && !r.j.deny[memId], 'owner opens everything again');
    r = await call('POST', '/api/access/section', { section: 'documents', allow: [] }); ok(r.s === 200 && r.j.deny[memId].includes('documents'), 'per-section: nobody but the owner gets Documents');
    r = await call('POST', '/api/access/section', { section: 'documents', allow: [memId] }); ok(r.s === 200 && !(r.j.deny[memId] || []).includes('documents'), 'per-section: picked person gets it back');
    r = await call('POST', '/api/access/section', { section: 'trucks', allow: [memId], read: [memId] }); ok(r.s === 200 && r.j.read[memId].includes('trucks') && !(r.j.deny[memId] || []).includes('trucks'), 'per-section: person set to read only');
    await LI('mem'); r = await call('GET', '/api/state'); ok(r.j.user.ro.includes('trucks') && r.j.DB.trucks.length > 0, 'read-only: member still sees the data and is told');
    r = await call('POST', '/api/sync', { upserts: [{ c: 'trucks', id: 't1', d: { num: '4382', status: 's2', miles: 1200, company: 'cM' } }] }); ok(r.s === 403, 'read-only: cannot write trucks');
    r = await call('POST', '/api/sync', { upserts: [{ c: 'plans', id: 'pY', d: { truck: 't1', name: 'oil' } }] }); ok(r.s === 200, 'read-only on one section does not block others');
    await LI('owner'); r = await call('POST', '/api/access/section', { section: 'trucks', allow: [memId], read: [] }); ok(r.s === 200 && !(r.j.read[memId] || []).includes('trucks'), 'per-section: back to can edit');
    await LI('mem'); r = await call('POST', '/api/sync', { upserts: [{ c: 'trucks', id: 't1', d: { num: '4382', status: 's2', miles: 1200, company: 'cM' } }] }); ok(r.s === 200, 'can edit again');
    await LI('owner');
    r = await call('POST', '/api/access/section', { section: 'bogus', allow: [] }); ok(r.s === 400, 'per-section: unknown section refused');
    await LI('owner'); r = await call('POST', '/api/access', { user: memId, deny: [] });
    await LI('mem'); r = await call('POST', '/api/sync', { upserts: [{ c: 'plans', id: 'pX', d: { truck: 't1', name: 'oil' } }] }); ok(r.s === 200, 'after opening, writes work again');
  }
  console.log(errs.length ? `\n${errs.length} FAILED of ${n}` : `\nALL ${n} TG CHECKS PASSED`);
  srv.close(); await pg.stop(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
