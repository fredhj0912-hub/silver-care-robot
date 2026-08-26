const test = require('node:test');
const assert = require('node:assert');
const { pcmToWav } = require('../src/services/tts');

/**
 * Gemini TTS는 헤더 없는 raw PCM을 준다. WAV 헤더가 한 바이트라도 틀리면
 * 브라우저가 재생을 거부하고 어르신은 아무 소리도 듣지 못한다.
 */
test('PCM에 올바른 WAV 헤더를 붙인다', () => {
  const pcm = Buffer.alloc(1000, 7);
  const wav = pcmToWav(pcm, 24000, 1, 16);

  assert.strictEqual(wav.length, pcm.length + 44, 'WAV 헤더는 44바이트여야 한다');
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(wav.toString('ascii', 12, 16), 'fmt ');
  assert.strictEqual(wav.toString('ascii', 36, 40), 'data');

  assert.strictEqual(wav.readUInt32LE(4), 36 + pcm.length, 'RIFF 청크 크기');
  assert.strictEqual(wav.readUInt16LE(20), 1, 'PCM 포맷 코드');
  assert.strictEqual(wav.readUInt16LE(22), 1, '채널 수');
  assert.strictEqual(wav.readUInt32LE(24), 24000, '샘플레이트');
  assert.strictEqual(wav.readUInt32LE(28), 48000, '바이트레이트 = 24000 * 1 * 16/8');
  assert.strictEqual(wav.readUInt16LE(32), 2, '블록 정렬 = 채널 * 비트/8');
  assert.strictEqual(wav.readUInt16LE(34), 16, '비트 심도');
  assert.strictEqual(wav.readUInt32LE(40), pcm.length, 'data 청크 크기');

  assert.ok(wav.subarray(44).equals(pcm), 'PCM 본문이 그대로 보존되어야 한다');
});

test('스테레오/다른 샘플레이트도 헤더가 맞는다', () => {
  const wav = pcmToWav(Buffer.alloc(400), 48000, 2, 16);
  assert.strictEqual(wav.readUInt32LE(24), 48000);
  assert.strictEqual(wav.readUInt16LE(22), 2);
  assert.strictEqual(wav.readUInt32LE(28), 48000 * 2 * 2, '바이트레이트');
  assert.strictEqual(wav.readUInt16LE(32), 4, '블록 정렬');
});
