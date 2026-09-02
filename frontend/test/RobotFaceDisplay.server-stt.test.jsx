import { test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

/**
 * 서버측 STT(기본 모드)에서도 **화면의 웨이크워드 배선이 그대로 돈다**는 것을 확인한다.
 *
 * 이 파일이 있는 이유: 서버 인식기를 만들면서 "인터페이스가 같으니 호출부는 안 바뀐다"고
 * 주장했는데, 그 주장을 검증 없이 믿으면 파이 앞에서야 틀린 것을 알게 된다.
 * RobotFaceDisplay.test.jsx는 이벤트를 손으로 흘려보내려고 browser 모드로 고정돼 있어
 * **실제 배포 경로(server)를 아무도 안 지나간다** — 그 구멍을 여기서 막는다.
 *
 * 마이크 대신 가짜 AudioContext에 RMS 값을 직접 먹인다.
 */

// ── Web Audio 대역 ────────────────────────────────────────────────────────
let frameHandler = null;      // ScriptProcessorNode.onaudioprocess
const stoppedTracks = [];

class FakeAudioContext {
  constructor({ sampleRate }) { this.sampleRate = sampleRate; this.destination = {}; }
  createMediaStreamSource() { return { connect: () => {} }; }
  createGain() { return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} }; }
  createScriptProcessor() {
    const node = { connect: () => {}, disconnect: () => {}, set onaudioprocess(fn) { frameHandler = fn; } };
    return node;
  }
  close() {}
}

/** 한 프레임(4096샘플 @16kHz = 256ms)을 흘려보낸다. amplitude가 곧 RMS다. */
function frame(amplitude) {
  const data = new Float32Array(4096).fill(amplitude);
  act(() => frameHandler?.({ inputBuffer: { getChannelData: () => data } }));
}

/** 한 발화: 시끄러운 구간 → 침묵으로 마무리. VAD가 경계를 잡는다. */
function utter(frames = 4) {
  for (let i = 0; i < frames; i++) frame(0.2);     // startThreshold(0.02)보다 훨씬 큼
  for (let i = 0; i < 5; i++) frame(0.001);        // silenceMs(900) 넘김
}

// ── fetch 대역 (RobotFaceDisplay.test.jsx와 같은 방식) ────────────────────
let calls;
let transcript;                 // /api/stt 가 돌려줄 받아쓰기 결과
let sttStatus;
function stubFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    const p = String(url);
    if (p.includes('/api/stt')) {
      if (sttStatus !== 200) return { ok: false, status: sttStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ text: transcript, source: 'gemini' }) };
    }
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
  // 기본값이지만 명시한다 — .env에 VITE_STT_MODE=browser가 있어도 이 파일은 server를 본다.
  vi.stubEnv('VITE_STT_MODE', 'server');
  RobotFaceDisplay = (await import('../src/components/RobotFaceDisplay')).default;
});

const STATUS = { isEmergency: false, seniorExpression: 'neutral', battery: 90 };

beforeEach(() => {
  frameHandler = null;
  stoppedTracks.length = 0;
  transcript = '';
  sttStatus = 200;
  stubFetch();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('speechSynthesis', { cancel: () => {}, speak: () => {}, getVoices: () => [] });
  vi.stubGlobal('SpeechSynthesisUtterance', class { });
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      getUserMedia: async (constraints) => {
        // 카메라 요청은 거절한다 (VITE_VISION_ENABLED가 켜진 환경 대비)
        if (!constraints?.audio) throw new Error('no camera');
        return { getTracks: () => [{ stop: () => stoppedTracks.push(1) }] };
      },
    },
  });
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/** 마운트하고 인식기가 마이크를 잡을 때까지 기다린다 (1초 지연 후 start()) */
async function mountAndListen() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  vi.useRealTimers();
  await waitFor(() => expect(frameHandler).not.toBeNull());
}

test('마이크를 잡으면 웨이크워드를 기다린다고 알린다', async () => {
  await mountAndListen();
  expect(screen.getByText(/효돌아.*불러주세요/)).toBeInTheDocument();
});

test('웨이크워드 없는 발화는 서버로 받아쓰되 대화는 부르지 않는다', async () => {
  await mountAndListen();
  transcript = '오늘 드라마 재미있네';
  utter();
  await waitFor(() => expect(sttCalls().length).toBe(1));
  // 받아쓰기는 했지만 게이트가 닫혀 있으므로 Gemini 대화는 부르지 않는다
  expect(chatCalls()).toHaveLength(0);
});

test('웨이크워드가 붙은 발화는 웨이크워드를 떼고 대화로 넘어간다', async () => {
  await mountAndListen();
  transcript = '효돌아 오늘 날씨 어때';
  utter();
  await waitFor(() => expect(chatCalls().length).toBe(1));
  expect(JSON.parse(chatCalls()[0].body).text).toBe('오늘 날씨 어때');
});

test('응급 발화는 웨이크워드 없이도 통과한다', async () => {
  await mountAndListen();
  transcript = '살려줘';
  utter();
  await waitFor(() => expect(chatCalls().length).toBe(1));
});

test('보낸 오디오는 백엔드가 받는 WAV data URI다', async () => {
  await mountAndListen();
  transcript = '효돌아';
  utter();
  await waitFor(() => expect(sttCalls().length).toBe(1));
  const { audio } = JSON.parse(sttCalls()[0].body);
  // backend/src/routes/stt.js 의 검사식과 같은 조건
  expect(audio).toMatch(/^data:audio\/wav;base64,/);
});

test('너무 짧은 소리는 서버로 보내지 않는다', async () => {
  await mountAndListen();
  utter(1);                                   // 256ms < minSpeechMs(400)
  await new Promise((r) => setTimeout(r, 20));
  expect(sttCalls()).toHaveLength(0);
});

test('조용하기만 하면 아무것도 보내지 않는다', async () => {
  await mountAndListen();
  for (let i = 0; i < 20; i++) frame(0.001);
  await new Promise((r) => setTimeout(r, 20));
  expect(sttCalls()).toHaveLength(0);
});

test('빈 받아쓰기는 침묵과 같이 취급한다 — 대화를 부르지 않는다', async () => {
  await mountAndListen();
  transcript = '';
  utter();
  await waitFor(() => expect(sttCalls().length).toBe(1));
  expect(chatCalls()).toHaveLength(0);
});

test('백엔드가 받아쓰기를 못 하면(503) 텍스트 입력으로 안내한다', async () => {
  // 503은 되돌릴 수 없는 상태다 — 재시도 3회를 기다리지 않고 바로 포기해야 한다.
  await mountAndListen();
  sttStatus = 503;
  utter();
  await waitFor(() => expect(screen.getByText(/글로 말씀해 주세요/)).toBeInTheDocument());
});

test('마이크 권한이 거부되면 즉시 포기하고 텍스트 입력으로 안내한다', async () => {
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      getUserMedia: async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; },
    },
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  vi.useRealTimers();
  await waitFor(() => expect(screen.getByText(/마이크를 쓸 수 없어요/)).toBeInTheDocument());
});

test('언마운트하면 마이크를 놓아준다', async () => {
  const { unmount } = render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
  await waitFor(() => expect(frameHandler).not.toBeNull(), { timeout: 3000 });
  unmount();
  expect(stoppedTracks.length).toBeGreaterThan(0);
});
