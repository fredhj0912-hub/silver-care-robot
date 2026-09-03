import { test, expect } from 'vitest';
import { readVadDebug } from '../src/lib/vad-debug';

test('파라미터가 없으면 꺼져 있고 덮어쓸 값도 없다', () => {
  expect(readVadDebug('')).toEqual({ enabled: false, vadOptions: {} });
});

test('?vad=1 이면 켜진다', () => {
  expect(readVadDebug('?vad=1').enabled).toBe(true);
  // 다른 값으로는 켜지지 않는다 — 오타로 어르신 화면에 오버레이가 뜨면 안 된다
  expect(readVadDebug('?vad=0').enabled).toBe(false);
  expect(readVadDebug('?vad=true').enabled).toBe(false);
});

test('임계값을 숫자로 넘긴다', () => {
  expect(readVadDebug('?vad=1&vadstart=0.01&vadend=0.006&vadsilence=600').vadOptions)
    .toEqual({ startThreshold: 0.01, endThreshold: 0.006, silenceMs: 600 });
});

test('숫자가 아니면 통째로 무시한다', () => {
  // NaN이 DEFAULTS를 덮으면 모든 비교가 false가 되어 VAD가 발화를 영영 못 잡는다.
  // 파이 앞에서 오타 하나로 마이크가 죽는 것이 이 가드가 막는 상황이다.
  expect(readVadDebug('?vadstart=abc&vadend=').vadOptions).toEqual({});
});

test('오버레이를 켜지 않아도 임계값은 적용된다', () => {
  // 현장에서 확정한 값을 실제 받아쓰기(업로드 켠 상태)로 검증할 때 쓴다.
  expect(readVadDebug('?vadstart=0.01')).toEqual({ enabled: false, vadOptions: { startThreshold: 0.01 } });
});
