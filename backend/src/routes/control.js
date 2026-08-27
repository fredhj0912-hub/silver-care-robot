const express = require('express');
const commandsRepo = require('../repositories/commands');
const statusRepo = require('../repositories/status');
const motion = require('../services/motion');
const { emit, EVENTS } = require('../services/events');

const router = express.Router();

const DIRECTIONS = ['up', 'down', 'left', 'right'];

/**
 * 보호자 원격조종 — D-패드 이동.
 * 실물 구동부가 없어 services/motion.js가 가상 좌표로만 시뮬레이션한다.
 */
router.post('/control/move', (req, res) => {
  // 응급 상황 중에는 원격 조종을 잠근다 — 어르신을 확인/구조하는 게 우선이다.
  if (statusRepo.get().isEmergency) {
    return res.status(423).json({ error: '응급 상황 중에는 원격 조종을 사용할 수 없습니다' });
  }

  const { direction, speed, durationMs } = req.body || {};
  if (!DIRECTIONS.includes(direction)) {
    return res.status(400).json({ error: `direction은 ${DIRECTIONS.join('/')} 중 하나여야 합니다` });
  }

  const state = motion.move({ direction, speed, durationMs });

  const command = commandsRepo.enqueue({ kind: 'move', payload: { direction, speed, durationMs } });
  emit(EVENTS.COMMAND_ISSUED, command);

  res.json({ success: true, state });
});

router.get('/control/state', (req, res) => {
  res.json(motion.getState());
});

module.exports = router;
