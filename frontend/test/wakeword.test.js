import test from 'node:test';
import assert from 'node:assert';
import {
  containsWakeWord,
  isBypassUtterance,
  isMeaningfulUtterance,
  stripWakeWord,
  decideAction,
} from '../src/lib/wakeword.js';

/**
 * 게이팅이 잘못되면 두 방향 모두 실패가 된다:
 *  - 너무 좁으면 어르신이 로봇을 불러도 반응하지 않는다
 *  - 너무 넓으면 TV 소리와 혼잣말에 로봇이 끼어든다
 * 그리고 응급 우회가 깨지면 넘어진 어르신의 "도와줘"가 무시된다.
 */

test('웨이크워드와 STT 오인식 변형을 인식한다', () => {
  const shouldMatch = [
    '효돌아',
    '효돌이',
    '효돌아 뭐해',
    '효 돌아 이리 와봐',        // STT가 띄어쓰기를 넣은 경우
    '요돌아',                     // 흔한 오인식
    '표돌아 밥 먹었니',
    '휴돌이',
    '효도리야',
    '효돌아!',
  ];
  for (const t of shouldMatch) {
    assert.ok(containsWakeWord(t), `인식 실패: "${t}"`);
  }
});

test('관계 없는 말을 웨이크워드로 오인하지 않는다', () => {
  const shouldNotMatch = [
    '오늘 날씨 좋네',
    '효자손 어디 갔지',
    '돌아가신 어머니 생각이 나',
    '효과가 좋더라',
    '밥 먹었어',
    '',
  ];
  for (const t of shouldNotMatch) {
    assert.ok(!containsWakeWord(t), `오인식: "${t}"`);
  }
});

test('웨이크워드를 떼고 용건만 남긴다', () => {
  assert.strictEqual(stripWakeWord('효돌아 오늘 날씨 어때'), '오늘 날씨 어때');
  assert.strictEqual(stripWakeWord('효돌이, 밥 먹었니?'), ', 밥 먹었니?'.replace(/^,\s*/, '') || '밥 먹었니?');
  assert.strictEqual(stripWakeWord('효돌아'), '');
  assert.strictEqual(stripWakeWord('효돌아!!'), '');
});

test('응급 발화는 웨이크워드 없이도 통과한다 (안전 핵심)', () => {
  const emergencies = [
    '도와줘',
    '살려주세요',
    '아이고 아파',
    '넘어졌어',
    '숨이 안 쉬어져',
    '119 불러줘',
    '못 일어나겠어',
    '무서워',
  ];
  for (const t of emergencies) {
    assert.ok(isBypassUtterance(t), `우회 실패: "${t}"`);
    // dormant 상태(창이 닫힌 상태)에서도 반드시 전송되어야 한다
    assert.strictEqual(decideAction(t, false).action, 'send', `dormant에서 무시됨: "${t}"`);
  }
});

test('잡음과 무의미한 조각을 걸러낸다', () => {
  for (const t of ['ㅋㅋ', 'ㅇㅇ', 'ㅡ', '아', '음', '아아아', '  ', '']) {
    assert.ok(!isMeaningfulUtterance(t), `잡음으로 걸러지지 않음: "${t}"`);
  }
  for (const t of ['안녕', '밥 먹었어', '오늘 날씨 좋다']) {
    assert.ok(isMeaningfulUtterance(t), `정상 발화가 걸러짐: "${t}"`);
  }
});

test('dormant: 웨이크워드 없는 일반 발화는 무시한다 (TV 소리 대응)', () => {
  const tv = [
    '다음 뉴스입니다',
    '오늘의 주요 소식을 전해드리겠습니다',
    '이 제품은 지금 주문하시면',
  ];
  for (const t of tv) {
    const d = decideAction(t, false);
    assert.strictEqual(d.action, 'ignore', `dormant에서 반응함: "${t}" (${d.reason})`);
  }
});

test('active: 창이 열려 있으면 웨이크워드 없이 대화가 이어진다', () => {
  const d = decideAction('그럼 내일은 비가 오나', true);
  assert.strictEqual(d.action, 'send');
  assert.strictEqual(d.reason, 'active-window');
  assert.strictEqual(d.text, '그럼 내일은 비가 오나');
});

test('웨이크워드만 부르면 창만 열고 API를 부르지 않는다', () => {
  const d = decideAction('효돌아', false);
  assert.strictEqual(d.action, 'acknowledge');
  assert.strictEqual(d.reason, 'wake-only');
});

test('웨이크워드 + 용건은 용건만 전송한다', () => {
  const d = decideAction('효돌아 오늘 날씨 어때', false);
  assert.strictEqual(d.action, 'send');
  assert.strictEqual(d.text, '오늘 날씨 어때');
});

test('active 상태에서도 잡음은 여전히 무시한다', () => {
  assert.strictEqual(decideAction('ㅋㅋ', true).action, 'ignore');
});
