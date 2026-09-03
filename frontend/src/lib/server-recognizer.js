/**
 * 서버측 음성 인식기 — 마이크를 직접 녹음해 백엔드(POST /api/stt)로 보낸다.
 *
 * 왜 있는가: 라즈베리파이 OS 저장소의 Chromium은 구글 음성 키 없이 빌드돼 있어
 * Web Speech API가 **매번 network 오류로 끝난다**(2026-09-01 파이 5 실측).
 * ARM64 리눅스용 정식 Chrome 빌드가 없어 브라우저를 바꾸는 것은 경로가 아니었다.
 *
 * **lib/stt.js의 createRecognizer와 같은 인터페이스를 지킨다.** 그래서 호출부
 * (RobotFaceDisplay.jsx)와 웨이크워드 게이트(lib/wakeword.js)는 한 줄도 바뀌지 않는다.
 * 오류 코드도 Web Speech API의 것을 그대로 쓴다 — classifySttError가 계속 통한다.
 *
 * **브라우저 STT와 다른 점 하나**: 이쪽 세션은 스스로 끊기지 않는다. 그래서
 * stop()은 마이크를 닫는 것이 아니라 **캡처를 멈추는 것**이고, 마이크 스트림과
 * AudioContext는 살려 둔다. 매번 getUserMedia를 다시 부르면 파이에서 권한
 * 대화상자가 다시 뜰 수 있고(TODO.md 백로그 항목), 어르신이 말할 때마다 수백 ms가
 * 낭비된다. 완전한 정리는 abort()에서만 한다.
 *
 * AudioWorklet이 아니라 ScriptProcessorNode를 쓰는 이유: 워클릿은 별도 모듈 파일을
 * addModule()로 불러야 해서 Vite 에셋 처리에 의존한다. dev에서는 되고 프로덕션
 * 빌드에서 깨지는 종류의 문제이고, **그 차이가 파이에서만 드러난다.**
 * deprecated지만 모든 Chromium에서 동작하고 추가 파일이 없는 쪽을 골랐다.
 */

import { apiFetch } from './api';
import { encodeWav, wavToDataUri, rms } from './wav';
import { createVadState, feedEnergy, resetSpeech } from './vad';

// Gemini가 어차피 16kHz로 낮춰 듣는다. AudioContext에 직접 요구하면 브라우저가
// 리샘플링해 주므로 우리가 다운샘플 코드를 쓸 일이 없다.
const SAMPLE_RATE = 16000;
// 2의 거듭제곱이어야 한다. 4096 @ 16kHz = 256ms — VAD 판정에 충분히 촘촘하다.
const FRAME_SIZE = 4096;

