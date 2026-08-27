const { getDB, nowISO } = require('../db');

function toApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    timestamp: row.ts,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    delivered: Boolean(row.delivered),
    deliveredAt: row.delivered_at,
  };
}

function enqueue({ kind, payload }) {
  const info = getDB()
    .prepare('INSERT INTO outbound_commands (ts, kind, payload) VALUES (?, ?, ?)')
    .run(nowISO(), kind, JSON.stringify(payload));
  return byId(info.lastInsertRowid);
}

function byId(id) {
  return toApi(getDB().prepare('SELECT * FROM outbound_commands WHERE id = ?').get(Number(id)));
}

/**
 * 미전달 명령을 조회한다 — 조회만 하고 큐에서 제거하지 않는다.
 * 예전 GET /api/remote-message/poll 은 조회 시점에 shift()로 큐를 비워서,
 * 응답이 유실되면 보호자 메시지가 영영 사라졌다. 이제 로봇이 처리 후 ack()를 호출한다.
 */
function pending({ kind = null, limit = 20 } = {}) {
  const where = ['delivered = 0'];
  const params = [];
  if (kind) { where.push('kind = ?'); params.push(kind); }

  return getDB()
    .prepare(`SELECT * FROM outbound_commands WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`)
    .all(...params, Math.min(Number(limit) || 20, 100))
    .map(toApi);
}

function ack(id) {
  const changes = getDB()
    .prepare('UPDATE outbound_commands SET delivered = 1, delivered_at = ? WHERE id = ? AND delivered = 0')
    .run(nowISO(), Number(id)).changes;
  return { found: changes > 0, command: byId(id) };
}

/** 이동 명령은 지나면 의미가 없다 — 미전달 move 명령을 한꺼번에 폐기한다(비상 정지 등). */
function dropPending(kind) {
  return getDB()
    .prepare('UPDATE outbound_commands SET delivered = 1, delivered_at = ? WHERE delivered = 0 AND kind = ?')
    .run(nowISO(), kind).changes;
}

module.exports = { enqueue, byId, pending, ack, dropPending };
