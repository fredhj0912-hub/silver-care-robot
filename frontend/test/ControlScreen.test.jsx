import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import ControlScreen from '../src/guardian/screens/ControlScreen';

/**
 * 원격조종 — 꾹 누르기.
 *
 * 이 화면의 안전은 **손을 뗀 것을 놓치지 않는 것** 하나에 걸려 있다. 놓치면
 * 심박이 계속 나가고 로봇은 계속 간다. 그래서 여기서 확인하는 것은 "정지를 보내는가"가
 * 아니라 **"떼고 나서 더 이상 이동 명령이 나가지 않는가"** 다.
 *
 * `lib/api.js`는 목킹하지 않고 fetch만 스텁한다 (다른 화면 테스트와 같은 이유 —
 * API 키 스탬핑까지 실제 코드로 통과시킨다).
 */

let calls;

const stubFetch = (moveStatus = 200) => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET' });
    if (u.includes('/api/control/move')) {
      return { ok: moveStatus === 200, status: moveStatus, json: async () => ({ success: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ x: 0, y: 0, moving: false, direction: null }) };
  }));
};

const moves = () => calls.filter((c) => c.url.includes('/api/control/move'));
const stops = () => calls.filter((c) => c.url.includes('/api/control/stop'));

// 포인터 이벤트는 jsdom에 없어서 userEvent 대신 직접 만든다.
const pointer = (type, el) => act(() => {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  stubFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const up = () => screen.getByRole('button', { name: '⬆️' });

test('누르고 있는 동안 이동 명령이 반복해서 나간다', async () => {
  render(<ControlScreen isEmergency={false} />);

  pointer('pointerdown', up());
  expect(moves()).toHaveLength(1); // 누른 즉시 한 번

  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(moves().length).toBeGreaterThan(2); // 심박이 돌고 있다
});

test('손을 떼면 더 이상 이동 명령이 나가지 않는다', async () => {
  render(<ControlScreen isEmergency={false} />);

  pointer('pointerdown', up());
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });

  pointer('pointerup', up());
  expect(stops()).toHaveLength(1);

  // "아직 안 왔다"와 "영영 안 온다"를 가른다 — 뗀 뒤의 개수를 재고 시간을 크게 흘린다.
  const afterRelease = moves().length;
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(moves()).toHaveLength(afterRelease);
});

test('탭을 전환하면(폰 잠금) 누르고 있어도 멈춘다', async () => {
  render(<ControlScreen isEmergency={false} />);

  pointer('pointerdown', up());
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });

  // pointerup 없이 화면만 숨는 상황 — 폰을 잠그거나 앱을 전환하면 이렇게 된다
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });

  expect(stops()).toHaveLength(1);
  const afterHide = moves().length;
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(moves()).toHaveLength(afterHide);

  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

test('화면을 벗어나면(언마운트) 멈춘다', async () => {
  const { unmount } = render(<ControlScreen isEmergency={false} />);

  pointer('pointerdown', up());
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });

  const afterUnmountBase = moves().length;
  act(() => { unmount(); });

  expect(stops()).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(moves()).toHaveLength(afterUnmountBase);
});

test('응급 중에는 버튼이 잠기고 눌러도 명령이 안 나간다', async () => {
  render(<ControlScreen isEmergency />);

  expect(up()).toBeDisabled();
  pointer('pointerdown', up());
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  expect(moves()).toHaveLength(0);
});

test('423이면 응급 중이라는 것을 화면에 알린다', async () => {
  stubFetch(423);
  render(<ControlScreen isEmergency={false} />);

  pointer('pointerdown', up());
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });

  expect(screen.getByText(/응급 상황 중에는 원격 조종을 사용할 수 없어요/)).toBeInTheDocument();
});
