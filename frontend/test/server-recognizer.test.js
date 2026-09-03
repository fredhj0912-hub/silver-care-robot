import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServerRecognizer } from '../src/lib/server-recognizer';

/**
 * 인식기 자체의 계약을 확인한다 — 화면을 거치면 웨이크워드 게이트에 가려서
 * 안 보이는 것들이 있다(빈 받아쓰기가 그렇다. 게이트가 어차피 걸러내므로
 * 컴포넌트 테스트로는 가드를 지워도 통과해 버린다).
 *
 * 특히 **stop()이 마이크를 닫지 않는다**는 것이 중요하다. 브라우저 인식기와
 * 다른 유일한 지점이고, 여기가 틀리면 로봇이 한 마디 할 때마다 getUserMedia가
 * 다시 불려서 파이에서 권한 대화상자가 뜬다.
 */

let frameHandler = null;
let stoppedTracks = 0;
let closedContexts = 0;

class FakeAudioContext {
  constructor({ sampleRate }) { this.sampleRate = sampleRate; this.destination = {}; }
  createMediaStreamSource() { return { connect: () => {} }; }
  createGain() { return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} }; }
  createScriptProcessor() {
    return { connect: () => {}, disconnect: () => {}, set onaudioprocess(fn) { frameHandler = fn; } };
  }
  close() { closedContexts += 1; }
}

function frame(amplitude) {
  const data = new Float32Array(4096).fill(amplitude);
  frameHandler?.({ inputBuffer: { getChannelData: () => data } });
}

/** 한 발화: 시끄러운 구간 → 침묵 */
function utter(frames = 4) {
  for (let i = 0; i < frames; i++) frame(0.2);
  for (let i = 0; i < 5; i++) frame(0.001);
}

let getUserMediaCalls;
let fetchImpl;

beforeEach(() => {
  frameHandler = null;
  stoppedTracks = 0;
  closedContexts = 0;
  getUserMediaCalls = 0;
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ text: '안녕하세요' }) });

  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('fetch', vi.fn((...a) => fetchImpl(...a)));
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      getUserMedia: async () => {
        getUserMediaCalls += 1;
        return { getTracks: () => [{ stop: () => { stoppedTracks += 1; } }] };
      },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

/** 인식기를 만들고 마이크가 열릴 때까지 기다린다 */
async function open(handlers = {}, vadOptions) {
  const cbs = { onResult: vi.fn(), onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn(), ...handlers };
  const r = createServerRecognizer({ ...cbs, vadOptions });
  r.start();
  // onStart까지 기다려야 캡처가 실제로 켜진 것이다 — frameHandler만 보면
  // 아직 capturing=false 라서 먹인 프레임이 조용히 버려진다.
  await vi.waitFor(() => expect(cbs.onStart).toHaveBeenCalled());
  return { r, cbs };
}

test('start()에서 마이크를 열고 onStart를 부른다', async () => {
  const { cbs } = await open();
  expect(cbs.onStart).toHaveBeenCalledTimes(1);
  expect(getUserMediaCalls).toBe(1);
});

test('발화가 끝나면 받아쓴 결과를 onResult로 넘긴다', async () => {
  const { cbs } = await open();
  utter();
  await vi.waitFor(() => expect(cbs.onResult).toHaveBeenCalledWith('안녕하세요', { confidence: 0 }));
});

test('빈 받아쓰기는 침묵과 같다 — onResult를 부르지 않는다', async () => {
  // 브라우저 STT의 no-speech가 ignorable인 것과 같은 취급이다. 이것이 없으면
  // 조용한 방에서 빈 결과가 계속 흘러들어 sttFailStreak이 영원히 0으로 리셋된다.
  //
  // '안 불렸다'는 그냥 기다려서는 증명이 안 된다(아직 안 온 것과 구분이 안 된다).
  // 빈 발화 다음에 진짜 발화를 하나 더 보내, onResult가 **그것 하나만** 받았는지 본다.
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ text: '   ' }) });
  const { cbs } = await open();
  utter();

  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ text: '효돌아' }) });
  utter();

  await vi.waitFor(() => expect(cbs.onResult).toHaveBeenCalled());
  expect(cbs.onResult).toHaveBeenCalledTimes(1);
  expect(cbs.onResult).toHaveBeenCalledWith('효돌아', { confidence: 0 });
  expect(cbs.onError).not.toHaveBeenCalled();
});

test('네트워크가 끊기면 transient(network)로 알린다', async () => {
  fetchImpl = async () => { throw new Error('tunnel down'); };
  const { cbs } = await open();
  utter();
  await vi.waitFor(() => expect(cbs.onError).toHaveBeenCalledWith('network'));
});

