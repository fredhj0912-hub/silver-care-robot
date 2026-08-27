const express = require('express');
const { asyncHandler } = require('../middleware');
const alertsRepo = require('../repositories/alerts');
const messagesRepo = require('../repositories/messages');
const emergency = require('../services/emergency');
const snapshots = require('../services/snapshots');

const router = express.Router();

/**
 * 기존 프론트가 쓰고 있는 엔드포인트(RobotFaceDisplay.jsx:288).
 * @deprecated GET /api/messages + GET /api/alerts 로 대체됨. 호환을 위해 남겨둔다.
 */
router.get('/history', (req, res) => {
  res.json({
    history: messagesRepo.list({ limit: 200 }).messages.reverse(),
    alerts: alertsRepo.list({ limit: 200 }).alerts,
  });
});

router.get('/alerts', (req, res) => {
  const { resolved, type, from, to, before, limit } = req.query;
  res.json(alertsRepo.list({
    resolved: resolved === undefined ? null : resolved === 'true' || resolved === '1',
    type, from, to, before, limit,
  }));
});

router.get('/alerts/:id', (req, res) => {
  const alert = alertsRepo.byId(req.params.id);
  if (!alert) return res.status(404).json({ error: '알림을 찾을 수 없습니다' });
  res.json(alert);
});

/** 수동 SOS. 어르신의 명시적 의사표시이므로 쿨다운을 적용하지 않는다. */
router.post('/alerts', asyncHandler(async (req, res) => {
  const { type, description, image } = req.body || {};
  const snapshotPath = image ? await snapshots.save(image) : null;

  const alert = emergency.raise({
    type: type || 'manual_panic_button',
    severity: 'critical',
    description: description || '어르신이 SOS 버튼을 직접 눌렀습니다',
    snapshotPath,
    skipCooldown: true,
  });

  res.json({ success: true, alert });
}));

router.post('/alerts/resolve', (req, res) => {
  const { id, by } = req.body || {};
  if (id === undefined) return res.status(400).json({ error: '알림 id가 필요합니다' });

  const result = emergency.resolveAlert(id, by === 'guardian' ? 'guardian' : 'senior');
  res.json({ success: result.found, isEmergency: result.isEmergency, alert: result.alert });
});

/** 낙상 스냅샷 이미지 — <img src>로 직접 불러온다 (쿼리 파라미터 인증 허용) */
router.get('/snapshots/:filename', asyncHandler(async (req, res) => {
  await snapshots.serve(req.params.filename, res);
}));

module.exports = router;
