/**
 * 웨이크워드 게이팅 — 로봇이 언제 "듣고 반응할지"를 결정한다.
 *
 * 이전 구현은 인식된 모든 발화를 그대로 /api/chat 으로 보냈다.
 * TV 소리, 혼잣말, 전화 통화까지 전부 로봇이 대답했고,
 * 어르신 입장에서는 로봇이 아무 때나 끼어드는 것으로 느껴진다.
 *
 * 이 모듈은 순수 함수만 담는다(테스트 가능). 타이머와 상태는 컴포넌트가 관리한다.
 */

/** 대화 창이 열려 있는 시간. 이 안에 말하면 웨이크워드 없이 이어진다. */
export const ACTIVE_WINDOW_MS = 30_000;

/**
 * 웨이크워드와 그 오인식 변형.
 *
 * 노인 발음 + STT 오인식이 겹치므로 정확히 "효돌아"로 들어올 것을 기대하면 안 된다.
 * 실제로 브라우저 STT는 "효돌아"를 "요돌아", "표돌아", "효도라" 등으로 자주 돌려준다.
 */
const WAKE_VARIANTS = [
  '효돌아', '효돌이', '효도리', '효돌', '효도라', '효돌라',
  '요돌아', '요돌이', '요돌', '유돌아', '휴돌아', '휴돌이',
  '표돌아', '표돌이', '쇼돌아', '초돌아', '조돌아',
  '효툴아', '효둘아', '효놀아', '효몰아',
  '효도라이', '효도날', '요도리', '효토리',
];

/**
 * 웨이크워드를 건너뛰는 발화.
 *
 * 넘어진 어르신이 "효돌아, 도와줘"라고 격식을 갖춰 부를 것이라 기대할 수 없다.
 * 안전 관련 발화는 게이트 상태와 무관하게 항상 통과시킨다.
 *
 * 백엔드 services/emergency.js 의 CRITICAL_PHRASES 와 목적이 다르다는 점에 유의:
 * 여기는 "로봇이 반응할지"를 정하고, 백엔드는 "보호자에게 알릴지"를 정한다.
 * 여기 목록이 더 넓어도 안전하다 — 로봇이 대답만 하고 알림은 안 갈 수 있다.
 */
const BYPASS_PHRASES = [
  '살려', '도와', '도와줘', '도와주세요', '구해',
  '119', '구급차', '응급',
  '아파', '아프', '쓰러', '넘어졌', '넘어져',
  '숨이', '숨을', '가슴이',
  '못 일어나', '일어날 수가', '움직일 수가',
  '무서워', '누구 없어', '사람 없어',
];

/** 공백·문장부호를 없애 비교한다. STT는 띄어쓰기를 제멋대로 넣는다. */
function normalize(text) {
  return String(text || '').replace(/[\s.,!?~"'·]/g, '');
}

/** 발화에 웨이크워드(또는 그 오인식 변형)가 들어 있는가 */
export function containsWakeWord(text) {
  const t = normalize(text);
  if (!t) return false;
  return WAKE_VARIANTS.some((v) => t.includes(v));
}

/** 게이트를 우회해야 하는 발화인가 (안전 관련) */
export function isBypassUtterance(text) {
  const t = normalize(text);
  if (!t) return false;
  return BYPASS_PHRASES.some((p) => t.includes(normalize(p)));
}

/**
 * 웨이크워드 이후의 실제 용건만 남긴다.
 * "효돌아 오늘 날씨 어때" → "오늘 날씨 어때"
 * 웨이크워드만 부른 경우("효돌아") 빈 문자열이 된다.
 */
export function stripWakeWord(text) {
  let out = String(text || '');
  for (const v of WAKE_VARIANTS) {
    // 원문의 띄어쓰기를 허용하도록 각 글자 사이에 \s* 를 넣는다
    const pattern = v.split('').map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    out = out.replace(new RegExp(`${pattern}[\\s,.!?~]*`, 'gi'), ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 인식 결과가 실제 발화인지 잡음인지 판정한다.
 *
 * 브라우저 STT는 기침, 문 닫히는 소리, TV 웅얼거림에도 짧은 조각을 돌려준다.
 * 이런 걸 그대로 Gemini에 보내면 로봇이 엉뚱한 대답을 지어낸다.
 */
export function isMeaningfulUtterance(text) {
  const t = normalize(text);
  if (t.length < 2) return false;
  // 자음·모음만 있는 조각 (ㅋㅋ, ㅇㅇ, ㅡㅡ 등)
  if (/^[ㄱ-ㅎㅏ-ㅣ]+$/.test(t)) return false;
  // 같은 글자 반복 ("아아아", "음음음")
  if (t.length <= 4 && new Set(t).size === 1) return false;
  return true;
}

/**
 * 발화를 어떻게 처리할지 결정한다. 게이팅의 핵심 함수.
 *
 * @param {string} transcript  STT가 인식한 원문
 * @param {boolean} isActive   대화 창이 열려 있는가
 * @returns {{action: 'ignore'|'acknowledge'|'send', text: string, reason: string}}
 *   ignore      — 아무것도 하지 않는다 (잡음, 게이트 밖의 일반 발화)
 *   acknowledge — 웨이크워드만 불렀다. 창을 열고 "네, 어르신" 정도로 응답
 *   send        — /api/chat 으로 보낸다
 */
export function decideAction(transcript, isActive) {
  const raw = String(transcript || '').trim();

  if (!isMeaningfulUtterance(raw)) {
    return { action: 'ignore', text: '', reason: 'noise' };
  }

  // 안전 관련 발화는 게이트와 무관하게 항상 통과
  if (isBypassUtterance(raw)) {
    return { action: 'send', text: stripWakeWord(raw) || raw, reason: 'bypass' };
  }

  if (containsWakeWord(raw)) {
    const rest = stripWakeWord(raw);
    return rest
      ? { action: 'send', text: rest, reason: 'wake+command' }
      : { action: 'acknowledge', text: '', reason: 'wake-only' };
  }

  if (isActive) {
    return { action: 'send', text: raw, reason: 'active-window' };
  }

  return { action: 'ignore', text: '', reason: 'dormant' };
}

/** 웨이크워드만 불렀을 때 로봇이 돌려줄 응답 (API 호출 없이 즉시) */
export const ACKNOWLEDGE_REPLIES = [
  '네 어르신, 듣고 있어요.',
  '네, 무슨 일이세요?',
  '네! 말씀하세요.',
];

export function pickAcknowledgeReply() {
  return ACKNOWLEDGE_REPLIES[Math.floor(Math.random() * ACKNOWLEDGE_REPLIES.length)];
}
