/**
 * 음성 인식 어댑터 — 두 가지 구현을 같은 인터페이스 뒤에 감춘다.
 *
 * | 모드      | 구현                        | 쓰는 곳                          |
 * |-----------|-----------------------------|----------------------------------|
 * | 'server'  | lib/server-recognizer.js    | **라즈베리파이(기본값)**         |
 * | 'browser' | 이 파일의 Web Speech API    | 개발 PC (윈도우 Chrome)          |
 *
 * 왜 둘 다 남기는가: 파이 OS 저장소의 Chromium은 구글 음성 키 없이 빌드돼 있어
 * Web Speech API가 **매번 network 오류로 끝난다**(2026-09-01 파이 5 실측).
 * 반대로 개발 PC의 Chrome에서는 브라우저 STT가 잘 돌아서 로컬 개발이 편하다.
 * 최종 실행 환경이 파이이므로 **기본값은 'server'** 다.
 * (backend의 TTS_PROVIDER와 같은 패턴이다.)
 *
 * 브라우저 STT의 다른 한계 (2026-08 기준):
 *  - speechContexts(어휘 힌트)를 줄 수 없다. "효돌아", 약 이름, 손주 이름 같은
 *    고유명사를 미리 알려줄 방법이 없어서 노인 발음 대응에 불리하다.
 *  - 신뢰도 점수가 불안정하고, 장시간 세션에서 조용히 끊긴다.
 */

import { createServerRecognizer } from './server-recognizer';

/** 'server' | 'browser'. 기본값은 파이 기준인 'server'. */
export const STT_MODE = import.meta.env.VITE_STT_MODE || 'server';

const SpeechRecognitionImpl =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

const isBrowserSttSupported = () => Boolean(SpeechRecognitionImpl);

/**
 * 지금 모드에서 음성 인식을 쓸 수 있는가.
 *
 * 모드마다 필요한 것이 다르다 — browser는 Web Speech API, server는 getUserMedia다.
 * 둘을 같은 조건으로 보면 파이에서 서버 STT가 멀쩡한데도 "미지원"으로 떨어진다
 * (파이 Chromium에 window.SpeechRecognition 이 없기 때문이다).
 */
export const isSupported = () => (STT_MODE === 'browser'
  ? isBrowserSttSupported()
  : typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia));

/**
 * 되돌릴 수 없는 오류 — 다시 시도해도 같은 결과가 나온다.
 * 마이크 권한 거부, 음성 서비스 자체를 못 쓰는 빌드, 입력 장치 없음, 미지원 언어.
 */
export const FATAL_STT_ERRORS = [
  'not-allowed',
  'service-not-allowed',
  'audio-capture',
  'language-not-supported',
];

/**
 * 오류 심각도를 나눈다 — 'ignorable' | 'fatal' | 'transient'.
 *
 * 'network'를 fatal이 아니라 transient로 두는 것이 중요하다. 진짜 일시적 끊김일 수도 있지만,
 * 구글 음성 키 없이 빌드된 Chromium(라즈베리파이 OS 저장소 빌드가 그럴 수 있다)에서는
 * **매 세션이 network로 끝난다.** 그래서 호출부가 연속 횟수를 세서 판단해야 한다.
 */
export function classifySttError(err) {
  // no-speech(침묵)와 aborted(우리가 직접 멈춤)는 정상 동작의 일부다.
  if (!err || err === 'no-speech' || err === 'aborted') return 'ignorable';
  if (FATAL_STT_ERRORS.includes(err)) return 'fatal';
  return 'transient';
}

/** 브라우저 Web Speech API 구현. 개발 PC 전용 — 파이에서는 동작하지 않는다. */
function createBrowserRecognizer({ onResult, onStart, onEnd, onError, lang }) {
  if (!SpeechRecognitionImpl) {
    return { start() {}, stop() {}, abort() {}, isSupported: false };
  }

  const recognition = new SpeechRecognitionImpl();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = lang;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => { onStart?.(); };
  recognition.onend = () => { onEnd?.(); };

  recognition.onerror = (event) => {
    // ignorable을 오류로 취급하면 로그가 쓸모없어지고 화면이 깜빡인다.
    if (classifySttError(event.error) === 'ignorable') return;
    onError?.(event.error);
  };

  recognition.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    if (!result || !result.isFinal) return;

    const alternative = result[0];
    if (!alternative || !alternative.transcript) return;

    onResult(alternative.transcript.trim(), {
      // Chrome은 confidence를 0으로 주는 경우가 잦다. 0이면 "모름"으로 취급한다.
      confidence: typeof alternative.confidence === 'number' ? alternative.confidence : 0,
    });
  };

  return {
    isSupported: true,
    start() {
      try {
        recognition.start();
      } catch {
        // 이미 실행 중이면 예외가 난다 — 정상이므로 무시
      }
    },
    stop() {
      try {
        recognition.stop();
      } catch {
        /* 이미 멈춤 */
      }
    },
    abort() {
      try {
        recognition.abort();
      } catch {
        /* 이미 멈춤 */
      }
    },
  };
}

/**
 * 음성 인식기를 만든다. 구현은 STT_MODE가 고른다.
 *
 * @param {object} opts
 * @param {(text: string, meta: {confidence: number}) => void} opts.onResult  최종 인식 결과
 * @param {() => void} [opts.onStart]
 * @param {() => void} [opts.onEnd]
 * @param {(err: string) => void} [opts.onError]  무시해도 되는 오류는 전달하지 않는다
 * @param {string} [opts.lang='ko-KR']  browser 모드에서만 쓰인다
 * @returns {{start: () => void, stop: () => void, abort: () => void, isSupported: boolean}}
 */
export function createRecognizer({ onResult, onStart, onEnd, onError, lang = 'ko-KR' }) {
  if (STT_MODE === 'browser') {
    return createBrowserRecognizer({ onResult, onStart, onEnd, onError, lang });
  }
  return createServerRecognizer({ onResult, onStart, onEnd, onError });
}
