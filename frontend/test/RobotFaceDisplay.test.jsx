import { test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 키오스크 화면에서 검증하는 건 하나다 — **화면이 웨이크워드 게이트를 실제로 통과시키는가**.
 *
 * 게이트 판정 자체(decideAction)는 wakeword.test.js가 이미 덮고 있으므로 여기서
 * 되풀이하지 않는다. 이 파일이 막는 건 "순수 함수는 맞는데 화면이 그걸 안 부르는" 경우다:
 * 게이트를 우회하면 TV 소리·혼잣말에도 Gemini를 부르고, 반대로 응급 우회 발화가
 * 막히면 쓰러진 어르신의 "살려줘"가 무시된다.
 */

// ── 브라우저 음성 API 대역 ────────────────────────────────────────────────
// stt.js는 **모듈 로드 시점**에 window.SpeechRecognition을 붙잡는다.
// 그래서 컴포넌트를 정적 import하면 늦다 — 심어 놓고 동적으로 불러온다.
const recognizers = [];
class FakeRecognition {
  constructor() { recognizers.push(this); }
  start() { this.onstart?.(); }   // 실제 브라우저와 같이 시작 이벤트를 낸다
  stop() {}
  abort() {}
}

/** 인식된 발화 한 건을 흘려보낸다 (stt.js가 기대하는 event 모양 그대로). */
function speak(text) {
  const alternatives = [{ transcript: text, confidence: 0.9 }];
  alternatives.isFinal = true;
  const recognition = recognizers.at(-1);
  act(() => recognition.onresult({ results: [alternatives] }));
}

let RobotFaceDisplay;
beforeAll(async () => {
  window.SpeechRecognition = FakeRecognition;
  RobotFaceDisplay = (await import('../src/components/RobotFaceDisplay')).default;
});

const STATUS = { isEmergency: false, seniorExpression: 'neutral', battery: 90 };

// fetch를 경로별로 분기해 가로챈다. api.js(apiFetch)는 실제 코드를 그대로 통과시킨다.
let calls;
function stubFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    const p = String(url);
    // 204 = 브라우저 TTS로 처리하라는 신호. 오디오 재생 경로를 타지 않는다.
    if (p.includes('/api/tts')) return { status: 204, ok: true, headers: { get: () => null } };
    if (p.includes('/api/chat')) {
      return { ok: true, status: 200, json: async () => ({ text: '네, 잘 지내고 있어요', emotion: 'happy', source: 'mock' }) };
    }
    if (p.includes('/api/commands/pending')) return { ok: true, status: 200, json: async () => ({ commands: [] }) };
    return { ok: true, status: 200, json: async () => ({ alerts: [] }) };
  }));
}

const chatCalls = () => calls.filter((c) => c.url.includes('/api/chat'));

beforeEach(() => {
  recognizers.length = 0;
  stubFetch();
  vi.stubGlobal('speechSynthesis', { cancel: () => {}, speak: () => {}, getVoices: () => [] });
  vi.stubGlobal('SpeechSynthesisUtterance', class { });
  // VITE_VISION_ENABLED가 켜져 있는 환경에서도 카메라를 실제로 열지 않게 막는다.
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: async () => { throw new Error('no camera'); } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const renderKiosk = (status = STATUS) =>
  render(<RobotFaceDisplay status={status} onStatusChange={() => {}} />);

test('듣고 있지만 게이트가 닫혀 있으면 웨이크워드를 부르라고 안내한다', async () => {
  // 지금 불러야 하는 상태인지가 화면에서 분명해야 한다 —
  // 말을 걸었는데 반응이 없으면 어르신은 로봇이 고장난 줄 안다.
  vi.useFakeTimers();
  try {
    renderKiosk();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });   // 인식 시작 타이머
    expect(screen.getByText('"효돌아" 하고 불러주세요')).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test('웨이크워드 없는 발화는 Gemini를 부르지 않는다', async () => {
  renderKiosk();

  speak('오늘 날씨가 참 좋네');   // TV 소리·혼잣말이 여기로 들어온다

  await new Promise((r) => setTimeout(r, 0));
  expect(chatCalls()).toHaveLength(0);
});

test('웨이크워드와 함께 말하면 웨이크워드를 뗀 내용만 보낸다', async () => {
  renderKiosk();

  speak('효돌아 오늘 날씨 어때');

  await waitFor(() => expect(chatCalls()).toHaveLength(1));
  expect(JSON.parse(chatCalls()[0].body).text).toBe('오늘 날씨 어때');
});

test('웨이크워드만 부르면 Gemini 없이 바로 대답한다', async () => {
  renderKiosk();

  speak('효돌아');

  await waitFor(() => expect(screen.getByText(/효돌이:/)).toBeInTheDocument());
  expect(chatCalls()).toHaveLength(0);
});

test('응급 발화는 웨이크워드 없이도 통과한다', async () => {
  // 넘어진 어르신이 "효돌아, 도와줘"라고 격식을 갖춰 부를 것이라 기대할 수 없다.
  renderKiosk();

  speak('살려줘');

  await waitFor(() => expect(chatCalls()).toHaveLength(1));
});

test('SOS 버튼은 수동 알림을 올린다', async () => {
  renderKiosk();

  await userEvent.click(screen.getByRole('button', { name: /SOS 긴급 호출/ }));

  const sos = calls.find((c) => c.method === 'POST' && c.url.includes('/api/alerts'));
  expect(sos).toBeTruthy();
  expect(JSON.parse(sos.body).type).toBe('manual_panic_button');
});
