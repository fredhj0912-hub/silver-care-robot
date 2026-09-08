import { test, expect } from 'vitest';
import { encodeWav, wavToDataUri, rms } from '../src/lib/wav';

/**
 * WAV 인코더는 **Gemini가 실제로 읽을 수 있는 바이트**를 만들어야 한다.
 * 헤더가 한 필드라도 틀리면 증상은 "받아쓰기가 이상하다"가 아니라 400/빈 응답이라
 * 원인을 파이에서 찾기 어렵다. 그래서 바이트 단위로 확인한다.
 */

const ascii = (view, at, len) =>
  Array.from({ length: len }, (_, i) => String.fromCharCode(view.getUint8(at + i))).join('');

test('44바이트 RIFF/WAVE 헤더를 규격대로 쓴다', () => {
  const samples = new Float32Array(100);
  const view = new DataView(encodeWav(samples, 16000));

  expect(ascii(view, 0, 4)).toBe('RIFF');
  expect(ascii(view, 8, 4)).toBe('WAVE');
  expect(ascii(view, 12, 4)).toBe('fmt ');
  expect(ascii(view, 36, 4)).toBe('data');

  expect(view.getUint32(16, true)).toBe(16);          // fmt 청크 길이
  expect(view.getUint16(20, true)).toBe(1);           // 1 = PCM (압축 없음)
  expect(view.getUint16(22, true)).toBe(1);           // 모노
  expect(view.getUint32(24, true)).toBe(16000);       // sampleRate
  expect(view.getUint32(28, true)).toBe(16000 * 2);   // byteRate = rate × 채널 × 바이트/샘플
  expect(view.getUint16(32, true)).toBe(2);           // blockAlign
  expect(view.getUint16(34, true)).toBe(16);          // bits
});

test('길이 필드가 실제 데이터 크기와 맞는다', () => {
  const samples = new Float32Array(1000);
  const buffer = encodeWav(samples, 16000);
  const view = new DataView(buffer);

  expect(buffer.byteLength).toBe(44 + 2000);
  expect(view.getUint32(40, true)).toBe(2000);        // data 청크 크기
  expect(view.getUint32(4, true)).toBe(36 + 2000);    // RIFF 크기 = 전체 - 8
});

test('sampleRate가 바뀌면 헤더도 따라 바뀐다', () => {
  const view = new DataView(encodeWav(new Float32Array(10), 48000));
  expect(view.getUint32(24, true)).toBe(48000);
  expect(view.getUint32(28, true)).toBe(48000 * 2);
});

test('Float32를 16bit 정수로 옮긴다', () => {
  const view = new DataView(encodeWav(Float32Array.from([0, 1, -1, 0.5]), 16000));
  expect(view.getInt16(44, true)).toBe(0);
  expect(view.getInt16(46, true)).toBe(32767);
  expect(view.getInt16(48, true)).toBe(-32768);
  expect(view.getInt16(50, true)).toBe(Math.trunc(0.5 * 32767));  // setInt16은 절삭한다
});

test('범위를 벗어난 값은 잘라낸다', () => {
  // 클리핑이 없으면 정수가 겹쳐서(wrap) 큰 소리가 잡음으로 뭉개진다.
  const view = new DataView(encodeWav(Float32Array.from([3.5, -3.5]), 16000));
  expect(view.getInt16(44, true)).toBe(32767);
  expect(view.getInt16(46, true)).toBe(-32768);
});

test('data URI는 백엔드가 받는 형식이다', () => {
  const uri = wavToDataUri(encodeWav(new Float32Array(10), 16000));
  // backend/src/routes/stt.js 의 검사식과 같은 조건이어야 한다
  expect(uri).toMatch(/^data:audio\/wav;base64,/);
  expect(() => atob(uri.split(',')[1])).not.toThrow();
});

test('긴 발화도 base64로 변환된다 (인자 수 한계에 걸리지 않는다)', () => {
  // 10초 발화면 샘플이 16만 개다. String.fromCharCode(...bytes)를 통째로 하면
  // 인자 수가 스택 한계를 넘어 터진다 — 조각내는 이유가 이것이다.
  const uri = wavToDataUri(encodeWav(new Float32Array(160000), 16000));
  expect(atob(uri.split(',')[1]).length).toBe(44 + 320000);
});

test('rms: 무음은 0, 진폭이 클수록 크다', () => {
  expect(rms(new Float32Array(100))).toBe(0);
  expect(rms(new Float32Array([]))).toBe(0);
  expect(rms(Float32Array.from([1, -1, 1, -1]))).toBe(1);
  expect(rms(Float32Array.from([0.5, -0.5]))).toBeCloseTo(0.5);
  expect(rms(Float32Array.from([0.3, -0.3]))).toBeLessThan(rms(Float32Array.from([0.6, -0.6])));
});
