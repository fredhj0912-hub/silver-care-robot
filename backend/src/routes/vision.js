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

  // **분석이 실패하면 이 프레임에 대해 우리는 아무것도 모른다.**
  //
  // analyzeImage 는 어떤 실패 경로에서든 폴백값을 돌려준다
  // (expression:'neutral', isEmergency:false, hasPerson:true). 그 값들은
  // "평온하다"가 아니라 **"보지 못했다"**는 뜻인데, error 를 안 보고 그대로 쓰면:
  //   ① 카메라가 보지도 않은 'neutral' 이 robot_status 에 덮이고,
  //      직전 표정과 다르면 detections 에 **없던 표정 변화**가 한 줄 남는다 —
  //      그 근거 없는 기록이 보호자 화면과 일일 요약으로 그대로 나간다.
  //   ② isEmergency:false 라서 **그 프레임에 진짜 낙상이 있었어도 조용히 지워진다.**
  // 예산이 소진되는 순간(budget_exhausted)이 정확히 이 상태이고, 그때는 15초마다
  // 이 일이 반복된다. 그래서 아무것도 쓰지 않고 "판정 못 했다"고 밝힌다.
  //
  // 스냅샷은 위에서 이미 저장했다 — 라이브 뷰는 Gemini 와 무관하게 계속 살아 있어야 한다.
  if (analysis.error) {
    console.error(`[VISION] 분석 실패 — 이 프레임은 판정하지 않는다: ${analysis.error}`);
    return res.json({
      analyzed: false,
      error: analysis.error,
      // null 은 "모른다"다. false 로 주면 "확인했고 이상 없다"로 읽힌다.
      hasPerson: null,
      isEmergency: null,
      expression: null,
      confidence: null,
      summary: null,
      source: analysis.source,
      alert: null,
    });
  }

  // 표정은 카메라 주기(기본 15초)마다 들어온다. 매번 남기면 하루 수천 행이라
  // **바뀔 때만** 한 줄 남긴다. 그 대가로 이 기록은 지속 시간이 아니라 변화 횟수를
  // 센다 — "종일 슬픔"과 "잠깐 슬픔"이 똑같이 1이다. 지속 시간 가중이 필요해지면
  // meta_json에 직전 상태의 지속 시간을 넣어 확장한다.
  const previousExpression = (await statusRepo.get()).seniorExpression;
  await statusRepo.update({ seniorExpression: analysis.expression });

  if (analysis.expression && analysis.expression !== previousExpression) {
    await detectionsRepo.record({
      source: 'vision_gemini',
      type: detectionsRepo.EMOTION_TYPE,
      confidence: analysis.confidence,
      meta: {
        expression: analysis.expression,
        previous: previousExpression,
        hasPerson: analysis.hasPerson,
      },
    });
  }

  let alert = null;
  if (analysis.isEmergency) {
    const snapshotPath = await snapshots.save(image);
    if (!snapshotPath) {
      console.error('[VISION] critical 알림인데 스냅샷 저장 실패 (형식 오류 또는 8MB 초과) — 증거 사진 없이 알림 생성');
    }
    alert = await emergency.raise({
      type: 'vision_anomaly',
      severity: 'critical',
      description: analysis.summary,
      confidence: analysis.confidence,
      snapshotPath,
    });
    await detectionsRepo.record({
      source: 'vision_gemini',
      type: 'abnormal_posture',
      confidence: analysis.confidence,
      meta: { summary: analysis.summary },
      alertId: alert ? alert.id : null,
    });
  }

  res.json({
    analyzed: true,
    error: null,
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
  const overThreshold = confidence >= config.detectionThreshold;
  if (overThreshold) {
    alert = await emergency.raise({
      type: type === 'fall' ? 'fall_detected' : type === 'no_motion' ? 'no_motion' : 'vision_anomaly',
      severity: 'critical',
      description: describeDetection(type, confidence),
      confidence,
      snapshotPath,
    });
  }

  const id = await detectionsRepo.record({
    source, type, confidence, meta, detectedAt,
    alertId: alert ? alert.id : null,
  });

  res.json({
    detectionId: id,
    accepted: true,
    alertRaised: Boolean(alert),
    // raise()는 쿨다운에 걸려도 null을 돌려준다. 억제 사유를 실어 주지 않으면
    // 감지기 쪽에서 임계값 문제로 오해해 디버깅이 헛돈다(mock-detector가 실제로 그랬다).
    suppressedBy: alert ? null : (overThreshold ? 'cooldown' : 'threshold'),
    alert: alert ? { id: alert.id } : null,
    threshold: config.detectionThreshold,
  });
}));

router.get('/detections', asyncHandler(async (req, res) => {
  // type을 주지 않으면 감정 기록은 빠진다 — 기본 목록은 감지기 이벤트용이다.
  res.json({
    detections: await detectionsRepo.list({ limit: req.query.limit, type: req.query.type }),
  });
}));

function describeDetection(type, confidence) {
  const pct = Math.round(confidence * 100);
  if (type === 'fall') return `낙상이 감지되었습니다 (신뢰도 ${pct}%). 어르신 상태 확인이 필요합니다.`;
  if (type === 'no_motion') return `장시간 움직임이 없습니다 (신뢰도 ${pct}%).`;
  return `비정상 자세가 감지되었습니다 (신뢰도 ${pct}%).`;
}

module.exports = router;
