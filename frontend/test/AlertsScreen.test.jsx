import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import AlertsScreen from '../src/guardian/screens/AlertsScreen';

/**
 * 알림 이력 화면. usePagedList가 실제로 /api/alerts를 읽고,
 * 해제 버튼이 미해결 알림에만 붙는지를 확인한다 — 이미 확인한 알림에
 * 버튼이 남아 있으면 보호자가 같은 알림을 두 번 처리했다고 착각한다.
 */

const alert = (over = {}) => ({
  id: 'a1',
  type: 'fall_detected',
  severity: 'critical',
  description: '어르신이 넘어지신 것 같아요',
  timestamp: '2026-08-29T10:05:00.000Z',
  resolved: false,
  ...over,
});

let calls;
let alerts;

/** GET /api/alerts는 현재 `alerts` 배열을, resolve POST는 빈 응답을 준다. */
function stubFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).includes('/api/alerts/resolve')) {
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ alerts, nextCursor: null }) };
  }));
}

const renderAlerts = (props) =>
  render(
    <MemoryRouter>
      <AlertsScreen {...props} />
    </MemoryRouter>
  );

beforeEach(stubFetch);
afterEach(() => vi.unstubAllGlobals());

test('알림이 하나도 없으면 별일 없다는 뜻으로 안내한다', async () => {
  alerts = [];
  renderAlerts();
  expect(await screen.findByText(/아직 알림이 없어요/)).toBeInTheDocument();
});

test('확인한 알림엔 버튼 대신 처리 이력이, 미확인 알림엔 해제 버튼이 붙는다', async () => {
  alerts = [
    alert({ id: 'open-1' }),
    alert({
      id: 'done-1',
      type: 'manual_panic_button',
      resolved: true,
      resolvedAt: '2026-08-29T10:10:00.000Z',
      resolvedBy: 'guardian',
    }),
  ];
  renderAlerts();

  expect(await screen.findByText('낙상 감지')).toBeInTheDocument();
  expect(screen.getByText('SOS 버튼')).toBeInTheDocument();

  // 해제 버튼은 미해결 1건에만.
  expect(screen.getAllByRole('button', { name: '확인했어요' })).toHaveLength(1);
  expect(screen.getByText(/확인함 .* \(보호자\)/)).toBeInTheDocument();
});

test('"확인했어요"가 해제 요청을 보내고 목록을 다시 읽으며 상위에 알린다', async () => {
  alerts = [alert({ id: 'open-1' })];
  const onChange = vi.fn();
  renderAlerts({ onChange });

  await screen.findByRole('button', { name: '확인했어요' });
  const listReadsBefore = calls.filter((c) => !String(c.url).includes('/resolve')).length;

  await userEvent.click(screen.getByRole('button', { name: '확인했어요' }));

  const resolve = calls.find((c) => String(c.url).includes('/api/alerts/resolve'));
  expect(resolve).toBeDefined();
  expect(resolve.options.method).toBe('POST');
  expect(JSON.parse(resolve.options.body)).toEqual({ id: 'open-1', by: 'guardian' });

  // 해제 후 목록을 다시 읽어야 화면이 방금 처리한 알림을 확인함으로 바꾼다.
  await waitFor(() =>
    expect(calls.filter((c) => !String(c.url).includes('/resolve')).length)
      .toBeGreaterThan(listReadsBefore)
  );
  await waitFor(() => expect(onChange).toHaveBeenCalled());
});
