const { getDB, nowISO } = require('../db');

/**
 * 감지기 원본 이벤트. 임계값 미만이라 알림으로 승격되지 않은 것도 남긴다 —
 * 나중에 YOLOv8 임계값을 튜닝할 때 이 기록이 유일한 근거가 된다.
 */
function record({ source, type, confidence, meta = null, detectedAt = null, alertId = null }) {
  const info = getDB()
    .prepare('INSERT INTO detections (ts, source, type, confidence, meta_json, alert_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(detectedAt || nowISO(), source, type, confidence, meta ? JSON.stringify(meta) : null, alertId);
  return info.lastInsertRowid;
}

function list({ limit = 100 } = {}) {
  return getDB()
    .prepare('SELECT * FROM detections ORDER BY id DESC LIMIT ?')
    .all(Math.min(Number(limit) || 100, 500))
    .map((row) => ({
      id: row.id,
      timestamp: row.ts,
      source: row.source,
      type: row.type,
      confidence: row.confidence,
      meta: row.meta_json ? JSON.parse(row.meta_json) : null,
      alertId: row.alert_id,
    }));
}

module.exports = { record, list };
