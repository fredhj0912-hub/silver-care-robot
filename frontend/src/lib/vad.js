/**
 * 발화 감지(VAD) 상태기계.
 *
 * 서버측 STT는 "언제부터 언제까지가 한 발화인가"를 스스로 정해야 한다. 브라우저
 * 음성 인식은 그 경계를 알아서 잡아 줬지만, 우리가 직접 녹음하면 그 일도 우리 몫이다.
 *
 * 경계를 잘못 잡으면 두 방향으로 나빠진다:
 *  - 너무 민감하면 → 방 안의 모든 소리가 Gemini로 올라간다(호출 비용 + 오인식)
 *  - 너무 둔하면  → 어르신이 조용히 말했을 때 로봇이 아예 못 듣는다
 *
 * **오디오 없이 RMS 숫자열만으로 검증할 수 있도록 순수 함수로 분리했다.**
 * 실제 마이크 배선(server-recognizer.js)은 이 상태기계에 숫자만 먹인다.
 */

export const DEFAULTS = {
  // 발화로 칠 최소 에너지.
  //
  // **2026-09-03 파이 실측(reSpeaker 4-Mic Array)으로 이 값이 맞는 것을 확인했다.**
  // 조용한 방 바닥 0.0015 / 작게 말할 때 0.06 / 평소 말투 0.15 — 바닥의 13배 위,
  // 가장 작은 발화의 1/3 아래에 앉아 있다. 양쪽으로 여유가 있어 손댈 이유가 없다.
  // 다시 재려면 ?vad=1 을 붙인다(lib/vad-debug.js) — 할당량을 쓰지 않는다.
  startThreshold: 0.02,
  // 발화가 끝났다고 볼 에너지. 시작보다 낮게 둔다(히스테리시스) — 같은 값이면
  // 임계값 근처에서 켜졌다 꺼졌다 하며 한 문장이 여러 조각으로 잘린다.
  endThreshold: 0.012,
  // 이만큼 조용하면 발화가 끝난 것으로 본다. 어르신은 문장 중간에 쉬는 일이 잦아
  // 짧게 잡으면 말이 토막난다. 09-03 실측에서 쉼표가 든 긴 문장이 한 발화로 남았다.
  silenceMs: 900,
  // 이보다 짧으면 기침·문 닫는 소리로 보고 버린다. Gemini 호출을 아끼는 1차 방어선.
  minSpeechMs: 400,
  // 이보다 길면 강제로 끊는다. 마이크가 켜진 채 방치돼도 요청 하나가 커지지 않게.
  maxSpeechMs: 12000,
};

/**
 * @param {Partial<typeof DEFAULTS>} [opts]
 * @returns {object} 상태 객체 — feedEnergy가 제자리에서 갱신한다
 */
export function createVadState(opts = {}) {
  return {
    ...DEFAULTS,
    ...opts,
    speaking: false,
    speechMs: 0,
    silenceMs_: 0,
  };
}

/**
 * 프레임 하나를 먹인다.
 *
 * @param {object} state       createVadState()가 만든 객체 (제자리 갱신됨)
 * @param {number} energy      이 프레임의 RMS
 * @param {number} frameMs     이 프레임의 길이(ms)
 * @returns {'idle'|'started'|'speaking'|'ended'|'discarded'}
 *   'started'   — 이 프레임에서 발화가 시작됐다
 *   'ended'     — 발화가 끝났다. 모아 둔 오디오를 보낼 시점이다
 *   'discarded' — 발화가 끝났지만 너무 짧아 버린다(보내지 않는다)
 */
export function feedEnergy(state, energy, frameMs) {
  if (!state.speaking) {
    if (energy < state.startThreshold) return 'idle';
    state.speaking = true;
    state.speechMs = frameMs;
    state.silenceMs_ = 0;
    return 'started';
  }

  state.speechMs += frameMs;

  // 상한을 넘으면 조용해지길 기다리지 않고 끊는다. 여기까지 왔으면 길이는 충분하므로
  // 'discarded'가 아니라 항상 'ended'다.
  if (state.speechMs >= state.maxSpeechMs) {
    resetSpeech(state);
    return 'ended';
  }

  if (energy >= state.endThreshold) {
    state.silenceMs_ = 0;
    return 'speaking';
  }

  state.silenceMs_ += frameMs;
  if (state.silenceMs_ < state.silenceMs) return 'speaking';

  // 끝났다. 침묵 구간은 발화 길이에서 빼고 판단한다 — 안 그러면 silenceMs(900ms)만으로도
  // minSpeechMs(400ms)를 넘겨 버려서 최소 길이 검사가 아무것도 걸러내지 못한다.
  const voicedMs = state.speechMs - state.silenceMs_;
  resetSpeech(state);
  return voicedMs >= state.minSpeechMs ? 'ended' : 'discarded';
}

/** 말하는 중이던 것을 취소한다 (로봇이 말하기 시작할 때 등) */
export function resetSpeech(state) {
  state.speaking = false;
  state.speechMs = 0;
  state.silenceMs_ = 0;
}
