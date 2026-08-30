const { query, queryOne, nowISO } = require('../db');

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

async function enqueue({ kind, payload }) {
  const row = await queryOne(
    `INSERT INTO outbound_commands (ts, kind, payload)
     VALUES (?, ?, ?)
     RETURNING *`,
    [nowISO(), kind, JSON.stringify(payload)]
  );
  return toApi(row);
}

async function byId(id) {
  return toApi(await queryOne('SELECT * FROM outbound_commands WHERE id = ?', [Number(id)]));
}

/**
 * 미전달 명령을 조회한다 — 조회만 하고 큐에서 제거하지 않는다.
 * 예전 GET /api/remote-message/poll 은 조회 시점에 shift()로 큐를 비워서,
 * 응답이 유실되면 보호자 메시지가 영영 사라졌다. 이제 로봇이 처리 후 ack()를 호출한다.
 */
async function pending({ kind = null, limit = 20 } = {}) {
  const where = ['delivered = 0'];
  const params = [];
  if (kind) { where.push('kind = ?'); params.push(kind); }

  const { rows } = await query(
    `SELECT * FROM outbound_commands WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`,
    [...params, Math.min(Number(limit) || 20, 100)]
  );
  return rows.map(toApi);
}

async function ack(id) {
  const { rowCount } = await query(
    'UPDATE outbound_commands SET delivered = 1, delivered_at = ? WHERE id = ? AND delivered = 0',
    [nowISO(), Number(id)]
  );
  return { found: rowCount > 0, command: await byId(id) };
}

/**
 * 이동 명령은 지나면 의미가 없다 — 미전달 move 명령을 한꺼번에 폐기한다(비상 정지 등).
 * `tx`를 넘기면 그 트랜잭션 안에서 실행된다 (`emergency.raise()`가 쓴다).
 */
async function dropPending(kind, tx = null) {
  const run = tx ? tx.query : query;
  const { rowCount } = await run(
    'UPDATE outbound_commands SET delivered = 1, delivered_at = ? WHERE delivered = 0 AND kind = ?',
    [nowISO(), kind]
  );
  return rowCount;
}

module.exports = { enqueue, byId, pending, ack, dropPending };
