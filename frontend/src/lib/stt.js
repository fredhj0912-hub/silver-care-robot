/**
 * 음성 인식 어댑터.
 *
 * 지금은 브라우저 Web Speech API 하나뿐이지만, 이 인터페이스 뒤로 감춰둔다.
 * 실사용에서 어르신 발음 인식률이 부족하면 서버 STT(Cloud STT)로 교체할 수 있게 하기 위함이다.
 *
 * 브라우저 STT의 실제 한계 (2026-08 기준):
 *  - Chrome은 오디오를 구글 서버로 보내 인식하므로 정확도 자체는 Cloud STT와 같은 계열이다.
 *  - 다만 speechContexts(어휘 힌트)를 줄 수 없다. "효돌아", 약 이름, 손주 이름 같은
 *    고유명사를 미리 알려줄 방법이 없어서 노인 발음 대응에 불리하다.
 *  - 신뢰도 점수가 불안정하고, 장시간 세션에서 조용히 끊긴다.
 *
 * 교체 시점에는 createRecognizer 만 다른 구현으로 바꾸면 된다.
 */

const SpeechRecognitionImpl =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

export const isSupported = () => Boolean(SpeechRecognitionImpl);

/**
 * 연속 음성 인식기를 만든다.
 *
 * @param {object} opts
 * @param {(text: string, meta: {confidence: number}) => void} opts.onResult  최종 인식 결과
 * @param {() => void} [opts.onStart]
 * @param {() => void} [opts.onEnd]
 * @param {(err: string) => void} [opts.onError]  무시해도 되는 오류는 전달하지 않는다
 * @param {string} [opts.lang='ko-KR']
 * @returns {{start: () => void, stop: () => void, abort: () => void, isSupported: boolean}}
 */
export function createRecognizer({ onResult, onStart, onEnd, onError, lang = 'ko-KR' }) {
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
    // no-speech(침묵)와 aborted(우리가 직접 멈춤)는 정상 동작의 일부다.
    // 이걸 오류로 취급하면 로그가 쓸모없어지고 화면이 깜빡인다.
    if (event.error === 'no-speech' || event.error === 'aborted') return;
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
