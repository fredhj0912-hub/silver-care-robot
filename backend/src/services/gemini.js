const { config } = require('../config');
const prompts = require('./prompts');
const history = require('./history');

let GoogleGenerativeAI = null;
try {
  ({ GoogleGenerativeAI } = require('@google/generative-ai'));
} catch {
  console.log('@google/generative-ai 를 불러오지 못했습니다 — mock 대화로 동작합니다');
}

// 클라이언트는 한 번만 만든다. 이전에는 요청마다 new GoogleGenerativeAI(...) 를 호출했다.
let client = null;
function getClient() {
  if (!GoogleGenerativeAI || !config.geminiApiKey) return null;
  if (!client) client = new GoogleGenerativeAI(config.geminiApiKey);
  return client;
}

const isAvailable = () => Boolean(getClient());

const ALLOWED_EMOTIONS = ['happy', 'neutral', 'sad', 'concerned', 'thinking'];
const ALLOWED_EXPRESSIONS = ['happy', 'sad', 'neutral', 'pain', 'sleeping', 'unknown'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 잠시 후 다시 시도하면 풀릴 수 있는 오류인가 (모델 과부하, 쿼터, 게이트웨이) */
function isTransient(err) {
  return /\[(429|500|502|503|504)\s/.test(String(err && err.message));
}

/**
 * 모델 호출을 재시도와 대체 모델로 감싼다.
 *
 * 실제로 겪은 상황: gemini-3.7-flash 가 503(수요 폭주)을 연달아 반환했다.
 * 재시도가 없으면 어르신은 그 시간 동안 통조림 mock 응답만 듣게 되고,
 * 서버 로그를 보지 않는 한 아무도 눈치채지 못한다.
 *
 * @param {(modelId: string) => Promise<any>} call
 * @returns {Promise<{result: any, modelUsed: string}>}
 */
async function withRetry(call, { retries = config.geminiRetries, deadline = null } = {}) {
  const chain = [config.geminiModel];
  if (config.geminiFallbackModel && config.geminiFallbackModel !== config.geminiModel) {
    chain.push(config.geminiFallbackModel);
  }

  let lastErr;
  for (const modelId of chain) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      // 시한이 있으면 **다음 시도를 시작하기 전에** 확인한다.
      // 이미 늦었는데 한 번 더 부르면 그만큼 더 기다리게 된다.
      if (deadline && Date.now() >= deadline) throw lastErr || new Error('시간 초과');
      try {
        return { result: await call(modelId), modelUsed: modelId };
      } catch (err) {
        lastErr = err;
        if (!isTransient(err)) throw err;           // 잘못된 키/요청은 재시도해도 소용없다
        if (attempt < retries) {
          await sleep(config.geminiRetryDelayMs * (attempt + 1));
        }
      }
    }
    console.warn(`${modelId} 일시 오류가 계속됩니다 — 다음 모델로 전환합니다`);
  }
  throw lastErr;
}

/** 코드펜스를 걷어내고 JSON을 파싱한다. 실패하면 null. */
function parseJSON(raw) {
  const cleaned = String(raw).replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // 모델이 JSON 앞뒤에 말을 붙인 경우
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* 아래로 */ }
    }
    return null;
  }
}

/**
 * mock 대화 폴백. Gemini가 없거나 실패했을 때만 쓴다.
 * 예전에는 이 경로로 떨어져도 응답이 겉보기에 정상이라 아무도 알아채지 못했다.
 * 이제 호출부가 source:'mock'을 응답에 실어 화면에 표시한다.
 */
