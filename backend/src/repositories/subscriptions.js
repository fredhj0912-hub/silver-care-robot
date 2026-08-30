const { query, nowISO } = require('../db');

/** 보호자 기기의 Web Push 구독 (Phase 5) */
async function save({ endpoint, keys, label = null }) {
  // ON CONFLICT ... DO UPDATE 는 SQLite와 PostgreSQL 문법이 동일하다.
  await query(
    `INSERT INTO push_subscriptions (endpoint, keys_json, label, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET keys_json = excluded.keys_json, label = excluded.label`,
    [endpoint, JSON.stringify(keys), label, nowISO()]
  );
}

async function remove(endpoint) {
  const { rowCount } = await query('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
  return rowCount;
}

async function all() {
  const { rows } = await query('SELECT * FROM push_subscriptions', []);
  return rows.map((row) => ({
    id: row.id,
    endpoint: row.endpoint,
    keys: JSON.parse(row.keys_json),
    label: row.label,
  }));
}

module.exports = { save, remove, all };
