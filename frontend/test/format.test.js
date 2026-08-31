import { test } from 'vitest';
import assert from 'node:assert';
import { buildDailyNote } from '../src/guardian/format.js';

/**
 * 보호자가 읽는 "오늘 어땠나" 문장. 여기서 기분을 말하려면 근거가 어르신의 표정이어야
 * 한다. 예전에는 summary.emotionCounts(= 로봇이 어떤 표정으로 말했는지)를 세고 있어서
 * 문장이 가리키는 대상이 틀려 있었다.
 *
 * 어휘가 두 가지라는 점이 함정이다:
 *   어르신 표정 : happy | sad | neutral | pain | sleeping | unknown
 *   로봇 발화   : happy | neutral | sad | concerned | thinking
 */

const textOf = (note) => (note || []).map((part) => part.t).join('');

test('어르신 표정이 있으면 그것으로 기분을 말한다', () => {
  const note = buildDailyNote({ conversationTurns: 3, seniorEmotionCounts: { happy: 4, sad: 1 } });
  assert.match(textOf(note), /좋으셨어요/);
});

test('부정 표정이 더 많으면 기운이 없다고 말한다 (pain도 부정으로 센다)', () => {
  const note = buildDailyNote({ conversationTurns: 3, seniorEmotionCounts: { happy: 1, pain: 2 } });
  assert.match(textOf(note), /기운이 조금 없어/);
});

test('카메라가 꺼져 있으면 기분을 아예 말하지 않는다', () => {
  // 로봇 발화 emotion만 있는 상태 — 예전 코드는 이걸로 "좋으셨어요"를 만들었다.
  const note = buildDailyNote({ conversationTurns: 3, emotionCounts: { happy: 5 }, seniorEmotionCounts: {} });
  const text = textOf(note);
  assert.doesNotMatch(text, /좋으셨어요|기운이 조금 없어|힘들어하시는/,
    '표정 근거가 없는데 기분을 단정했다 (로봇 발화를 어르신 기분으로 착각한 예전 동작)');
  assert.match(text, /이야기를 나눴어요/, '대화 횟수 문장까지 사라지면 안 된다');
});

test('중립/수면만 관찰된 날은 힘들어하지 않으셨다고 말한다', () => {
  const note = buildDailyNote({ conversationTurns: 1, seniorEmotionCounts: { neutral: 3, sleeping: 2 } });
  assert.match(textOf(note), /힘들어하시는 기색은 없었어요/);
});
