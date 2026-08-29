import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import HomeScreen from '../src/guardian/screens/HomeScreen';

/**
 * 보호자 홈 화면은 "엄마 괜찮으신가?"에 한 화면으로 답한다.
 * 여기 걸린 단언들은 전부 그 답이 틀리는 경로를 막는다 —
 * 특히 미해결 알림이 있는데 평상시 안부 쪽지가 뜨면 보호자가 응급을 놓친다.
 */

const STATUS = { isEmergency: false, lastActive: '2026-08-29T10:00:00.000Z', battery: 80 };
const SUMMARY = { conversationTurns: 3, emotionCounts: {} };

const alert = (over = {}) => ({
  id: 'a1',
  type: 'fall_detected',
  severity: 'critical',
  description: '어르신이 넘어지신 것 같아요',
  timestamp: '2026-08-29T10:05:00.000Z',
  resolved: false,
  ...over,
});

/** fetch를 경로별로 분기해 가로챈다. api.js(apiFetch/assetUrl)는 실제 코드를 그대로 통과시킨다. */
let calls;
function stubFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).includes('/api/messages')) {
      return { ok: true, json: async () => ({ messages: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

const renderHome = (props) =>
  render(
    <MemoryRouter>
      <HomeScreen
        status={STATUS}
        openAlerts={[]}
        summary={SUMMARY}
        connected
        refresh={() => {}}
        {...props}
      />
    </MemoryRouter>
  );

beforeEach(stubFetch);
afterEach(() => vi.unstubAllGlobals());

test('미해결 알림이 없으면 효돌이의 안부 쪽지를 보여준다', async () => {
  const { container } = renderHome();

  const note = container.querySelector('.g-note__body');
  expect(note).not.toBeNull();
  expect(note.textContent).toContain('오늘 어르신과 세 번 이야기를 나눴어요');
  expect(container.querySelector('.g-emergency')).toBeNull();

  await waitFor(() => expect(calls.some((c) => String(c.url).includes('/api/messages'))).toBe(true));
});

test('미해결 알림이 있으면 쪽지 대신 응급 섹션이 뜬다', () => {
  const a = alert({ snapshotUrl: '/api/snapshots/local-abc.jpg' });
  const { container } = renderHome({ openAlerts: [a] });

  expect(container.querySelector('.g-emergency')).not.toBeNull();
  expect(screen.getByText('낙상 감지')).toBeInTheDocument();
  expect(screen.getByText(a.description)).toBeInTheDocument();
  expect(screen.getByAltText('감지 당시 화면')).toBeInTheDocument();

  // 쪽지가 함께 뜨면 안 된다 — 응급이 평상시 문구에 묻히는 경로다.
  expect(container.querySelector('.g-note__body')).toBeNull();
});

test('"확인했어요"가 해당 알림을 보호자 명의로 해제하고 화면을 갱신한다', async () => {
  const refresh = vi.fn();
  renderHome({ openAlerts: [alert()], refresh });

  await userEvent.click(screen.getByRole('button', { name: '확인했어요' }));

  const resolve = calls.find((c) => String(c.url).includes('/api/alerts/resolve'));
  expect(resolve).toBeDefined();
  expect(resolve.options.method).toBe('POST');
  expect(JSON.parse(resolve.options.body)).toEqual({ id: 'a1', by: 'guardian' });
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

test('미해결 알림이 여러 건이면 남은 건수를 알려준다', () => {
  renderHome({ openAlerts: [alert(), alert({ id: 'a2' }), alert({ id: 'a3' })] });
  expect(screen.getByText(/확인하지 않은 알림이 2건 더 있어요/)).toBeInTheDocument();
});

test('SSE가 끊기면 폴백 폴링 중이라는 것을 알려준다', () => {
  renderHome({ connected: false });
  expect(screen.getByText(/실시간 연결이 끊겼어요/)).toBeInTheDocument();
});
