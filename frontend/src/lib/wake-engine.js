/**
 * 온디바이스 웨이크워드 엔진 어댑터 — 파이 안에서 "돌봄아"를 알아듣는 자리.
 *
 * 왜 있는가: 지금 웨이크워드 판정(lib/wakeword.js의 decideAction)은 **받아쓰기 뒤**에 돈다.
 * "돌봄아"인지 알려면 먼저 Gemini에 올려야 하고, 게이트가 닫혀 있어도 값은 이미 지불된
 * 뒤다 — 2026-09-02 파이에서 한 시간에 100건을 그렇게 태웠다. 이 모듈은 그 순서를
 * 뒤집기 위한 것이다: 로컬에서 먼저 듣고, 통과한 것만 올린다.
 *
 * **로컬 ASR은 "올릴지 말지"만 정한다.** 실제 받아쓰기는 통과한 오디오를 올려 Gemini가
 * 한다. 그래서 로컬 모델의 WER이 대화 품질을 깎지 않는다 — 문법 제한이 공짜인 이유다.
 *
 * lib/stt.js가 VITE_STT_MODE로 인식기를 고르는 것과 **같은 패턴**이다. 엔진을 이 뒤에
 * 감춰 두면 호출부(server-recognizer.js)는 "웨이크워드가 열렸나"만 물어보면 된다.
 *
 * ⚠️ **Porcupine이 아니다.** 2026-09-08 확인: Picovoice가 2026-06-30자로 Free Tier를
 * 폐지하고 기존 무료 AccessKey도 비활성화했다("no non-commercial tier planned").
 * openWakeWord는 상류가 영어 전용이고 사전학습 모델이 CC-BY-NC-SA(비상업)라 역시 막혔다.
 * 남은 무료·한국어·Apache-2.0 경로가 Vosk다. 자세한 경위는 docs/plan-wake-word.md.
 *
 * 모델(82MB)과 wasm은 **동적 import로만** 들어온다 — 엔진을 안 켜면 한 바이트도 안 받는다.
 */

/** 웨이크워드 판정이 이만큼 안 돌아오면 포기한다. 응답 없는 워커에 매달리지 않는다(09-06 교훈). */
const FINISH_TIMEOUT_MS = 3000;

/** Gemini가 16kHz로 낮춰 듣는 것과 같은 값. server-recognizer.js의 SAMPLE_RATE와 맞춘다. */
const SAMPLE_RATE = 16000;

/**
 * 엔진을 만든다. **모델 로딩은 비동기이고, 그 동안 feed()는 조용히 버려진다** —
 * 어르신이 모델을 기다려 줄 리 없으니 준비가 안 됐다고 마이크를 막지는 않는다.
 *
 * @param {object} opts
 * @param {'grammar'|'free'} opts.mode  grammar = 문구 목록으로 어휘를 좁힌다(권장)
 * @param {string} opts.modelUrl        gzip tar 아카이브 주소
 * @param {string[]} [opts.phrases]     grammar 모드에서 인식할 문구
 * @param {() => Promise<object>} [opts.loadVosk]  테스트에서 가짜 모듈을 주입하는 자리
 * @returns {{ready: Promise<object>, feed: Function, finish: Function, dispose: Function}}
 */
