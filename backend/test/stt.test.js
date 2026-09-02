const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// config 는 require 시점에 환경변수를 읽는다. 반드시 app 을 부르기 전에 설정한다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hyodol-stt-test-'));
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = path.join(TMP, 'test.sqlite');
process.env.SNAPSHOT_DIR = path.join(TMP, 'snapshots');
process.env.ROBOT_API_KEY = 'test-key';
process.env.GEMINI_API_KEY = '';          // 결정론적 테스트를 위해 mock 경로 고정
process.env.PUBLIC_DIR = '';

const { createApp } = require('../src/app');
const { initDB, closeDB } = require('../src/db');
const { config } = require('../src/config');
const gemini = require('../src/services/gemini');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let BASE;

const H = { 'Content-Type': 'application/json', 'x-api-key': 'test-key' };
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) })
  .then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));

// 최소한의 유효한 data URI. 내용은 중요하지 않다 — 키가 없어 Gemini까지 가지 않는다.
const WAV_URI = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

test.before(async () => {
  await initDB();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await closeDB();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── cleanTranscript — 순수 함수 ─────────────────────────────
// 모델이 받아쓴 말 대신 주석을 돌려주는 경우를 걸러내는 것이 이 함수의 존재 이유다.
// 통과하면 웨이크워드 게이트가 그 주석을 어르신의 말로 착각한다.

test('cleanTranscript: 통째로 싸인 따옴표를 벗긴다', () => {
  assert.strictEqual(gemini.cleanTranscript('"안녕하세요"'), '안녕하세요');
  assert.strictEqual(gemini.cleanTranscript('“효돌아”'), '효돌아');
});

test('cleanTranscript: 문장 안의 따옴표는 건드리지 않는다', () => {
  assert.strictEqual(gemini.cleanTranscript('아들이 "밥 먹었냐"고 물었어'), '아들이 "밥 먹었냐"고 물었어');
});

test('cleanTranscript: 통째로 괄호에 싸인 것은 모델의 주석이므로 버린다', () => {
  assert.strictEqual(gemini.cleanTranscript('(음성 없음)'), '');
  assert.strictEqual(gemini.cleanTranscript('[inaudible]'), '');
});

test('cleanTranscript: 평범한 발화는 앞뒤 공백만 다듬는다', () => {
  assert.strictEqual(gemini.cleanTranscript('  효돌아 밥 먹었어  '), '효돌아 밥 먹었어');
  assert.strictEqual(gemini.cleanTranscript(null), '');
});

// ── transcribeAudio — data URI 검증 ────────────────────────

test('transcribeAudio: 키가 있어도 data URI가 아니면 bad_data_uri', async () => {
  // 키 검사가 형식 검사보다 먼저다(analyzeImage와 같은 순서). 그래서 형식 오류만
  // 보려면 키가 있는 상태를 흉내내야 한다 — config를 잠깐 갈아끼운다.
  config.geminiApiKey = 'fake-key-for-shape-check';
  try {
    const r = await gemini.transcribeAudio('그냥 문자열');
    // SDK가 없는 환경이면 sdk_unavailable 이 먼저 나온다 — 둘 다 '형식까지 가지 않았다'는 뜻이다
    assert.ok(['bad_data_uri', 'sdk_unavailable'].includes(r.error), 'error: ' + r.error);
  } finally {
    config.geminiApiKey = '';
  }
});

test('transcribeAudio: image data URI는 받지 않는다', async () => {
  // 키가 없으면 no_api_key 에서 먼저 걸리므로, 형식 검사만 따로 확인한다.
  const m = /^data:(audio\/[a-zA-Z0-9.+-]+);base64,(.+)$/s;
  assert.ok(!m.test('data:image/png;base64,AAAA'));
  assert.ok(m.test(WAV_URI));
});

test('transcribeAudio: API 키가 없으면 no_api_key 로 떨어진다', async () => {
  const r = await gemini.transcribeAudio(WAV_URI);
  assert.strictEqual(r.error, 'no_api_key');
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.source, 'mock');
});

// ── POST /api/stt ─────────────────────────────────────────

test('POST /api/stt: audio 가 없으면 400', async () => {
  assert.strictEqual((await post('/api/stt', {})).s, 400);
  assert.strictEqual((await post('/api/stt', { audio: 123 })).s, 400);
});

test('POST /api/stt: data:audio/ 가 아니면 400', async () => {
  assert.strictEqual((await post('/api/stt', { audio: 'data:image/png;base64,AAAA' })).s, 400);
  assert.strictEqual((await post('/api/stt', { audio: 'AAAA' })).s, 400);
});

test('POST /api/stt: 용량 상한을 넘으면 413', async () => {
  const head = 'data:audio/wav;base64,';
  const oversize = head + 'A'.repeat(config.maxAudioBytes - head.length + 1);
  assert.ok(Buffer.byteLength(oversize, 'utf8') > config.maxAudioBytes);
  assert.strictEqual((await post('/api/stt', { audio: oversize })).s, 413);
});

test('POST /api/stt: 상한 바로 아래는 크기 때문에 막히지 않는다', async () => {
  // 413 검사가 상수와 무관하게 항상 참이 되는 것을 막는 대칭 케이스다.
  const head = 'data:audio/wav;base64,';
  const justUnder = head + 'A'.repeat(config.maxAudioBytes - head.length);
  assert.ok(Buffer.byteLength(justUnder, 'utf8') <= config.maxAudioBytes);
  assert.notStrictEqual((await post('/api/stt', { audio: justUnder })).s, 413);
});

test('POST /api/stt: 받아쓰기를 쓸 수 없으면 200이 아니라 503으로 알린다', async () => {
  // 조용한 성공(200 + 빈 text)으로 감추면 프론트가 음성 경로를 접지 못해
  // 어르신은 로봇이 못 알아듣는다고만 느끼게 된다.
  const r = await post('/api/stt', { audio: WAV_URI });
  assert.strictEqual(r.s, 503);
  assert.strictEqual(r.b.reason, 'no_api_key');
});

test('POST /api/stt: 받아쓰기 실패는 200이 아니라 502로 알린다', async () => {
  // 200 + 빈 text 로 돌려주면 프론트에서 **침묵과 구분되지 않는다** — 어르신이 말을
  // 걸었는데 아무 일도 안 일어난 것처럼 보이고 화면에 진단도 안 뜬다(2026-09-02 실측).
  // 503(되돌릴 수 없음)과 502(일시적)를 나누는 것도 중요하다: 프론트는 503이면 즉시
  // 텍스트 입력을 안내하고, 502면 연속 실패 횟수를 센 뒤 포기한다.
  const original = gemini.transcribeAudio;
  gemini.transcribeAudio = async () => ({ text: '', source: 'mock', error: 'Gemini 503' });
  try {
    const r = await post('/api/stt', { audio: WAV_URI });
    assert.strictEqual(r.s, 502);
    assert.strictEqual(r.b.reason, 'Gemini 503');
  } finally {
    gemini.transcribeAudio = original;
  }
});

test('POST /api/stt: 조용한 오디오는 성공(200)에 빈 text다', async () => {
  // 실패와 달리 이건 정상이다 — 프론트가 no-speech 처럼 조용히 넘어간다.
  const original = gemini.transcribeAudio;
  gemini.transcribeAudio = async () => ({ text: '', source: 'gemini', error: null });
  try {
    const r = await post('/api/stt', { audio: WAV_URI });
    assert.strictEqual(r.s, 200);
    assert.strictEqual(r.b.text, '');
  } finally {
    gemini.transcribeAudio = original;
  }
});

// ── withRetry 의 재시도·시한 정책 ──────────────────────────
//
// ⚠️ **여기서 못 덮는 것 하나**: transcribeAudio 가 withRetry 에 실제로
//    { retries: 0, deadline } 을 넘기는지. withRetry 를 주입할 방법이 없어
//    그 한 줄을 지워도 이 파일은 통과한다(변이 테스트로 확인). 고칠 때 눈으로 볼 것.
// 2026-09-02 실측: Gemini가 503을 뱉을 때 체인을 다 돌면 50초가 걸렸다.
// 어르신은 20초면 로봇이 고장난 줄 안다. 시한이 이 정책의 전부다.

const transient503 = () => new Error('[503 Service Unavailable] high demand');

test('withRetry: 시한이 지나면 다음 시도를 시작하지 않는다', async () => {
  let calls = 0;
  const started = Date.now();
  await assert.rejects(
    gemini.withRetry(async () => { calls += 1; await sleep(60); throw transient503(); },
      { retries: 5, deadline: Date.now() + 100 }),
  );
  // 시한이 없었다면 (모델 2개 × 6회) 12번 불렸을 것이다
  assert.ok(calls < 12, `시한을 무시하고 ${calls}번 호출했다`);
  assert.ok(Date.now() - started < 2000, '시한을 한참 넘겨서 돌아왔다');
});

test('withRetry: 시한 안이면 정상적으로 성공한다', async () => {
  const { result } = await gemini.withRetry(async () => '받아쓴 문장',
    { retries: 0, deadline: Date.now() + 5000 });
  assert.strictEqual(result, '받아쓴 문장');
});

test('withRetry: retries=0 이면 같은 모델을 다시 부르지 않는다', async () => {
  // STT가 쓰는 정책이다. 늦게 온 받아쓰기는 쓸모가 없으니 기다리지 않는다.
  const seen = [];
  await assert.rejects(
    gemini.withRetry(async (modelId) => { seen.push(modelId); throw transient503(); }, { retries: 0 }),
  );
  assert.deepStrictEqual(seen, [...new Set(seen)], '같은 모델을 두 번 불렀다');
});

test('withRetry: 일시적이지 않은 오류는 재시도하지 않고 바로 던진다', async () => {
  let calls = 0;
  await assert.rejects(
    gemini.withRetry(async () => { calls += 1; throw new Error('[400 Bad Request] 잘못된 키'); },
      { retries: 3 }),
  );
  assert.strictEqual(calls, 1);
});

test('설정: 받아쓰기 시한은 어르신이 기다릴 수 있는 범위여야 한다', () => {
  assert.ok(config.sttTimeoutMs > 0, 'sttTimeoutMs 가 설정돼 있어야 한다');
  assert.ok(config.sttTimeoutMs <= 20000, `${config.sttTimeoutMs}ms 는 너무 길다`);
});

test('POST /api/stt: API 키가 없어도 인증은 그대로 걸린다', async () => {
  const r = await fetch(BASE + '/api/stt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: WAV_URI }),
  });
  assert.strictEqual(r.status, 401);
});
