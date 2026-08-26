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

// 재시작해도 어르신과의 대화 맥락이 이어지도록 최근 대화를 복원한다.
// 이전에는 히스토리가 프로세스 메모리에만 있어 재시작 시 통째로 사라졌다.
const restored = history.restoreFrom(messagesRepo.recentAscending(config.maxHistoryTurns * 2));

const server = createApp().listen(config.port, '0.0.0.0', () => {
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

function shutdown(signal) {
  console.log(`\n${signal} 수신 — 서버를 정리하고 종료합니다`);
  server.close(() => {
    closeDB();
    process.exit(0);
  });
  // 열린 SSE 연결이 닫히지 않아도 강제로 내려간다
  setTimeout(() => { closeDB(); process.exit(0); }, 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
