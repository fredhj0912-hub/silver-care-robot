const { query, queryOne } = require('../db');

/**
 * Gemini 호출 일일 카운터. 이 프로젝트에서 호출을 세는 유일한 곳이다.
 *
 * `day`가 무엇인지(태평양 시각)와 `bucket`이 무엇인지는 services/budget.js 가 정한다 —
 * 여기는 그냥 (day, bucket) 칸을 세는 창구다.
 */

/**
 * 원자적으로 1 올리고 **올린 뒤의 값**을 돌려준다.
 *
 * `emergency.js`의 쿨다운(`hasRecentOfType`)은 조회 후 삽입이라 pg 에서 racy 하다고 그
 * 파일에 적혀 있다. 여기서는 그 패턴을 따라가지 않는다 — 한 문장 UPSERT 라 동시 요청
 * 두 개가 같은 숫자를 받는 일이 없다. 예산 상한은 세는 것이 어긋나면 의미가 없다.
 */
async function increment(day, bucket) {
  const row = await queryOne(
    `INSERT INTO api_usage (day, bucket, n) VALUES (?, ?, 1)
     ON CONFLICT (day, bucket) DO UPDATE SET n = api_usage.n + 1
     RETURNING n`,
    [day, bucket]
  );
  return Number(row.n);
}

/** 그 날의 버킷별 사용량. 없는 버킷은 키 자체가 없다. */
async function getDay(day) {
  const { rows } = await query('SELECT bucket, n FROM api_usage WHERE day = ?', [day]);
  return Object.fromEntries(rows.map((r) => [r.bucket, Number(r.n)]));
}

module.exports = { increment, getDay };
