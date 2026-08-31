const { query, queryOne, nowISO } = require('../db');

/**
 * 감정 기록(`type='emotion'`)은 감지기 이벤트와 성격이 다르다. 같은 테이블에 넣되
 * `list()` 기본 조회에서는 빼 둔다 — 임계값 튜닝용 목록이 감정 행에 밀리면 안 된다.
 */
const EMOTION_TYPE = 'emotion';

/**
 * 감지기 원본 이벤트. 임계값 미만이라 알림으로 승격되지 않은 것도 남긴다 —
 * 나중에 YOLOv8 임계값을 튜닝할 때 이 기록이 유일한 근거가 된다.
 */
async function record({ source, type, confidence, meta = null, detectedAt = null, alertId = null }) {
  const row = await queryOne(
    `INSERT INTO detections (ts, source, type, confidence, meta_json, alert_id)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id`,
    [detectedAt || nowISO(), source, type, confidence, meta ? JSON.stringify(meta) : null, alertId]
  );
  return row.id;
}

function toApi(row) {
  return {
    id: row.id,
    timestamp: row.ts,
    source: row.source,
    type: row.type,
    confidence: row.confidence,
    meta: row.meta_json ? JSON.parse(row.meta_json) : null,
    alertId: row.alert_id,
  };
}

/** `type`을 주면 그 종류만, 안 주면 감정 기록을 뺀 감지기 이벤트만 돌려준다. */
async function list({ limit = 100, type = null } = {}) {
  const { rows } = await query(
    `SELECT * FROM detections WHERE type ${type ? '=' : '<>'} ? ORDER BY id DESC LIMIT ?`,
    [type || EMOTION_TYPE, Math.min(Number(limit) || 100, 500)]
  );
  return rows.map(toApi);
}

/**
 * 한 종류를 시간 구간 [start, end)로 조회한다. 보호자 요약의 하루 집계용.
 * 집계를 SQL COUNT/GROUP BY로 하지 않는 이유: 세어야 하는 값이 `meta_json` 안의
 * expression이라 어차피 JS에서 풀어야 하고, COUNT를 쓰면 pg의 int8이 문자열로 와서
 * 정규화가 필요한데 pg-mem은 그 차이를 재현하지 못해 테스트로 못 잡는다.
 */
async function listInRange(type, startIso, endIso, { limit = 2000 } = {}) {
  const { rows } = await query(
    'SELECT * FROM detections WHERE type = ? AND ts >= ? AND ts < ? ORDER BY id ASC LIMIT ?',
    [type, startIso, endIso, Math.min(Number(limit) || 2000, 5000)]
  );
  return rows.map(toApi);
}

module.exports = { record, list, listInRange, EMOTION_TYPE };
