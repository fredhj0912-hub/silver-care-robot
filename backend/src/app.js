const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const { config } = require('./config');
const { securityHeaders, apiKeyAuth, notFound, errorHandler } = require('./middleware');

const statusRoutes = require('./routes/status');
const chatRoutes = require('./routes/chat');
const alertRoutes = require('./routes/alerts');
const visionRoutes = require('./routes/vision');
const commandRoutes = require('./routes/commands');
const controlRoutes = require('./routes/control');
const eventRoutes = require('./routes/events');
const ttsRoutes = require('./routes/tts');
const pushRoutes = require('./routes/push');
const medicationRoutes = require('./routes/medications');

/**
 * 사설 네트워크에서 온 요청만 허용한다.
 * 이전에는 cors() 를 옵션 없이 열어 어떤 오리진이든 통과했다.
 */
function isPrivateOrigin(origin) {
  if (!origin) return true; // 같은 오리진 / curl / 서버 간 호출
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname.endsWith('.local')
    );
  } catch {
    return false;
  }
}

function createApp() {
  const app = express();

  app.use(cors({
    origin: (origin, cb) => cb(null, isPrivateOrigin(origin)),
    credentials: false,
  }));
  app.use(express.json({ limit: config.maxJsonBody }));
  app.use(securityHeaders);
  app.use(apiKeyAuth);

  // 프론트엔드 빌드가 지정돼 있으면 백엔드가 같은 오리진에서 서빙한다(EC2 배포).
  // 없으면 기존대로 상태 페이지만 띄운다 — 로컬 개발은 Vite dev 서버가 화면을 맡는다.
  const publicIndex = config.publicDir
    ? path.resolve(config.publicDir, 'index.html')
    : null;
  const servePublic = Boolean(publicIndex && fs.existsSync(publicIndex));

  if (!servePublic) {
    app.get('/', (req, res) => {
      res.type('html').send(landingPage());
    });
  }

  app.use('/api', statusRoutes);
  app.use('/api', chatRoutes);
  app.use('/api', alertRoutes);
  app.use('/api', visionRoutes);
  app.use('/api', commandRoutes);
  app.use('/api', controlRoutes);
  app.use('/api', eventRoutes);
  app.use('/api', ttsRoutes);
  app.use('/api', pushRoutes);
  app.use('/api', medicationRoutes);

  if (servePublic) {
    app.use(express.static(path.resolve(config.publicDir)));
    // 클라이언트 라우팅(/guardian/alerts 등)은 서버에 실제 파일이 없으므로 셸을 돌려준다.
    // /api/* 는 넘기지 않는다 — 없는 API가 200 HTML을 받으면 디버깅이 지옥이 된다.
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(publicIndex);
    });
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

function landingPage() {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>효돌이 백엔드 서버 상태</title>
<style>
  body { font-family: system-ui, sans-serif; background:#1a1a24; color:#f8fafc; padding:3rem; text-align:center; }
  .card { background:#22222e; padding:2rem; border-radius:16px; display:inline-block; border:1px solid rgba(255,255,255,.08); }
  h1 { color:#5c64ec; margin-top:0; }
  .badge { background:#10b981; color:#fff; padding:.3rem .6rem; border-radius:6px; font-size:.8rem; font-weight:700; }
  a { color:#5c64ec; font-weight:700; text-decoration:none; }
  code { background:rgba(255,255,255,.06); padding:.15rem .4rem; border-radius:4px; }
</style></head><body>
<div class="card">
  <h1>🤖 효돌이 백엔드 API 서버</h1>
  <p>상태: <span class="badge">정상 작동 중</span></p>
  <p>포트: <code>${config.port}</code> &nbsp; 모델: <code>${config.geminiModel}</code></p>
  <p style="color:#64748b;font-size:.9rem;margin-top:1.5rem">
    로봇 화면: <a href="http://localhost:5173">http://localhost:5173</a><br/>
    상세 상태: <a href="/api/health">/api/health</a>
  </p>
</div></body></html>`;
}

module.exports = { createApp, isPrivateOrigin };
