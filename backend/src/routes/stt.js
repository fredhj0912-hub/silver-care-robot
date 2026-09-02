const express = require('express');
const { asyncHandler } = require('../middleware');
const { config } = require('../config');
const gemini = require('../services/gemini');

const router = express.Router();

/**
 * 서버측 받아쓰기 — 브라우저가 녹음한 발화 오디오를 텍스트로 돌려준다.
 *
 * 왜 있는가: 파이 OS 저장소의 Chromium이 구글 음성 키 없이 빌드돼 있어 브라우저
 * 음성 인식(Web Speech API)이 매번 network 오류로 끝난다(2026-09-01 파이 5 실측).
 * ARM64용 정식 Chrome 빌드가 없어 브라우저 교체는 경로가 아니었다.
 *
 * 이 라우트는 받아쓰기만 한다 — 대화 응답은 프론트가 결과 텍스트를 웨이크워드
 * 게이트(lib/wakeword.js)에 통과시킨 뒤 /api/chat 으로 따로 보낸다. 게이트를 서버로
 * 옮기면 응급 발화 우회 판정이 두 곳으로 갈라진다.
 */
router.post('/stt', asyncHandler(async (req, res) => {
  const { audio } = req.body || {};

  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ error: '오디오 데이터(base64 data URI)가 필요합니다' });
  }
  if (!/^data:audio\/[a-zA-Z0-9.+-]+;base64,/.test(audio)) {
    return res.status(400).json({ error: 'data:audio/ 로 시작하는 올바른 data URI여야 합니다' });
  }
  // 한계값은 config 한 곳에서만 정의한다 (routes/vision.js와 같은 이중 체크 패턴)
  if (Buffer.byteLength(audio, 'utf8') > config.maxAudioBytes) {
    return res.status(413).json({ error: '오디오 용량이 허용치를 초과했습니다' });
  }

  const result = await gemini.transcribeAudio(audio);

  // Gemini를 못 쓰는 상태(키 없음/SDK 없음)는 200에 빈 text로 감추지 않는다.
  // 프론트가 이것을 보고 음성 경로를 접고 텍스트 입력 폴백을 안내해야 하는데,
  // 조용한 성공으로 돌려주면 어르신은 로봇이 못 알아듣는다고만 느낀다.
  if (result.error === 'no_api_key' || result.error === 'sdk_unavailable') {
    return res.status(503).json({ error: '받아쓰기를 쓸 수 없습니다', reason: result.error });
  }

  res.json({ text: result.text, source: result.source, error: result.error });
}));

module.exports = router;
