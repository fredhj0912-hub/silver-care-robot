/**
 * 보호자 화면에 쓰이는 문구 생성.
 *
 * 원칙: 보호자에게 지표를 해석시키지 않는다.
 * `conversationTurns: 8` 을 보여주는 대신 "여덟 번 이야기를 나눴어요"라고 말한다.
 */

const KST = 'Asia/Seoul';

export function formatTime(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: KST, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

export function formatDay(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: KST, month: 'long', day: 'numeric', weekday: 'short',
  }).format(new Date(iso));
}

/**
 * KST 달력일의 시작을 ISO UTC로. `offsetDays`만큼 앞뒤로 옮긴다.
 * 백엔드 `routes/status.js`의 kstDayRange와 같은 규칙 — 조회 구간은 화면이 정하고
 * 백엔드는 받은 구간만 본다.
 */
export function kstDayStartISO(offsetDays = 0) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: KST }).format(new Date());
  const start = new Date(`${today}T00:00:00+09:00`);
  return new Date(start.getTime() + offsetDays * 24 * 60 * 60 * 1000).toISOString();
}

/** 목록의 날짜 구분선용 키 (KST 달력일) */
export function dayKey(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: KST }).format(new Date(iso));
}

/**
 * 날짜 구분선이 없는 곳(홈의 최근 대화)에서 쓰는 시각 표기.
 *
 * 시각만 보여주면 어제 15:29 메시지와 오늘 12:09 메시지가 나란히 놓였을 때
 * 순서가 뒤집힌 것처럼 보인다. 오늘이 아니면 날짜를 함께 붙인다.
 */
export function formatWhen(iso) {
  if (!iso) return '—';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: KST }).format(new Date());
  if (dayKey(iso) === today) return formatTime(iso);

  const md = new Intl.DateTimeFormat('ko-KR', {
    timeZone: KST, month: 'numeric', day: 'numeric',
  }).format(new Date(iso));
  return `${md} ${formatTime(iso)}`;
}

export function relativeTime(iso) {
  if (!iso) return '기록 없음';
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return '방금';
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전`;
  return `${Math.round(diffHr / 24)}일 전`;
}

const KO_NUM = ['영', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];

/** 1~10은 우리말 수사로, 그 이상은 숫자로 — 문장 안에서 자연스럽게 읽히도록 */
export function koCount(n) {
  return n <= 10 ? KO_NUM[n] : String(n);
}

const ALERT_LABELS = {
  fall_detected: '낙상 감지',
  manual_panic_button: 'SOS 버튼',
  voice_trigger: '음성 위급 신호',
  vision_anomaly: '카메라 이상 감지',
  no_motion: '장시간 움직임 없음',
  medication_missed: '복약 미확인',
};

export const alertLabel = (type) => ALERT_LABELS[type] || type;

/**
 * 안부 카드 본문. 효돌이가 1인칭으로 오늘을 전한다.
 *
 * HTML 문자열이 아니라 토큰 배열을 반환한다 — 강조 표시를 위해
 * dangerouslySetInnerHTML 을 쓰면, 나중에 누군가 이 문장에 사용자 입력을
 * 끼워 넣는 순간 XSS 통로가 된다.
 *
 * @returns {Array<{t: string, em?: boolean}>|null}
 */
export function buildDailyNote(summary, status) {
  if (!summary) return null;

  const turns = summary.conversationTurns || 0;
  const out = [];
  const say = (t) => out.push({ t });
  const emph = (t) => out.push({ t, em: true });

  if (turns === 0) {
    say('오늘은 아직 어르신과 이야기를 나누지 못했어요. ');
  } else {
    say('오늘 어르신과 ');
    emph(`${koCount(turns)} 번`);
    say(' 이야기를 나눴어요. ');
  }

  const emotions = summary.emotionCounts || {};
  const positive = emotions.happy || 0;
  const negative = (emotions.sad || 0) + (emotions.concerned || 0);

  if (turns > 0) {
    if (negative > positive) {
      say('오늘은 기운이 조금 없어 보이셨어요. ');
    } else if (positive > 0) {
      say('기분은 대체로 ');
      emph('좋으셨어요');
      say('. ');
    } else {
      say('특별히 힘들어하시는 기색은 없었어요. ');
    }
  }

  if (summary.alertCount > 0) {
    say('오늘 알림이 ');
    emph(`${koCount(summary.alertCount)} 번`);
    say(' 있었어요. ');
  }

  if (status && !status.isEmergency && summary.unresolvedAlerts === 0 && turns > 0) {
    say('지금은 별일 없으세요.');
  }

  return out;
}

/** 상태 한 줄 — 화면 맨 위에서 "괜찮으신가?"에 바로 답한다 */
export function stateLabel({ status, openAlerts, connected }) {
  if (status?.isEmergency || openAlerts?.length) {
    return { text: '확인이 필요해요', tone: 'alarm' };
  }
  if (!connected || !status) {
    return { text: '연결 확인 중', tone: 'offline' };
  }
  return { text: '평온해요', tone: 'live' };
}
