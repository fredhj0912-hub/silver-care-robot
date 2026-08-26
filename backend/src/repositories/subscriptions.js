const { getDB, nowISO } = require('../db');

/** 보호자 기기의 Web Push 구독 (Phase 5) */
function save({ endpoint, keys, label = null }) {
  getDB()
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, keys_json, label, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET keys_json = excluded.keys_json, label = excluded.label`
    )
    .run(endpoint, JSON.stringify(keys), label, nowISO());
}

function remove(endpoint) {
  return getDB().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes;
}

function all() {
  return getDB()
    .prepare('SELECT * FROM push_subscriptions')
    .all()
    .map((row) => ({
      id: row.id,
      endpoint: row.endpoint,
      keys: JSON.parse(row.keys_json),
      label: row.label,
    }));
}

module.exports = { save, remove, all };
