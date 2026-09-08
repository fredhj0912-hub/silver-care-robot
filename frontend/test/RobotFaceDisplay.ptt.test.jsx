import { test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * 푸시투토크(기본 모드) — **마이크가 버튼을 눌러야만 열린다**는 것을 확인한다.
 *
 * 이 파일이 있는 이유: 상시 청취에서는 방 안에서 나는 모든 소리가 받아쓰기 1건이고,
 * 웨이크워드 판정이 받아쓰기 *뒤*라 게이트가 닫혀 있어도 이미 지불된 뒤다.
 * 2026-09-02 파이에서 한 시간에 100건을 그렇게 태웠다. 그래서 여기서 보는 것은
 * "게이트가 잘 도는가"가 아니라 **"안 눌렀는데 /api/stt 가 나가지 않는가"** 다.
 *
 * server-stt 테스트와 같은 가짜 AudioContext를 쓴다 — 실제 배포 경로가 server 모드다.
 */

// ── Web Audio 대역 (RobotFaceDisplay.server-stt.test.jsx와 같은 방식) ─────
let frameHandler = null;

class FakeAudioContext {
  constructor({ sampleRate }) { this.sampleRate = sampleRate; this.destination = {}; }
  createMediaStreamSource() { return { connect: () => {} }; }
  createGain() { return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} }; }
  createScriptProcessor() {
    return { connect: () => {}, disconnect: () => {}, set onaudioprocess(fn) { frameHandler = fn; } };
  }
  close() {}
}

function frame(amplitude) {
  const data = new Float32Array(4096).fill(amplitude);
  act(() => frameHandler?.({ inputBuffer: { getChannelData: () => data } }));
}

/** 한 발화: 시끄러운 구간 → 침묵으로 마무리 */
function utter(frames = 4) {
  for (let i = 0; i < frames; i++) frame(0.2);
  for (let i = 0; i < 5; i++) frame(0.001);
}

let calls;
let transcript;
function stubFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    const p = String(url);
    if (p.includes('/api/stt')) return { ok: true, status: 200, json: async () => ({ text: transcript, source: 'gemini' }) };
    if (p.includes('/api/tts')) return { status: 204, ok: true, headers: { get: () => null } };
    if (p.includes('/api/chat')) {
      return { ok: true, status: 200, json: async () => ({ text: '네, 잘 지내고 있어요', emotion: 'happy', source: 'mock' }) };
    }
    if (p.includes('/api/commands/pending')) return { ok: true, status: 200, json: async () => ({ commands: [] }) };
    return { ok: true, status: 200, json: async () => ({ alerts: [] }) };
  }));
}

const chatCalls = () => calls.filter((c) => c.url.includes('/api/chat'));
const sttCalls = () => calls.filter((c) => c.url.includes('/api/stt'));

let RobotFaceDisplay;
beforeAll(async () => {
  vi.stubEnv('VITE_STT_MODE', 'server');
  // 기본값이지만 명시한다 — .env 에 VITE_MIC_MODE=always 가 있어도 이 파일은 ptt 를 본다.
  vi.stubEnv('VITE_MIC_MODE', 'ptt');
  RobotFaceDisplay = (await import('../src/components/RobotFaceDisplay')).default;
});

const STATUS = { isEmergency: false, seniorExpression: 'neutral', battery: 90 };

beforeEach(() => {
  frameHandler = null;
  transcript = '';
  stubFetch();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('speechSynthesis', { cancel: () => {}, speak: () => {}, getVoices: () => [] });
  vi.stubGlobal('SpeechSynthesisUtterance', class { });
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      getUserMedia: async (constraints) => {
        if (!constraints?.audio) throw new Error('no camera');
        return { getTracks: () => [{ stop: () => {} }] };
      },
    },
  });
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const pttButton = () => screen.getByRole('button', { name: /눌러서 말하기|듣고 있어요/ });

