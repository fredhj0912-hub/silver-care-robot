#!/usr/bin/env node
/**
 * 자주 쓰는 문구를 미리 합성해 캐시에 넣는다.
 *
 *   npm run prewarm-tts
 *
 * 이 문구들(인사, 알림 해제, 되묻기, mock 응답)은 첫 사용부터 지연 0이 된다.
 * Gemini TTS처럼 느린 provider에서 특히 효과가 크다 — 문장당 5초를 아낀다.
 */
const { config } = require('../src/config');
const tts = require('../src/services/tts');

(async () => {
  console.log(`TTS provider: ${config.ttsProvider} / voice: ${config.ttsVoice}`);

  if (!tts.isEnabled()) {
    console.log(`\nprovider가 '${config.ttsProvider}'라 서버 합성을 하지 않습니다.`);
    console.log('서버 TTS를 쓰려면 backend/.env 에 다음을 추가하세요:');
    console.log('  TTS_PROVIDER=cloud     # 권장 — 지연 수백 ms');
    console.log('  TTS_PROVIDER=gemini    # 지금 키로 바로 되지만 문장당 약 5초');
    console.log('\ncloud를 쓰려면 콘솔에서 API 활성화가 한 번 필요합니다:');
    console.log('  https://console.cloud.google.com/apis/library/texttospeech.googleapis.com');
    return;
  }

  console.log(`문구 ${tts.COMMON_PHRASES.length}개 예열 중...\n`);
  const started = Date.now();
  const result = await tts.prewarm();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`✅ 완료 — 새로 생성 ${result.generated}개, 이미 캐시됨 ${result.cached}개 (${elapsed}초)`);
  console.log(`   캐시 위치: ${config.ttsCacheDir}`);

  if (result.failures.length) {
    console.log(`\n⚠️  실패 ${result.failures.length}건:`);
    for (const f of [...new Set(result.failures)]) console.log('   -', f);
  }
})();
