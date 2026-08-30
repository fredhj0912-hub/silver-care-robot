const express = require('express');
const { asyncHandler } = require('../middleware');
const { config } = require('../config');
const messagesRepo = require('../repositories/messages');
const statusRepo = require('../repositories/status');
const gemini = require('../services/gemini');
const emergency = require('../services/emergency');
const medication = require('../services/medication');
const { emit, EVENTS } = require('../services/events');

const router = express.Router();

router.post('/chat', asyncHandler(async (req, res) => {
  const { text, seniorExpression } = req.body || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: '대화 내용(text)이 필요합니다' });
  }
  if (text.length > config.maxChatChars) {
    return res.status(400).json({ error: `대화 내용은 ${config.maxChatChars}자를 넘을 수 없습니다` });
  }
  if (seniorExpression !== undefined && typeof seniorExpression !== 'string') {
    return res.status(400).json({ error: 'seniorExpression은 문자열이어야 합니다' });
  }

  const utterance = text.trim();

  // 1. 어르신 발화 기록
  const seniorMsg = await messagesRepo.add({
    sender: 'senior',
    text: utterance,
    emotion: seniorExpression || 'neutral',
  });
  emit(EVENTS.MESSAGE_ADDED, seniorMsg);

  // 2. 응답 생성 (Gemini 실패 시 mock 폴백 — source로 어느 쪽인지 드러난다)
  const reply = await gemini.chat(utterance, seniorExpression);

  // 3. 응급 판정. 음성/비전/수동 트리거가 모두 emergency 서비스 하나를 거친다.
  //    Gemini가 'concerned'로 답했다는 사실만으로는 알림을 올리지 않는다 —
  //    "외로워요" 같은 말에도 concerned가 나오므로 오탐의 주원인이었다.
  const alert = await emergency.evaluateUtterance(utterance);

  //    응급 판정 다음에 둔다 — "약 먹고 어지러워" 처럼 둘 다 걸리는 발화에서
  //    응급 신호가 복약 처리에 묻히면 안 된다. 서로 독립적으로 동작한다.
  const takenMedication = await medication.evaluateUtterance(utterance);

  // 4. 로봇 응답 기록
  const robotMsg = await messagesRepo.add({
    sender: 'robot',
    text: reply.text,
    emotion: reply.emotion,
    source: reply.source,
  });
  emit(EVENTS.MESSAGE_ADDED, robotMsg);

  await statusRepo.update({
    seniorExpression: seniorExpression || 'neutral',
    lastActive: new Date().toISOString(),
  });

  res.json({
    text: reply.text,
    emotion: reply.emotion,
    source: reply.source,          // 'gemini' | 'mock' — 키오스크가 배지로 표시한다
    model: reply.model || null,    // 대체 모델로 넘어갔는지 확인용
    degradedReason: reply.error,   // mock으로 떨어진 이유 (개발 진단용)
    alert: alert ? { id: alert.id, severity: alert.severity } : null,
    medicationTaken: takenMedication
      ? { id: takenMedication.id, medicineName: takenMedication.medicineName }
      : null,
  });
}));

/**
 * 커서 페이지네이션 로그 조회.
 * 이전 GET /api/history 는 전체 로그를 통째로 반환했다.
 */
router.get('/messages', asyncHandler(async (req, res) => {
  const { before, limit, sender, q } = req.query;
  res.json(await messagesRepo.list({ before, limit, sender, q }));
}));

module.exports = router;