export function createWakeEngine({
  mode = 'grammar',
  modelUrl,
  phrases = [],
  loadVosk = () => import('vosk-browser'),
}) {
  let model = null;
  let recognizer = null;
  let disposed = false;
  let usedGrammar = false;
  let feedWarned = false;   // 프레임 오류는 한 번만 알린다 (아래 feed 참고)

  // Kaldi는 스스로 발화 끝을 판단해 result를 흘려보내기도 한다. finish()가 부를 때까지
  // 모아 뒀다가 함께 돌려준다 — 안 그러면 웨이크워드가 그 조각에 담겨 사라진다.
  let collected = [];
  let waiter = null;

  function handleResult(message) {
    const text = message?.result?.text;
    if (typeof text === 'string' && text.trim()) collected.push(text.trim());
    if (waiter) { const w = waiter; waiter = null; w(); }
  }

  async function build() {
    const Vosk = await loadVosk();
    const createModel = Vosk.createModel || Vosk.default?.createModel;
    if (typeof createModel !== 'function') throw new Error('vosk-browser: createModel 없음');

    model = await createModel(modelUrl);
    if (disposed) { model.terminate?.(); return { ok: false, reason: 'disposed' }; }

    // 문법 제한이 이 wasm 빌드·이 모델에서 실제로 먹는지는 해 봐야 안다. 모델 어휘에
    // 없는 낱말이 섞이면 Kaldi가 문법 FST를 못 만든다 — 그때는 자유 발화로 떨어진다.
    // 조용히 죽는 것보다 **덜 정확한 채로 도는 편**이 낫다(측정은 어느 쪽이든 된다).
    if (mode === 'grammar' && phrases.length) {
      try {
        recognizer = new model.KaldiRecognizer(SAMPLE_RATE, JSON.stringify([...phrases, '[unk]']));
        usedGrammar = true;
      } catch (err) {
        console.warn('[WAKE] 문법 제한 실패 — 자유 발화로 떨어진다:', err?.message || err);
      }
    }
    if (!recognizer) recognizer = new model.KaldiRecognizer(SAMPLE_RATE);

    recognizer.on('result', handleResult);
    return { ok: true, grammar: usedGrammar };
  }

  const ready = build().catch((err) => {
    console.warn('[WAKE] 엔진을 못 띄웠다:', err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  });

  return {
    mode,
    /** 실제로 문법 제한이 걸렸는가 (오버레이가 보여 준다) */
    get grammar() { return usedGrammar; },

    /**
     * 발화 프레임 하나를 흘려보낸다. **server-recognizer의 event.inputBuffer 그대로**다 —
     * vosk-browser의 acceptWaveform이 16kHz mono AudioBuffer를 받으므로 변환이 없다.
     */
    feed(audioBuffer) {
      if (disposed || !recognizer) return;
      try {
        recognizer.acceptWaveform(audioBuffer);
      } catch (err) {
        // 한 프레임을 놓치는 것으로 캡처 전체를 멈추지는 않는다.
        // **한 번만 알린다** — 프레임은 초당 4개라, 엔진이 망가진 상태면 콘솔이
        // 이 줄로 가득 차서 정작 봐야 할 로그가 밀려난다.
        if (!feedWarned) {
          feedWarned = true;
          console.warn('[WAKE] acceptWaveform 실패 (이후 같은 오류는 안 알림):', err?.message || err);
        }
      }
    },

    /**
     * 발화가 끝났다. 여태 들은 것을 돌려준다.
     *
     * ⚠️ **겹쳐 부르지 말 것.** 두 발화가 연달아 끝나 이 함수가 겹치면 나중 호출이
     * waiter 를 덮어써 앞 발화의 글자가 뒤 발화에 실린다. 지금은 VAD 가 발화 사이에
     * 침묵(900ms)을 요구하고 판정이 200ms 안팎이라 겹치지 않는다 — Phase 1 에서
     * 업로드 판정이 이걸 await 하게 될 때 이 전제를 다시 볼 것.
     *
     * @returns {Promise<{text: string, ms: number, ready: boolean}>}
     */
    async finish() {
      const startedAt = Date.now();
      if (disposed || !recognizer) {
        return { text: '', ms: 0, ready: false };
      }

      await new Promise((resolve) => {
        let timer = null;
        // result가 오든 시한이 끝나든 한 번만 끝난다. 응답 없는 워커에 매달리지 않는다.
        const settle = () => { clearTimeout(timer); waiter = null; resolve(); };
        waiter = settle;
        timer = setTimeout(settle, FINISH_TIMEOUT_MS);
        try {
          recognizer.retrieveFinalResult();
        } catch {
          settle();
        }
      });

      const text = collected.join(' ').trim();
      collected = [];
      return { text, ms: Date.now() - startedAt, ready: true };
    },

    dispose() {
      disposed = true;
      waiter = null;
      collected = [];
      try { recognizer?.remove(); } catch { /* 이미 정리됨 */ }
      try { model?.terminate(); } catch { /* 이미 정리됨 */ }
      recognizer = null;
      model = null;
    },

    ready,
  };
}
