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
  const hid = S.hideF || { tr: ['plate', 'cab', 'owner'] }, cabOff = Array.isArray(hid.tr) && hid.tr.includes('cab');   // cab card switched off in Profile → Fields
  (DB.trucks || []).forEach(tr => { if (!tr.cab || cabOff) return; const d = dayDiff(tr.cab, today); if (d < 0) out.over.push(`${tr.num}: cab card expired`); else if (d <= 15) out.soon.push(`${tr.num}: cab card in ${d} d`); });
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

const HELP = '<b>TOPGFLEET assistant</b>\nWrite to me in plain words (any language) — I can look things up and change data on the site for you.\n\n/status — trucks by status\n/alerts — what needs attention\n/digest on|off — daily morning summary\n/new — start a fresh conversation\n/chatid — show this chat’s id\n/stop — unlink this chat';
async function linkedUser(chatId) {
  const r = await D.q('SELECT u.* FROM tg_chats c JOIN users u ON u.id=c.user_id WHERE c.chat_id=$1 AND NOT u.disabled AND u.role<>\'driver\'', [String(chatId)]);
  return r.rows[0] || null;
}
async function groupAllowed(chatId) { const { S } = await D.loadAll(); const g = S.tg || {}; return [g.work, ...((S.comps || []).flatMap(c => [c.inv, c.mgr]))].filter(Boolean).map(String).includes(String(chatId)); }

// the sender's private chat id equals their Telegram user id; they count as the owner only if that chat is linked to the owner account
async function ownerChat(senderId) { const u = await linkedUser(senderId); return u && u.is_owner ? u : null; }
const BUSY = new Set();
async function AIchat(user, level, chatId, text) {
  if (!D.ai) return;
  if (BUSY.has(chatId)) return send(chatId, '⏳ One moment, I am still working on your previous message.');
  BUSY.add(chatId);
  const typing = setInterval(() => api('sendChatAction', { chat_id: chatId, action: 'typing' }), 4500); api('sendChatAction', { chat_id: chatId, action: 'typing' });
  try { const r = await D.ai.chat(user, level, chatId, text); await sendLong(chatId, r); }
  catch (e) { console.error('tg ai', e.message); await send(chatId, '⚠️ Something went wrong while I worked on that. Please try again.'); }
  finally { clearInterval(typing); BUSY.delete(chatId); }
}
async function sendLong(chat, html) { const t = String(html || '…'); for (let i = 0; i < t.length; i += 3800) { const part = t.slice(i, i + 3800), r = await send(chat, part); if (!r.ok && /parse|entit/i.test(r.description || '')) await send(chat, part.replace(/<[^>]+>/g, ''), { parse_mode: undefined }); } }

