const { getDB, nowISO } = require('../db');

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

function create({ type, severity = 'critical', description = '', confidence = null, snapshotPath = null }) {
  const info = getDB()
    .prepare(
      `INSERT INTO alerts (ts, type, severity, description, confidence, snapshot_path)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(nowISO(), type, severity, description, confidence, snapshotPath);
  return byId(info.lastInsertRowid);
}

function byId(id) {
  return toApi(getDB().prepare('SELECT * FROM alerts WHERE id = ?').get(Number(id)));
}

function list({ resolved = null, type = null, from = null, to = null, before = null, limit = 50 } = {}) {
  const where = [];
  const params = [];

  if (resolved !== null && resolved !== undefined) { where.push('resolved = ?'); params.push(resolved ? 1 : 0); }
  if (type) { where.push('type = ?'); params.push(type); }
  if (from) { where.push('ts >= ?'); params.push(from); }
  if (to) { where.push('ts <= ?'); params.push(to); }
  if (before) { where.push('id < ?'); params.push(Number(before)); }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const capped = Math.min(Number(limit) || 50, 200);

  const rows = getDB()
    .prepare(`SELECT * FROM alerts ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...params, capped + 1);

  const hasMore = rows.length > capped;
  const page = hasMore ? rows.slice(0, capped) : rows;

  return {
    alerts: page.map(toApi),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

function unresolved() {
  return getDB()
    .prepare('SELECT * FROM alerts WHERE resolved = 0 ORDER BY id DESC')
    .all()
    .map(toApi);
}

function unresolvedCount() {
  return getDB().prepare('SELECT COUNT(*) AS n FROM alerts WHERE resolved = 0').get().n;
}

function resolve(id, by = 'senior') {
  const changes = getDB()
    .prepare(`UPDATE alerts SET resolved = 1, resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved = 0`)
    .run(nowISO(), by, Number(id)).changes;
  return { found: changes > 0, alert: byId(id) };
}

/**
 * 같은 유형·같은 severity의 알림이 쿨다운 안에 이미 있는지 확인한다.
 * 예전에는 "숨" 같은 헐거운 키워드가 매칭될 때마다 알림이 무제한 적재됐다.
 *
 * severity도 같이 봐야 한다 — 안 그러면 warning 알림 직후의 진짜 critical 발화가
 * (둘 다 type: 'voice_trigger') 같은 쿨다운에 걸려 억제된다.
 */
function hasRecentOfType(type, withinMs, severity) {
  const since = new Date(Date.now() - withinMs).toISOString();
  return getDB()
    .prepare('SELECT COUNT(*) AS n FROM alerts WHERE type = ? AND severity = ? AND ts >= ?')
    .get(type, severity, since).n > 0;
}

/** `to`를 생략하면 지금까지 전부 — 일일 요약처럼 상한이 필요한 곳은 반드시 넘겨야 한다. */
function countSince(isoTs, { severity = null, to = null } = {}) {
  const where = ['ts >= ?'];
  const params = [isoTs];
  if (to) { where.push('ts < ?'); params.push(to); }
  if (severity) { where.push('severity = ?'); params.push(severity); }

  return getDB()
    .prepare(`SELECT COUNT(*) AS n FROM alerts WHERE ${where.join(' AND ')}`)
    .get(...params).n;
}

module.exports = {
  create, byId, list, unresolved, unresolvedCount,
  resolve, hasRecentOfType, countSince,
};