function mockReply(text) {
  const t = String(text || '');
  if (t.includes('날씨') || t.includes('비') || t.includes('눈') || t.includes('더워') || t.includes('추워')) {
    return { text: '오늘 날씨는 아주 화창해요! 방 안 환기를 한번 시켜주시면 상쾌해질 것 같아요.', emotion: 'happy' };
  }
  if (t.includes('밥') || t.includes('배고파') || t.includes('식사') || t.includes('먹었')) {
    return { text: '어르신, 식사는 제때 꼭 챙겨 드셔야 해요. 물도 한 잔 잊지 마세요!', emotion: 'happy' };
  }
  if (t.includes('심심') || t.includes('외로') || t.includes('노래') || t.includes('말동무')) {
    return { text: '제가 곁에 늘 있으니 외로워하지 마세요! 언제든 말을 걸어주세요.', emotion: 'happy' };
  }
  if (t.includes('안녕') || t.includes('고마워') || t.includes('사랑')) {
    return { text: '헤헤, 저도 어르신이 제일 좋아요! 오늘도 저랑 즐겁게 지내요.', emotion: 'happy' };
  }
  return { text: '네 어르신, 효돌이가 늘 곁에서 말씀 잘 듣고 있어요. 오늘 하루는 어떻게 보내고 계신가요?', emotion: 'neutral' };
}

/**
 * 어르신 발화에 대한 응답을 생성한다.
 * @returns {{text: string, emotion: string, source: 'gemini'|'mock', error: string|null}}
 */
async function chat(text, seniorExpression) {
  const userTurn = prompts.buildUserTurn(text, seniorExpression);
  history.touch();

  const genAI = getClient();
  if (genAI) {
    try {
      const { result, modelUsed } = await withRetry(async (modelId) => {
        const model = genAI.getGenerativeModel({
          model: modelId,
          systemInstruction: prompts.CHAT_SYSTEM_INSTRUCTION,
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: 1000,
            temperature: 0.7,
          },
        });
        return (await model.startChat({ history: history.get() }).sendMessage(userTurn)).response.text();
      });

      const parsed = parseJSON(result);

      if (parsed && typeof parsed.text === 'string' && parsed.text.trim()) {
        const reply = {
          text: parsed.text.trim(),
          emotion: ALLOWED_EMOTIONS.includes(parsed.emotion) ? parsed.emotion : 'neutral',
        };
        // 성공한 턴만 히스토리에 넣는다 (파싱 실패 응답으로 맥락을 오염시키지 않는다)
        history.push('user', userTurn);
        history.push('model', JSON.stringify(reply));
        return { ...reply, source: 'gemini', model: modelUsed, error: null };
      }

      console.error('Gemini 응답을 JSON으로 파싱하지 못했습니다:', String(result).slice(0, 200));
      return { ...mockReply(text), source: 'mock', error: 'parse_failed' };
    } catch (err) {
      // 조용히 삼키지 않는다 — 호출부가 이 사실을 화면까지 전달한다
      console.error('Gemini 호출 실패 → mock 폴백:', err.message);
      return { ...mockReply(text), source: 'mock', error: err.message };
    }
  }

  return { ...mockReply(text), source: 'mock', error: config.geminiApiKey ? 'sdk_unavailable' : 'no_api_key' };
}

/**
 * 카메라 스냅샷을 분석한다.
 * @param {string} dataUri  data:image/...;base64,...
 */
async function analyzeImage(dataUri) {
  const fallback = {
    hasPerson: true, isEmergency: false, expression: 'neutral',
    confidence: 0, summary: '어르신 생활 모니터링 중', source: 'mock', error: null,
  };

  const genAI = getClient();
  if (!genAI) return { ...fallback, error: config.geminiApiKey ? 'sdk_unavailable' : 'no_api_key' };

  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUri);
  if (!match) return { ...fallback, error: 'bad_data_uri' };

  try {
    const { result } = await withRetry(async (modelId) => {
      const model = genAI.getGenerativeModel({
        model: modelId,
        // chat 경로에는 있었는데 vision 경로에는 빠져 있어 문자열 스캔에 의존하고 있었다
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      });
      // 이전 코드는 Buffer.from(x,'base64').toString('base64') 로 왕복시켰다 — 그냥 x와 같다.
      const r = await model.generateContent([
        prompts.VISION_PROMPT,
        { inlineData: { data: match[2], mimeType: match[1] } },
      ]);
      return r.response.text();
    });

    const parsed = parseJSON(result);
    if (!parsed) return { ...fallback, error: 'parse_failed' };

    return {
      hasPerson: typeof parsed.hasPerson === 'boolean' ? parsed.hasPerson : true,
      isEmergency: parsed.isEmergency === true,
      expression: ALLOWED_EXPRESSIONS.includes(parsed.expression) ? parsed.expression : 'neutral',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : fallback.summary,
      source: 'gemini',
      error: null,
    };
  } catch (err) {
    console.error('Gemini Vision 호출 실패:', err.message);
    return { ...fallback, error: err.message };
  }
}

