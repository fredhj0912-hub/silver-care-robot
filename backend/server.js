/**
 * 효돌이 백엔드 진입점.
 * 라우트/서비스/저장소 구현은 src/ 아래에 있다.
 */
const { createApp } = require('./src/app');
const { config, describeStartup } = require('./src/config');
const { getDB, closeDB } = require('./src/db');
const messagesRepo = require('./src/repositories/messages');
const history = require('./src/services/history');
const gemini = require('./src/services/gemini');
const tts = require('./src/services/tts');

getDB(); // 스키마 적용 + 상태 행 보장

let server = null;

function shutdown(signal) {
  console.log(`\n${signal} 수신 — 서버를 정리하고 종료합니다`);
  if (server) {
    server.close(() => {
      closeDB();
      process.exit(0);
    });
  }
  // 열린 SSE 연결이 닫히지 않아도 강제로 내려간다
  setTimeout(() => { closeDB(); process.exit(0); }, 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// CommonJS는 top-level await를 지원하지 않는다. 리포지토리가 async가 되면서
// 히스토리 복원이 Promise를 반환하므로 async IIFE로 감싼다.
(async () => {
  // 재시작해도 어르신과의 대화 맥락이 이어지도록 최근 대화를 복원한다.
  // 이전에는 히스토리가 프로세스 메모리에만 있어 재시작 시 통째로 사라졌다.
  // 복원을 기다린 뒤에 listen 한다 — 서버가 뜬 직후 들어온 첫 대화가 복원 전
  // 히스토리를 보면 맥락이 끊긴다.
  const restored = history.restoreFrom(await messagesRepo.recentAscending(config.maxHistoryTurns * 2));

  server = createApp().listen(config.port, '0.0.0.0', () => {
    console.log('\n======================================================');
    console.log('🤖 효돌이 백엔드 서버 실행 중');
    console.log(`   URL:      http://0.0.0.0:${config.port}`);
    console.log(`   Database: ${config.dbPath}`);
    console.log(`   Gemini:   ${gemini.isAvailable() ? `사용 가능 (${config.geminiModel})` : '사용 불가 → mock 대화'}`);
    console.log(`   TTS:      ${tts.isEnabled() ? `${config.ttsProvider} / ${config.ttsVoice}` : '브라우저 SpeechSynthesis'}`);
    console.log(`   히스토리:  최근 대화 ${restored}개 복원됨`);
    for (const line of describeStartup()) console.log(`   ${line}`);
    console.log('======================================================\n');
  });
})().catch((err) => {
  // 부팅 실패를 unhandled rejection으로 흘리면 원인이 안 보이는 채로 죽는다.
  console.error('서버 시작 실패:', err.stack || err);
  closeDB();
  process.exit(1);
});
