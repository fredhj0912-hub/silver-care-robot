const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// config 는 require 시점에 환경변수를 읽는다. 반드시 services/snapshots를 부르기 전에 설정한다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hyodol-snapshots-test-'));
// SNAPSHOT_DIR 자리에 디렉터리 대신 '파일'을 미리 만들어, save()가 내부에서
// fs.mkdirSync(recursive:true)를 호출할 때 반드시 실패하도록 한다.
const BLOCKED_DIR = path.join(TMP, 'blocked-snapshot-dir');
fs.writeFileSync(BLOCKED_DIR, '');
process.env.SNAPSHOT_DIR = BLOCKED_DIR;
process.env.SNAPSHOT_STORAGE = 'local';
process.env.AWS_ACCESS_KEY_ID = '';
process.env.AWS_SECRET_ACCESS_KEY = '';
process.env.AWS_SESSION_TOKEN = '';
process.env.AWS_REGION = '';

const snapshots = require('../src/services/snapshots');
// config는 require 시점에 값이 고정된 객체다 — 이후 process.env를 바꿔도 반영되지 않는다.
// 같은 객체 참조를 mutate해야 snapshots.js가 읽는 값도 바뀐다.
const { config } = require('../src/config');

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// 회귀: save()가 저장 실패 시 예외를 던지면 asyncHandler를 거쳐 emergency.raise()가
// 아예 호출되지 못한 채 500으로 끝난다 — SOS 버튼/낙상 감지 알림 자체가 사라진다.
// (2026-08-28 adversarial review 발견, routes/vision.js·alerts.js는 이미
// snapshotPath===null을 "사진 없이 계속"으로 처리하고 있어 그 계약을 지켜야 한다)
test('save(): 저장 실패해도 예외를 던지지 않고 null을 반환한다', async () => {
  const result = await snapshots.save(TINY_PNG);
  assert.strictEqual(result, null);
});

test('save(): 유효하지 않은 data URI는 그대로 null', async () => {
  const result = await snapshots.save('not-a-data-uri');
  assert.strictEqual(result, null);
});

// SNAPSHOT_STORAGE를 나중에 바꿔도 이미 저장된 파일이 계속 정상 조회되려면
// 저장 당시의 provider가 파일명에 남아 있어야 한다.
test('save(): 파일명이 저장 당시 SNAPSHOT_STORAGE로 시작한다 (local)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyodol-snapshots-ok-'));
  const original = config.snapshotDir;
  config.snapshotDir = dir;
  try {
    const name = await snapshots.save(TINY_PNG);
    assert.match(name, /^local-\d+-[0-9a-f]{8}\.png$/);
  } finally {
    config.snapshotDir = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serve(): 접두어 없는 레거시 파일명은 local provider로 폴백한다', async () => {
  const { Writable } = require('node:stream');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyodol-snapshots-legacy-'));
  const original = config.snapshotDir;
  config.snapshotDir = dir;
  try {
    const legacyName = '1699999999999-deadbeef.png';
    fs.writeFileSync(path.join(dir, legacyName), Buffer.from('fake'));
    const statusCalls = [];
    const chunks = [];
    const res = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } });
    res.setHeader = () => {};
    res.status = (code) => { statusCalls.push(code); return res; };
    res.json = () => {};
    // serve()는 pipe()를 걸어두기만 하고 반환한다 — 스트림이 실제로 끝나는 건
    // 'finish' 이벤트를 기다려야 알 수 있다. 이걸 기다리지 않으면 finally의
    // fs.rmSync가 스트림보다 먼저 파일을 지워 ENOENT가 나기도 한다.
    const finished = new Promise((resolve, reject) => {
      res.on('finish', resolve);
      res.on('error', reject);
    });
    await snapshots.serve(legacyName, res);
    await finished;
    // 404가 아니라 파일 내용이 스트리밍됐다면 local provider로 정상 조회된 것
    assert.deepStrictEqual(statusCalls, []);
    assert.strictEqual(Buffer.concat(chunks).toString(), 'fake');
  } finally {
    config.snapshotDir = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