/**
 * 받아쓰기 결과를 다듬는다.
 *
 * 프롬프트로 "문장만 출력하라"고 못박아도 모델은 조용한 오디오에 대해
 * "(음성 없음)" 같은 메타 주석이나 따옴표를 붙여 오는 일이 있다. 그것이 그대로
 * 나가면 웨이크워드 게이트가 사람 말로 착각한다 — 여기서 걸러 빈 문자열로 만든다.
 */
function cleanTranscript(raw) {
  let t = String(raw || '').trim();
  // 통째로 따옴표에 싸여 온 경우
  const quoted = /^["'“‘]([\s\S]*)["'”’]$/.exec(t);
  if (quoted) t = quoted[1].trim();
  // 통째로 괄호에 싸인 것은 받아쓴 말이 아니라 모델의 주석이다
  if (/^[([{<][\s\S]*[)\]}>]$/.test(t)) return '';
  return t;
}

/**
 * 발화 오디오를 받아쓴다 (서버측 STT).
 *
 * 파이의 Chromium은 브라우저 음성 인식이 구조적으로 불가능하다 — 파이 OS 저장소의
 * 배포판이 구글 음성 키 없이 빌드돼 있어 매번 network 오류로 끝난다(2026-09-01 실측).
 * analyzeImage와 같은 inlineData 경로를 쓰므로 재시도·대체 모델(withRetry)이
 * 그대로 적용된다.
 *
 * @param {string} dataUri  data:audio/...;base64,...
 * @returns {{text: string, source: 'gemini'|'mock', error: string|null}}
 */
async function transcribeAudio(dataUri) {
  const fallback = { text: '', source: 'mock', error: null };

  const genAI = getClient();
  if (!genAI) return { ...fallback, error: config.geminiApiKey ? 'sdk_unavailable' : 'no_api_key' };

  const match = /^data:(audio\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUri);
  if (!match) return { ...fallback, error: 'bad_data_uri' };

  // 대화(chat)와 달리 **늦게 온 받아쓰기는 쓸모가 없다** — 어르신은 이미 돌아섰고,
  // 그 사이에 한 다른 말과 뒤섞인다. 그래서 시한을 두고 넘기면 실패로 처리한다.
  const deadline = Date.now() + config.sttTimeoutMs;

  try {
    const { result } = await withRetry(async (modelId) => {
      const model = genAI.getGenerativeModel({
        model: modelId,
        // JSON을 강제하지 않는다 — 받아쓰기 결과는 순수 텍스트다.
        // temperature 0: 들린 말을 그대로 옮기는 일에 창의성은 해롭기만 하다.
        generationConfig: { temperature: 0, maxOutputTokens: 256 },
      });
      const r = await model.generateContent([
        prompts.STT_PROMPT,
        { inlineData: { data: match[2], mimeType: match[1] } },
      ]);
      return r.response.text();
      // 같은 모델을 재시도하지 않는다(retries: 0). 다음 발화에서 자연스럽게 다시
      // 시도되므로 여기서 기다릴 이유가 없다. 대체 모델로 넘어가는 것은 남겨 둔다 —
      // 한쪽만 붐비는 경우가 있다. 2026-09-02 실측: 체인을 다 돌면 50초까지 갔다.
    }, { retries: 0, deadline });

    return { text: cleanTranscript(result), source: 'gemini', error: null };
  } catch (err) {
    const reason = Date.now() >= deadline ? `시간 초과 (${config.sttTimeoutMs}ms)` : err.message;
    console.error('Gemini STT 호출 실패:', reason);
    // **빈 문자열로 조용히 성공시키지 않는다.** 화면에서 '침묵'과 구분되지 않아
    // 어르신이 말을 걸었는데 아무 일도 안 일어난 것처럼 보인다(2026-09-02 실측).
    return { ...fallback, error: reason };
  }
}

module.exports = { chat, analyzeImage, transcribeAudio, isAvailable, parseJSON, mockReply, cleanTranscript, withRetry };
