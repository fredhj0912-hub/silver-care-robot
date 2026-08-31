const express = require('express');
const { asyncHandler } = require('../middleware');
const subscriptionsRepo = require('../repositories/subscriptions');

const router = express.Router();

/** 보호자 브라우저가 구독을 등록한다. */
router.post('/push/subscribe', asyncHandler(async (req, res) => {
  const { endpoint, keys, label } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'endpoint와 keys(p256dh, auth)가 필요합니다' });
  }

  // origin은 요청 헤더에서 읽는다 — 프론트가 보내는 값을 믿을 이유가 없다.
  const origin = req.get('origin') || null;
  await subscriptionsRepo.save({ endpoint, keys, label, origin });

  const dropped = await subscriptionsRepo.removeOtherOrigins(origin);
  if (dropped > 0) {
    console.log(`[PUSH] 옛 주소의 구독 ${dropped}건 정리 (현재 origin: ${origin})`);
  }

  res.json({ success: true });
}));

/** 알림 끄기(구독 해제). */
router.post('/push/unsubscribe', asyncHandler(async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint가 필요합니다' });

  await subscriptionsRepo.remove(endpoint);
  res.json({ success: true });
}));

module.exports = router;