async function onMessage(m) {
  const chat = m.chat, text = (m.text || '').trim(); if (!text) return;
  const priv = chat.type === 'private', id = String(chat.id), sender = String((m.from && m.from.id) || (priv ? chat.id : ''));
  const isCmd = text.startsWith('/'), [cmdRaw, ...args] = text.split(/\s+/), cmd = isCmd ? cmdRaw.split('@')[0].toLowerCase() : '';
  // The one-time link code is the only thing anyone but the owner can use (it proves they are signed in on the site).
  if (cmd === '/start' && priv && args[0]) {
    const code = (args[0] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const r = await D.q('DELETE FROM tg_codes WHERE code=$1 AND expires>now() RETURNING user_id', [code]);
    if (!r.rows[0]) { const o = await linkedUser(sender); return o && (await D.ai.accessOf(o)) ? send(id, '⚠️ That code is wrong or expired. Generate a new one on the site.') : undefined; }
    const u = (await D.q('SELECT * FROM users WHERE id=$1 AND NOT disabled', [r.rows[0].user_id])).rows[0]; if (!u) return;
    await D.q('INSERT INTO tg_chats(chat_id,user_id) VALUES($1,$2) ON CONFLICT (chat_id) DO UPDATE SET user_id=EXCLUDED.user_id, linked_at=now()', [id, u.id]);
    D.audit(u.id, 'telegram.link', id, {}, null);
    return send(id, u.is_owner ? `✅ Linked to <b>${esc(u.name)}</b>. I am your assistant: write to me in plain words and I will do it on the site (read, add, change). You also get the morning summary and urgent alerts here.\n\nTry: <i>how many trucks are at the shop?</i>` : `✅ Linked to <b>${esc(u.name)}</b>. You will get the morning summary and urgent alerts here.`);
  }
  // A truck's group: someone signed in on the site made a one-time link (/api/tg/truck-link) and added the bot with it.
  if (cmd === '/start' && !priv && /^T[A-Z0-9]{10}$/i.test(args[0] || '')) {
    const v = await takeTruckCode(args[0].toUpperCase()); if (!v) return;   // wrong / expired / used: silence, like every other stranger
    const r = await D.q("UPDATE records SET data = data || $2::jsonb, updated_at = now(), updated_by = $3 WHERE coll='trucks' AND id=$1 RETURNING data->>'num' AS num", [v.t, JSON.stringify({ tg: id }), v.u]);
    if (!r.rows[0]) return; D.audit(v.u, 'telegram.truck', v.t, { chat: id }, null);
    return send(id, `✅ This group is now connected to truck <b>${esc(r.rows[0].num)}</b> on TOPGFLEET. Pre-trip (PTI) reminders for this truck come here.`);
  }
  // Everything else: the owner, and the people the owner allowed (AI page). Anyone else gets no reply at all.
  const lu = await linkedUser(sender), level = lu ? await D.ai.accessOf(lu) : null; if (!level) return;
  const isOwner = level === 'owner';
  if (cmd === '/chatid') { if (!isOwner) return; return send(id, `This chat’s id: <code>${esc(id)}</code>`); }
  if (!priv && !isOwner) return;   // groups: the owner only
  if (cmd === '/help' || cmd === '/start') return send(id, HELP);
  if (!isCmd) { if (!priv) return; return AIchat(lu, level, id, text); }
  const user = priv ? lu : null;
  if (!priv && !(await groupAllowed(id))) return send(id, 'This group is not configured. Add its id (<code>' + esc(id) + '</code>) on the site: Profile → Integrations / Companies.');
  if (cmd === '/new' && priv) { if (D.ai) await D.ai.reset(id); return send(id, '🆕 New conversation started.'); }
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
    const line = i => '• ' + esc(i.title || '–') + (i.desc ? ' — ' + esc(i.desc) : '');
    // an issue goes to the managers group of the company whose truck / trailer it names
    const coOf = i => { const T = String(i.title || ''), hit = L => (L || []).find(u => u.num && new RegExp('(^|[^A-Za-z0-9])' + String(u.num).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z0-9]|$)', 'i').test(T)); const u = hit(DB.trucks) || hit(DB.trailers); return u && (S.comps || []).find(c => c.id === u.company); };
    const byChat = new Map();
    for (const i of hot) { const c = coOf(i); if (c && c.mgr) byChat.set(String(c.mgr), [...(byChat.get(String(c.mgr)) || []), i]); }
    for (const [chat, L] of byChat) await send(chat, '❗ <b>New High priority issue</b>\n' + L.map(line).join('\n'));
    const txt = '❗ <b>New High priority issue</b>\n' + hot.map(line).join('\n');
    const admins = await D.q('SELECT c.chat_id FROM tg_chats c JOIN users u ON u.id=c.user_id WHERE u.role=\'admin\' AND NOT u.disabled AND c.digest');
    for (const r of admins.rows) if (!byChat.has(String(r.chat_id))) await send(r.chat_id, txt);
  } catch (e) { console.error('tg notify', e.message); }
}


const REASON = { truck: 'Truck Issue', trailer: 'Trailer Issue', tires: 'Tires', tow: 'Towing', parts: 'Parts', fuel: 'Fuel', lumper: 'Lumper fee', other: 'Other' };
const METHOD = { efs: 'EFS Money Code', ccheck: 'Comcheck', cc: 'Credit Card', zelle: 'Zelle', chk: 'ACH / WIRE / Other' };
const PAYER = { co: 'Company pays', ow: 'Owner operator pays', vn: 'Vendor pays', dr: 'Driver pays', br: 'Broker pays', sp: 'Split charge' };
const money = n => '$' + (+n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function loadFiles(files) {
  const ids = (Array.isArray(files) ? files : []).map(x => x && x.id).filter(x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x)).slice(0, 10); if (!ids.length) return [];
  const rows = (await D.q('SELECT id,name,mime,path FROM files WHERE id=ANY($1)', [ids])).rows, out = [];
  for (const id of ids) { const f = rows.find(r => r.id === id); if (!f) continue; try { out.push({ ...f, buf: require('fs').readFileSync(require('path').join(D.dataDir, f.path)) }); } catch (e) { console.error('tg file', e.message); } }
  return out;
}
// ONE message: every file goes as a document (no compression, original names), in a single album.
// Order: pictures first, then PDFs / other files; the invoice text is the caption of the LAST file, so it shows at the bottom of the album.
async function sendAlbum(chat, thread, files, html) {
  const post = async (method, fd) => { try { const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', body: fd, signal: AbortSignal.timeout(90000) }); return await r.json(); } catch (e) { return { ok: false, description: e.message }; } };
  const base = fd => { fd.append('chat_id', String(chat)); if (thread) fd.append('message_thread_id', String(thread)); return fd; };
  const isPic = f => /^image\//i.test(f.mime || '');
  const list = [...files.filter(isPic), ...files.filter(f => !isPic(f))];
  const cap = html.length <= 1000 ? html : null;
  let last, firstId = null, capId = null;
  const msgId = (r, lastOne) => { const m = r && r.ok && r.result; const f = Array.isArray(m) ? (lastOne ? m[m.length - 1] : m[0]) : m; return f && f.message_id || null; };
  const grab = r => { if (firstId) return; const m = r && r.ok && r.result; const f = Array.isArray(m) ? m[0] : m; if (f && f.message_id) firstId = f.message_id; };
  if (list.length === 1) {
    const f = list[0], fd = base(new FormData()); fd.append('document', new Blob([f.buf], { type: f.mime }), f.name);
    if (cap) { fd.append('caption', cap); fd.append('parse_mode', 'HTML'); }
    last = await post('sendDocument', fd); grab(last); capId = msgId(last, true);
  } else {
    for (let k = 0; k < list.length; k += 10) {
      const part = list.slice(k, k + 10), fd = base(new FormData()), lastChunk = k + 10 >= list.length;
      fd.append('media', JSON.stringify(part.map((f, n) => ({ type: 'document', media: 'attach://f' + n, ...(cap && lastChunk && n === part.length - 1 ? { caption: cap, parse_mode: 'HTML' } : {}) }))));
      part.forEach((f, n) => fd.append('f' + n, new Blob([f.buf], { type: f.mime }), f.name)); last = await post('sendMediaGroup', fd); grab(last); if (lastChunk) capId = msgId(last, true);
    }
  }
  if (!cap) last = await api('sendMessage', { chat_id: chat, text: html.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true, ...(thread ? { message_thread_id: thread } : {}) }), capId = msgId(last, true);
  return { mid: capId || firstId || (last && last.ok && last.result && last.result.message_id) || null, ok: !!(last && last.ok) };
}
async function notifyNewInvoices(invs, base) {
  const out = [];
  if (!enabled() || !invs.length) return out;
  try {
    const { DB, S } = await D.loadAll(), g = S.tg || {};
    for (const v of invs) {
      const tr = (DB.trucks || []).find(x => x.id === v.truck), tl = (DB.trailers || []).find(x => x.id === v.trailer);
      const co = (S.comps || []).find(c => c.id === ((tr && tr.company) || (tl && tl.company) || v.co)), chat = String((co && co.inv) || '').trim(), own = true; if (!chat) continue;
      const dr = tr && (DB.drivers || []).find(x => x.truck === tr.id);
      const resp = (PAYER[v.who] || v.who || '') + (v.who === 'sp' && Array.isArray(v.split) ? ' (' + v.split.map(s => `${({ co: 'Company', ow: 'Owner operator', vn: 'Vendor', dr: 'Driver', br: 'Broker' })[s.p] || s.p} ${v.sby === 'pct' ? s.v + '%' : money(s.v)}`).join(', ') + ')' : '');
      const L = [['Truck', (tr && tr.num) || v.truckT], ['Trailer', (tl && tl.num) || v.trailerT], ['Driver name', dr && dr.name], ['Reason', [v.rtxt || REASON[v.reason] || v.reason, v.desc].filter(Boolean).join(' — ')], ['Amount', money(v.amt)], ['Payment method', METHOD[v.method] || v.method], ['Invoice number', v.num], ['Responsible', resp], ['Date', v.date]]
        .map(([k, val]) => `${k}: ${val ? esc(val) : ''}`.trimEnd());
      const root = String(process.env.PUBLIC_URL || base || '').replace(/\/$/, ''); if (root && v.id) L.push(`Link: <a href="${esc(root)}/invoices?id=${encodeURIComponent(v.id)}">Open invoice</a>`);
      const text = L.join('\n'), thread = !own && g.topic && +g.topic || undefined, files = await loadFiles(v.files);
      let res;
      if (files.length) res = await sendAlbum(chat, thread, files, text);
      else { const body = { chat_id: chat, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }; if (thread) body.message_thread_id = thread; const r = await api('sendMessage', body); res = { ok: !!(r && r.ok), mid: r && r.result && r.result.message_id }; }
      if (res && res.ok) {
        const tzN = g.tz || 'America/Chicago', rec = { chat, mid: res.mid || null, time: (() => { try { return new Date().toLocaleTimeString('en-US', { timeZone: tzN, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch (e) { return new Date().toISOString().slice(11, 16) + ' UTC'; } })(), at: (() => { try { return new Date().toLocaleDateString('en-CA', { timeZone: g.tz || 'America/Chicago' }); } catch (e) { return new Date().toISOString().slice(0, 10); } })(), link: /^-100\d+$/.test(chat) && res.mid ? `https://t.me/c/${chat.slice(4)}/${res.mid}` : null };
        out.push({ id: v.id, ...rec });
        try { await D.q("UPDATE records SET data = data || $2::jsonb, updated_at = now() WHERE coll='inv' AND id=$1", [v.id, JSON.stringify({ tg: rec.at, tgm: rec })]); } catch (e) { console.error('tg save', e.message); }
      }
    }
  } catch (e) { console.error('tg invoice', e.message); }
  return out;
}

/* ---------- parking: units booked at a place until a date (list goes to the workers group) ---------- */
const usDate = d => { const a = String(d || '').split('-'); return a.length === 3 ? `${a[1]}/${a[2]}/${a[0]}` : '–'; };
const PARK_DUE_DAYS = 2;
/* scope: 'all' | company id | 't:' + team id; allowed: Set of company ids the sender may see (or null) */
function parkRows(DB, S, scope, allowed, today) {
  let cos = null, label = 'All companies';
  if (scope && scope !== 'all') {
    if (String(scope).startsWith('t:')) { const tm = (S.teams || []).find(x => x.id === String(scope).slice(2)); cos = new Set(tm ? tm.cos || [] : []); label = tm ? tm.n : 'Team'; }
    else { cos = new Set([scope]); const c = (S.comps || []).find(x => x.id === scope); label = c ? c.n : 'Company'; }
  }
  const units = new Map(); (DB.trucks || []).forEach(x => units.set('truck:' + x.id, x)); (DB.trailers || []).forEach(x => units.set('trailer:' + x.id, x));
  const rows = [];
  for (const p of (DB.park || [])) {
    if (p.status === 'closed') continue;
    const u = units.get((p.kind === 'trailer' ? 'trailer:' : 'truck:') + p.uid); if (!u) continue;
    if (cos && !cos.has(u.company)) continue; if (allowed && !allowed.has(u.company)) continue;
    rows.push({ kind: p.kind === 'trailer' ? 'Trailer' : 'Truck', num: u.num, loc: p.loc || '', driver: p.driver || '', phone: p.phone || '', from: p.from || '', to: p.to || '', note: p.note || '', days: dayDiff(p.to, today) });
  }
  rows.sort((a, b) => (a.days ?? 9e6) - (b.days ?? 9e6));
  return { rows, label };
}
const dueWord = d => d == null ? '' : d < 0 ? `overdue by ${-d} day${d === -1 ? '' : 's'}` : d === 0 ? 'ends today' : d === 1 ? 'ends tomorrow' : `in ${d} days`;
async function sendParkList(kind, scope, allowed) {
  const { DB, S } = await D.loadAll(), g = S.tg || {}, today = nowIn(g.tz || 'America/Chicago').date;
  if (!g.work) return { ok: false, description: 'no workers group set' };
  const { rows, label } = parkRows(DB, S, scope, allowed, today), full = kind === 'full';
  const list = full ? rows : rows.filter(r => r.days != null && r.days <= PARK_DUE_DAYS);
  const place = x => String(x || '').replace(/,?\s*(United States( of America)?|USA)\s*$/i, '').trim();
  const block = r => [`<b>${esc(r.kind)} unit:</b> ${esc(r.num)}`,
    `<b>Booking days:</b> ${usDate(r.from)} (drop off) → ${usDate(r.to)} (pick up)${r.days != null ? ' · ' + dueWord(r.days) : ''}${r.days != null && r.days <= PARK_DUE_DAYS ? ' ⚠️' : ''}`,
    r.driver || r.phone ? `<b>Driver:</b> ${esc([r.driver, r.phone].filter(Boolean).join(' · '))}` : '', r.note ? `<b>Description:</b> ${esc(r.note)}` : '', `<b>Location:</b> ${esc(place(r.loc) || '–')}`].filter(Boolean).join('\n');
  const head = `<b>🅿️ Parking — ${full ? 'full list' : 'due soon'}${list.length ? ' (' + list.length + ')' : ''}</b> · ${esc(label)}`;
  if (!list.length) { const body = { chat_id: g.work, text: head + '\n✅ ' + (full ? 'No units are booked in parking.' : `Nothing ends in the next ${PARK_DUE_DAYS} days.`), parse_mode: 'HTML', disable_web_page_preview: true }; if (g.topic) body.message_thread_id = +g.topic || undefined; return api('sendMessage', body); }
  const msgs = []; let cur = head; for (const r of list) { const b = block(r); if ((cur + '\n\n' + b).length > 3800) { msgs.push(cur); cur = head + ' (cont.)'; } cur += '\n\n' + b; } msgs.push(cur);
  let res = { ok: true };
  for (const text of msgs) { const body = { chat_id: g.work, text, parse_mode: 'HTML', disable_web_page_preview: true }; if (g.topic) body.message_thread_id = +g.topic || undefined; res = await api('sendMessage', body); if (!res.ok) break; }
  return res;
}
/* ---------- scheduler (every minute) ---------- */
async function getState() { const r = await D.q("SELECT value FROM kv WHERE key='tg_state'"); return r.rows[0] ? r.rows[0].value : {}; }
async function putState(v) { await D.q("INSERT INTO kv(key,value) VALUES('tg_state',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [JSON.stringify(v)]); }
async function tick() {
  if (!enabled() || !D) return;
  try {
    const { DB, S } = await D.loadAll(), g = S.tg || {}, n = nowIn(g.tz), st = await getState(); let dirty = false;
    for (const t of (g.times || [])) { const key = 'w:' + t; if (n.hm === t && st[key] !== n.date) { st[key] = n.date; dirty = true; await sendWorkersList(S, DB, false); } }
    {   // scheduled parking lists (kv parkSched: [{id, kind, scope, date, time, daily, last}])
      const r0 = await D.q("SELECT value FROM kv WHERE key='parkSched'"), ps = r0.rows[0] && Array.isArray(r0.rows[0].value) ? r0.rows[0].value : [], keep = []; let pd = false;
      for (const e of ps) {
        const due = e.daily ? (n.hm >= e.time && e.last !== n.date) : (n.date > e.date || (n.date === e.date && n.hm >= e.time));
        if (!due) { keep.push(e); continue; }
        pd = true; try { await sendParkList(e.kind, e.scope, null); } catch (er) { console.error('tg park', er.message); }
        if (e.daily) { e.last = n.date; keep.push(e); }
      }
      if (pd) await D.q("INSERT INTO kv(key,value) VALUES('parkSched',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [JSON.stringify(keep)]);
    }
    if (n.h === DIGEST_HOUR && st.digest !== n.date) {
      st.digest = n.date; dirty = true;
      const rows = (await D.q('SELECT c.chat_id,u.* FROM tg_chats c JOIN users u ON u.id=c.user_id WHERE c.digest AND NOT u.disabled AND u.role<>\'driver\'')).rows;
      for (const r of rows) { const A = D.allowedOf(r), d = A ? D.scopeState(DB, A) : DB, c = compute(d, S, n.date); if (c.over.length || c.soon.length || c.cant.length || c.issues.length) await send(r.chat_id, alertsText(c, 'Good morning — daily summary')); }
    }
    if (dirty) { for (const k of Object.keys(st)) if (k.startsWith('w:') && st[k] !== n.date && false) delete st[k]; await putState(st); }
  } catch (e) { console.error('tg tick', e.message); }
}
function init(deps, baseUrl) {
  D = deps; D.TG = module.exports; D.ai = require('./ai').make(D); if (!enabled()) { console.log('Telegram bot: off (set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET)'); return; }
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
// one-time codes that tie a Telegram group to a truck (kept in kv, never sent to the site)
const TCODES = 'tg_tcodes';
async function tcodes() { const r = await D.q('SELECT value FROM kv WHERE key=$1', [TCODES]); const now = Date.now(), m = {}; for (const [k, v] of Object.entries((r.rows[0] && r.rows[0].value) || {})) if (v && v.exp > now) m[k] = v; return m; }
const putTcodes = m => D.q('INSERT INTO kv(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()', [TCODES, JSON.stringify(m)]);
async function truckCode(truckId, userId) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = crypto.randomBytes(10); let code = 'T'; for (const x of b) code += A[x % A.length];
  const m = await tcodes(); for (const k of Object.keys(m)) if (m[k].t === truckId) delete m[k];
  m[code] = { t: truckId, u: userId, exp: Date.now() + 30 * 60e3 }; await putTcodes(m); return code;
}
async function takeTruckCode(code) { const m = await tcodes(), v = m[code]; if (!v) return null; delete m[code]; await putTcodes(m); return v; }
module.exports = { ai: () => D.ai, enabled, truckCode, init, verify, handleUpdate, setWebhook, info, me, send, api, sendWorkersList, sendParkList, tick, notifyNewIssues, notifyNewInvoices, linkCode, compute, alertsText, nowIn };