/** 버튼을 누르고 인식기가 마이크를 잡을 때까지 기다린다 */
async function press() {
  await userEvent.click(pttButton());
  await waitFor(() => expect(frameHandler).not.toBeNull());
}

test('마운트만으로는 마이크가 열리지 않는다 — 이것이 이 모드의 전부다', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
  // 상시 청취라면 여기서 마이크를 잡는다(1초 지연 후 start)
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  vi.useRealTimers();

  expect(frameHandler).toBeNull();
  expect(screen.getByText(/버튼을 누르고 말씀해 주세요/)).toBeInTheDocument();
});

test('버튼을 눌러야 마이크가 열리고, 그 발화가 대화로 넘어간다', async () => {
  render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
  await press();

  // 누른 것 자체가 의도 표명이므로 웨이크워드를 요구하지 않는다
  transcript = '오늘 날씨 어때';
  utter();
  await waitFor(() => expect(chatCalls().length).toBe(1));
  expect(JSON.parse(chatCalls()[0].body).text).toBe('오늘 날씨 어때');
});

test('한 번 누름 = 한 발화 — 처리한 뒤 스스로 닫는다', async () => {
  render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
  await press();

  transcript = '오늘 날씨 어때';
  utter();
  await waitFor(() => expect(sttCalls().length).toBe(1));

  // 닫힌 뒤에는 같은 프레임을 아무리 흘려보내도 더 올라가지 않는다
  await waitFor(() => expect(screen.queryByText(/듣고 있어요 ·/)).toBeNull());
  utter();
  utter();
  await new Promise((r) => setTimeout(r, 50));
  expect(sttCalls()).toHaveLength(1);
});

test('잡음으로 흘려보낸 발화도 마이크를 닫는다 — 열린 채 잊히지 않는다', async () => {
  render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
  await press();

  transcript = '음';                     // isMeaningfulUtterance 가 걸러내는 짧은 잡음
  utter();
  await waitFor(() => expect(sttCalls().length).toBe(1));
  expect(chatCalls()).toHaveLength(0);
  await waitFor(() => expect(screen.queryByText(/듣고 있어요 ·/)).toBeNull());
});

test('눌렀는데 아무 말이 없으면 시간이 지나 스스로 닫는다 (업로드 0건)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
  await userEvent.click(pttButton(), { advanceTimers: vi.advanceTimersByTime });

  expect(screen.getByText(/듣고 있어요 ·/)).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(8500); });
  vi.useRealTimers();

  expect(screen.queryByText(/듣고 있어요 ·/)).toBeNull();
  expect(sttCalls()).toHaveLength(0);
});

test('듣는 중에 다시 누르면 닫힌다 — 잘못 눌렀을 때 되돌릴 길이 있어야 한다', async () => {
  render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
  await press();
  expect(screen.getByText(/듣고 있어요 ·/)).toBeInTheDocument();

  await userEvent.click(pttButton());
  expect(screen.queryByText(/듣고 있어요 ·/)).toBeNull();
});

/**
 * 이 모드가 없앤 것을 명시적으로 남긴다. 상시 청취에서는 "살려줘"가 웨이크워드 없이
 * 통과해 응급 알림으로 이어졌지만, 마이크가 닫혀 있으면 그 경로 자체가 없다.
 * 대체 수단은 화면의 SOS 버튼이고, 그래서 그 버튼은 **항상** 보여야 한다.
 */
test('마이크가 닫혀 있어도 SOS 버튼은 항상 화면에 있다', async () => {
  render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
  expect(screen.getByRole('button', { name: /SOS 긴급 호출/ })).toBeInTheDocument();
});

/**
 * 마이크가 닫혔는데 화면이 "듣고 있어요"로 남으면, 어르신은 죽은 마이크에 대고 말한다.
 * ptt 모드에서는 인식기의 onEnd 가 먼저 return 하므로 stopPtt 가 상태줄을 되돌려야 한다.
 */
