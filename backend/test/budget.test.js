const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// config 는 require 시점에 환경변수를 읽는다. 반드시 서비스를 부르기 전에 설정한다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hyodol-budget-test-'));
// .env에 DB_DRIVER=pg 가 설정돼 있어도 테스트가 실제 RDS를 치지 않게 고정한다.
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = path.join(TMP, 'test.sqlite');
process.env.SNAPSHOT_DIR = path.join(TMP, 'snapshots');
process.env.GEMINI_API_KEY = '';       // 어떤 경우에도 실제 Gemini 를 부르지 않는다
process.env.GEMINI_ENABLED = '0';      // 킬 스위치 켠 상태로 고정
process.env.GEMINI_DAILY_BUDGET = '2'; // 두 건이면 바닥나게
process.env.TTS_DAILY_BUDGET = '1';

const { initDB, closeDB, query } = require('../src/db');
const budget = require('../src/services/budget');
const usageRepo = require('../src/repositories/usage');
const gemini = require('../src/services/gemini');

test.before(async () => { await initDB(); });
test.after(async () => {
  await closeDB();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test.beforeEach(async () => { await query('DELETE FROM api_usage', []); });

test('날짜 경계는 태평양 시각이다 (KST 도 UTC 도 아니다)', () => {
  // 2026-09-07 05:00Z = PT 로는 아직 09-06 22시. 무료 등급 리셋 경계가 PT 자정이므로
  // 우리 카운터도 이때는 "어제"여야 실제 통과 어긋나지 않는다.
  assert.strictEqual(budget.today(new Date('2026-09-07T05:00:00Z')), '2026-09-06');
  // 같은 순간의 KST 는 09-07 14시라 날짜가 다르다 — 그 경계를 쓰면 안 된다는 확인
  assert.strictEqual(budget.today(new Date('2026-09-07T08:00:00Z')), '2026-09-07');
});

test('consume 은 시도마다 1건씩 올린다', async () => {
  assert.strictEqual(await budget.consume('text'), 1);
  assert.strictEqual(await budget.consume('text'), 2);
  assert.deepStrictEqual(await usageRepo.getDay(budget.today()), { text: 2 });
});

test('동시에 들어온 요청이 상한을 넘기지 못한다', async () => {
  // 읽기와 판단이 갈라져 있으면 둘 다 "아직 여유 있다"를 읽고 둘 다 올려 상한을 넘긴다.
  // 예산 2에 다섯을 한꺼번에 밀어 넣어도 성공은 정확히 2건이어야 한다.
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => budget.consume('text')));
  const ok = results.filter((r) => r.status === 'fulfilled');
  assert.strictEqual(ok.length, 2, '상한을 넘겨 통과했다');
  assert.deepStrictEqual(await usageRepo.getDay(budget.today()), { text: 2 });
});

test('예산이 0이면 첫 호출부터 막힌다', async () => {
  // 0("아무 호출도 하지 마라")에서 첫 INSERT 가 새면 상한이 상한이 아니다.
  assert.strictEqual(await usageRepo.incrementIfBelow(budget.today(), 'text', 0), null);
  assert.deepStrictEqual(await usageRepo.getDay(budget.today()), {});
});

test('text 와 tts 는 서로 다른 통이다', async () => {
  await budget.consume('text');
  await budget.consume('tts');
  const snap = await budget.snapshot();
  assert.deepStrictEqual(snap.text, { used: 1, budget: 2 });
  assert.deepStrictEqual(snap.tts, { used: 1, budget: 1 });
});

test('예산을 넘으면 BUDGET_EXHAUSTED 를 던지고, 그 뒤로는 카운터가 더 오르지 않는다', async () => {
  await budget.consume('tts');   // 예산 1 소진
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => budget.consume('tts'), (err) => {
      assert.strictEqual(err.code, 'BUDGET_EXHAUSTED');
      assert.ok(budget.isExhausted(err));
      return true;
    });
  }
  // 막힌 뒤에 계속 올리면 숫자가 "얼마나 넘었나"가 아니라 "몇 번 두드렸나"가 된다
  assert.deepStrictEqual(await usageRepo.getDay(budget.today()), { tts: 1 });
});

test('withRetry: 예산이 바닥나면 대체 모델까지 넘어가지 않고 즉시 던진다', async () => {
  let calls = 0;
  const call = async () => { calls++; return 'ok'; };

  assert.deepStrictEqual(await gemini.withRetry(call), { result: 'ok', modelUsed: 'gemini-3.6-flash' });
  await gemini.withRetry(call);                     // 예산 2 소진

  await assert.rejects(() => gemini.withRetry(call), (err) => err.code === 'BUDGET_EXHAUSTED');
  // 예산 초과가 transient 로 분류되면 여기서 모델 체인을 다 돌아 calls 가 늘어난다
  assert.strictEqual(calls, 2);
});

test('GEMINI_ENABLED=0 이면 호출 자체가 없어 카운터가 아예 안 오른다', async () => {
  const reply = await gemini.chat('안녕하세요');
  assert.strictEqual(reply.source, 'mock');
  assert.deepStrictEqual(await usageRepo.getDay(budget.today()), {});
});

/**
 * DB 장애는 "Gemini 실패"가 아니다.
 *
 * consume() 이 던지면 호출부의 catch 가 mock 폴백으로 삼켜서, RDS 가 끊긴 내내 로봇이
 * 통조림 답변만 하고 로그에는 "Gemini 호출 실패"로만 남는다 — 원인을 엉뚱한 데서 찾게 된다.
 * 예산은 비용을 막는 장치지 우리 DB 가 아플 때 어르신 앞의 로봇을 막는 장치가 아니다.
 */
test('사용량을 기록하지 못하면 막지 않고 통과시킨다 (fail-open)', async () => {
  const real = usageRepo.incrementIfBelow;
  usageRepo.incrementIfBelow = async () => { throw new Error('connection terminated unexpectedly'); };
  try {
    // 던지지 않는다 — 던지면 대화가 통째로 mock 으로 떨어진다
    assert.strictEqual(await budget.consume('text'), null);
  } finally {
    usageRepo.incrementIfBelow = real;
  }
});
