const express = require('express');
const { asyncHandler } = require('../middleware');
const { config } = require('../config');
const statusRepo = require('../repositories/status');
const detectionsRepo = require('../repositories/detections');
const gemini = require('../services/gemini');
const emergency = require('../services/emergency');
const snapshots = require('../services/snapshots');

const router = express.Router();

// 최신 카메라 프레임 (라이브 뷰용). 메모리에만 두고 영속화하지 않는다.
let latestSnapshot = null;
let latestSnapshotAt = null;

router.post('/vision', asyncHandler(async (req, res) => {
  const { image } = req.body || {};

  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: '이미지 데이터(base64 data URI)가 필요합니다' });
  }
  if (!snapshots.parseDataUri(image)) {
    return res.status(400).json({ error: 'data:image/ 로 시작하는 올바른 data URI여야 합니다' });
  }
  // 한계값은 config 한 곳에서만 정의한다 (이전에는 50mb/20MB/"15MB"가 서로 달랐다)
  if (Buffer.byteLength(image, 'utf8') > config.maxJsonBodyBytes) {
    return res.status(413).json({ error: '이미지 용량이 허용치를 초과했습니다' });
  }

  latestSnapshot = image;
  latestSnapshotAt = new Date().toISOString();

  const analysis = await gemini.analyzeImage(image);

  statusRepo.update({ seniorExpression: analysis.expression });

  let alert = null;
  if (analysis.isEmergency) {
    const snapshotPath = await snapshots.save(image);
    if (!snapshotPath) {
      console.error('[VISION] critical 알림인데 스냅샷 저장 실패 (형식 오류 또는 8MB 초과) — 증거 사진 없이 알림 생성');
    }
    alert = emergency.raise({
      type: 'vision_anomaly',
      severity: 'critical',
      description: analysis.summary,
      confidence: analysis.confidence,
      snapshotPath,
    });
    detectionsRepo.record({
      source: 'vision_gemini',
      type: 'abnormal_posture',
      confidence: analysis.confidence,
      meta: { summary: analysis.summary },
      alertId: alert ? alert.id : null,
    });
  }

  res.json({
    hasPerson: analysis.hasPerson,
    isEmergency: analysis.isEmergency,
    expression: analysis.expression,
    confidence: analysis.confidence,
    summary: analysis.summary,
    source: analysis.source,
    alert: alert ? { id: alert.id } : null,
  });
}));

router.get('/vision/latest', (req, res) => {
  res.json({ image: latestSnapshot, capturedAt: latestSnapshotAt });
});

/**
 * 외부 감지기(YOLOv8 서비스 등) → 백엔드 이벤트 수신구.
 * 지금은 mock-detector 스크립트가 이 계약을 사용해 전체 파이프라인을 테스트한다.
 */
router.post('/detections', asyncHandler(async (req, res) => {
  const { source, type, confidence, detectedAt, snapshot, meta } = req.body || {};

  if (!source || !type || typeof confidence !== 'number') {
    return res.status(400).json({ error: 'source, type, confidence(숫자)가 필요합니다' });
  }
  if (confidence < 0 || confidence > 1) {
    return res.status(400).json({ error: 'confidence는 0~1 사이여야 합니다' });
  }

  const snapshotPath = snapshot ? await snapshots.save(snapshot) : null;

  // 임계값 미만은 기록만 한다 — 알림은 올리지 않되 임계값 튜닝 근거로 남긴다.
  let alert = null;
  if (confidence >= config.detectionThreshold) {
    alert = emergency.raise({
      type: type === 'fall' ? 'fall_detected' : type === 'no_motion' ? 'no_motion' : 'vision_anomaly',
      severity: 'critical',
      description: describeDetection(type, confidence),
      confidence,
      snapshotPath,
    });
  }

  const id = detectionsRepo.record({
    source, type, confidence, meta, detectedAt,
    alertId: alert ? alert.id : null,
  });

  res.json({
    detectionId: id,
    accepted: true,
    alertRaised: Boolean(alert),
    alert: alert ? { id: alert.id } : null,
    threshold: config.detectionThreshold,
  });
}));

router.get('/detections', (req, res) => {
  res.json({ detections: detectionsRepo.list({ limit: req.query.limit }) });
});

function describeDetection(type, confidence) {
  const pct = Math.round(confidence * 100);
  if (type === 'fall') return `낙상이 감지되었습니다 (신뢰도 ${pct}%). 어르신 상태 확인이 필요합니다.`;
  if (type === 'no_motion') return `장시간 움직임이 없습니다 (신뢰도 ${pct}%).`;
  return `비정상 자세가 감지되었습니다 (신뢰도 ${pct}%).`;
}

module.exports = router;