test('닫힌 뒤에는 상태줄도 "듣고 있어요"가 아니어야 한다', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
  await userEvent.click(pttButton(), { advanceTimers: vi.advanceTimersByTime });
  await act(async () => { await vi.advanceTimersByTimeAsync(8500); });
  vi.useRealTimers();

  // 마이크는 닫혔다. 상태줄이 계속 "말씀하세요, 듣고 있어요"면 어르신은 죽은 마이크에 말한다.
  expect(screen.queryByText(/말씀하세요, 듣고 있어요/)).toBeNull();
  expect(screen.getByText(/버튼을 누르고 말씀해 주세요/)).toBeInTheDocument();
});

/**
 * 한 번 누름 = 업로드 **최대 한 건**. 이게 이 모드의 값어치 전부다.
 *
 * 09-07 리뷰에서 드러난 구멍: 마이크를 닫는 건 stopPtt 하나뿐인데 그건 받아쓴 글자가
 * 비어 있지 않을 때만 불린다(빈 결과는 onResult 를 건너뛴다). TV 소리·기침은 보통 빈
 * 결과로 돌아오므로, 조용한 방이 아니면 한 번 누름에 2~3건이 나갔다. 인식기의 oneShot 이
 * 발화가 끝나는 그 순간 캡처를 닫아 막는다.
 */
test('한 번 누름에 업로드는 한 건뿐 — 빈 받아쓰기가 돌아와도 더 안 올린다', async () => {
  render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
  await press();

  transcript = '';        // TV 소리·기침이 이렇게 돌아온다
  utter();
  await waitFor(() => expect(sttCalls().length).toBe(1));

  // 같은 누름 안에서 계속 떠들어도 마이크는 이미 닫혔다
  utter();
  utter();
  await new Promise((r) => setTimeout(r, 60));
  expect(sttCalls()).toHaveLength(1);
  expect(chatCalls()).toHaveLength(0);
});

/**
 * 인식기 효과는 상태값이 바뀌면 누르는 도중에도 다시 돈다. 그 정리 코드가 타이머만
 * 지우고 화면 상태를 안 되돌리면, 버튼이 숫자가 멈춘 채 "듣고 있어요"로 굳는다 —
 * 닫을 타이머까지 이미 지워진 뒤라 영영 안 풀린다.
 */
test('누르는 도중 인식기가 재생성돼도 버튼이 "듣고 있어요"로 굳지 않는다', async () => {
  const { rerender } = render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
  await press();
  expect(screen.getByText(/듣고 있어요 ·/)).toBeInTheDocument();

  // seniorExpression 이 바뀌면 sendVoiceMessage → handleTranscript → 인식기 효과가 다시 돈다
  rerender(<RobotFaceDisplay status={{ ...STATUS, seniorExpression: 'happy' }} onStatusChange={() => {}} />);

  await waitFor(() => expect(screen.queryByText(/듣고 있어요 ·/)).toBeNull());
  expect(screen.getByRole('button', { name: /눌러서 말하기/ })).toBeInTheDocument();
});

/** 카운트다운은 마이크가 실제로 열린 뒤부터다 — 파이의 느린 getUserMedia 가 창을 갉아먹지 않게. */
test('마이크가 열리기 전에는 카운트다운이 아니라 "여는 중"이다', async () => {
  let openMic;
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      // getUserMedia 를 우리가 원할 때까지 붙잡아 둔다 (파이의 느린 권한 획득 재현)
      getUserMedia: (constraints) => new Promise((resolve, reject) => {
        if (!constraints?.audio) return reject(new Error('no camera'));
        openMic = () => resolve({ getTracks: () => [{ stop: () => {} }] });
      }),
    },
  });

  render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
  await userEvent.click(pttButton());

  expect(screen.getByText(/마이크를 여는 중/)).toBeInTheDocument();
  expect(screen.queryByText(/듣고 있어요 ·/)).toBeNull();

  await act(async () => { openMic(); });
  await waitFor(() => expect(screen.getByText(/듣고 있어요 · 8초/)).toBeInTheDocument());
});
