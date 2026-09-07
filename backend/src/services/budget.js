const { config } = require('../config');
const usageRepo = require('../repositories/usage');

/**
 * Gemini 하루 예산 상한.
 *
 * 이게 없던 2026-09-06까지 서버에는 **어떤 종류의 호출 상한도 없었다.** 할당량 소진은
 * 429 문자열을 정규식으로 알아채는 사후 감지(gemini.js 의 QUOTA_EXHAUSTED)뿐이었고,
 * 잡음 몇 번이면 하루치가 사라졌다(09-02 에 한 시간에 100건을 태웠다).
 *
 * 무료 등급에서는 "통을 다 쓰기 전에 우리가 먼저 멈추는" 장치이고,
 * **결제를 켜면 그대로 요금 상한**이 된다 — 상한이 없으면 상한선은 카드 한도다.
 *
 * 넘었을 때 하는 일은 새 폴백을 만드는 것이 아니라 **던지는 것**이다. gemini.js 와
 * tts.js 에는 이미 실패를 mock/204 로 떨어뜨리는 경로가 있으므로 거기에 얹는다.
 */

const BUCKETS = {
  // 대화·받아쓰기·표정(Vision)은 **같은 모델 통**을 쓴다. 셋을 따로 세면 합계가
  // 실제 한도를 넘는 순간을 못 잡는다.
  text: () => config.geminiDailyBudget,
  // TTS 는 별도 모델이라 통도 따로다.
  tts: () => config.ttsDailyBudget,
};

/**
 * 오늘 날짜 — **미국 태평양 시각 기준 YYYY-MM-DD.**
 *
 * KST 가 아니다. 무료 등급의 할당량 리셋 경계가 PT 자정이라, 우리 카운터가 다른 경계를
 * 쓰면 하루 중 일부 구간에서 "우리는 여유 있는데 Google 은 이미 막는" 상태가 된다.
 * (routes/status.js 의 kstDateString() 이 같은 기법을 쓰지만 그건 보호자 화면용
 * 달력일이라 목적이 다르다 — 우연히 같은 방식일 뿐 공유하지 않는다.)
 */
const PT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' });
const today = (instant = new Date()) => PT.format(instant);

function exhausted(bucket, used, budget) {
  const err = new Error(`오늘 ${bucket} 예산을 다 썼습니다 (${used}/${budget})`);
  err.code = 'BUDGET_EXHAUSTED';
  return err;
}

const isExhausted = (err) => Boolean(err) && err.code === 'BUDGET_EXHAUSTED';

/**
 * 호출 **시도 한 번**을 예산에서 뺀다. 재시도와 대체 모델 전환도 Google 이 세는 실제
 * 요청이므로 똑같이 센다.
 *
 * 넘었으면 카운터를 올리지 않고 던진다 — 막힌 뒤에도 계속 올리면 숫자가 무한히 커져
 * 로그에서 "얼마나 넘었나"가 아니라 "몇 번 두드렸나"가 되어 버린다.
 */
async function consume(bucket) {
  const budget = BUCKETS[bucket]();

  const before = (await usageRepo.getDay(today()))[bucket] || 0;
  if (before >= budget) {
    console.warn(`[QUOTA] ${bucket} 예산 초과 — 호출하지 않고 mock 으로 떨어뜨립니다 (${before}/${budget})`);
    throw exhausted(bucket, before, budget);
  }

  const used = await usageRepo.increment(today(), bucket);
  console.log(`[QUOTA] ${bucket} ${used}/${budget}`);
  return used;
}

/** GET /api/status 용. 화면에서 남은 예산이 보이게 하는 것이 목적이다. */
async function snapshot() {
  const day = today();
  const used = await usageRepo.getDay(day);
  return {
    day,
    text: { used: used.text || 0, budget: BUCKETS.text() },
    tts: { used: used.tts || 0, budget: BUCKETS.tts() },
  };
}

module.exports = { consume, snapshot, isExhausted, today };
