const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// config 는 require 시점에 환경변수를 읽는다. 반드시 app 을 부르기 전에 설정한다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hyodol-test-control-'));
// .env에 DB_DRIVER=pg 가 설정돼 있어도 테스트가 실제 RDS를 치지 않게 고정한다
// (SNAPSHOT_STORAGE='local' 과 같은 이유 — 통합 테스트는 임시 SQLite에서만 돈다).
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = path.join(TMP, 'test.sqlite');
process.env.SNAPSHOT_DIR = path.join(TMP, 'snapshots');
process.env.ROBOT_API_KEY = 'test-key';
process.env.GEMINI_API_KEY = '';
process.env.SNAPSHOT_STORAGE = 'local';
process.env.AWS_ACCESS_KEY_ID = '';
process.env.AWS_SECRET_ACCESS_KEY = '';
process.env.AWS_SESSION_TOKEN = '';
process.env.AWS_REGION = '';

const { createApp } = require('../src/app');
const { closeDB } = require('../src/db');
const motion = require('../src/services/motion');
const statusRepo = require('../src/repositories/status');

let server;
let BASE;

const H = { 'Content-Type': 'application/json', 'x-api-key': 'test-key' };
const get = (p) => fetch(BASE + p, { headers: H }).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) })
  .then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  motion.stop(); // 데드맨 타이머가 남아 프로세스 종료를 막지 않도록
  server.close();
  await closeDB();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('잘못된 방향은 400을 반환한다', async () => {
  const r = await post('/api/control/move', { direction: 'diagonal' });
  assert.strictEqual(r.s, 400);
});

test('정상 이동은 200과 갱신된 가상 좌표를 반환한다', async () => {
  const r = await post('/api/control/move', { direction: 'up', speed: 50, durationMs: 100 });
  assert.strictEqual(r.s, 200);
  assert.strictEqual(r.b.state.moving, true);

  const state = await get('/api/control/state');
  assert.strictEqual(state.b.direction, 'up');
});

test('응급 상황 중에는 원격 조종이 423으로 잠긴다', async () => {
  await statusRepo.update({ isEmergency: true });
  try {
    const r = await post('/api/control/move', { direction: 'down' });
    assert.strictEqual(r.s, 423);
  } finally {
    await statusRepo.update({ isEmergency: false }); // 이후 테스트에 영향 없도록 복원
  }
});

test('숫자가 아닌 speed/durationMs는 400을 반환한다', async () => {
  // 큐에 들어간 값을 구동부가 그대로 믿는다. 문자열이 그대로 흘러가면 안 된다.
  const bad = await post('/api/control/move', { direction: 'up', speed: '99999' });
  assert.strictEqual(bad.s, 400);

  const badDuration = await post('/api/control/move', { direction: 'up', durationMs: null });
  assert.strictEqual(badDuration.s, 400);
});

test('speed/durationMs를 생략하면 기본값으로 동작한다', async () => {
  motion.stop();
  const r = await post('/api/control/move', { direction: 'up' });
  assert.strictEqual(r.s, 200);
  assert.strictEqual(r.b.state.moving, true);
});

// ── 정지 ─────────────────────────────────────────
// 잠가야 하는 것은 움직이는 쪽이지 멈추는 쪽이 아니다. 응급이 뜬 그 순간 굴러가던
// 로봇을 세울 방법이 없어지면 안 된다.

test('POST /api/control/stop 은 즉시 정지시킨다', async () => {
  await post('/api/control/move', { direction: 'left', speed: 40, durationMs: 3000 });
  assert.strictEqual((await get('/api/control/state')).b.moving, true);

  const r = await post('/api/control/stop', {});
  assert.strictEqual(r.s, 200);
  assert.strictEqual(r.b.state.moving, false);
  assert.strictEqual((await get('/api/control/state')).b.moving, false);
});

test('응급 중에도 정지는 허용된다 (move만 423이다)', async () => {
  await post('/api/control/move', { direction: 'right', speed: 40, durationMs: 3000 });
  await statusRepo.update({ isEmergency: true });
  try {
    assert.strictEqual((await post('/api/control/move', { direction: 'right' })).s, 423);
    assert.strictEqual((await post('/api/control/stop', {})).s, 200);
    assert.strictEqual((await get('/api/control/state')).b.moving, false);
  } finally {
    await statusRepo.update({ isEmergency: false });
  }
});

// ── 심박은 큐에 쌓이지 않는다 ───────────────────────
// 누르고 있는 동안 앱이 250ms마다 부른다. 그때마다 큐에 넣으면 초당 네 줄씩 쌓이고
// (백로그 "미처리 move가 쌓인다"), 키오스크 표시도 매번 새 명령으로 깜빡인다.

const pendingMoves = async () => (await get('/api/commands/pending?kind=move')).b.commands.length;

test('같은 방향의 심박은 큐에 한 줄만 남긴다', async () => {
  motion.stop();
  const before = await pendingMoves();

  for (let i = 0; i < 5; i++) {
    await post('/api/control/move', { direction: 'up', speed: 40, durationMs: 700 });
  }

  assert.strictEqual(await pendingMoves() - before, 1, '심박마다 큐 행이 생겼다');
});

test('방향이 바뀌면 큐에 새 줄이 생긴다', async () => {
  motion.stop();
  const before = await pendingMoves();

  await post('/api/control/move', { direction: 'up', speed: 40, durationMs: 700 });
  await post('/api/control/move', { direction: 'up', speed: 40, durationMs: 700 });
  await post('/api/control/move', { direction: 'left', speed: 40, durationMs: 700 });

  assert.strictEqual(await pendingMoves() - before, 2, '방향 전환이 새 명령으로 남지 않았다');
});

test('큐에 저장되는 speed/durationMs는 클램핑된 값이다', async () => {
  motion.stop();
  await post('/api/control/move', { direction: 'down', speed: 99999, durationMs: 999999 });

  const list = (await get('/api/commands/pending?kind=move')).b.commands;
  const payload = list[list.length - 1].payload;
  assert.strictEqual(payload.speed, motion.MAX_SPEED);
  assert.strictEqual(payload.durationMs, motion.MAX_DURATION_MS);
});
