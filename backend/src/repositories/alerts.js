const { query, queryOne, nowISO } = require('../db');

function toApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    timestamp: row.ts,
    type: row.type,
    severity: row.severity,
    description: row.description,
    confidence: row.confidence,
    // 스냅샷은 파일로 저장하고 API에서는 URL로 노출한다
    snapshotUrl: row.snapshot_path ? `/api/snapshots/${row.snapshot_path}` : null,
    resolved: Boolean(row.resolved),
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

async function create({ type, severity = 'critical', description = '', confidence = null, snapshotPath = null }, tx = null) {
  const run = tx ? tx.queryOne : queryOne;
  const row = await run(
    `INSERT INTO alerts (ts, type, severity, description, confidence, snapshot_path)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING *`,
    [nowISO(), type, severity, description, confidence, snapshotPath]
  );
  return toApi(row);
}

async function byId(id) {
  return toApi(await queryOne('SELECT * FROM alerts WHERE id = ?', [Number(id)]));
}

async function list({ resolved = null, type = null, from = null, to = null, before = null, limit = 50 } = {}) {
  const where = [];
  const params = [];

  if (resolved !== null && resolved !== undefined) { where.push('resolved = ?'); params.push(resolved ? 1 : 0); }
  if (type) { where.push('type = ?'); params.push(type); }
  if (from) { where.push('ts >= ?'); params.push(from); }
  if (to) { where.push('ts <= ?'); params.push(to); }
  if (before) { where.push('id < ?'); params.push(Number(before)); }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const capped = Math.min(Number(limit) || 50, 200);

  const { rows } = await query(
    `SELECT * FROM alerts ${clause} ORDER BY id DESC LIMIT ?`,
    [...params, capped + 1]
  );

  const hasMore = rows.length > capped;
  const page = hasMore ? rows.slice(0, capped) : rows;

  return {
    alerts: page.map(toApi),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

async function unresolved() {
  const { rows } = await query('SELECT * FROM alerts WHERE resolved = 0 ORDER BY id DESC', []);
  return rows.map(toApi);
}

async function unresolvedCount(tx = null) {
  const run = tx ? tx.queryOne : queryOne;
  const row = await run('SELECT COUNT(*) AS n FROM alerts WHERE resolved = 0', []);
  return Number(row.n);
}

async function resolve(id, by = 'senior', tx = null) {
  const run = tx ? tx.query : query;
  const { rowCount } = await run(
    'UPDATE alerts SET resolved = 1, resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved = 0',
    [nowISO(), by, Number(id)]
  );

  const readOne = tx ? tx.queryOne : queryOne;
  const alert = toApi(await readOne('SELECT * FROM alerts WHERE id = ?', [Number(id)]));
  return { found: rowCount > 0, alert };
}

/**
 * 같은 유형·같은 severity의 알림이 쿨다운 안에 이미 있는지 확인한다.
 * 예전에는 "숨" 같은 헐거운 키워드가 매칭될 때마다 알림이 무제한 적재됐다.
 *
 * severity도 같이 봐야 한다 — 안 그러면 warning 알림 직후의 진짜 critical 발화가
 * (둘 다 type: 'voice_trigger') 같은 쿨다운에 걸려 억제된다.
 */
async function hasRecentOfType(type, withinMs, severity, tx = null) {
  const since = new Date(Date.now() - withinMs).toISOString();
  const run = tx ? tx.queryOne : queryOne;
  const row = await run(
    'SELECT COUNT(*) AS n FROM alerts WHERE type = ? AND severity = ? AND ts >= ?',
    [type, severity, since]
  );
  return Number(row.n) > 0;
}

/** `to`를 생략하면 지금까지 전부 — 일일 요약처럼 상한이 필요한 곳은 반드시 넘겨야 한다. */
async function countSince(isoTs, { severity = null, to = null } = {}) {
  const where = ['ts >= ?'];
  const params = [isoTs];
  if (to) { where.push('ts < ?'); params.push(to); }
  if (severity) { where.push('severity = ?'); params.push(severity); }

  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM alerts WHERE ${where.join(' AND ')}`,
    params
  );
  return Number(row.n);
}

module.exports = {
  create, byId, list, unresolved, unresolvedCount,
  resolve, hasRecentOfType, countSince,
};
