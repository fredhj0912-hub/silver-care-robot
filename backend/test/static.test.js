const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// PUBLIC_DIR을 설정했을 때(EC2 배포 형태) 프론트엔드 빌드가 백엔드와 같은 오리진에서
// 서빙되는지 확인한다. config는 require 시점에 환경변수를 읽으므로 app 보다 먼저 쓴다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hyodol-static-'));
const DIST = path.join(TMP, 'dist');
fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });
fs.writeFileSync(path.join(DIST, 'index.html'), '<!doctype html><title>효돌이</title><div id="root"></div>');
fs.writeFileSync(path.join(DIST, 'sw.js'), '// service worker');
fs.writeFileSync(path.join(DIST, 'assets', 'index-abc123.js'), 'console.log(1)');

process.env.DB_PATH = path.join(TMP, 'test.sqlite');
process.env.SNAPSHOT_DIR = path.join(TMP, 'snapshots');
process.env.PUBLIC_DIR = DIST;
process.env.ROBOT_API_KEY = 'test-key';   // 키가 켜진 상태에서도 정적 자산이 뚫려야 한다
process.env.GEMINI_API_KEY = '';
process.env.SNAPSHOT_STORAGE = 'local';

const { createApp } = require('../src/app');
const { closeDB } = require('../src/db');

let server;
let BASE;

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await closeDB();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ROBOT_API_KEY가 정적 자산까지 막던 버그의 회귀 테스트.
// 막히면 증상이 "앱이 백지" 라서 원인을 찾기 어렵다.
test('API 키가 설정돼 있어도 정적 자산은 키 없이 200을 준다', async () => {
  for (const p of ['/sw.js', '/assets/index-abc123.js']) {
    assert.strictEqual((await fetch(BASE + p)).status, 200, `${p} 가 막혔다`);
  }
});

test('그래도 /api/* 는 여전히 키를 요구한다', async () => {
  assert.strictEqual((await fetch(BASE + '/api/status')).status, 401);
  assert.strictEqual(
    (await fetch(BASE + '/api/status', { headers: { 'x-api-key': 'test-key' } })).status,
    200
  );
});

test('클라이언트 라우트는 index.html 셸로 폴백한다', async () => {
  for (const p of ['/', '/guardian', '/guardian/alerts/42']) {
    const res = await fetch(BASE + p);
    assert.strictEqual(res.status, 200, `${p} 가 200이 아니다`);
    assert.match(await res.text(), /id="root"/, `${p} 가 셸을 돌려주지 않았다`);
  }
});

// 없는 API가 200 HTML을 받으면 프론트에서 JSON 파싱 에러로만 보여 원인 추적이 어렵다.
test('없는 API 경로는 셸이 아니라 JSON 404를 유지한다', async () => {
  const res = await fetch(BASE + '/api/nope', { headers: { 'x-api-key': 'test-key' } });
  assert.strictEqual(res.status, 404);
  assert.strictEqual((await res.json()).error, 'Not Found');
});
