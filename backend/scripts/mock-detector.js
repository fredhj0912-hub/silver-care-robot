#!/usr/bin/env node
/**
 * 낙상 감지기 시뮬레이터.
 *
 * 실물 라즈베리파이/카메라/YOLOv8 없이 전체 응급 파이프라인
 * (감지 → 알림 → SSE → 보호자 화면)을 끝까지 테스트한다.
 *
 *   npm run mock-detector -- --type fall --confidence 0.92
 *   npm run mock-detector -- --type no_motion --confidence 0.8
 *   npm run mock-detector -- --confidence 0.3      # 임계값 미만 → 기록만
 *
 * 나중에 붙일 Python(YOLOv8 + MediaPipe) 서비스는 이 스크립트와
 * 똑같은 POST /api/detections 계약을 사용하면 된다.
 */
const { config } = require('../src/config');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const type = arg('type', 'fall');
const confidence = Number(arg('confidence', '0.92'));
const host = arg('host', `http://127.0.0.1:${config.port}`);

if (!['fall', 'no_motion', 'abnormal_posture'].includes(type)) {
  console.error(`--type 은 fall | no_motion | abnormal_posture 중 하나여야 합니다 (받은 값: ${type})`);
  process.exit(1);
}
if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
  console.error(`--confidence 는 0~1 사이 숫자여야 합니다 (받은 값: ${arg('confidence', '')})`);
  process.exit(1);
}

// 실제 YOLOv8+MediaPipe 파이프라인이 내보낼 값의 형태를 흉내낸다
const meta = {
  torsoAngle: type === 'fall' ? 78.4 : 12.1,      // 토르소 기울기(도) — 수평에 가까울수록 낙상
  verticalVelocity: type === 'fall' ? 1.42 : 0.03, // 수직 속도(m/s)
  keypointCount: 33,                                // MediaPipe Pose 랜드마크 수
  model: 'mock',
};

(async () => {
  const res = await fetch(`${host}/api/detections`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.robotApiKey ? { 'x-api-key': config.robotApiKey } : {}),
    },
    body: JSON.stringify({
      source: 'mock',
      type,
      confidence,
      detectedAt: new Date().toISOString(),
      meta,
    }),
  }).catch((err) => {
    console.error(`백엔드(${host})에 연결하지 못했습니다:`, err.message);
    console.error('먼저 `npm run dev` 로 서버를 실행하세요.');
    process.exit(1);
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`요청 실패 (${res.status}):`, body);
    process.exit(1);
  }

  console.log(`감지 이벤트 전송: ${type} / 신뢰도 ${confidence} (임계값 ${body.threshold})`);
  if (body.alertRaised) {
    console.log(`🚨 알림 생성됨 — id ${body.alert.id}. 로봇 화면과 보호자 앱이 비상 모드로 전환됩니다.`);
  } else {
    console.log('ℹ️  임계값 미만이라 알림 없이 기록만 되었습니다 (임계값 튜닝 근거로 남습니다).');
  }
})();
