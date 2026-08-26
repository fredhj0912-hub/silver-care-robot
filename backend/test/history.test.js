const test = require('node:test');
const assert = require('node:assert');
const { trimToTurns } = require('../src/services/history');

const user = (t) => ({ role: 'user', parts: [{ text: t }] });
const model = (t) => ({ role: 'model', parts: [{ text: t }] });

/**
 * 이전 구현은 slice(-16) 으로 **메시지 개수**만 보고 잘랐다.
 * 홀수 지점에서 잘리면 결과가 'model' 로 시작하는데,
 * Gemini startChat 은 히스토리가 'user' 로 시작할 것을 요구한다.
 * → 긴 대화에서 어느 순간부터 매 요청이 예외로 떨어졌다.
 */

test('턴 수 이내면 그대로 둔다', () => {
  const h = [user('1'), model('1'), user('2'), model('2')];
  assert.deepStrictEqual(trimToTurns(h, 8), h);
});

test('최근 N턴만 남긴다', () => {
  const h = [];
  for (let i = 0; i < 20; i++) { h.push(user(`u${i}`)); h.push(model(`m${i}`)); }
  const trimmed = trimToTurns(h, 3);
  assert.strictEqual(trimmed.length, 6);
  assert.strictEqual(trimmed[0].parts[0].text, 'u17');
});

test('자른 결과는 항상 user 로 시작한다 (구버전 버그 회귀)', () => {
  const h = [];
  for (let i = 0; i < 20; i++) { h.push(user(`u${i}`)); h.push(model(`m${i}`)); }

  // 앞에 짝 없는 model 응답이 있어 경계가 어긋나는 경우
  const offset = [model('orphan'), ...h];
  for (let turns = 1; turns <= 10; turns++) {
    const trimmed = trimToTurns(offset, turns);
    if (trimmed.length) {
      assert.strictEqual(trimmed[0].role, 'user', `maxTurns=${turns} 에서 model 로 시작함`);
    }
  }
});

test('model 로만 이루어진 히스토리는 전부 버린다', () => {
  assert.deepStrictEqual(trimToTurns([model('a'), model('b')], 4), []);
});

test('빈 히스토리를 안전하게 처리한다', () => {
  assert.deepStrictEqual(trimToTurns([], 8), []);
});