test('백엔드가 503이면 되돌릴 수 없는 오류로 알린다', async () => {
  fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({ reason: 'no_api_key' }) });
  const { cbs } = await open();
  utter();
  await vi.waitFor(() => expect(cbs.onError).toHaveBeenCalledWith('service-not-allowed'));
});

test('stop()은 캡처만 멈춘다 — 마이크는 살려 둔다', async () => {
  const { r, cbs } = await open();
  r.stop();
  expect(cbs.onEnd).toHaveBeenCalledTimes(1);
  expect(stoppedTracks).toBe(0);          // 마이크는 그대로
  expect(closedContexts).toBe(0);

  // 멈춘 동안에는 아무리 시끄러워도 서버로 보내지 않는다 (로봇이 말하는 중)
  utter();
  expect(fetch).not.toHaveBeenCalled();

  // 다시 켜도 getUserMedia를 새로 부르지 않는다
  r.start();
  expect(getUserMediaCalls).toBe(1);
  expect(cbs.onStart).toHaveBeenCalledTimes(2);
  utter();
  await vi.waitFor(() => expect(cbs.onResult).toHaveBeenCalled());
});

/** 지금까지 서버로 보낸 발화들의 프레임 수 (한 프레임 = 4096샘플 = 256ms) */
function sentFrames() {
  return fetch.mock.calls
    .filter((c) => String(c[0]).includes('/api/stt'))
    .map((c) => (atob(JSON.parse(c[1].body).audio.split(',')[1]).length - 44) / 2 / 4096);
}

/**
 * 두 테스트가 같은 방식으로 확인한다 — 방해(stop/start)를 받은 발화가
 * **방해 없는 같은 발화와 똑같이** 서버에 도착하는가.
 *
 * 프레임 수를 숫자로 박지 않는 이유: VAD 상수에 딸린 값이라 임계값을 조정하면
 * 테스트가 통째로 거짓말이 된다. 개수까지 함께 보는 이유: 어긋나면 발화가
 * **잘리는 것이 아니라 둘로 쪼개져** 길이만으로는 우연히 같아 보일 수 있다.
 */
async function expectSameAsUninterrupted(vadOptions, interrupt) {
  const a = await open({}, vadOptions);
  utter(3);
  await vi.waitFor(() => expect(a.cbs.onResult).toHaveBeenCalled());
  expect(sentFrames()).toHaveLength(1);
  const baseline = sentFrames()[0];

  frameHandler = null;
  const b = await open({}, vadOptions);
  await interrupt(b);
  utter(3);
  await vi.waitFor(() => expect(b.cbs.onResult).toHaveBeenCalled());

  // 대조군 1건 + 실험군 1건. 3건이면 발화가 쪼개진 것이다.
  expect(sentFrames()).toEqual([baseline, baseline]);
}

test('stop() 중에 모인 소리는 버린다 — 로봇 목소리가 다음 발화에 섞이지 않게', async () => {
  await expectSameAsUninterrupted(undefined, async (b) => {
    for (let i = 0; i < 3; i++) frame(0.2);   // 로봇이 말하기 직전까지 들어온 소리
    b.r.stop();
    b.r.start();
  });
});

test('stop()은 발화 길이도 초기화한다 — 다음 발화가 상한에 일찍 걸리지 않게', async () => {
  // 초기화하지 않으면 stop() 이전에 쌓인 speechMs가 남아, 로봇이 한 마디 한 뒤
  // 어르신의 다음 말이 maxSpeechMs에 걸려 중간에 잘린다(그리고 나머지가
  // 별도 발화로 한 번 더 올라간다).
  await expectSameAsUninterrupted({ maxSpeechMs: 1200 }, async (b) => {
    for (let i = 0; i < 3; i++) frame(0.2);
    b.r.stop();
    b.r.start();
  });
});

test('abort()는 마이크를 완전히 놓아준다', async () => {
  const { r } = await open();
  r.abort();
  expect(stoppedTracks).toBe(1);
  expect(closedContexts).toBe(1);
});

test('abort() 뒤에는 어떤 콜백도 부르지 않는다', async () => {
  const { r, cbs } = await open();
  r.abort();
  cbs.onStart.mockClear();
  r.start();
  utter();
  expect(cbs.onStart).not.toHaveBeenCalled();
  expect(cbs.onResult).not.toHaveBeenCalled();
});

test('start()를 연달아 불러도 마이크를 두 번 열지 않는다', async () => {
  const r = createServerRecognizer({ onResult: vi.fn(), onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() });
  r.start();
  r.start();
  r.start();
  await vi.waitFor(() => expect(frameHandler).not.toBeNull());
  expect(getUserMediaCalls).toBe(1);
});

