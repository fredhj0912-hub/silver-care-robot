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
  constructor() { this.startCount = 0; recognizers.push(this); }
  start() { this.startCount += 1; this.onstart?.(); }   // 실제 브라우저와 같이 시작 이벤트를 낸다
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

/** 인식 실패 한 번 — 실제 브라우저처럼 error 뒤에 end가 따라온다. */
function failWith(error) {
  const recognition = recognizers.at(-1);
  act(() => {
    recognition.onerror?.({ error });
    recognition.onend?.();
  });
}

let RobotFaceDisplay;
beforeAll(async () => {
  // 이 파일이 검증하는 것은 **화면의 배선**이지 STT 구현이 아니다. 배선은 두 모드에
  // 공통이므로, 이벤트를 손으로 흘려보낼 수 있는 browser 모드로 고정해 테스트한다.
  // 기본값(server)에서도 같은 배선이 도는 것은 RobotFaceDisplay.server-stt.test.jsx가 덮는다.
  vi.stubEnv('VITE_STT_MODE', 'browser');
  window.SpeechRecognition = FakeRecognition;
  RobotFaceDisplay = (await import('../src/components/RobotFaceDisplay')).default;
});

const STATUS = { isEmergency: false, seniorExpression: 'neutral', battery: 90 };

// fetch를 경로별로 분기해 가로챈다. api.js(apiFetch)는 실제 코드를 그대로 통과시킨다.
let calls;
let pendingMove = null;   // 테스트가 채우면 kind=move 조회가 이걸 돌려준다
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
    if (p.includes('kind=move')) {
      return { ok: true, status: 200, json: async () => ({ commands: pendingMove ? [pendingMove] : [] }) };
    }
    if (p.includes('/api/commands/pending')) return { ok: true, status: 200, json: async () => ({ commands: [] }) };
    return { ok: true, status: 200, json: async () => ({ alerts: [] }) };
  }));
}

const chatCalls = () => calls.filter((c) => c.url.includes('/api/chat'));

beforeEach(() => {
  recognizers.length = 0;
  pendingMove = null;
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

/**
 * 아래 네 개는 전부 같은 목적이다 — **실패가 콘솔이 아니라 7인치 화면에 뜨는가.**
 * 라즈베리파이 앞에 devtools를 열어 둘 사람은 없다. 화면이 "듣고 있어요"라고 말하는데
 * 실제로는 아무것도 듣고 있지 않은 상태가 이 프로젝트에서 가장 나쁜 실패다.
 */

test('보안 컨텍스트가 아니면 음성 인식을 시작하지 않고 이유를 화면에 띄운다', () => {
  // 파이를 http://<LAN IP>:3001 로 열었을 때가 정확히 이 경우다.
  vi.stubGlobal('isSecureContext', false);

  renderKiosk();

  expect(screen.getByText(/HTTPS 필요/)).toBeInTheDocument();
  expect(recognizers).toHaveLength(0);   // 헛되이 인식기를 만들지 않는다
});

test('마이크를 못 쓰면 즉시 포기하고 텍스트 입력으로 안내한다', async () => {
  renderKiosk();

  failWith('not-allowed');   // 되돌릴 수 없는 오류 — 재시도해도 같다

  expect(screen.getByText(/마이크를 쓸 수 없어요/)).toBeInTheDocument();
});

test("연속된 'network' 오류는 3회에서 포기하고 재시작 루프를 멈춘다", async () => {
  // 구글 음성 키 없이 빌드된 Chromium은 매 세션 network로 끝난다.
  // 예전에는 고정 300ms로 무한 재시작하면서 화면은 계속 "듣고 있어요"였다.
  vi.useFakeTimers();
  try {
    renderKiosk();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    const recognition = recognizers.at(-1);
    for (let i = 0; i < 3; i += 1) {
      failWith('network');
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });  // 백오프 최대치
    }

    expect(screen.getByText(/음성 인식 서버에 닿지 않아요/)).toBeInTheDocument();

    const startsAfterGivingUp = recognition.startCount;
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(recognition.startCount).toBe(startsAfterGivingUp);   // 더 이상 재시작하지 않는다
  } finally {
    vi.useRealTimers();
  }
});

test('발화 완료 신호가 영영 안 와도 워치독이 듣기를 되살린다', async () => {
  // speechSynthesis.speak()는 스텁이라 onend를 절대 부르지 않는다 —
  // speech-dispatcher가 없는 리눅스에서 실제로 이렇게 동작한다.
  // 워치독이 없으면 isSpeakingRef가 true로 잠겨 로봇이 영구히 귀머거리가 된다.
  vi.useFakeTimers();
  try {
    renderKiosk();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    speak('효돌아');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('말하는 중...')).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.queryByText('말하는 중...')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test('이동 명령은 화면에 보여주기만 하고 ack하지 않는다', async () => {
  // move를 소비(ack)해도 되는 것은 실물 구동부를 돌리는 프로세스 하나뿐이다.
  // 키오스크가 여기서 ack하면 모터가 명령을 영영 받지 못한다.
  pendingMove = { id: 7, kind: 'move', payload: { direction: 'left' } };

  vi.useFakeTimers();
  try {
    renderKiosk();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });   // 폴링 1주기

    expect(screen.getByText(/이동 중/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/ack'))).toBe(false);

    // 지나면 의미가 없는 명령이므로 조회 자체에 나이 제한을 건다
    expect(calls.some((c) => c.url.includes('kind=move&maxAgeMs=2000'))).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('이동 표시는 부모가 리렌더돼도 1.5초 뒤에 사라진다', async () => {
  // 09-01 파이 실측에서 "이동 중"이 화면에 박제됐다. 원인은 소멸 타이머가 명령 폴링
  // 효과에 얹혀 있어서, 그 효과가 재실행될 때 정리 함수가 타이머를 지워 버린 것이다.
  // App.jsx의 onStatusChange가 매 렌더 새 함수면 3초마다 그 일이 벌어진다.
  pendingMove = { id: 11, kind: 'move', payload: { direction: 'left' } };

  vi.useFakeTimers();
  try {
    const { rerender } = render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByText(/이동 중/)).toBeInTheDocument();

    // 새 함수 정체성으로 리렌더 — 폴링 효과가 통째로 재실행되는 상황을 그대로 재현한다
    rerender(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

    expect(screen.queryByText(/이동 중/)).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test('SOS 버튼은 수동 알림을 올린다', async () => {
  renderKiosk();

  await userEvent.click(screen.getByRole('button', { name: /SOS 긴급 호출/ }));

  const sos = calls.find((c) => c.method === 'POST' && c.url.includes('/api/alerts'));
  expect(sos).toBeTruthy();
  expect(JSON.parse(sos.body).type).toBe('manual_panic_button');
});
