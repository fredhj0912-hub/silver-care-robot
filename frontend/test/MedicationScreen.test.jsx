import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MedicationScreen from '../src/guardian/screens/MedicationScreen';

/**
 * 복약 화면. 보호자가 등록한 일정이 실제로 백엔드 계약대로 나가는지,
 * 이미 드신 약에 「드셨어요」 버튼이 남지 않는지를 확인한다 —
 * 버튼이 남으면 보호자가 같은 약을 두 번 확인했다고 착각한다.
 *
 * `lib/api.js`는 목킹하지 않고 fetch만 스텁한다. 그래야 API 키 스탬핑까지
 * 실제 코드로 통과시켜 회귀를 잡는다.
 */

const med = (over = {}) => ({
  id: 1,
  medicineName: '혈압약',
  scheduledAt: '2026-08-30T00:00:00.000Z',
  status: 'scheduled',
  takenAt: null,
  takenBy: null,
  remindedAt: null,
  notes: null,
  createdAt: '2026-08-29T00:00:00.000Z',
  ...over,
});

let calls;
let medications;

function stubFetch() {
  calls = [];
  medications = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (options.method === 'POST' || options.method === 'DELETE') {
      return { ok: true, json: async () => ({ success: true, medications: [] }) };
    }
    return { ok: true, json: async () => ({ medications }) };
  }));
}

const listCalls = () => calls.filter((c) => !c.options.method || c.options.method === 'GET');

beforeEach(stubFetch);
afterEach(() => vi.unstubAllGlobals());

test('등록된 약이 없으면 등록을 안내한다', async () => {
  render(<MedicationScreen />);
  expect(await screen.findByText(/아직 등록된 약이 없어요/)).toBeInTheDocument();
});

test('일정을 등록하면 UTC로 변환해 보내고 목록을 다시 읽는다', async () => {
  render(<MedicationScreen />);
  await screen.findByText(/아직 등록된 약이 없어요/);
  const readsBefore = listCalls().length;

  await userEvent.type(screen.getByLabelText('약 이름'), '혈압약');
  await userEvent.clear(screen.getByLabelText('며칠 동안'));
  await userEvent.type(screen.getByLabelText('며칠 동안'), '3');
  await userEvent.click(screen.getByRole('button', { name: '일정 등록하기' }));

  const post = calls.find((c) => c.options.method === 'POST');
  expect(post).toBeDefined();
  const body = JSON.parse(post.options.body);
  expect(body.medicineName).toBe('혈압약');
  expect(body.repeatDays).toBe(3);
  // datetime-local 은 기기 로컬 시각이므로 반드시 UTC ISO로 변환돼 나가야 한다.
  expect(body.scheduledAt).toMatch(/Z$/);

  await waitFor(() => expect(listCalls().length).toBeGreaterThan(readsBefore));
});

test('약 이름이 비어 있으면 등록 버튼이 눌리지 않는다', async () => {
  render(<MedicationScreen />);
  await screen.findByText(/아직 등록된 약이 없어요/);

  expect(screen.getByRole('button', { name: '일정 등록하기' })).toBeDisabled();
});

test('이미 드신 약엔 「드셨어요」 버튼 대신 복용 기록이 남는다', async () => {
  medications = [
    med({ id: 1, medicineName: '혈압약' }),
    med({
      id: 2,
      medicineName: '당뇨약',
      status: 'taken',
      takenAt: '2026-08-30T00:05:00.000Z',
      takenBy: 'guardian',
    }),
  ];
  render(<MedicationScreen />);

  expect(await screen.findByText('혈압약')).toBeInTheDocument();
  expect(screen.getByText('당뇨약')).toBeInTheDocument();

  // 버튼은 아직 확인 안 된 1건에만 붙는다.
  expect(screen.getAllByRole('button', { name: '드셨어요' })).toHaveLength(1);
  expect(screen.getByText(/드셨어요 \(보호자 확인\)/)).toBeInTheDocument();
});

test('「드셨어요」는 보호자 명의로 복용 처리를 보낸다', async () => {
  medications = [med({ id: 7 })];
  render(<MedicationScreen />);

  await userEvent.click(await screen.findByRole('button', { name: '드셨어요' }));

  const post = calls.find((c) => c.url.includes('/api/medications/7/taken'));
  expect(post).toBeDefined();
  expect(JSON.parse(post.options.body)).toEqual({ by: 'guardian' });
});

test('「일정 지우기」는 남은 반복 일정까지 한 번에 지운다', async () => {
  // 30일치를 잘못 등록했을 때 한 건씩 지우게 하면 남은 것이 미복용으로 쌓여
  // 보호자에게 경고까지 올라간다 — 그래서 scope=series 여야 한다.
  medications = [med({ id: 7 })];
  render(<MedicationScreen />);

  await userEvent.click(await screen.findByRole('button', { name: '일정 지우기' }));

  const remove = calls.find((c) => c.options.method === 'DELETE');
  expect(remove).toBeDefined();
  expect(remove.url).toContain('/api/medications/7?scope=series');
});

test('못 드신 약은 미복용으로 표시된다', async () => {
  medications = [med({ id: 3, status: 'missed' })];
  render(<MedicationScreen />);

  expect(await screen.findByText('못 드셨어요')).toBeInTheDocument();
});
