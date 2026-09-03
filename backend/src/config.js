const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BACKEND_ROOT = path.join(__dirname, '..');

// 업로드 페이로드 한계 — 이전에는 express.json(50mb) / 핸들러 검사(20,000,000자) /
// 에러 문구("15MB")가 서로 달랐다. 한 곳에서만 정의한다.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;             // 디코딩된 원본 이미지 8MB
const MAX_JSON_BODY_BYTES = 12 * 1024 * 1024;        // base64는 원본보다 ~33% 크다
const MAX_JSON_BODY = `${MAX_JSON_BODY_BYTES}b`;     // express.json 이 이해하는 형식

// 서버측 STT로 올라오는 발화 오디오. 16kHz 모노 16bit WAV라 10초 발화가 약 320KB,
// base64로 감싸도 ~430KB다. 10배 넘는 여유를 두되 MAX_JSON_BODY_BYTES 아래에 둔다 —
// 마이크가 켜진 채 방치돼도 한 요청이 서버를 오래 붙들지 않게 하는 것이 목적이다.
const MAX_AUDIO_BYTES = 6 * 1024 * 1024;             // base64 data URI 문자열 기준

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

  // 받아쓰기 마감시한. 대화(chat)와 달리 **늦게 온 받아쓰기는 쓸모가 없다** —
  // 어르신은 이미 돌아섰고, 그 사이에 한 다른 말과 뒤섞인다.
  // 2026-09-02 실측: 잘 되면 3초, 503 재시도 체인에 걸리면 20~52초까지 갔다.
  // 시한을 넘기면 실패로 처리해 화면에 드러낸다 — 조용히 기다리는 것이 제일 나쁘다.
  sttTimeoutMs: Number(process.env.STT_TIMEOUT_MS) || 12000,

  // AWS 공용 리전 (지금은 S3 스냅샷 저장소만 사용).
  awsRegion: process.env.AWS_REGION || 'us-west-2',

  // LAN 공유 비밀키. 미설정이면 모든 API가 열린다(개발 편의) — 부팅 시 경고를 띄운다.
  robotApiKey: process.env.ROBOT_API_KEY || '',

  // DB 드라이버 — 'sqlite'(기본, 개발·테스트) | 'pg'(RDS PostgreSQL).
  // S3와 달리 RDS는 사용자/비밀번호 인증이라 Access Key 금지 제약에 걸리지 않는다
  // — 로컬에서도 실제 연결 검증이 된다 (npm run verify-rds).
  dbDriver: process.env.DB_DRIVER || 'sqlite',
  databaseUrl: process.env.DATABASE_URL || '',
  // RDS는 SSL을 요구한다. 로컬 PostgreSQL로 시험할 때만 0으로 끈다.
  databaseSsl: process.env.DATABASE_SSL !== '0',

  dbPath: process.env.DB_PATH || path.join(BACKEND_ROOT, 'data', 'hyodol.sqlite'),
  snapshotDir: process.env.SNAPSHOT_DIR || path.join(BACKEND_ROOT, 'data', 'snapshots'),
  ttsCacheDir: process.env.TTS_CACHE_DIR || path.join(BACKEND_ROOT, 'data', 'tts-cache'),
  legacyJsonPath: path.join(BACKEND_ROOT, 'database.json'),

  // 프론트엔드 빌드(frontend/dist)를 백엔드가 같은 오리진에서 서빙할 디렉터리.
  // EC2 배포 전용이다 — 로컬 개발은 Vite dev 서버가 /api를 프록시하므로 비워 둔다.
  // 같은 오리진이라 lib/api.js의 API_BASE(상대 경로)와 CORS 설정을 건드릴 필요가 없다.
  publicDir: process.env.PUBLIC_DIR || '',

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
  // 일시 오류(503 등)를 몇 번 더 시도할지. **기본값을 1로 잡은 이유**: TTS도 하루 20건이고,
  // 503 재시도가 그 카운트에 잡히는지 확인된 바 없다. 할당량 소진은 아예 재시도하지 않는다.
  // `|| 1`이 아니라 이 형태인 이유: TTS_RETRIES=0("재시도하지 마라")이 살아남아야 한다.
  ttsRetries: Number.isFinite(Number(process.env.TTS_RETRIES)) && process.env.TTS_RETRIES !== ''
    ? Number(process.env.TTS_RETRIES)
    : 1,
  ttsRetryDelayMs: Number(process.env.TTS_RETRY_DELAY_MS) || 600,

  maxImageBytes: MAX_IMAGE_BYTES,
  maxAudioBytes: MAX_AUDIO_BYTES,
  maxJsonBody: MAX_JSON_BODY,
  maxJsonBodyBytes: MAX_JSON_BODY_BYTES,
  maxChatChars: 1000,
  maxSpeakChars: 500,

  // 복약 일정 입력 한계 (팀원 FastAPI 스키마의 max_length를 그대로 가져왔다)
  maxMedicineNameChars: 100,
  maxMedicationNotesChars: 1000,
  // 반복 등록은 행을 미리 펼쳐 두므로 상한이 곧 한 번에 만들어지는 행 수다
  maxRepeatDays: 30,

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
  if (config.dbDriver === 'pg' && !config.databaseUrl) {
    lines.push('⚠️  DB_DRIVER=pg 인데 DATABASE_URL 미설정 → 첫 DB 접근에서 서버가 죽습니다');
    lines.push('   postgres://사용자:비밀번호@호스트:5432/DB이름 형식으로 설정하세요');
  }
  if (!['sqlite', 'pg'].includes(config.dbDriver)) {
    lines.push(`⚠️  DB_DRIVER="${config.dbDriver}"는 알 수 없는 값 → sqlite로 조용히 동작합니다 (오타 확인)`);
  }
  if (config.snapshotStorage === 's3' && !config.s3Bucket) {
    lines.push('⚠️  SNAPSHOT_STORAGE=s3 인데 S3_BUCKET 미설정 → 스냅샷 저장이 실패합니다');
  }
  if (!['local', 's3'].includes(config.snapshotStorage)) {
    lines.push(`⚠️  SNAPSHOT_STORAGE="${config.snapshotStorage}"는 알 수 없는 값 → local로 조용히 동작합니다 (오타 확인)`);
  }
  return lines;
}

module.exports = { config, describeStartup };
