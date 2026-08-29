const { getDB, nowISO } = require('../db');

/** DB 행(snake_case, 정수 boolean) → API 응답 형태. 기존 프론트가 쓰던 키 이름을 그대로 유지한다. */
function toApi(row) {
  return {
    status: row.status,
    battery: row.battery,
    lastActive: row.last_active,
    seniorExpression: row.senior_expression,
    isEmergency: Boolean(row.is_emergency),
  };
}

async function get() {
  return toApi(getDB().prepare('SELECT * FROM robot_status WHERE id = 1').get());
}

/**
 * 상태를 부분 갱신한다.
 * 예전 GET /api/status 는 조회할 때마다 lastActive를 갱신하며 DB 전체를 다시 썼다.
 * 이제 갱신은 명시적으로 요청할 때만 일어난다.
 */
async function update(patch = {}) {
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
    values.push(key === 'isEmergency' ? (patch[key] ? 1 : 0) : patch[key]);
  }

  if (!sets.length) return get();

  getDB().prepare(`UPDATE robot_status SET ${sets.join(', ')} WHERE id = 1`).run(...values);
  return get();
}

/** 어르신과의 상호작용이 있었음을 기록 — "마지막 활동" 표시용 */
async function touch() {
  getDB().prepare('UPDATE robot_status SET last_active = ? WHERE id = 1').run(nowISO());
}

module.exports = { get, update, touch };
