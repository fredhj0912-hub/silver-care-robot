const { query, queryOne, nowISO } = require('../db');

/**
 * DB 행(snake_case, 정수 boolean) → API 응답 형태. 기존 프론트가 쓰던 키 이름을 그대로 유지한다.
 * `is_emergency`는 두 드라이버 모두 정수 0/1이므로 `Boolean()`이 양쪽에서 동작한다.
 */
function toApi(row) {
  return {
    status: row.status,
    battery: row.battery,
    lastActive: row.last_active,
    seniorExpression: row.senior_expression,
    isEmergency: Boolean(row.is_emergency),
  };
}

async function get(tx = null) {
  const run = tx ? tx.queryOne : queryOne;
  return toApi(await run('SELECT * FROM robot_status WHERE id = 1', []));
}

/**
 * 상태를 부분 갱신한다.
 * 예전 GET /api/status 는 조회할 때마다 lastActive를 갱신하며 DB 전체를 다시 썼다.
 * 이제 갱신은 명시적으로 요청할 때만 일어난다.
 *
 * `tx`를 넘기면 그 트랜잭션 안에서 실행된다 — `emergency.js`가 쿨다운 확인과
 * 비상 상태 전환을 한 트랜잭션으로 묶을 때 쓴다.
 */
async function update(patch = {}, tx = null) {
  const sets = [];
  const values = [];

  const columns = {
    status: 'status',
    battery: 'battery',
    seniorExpression: 'senior_expression',
    isEmergency: 'is_emergency',
    lastActive: 'last_active',
  };

  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    // boolean은 두 드라이버 모두 정수 0/1로 저장한다 (db/index.js 규칙 3).
    values.push(key === 'isEmergency' ? (patch[key] ? 1 : 0) : patch[key]);
  }

  if (!sets.length) return get(tx);

  const run = tx ? tx.query : query;
  await run(`UPDATE robot_status SET ${sets.join(', ')} WHERE id = 1`, values);
  return get(tx);
}

/** 어르신과의 상호작용이 있었음을 기록 — "마지막 활동" 표시용 */
async function touch() {
  await query('UPDATE robot_status SET last_active = ? WHERE id = 1', [nowISO()]);
}

module.exports = { get, update, touch };
