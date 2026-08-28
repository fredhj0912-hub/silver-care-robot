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
