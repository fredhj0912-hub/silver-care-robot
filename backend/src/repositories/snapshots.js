const { query, queryOne, nowISO } = require('../db');

/**
 * 카메라 스냅샷 기록. **이미지가 아니라 파일명만** 담는다 — 실제 바이트는
 * services/snapshots.js 가 디스크나 S3 에 둔다(팀원과 같은 RDS 를 쓰므로).
 */

function toApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    capturedAt: row.ts,
    // 파일은 기존 서빙 경로로 내보낸다 (routes/alerts.js 의 /api/snapshots/:filename).
    url: `/api/snapshots/${row.filename}`,
  };
}

async function record(filename, capturedAt = null) {
  const row = await queryOne(
    'INSERT INTO snapshots (ts, filename) VALUES (?, ?) RETURNING *',
    [capturedAt || nowISO(), filename]
  );
  return toApi(row);
}

/** 최신순. 보호자 화면은 limit=1 로 "지금 방 안 모습"만 가져간다. */
async function list(limit = 20) {
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const { rows } = await query(
    'SELECT * FROM snapshots ORDER BY id DESC LIMIT ?',
    [capped]
  );
  return rows.map(toApi);
}

async function count() {
  const row = await queryOne('SELECT COUNT(*) AS n FROM snapshots', []);
  return Number(row.n);
}

/**
 * 최신 `keep`개만 남기고 나머지를 지운다. **삭제한 파일명을 돌려준다** —
 * 호출부가 실제 파일까지 지워야 하기 때문이다. 행만 지우면 디스크에는 영원히 남는다.
 *
 * `id > ?` 서브쿼리 대신 "남길 것의 최소 id"를 먼저 구한다 — LIMIT/OFFSET 을
 * DELETE 안에 넣는 문법이 SQLite 와 PostgreSQL 에서 서로 다르기 때문이다.
 */
async function pruneToLimit(keep) {
  const limit = Math.max(Number(keep) || 0, 1);

  const boundary = await queryOne(
    'SELECT id FROM snapshots ORDER BY id DESC LIMIT 1 OFFSET ?',
    [limit]
  );
  if (!boundary) return [];   // 아직 상한을 안 넘었다

  const { rows } = await query(
    'SELECT filename FROM snapshots WHERE id <= ?',
    [boundary.id]
  );
  await query('DELETE FROM snapshots WHERE id <= ?', [boundary.id]);

  return rows.map((r) => r.filename);
}

module.exports = { record, list, count, pruneToLimit };
