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
