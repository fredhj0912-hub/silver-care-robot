const { config } = require('../config');

/**
 * Gemini 멀티턴 대화 히스토리.
 *
 * 이전 구현(server.js:37-44)의 버그:
 *   conversationHistory.slice(-16) — **메시지 개수**로 잘랐다.
 *   홀수 지점에서 잘리면 결과가 'model' 역할로 시작하는데,
 *   Gemini startChat 은 히스토리가 'user'로 시작할 것을 요구한다.
 *   → 대화가 길어지면 어느 순간부터 매 요청이 예외로 떨어졌다.
 *
 * 여기서는 항상 'user'로 시작하도록 보정한다.
 */

let history = [];
let lastInteractionAt = Date.now();

/**
 * 히스토리를 최근 N턴으로 자르되 항상 'user'로 시작하게 만든다.
 * 순수 함수 — 단위 테스트 대상.
 */
function trimToTurns(messages, maxTurns) {
  let trimmed = messages.slice(-(maxTurns * 2));
  // 잘린 앞머리가 model이면 그 짝 없는 응답을 버린다
  while (trimmed.length && trimmed[0].role !== 'user') {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

function isStale(now = Date.now()) {
  return now - lastInteractionAt > config.sessionTimeoutMs;
}

/** 세션 타임아웃 검사. 이전에는 Gemini 분기 안에서만 호출돼 mock 경로에서는 영영 리셋되지 않았다. */
function touch() {
  if (isStale()) {
    history = [];
    console.log('세션 타임아웃 — 대화 히스토리를 초기화했습니다');
  }
  lastInteractionAt = Date.now();
}

function get() {
  return trimToTurns(history, config.maxHistoryTurns);
}

function push(role, text) {
  history.push({ role, parts: [{ text }] });
  history = trimToTurns(history, config.maxHistoryTurns);
}

function reset() {
  history = [];
  lastInteractionAt = Date.now();
}

/**
 * 서버 재시작 시 DB에서 최근 대화를 복원한다.
 * 이전에는 히스토리가 프로세스 메모리에만 있어 재시작하면 어르신과의 맥락이 통째로 사라졌다.
 */
function restoreFrom(messages) {
  const restored = [];
  for (const m of messages) {
    if (m.sender === 'senior') restored.push({ role: 'user', parts: [{ text: m.text }] });
    else if (m.sender === 'robot') restored.push({ role: 'model', parts: [{ text: m.text }] });
  }
  history = trimToTurns(restored, config.maxHistoryTurns);
  return history.length;
}

module.exports = { trimToTurns, isStale, touch, get, push, reset, restoreFrom };
