const { getDB, nowISO } = require('../db');

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

function add({ sender, text, emotion = 'neutral', source = null, ts = null }) {
  const info = getDB()
    .prepare('INSERT INTO messages (ts, sender, text, emotion, source) VALUES (?, ?, ?, ?, ?)')
    .run(ts || nowISO(), sender, text, emotion, source);
  return toApi(
    getDB().prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid)
  );
}

/**
 * 커서 페이지네이션. `before`(마지막으로 본 id)보다 작은 id를 최신순으로 반환한다.
 * 이전 GET /api/history 는 전체 로그를 통째로 반환해서, 대화가 쌓일수록 보호자 앱이 느려졌다.
 */
function list({ before = null, limit = 50, sender = null, q = null } = {}) {
  const where = [];
  const params = [];

  if (before) { where.push('id < ?'); params.push(Number(before)); }
  if (sender) { where.push('sender = ?'); params.push(sender); }
  if (q) { where.push('text LIKE ?'); params.push(`%${q}%`); }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const capped = Math.min(Number(limit) || 50, 200);

  const rows = getDB()
    .prepare(`SELECT * FROM messages ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...params, capped + 1);

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
function listInRange(fromIso, toIso) {
  return getDB()
    .prepare('SELECT * FROM messages WHERE ts >= ? AND ts < ? ORDER BY id ASC')
    .all(fromIso, toIso)
    .map(toApi);
}

/** 오래된 순으로 최근 N개 — Gemini 대화 히스토리 복원용 */
function recentAscending(count) {
  const rows = getDB()
    .prepare(`SELECT * FROM messages WHERE sender IN ('senior', 'robot') ORDER BY id DESC LIMIT ?`)
    .all(count);
  return rows.reverse().map(toApi);
}

function countSince(isoTs) {
  return getDB()
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE ts >= ?')
    .get(isoTs).n;
}

/** 보관 정책: 어르신 대화 로그는 민감 정보이므로 무한 적재하지 않는다. */
function purgeOlderThan(isoTs) {
  return getDB().prepare('DELETE FROM messages WHERE ts < ?').run(isoTs).changes;
}

module.exports = { add, list, listInRange, recentAscending, countSince, purgeOlderThan };
