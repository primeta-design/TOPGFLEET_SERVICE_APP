'use strict';
// Telematics (Samsara now, Motive later). READ-ONLY: this file only ever sends GET requests to the provider.
// API keys are sealed with APP_SECRET (AES-256-GCM) in kv 'telem' and never leave the server; the site sees the last 4 characters.
const KV = 'telem';
const HOSTS = { us: 'https://api.samsara.com', eu: 'https://api.eu.samsara.com', ca: 'https://api.ca.samsara.com' };
const MI = 1609.344;
const HOURS = [+process.env.TELEM_FROM || 6, +process.env.TELEM_TO || 20];   // automatic mileage pull: every hour between these hours (company time zone)
const cleanVin = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const s = (v, n = 120) => String(v == null ? '' : v).slice(0, n);
class TErr extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } }

function make(D) {   // D: { q, C, audit, loadAll, allowedOf }
  const all = async () => { const r = (await D.q('SELECT value FROM kv WHERE key=$1', [KV])).rows[0]; return Array.isArray(r && r.value) ? r.value : []; };
  const put = L => D.q('INSERT INTO kv(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()', [KV, JSON.stringify(L)]);
  const pub = a => ({ id: a.id, n: a.n, p: a.p, co: a.co || null, region: a.region || 'us', last4: a.last4, at: a.at, by: a.by, ok: a.ok !== false, cnt: a.cnt || 0, err: a.err || null, checked: a.checked || null, synced: a.synced || null });
  // which accounts a person may use: an account tied to a company only for people who see that company
  const visible = (L, u) => { const A = u ? D.allowedOf(u) : null; return L.filter(a => !A || (a.co ? A.has(a.co) : false)); };

  /* ---------- Samsara (GET only) ---------- */
  async function sam(a, p, params) {
    let key; try { key = D.C.unseal(a.key); } catch { throw new TErr('key'); }
    const u = new URL((HOSTS[a.region] || HOSTS.us) + p); for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== '') u.searchParams.set(k, v);
    let r; try { r = await fetch(u, { method: 'GET', headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, signal: AbortSignal.timeout(25000) }); } catch { throw new TErr('net'); }
    if (r.status === 401) throw new TErr('key', 401); if (r.status === 403) throw new TErr('scope', 403); if (r.status === 429) throw new TErr('busy', 429);
    if (!r.ok) throw new TErr('http', r.status);
    try { return await r.json(); } catch { throw new TErr('http', r.status); }
  }
  async function pages(a, p, params, max = 25) {
    const out = []; let after;
    for (let i = 0; i < max; i++) { const j = await sam(a, p, { ...params, after }); out.push(...(Array.isArray(j.data) ? j.data : [])); const pg = j.pagination || {}; if (!pg.hasNextPage || !pg.endCursor) break; after = pg.endCursor; }
    return out;
  }
  const vehicles = async a => (await pages(a, '/fleet/vehicles', { limit: 512 })).map(v => ({ sid: s(v.id, 40), name: s(v.name, 60), vin: cleanVin(v.vin).slice(0, 20), make: s(v.make, 40), model: s(v.model, 40), year: s(v.year, 4), plate: s(v.licensePlate, 20) }));
  async function stats(a) {
    const m = new Map();
    for (const v of await pages(a, '/fleet/vehicles/stats', { types: 'obdOdometerMeters,gpsOdometerMeters,gps' })) {
      const o = v.obdOdometerMeters && v.obdOdometerMeters.value != null ? v.obdOdometerMeters : v.gpsOdometerMeters && v.gpsOdometerMeters.value != null ? v.gpsOdometerMeters : null, g = v.gps || null;
      m.set(String(v.id), { mi: o ? Math.round(+o.value / MI) : null, at: o ? o.time : null, src: v.obdOdometerMeters && v.obdOdometerMeters.value != null ? 'obd' : o ? 'gps' : null,
        loc: g ? s((g.reverseGeo && g.reverseGeo.formattedLocation) || (g.address && g.address.name) || '', 160) : '', lat: g && isFinite(+g.latitude) ? +g.latitude : null, lng: g && isFinite(+g.longitude) ? +g.longitude : null, locAt: g ? g.time : null });
    }
    return m;
  }
  const errText = e => (e && e.code) || 'net';

  /* ---------- trucks <-> provider vehicles ---------- */
  function matcher(trucks) {
    const byVin = new Map(), bySid = new Map(), byNum = new Map();
    trucks.forEach(t => { const v = cleanVin(t.vin); if (v) byVin.set(v, t); if (t.tsid) bySid.set(String(t.tsid), t); if (t.num) byNum.set(String(t.num).trim().toLowerCase(), t); });
    return v => (v.vin && byVin.get(v.vin)) || bySid.get(v.sid) || (v.name && byNum.get(v.name.trim().toLowerCase())) || null;
  }
  // pull odometer + location into the trucks; one Samsara reading per truck per day in the mileage history
  async function syncMiles(u) {
    const L = visible(await all(), u).filter(a => a.p === 'samsara'); if (!L.length) return { accounts: 0, updated: 0, matched: 0, unmatched: 0, errors: [] };
    const A = u ? D.allowedOf(u) : null, { DB } = await D.loadAll(), trucks = (DB.trucks || []).filter(t => !A || A.has(t.company));
    const out = { accounts: L.length, updated: 0, matched: 0, unmatched: 0, errors: [] }, full = await all(), now = new Date().toISOString();
    for (const a of L) {
      const rec = full.find(x => x.id === a.id);
      try {
        const [vs, st] = await Promise.all([vehicles(a), stats(a)]); const pool = trucks.filter(t => !a.co || t.company === a.co), find = matcher(pool);
        for (const v of vs) {
          const tr = find(v), x = st.get(v.sid); if (!tr) { out.unmatched++; continue; } out.matched++; if (!x) continue;
          const d = JSON.parse(JSON.stringify(tr)); let ch = false;
          if (d.tsid !== v.sid) { d.tsid = v.sid; ch = true; }
          if (x.mi != null && x.mi >= 0 && String(d.miles) !== String(x.mi)) {
            d.miles = String(x.mi); d.miAt = x.at || now; ch = true;
            const mh = Array.isArray(d.mh) ? d.mh : [], day = String(x.at || now).slice(0, 10), e = { mi: x.mi, at: x.at || now, src: 'samsara', by: 'Samsara' };
            if (!mh.length && tr.miles !== '' && tr.miles != null && +tr.miles !== x.mi) mh.push({ mi: +tr.miles, at: null, src: 'unknown' });
            const same = mh.findIndex(m => m && m.src === 'samsara' && String(m.at || '').slice(0, 10) === day); if (same >= 0) mh[same] = e; else mh.push(e);
            d.mh = mh.sort((p, q) => String(q.at || '').localeCompare(String(p.at || ''))).slice(0, 300);
          }
          if (x.loc && x.loc !== d.loc) { d.loc = x.loc; ch = true; }
          if (x.lat != null) { d.gps = { lat: x.lat, lng: x.lng, at: x.locAt || now }; ch = true; }
          if (ch) { await D.q("UPDATE records SET data=$2::jsonb, updated_at=now(), updated_by='samsara' WHERE coll='trucks' AND id=$1", [tr.id, JSON.stringify(d)]); out.updated++; }
        }
        if (rec) Object.assign(rec, { ok: true, err: null, cnt: vs.length, synced: now, checked: now });
      } catch (e) { out.errors.push({ acc: a.n, err: errText(e) }); if (rec) Object.assign(rec, { ok: false, err: errText(e), checked: now }); }
    }
    await put(full); return out;
  }

  /* ---------- routes ---------- */
  function routes(app, { auth, staff, intOk, wrap, limit, okId, denyOf, roOf }) {
    const sec = (k, write) => wrap(async (req, res, next) => { const d = await denyOf(req.u); if (d.includes(k) || (write && (await roOf(req.u)).includes(k))) return res.status(403).json({ error: 'section' }); next(); });
    app.get('/api/telem', auth(), staff, wrap(async (req, res) => { const L = await all(); res.json({ accounts: visible(L, req.u).map(pub) }); }));
    app.post('/api/telem', limit('telemadd', 20, 10 * 60e3), auth(), staff, intOk, wrap(async (req, res) => {
      const b = req.body || {}, n = String(b.n || '').trim().slice(0, 60), key = String(b.key || '').trim(), region = HOSTS[b.region] ? b.region : 'us';
      if (b.p === 'motive') return res.status(400).json({ error: 'soon' });
      if (b.p !== 'samsara' || !n || key.length < 20 || key.length > 400 || /\s/.test(key)) return res.status(400).json({ error: 'bad' });
      const co = b.co && okId(b.co) ? b.co : null;
      if (co) { const cr = (await D.q("SELECT value FROM kv WHERE key='comps'")).rows[0]; if (!cr || !Array.isArray(cr.value) || !cr.value.some(c => c && c.id === co)) return res.status(400).json({ error: 'bad' }); }
      const a = { id: D.C.uid(), n, p: 'samsara', co, region, key: D.C.seal(key), last4: key.slice(-4), at: new Date().toISOString(), by: req.u.name };
      try { const vs = await vehicles(a); a.ok = true; a.cnt = vs.length; a.checked = new Date().toISOString(); }
      catch (e) { return res.status(400).json({ error: errText(e) }); }
      const L = await all(); L.push(a); await put(L); D.audit(req.u.id, 'telem.add', a.id, { n, co, region }, req.ip);
      res.json({ account: pub(a) });
    }));
    app.post('/api/telem/:id/test', limit('telemtest', 30, 10 * 60e3), auth(), staff, intOk, wrap(async (req, res) => {
      const L = await all(), a = L.find(x => x.id === req.params.id); if (!a) return res.status(404).json({ error: 'none' });
      try { const vs = await vehicles(a); Object.assign(a, { ok: true, err: null, cnt: vs.length, checked: new Date().toISOString() }); } catch (e) { Object.assign(a, { ok: false, err: errText(e), checked: new Date().toISOString() }); }
      await put(L); res.json({ account: pub(a) });
    }));
    app.delete('/api/telem/:id', auth(), staff, intOk, wrap(async (req, res) => {
      const L = await all(), i = L.findIndex(x => x.id === req.params.id); if (i < 0) return res.status(404).json({ error: 'none' });
      const [a] = L.splice(i, 1); await put(L); D.audit(req.u.id, 'telem.delete', a.id, { n: a.n }, req.ip); res.json({ ok: true });
    }));
    // every vehicle the person's accounts report, with odometer and whether it is already a truck on the site
    app.get('/api/telem/vehicles', limit('telemv', 60, 10 * 60e3), auth(), staff, sec('trucks'), wrap(async (req, res) => {
      const L = visible(await all(), req.u).filter(a => a.p === 'samsara'); if (!L.length) return res.json({ accounts: 0, vehicles: [], errors: [] });
      const A = D.allowedOf(req.u), { DB } = await D.loadAll(), trucks = (DB.trucks || []).filter(t => !A || A.has(t.company));
      const out = [], errors = [];
      for (const a of L) {
        try { const [vs, st] = await Promise.all([vehicles(a), stats(a).catch(() => new Map())]), find = matcher(trucks.filter(t => !a.co || t.company === a.co));
          vs.forEach(v => { const tr = find(v), x = st.get(v.sid) || {}; out.push({ ...v, acc: a.id, accN: a.n, co: a.co || null, mi: x.mi ?? null, loc: x.loc || '', truck: tr ? tr.id : null, num: tr ? tr.num : null }); });
        } catch (e) { errors.push({ acc: a.n, err: errText(e) }); }
      }
      res.json({ accounts: L.length, vehicles: out, errors });
    }));
    app.get('/api/telem/find', limit('telemf', 60, 10 * 60e3), auth(), staff, sec('trucks'), wrap(async (req, res) => {
      const qv = String(req.query.q || '').trim().toLowerCase(), qn = cleanVin(qv); if (!qv) return res.status(400).json({ error: 'bad' });
      const L = visible(await all(), req.u).filter(a => a.p === 'samsara'); if (!L.length) return res.json({ accounts: 0, matches: [] });
      const m = [], errors = [];
      for (const a of L) { try { for (const v of await vehicles(a)) if (v.name.toLowerCase() === qv || (qn.length >= 6 && v.vin.endsWith(qn)) || (qv.length >= 2 && v.name.toLowerCase().includes(qv))) m.push({ ...v, acc: a.id, co: a.co || null }); } catch (e) { errors.push({ acc: a.n, err: errText(e) }); } }
      m.sort((x, y) => (y.name.toLowerCase() === qv) - (x.name.toLowerCase() === qv));
      const top = m.slice(0, 8);
      if (top.length) { const a = L.find(x => x.id === top[0].acc); try { const st = await stats(a), x = st.get(top[0].sid); if (x) top[0].mi = x.mi; } catch {} }
      res.json({ accounts: L.length, matches: top, errors });
    }));
    app.post('/api/telem/sync-miles', limit('telemsync', 20, 10 * 60e3), auth(), staff, sec('trucks', true), wrap(async (req, res) => {
      const r = await syncMiles(req.u); D.audit(req.u.id, 'telem.sync', null, { updated: r.updated }, req.ip); res.json(r);
    }));
    // safety events for the Violation Report (max 31 days a request)
    app.get('/api/telem/violations', limit('telemev', 60, 10 * 60e3), auth(), staff, sec('violations'), wrap(async (req, res) => {
      const a0 = new Date(String(req.query.from || '')), b0 = new Date(String(req.query.to || '')); if (isNaN(a0) || isNaN(b0) || b0 <= a0 || b0 - a0 > 31 * 864e5) return res.status(400).json({ error: 'bad' });
      const L = visible(await all(), req.u).filter(a => a.p === 'samsara'); if (!L.length) return res.json({ accounts: 0, events: [], errors: [] });
      const A = D.allowedOf(req.u), { DB } = await D.loadAll(), trucks = (DB.trucks || []).filter(t => !A || A.has(t.company)), ev = [], errors = [];
      for (const a of L) {
        try { const find = matcher(trucks.filter(t => !a.co || t.company === a.co));
          for (const e of await pages(a, '/fleet/safety-events', { startTime: a0.toISOString(), endTime: b0.toISOString() }, 10)) {
            const v = e.vehicle || {}, tr = find({ sid: String(v.id || ''), name: s(v.name, 60), vin: '' });
            ev.push({ id: s(e.id, 60), time: e.time, acc: a.n, vehicle: s(v.name, 60), truck: tr ? tr.id : null, num: tr ? tr.num : null, driver: s(e.driver && e.driver.name, 80),
              labels: (Array.isArray(e.behaviorLabels) ? e.behaviorLabels : []).map(l => s(l.name || l.label, 60)).filter(Boolean), g: e.maxAccelerationGForce ?? null,
              lat: e.location && isFinite(+e.location.latitude) ? +e.location.latitude : null, lng: e.location && isFinite(+e.location.longitude) ? +e.location.longitude : null, coach: s(e.coachingState, 40),
              video: /^https:\/\//.test(e.downloadForwardVideoUrl || '') ? e.downloadForwardVideoUrl : null });
          }
        } catch (e) { errors.push({ acc: a.n, err: errText(e) }); }
      }
      ev.sort((x, y) => String(y.time).localeCompare(String(x.time)));
      res.json({ accounts: L.length, events: ev.slice(0, 2000), errors });
    }));
  }

  /* ---------- every hour while the office works ---------- */
  let lastHour = '';
  async function tick() {
    try {
      const L = await all(); if (!L.some(a => a.p === 'samsara')) return;
      const { S } = await D.loadAll(), tz = (S.tg && S.tg.tz) || 'America/Chicago';
      let p; try { p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value])); } catch { return; }
      const h = +p.hour, key = `${p.year}-${p.month}-${p.day} ${p.hour}`; if (h < HOURS[0] || h > HOURS[1] || key === lastHour) return; lastHour = key;
      const r = await syncMiles(null); if (r.updated) console.log('telematics: updated', r.updated, 'trucks');
    } catch (e) { console.error('telematics tick', e.message); }
  }
  function start() { setInterval(tick, 5 * 60e3).unref(); setTimeout(tick, 30e3).unref(); }
  return { routes, start, syncMiles, tick, _all: all };
}
module.exports = { make, cleanVin };
