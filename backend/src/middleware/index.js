const { config } = require('../config');

/** 클릭재킹/스니핑 방지 헤더 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

/**
 * LAN 공유 비밀키 인증.
 *
 * 주의: 이 키는 프론트엔드 번들(VITE_ROBOT_API_KEY)에 평문으로 들어간다.
 * 같은 Wi-Fi의 다른 기기가 무심코 API를 두드리는 것을 막는 수준의 방어선이지,
 * 진짜 인증이 아니다. 인터넷에 노출할 계획이 생기면 반드시 교체해야 한다.
 */
const PUBLIC_PATHS = new Set(['/', '/api/health']);

function apiKeyAuth(req, res, next) {
  if (!config.robotApiKey) return next();          // 미설정 시 개발 편의를 위해 통과
  if (req.method === 'OPTIONS') return next();     // CORS 프리플라이트
  if (PUBLIC_PATHS.has(req.path)) return next();

  // <img src> 와 EventSource 는 커스텀 헤더를 붙일 수 없으므로 쿼리 파라미터도 받는다.
  const provided = req.get('x-api-key') || req.query.key;
  if (provided !== config.robotApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/** async 라우트의 예외를 에러 핸들러로 넘긴다. 없으면 unhandled rejection이 된다. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function notFound(req, res) {
  res.status(404).json({ error: 'Not Found', path: req.path });
}

/** 스택 트레이스를 노출하지 않는 최종 에러 핸들러 */
// eslint-disable-next-line no-unused-vars -- Express는 4개 인자로 에러 핸들러를 식별한다
function errorHandler(err, req, res, next) {
  console.error('처리되지 않은 서버 오류:', err.stack || err);
  res.status(err.status || 500).json({
    error: err.status && err.status < 500 ? err.message : 'Internal Server Error',
  });
}

module.exports = { securityHeaders, apiKeyAuth, asyncHandler, notFound, errorHandler };
