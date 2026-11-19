'use strict';
// Sends e-mail through Resend's HTTPS API (works on Railway; plain SMTP is blocked there).
// Set RESEND_API_KEY and MAIL_FROM (an address on a domain you verified in Resend). Without them nothing is sent.
const enabled = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
async function send(to, subject, html, text) {
  if (!enabled()) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, html, text }) });
    if (!r.ok) console.error('mail', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) { console.error('mail', e.message); return false; }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const wrap = (title, body, url, btn) => `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px"><h2 style="margin:0 0 12px">${esc(title)}</h2><p style="color:#333;line-height:1.5">${esc(body)}</p><p><a href="${esc(url)}" style="display:inline-block;background:#7c5cff;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${esc(btn)}</a></p><p style="color:#777;font-size:12px">${esc(url)}</p></div>`;
module.exports = { enabled, send, wrap };
