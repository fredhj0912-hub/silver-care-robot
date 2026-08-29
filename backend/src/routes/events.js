const express = require('express');
const { asyncHandler } = require('../middleware');
const { subscribe } = require('../services/events');
const statusRepo = require('../repositories/status');
const alertsRepo = require('../repositories/alerts');

const router = express.Router();

const HEARTBEAT_MS = 25_000; // 프록시가 유휴 연결을 끊지 않도록

/**
 * Server-Sent Events — 서버에서 클라이언트로 밀어주는 단방향 채널.
 *
 * 이전에는 푸시 채널이 없어 상태 3초, 보호자 메시지 2.5초 폴링에 의존했다.
 * 응급 알림이 보호자 화면에 뜨기까지 최대 3초가 밀렸고, 원격 조종은 이 지연을 그대로 체감한다.
 *
 * role=robot     로봇 키오스크 — 명령, 알림, 상태
 * role=guardian  보호자 앱 — 위 전부 + 대화 로그
 */
router.get('/events', asyncHandler(async (req, res) => {
  const role = req.query.role === 'robot' ? 'robot' : 'guardian';

  // DB 조회를 writeHead 前에 끝낸다 — 스트림을 연 뒤에 조회가 실패하면 이미 200을
  // 보낸 응답에 500을 덧씌우려다 ERR_HTTP_HEADERS_SENT가 난다. 여기서 실패하면
  // 스트림을 열기 전이라 깔끔하게 500으로 끝낼 수 있다.
  // (await를 빠뜨리면 Promise가 그대로 직렬화돼 보호자 화면 초기 렌더가 조용히 깨진다.)
  const hello = {
    role,
    status: await statusRepo.get(),
    unresolvedAlerts: await alertsRepo.unresolved(),
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (type, payload) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // 연결 직후 현재 상태를 한 번 보내 클라이언트가 즉시 그릴 수 있게 한다
  send('hello', hello);

  const unsubscribe = subscribe(role, (event) => send(event.type, event.payload));
  // named event로 보낸다 — SSE 주석(`:`로 시작하는 줄)은 EventSource의 JS 리스너에
  // 아예 전달되지 않아, 클라이언트가 "연결은 열려 있지만 응답이 없다"를 감지할 수 없다.
  const heartbeat = setInterval(() => send('heartbeat', {}), HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}));

module.exports = router;
