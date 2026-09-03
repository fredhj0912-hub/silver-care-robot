import { test, expect } from 'vitest';
import { createVadState, feedEnergy, resetSpeech, DEFAULTS } from '../src/lib/vad';

/**
 * VAD가 발화 경계를 잘못 잡으면 두 방향으로 나빠진다 —
 * 너무 민감하면 방 안의 모든 소리가 Gemini로 올라가고,
 * 너무 둔하면 어르신이 말을 걸어도 로봇이 아예 못 듣는다.
 *
 * 오디오 없이 RMS 숫자열만 먹여서 확인한다. 상태기계를 순수 함수로 분리한 이유다.
 */

const FRAME = 256;   // 4096 샘플 @ 16kHz = 256ms (실제 프레임 길이와 같게 둔다)

/** 같은 에너지를 n프레임 먹이고 판정들을 모아 돌려준다 */
function feed(state, energy, frames) {
  const out = [];
  for (let i = 0; i < frames; i++) out.push(feedEnergy(state, energy, FRAME));
  return out;
}

const LOUD = DEFAULTS.startThreshold * 2;
const QUIET = DEFAULTS.endThreshold / 2;

test('조용하면 아무 일도 일어나지 않는다', () => {
  const s = createVadState();
  expect(feed(s, QUIET, 20)).toEqual(Array(20).fill('idle'));
});

test('임계값을 넘는 첫 프레임에서 발화가 시작된다', () => {
  const s = createVadState();
  expect(feedEnergy(s, LOUD, FRAME)).toBe('started');
  expect(feedEnergy(s, LOUD, FRAME)).toBe('speaking');
});

test('충분히 말한 뒤 조용해지면 발화가 끝난다', () => {
  const s = createVadState();
  feed(s, LOUD, 4);                                    // 1024ms 발화
  const tail = feed(s, QUIET, 10);                     // 침묵
  expect(tail).toContain('ended');
  // 끝난 뒤에는 다시 처음 상태다
  expect(feedEnergy(s, QUIET, FRAME)).toBe('idle');
});

test('침묵이 짧으면 아직 끝난 것이 아니다 — 문장 중간의 숨을 자르지 않는다', () => {
  const s = createVadState();
  feed(s, LOUD, 4);
  // silenceMs(900) 미만이면 계속 말하는 중으로 본다
  const pause = feed(s, QUIET, 3);                     // 768ms
  expect(pause).not.toContain('ended');
  expect(feedEnergy(s, LOUD, FRAME)).toBe('speaking');  // 다시 말을 이었다
});

test('너무 짧은 소리는 버린다 — 기침·문 닫는 소리를 Gemini로 보내지 않는다', () => {
  const s = createVadState();
  feedEnergy(s, LOUD, FRAME);                          // 256ms < minSpeechMs(400)
  const tail = feed(s, QUIET, 10);
  expect(tail).toContain('discarded');
  expect(tail).not.toContain('ended');
});

test('최소 길이 판정은 침묵 구간을 빼고 센다', () => {
  // 이 검사가 없으면 silenceMs(900ms)만으로도 minSpeechMs(400ms)를 넘겨 버려서
  // "너무 짧은 소리 버리기"가 아무것도 걸러내지 못한다.
  const s = createVadState({ minSpeechMs: 600 });
  feedEnergy(s, LOUD, FRAME);                          // 실제로 소리난 것은 256ms뿐
  const tail = feed(s, QUIET, 10);
  expect(tail).toContain('discarded');
});

test('히스테리시스: 끝 임계값은 시작보다 낮다 — 한 문장이 토막나지 않게', () => {
  expect(DEFAULTS.endThreshold).toBeLessThan(DEFAULTS.startThreshold);
  const s = createVadState();
  feedEnergy(s, LOUD, FRAME);
  // 시작 임계값 아래지만 끝 임계값 위인 소리 — 말이 이어지는 것으로 본다
  const between = (DEFAULTS.startThreshold + DEFAULTS.endThreshold) / 2;
  expect(feedEnergy(s, between, FRAME)).toBe('speaking');
});

test('상한을 넘으면 조용해지길 기다리지 않고 끊는다', () => {
  const s = createVadState({ maxSpeechMs: 1000 });
  const out = feed(s, LOUD, 10);                       // 계속 시끄러운 상태
  expect(out).toContain('ended');
  // 상한까지 갔으면 길이는 충분하므로 버리지 않는다
  expect(out).not.toContain('discarded');
  expect(out.indexOf('ended')).toBe(3);                // 0번 프레임부터 세서 256×4 = 1024ms ≥ 1000ms
});

test('resetSpeech: 말하던 중을 취소한다 (로봇이 말하기 시작할 때)', () => {
  const s = createVadState();
  feed(s, LOUD, 3);
  resetSpeech(s);
  expect(s.speaking).toBe(false);
  // 취소 뒤 첫 소리는 다시 'started'여야 한다 — 이어붙이면 로봇 목소리가 섞인다
  expect(feedEnergy(s, LOUD, FRAME)).toBe('started');
});

test('옵션으로 임계값을 바꿀 수 있다', () => {
  const s = createVadState({ startThreshold: 0.5 });
  expect(feedEnergy(s, 0.3, FRAME)).toBe('idle');      // 기본값이면 started 였을 값
  expect(feedEnergy(s, 0.6, FRAME)).toBe('started');
});
