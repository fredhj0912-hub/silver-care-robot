const alertsRepo = require('../repositories/alerts');
const { config } = require('../config');
const { emit, EVENTS } = require('./events');

/**
 * 응급 판정 — 음성/비전/수동 트리거가 모두 이 파일 하나를 거친다.
 *
 * 이전 구현(server.js:47)의 문제:
 *   EMERGENCY_KEYWORDS = ['아프','가슴','숨','넘어져','죽을 것 같','죽고 싶','힘들','괴롭','우울']
 *   - '숨' 단독 매칭이 "한숨", "숨쉬기 운동", "숨기다"에 전부 걸렸다.
 *   - '힘들', '우울'은 일상 대화에 흔해 "오늘 좀 힘들었지만 괜찮아"도 응급이 됐다.
 *   - 매칭될 때마다 알림이 무제한 적재되고 isEmergency가 래치됐다.
 *
 * 이제 2단으로 나눈다:
 *   critical → 즉시 알림 (문구 단위 매칭)
 *   warning  → 즉시 알리지 않고, 24시간 내 반복될 때만 승격
 *
 * 오탐 알림이 반복되면 보호자가 알림을 꺼버린다. 그게 이 시스템 최악의 실패 모드다.
 */

// 즉시 알림. 부분 단어가 아니라 문구로 매칭해 오탐을 줄인다.
const CRITICAL_PHRASES = [
  '살려줘', '살려 줘', '사람 살려', '도와줘', '도와 줘', '도와주세요',
  '119', '구급차', '응급실',
  '쓰러졌', '쓰러질', '넘어졌', '넘어져', '자빠졌',
  '숨이 안', '숨을 못', '숨쉬기 힘들', '숨이 차', '숨이 막',
  '가슴이 아프', '가슴이 답답', '가슴이 조이', '심장이',
  '피가 나', '피를 흘',
  '죽을 것 같', '죽겠어', '죽고 싶',
  '움직일 수 없', '일어날 수 없', '못 일어나',
];

// 누적 관찰 대상. 한 번으로는 알림이 되지 않는다.
const WARNING_PHRASES = [
  '아파', '아프', '아픈', '통증',
  '어지러', '어지럽',
  '힘들', '기운이 없', '기력이',
  '우울', '외로', '쓸쓸',
  '잠이 안', '잠을 못',
  '입맛이 없', '밥맛이 없',
];

// 24시간 내 warning이 이 횟수 이상이면 알림으로 승격한다.
const WARNING_PROMOTION_COUNT = 3;

const includesAny = (text, phrases) => phrases.some((p) => text.includes(p));

/**
 * 발화를 분류한다. 순수 함수 — DB나 시각에 의존하지 않으므로 단위 테스트 가능.
 * @returns {{severity: 'critical'|'warning'|null, matched: string|null}}
 */
function classifyUtterance(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return { severity: null, matched: null };

  const critical = CRITICAL_PHRASES.find((p) => text.includes(p));
  if (critical) return { severity: 'critical', matched: critical };

  const warning = WARNING_PHRASES.find((p) => text.includes(p));
  if (warning) return { severity: 'warning', matched: warning };

  return { severity: null, matched: null };
}

/**
 * 알림을 만든다. 쿨다운과 상태 래치를 여기서만 처리한다.
 * @returns {object|null} 생성된 알림, 쿨다운으로 억제되면 null
 */
function raise({ type, severity = 'critical', description, confidence = null, snapshotPath = null, skipCooldown = false }) {
  // 수동 SOS 버튼은 어르신의 명시적 의사표시이므로 쿨다운을 적용하지 않는다.
  if (!skipCooldown && alertsRepo.hasRecentOfType(type, config.alertCooldownMs, severity)) {
    console.log(`[ALERT] 쿨다운으로 억제됨 (${type}): ${description}`);
    return null;
  }

  const alert = alertsRepo.create({ type, severity, description, confidence, snapshotPath });

  // critical만 로봇/보호자 화면의 비상 모드를 켠다. warning은 기록만 남긴다.
  if (severity === 'critical') {
    require('../repositories/status').update({ isEmergency: true });
    emit(EVENTS.STATUS_CHANGED, require('../repositories/status').get());

    // 보호자 브라우저로 Web Push. fire-and-forget — 실패해도 알림 생성 자체는 막지 않는다.
    require('./notify').send(alert).catch((err) => console.error('[PUSH] 발송 실패:', err.message));
  }

  emit(EVENTS.ALERT_CREATED, alert);
  console.log(`[ALERT] ${severity} / ${type} — ${description}`);

  return alert;
}

/**
 * 어르신 발화를 평가하고 필요하면 알림을 올린다.
 * @returns {object|null} 생성된 알림
 */
function evaluateUtterance(text) {
  const { severity, matched } = classifyUtterance(text);
  if (!severity) return null;

  if (severity === 'critical') {
    return raise({
      type: 'voice_trigger',
      severity: 'critical',
      description: `어르신 음성 위급 감지 ("${matched}"): "${text}"`,
    });
  }

  // warning: 24시간 내 반복될 때만 승격한다.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentWarnings = alertsRepo.countSince(since, { severity: 'warning' });

  const alert = raise({
    type: 'voice_trigger',
    severity: 'warning',
    description: `어르신 건강 신호 관찰 ("${matched}"): "${text}"`,
  });

  if (alert && recentWarnings + 1 >= WARNING_PROMOTION_COUNT) {
    return raise({
      type: 'voice_trigger',
      severity: 'critical',
      description: `24시간 내 건강 호소가 ${recentWarnings + 1}회 반복되었습니다. 보호자 확인이 필요합니다.`,
      skipCooldown: true,
    });
  }

  return alert;
}

/** 모든 알림이 해제되면 비상 상태를 내린다. */
function resolveAlert(id, by = 'senior') {
  const statusRepo = require('../repositories/status');
  const { found, alert } = alertsRepo.resolve(id, by);

  let status = statusRepo.get();
  if (alertsRepo.unresolvedCount() === 0 && status.isEmergency) {
    status = statusRepo.update({ isEmergency: false });
    emit(EVENTS.STATUS_CHANGED, status);
  }

  if (found) emit(EVENTS.ALERT_RESOLVED, alert);
  return { found, alert, isEmergency: status.isEmergency };
}

module.exports = {
  classifyUtterance,
  evaluateUtterance,
  raise,
  resolveAlert,
  CRITICAL_PHRASES,
  WARNING_PHRASES,
  WARNING_PROMOTION_COUNT,
};
