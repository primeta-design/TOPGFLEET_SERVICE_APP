'use strict';
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const url = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: url,
  max: 10,
  // Railway's internal network is private; its public proxy needs SSL
  ssl: url && /proxy\.rlwy\.net|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
});
pool.on('error', e => console.error('pg pool error', e.message));

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}
module.exports = { pool, q: (t, p) => pool.query(t, p), migrate };
