import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGuardianData } from '../src/lib/useGuardianData';

/**
 * 보호자 앱의 실시간 경로. 여기 걸린 단언은 두 가지를 지킨다 —
 * SSE가 조용히 죽었을 때 되살아나는가, 그리고 그 사이 화면이 보호자에게
 * 거짓 안내("연결 끊김")를 띄우지 않는가.
 */

const STATUS = { isEmergency: false, battery: 80, lastActive: '2026-08-31T01:00:00.000Z' };
const ALERT = { id: 'a1', type: 'fall_detected', severity: 'critical', resolved: false };

/** 테스트가 직접 이벤트를 발화할 수 있는 EventSource 대역. */
let sources;
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    sources.push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  close() { this.closed = true; }
  emit(type, data) {
    for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) });
  }
}

// fetch를 경로별로 분기해 가로챈다. api.js(apiFetch)는 실제 코드를 그대로 통과시킨다.
let fetchCount;
function stubFetch({ fail = false } = {}) {
  fetchCount = 0;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    fetchCount++;
    if (fail) throw new TypeError('Failed to fetch');
    const p = String(url);
    if (p.includes('/api/status')) return { ok: true, json: async () => STATUS };
    if (p.includes('/api/alerts')) return { ok: true, json: async () => ({ alerts: [] }) };
    return { ok: true, json: async () => ({ conversationTurns: 1, emotionCounts: {} }) };
  }));
}

beforeEach(() => {
  sources = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  stubFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('hello 이벤트를 받으면 상태와 미해결 알림이 화면에 반영된다', async () => {
  const { result } = renderHook(() => useGuardianData());

  act(() => sources[0].emit('hello', { status: STATUS, unresolvedAlerts: [ALERT] }));

  expect(result.current.status).toEqual(STATUS);
  expect(result.current.openAlerts).toHaveLength(1);
  expect(result.current.connected).toBe(true);
});

test('이벤트가 60초 넘게 없으면 정체로 보고 SSE를 새로 연다', async () => {
  vi.useFakeTimers();
  renderHook(() => useGuardianData());
  expect(sources).toHaveLength(1);

  // onerror 없이 소켓만 조용히 죽는 경우(모바일 PWA 백그라운드 전환 등)를 잡는
  // 유일한 신호가 이 정체 판정이다. 30초 간격 점검이므로 90초에 처음 걸린다.
  await act(async () => { await vi.advanceTimersByTimeAsync(90000); });

  expect(sources[0].closed).toBe(true);
  expect(sources).toHaveLength(2);
});

test('SSE가 정체돼도 폴백 폴링이 되는 동안에는 연결 끊김을 알리지 않는다', async () => {
  // 회귀 방지: 프록시가 SSE를 버퍼링하는 배포에서 화면이 멀쩡히 갱신되는데도
  // "실시간 연결이 끊겼어요"가 60초마다 깜빡였다.
  vi.useFakeTimers();
  const { result } = renderHook(() => useGuardianData());
  const before = fetchCount;

  await act(async () => { await vi.advanceTimersByTimeAsync(90000); });

  expect(fetchCount).toBeGreaterThan(before);   // 폴링으로 화면은 갱신되고 있다
  expect(result.current.connected).toBe(true);
  expect(result.current.status).toEqual(STATUS);
});

test('서버에 아예 닿지 못하면 연결 끊김을 알린다', async () => {
  stubFetch({ fail: true });
  const { result } = renderHook(() => useGuardianData());

  await waitFor(() => expect(result.current.connected).toBe(false));
});
