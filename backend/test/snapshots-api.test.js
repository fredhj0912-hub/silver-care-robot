const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// api.test.js 와 같은 격리 방식 — 실제 대화 로그(backend/data)를 건드리지 않는다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dolbom-snapshots-api-'));
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = path.join(TMP, 'test.sqlite');
process.env.SNAPSHOT_DIR = path.join(TMP, 'snapshots');
process.env.SNAPSHOT_STORAGE = 'local';
process.env.ROBOT_API_KEY = 'test-key';
process.env.GEMINI_API_KEY = '';
process.env.PUBLIC_DIR = '';
// 보관 상한을 작게 잡아 정리 동작을 몇 장으로 확인한다.
process.env.SNAPSHOT_KEEP = '3';

const { createApp } = require('../src/app');
const { initDB, closeDB } = require('../src/db');

let server;
let BASE;

const H = { 'Content-Type': 'application/json', 'x-api-key': 'test-key' };
const get = (p) => fetch(BASE + p, { headers: H }).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) })
  .then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));

// 1x1 투명 PNG. 실제 이미지여야 services/snapshots.js 의 data URI 검사를 통과한다.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const filesOnDisk = () => fs.readdirSync(process.env.SNAPSHOT_DIR).sort();

test.before(async () => {
  await initDB();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await closeDB();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('사진만 올리는 경로는 Gemini 없이 저장하고 목록에 나온다', async () => {
  const r = await post('/api/snapshots', { image: PNG });
  assert.strictEqual(r.s, 200);
  assert.ok(r.b.snapshot.id);
  assert.match(r.b.snapshot.url, /^\/api\/snapshots\/local-/);
  assert.ok(r.b.snapshot.capturedAt);

  const list = await get('/api/snapshots?limit=1');
  assert.strictEqual(list.b.snapshots[0].id, r.b.snapshot.id);
});

test('올린 사진은 기존 서빙 경로로 실제로 내려받힌다', async () => {
  const { b } = await post('/api/snapshots', { image: PNG });
  const res = await fetch(BASE + b.snapshot.url, { headers: H });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'image/png');
  assert.ok((await res.arrayBuffer()).byteLength > 0);
});

test('data URI 가 아니면 400', async () => {
  assert.strictEqual((await post('/api/snapshots', { image: 'not-an-image' })).s, 400);
  assert.strictEqual((await post('/api/snapshots', {})).s, 400);
});

test('보관 상한을 넘기면 오래된 것부터 행과 파일이 함께 사라진다', async () => {
  // 이 테스트 전까지 2장이 들어가 있다. 상한은 3장(SNAPSHOT_KEEP).
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await post('/api/snapshots', { image: PNG })).b.snapshot.id);

  const list = await get('/api/snapshots?limit=100');
  assert.strictEqual(list.b.snapshots.length, 3, '상한을 넘긴 행이 남아 있다');
  assert.deepStrictEqual(list.b.snapshots.map((s) => s.id), [...ids].reverse());

  // 행만 지우고 파일을 두면 디스크가 영원히 찬다 — 그게 이 단언의 이유다.
  assert.strictEqual(filesOnDisk().length, 3, '지워진 행의 파일이 디스크에 남아 있다');

  // 남아 있는 사진은 여전히 열려야 한다 (파일을 잘못 지웠는지 확인)
  const alive = await fetch(BASE + list.b.snapshots[0].url, { headers: H });
  assert.strictEqual(alive.status, 200);
});

test('응급 알림의 증거 사진은 보관 상한과 무관하다', async () => {
  const sos = await post('/api/alerts', { description: '증거 사진 테스트', image: PNG });
  const evidenceUrl = sos.b.alert.snapshotUrl;
  assert.ok(evidenceUrl, '알림에 스냅샷이 붙지 않았다');

  // 상한(3장)을 훌쩍 넘게 올려 정리를 여러 번 돌린다
  for (let i = 0; i < 5; i++) await post('/api/snapshots', { image: PNG });

  const res = await fetch(BASE + evidenceUrl, { headers: H });
  assert.strictEqual(res.status, 200, '증거 사진이 스냅샷 정리에 휩쓸려 사라졌다');
});
