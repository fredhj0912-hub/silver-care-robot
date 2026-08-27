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
async function withRetry(call) {
  const chain = [config.geminiModel];
  if (config.geminiFallbackModel && config.geminiFallbackModel !== config.geminiModel) {
    chain.push(config.geminiFallbackModel);
  }

  let lastErr;
  for (const modelId of chain) {
    for (let attempt = 0; attempt <= config.geminiRetries; attempt++) {
      try {
        return { result: await call(modelId), modelUsed: modelId };
      } catch (err) {
        lastErr = err;
        if (!isTransient(err)) throw err;           // 잘못된 키/요청은 재시도해도 소용없다
        if (attempt < config.geminiRetries) {
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

module.exports = { chat, analyzeImage, isAvailable, parseJSON, mockReply };
