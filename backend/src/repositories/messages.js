const { query, queryOne, nowISO } = require('../db');

function toApi(row) {
  return {
    id: row.id,
    timestamp: row.ts,
    sender: row.sender,
    text: row.text,
    emotion: row.emotion,
    source: row.source,
  };
}

async function add({ sender, text, emotion = 'neutral', source = null, ts = null }) {
  // RETURNING 으로 새 행을 바로 받는다 — lastInsertRowid 는 드라이버마다 달라 쓰지 않는다.
  const row = await queryOne(
    `INSERT INTO messages (ts, sender, text, emotion, source)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
    [ts || nowISO(), sender, text, emotion, source]
  );
  return toApi(row);
}

/**
 * 커서 페이지네이션. `before`(마지막으로 본 id)보다 작은 id를 최신순으로 반환한다.
 * 이전 GET /api/history 는 전체 로그를 통째로 반환해서, 대화가 쌓일수록 보호자 앱이 느려졌다.
 */
async function list({ before = null, limit = 50, sender = null, q = null } = {}) {
  const where = [];
  const params = [];

  if (before) { where.push('id < ?'); params.push(Number(before)); }
  if (sender) { where.push('sender = ?'); params.push(sender); }
  if (q) { where.push('text LIKE ?'); params.push(`%${q}%`); }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const capped = Math.min(Number(limit) || 50, 200);

  const { rows } = await query(
    `SELECT * FROM messages ${clause} ORDER BY id DESC LIMIT ?`,
    [...params, capped + 1]
  );

  const hasMore = rows.length > capped;
  const page = hasMore ? rows.slice(0, capped) : rows;

  return {
    messages: page.map(toApi),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

/**
 * 시간 범위 내 메시지를 오름차순으로 반환한다 (SQL에서 직접 필터링).
 * 일일 요약처럼 특정 구간 전체가 필요할 때 쓴다 — `list()`는 최신 N건을 캡핑해서
 * 가져오므로, 과거 날짜를 조회하면 그 구간이 최신 N건 밖에 있어 누락될 수 있다.
 */
async function listInRange(fromIso, toIso) {
  const { rows } = await query(
    'SELECT * FROM messages WHERE ts >= ? AND ts < ? ORDER BY id ASC',
    [fromIso, toIso]
  );
  return rows.map(toApi);
}

/** 오래된 순으로 최근 N개 — Gemini 대화 히스토리 복원용 */
async function recentAscending(count) {
  const { rows } = await query(
    `SELECT * FROM messages WHERE sender IN ('senior', 'robot') ORDER BY id DESC LIMIT ?`,
    [count]
  );
  return rows.reverse().map(toApi);
}

async function countSince(isoTs) {
  // COUNT는 pg에서 int8이라 문자열로 오기 쉽다 — pg 드라이버가 숫자로 정규화한다.
  const row = await queryOne('SELECT COUNT(*) AS n FROM messages WHERE ts >= ?', [isoTs]);
  return Number(row.n);
}

/** 보관 정책: 어르신 대화 로그는 민감 정보이므로 무한 적재하지 않는다. */
async function purgeOlderThan(isoTs) {
  const { rowCount } = await query('DELETE FROM messages WHERE ts < ?', [isoTs]);
  return rowCount;
}

module.exports = { add, list, listInRange, recentAscending, countSince, purgeOlderThan };
