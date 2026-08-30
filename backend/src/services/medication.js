const medicationsRepo = require('../repositories/medications');
const commandsRepo = require('../repositories/commands');
const emergency = require('./emergency');
const { emit, EVENTS } = require('./events');

/**
 * 복약 알림 — 일정이 되면 효돌이가 소리 내어 알리고, 어르신 대답으로 복용을 확인한다.
 *
 * 알림 전달은 새 경로를 만들지 않고 기존 `outbound_commands` 큐(kind: 'speak')를 탄다.
 * 로봇 키오스크가 이미 2.5초마다 이 큐를 폴링해 읽어주고 웨이크워드 게이트까지 열어주므로
 * (`RobotFaceDisplay.jsx`), 어르신이 "효돌아"를 다시 부르지 않고 바로 대답할 수 있다.
 */

// 복용 시각이 이만큼 지나도록 확인이 없으면 미복용(missed)으로 넘긴다.
const GRACE_MS = 2 * 60 * 60 * 1000;

// 24시간 내 미복용이 이 횟수 이상일 때만 보호자에게 알린다.
// 한 번 거른 것은 알림이 아니다 — 약 한 번에 알림을 보내기 시작하면 보호자가 알림을
// 꺼버리고, 그게 이 시스템 최악의 실패 모드다 (CLAUDE.md 규칙 5).
const MISSED_ALERT_COUNT = 3;

// "먹었어" 같은 짧은 대답은 방금 알림을 받은 직후에만 복용 확인으로 인정한다.
const RECENT_REMINDER_MS = 10 * 60 * 1000;

// 부정이 먼저다 — "아직 안 먹었어"에도 '먹었'이 들어 있으므로 이걸 먼저 걸러야 한다.
const NOT_YET_PHRASES = [
  '아직 안 먹', '아직 못 먹', '안 먹었', '못 먹었',
  '나중에 먹', '이따 먹', '있다 먹', '조금 있다',
];

// 약을 명시한 확인. 이것만으로 복용 처리한다.
const TAKEN_PHRASES = [
  '약 먹었', '약을 먹었', '약은 먹었', '약 챙겨 먹', '약 다 먹었', '약 먹음',
];

// 약을 명시하지 않은 짧은 확인. **방금 알림을 받은 경우에만** 인정한다 —
// "밥 먹었어"를 복약 확인으로 오인하면 보호자는 약을 드신 줄 알고 넘어간다.
// 놓치는 쪽(보호자가 직접 표시)이 잘못 표시하는 쪽보다 훨씬 안전하다.
const BARE_TAKEN_PHRASES = ['먹었어', '먹었지', '먹었습니다', '먹었다', '다 먹었'];

const findPhrase = (text, phrases) => phrases.find((p) => text.includes(p)) || null;

/**
 * 발화를 분류한다. 순수 함수 — DB나 시각에 의존하지 않으므로 단위 테스트 가능.
 * `emergency.classifyUtterance()`와 같은 형태다.
 *
 * @returns {{intent: 'taken'|'not_yet'|null, matched: string|null, needsRecentReminder: boolean}}
 */
function classifyUtterance(rawText) {
  const text = String(rawText || '').trim();
  const none = { intent: null, matched: null, needsRecentReminder: false };
  if (!text) return none;

  const notYet = findPhrase(text, NOT_YET_PHRASES);
  if (notYet) return { intent: 'not_yet', matched: notYet, needsRecentReminder: false };

  const taken = findPhrase(text, TAKEN_PHRASES);
  if (taken) return { intent: 'taken', matched: taken, needsRecentReminder: false };

  const bare = findPhrase(text, BARE_TAKEN_PHRASES);
  if (bare) return { intent: 'taken', matched: bare, needsRecentReminder: true };

  return none;
}

/**
 * 어르신 발화를 복약 확인으로 해석한다. `routes/chat.js`가 부른다.
 * @returns {object|null} 복용 처리된 일정, 해당 없으면 null
 */
async function evaluateUtterance(text, now = new Date()) {
  const { intent, needsRecentReminder } = classifyUtterance(text);
  if (intent !== 'taken') return null;

  // 이미 지난 미복용 건만 대상이다 — 아침 발화로 저녁 약이 복용 처리되면 안 된다.
  const pending = await medicationsRepo.latestPendingBefore(now.toISOString());
  if (!pending) return null;

  if (needsRecentReminder) {
    const remindedAt = pending.remindedAt ? new Date(pending.remindedAt).getTime() : 0;
    if (now.getTime() - remindedAt > RECENT_REMINDER_MS) return null;
  }

  const { found, medication } = await medicationsRepo.markTaken(pending.id, 'senior');
  if (!found) return null;

  console.log(`[MEDICATION] 복용 확인 (어르신 음성): ${medication.medicineName}`);
  return medication;
}

function reminderText({ medicineName, notes }) {
  const base = `${medicineName} 드실 시간이에요.`;
  return notes ? `${base} ${notes}` : base;
}

/**
 * 스케줄러 한 틱. `server.js`가 1분마다 호출한다.
 * 테스트에서 직접 부를 수 있도록 시각을 주입받는다.
 *
 * @returns {{reminded: number, missed: number, alert: object|null}}
 */
async function tick(now = new Date()) {
  const nowIso = now.toISOString();

  // 1) 시간이 된 약을 로봇이 말하도록 큐에 넣는다. 유예 시간을 넘긴 건은 제외한다
  //    (로봇이 꺼져 있다 켜졌을 때 밀린 알림을 쏟아내지 않기 위함 — repo의 due() 참고).
  const graceStart = new Date(now.getTime() - GRACE_MS).toISOString();
  let reminded = 0;
  for (const med of await medicationsRepo.due(nowIso, graceStart)) {
    // 틱이 겹쳐 돌아도 같은 약을 두 번 말하지 않는다 — 스탬프에 성공한 쪽만 큐에 넣는다.
    if (!(await medicationsRepo.markReminded(med.id))) continue;

    const command = await commandsRepo.enqueue({
      kind: 'speak',
      payload: { text: reminderText(med), label: '복약 알림' },
    });
    emit(EVENTS.COMMAND_ISSUED, command);
    reminded += 1;
    console.log(`[MEDICATION] 복약 알림 발화 예약: ${med.medicineName} (${med.scheduledAt})`);
  }

  // 2) 유예 시간이 지나도 확인이 없으면 미복용으로 넘긴다.
  const missed = await medicationsRepo.markMissedBefore(graceStart);

  // 3) 반복해서 거를 때만 보호자에게 알린다. severity는 항상 'warning' —
  //    raise()는 critical일 때만 푸시를 보내므로 여기서 푸시가 나가는 일은 없다.
  let alert = null;
  if (missed > 0) {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const count = await medicationsRepo.countMissedSince(since);
    if (count >= MISSED_ALERT_COUNT) {
      alert = await emergency.raise({
        type: 'medication_missed',
        severity: 'warning',
        description: `24시간 안에 약을 ${count}번 거르셨습니다. 보호자 확인이 필요합니다.`,
      });
    }
  }

  return { reminded, missed, alert };
}

module.exports = {
  classifyUtterance,
  evaluateUtterance,
  tick,
  reminderText,
  GRACE_MS,
  MISSED_ALERT_COUNT,
  RECENT_REMINDER_MS,
};
