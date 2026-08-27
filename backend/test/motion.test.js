const test = require('node:test');
const assert = require('node:assert');
const motion = require('../src/services/motion');

/**
 * services/motion.js 는 원격조종 안전장치(데드맨 스위치)를 담당한다 — 지금까지
 * curl 수동 검증만 했고 자동 테스트가 없었다. 데드맨 타이머가 durationMs보다 먼저
 * 끝나 이동 중 로봇이 멈춰버리는 회귀(2026-08-27 수정)를 특히 잡아야 한다.
 */

test.afterEach(() => {
  motion.stop(); // 다음 테스트로 데드맨 타이머가 새지 않도록 정리
});

test('알 수 없는 방향은 에러를 던진다', () => {
  assert.throws(() => motion.move({ direction: 'diagonal' }));
});

test('데드맨 스위치: 다음 명령 없이 DEADMAN_MS가 지나면 자동 정지된다', async () => {
  const state = motion.move({ direction: 'up', speed: 50, durationMs: 100 });
  assert.strictEqual(state.moving, true);

  await new Promise((r) => setTimeout(r, motion.DEADMAN_MS + 100));
  assert.strictEqual(motion.getState().moving, false);
});

test('durationMs가 DEADMAN_MS보다 길면 그 전에 자동 정지되지 않는다 (회귀)', async () => {
  const durationMs = motion.DEADMAN_MS + 400;
  motion.move({ direction: 'right', speed: 50, durationMs });

  // DEADMAN_MS는 지났지만 durationMs는 아직 안 지난 시점 — 예전 버그는 여기서 멈췄다.
  await new Promise((r) => setTimeout(r, motion.DEADMAN_MS + 100));
  assert.strictEqual(motion.getState().moving, true, 'durationMs가 끝나기 전에 멈췄다');

  // durationMs까지 마저 지나면 데드맨이 정상적으로 정지시킨다.
  await new Promise((r) => setTimeout(r, durationMs - motion.DEADMAN_MS));
  assert.strictEqual(motion.getState().moving, false);
});

test('stop()은 즉시 정지하고 데드맨 타이머를 취소한다', () => {
  motion.move({ direction: 'down', speed: 50, durationMs: 100 });
  const state = motion.stop();
  assert.strictEqual(state.moving, false);
  assert.strictEqual(state.direction, null);
});
