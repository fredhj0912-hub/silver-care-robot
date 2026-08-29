const express = require('express');
const { asyncHandler } = require('../middleware');
const statusRepo = require('../repositories/status');
const messagesRepo = require('../repositories/messages');
const alertsRepo = require('../repositories/alerts');
const gemini = require('../services/gemini');
const { config } = require('../config');
const { emit, EVENTS } = require('../services/events');

const router = express.Router();

// 한국은 DST가 없으므로 고정 +09:00로 계산한다.
const KST_TZ = 'Asia/Seoul';

/** 현재 시각의 KST 달력 날짜를 'YYYY-MM-DD'로. UTC 자정 기준으로 계산하면
 * KST 00~09시 사이의 대화가 "어제"로 잘못 집계된다. */
function kstDateString(instant = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: KST_TZ }).format(instant);
}

/** 'YYYY-MM-DD'(KST 기준 하루)를 UTC 구간 [start, end)로 변환한다. */
function kstDayRange(dateStr) {
  const start = new Date(`${dateStr}T00:00:00+09:00`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

// 인증 없이 접근 가능 — 로봇이 살아있는지 확인하는 용도
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    geminiAvailable: gemini.isAvailable(),
    model: config.geminiModel,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

router.get('/status', asyncHandler(async (req, res) => {
  res.json(await statusRepo.get());
}));

router.post('/status', asyncHandler(async (req, res) => {
  const { battery, seniorExpression, status } = req.body || {};
  const patch = {};
  if (battery !== undefined) patch.battery = Number(battery);
  if (seniorExpression !== undefined) patch.seniorExpression = String(seniorExpression);
  if (status !== undefined) patch.status = String(status);
  patch.lastActive = new Date().toISOString();

  const updated = await statusRepo.update(patch);
  emit(EVENTS.STATUS_CHANGED, updated);
  res.json(updated);
}));

/**
 * 보호자 홈 카드용 — "오늘 어땠나"를 한 번의 요청으로.
 *
 * 날짜 경계는 KST(UTC+9) 달력일 기준이다. UTC 자정 기준으로 계산했던 이전 버전은
 * 새벽 0~9시(KST) 사이의 대화를 "어제"로 잘못 집계했다 — 어르신이 이른 아침에
 * 나눈 대화가 보호자 화면의 "오늘" 카드에 반영되지 않는 문제였다.
 *
 * 조회도 `list({limit:200})` + JS 필터가 아니라 시간 범위로 직접 SQL 조회한다.
 * 캡핑된 최신 200건에서 필터링하면, 전체 메시지가 200건을 넘어선 뒤로는
 * 과거 날짜 조회가 항상 0건을 반환했다.
 */
router.get('/summary/daily', asyncHandler(async (req, res) => {
  const dateStr = req.query.date || kstDateString();
  const { start, end } = kstDayRange(dateStr);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const inRange = await messagesRepo.listInRange(startIso, endIso);

  const emotionCounts = inRange
    .filter((m) => m.sender === 'robot')
    .reduce((acc, m) => ({ ...acc, [m.emotion]: (acc[m.emotion] || 0) + 1 }), {});

  res.json({
    date: dateStr,
    conversationTurns: inRange.filter((m) => m.sender === 'senior').length,
    guardianMessages: inRange.filter((m) => m.sender === 'guardian').length,
    emotionCounts,
    alertCount: await alertsRepo.countSince(startIso, { to: endIso }),
    unresolvedAlerts: await alertsRepo.unresolvedCount(),
    lastActive: (await statusRepo.get()).lastActive,
  });
}));

module.exports = router;
