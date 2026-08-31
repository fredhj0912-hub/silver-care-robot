const { query, nowISO } = require('../db');

/** 보호자 기기의 Web Push 구독 (Phase 5) */
async function save({ endpoint, keys, label = null, origin = null }) {
  // ON CONFLICT ... DO UPDATE 는 SQLite와 PostgreSQL 문법이 동일하다.
  await query(
    `INSERT INTO push_subscriptions (endpoint, keys_json, label, origin, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET keys_json = excluded.keys_json,
                                          label = excluded.label,
                                          origin = excluded.origin`,
    [endpoint, JSON.stringify(keys), label, origin, nowISO()]
  );
}

/**
 * 지금 살아 있는 origin이 아닌 구독을 지운다.
 *
 * 터널 주소가 재시작마다 바뀌는데, 옛 주소의 구독을 FCM은 404/410으로 거부하지 않고
 * **성공으로 응답한다.** 그래서 notify.js의 자동 정리에 안 걸리고 로그엔 "발송 완료"가
 * 찍히지만 보호자가 알림을 눌러도 사라진 주소가 열린다(Cloudflare Error 1033).
 * 살아 있는 주소는 한 번에 하나뿐이므로, 새 구독이 들어온 origin과 다르면 죽은 것이다.
 * origin이 NULL인 레거시 행도 같은 이유로 함께 정리한다.
 */
async function removeOtherOrigins(origin) {
  if (!origin) return 0;
  const { rowCount } = await query(
    'DELETE FROM push_subscriptions WHERE origin IS NULL OR origin <> ?',
    [origin]
  );
  return rowCount;
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
    origin: row.origin,
  }));
}

module.exports = { save, remove, removeOtherOrigins, all };
