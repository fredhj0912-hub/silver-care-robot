const express = require('express');
const { asyncHandler } = require('../middleware');
const commandsRepo = require('../repositories/commands');
const statusRepo = require('../repositories/status');
const motion = require('../services/motion');
const { emit, EVENTS } = require('../services/events');

const router = express.Router();

const DIRECTIONS = ['up', 'down', 'left', 'right'];

// 안 보내면 motion.js의 기본값을 쓴다. 보냈는데 숫자가 아니면 거른다.
const isOptionalNumber = (v) => v === undefined || (typeof v === 'number' && Number.isFinite(v));

/**
 * 보호자 원격조종 — 화살표를 누르고 있는 동안 앱이 이 경로를 반복해 부른다(심박).
 * 실물 구동부가 없어 services/motion.js가 가상 좌표로만 시뮬레이션한다.
 */
router.post('/control/move', asyncHandler(async (req, res) => {
  // 응급 상황 중에는 원격 조종을 잠근다 — 어르신을 확인/구조하는 게 우선이다.
  if ((await statusRepo.get()).isEmergency) {
    return res.status(423).json({ error: '응급 상황 중에는 원격 조종을 사용할 수 없습니다' });
  }

  const { direction, speed, durationMs } = req.body || {};
  if (!DIRECTIONS.includes(direction)) {
    return res.status(400).json({ error: `direction은 ${DIRECTIONS.join('/')} 중 하나여야 합니다` });
  }
  // 예전에는 motion.js만 클램핑했고 큐에는 **원본**이 들어갔다. 구동부가 큐의 값을
  // 그대로 믿으면 speed 99999를 받는다 — 숫자인지부터 여기서 거른다.
  if (!isOptionalNumber(speed) || !isOptionalNumber(durationMs)) {
    return res.status(400).json({ error: 'speed와 durationMs는 숫자여야 합니다' });
  }

  // 누르고 있는 동안의 심박은 같은 의도의 연장이다. 방향이 바뀌거나 서 있다가 출발할
  // 때만 큐에 한 줄 남긴다 — 심박마다 넣으면 초당 네 줄씩 쌓이고, 키오스크 표시도
  // 매번 새 명령으로 깜빡인다.
  const before = motion.getState();
  const isNewIntent = !before.moving || before.direction !== direction;

  const state = motion.move({ direction, speed, durationMs });

  if (isNewIntent) {
    const command = await commandsRepo.enqueue({
      kind: 'move',
      payload: {
        direction,
        speed: motion.clampSpeed(speed ?? motion.DEFAULT_SPEED),
        durationMs: motion.clampDuration(durationMs ?? motion.DEFAULT_DURATION_MS),
      },
    });
    emit(EVENTS.COMMAND_ISSUED, command);
  }

  res.json({ success: true, state });
}));

/**
 * 명시적 정지. **응급 중에도 막지 않는다** — 잠가야 하는 것은 움직이는 쪽이지
 * 멈추는 쪽이 아니다. move에 423을 주면서 stop까지 막으면, 응급이 뜬 그 순간
 * 굴러가던 로봇을 세울 방법이 사라진다.
 */
router.post('/control/stop', (req, res) => {
  res.json({ success: true, state: motion.stop() });
});

router.get('/control/state', (req, res) => {
  res.json(motion.getState());
});

module.exports = router;
