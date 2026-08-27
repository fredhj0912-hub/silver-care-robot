const express = require('express');
const { asyncHandler } = require('../middleware');
const { config } = require('../config');
const tts = require('../services/tts');

const router = express.Router();

/**
 * 문장을 음성으로 합성해 돌려준다.
 *
 * provider가 'browser'면 204를 반환한다 — 프론트가 이를 신호로 받아
 * 자체 SpeechSynthesis 로 말한다. 오류가 아니라 정상 경로다.
 */
router.post('/tts', asyncHandler(async (req, res) => {
  const { text, voice } = req.body || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: '합성할 문장(text)이 필요합니다' });
  }
  if (text.length > config.maxSpeakChars) {
    return res.status(400).json({ error: `문장은 ${config.maxSpeakChars}자를 넘을 수 없습니다` });
  }

  if (!tts.isEnabled()) {
    return res.status(204).end(); // 프론트가 브라우저 TTS로 처리하라는 신호
  }

  try {
    const result = await tts.synthesize(text.trim(), voice ? { voice } : {});
    if (!result) return res.status(204).end();

    res.setHeader('Content-Type', result.mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-TTS-Cached', result.cached ? '1' : '0');
    res.setHeader('X-TTS-Ms', String(result.ms));
    res.send(result.buffer);
  } catch (err) {
    // 합성이 실패해도 어르신은 대답을 들어야 한다.
    // 204를 돌려주면 프론트가 브라우저 TTS로 대신 말한다.
    console.error('TTS 합성 실패 → 브라우저 TTS로 폴백:', err.message);
    res.setHeader('X-TTS-Error', encodeURIComponent(err.message.slice(0, 200)));
    res.status(204).end();
  }
}));

/** 현재 TTS 설정 — 프론트가 어느 경로로 말할지 판단하는 데 쓴다 */
router.get('/tts/config', (req, res) => {
  res.json({
    provider: config.ttsProvider,
    enabled: tts.isEnabled(),
    voice: config.ttsVoice,
  });
});

module.exports = router;