export function createServerRecognizer({ onResult, onStart, onEnd, onError, vadOptions, onVad, dryRun }) {
  let stream = null;
  let audioContext = null;
  let processor = null;
  let source = null;
  let muteNode = null;

  let capturing = false;    // stop()으로 잠시 멈춘 상태와 구분한다
  let opening = false;      // getUserMedia 중복 호출 방지
  let destroyed = false;    // abort() 이후에는 어떤 콜백도 부르지 않는다

  let buffered = [];        // 발화 중 모은 Float32Array 조각들
  let bufferedLength = 0;
  const vad = createVadState(vadOptions);

  const dropBuffer = () => { buffered = []; bufferedLength = 0; };

  async function transcribe() {
    const merged = new Float32Array(bufferedLength);
    let at = 0;
    for (const chunk of buffered) { merged.set(chunk, at); at += chunk.length; }
    dropBuffer();

    const dataUri = wavToDataUri(encodeWav(merged, SAMPLE_RATE));

    let res;
    try {
      res = await apiFetch('/api/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: dataUri }),
      });
    } catch {
      // 터널이 끊겼거나 EC2가 죽었다. transient — 호출부가 연속 횟수로 판단한다.
      if (!destroyed) onError?.('network');
      return;
    }
    if (destroyed) return;

    if (res.status === 503) {
      // 백엔드가 받아쓰기를 아예 못 하는 상태(키 없음). 재시도해도 같다.
      onError?.('service-not-allowed');
      return;
    }
    if (!res.ok) {
      onError?.('network');
      return;
    }

    const data = await res.json().catch(() => null);
    if (destroyed) return;

    const text = data && typeof data.text === 'string' ? data.text.trim() : '';
    // 빈 결과는 침묵과 같다 — Web Speech API의 no-speech에 해당하고, 그쪽에서도
    // ignorable이라 콜백을 부르지 않는다. 여기서도 조용히 넘어간다.
    if (!text) return;

    // 서버 STT에는 대안 후보별 신뢰도가 없다. Chrome도 0을 주는 일이 잦아
    // 호출부가 이미 "0 = 모름"으로 다루므로 그 관례를 따른다.
    onResult(text, { confidence: 0 });
  }

  function handleFrame(event) {
    if (!capturing || destroyed) return;
    const input = event.inputBuffer.getChannelData(0);
    const frameMs = (input.length / SAMPLE_RATE) * 1000;
    const energy = rms(input);
    const verdict = feedEnergy(vad, energy, frameMs);

    if (verdict !== 'idle') {
      // 'started'/'speaking'/'ended'/'discarded' 모두 이 프레임까지가 발화의 일부다.
      // 복사해서 담는다 — inputBuffer는 다음 프레임에서 재사용된다.
      buffered.push(new Float32Array(input));
      bufferedLength += input.length;
    }

    // 관측은 idle 프레임까지 흘려보낸다 — 임계값을 맞추려면 "말하지 않을 때
    // 바닥이 얼마인가"가 "말할 때 얼마인가"만큼 중요하다.
    // 길이는 vad.speechMs가 아니라 모아 둔 오디오에서 잰다 — 발화가 끝나는 프레임에서
    // feedEnergy가 이미 상태를 초기화해 speechMs가 0이기 때문이다.
    onVad?.({
      rms: energy,
      verdict,
      speechMs: (bufferedLength / SAMPLE_RATE) * 1000,
      startThreshold: vad.startThreshold,
      endThreshold: vad.endThreshold,
      uploads: !dryRun,
    });

    if (verdict === 'idle') return;

    // 너무 짧아 버리는 경우. onEnd를 부르지 않는다 — 세션은 계속 살아 있다.
    if (verdict === 'discarded') { dropBuffer(); return; }
    if (verdict !== 'ended') return;

    // 관측 모드에서는 발화 경계만 보여 주고 업로드하지 않는다. 임계값을 맞추는
    // 일에 Gemini 할당량이 들지 않게 하는 것이 이 스위치의 존재 이유다.
    if (dryRun) { dropBuffer(); return; }

    // 발화가 끝났다. 업로드하는 동안에도 캡처는 계속 돈다 —
    // 어르신이 이어서 말하면 그것도 다음 발화로 잡아야 한다.
    transcribe();
  }

  async function open() {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // 로봇 자기 목소리를 되받아쓰는 것을 브라우저 단에서 한 번 걸러 준다.
        // (진짜 게이트는 호출부의 isSpeakingRef — 말하는 동안 stop()이 불린다)
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(FRAME_SIZE, 1, 1);
    processor.onaudioprocess = handleFrame;
    source.connect(processor);
    // ScriptProcessorNode는 목적지에 연결돼야 콜백이 돈다. 마이크 소리를 그대로
    // 스피커로 내보내면 하울링이 나므로 gain 0인 노드를 사이에 둔다.
    muteNode = audioContext.createGain();
    muteNode.gain.value = 0;
    processor.connect(muteNode);
    muteNode.connect(audioContext.destination);
  }

  function teardown() {
    try { processor?.disconnect(); } catch { /* 이미 끊김 */ }
    try { muteNode?.disconnect(); } catch { /* 이미 끊김 */ }
    try { source?.disconnect(); } catch { /* 이미 끊김 */ }
    try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* 이미 멈춤 */ }
    try { audioContext?.close(); } catch { /* 이미 닫힘 */ }
    processor = null; muteNode = null; source = null; stream = null; audioContext = null;
  }

  /** getUserMedia 실패를 Web Speech API의 오류 코드로 옮긴다 (classifySttError가 읽는다) */
  function reportOpenFailure(err) {
    const name = err && err.name;
    // 권한 거부와 장치 없음 모두 되돌릴 수 없다 — 둘 다 FATAL_STT_ERRORS에 있다.
    if (name === 'NotAllowedError' || name === 'SecurityError') onError?.('not-allowed');
    else onError?.('audio-capture');
  }

  return {
    // getUserMedia는 보안 컨텍스트에서만 존재한다. 호출부가 이것을 보고
    // '아래에 글로 말씀해 주세요'로 안내한다.
    isSupported: typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia),

    start() {
      if (destroyed || capturing || opening) return;

      // 이미 열려 있으면 캡처만 다시 켠다. 로봇이 한 마디 할 때마다
      // getUserMedia를 다시 부르지 않기 위한 것이다.
      if (audioContext) {
        // 여기는 stop()을 거쳐야만 도달한다 — 버퍼와 VAD는 그쪽에서 이미 비웠다.
        capturing = true;
        onStart?.();
        return;
      }

      opening = true;
      open().then(() => {
        opening = false;
        if (destroyed) { teardown(); return; }
        capturing = true;
        onStart?.();
      }).catch((err) => {
        opening = false;
        if (destroyed) return;
        reportOpenFailure(err);
        onEnd?.();
      });
    },

    /** 캡처만 멈춘다. 마이크와 AudioContext는 살려 둔다 (위 주석 참고). */
    stop() {
      if (destroyed || !capturing) return;
      capturing = false;
      resetSpeech(vad);
      dropBuffer();
      onEnd?.();
    },

    /** 완전히 정리한다. 언마운트 때만 부른다. */
    abort() {
      destroyed = true;
      capturing = false;
      resetSpeech(vad);
      dropBuffer();
      teardown();
    },
  };
}
