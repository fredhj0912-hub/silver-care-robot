import { test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

/**
 * **로봇이 조용히 벙어리가 되는 것**을 화면이 드러내는지 확인한다.
 *
 * 2026-09-02에 실제로 있었던 일: 서버 TTS(Gemini)가 503을 냈고, 라우트가 204를 돌려주자
 * 키오스크가 브라우저 TTS로 넘어갔다. 그런데 파이의 Chromium에는 speech-dispatcher가 없어
 * `speak()`가 **조용히 무시된다**(09-01 실측). 화면에는 글이 떴으므로 밖에서 보면
 * "정상 폴백"과 "완전한 실패"가 구별되지 않았다 — 소리로만 듣는 어르신에게는 실패다.
 *
 * 여기서 재는 것은 딱 하나: **onstart가 한 번도 오지 않았는가.**
 * 그것만이 소리가 안 났다는 관측 가능한 증거다.
 *
 * TTS 경로는 여기 말고 아무 테스트도 지나가지 않는다. 기존 두 파일
 * (RobotFaceDisplay.test.jsx / .server-stt.test.jsx)은 STT 모드 고정 때문에 구조가
 * 예민해서 건드리지 않고, TTS는 이 파일로 뗀다.
 */

const VOICELESS = /소리가 나지 않아/;
const SPOKEN_TEXT = '약 드실 시간이에요';

// ── speechSynthesis 대역 ──────────────────────────────────────────────────
// speakSilently=true 면 파이처럼 speak()가 아무 일도 하지 않는다(onstart가 영영 안 온다).
let speakSilently;
let spokenUtterances;

function stubSpeech() {
  spokenUtterances = [];
  vi.stubGlobal('speechSynthesis', {
    cancel: () => {},
    getVoices: () => [],
    speak: (utterance) => {
      spokenUtterances.push(utterance);
      if (!speakSilently) utterance.onstart?.();
    },
  });
  vi.stubGlobal('SpeechSynthesisUtterance', class {
    constructor(text) { this.text = text; }
  });
}

// ── fetch 대역 ────────────────────────────────────────────────────────────
let ttsErrorHeader;   // null이면 provider=browser 정상 경로, 값이 있으면 **합성 실패**
let commandServed;

function stubFetch() {
  commandServed = false;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const p = String(url);

    if (p.includes('/api/tts')) {
      return {
        status: 204,
        ok: true,
        headers: { get: (name) => (name === 'X-TTS-Error' && ttsErrorHeader ? ttsErrorHeader : null) },
      };
    }

    // 보호자 메시지 한 건을 딱 한 번만 흘려보낸다 — 매 폴링마다 주면 계속 말하게 된다
    if (p.includes('/api/commands/pending') && p.includes('kind=speak')) {
      if (commandServed) return { ok: true, status: 200, json: async () => ({ commands: [] }) };
      commandServed = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({ commands: [{ id: 1, payload: { text: SPOKEN_TEXT } }] }),
      };
    }

    return { ok: true, status: 200, json: async () => ({ commands: [], alerts: [] }) };
  }));
}

let RobotFaceDisplay;
beforeAll(async () => {
  // browser 모드 + window.SpeechRecognition 없음 → 인식기가 '미지원'으로 조용히 접힌다.
  // 이 파일이 보려는 것은 STT가 아니라 TTS라, 마이크 대역을 통째로 비워 둔다.
  vi.stubEnv('VITE_STT_MODE', 'browser');
  RobotFaceDisplay = (await import('../src/components/RobotFaceDisplay')).default;
});

const STATUS = { isEmergency: false, seniorExpression: 'neutral', battery: 90 };

beforeEach(() => {
  speakSilently = true;
  ttsErrorHeader = null;
  stubFetch();
  stubSpeech();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * 보호자 메시지가 도착해 로봇이 말하기까지 돌린 뒤, 무음 판정 시한까지 마저 넘긴다.
 * 명령 폴링은 2500ms 주기이고, 무음 판정은 발화 시작 후 1500ms다.
 */
async function speakAndSettle() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<RobotFaceDisplay status={STATUS} onStatusChange={() => {}} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2600); });  // 폴링 → 발화
  await act(async () => { await vi.advanceTimersByTimeAsync(1600); });  // 무음 판정 시한
  vi.useRealTimers();
}

test('서버 TTS가 실패했는데 브라우저도 소리를 못 내면 화면에 드러낸다', async () => {
  ttsErrorHeader = 'Gemini%20TTS%20503';
  speakSilently = true;

  await speakAndSettle();

  expect(screen.getByText(new RegExp(SPOKEN_TEXT))).toBeInTheDocument();
  expect(spokenUtterances.length).toBe(1);
  expect(screen.getByText(VOICELESS)).toBeInTheDocument();
});

test('소리가 실제로 났으면 표시하지 않는다', async () => {
  ttsErrorHeader = 'Gemini%20TTS%20503';
  speakSilently = false;   // onstart가 온다 = 소리가 났다

  await speakAndSettle();

  expect(screen.getByText(new RegExp(SPOKEN_TEXT))).toBeInTheDocument();
  expect(screen.queryByText(VOICELESS)).not.toBeInTheDocument();
});

test('provider=browser 정상 경로에서는 조용해도 경고하지 않는다', async () => {
  // 개발 PC는 이 경로로 늘 돈다. 여기까지 경고를 띄우면 곧 아무도 그 표시를 안 믿는다 —
  // 그러면 정작 파이에서 떴을 때 아무 의미가 없어진다.
  ttsErrorHeader = null;   // 헤더 없음 = 합성 실패가 아니라 원래 브라우저가 말하는 설정
  speakSilently = true;

  await speakAndSettle();

  expect(screen.getByText(new RegExp(SPOKEN_TEXT))).toBeInTheDocument();
  expect(screen.queryByText(VOICELESS)).not.toBeInTheDocument();
});
