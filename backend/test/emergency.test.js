const test = require('node:test');
const assert = require('node:assert');
const { classifyUtterance } = require('../src/services/emergency');

/**
 * 응급 판정은 이 시스템에서 가장 안전에 직결되는 로직이다.
 * - 놓치면 어르신이 위험해진다.
 * - 오탐이 반복되면 보호자가 알림을 꺼버려 결국 같은 결과가 된다.
 */

test('위급 발화는 critical 로 분류한다', () => {
  const critical = [
    '살려줘',
    '사람 살려',
    '도와줘 일어날 수가 없어',
    '119 좀 불러줘',
    '넘어졌어',
    '가슴이 아프고 답답해',
    '숨을 못 쉬겠어',
    '숨이 안 쉬어져',
    '죽을 것 같아',
    '피가 나',
    '못 일어나겠어',
  ];
  for (const text of critical) {
    assert.strictEqual(classifyUtterance(text).severity, 'critical', `놓침: "${text}"`);
  }
});

test('건강 호소는 warning 으로 분류한다 (한 번으로는 알림이 되지 않는다)', () => {
  for (const text of ['오늘 좀 어지러워', '무릎이 아파', '요즘 잠이 안 와', '기운이 없네']) {
    assert.strictEqual(classifyUtterance(text).severity, 'warning', `분류 실패: "${text}"`);
  }
});

test('무해한 발화를 응급으로 오인하지 않는다 (구버전 오탐 회귀)', () => {
  // 이전 구현은 키워드에 '숨'이 단독으로 들어 있어 아래가 전부 응급으로 잡혔다.
  const benign = [
    '한숨 한 번 쉬었어',
    '숨쉬기 운동을 했어',
    '숨기고 싶은 게 있어',
    '한숨 돌리고 나니 좋네',
    '오늘 날씨 참 좋다',
    '밥 맛있게 먹었어',
    '손주가 놀러 왔어',
  ];
  for (const text of benign) {
    assert.strictEqual(classifyUtterance(text).severity, null, `오탐: "${text}"`);
  }
});

test('빈 입력을 안전하게 처리한다', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.strictEqual(classifyUtterance(v).severity, null);
  }
});

test('critical 이 warning 보다 우선한다', () => {
  // '아파'(warning)와 '가슴이 아프'(critical)가 동시에 있는 문장
  assert.strictEqual(classifyUtterance('가슴이 아프고 다리도 아파').severity, 'critical');
});
