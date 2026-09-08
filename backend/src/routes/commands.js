const express = require('express');
const { asyncHandler } = require('../middleware');
const { config } = require('../config');
const commandsRepo = require('../repositories/commands');
const messagesRepo = require('../repositories/messages');
const { emit, EVENTS } = require('../services/events');

const router = express.Router();

/**
 * 보호자 → 로봇 명령 큐.
 *
 * 이전 구조: POST /api/remote-message 로 넣고 GET /api/remote-message/poll 로 꺼냈는데,
 * poll 이 조회 시점에 shift() 로 큐를 비웠다. 응답이 유실되면 메시지도 함께 사라졌다.
 * 이제 조회(pending)와 소비(ack)를 분리한다.
 */
router.post('/commands', asyncHandler(async (req, res) => {
  const { kind, payload } = req.body || {};

  if (!['speak', 'move', 'ping'].includes(kind)) {
    return res.status(400).json({ error: "kind는 'speak', 'move', 'ping' 중 하나여야 합니다" });
  }

  if (kind === 'speak') {
    const text = payload && payload.text;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: '보낼 말씀(payload.text)이 필요합니다' });
    }
    if (text.length > config.maxSpeakChars) {
      return res.status(400).json({ error: `메시지는 ${config.maxSpeakChars}자를 넘을 수 없습니다` });
    }
  }

  const command = await commandsRepo.enqueue({ kind, payload: payload || {} });

  // 보호자 메시지는 대화 로그에도 남긴다
  if (kind === 'speak') {
    const msg = await messagesRepo.add({
      sender: 'guardian',
      text: payload.text.trim(),
      source: 'remote',
    });
    emit(EVENTS.MESSAGE_ADDED, msg);
  }

  emit(EVENTS.COMMAND_ISSUED, command);
  res.json({ success: true, command });
}));

/** 로봇이 미처리 명령을 조회한다. 조회만으로는 큐에서 사라지지 않는다. */
router.get('/commands/pending', asyncHandler(async (req, res) => {
  res.json({
    commands: await commandsRepo.pending({
      kind: req.query.kind,
      limit: req.query.limit,
      maxAgeMs: req.query.maxAgeMs,
    }),
  });
}));

/** 로봇이 명령을 실제로 수행한 뒤 호출한다. */
router.post('/commands/:id/ack', asyncHandler(async (req, res) => {
  const { found, command } = await commandsRepo.ack(req.params.id);
  if (!found) return res.status(404).json({ error: '미처리 명령을 찾을 수 없습니다' });
  res.json({ success: true, command });
}));

module.exports = router;
