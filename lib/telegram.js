'use strict';
// Telegram bot: webhook, account linking, /status /alerts, daily digest, High Priority list for the workers group.
const crypto = require('crypto');
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const enabled = () => !!(TOKEN && SECRET);
const DIGEST_HOUR = Math.min(23, Math.max(0, +process.env.DIGEST_HOUR || 8));
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
let BOT = null;   // { username, id } from getMe

async function api(method, body) {
  if (!TOKEN) return { ok: false, description: 'no token' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) });
    return await r.json();
  } catch (e) { return { ok: false, description: 'network: ' + e.message }; }
}
const send = (chat, html, extra) => api('sendMessage', { chat_id: chat, text: String(html).slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true, ...(extra || {}) });

/* ---------- dates in the company time zone ---------- */
function nowIn(tz) {
  let f; try { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch { f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, h: +p.hour };
}
const U = s => { const [y, m, d] = String(s).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const dayDiff = (s, today) => s ? Math.round((U(s) - U(today)) / 864e5) : null;
const addDays = (s, n) => { const d = new Date(U(s) + n * 864e5); return d.toISOString().slice(0, 10); };

/* ---------- the same rules the site uses ---------- */
function planState(p, tr, today) {
  const nm = p.lastMi !== '' && p.lastMi != null && +p.everyMi ? +p.lastMi + +p.everyMi : null, nd = p.lastDate && +p.everyDays ? addDays(p.lastDate, +p.everyDays) : null;
  const miles = tr && tr.miles !== '' && tr.miles != null ? +tr.miles : null, rm = nm != null && miles != null ? nm - miles : null, rd = nd ? dayDiff(nd, today) : null;
  let st = 'ok'; if ((rm != null && rm < 0) || (rd != null && rd < 0)) st = 'over'; else if ((rm != null && rm <= 5000) || (rd != null && rd <= 30)) st = 'soon';
  return { st, rm, rd };
}
const effPrio = (i, S, today) => {
  const P = S.prio && S.prio.length ? S.prio : [{ id: 'p1', n: 'High' }];
  if (i.sched) { const d = dayDiff(i.sched, today), n = P.length; return P[d <= 0 ? 0 : d <= 2 ? Math.min(1, n - 1) : n - 1]; }
  return P.find(p => p.id == i.pr) || P[P.length - 1];
};
const nf = n => (+n || 0).toLocaleString('en-US');
function compute(DB, S, today) {
  const byId = (L, id) => L.find(x => x.id == id), out = { over: [], soon: [], cant: [], issues: [] };
  const stat = id => (S.stat || []).find(s => s.id == id);
  (DB.trucks || []).forEach(tr => { const s = stat(tr.status); if (s && s.w === false) out.cant.push(`${tr.num}: ${s.n}`); });
  (DB.plans || []).forEach(p => {
    const tr = byId(DB.trucks, p.truck); if (!tr) return; const s = planState(p, tr, today); if (s.st === 'ok') return;
    const bits = []; if (s.rm != null) bits.push(s.rm < 0 ? `over by ${nf(-s.rm)} mi` : `in ${nf(s.rm)} mi`); if (s.rd != null) bits.push(s.rd < 0 ? `${-s.rd} d overdue` : `in ${s.rd} d`);
    (s.st === 'over' ? out.over : out.soon).push(`${tr.num}: ${p.name} (${bits.join(', ')})`);
  });
  (DB.trucks || []).forEach(tr => { if (!tr.cab) return; const d = dayDiff(tr.cab, today); if (d < 0) out.over.push(`${tr.num}: cab card expired`); else if (d <= 15) out.soon.push(`${tr.num}: cab card in ${d} d`); });
  (DB.docs || []).forEach(x => {
    if (!x.exp) return; const d = dayDiff(x.exp, today); if (d > 30) return;
    const u = x.kind === 'truck' ? (byId(DB.trucks, x.uid) || {}).num : (byId(DB.trailers, x.uid) || {}).num, name = `${u || '?'}: ${x.title || x.type || 'document'}`;
    (d < 0 ? out.over : out.soon).push(d < 0 ? `${name} (expired ${-d} d ago)` : `${name} (in ${d} d)`);
  });
  const top = (S.prio && S.prio[0]) ? S.prio[0].id : 'p1';
  (DB.issues || []).filter(i => i.status !== 'closed' && effPrio(i, S, today).id === top).forEach(i => out.issues.push(`${i.title || '–'}${i.desc ? ' — ' + i.desc : ''}`));
  return out;
}
const list = (title, L, max = 25) => L.length ? `<b>${title} (${L.length})</b>\n` + L.slice(0, max).map(x => '• ' + esc(x)).join('\n') + (L.length > max ? `\n… +${L.length - max} more` : '') : '';
const alertsText = (c, head) => {
  const parts = [list('🔴 Overdue / expired', c.over), list('🟡 Coming up', c.soon), list('⛔ Can’t work', c.cant), list('❗ High priority issues', c.issues)].filter(Boolean);
  return parts.length ? (head ? `<b>${esc(head)}</b>\n\n` : '') + parts.join('\n\n') : (head ? `<b>${esc(head)}</b>\n\n` : '') + '✅ Nothing needs attention.';
};

/* ---------- wiring ---------- */
let D = null;   // { q, loadAll, scopeState, allowedOf, audit, userById }
async function dataFor(user) { const { DB, S } = await D.loadAll(); const A = user ? D.allowedOf(user) : null; return { DB: A ? D.scopeState(DB, A) : DB, S }; }

const HELP = '<b>TOPGFLEET bot</b>\n/status — trucks by status\n/alerts — what needs attention\n/digest on|off — daily morning summary\n/chatid — show this chat’s id\n/stop — unlink this chat\n\nTo link your account: open the site → Profile → Integrations → Connect Telegram.';
async function linkedUser(chatId) {
  const r = await D.q('SELECT u.* FROM tg_chats c JOIN users u ON u.id=c.user_id WHERE c.chat_id=$1 AND NOT u.disabled AND u.role<>\'driver\'', [String(chatId)]);
  return r.rows[0] || null;
}
async function groupAllowed(chatId) { const { S } = await D.loadAll(); const g = S.tg || {}; return [g.mgr, g.work, g.inv, ...((S.comps || []).map(c => c.inv))].filter(Boolean).map(String).includes(String(chatId)); }

async function onMessage(m) {
  const chat = m.chat, text = (m.text || '').trim(); if (!text.startsWith('/')) return;
  const [cmdRaw, ...args] = text.split(/\s+/), cmd = cmdRaw.split('@')[0].toLowerCase(), priv = chat.type === 'private', id = String(chat.id);
  if (cmd === '/chatid') return send(id, `This chat’s id: <code>${esc(id)}</code>`);
  if (cmd === '/help') return send(id, HELP);
  if (cmd === '/start' && priv) {
    const code = (args[0] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) { const u = await linkedUser(id); return send(id, u ? `✅ Linked as <b>${esc(u.name)}</b>.\n\n` + HELP : HELP); }
    const r = await D.q('DELETE FROM tg_codes WHERE code=$1 AND expires>now() RETURNING user_id', [code]);
    if (!r.rows[0]) return send(id, '⚠️ That code is wrong or expired. Generate a new one on the site.');
    const u = (await D.q('SELECT * FROM users WHERE id=$1 AND NOT disabled', [r.rows[0].user_id])).rows[0]; if (!u) return send(id, '⚠️ Account not available.');
    await D.q('INSERT INTO tg_chats(chat_id,user_id) VALUES($1,$2) ON CONFLICT (chat_id) DO UPDATE SET user_id=EXCLUDED.user_id, linked_at=now()', [id, u.id]);
    D.audit(u.id, 'telegram.link', id, {}, null);
    return send(id, `✅ Linked to <b>${esc(u.name)}</b>. You will get a morning summary and urgent alerts here.\n\nTry /status or /alerts.`);
  }
  // data commands: linked private chat, or a group configured on the site
  let user = null;
  if (priv) { user = await linkedUser(id); if (!user) return send(id, 'This chat is not linked yet. Open the site → Profile → Integrations → Connect Telegram.'); }
  else if (!(await groupAllowed(id))) return send(id, 'This group is not configured. Add its id (<code>' + esc(id) + '</code>) on the site: Profile → Integrations.');
  if (cmd === '/stop' && priv) { await D.q('DELETE FROM tg_chats WHERE chat_id=$1', [id]); return send(id, 'Unlinked. You will not get messages from TOPGFLEET here.'); }
  if (cmd === '/digest' && priv) { const on = (args[0] || '').toLowerCase() !== 'off'; await D.q('UPDATE tg_chats SET digest=$2 WHERE chat_id=$1', [id, on]); return send(id, on ? 'Morning summary is ON.' : 'Morning summary is OFF.'); }
  const { DB, S } = await dataFor(user), tz = (S.tg && S.tg.tz) || 'America/Chicago', today = nowIn(tz).date;
  if (cmd === '/alerts') return send(id, alertsText(compute(DB, S, today), 'Alerts'));
  if (cmd === '/status') {
    const cnt = {}; (DB.trucks || []).forEach(t => { const s = (S.stat || []).find(x => x.id == t.status); const k = s ? s.n : 'Other'; (cnt[k] = cnt[k] || []).push(t.num); });
    const rows = (S.stat || []).map(s => s.n).concat(Object.keys(cnt).filter(k => !(S.stat || []).some(s => s.n === k))).filter(k => cnt[k]).map(k => `<b>${esc(k)}</b> (${cnt[k].length}): ${esc(cnt[k].slice(0, 40).join(', '))}${cnt[k].length > 40 ? '…' : ''}`);
    return send(id, `<b>Trucks: ${(DB.trucks || []).length}</b>\n\n` + (rows.join('\n\n') || 'No trucks yet.'));
  }
  return send(id, HELP);
}

async function handleUpdate(u) { try { if (u && u.message) await onMessage(u.message); } catch (e) { console.error('tg update', e.message); } }
function verify(req) {
  const h = String(req.get('x-telegram-bot-api-secret-token') || ''), a = Buffer.from(h), b = Buffer.from(SECRET);
  return enabled() && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- outgoing ---------- */
async function setWebhook(base) {
  if (!enabled() || !base) return { ok: false, description: 'not configured' };
  return api('setWebhook', { url: base.replace(/\/$/, '') + '/tg/hook', secret_token: SECRET, allowed_updates: ['message'], drop_pending_updates: false });
}
async function me() { if (BOT) return BOT; const r = await api('getMe'); if (r.ok) BOT = { username: r.result.username, id: r.result.id }; return BOT; }
async function info() { const b = await me(), w = enabled() ? await api('getWebhookInfo') : null; return { enabled: enabled(), bot: b && b.username, webhook: w && w.ok ? { url: w.result.url, error: w.result.last_error_message || null } : null }; }

async function sendWorkersList(S, DB, only) {
  const g = S.tg || {}, tz = g.tz || 'America/Chicago', c = compute(DB, S, nowIn(tz).date);
  if (!g.work) return { ok: false, description: 'no workers group set' };
  if (!c.issues.length && !only) return { ok: true, skipped: true };
  const html = c.issues.length ? `<b>❗ High priority — ${c.issues.length}</b>\n` + c.issues.map(x => '• ' + esc(x)).join('\n') : '✅ No open High Priority issues.';
  const body = { chat_id: g.work, text: html.slice(0, 4000), parse_mode: 'HTML' }; if (g.topic) body.message_thread_id = +g.topic || undefined;
  return api('sendMessage', body);
}
async function notifyNewIssues(issues) {
  if (!enabled() || !issues.length) return;
  try {
    const { DB, S } = await D.loadAll(), g = S.tg || {}, today = nowIn(g.tz).date, top = S.prio && S.prio[0] ? S.prio[0].id : 'p1';
    const hot = issues.filter(i => i.status !== 'closed' && effPrio(i, S, today).id === top); if (!hot.length) return;
    const txt = '❗ <b>New High priority issue</b>\n' + hot.map(i => '• ' + esc(i.title || '–') + (i.desc ? ' — ' + esc(i.desc) : '')).join('\n');
    if (g.mgr) await send(g.mgr, txt);
    const admins = await D.q('SELECT c.chat_id FROM tg_chats c JOIN users u ON u.id=c.user_id WHERE u.role=\'admin\' AND NOT u.disabled AND c.digest');
    for (const r of admins.rows) if (String(r.chat_id) !== String(g.mgr)) await send(r.chat_id, txt);
  } catch (e) { console.error('tg notify', e.message); }
}


const REASON = { truck: 'Truck Issue', trailer: 'Trailer Issue', tires: 'Tires', tow: 'Towing', parts: 'Parts', fuel: 'Fuel', other: 'Other' };
const METHOD = { efs: 'EFS Money Code', cc: 'Credit Card', zelle: 'Zelle', chk: 'Check / ACH / Other' };
const PAYER = { co: 'Company pays', ow: 'Owner pays', dr: 'Driver pays', sp: 'Split charge' };
const money = n => '$' + (+n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function loadFiles(files) {
  const ids = (Array.isArray(files) ? files : []).map(x => x && x.id).filter(x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x)).slice(0, 10); if (!ids.length) return [];
  const rows = (await D.q('SELECT id,name,mime,path FROM files WHERE id=ANY($1)', [ids])).rows, out = [];
  for (const id of ids) { const f = rows.find(r => r.id === id); if (!f) continue; try { out.push({ ...f, buf: require('fs').readFileSync(require('path').join(D.dataDir, f.path)) }); } catch (e) { console.error('tg file', e.message); } }
  return out;
}
// one message: the files as a document album (names kept, no compression) with the text as its caption
async function sendAlbum(chat, thread, files, html) {
  const post = async (method, fd) => { try { const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', body: fd, signal: AbortSignal.timeout(90000) }); return await r.json(); } catch (e) { return { ok: false, description: e.message }; } };
  const cap = html.length <= 1000 ? html : null;
  if (cap === null) await api('sendMessage', { chat_id: chat, text: html.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true, ...(thread ? { message_thread_id: thread } : {}) });
  const base = fd => { fd.append('chat_id', String(chat)); if (thread) fd.append('message_thread_id', String(thread)); return fd; };
  if (files.length === 1) { const fd = base(new FormData()); fd.append('document', new Blob([files[0].buf], { type: files[0].mime }), files[0].name); if (cap) { fd.append('caption', cap); fd.append('parse_mode', 'HTML'); } return post('sendDocument', fd); }
  let first = true, last;
  for (let k = 0; k < files.length; k += 10) {
    const part = files.slice(k, k + 10), fd = base(new FormData());
    fd.append('media', JSON.stringify(part.map((f, n) => ({ type: 'document', media: 'attach://f' + n, ...(first && n === 0 && cap ? { caption: cap, parse_mode: 'HTML' } : {}) }))));
    part.forEach((f, n) => fd.append('f' + n, new Blob([f.buf], { type: f.mime }), f.name)); first = false; last = await post('sendMediaGroup', fd);
  }
  return last;
}
async function notifyNewInvoices(invs, base) {
  if (!enabled() || !invs.length) return;
  try {
    const { DB, S } = await D.loadAll(), g = S.tg || {};
    for (const v of invs) {
      const tr = (DB.trucks || []).find(x => x.id === v.truck), tl = (DB.trailers || []).find(x => x.id === v.trailer);
      const co = (S.comps || []).find(c => c.id === ((tr && tr.company) || (tl && tl.company))), chat = String((co && co.inv) || g.inv || '').trim(), own = !!(co && co.inv); if (!chat) continue;
      const dr = tr && (DB.drivers || []).find(x => x.truck === tr.id);
      const resp = (PAYER[v.who] || v.who || '') + (v.who === 'sp' && Array.isArray(v.split) ? ' (' + v.split.map(s => `${({ co: 'Company', ow: 'Owner', dr: 'Driver' })[s.p] || s.p} ${v.sby === 'pct' ? s.v + '%' : money(s.v)}`).join(', ') + ')' : '');
      const L = [['Truck', tr && tr.num], ['Trailer', tl && tl.num], ['Driver name', dr && dr.name], ['Reason', [REASON[v.reason] || v.reason, v.desc].filter(Boolean).join(' — ')], ['Amount', money(v.amt)], ['Payment method', METHOD[v.method] || v.method], ['Invoice number', v.num], ['Responsible', resp], ['Date', v.date]]
        .map(([k, val]) => `${k}: ${val ? esc(val) : ''}`.trimEnd());
      const root = String(process.env.PUBLIC_URL || base || '').replace(/\/$/, ''); if (root && v.id) L.push(`Link: <a href="${esc(root)}/invoices?id=${encodeURIComponent(v.id)}">Open invoice</a>`);
      const text = L.join('\n'), thread = !own && g.topic && +g.topic || undefined, files = await loadFiles(v.files);
      if (files.length) await sendAlbum(chat, thread, files, text);
      else { const body = { chat_id: chat, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }; if (thread) body.message_thread_id = thread; await api('sendMessage', body); }
    }
  } catch (e) { console.error('tg invoice', e.message); }
}

/* ---------- scheduler (every minute) ---------- */
async function getState() { const r = await D.q("SELECT value FROM kv WHERE key='tg_state'"); return r.rows[0] ? r.rows[0].value : {}; }
async function putState(v) { await D.q("INSERT INTO kv(key,value) VALUES('tg_state',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [JSON.stringify(v)]); }
async function tick() {
  if (!enabled() || !D) return;
  try {
    const { DB, S } = await D.loadAll(), g = S.tg || {}, n = nowIn(g.tz), st = await getState(); let dirty = false;
    for (const t of (g.times || [])) { const key = 'w:' + t; if (n.hm === t && st[key] !== n.date) { st[key] = n.date; dirty = true; await sendWorkersList(S, DB, false); } }
    if (n.h === DIGEST_HOUR && st.digest !== n.date) {
      st.digest = n.date; dirty = true;
      const rows = (await D.q('SELECT c.chat_id,u.* FROM tg_chats c JOIN users u ON u.id=c.user_id WHERE c.digest AND NOT u.disabled AND u.role<>\'driver\'')).rows;
      for (const r of rows) { const A = D.allowedOf(r), d = A ? D.scopeState(DB, A) : DB, c = compute(d, S, n.date); if (c.over.length || c.soon.length || c.cant.length || c.issues.length) await send(r.chat_id, alertsText(c, 'Good morning — daily summary')); }
    }
    if (dirty) { for (const k of Object.keys(st)) if (k.startsWith('w:') && st[k] !== n.date && false) delete st[k]; await putState(st); }
  } catch (e) { console.error('tg tick', e.message); }
}
function init(deps, baseUrl) {
  D = deps; if (!enabled()) { console.log('Telegram bot: off (set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET)'); return; }
  me().then(b => console.log('Telegram bot:', b ? '@' + b.username : 'token rejected'));
  if (baseUrl) setWebhook(baseUrl).then(r => console.log('Telegram webhook:', r.ok ? 'set' : r.description));
  setInterval(tick, 60e3).unref();
}
async function linkCode(userId) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = crypto.randomBytes(8); let code = ''; for (const x of b) code += A[x % A.length];
  await D.q('DELETE FROM tg_codes WHERE user_id=$1 OR expires<now()', [userId]);
  await D.q("INSERT INTO tg_codes(code,user_id,expires) VALUES($1,$2,now()+interval '10 minutes')", [code, userId]);
  return code;
}
module.exports = { enabled, init, verify, handleUpdate, setWebhook, info, me, send, api, sendWorkersList, notifyNewIssues, notifyNewInvoices, linkCode, compute, alertsText, nowIn };
