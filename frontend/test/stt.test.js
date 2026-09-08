import { test, expect } from 'vitest';
import { classifySttError, FATAL_STT_ERRORS } from '../src/lib/stt';

/**
 * 오류 분류가 틀리면 증상이 정반대로 나온다.
 *  - 되돌릴 수 없는 오류를 transient로 보면 → 영원히 재시작만 반복하고 화면은 "듣고 있어요"
 *  - 일시적 오류를 fatal로 보면 → 한 번 끊겼다고 음성 대화를 영구히 포기한다
 */

test('침묵과 우리가 직접 멈춘 것은 오류가 아니다', () => {
  expect(classifySttError('no-speech')).toBe('ignorable');
  expect(classifySttError('aborted')).toBe('ignorable');
  expect(classifySttError(undefined)).toBe('ignorable');
});

test('권한·장치·서비스 문제는 다시 시도해도 같으므로 fatal이다', () => {
  for (const err of FATAL_STT_ERRORS) {
    expect(classifySttError(err)).toBe('fatal');
  }
});

test("'network'는 fatal이 아니라 transient다", () => {
  // 진짜 일시적 끊김일 수 있다. 다만 구글 음성 키 없이 빌드된 Chromium은 매번 이걸 내므로
  // 호출부가 연속 횟수를 세서 판단한다 — 여기서 fatal로 못 박으면 그 구분이 사라진다.
  expect(classifySttError('network')).toBe('transient');
});

test('모르는 오류는 일단 transient로 둔다', () => {
  expect(classifySttError('그런-오류-없음')).toBe('transient');
});
