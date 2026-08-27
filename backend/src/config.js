const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BACKEND_ROOT = path.join(__dirname, '..');

// 업로드 페이로드 한계 — 이전에는 express.json(50mb) / 핸들러 검사(20,000,000자) /
// 에러 문구("15MB")가 서로 달랐다. 한 곳에서만 정의한다.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;             // 디코딩된 원본 이미지 8MB
const MAX_JSON_BODY_BYTES = 12 * 1024 * 1024;        // base64는 원본보다 ~33% 크다
const MAX_JSON_BODY = `${MAX_JSON_BODY_BYTES}b`;     // express.json 이 이해하는 형식

const config = {
  port: Number(process.env.PORT) || 3001,

  // Gemini — 2026-08 실측 결과:
  //   gemini-3.6-flash  안정적으로 응답
  //   gemini-3.7-flash  단가는 절반이지만 출시 직후라 503(수요 폭주)이 잦다
  // 어르신이 기다리는 대화이므로 안정성을 우선해 3.6을 기본으로 둔다.
  // 3.7이 안정화되면 GEMINI_MODEL 환경변수만 바꾸면 된다.
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash',

  // 일시적 오류(429/503) 재시도. 대화 지연이 길어지면 어르신이 로봇이 고장난 줄 안다.
  geminiRetries: Number(process.env.GEMINI_RETRIES) || 1,
  geminiRetryDelayMs: Number(process.env.GEMINI_RETRY_DELAY_MS) || 400,

  // AWS 공용 리전 (지금은 S3 스냅샷 저장소만 사용).
  awsRegion: process.env.AWS_REGION || 'us-west-2',

  // LAN 공유 비밀키. 미설정이면 모든 API가 열린다(개발 편의) — 부팅 시 경고를 띄운다.
  robotApiKey: process.env.ROBOT_API_KEY || '',

  dbPath: process.env.DB_PATH || path.join(BACKEND_ROOT, 'data', 'hyodol.sqlite'),
  snapshotDir: process.env.SNAPSHOT_DIR || path.join(BACKEND_ROOT, 'data', 'snapshots'),
  ttsCacheDir: process.env.TTS_CACHE_DIR || path.join(BACKEND_ROOT, 'data', 'tts-cache'),
  legacyJsonPath: path.join(BACKEND_ROOT, 'database.json'),

  // 스냅샷 저장소 — 'local'(기본) | 's3'. 대회 계정은 Access Key 발급이 금지되어
  // IAM Role로만 인증되므로 s3는 EC2에서만 실제로 동작한다 (docs/deploy-ec2-aws-test.md 참고).
  snapshotStorage: process.env.SNAPSHOT_STORAGE || 'local',
  s3Bucket: process.env.S3_BUCKET || '',

  // TTS — 'browser' | 'gemini' | 'cloud'
  //
  //  browser  브라우저 SpeechSynthesis. 지연 0, 무료. 목소리 캐릭터를 고를 수 없다.
  //  gemini   지금 API 키로 바로 됨. 실측 지연 약 4.9초 — 처음 듣는 문장에는 너무 느리다.
  //  cloud    Cloud TTS(Chirp 3 HD). 지연 수백 ms + 목소리 선택 가능.
  //           같은 API 키로 되지만 콘솔에서 API 활성화가 한 번 필요하다:
  //           https://console.cloud.google.com/apis/library/texttospeech.googleapis.com
  //
  // 활성화 전까지는 browser 가 기본이다 — 어르신을 기다리게 하지 않는 것이 우선이다.
  ttsProvider: process.env.TTS_PROVIDER || 'browser',
  ttsGeminiModel: process.env.TTS_GEMINI_MODEL || 'gemini-3.1-flash-tts-preview',
  // gemini provider면 프리셋 음성 이름(Zephyr/Leda/Aoede…), cloud면 ko-KR-Chirp3-HD-* 형식
  ttsVoice: process.env.TTS_VOICE || (process.env.TTS_PROVIDER === 'cloud' ? 'ko-KR-Chirp3-HD-Leda' : 'Leda'),
  ttsSpeakingRate: Number(process.env.TTS_SPEAKING_RATE) || 1.0,
  ttsPitch: Number(process.env.TTS_PITCH) || 0,

  maxImageBytes: MAX_IMAGE_BYTES,
  maxJsonBody: MAX_JSON_BODY,
  maxJsonBodyBytes: MAX_JSON_BODY_BYTES,
  maxChatChars: 1000,
  maxSpeakChars: 500,

  // 대화 히스토리
  maxHistoryTurns: 8,
  sessionTimeoutMs: 10 * 60 * 1000,

  // 같은 유형의 알림이 연달아 쏟아지는 것을 막는 쿨다운
  alertCooldownMs: Number(process.env.ALERT_COOLDOWN_MS) || 10 * 60 * 1000,

  // 감지기 신뢰도가 이 값 미만이면 기록만 하고 알림은 올리지 않는다
  detectionThreshold: Number(process.env.DETECTION_THRESHOLD) || 0.7,

  // 보호자 브라우저로 보내는 Web Push. 셋 다 있어야 발송된다(`npx web-push generate-vapid-keys`로 생성).
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || '',

  isDev: process.env.NODE_ENV !== 'production',
};

function describeStartup() {
  const lines = [];
  if (!config.geminiApiKey) {
    lines.push('⚠️  GEMINI_API_KEY 미설정 → mock 대화 모드로 동작합니다');
    lines.push('   🔗 https://aistudio.google.com/ 에서 API 키를 발급받으세요');
  }
  if (!config.robotApiKey) {
    lines.push('⚠️  ROBOT_API_KEY 미설정 → 모든 API가 인증 없이 열려 있습니다');
    lines.push('   같은 Wi-Fi의 누구나 SOS·카메라·원격조종 API를 호출할 수 있습니다');
  }
  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    lines.push('⚠️  VAPID 키 미설정 → 응급 상황이 발생해도 보호자에게 푸시 알림이 가지 않습니다');
    lines.push('   npx web-push generate-vapid-keys 로 발급 후 VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY를 설정하세요');
  }
  if (config.snapshotStorage === 's3' && !config.s3Bucket) {
    lines.push('⚠️  SNAPSHOT_STORAGE=s3 인데 S3_BUCKET 미설정 → 스냅샷 저장이 실패합니다');
  }
  return lines;
}

module.exports = { config, describeStartup };
