const { query, queryOne } = require('../db');

/**
 * Gemini 호출 일일 카운터. 이 프로젝트에서 호출을 세는 유일한 곳이다.
 *
 * `day`가 무엇인지(태평양 시각)와 `bucket`이 무엇인지는 services/budget.js 가 정한다 —
 * 여기는 그냥 (day, bucket) 칸을 세는 창구다.
 */

/**
 * 예산이 남아 있을 때만 원자적으로 1 올리고 **올린 뒤의 값**을 돌려준다.
 * 이미 상한에 닿았으면 아무것도 쓰지 않고 `null` 을 돌려준다.
 *
 * **읽기와 판단이 한 문장 안에 있어야 한다.** 조회 후 삽입으로 나누면 그 사이의 `await`
 * 에서 다른 요청이 끼어들어, 둘 다 "아직 여유 있다"를 읽고 둘 다 올린다 — 상한 36이
 * 37·38이 된다. 결제를 켜면 이 숫자가 곧 요금 상한이라 새는 상한은 상한이 아니다.
 * (`emergency.js` 의 쿨다운은 그 패턴이라 pg 에서 racy 하다고 그 파일에 적혀 있다)
 *
 * `DO UPDATE ... WHERE` 는 SQLite 와 PostgreSQL 둘 다 지원한다. 조건이 거짓이면 갱신도
 * `RETURNING` 도 일어나지 않아 행이 안 돌아온다 — 그게 곧 "가득 찼다"는 신호다.
 */
async function incrementIfBelow(day, bucket, limit) {
  // 한도가 0 이하면 첫 INSERT 자체를 막아야 한다 — 그 경로에는 ON CONFLICT 가 안 걸린다.
  if (!(limit > 0)) return null;

  const row = await queryOne(
    `INSERT INTO api_usage (day, bucket, n) VALUES (?, ?, 1)
     ON CONFLICT (day, bucket) DO UPDATE SET n = api_usage.n + 1
     WHERE api_usage.n < ?
     RETURNING n`,
    [day, bucket, limit]
  );
  return row ? Number(row.n) : null;
}

/** 그 날의 버킷별 사용량. 없는 버킷은 키 자체가 없다. */
async function getDay(day) {
  const { rows } = await query('SELECT bucket, n FROM api_usage WHERE day = ?', [day]);
  return Object.fromEntries(rows.map((r) => [r.bucket, Number(r.n)]));
}

module.exports = { incrementIfBelow, getDay };
