const webpush = require('web-push');
const { config } = require('../config');
const subscriptionsRepo = require('../repositories/subscriptions');

/**
 * 보호자 브라우저로 보내는 Web Push (표준 VAPID). critical 알림 전용 —
 * warning까지 푸시하면 오탐이 반복될 때 보호자가 알림을 꺼버린다(TODO.md 요구사항).
 */

const isEnabled = () =>
  Boolean(config.vapidPublicKey && config.vapidPrivateKey && config.vapidSubject);

if (isEnabled()) {
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
}

/**
 * 구독된 모든 보호자 기기에 알림을 보낸다. 실패한 구독(만료/거부, 410 Gone 등)은 정리한다.
 * emergency.raise()에서 fire-and-forget으로 호출된다 — 예외를 던지지 않는다.
 */
async function send(alert) {
  if (!isEnabled()) {
    console.warn('[PUSH] VAPID 키 미설정 — 보호자에게 응급 알림이 가지 않았습니다');
    return { skipped: true, reason: 'VAPID 키 미설정' };
  }

  const subscriptions = subscriptionsRepo.all();
  if (subscriptions.length === 0) {
    console.warn('[PUSH] 구독된 보호자 기기가 없습니다 — 응급 알림이 가지 않았습니다');
    return { skipped: true, reason: '구독된 기기 없음' };
  }

  const payload = JSON.stringify({
    title: '효돌이 응급 알림',
    body: alert.description,
    url: `/guardian/alerts/${alert.id}`,
  });

  let sent = 0;
  const failures = [];

  await Promise.all(subscriptions.map(async ({ endpoint, keys }) => {
    try {
      await webpush.sendNotification({ endpoint, keys }, payload);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        subscriptionsRepo.remove(endpoint);
      }
      failures.push(err.message);
    }
  }));

  // 응급 알림이 한 대도 못 갔는데 조용히 지나가면 안 된다.
  if (sent === 0) console.error(`[PUSH] 전 기기 발송 실패 (${subscriptions.length}대):`, failures.join(' / '));
  else console.log(`[PUSH] ${sent}/${subscriptions.length}대 발송 완료`);

  return { skipped: false, sent, failures };
}

module.exports = { send, isEnabled };
