const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// messagesRepo.purgeOlderThan은 실제 대화 로그를 지우는 함수라, 반드시 임시 DB에서만 검증한다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hyodol-retention-test-'));
// .env에 DB_DRIVER=pg 가 설정돼 있어도 테스트가 실제 RDS를 치지 않게 고정한다
// (SNAPSHOT_STORAGE='local' 과 같은 이유 — 통합 테스트는 임시 SQLite에서만 돈다).
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = path.join(TMP, 'test.sqlite');
process.env.SNAPSHOT_DIR = path.join(TMP, 'snapshots');

const { query, queryOne, initDB, closeDB } = require('../src/db');
const messagesRepo = require('../src/repositories/messages');

test.before(async () => {
  await initDB();
});

test.after(async () => {
  await closeDB();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function insertAt(isoTs) {
  await query(
    `INSERT INTO messages (ts, sender, text, emotion, source) VALUES (?, 'senior', 'x', 'neutral', 'legacy')`,
    [isoTs]
  );
}

const countMessages = async () => Number((await queryOne('SELECT COUNT(*) AS n FROM messages', [])).n);

test('90일보다 오래된 메시지만 삭제하고 최근 메시지는 남긴다', async () => {
  const now = Date.now();
  const old = new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString();  // 100일 전
  const recent = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10일 전
  await insertAt(old);
  await insertAt(recent);

  const cutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  const deleted = await messagesRepo.purgeOlderThan(cutoff);

  assert.strictEqual(deleted, 1, '90일 초과 메시지 1건만 삭제되어야 한다');
  const { rows: remaining } = await query('SELECT ts FROM messages', []);
  assert.ok(remaining.some((r) => r.ts === recent), '최근 메시지가 함께 삭제되었다');
  assert.ok(!remaining.some((r) => r.ts === old), '오래된 메시지가 삭제되지 않았다');
});

test('삭제 대상이 없으면 0을 반환하고 아무것도 지우지 않는다', async () => {
  const before = await countMessages();
  const deleted = await messagesRepo.purgeOlderThan('2000-01-01T00:00:00.000Z');
  assert.strictEqual(deleted, 0);
  assert.strictEqual(await countMessages(), before);
});