test('권한 거부는 되돌릴 수 없는 오류로 옮긴다', async () => {
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: async () => { const e = new Error('x'); e.name = 'NotAllowedError'; throw e; } },
  });
  const cbs = { onResult: vi.fn(), onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() };
  createServerRecognizer(cbs).start();
  await vi.waitFor(() => expect(cbs.onError).toHaveBeenCalledWith('not-allowed'));
});

test('마이크 장치가 없으면 audio-capture로 옮긴다', async () => {
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: async () => { const e = new Error('x'); e.name = 'NotFoundError'; throw e; } },
  });
  const cbs = { onResult: vi.fn(), onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() };
  createServerRecognizer(cbs).start();
  await vi.waitFor(() => expect(cbs.onError).toHaveBeenCalledWith('audio-capture'));
});

/**
 * 관측 모드(?vad=1) — 임계값을 맞추는 일에 Gemini 할당량이 들지 않아야 한다.
 * 발화 한 번이 받아쓰기 1건 + 대화 1건이라, 이 스위치가 없으면 임계값 탐색
 * 20번으로 하루치가 사라진다(2026-09-02 확인).
 */
test('dryRun이면 발화를 잡되 서버로 보내지 않는다', async () => {
  const onVad = vi.fn();
  const cbs = { onResult: vi.fn(), onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() };
  const r = createServerRecognizer({ ...cbs, onVad, dryRun: true });
  r.start();
  await vi.waitFor(() => expect(cbs.onStart).toHaveBeenCalled());

  utter();

  // 발화 경계는 그대로 관측된다 — 화면에서 "잡혔다"가 보여야 조정을 할 수 있다.
  await vi.waitFor(() => expect(onVad.mock.calls.some(([i]) => i.verdict === 'ended')).toBe(true));
  expect(fetch).not.toHaveBeenCalled();
  expect(cbs.onResult).not.toHaveBeenCalled();
});

test('dryRun 발화는 다음 발화에 섞이지 않는다', async () => {
  // 보내지 않는다고 버퍼를 안 비우면, 관측 모드를 끄고 처음 말하는 순간
  // 그동안 쌓인 소리가 전부 한 요청으로 올라간다.
  const first = await open();
  utter(3);
  await vi.waitFor(() => expect(first.cbs.onResult).toHaveBeenCalled());
  const baseline = sentFrames()[0];

  frameHandler = null;
  fetch.mockClear();
  const dry = createServerRecognizer({
    onResult: vi.fn(), onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn(),
    onVad: vi.fn(), dryRun: true,
  });
  dry.start();
  await vi.waitFor(() => expect(frameHandler).not.toBeNull());
  utter(3);
  utter(3);
  expect(fetch).not.toHaveBeenCalled();

  // 같은 인식기에서 dryRun을 끈 상태와 비교할 수는 없으므로(모듈 생성 시 고정),
  // 새 인식기로 같은 발화를 보내 대조군과 길이가 같은지 본다.
  frameHandler = null;
  const wet = await open();
  utter(3);
  await vi.waitFor(() => expect(wet.cbs.onResult).toHaveBeenCalled());
  expect(sentFrames()).toEqual([baseline]);
});

test('onVad는 조용한 프레임(idle)도 흘려보낸다', async () => {
  // 임계값을 맞추려면 "말하지 않을 때 바닥이 얼마인가"를 봐야 한다.
  const onVad = vi.fn();
  const cbs = { onResult: vi.fn(), onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() };
  createServerRecognizer({ ...cbs, onVad, dryRun: true }).start();
  await vi.waitFor(() => expect(cbs.onStart).toHaveBeenCalled());

  frame(0.001);
  expect(onVad).toHaveBeenCalledTimes(1);
  expect(onVad.mock.calls[0][0]).toMatchObject({ verdict: 'idle', startThreshold: 0.02 });
  expect(onVad.mock.calls[0][0].rms).toBeCloseTo(0.001, 5);
});

test('vadOptions로 넘긴 임계값이 실제 판정에 쓰인다', async () => {
  // URL 파라미터(?vadstart=…)가 여기까지 닿지 않으면 현장에서 값을 바꿀 방법이
  // EC2 재빌드뿐이 된다.
  const onVad = vi.fn();
  const cbs = { onResult: vi.fn(), onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() };
  createServerRecognizer({ ...cbs, onVad, dryRun: true, vadOptions: { startThreshold: 0.005 } }).start();
  await vi.waitFor(() => expect(cbs.onStart).toHaveBeenCalled());

  frame(0.01);   // 기본값(0.02) 아래, 넘긴 값(0.005) 위
  expect(onVad.mock.calls[0][0]).toMatchObject({ verdict: 'started', startThreshold: 0.005 });
});
