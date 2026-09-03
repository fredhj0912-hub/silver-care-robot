const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// config는 require 시점에 환경변수를 읽는다. 반드시 services/tts를 부르기 전에 설정한다.
// 임시 캐시를 안 쓰면 테스트가 **실제 캐시(backend/data/tts-cache)를 오염시킨다.**
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hyodol-tts-test-'));
process.env.TTS_CACHE_DIR = TMP;

const { pcmToWav, synthesize } = require('../src/services/tts');
// config는 require 시점에 값이 고정된 객체다 — 같은 참조를 mutate해야 tts.js가 읽는 값도 바뀐다.
const { config } = require('../src/config');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

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

// ──────────────────────────────────────────────
// 재시도 — 2026-09-02에 **503 한 번으로 로봇이 소리를 잃었다.**
// 합성이 실패하면 라우트가 204를 돌려주고 프론트가 브라우저 TTS로 넘어가는데,
// 파이의 브라우저 TTS는 무음이다. 여기서 포기하는 것은 어르신이 그 문장을
// **영영 못 듣는다**는 뜻이라, 재시도 횟수 자체가 안전 관련 숫자다.
// ──────────────────────────────────────────────

const OK_AUDIO = {
  candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('음성').toString('base64') } }] } }],
};

/** 준비한 응답을 순서대로 돌려주는 가짜 fetch. 호출 횟수를 센다. */
function stubFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const next = responses[calls.length] ?? responses[responses.length - 1];
    calls.push(url);
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      // 본문이 JSON이 아니면 진짜 fetch처럼 파싱에서 던진다 (503 게이트웨이 HTML)
      json: async () => {
        if (typeof next.body === 'string') throw new SyntaxError('Unexpected token <');
        return next.body;
      },
    };
  };
  return calls;
}

/** 테스트마다 다른 문장을 쓴다 — 같은 문장이면 앞 테스트의 캐시에 맞아 fetch가 0회가 된다. */
let seq = 0;
const uniqueText = () => `테스트 문장 ${++seq}`;

const realFetch = globalThis.fetch;
test.beforeEach(() => {
  config.ttsProvider = 'gemini';
  config.geminiApiKey = 'test-key';
  config.ttsRetries = 1;
  config.ttsRetryDelayMs = 0; // 테스트를 기다리게 하지 않는다
});
test.afterEach(() => { globalThis.fetch = realFetch; });

test('일시 오류(503)는 다시 시도해서 살려낸다', async () => {
  const calls = stubFetch([
    { status: 503, body: { error: { code: 503, message: 'The model is overloaded.' } } },
    { status: 200, body: OK_AUDIO },
  ]);

  const result = await synthesize(uniqueText());

  assert.ok(result, '두 번째 시도가 성공했으면 음성이 나와야 한다');
  assert.strictEqual(result.mime, 'audio/wav');
  assert.strictEqual(calls.length, 2, '503은 한 번 더 시도해야 한다');
});

test('503 본문이 JSON이 아니어도 재시도한다', async () => {
  // 게이트웨이가 HTML을 주면 예전 코드는 파싱 예외를 그대로 올려보냈고,
  // 그러면 **상태코드가 사라져** 재시도할 수 있는 오류인지 판단할 수 없었다.
  const calls = stubFetch([
    { status: 503, body: '<html>503 Service Unavailable</html>' },
    { status: 200, body: OK_AUDIO },
  ]);

  const result = await synthesize(uniqueText());

  assert.ok(result);
  assert.strictEqual(calls.length, 2, 'HTML 503도 일시 오류로 봐야 한다');
});

test('할당량이 바닥나면 다시 시도하지 않는다', async () => {
  // 429는 두 가지다. 분당 한도(잠시 후 풀린다)와 할당량 소진(오늘은 안 풀린다).
  // 후자를 재시도하면 **남은 통을 더 태운다** — 하루 20건짜리 통이다.
  const calls = stubFetch([{
    status: 429,
    body: { error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.' } },
  }]);

  await assert.rejects(() => synthesize(uniqueText()), /quota/i);
  assert.strictEqual(calls.length, 1, '할당량 소진은 한 번만 부르고 포기해야 한다');
});

test('Cloud TTS 미활성화(PERMISSION_DENIED)는 재시도 없이 안내 메시지를 남긴다', async () => {
  config.ttsProvider = 'cloud';
  const calls = stubFetch([{
    status: 403,
    body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'API not enabled' } },
  }]);

  await assert.rejects(() => synthesize(uniqueText()), /활성화/);
  assert.strictEqual(calls.length, 1, '재시도해도 API가 활성화되지는 않는다');
});

test('재시도 상한을 넘으면 포기한다', async () => {
  const calls = stubFetch([{ status: 503, body: { error: { code: 503, message: 'overloaded' } } }]);

  await assert.rejects(() => synthesize(uniqueText()));
  assert.strictEqual(calls.length, 2, 'ttsRetries=1 이면 최초 1회 + 재시도 1회');
});

test('TTS_RETRIES=0 은 재시도하지 말라는 뜻이다', async () => {
  config.ttsRetries = 0;
  const calls = stubFetch([{ status: 503, body: { error: { code: 503, message: 'overloaded' } } }]);

  await assert.rejects(() => synthesize(uniqueText()));
  assert.strictEqual(calls.length, 1, '0이 1로 둔갑하면 아낄 수 없는 할당량이 나간다');
});

test('캐시에 있으면 provider를 부르지 않는다', async () => {
  const text = uniqueText();
  const calls = stubFetch([{ status: 200, body: OK_AUDIO }]);

  const first = await synthesize(text);
  const second = await synthesize(text);

  assert.strictEqual(first.cached, false);
  assert.strictEqual(second.cached, true, '두 번째는 디스크 캐시에서 나와야 한다');
  assert.strictEqual(calls.length, 1, '캐시 히트는 할당량을 쓰지 않는다');
});

test('provider가 browser면 아예 합성하지 않는다', async () => {
  config.ttsProvider = 'browser';
  const calls = stubFetch([{ status: 200, body: OK_AUDIO }]);

  assert.strictEqual(await synthesize(uniqueText()), null, '프론트가 자체 TTS로 처리한다는 신호');
  assert.strictEqual(calls.length, 0);
});
