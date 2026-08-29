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

  await subscriptionsRepo.save({ endpoint, keys, label });
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
