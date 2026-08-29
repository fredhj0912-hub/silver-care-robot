const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// messagesRepo.purgeOlderThan은 실제 대화 로그를 지우는 함수라, 반드시 임시 DB에서만 검증한다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hyodol-retention-test-'));
process.env.DB_PATH = path.join(TMP, 'test.sqlite');
process.env.SNAPSHOT_DIR = path.join(TMP, 'snapshots');

const { getDB, closeDB } = require('../src/db');
const messagesRepo = require('../src/repositories/messages');

test.after(() => {
  closeDB();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function insertAt(isoTs) {
  getDB()
    .prepare(`INSERT INTO messages (ts, sender, text, emotion, source) VALUES (?, 'senior', 'x', 'neutral', 'legacy')`)
    .run(isoTs);
}

test('90일보다 오래된 메시지만 삭제하고 최근 메시지는 남긴다', async () => {
  const now = Date.now();
  const old = new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString();  // 100일 전
  const recent = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10일 전
  insertAt(old);
  insertAt(recent);

  const cutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  const deleted = await messagesRepo.purgeOlderThan(cutoff);

  assert.strictEqual(deleted, 1, '90일 초과 메시지 1건만 삭제되어야 한다');
  const remaining = getDB().prepare('SELECT ts FROM messages').all();
  assert.ok(remaining.some((r) => r.ts === recent), '최근 메시지가 함께 삭제되었다');
  assert.ok(!remaining.some((r) => r.ts === old), '오래된 메시지가 삭제되지 않았다');
});

test('삭제 대상이 없으면 0을 반환하고 아무것도 지우지 않는다', async () => {
  const before = getDB().prepare('SELECT COUNT(*) n FROM messages').get().n;
  const deleted = await messagesRepo.purgeOlderThan('2000-01-01T00:00:00.000Z');
  assert.strictEqual(deleted, 0);
  assert.strictEqual(getDB().prepare('SELECT COUNT(*) n FROM messages').get().n, before);
});
