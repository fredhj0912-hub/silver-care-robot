const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// config 는 require 시점에 환경변수를 읽는다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hyodol-driver-test-'));
process.env.DB_PATH = path.join(TMP, 'test.sqlite');
process.env.SNAPSHOT_DIR = path.join(TMP, 'snapshots');
process.env.GEMINI_API_KEY = '';

const { query, queryOne, exec, transaction, initDB, closeDB, driverName } = require('../src/db');
const { toPlaceholders } = require('../src/db/drivers/pg');

/**
 * 드라이버 계약 테스트.
 *
 * 두 드라이버(sqlite/pg)가 **같은 SQL로 같은 모양의 결과**를 내야 리포지토리를
 * 한 벌만 유지할 수 있다. 여기서 깨지면 pg 전환 시 조용히 어긋나는 것들이다 —
 * 특히 COUNT 타입은 `countMissedSince() >= 3` 같은 비교를 문자열 비교로
 * 바꿔 버려서 테스트 없이는 알아채기 어렵다.
 */

test.before(async () => {
  await initDB();
});

test.after(async () => {
  await closeDB();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('플레이스홀더 변환: ?를 순서대로 $1, $2…로 바꾼다', () => {
  assert.strictEqual(
    toPlaceholders('SELECT * FROM t WHERE a = ? AND b = ? LIMIT ?'),
    'SELECT * FROM t WHERE a = $1 AND b = $2 LIMIT $3'
  );
  // ?가 없으면 그대로 둔다
  assert.strictEqual(toPlaceholders('SELECT COUNT(*) AS n FROM t'), 'SELECT COUNT(*) AS n FROM t');
});

test('INSERT ... RETURNING 으로 새 행을 그대로 받는다 (lastInsertRowid 대신)', async () => {
  const row = await queryOne(
    `INSERT INTO messages (ts, sender, text, emotion, source)
     VALUES (?, 'senior', ?, 'neutral', 'legacy')
     RETURNING *`,
    [new Date().toISOString(), 'RETURNING 확인']
  );
  assert.ok(row, 'RETURNING 이 행을 돌려주지 않았다');
  assert.strictEqual(typeof row.id, 'number', 'id 가 숫자가 아니다 — PG에서 BIGINT를 쓰면 문자열이 온다');
  assert.strictEqual(row.text, 'RETURNING 확인');
});

test('COUNT(*)는 문자열이 아니라 숫자로 온다', async () => {
  // pg는 int8을 기본적으로 문자열로 준다. 그대로 두면 `>= 3` 비교가 문자열 비교가 되어
  // "10" < "3" 같은 결과가 나온다 — 미복용 3회 판정과 미해결 알림 0건 판정이 여기 걸려 있다.
  const row = await queryOne('SELECT COUNT(*) AS n FROM messages', []);
  assert.strictEqual(typeof row.n, 'number', `COUNT가 ${typeof row.n} 로 왔다`);
});

test('쓰기 질의는 rowCount로 영향 행 수를 돌려준다', async () => {
  const ts = new Date().toISOString();
  await query(
    `INSERT INTO messages (ts, sender, text, emotion, source) VALUES (?, 'senior', 'rowCount', 'neutral', 'legacy')`,
    [ts]
  );
  const { rowCount } = await query('DELETE FROM messages WHERE ts = ?', [ts]);
  assert.strictEqual(rowCount, 1);

  const none = await query('DELETE FROM messages WHERE ts = ?', ['2000-01-01T00:00:00.000Z']);
  assert.strictEqual(none.rowCount, 0);
});

test('boolean 자리는 정수 0/1이다 (양쪽 드라이버 공통)', async () => {
  // node:sqlite는 true/false 바인딩을 아예 거부하고, PG를 BOOLEAN으로 만들면
  // 0/1 바인딩이 거부된다. 그래서 스키마와 바인딩 모두 정수로 통일돼 있다.
  await query('UPDATE robot_status SET is_emergency = ? WHERE id = 1', [1]);
  const on = await queryOne('SELECT is_emergency FROM robot_status WHERE id = 1', []);
  assert.strictEqual(Boolean(on.is_emergency), true);

  await query('UPDATE robot_status SET is_emergency = ? WHERE id = 1', [0]);
  const off = await queryOne('SELECT is_emergency FROM robot_status WHERE id = 1', []);
  assert.strictEqual(Boolean(off.is_emergency), false);
});

test('트랜잭션이 커밋되면 쓴 내용이 남는다', async () => {
  const ts = new Date().toISOString();
  const returned = await transaction(async (tx) => {
    const row = await tx.queryOne(
      `INSERT INTO messages (ts, sender, text, emotion, source)
       VALUES (?, 'senior', '커밋됨', 'neutral', 'legacy') RETURNING *`,
      [ts]
    );
    return row.id;
  });

  const found = await queryOne('SELECT * FROM messages WHERE id = ?', [returned]);
  assert.ok(found, '커밋했는데 행이 없다');
  assert.strictEqual(found.text, '커밋됨');
});

test('트랜잭션 안에서 예외가 나면 전부 롤백된다', async () => {
  // emergency.raise() 가 이 성질에 기대고 있다 — 알림 생성과 비상 상태 전환이
  // 반쪽만 적용되면 보호자 화면과 DB가 어긋난다.
  const ts = new Date().toISOString();
  const before = (await queryOne('SELECT COUNT(*) AS n FROM messages', [])).n;

  await assert.rejects(
    transaction(async (tx) => {
      await tx.query(
        `INSERT INTO messages (ts, sender, text, emotion, source)
         VALUES (?, 'senior', '롤백되어야 함', 'neutral', 'legacy')`,
        [ts]
      );
      throw new Error('의도적 실패');
    }),
    /의도적 실패/
  );

  const after = (await queryOne('SELECT COUNT(*) AS n FROM messages', [])).n;
  assert.strictEqual(after, before, '롤백됐어야 하는데 행이 남았다');

  const leaked = await queryOne('SELECT * FROM messages WHERE ts = ?', [ts]);
  assert.strictEqual(leaked, null, '롤백된 행이 조회된다');
});

test('exec()는 파라미터 없는 raw DML을 실행한다', async () => {
  await exec("INSERT INTO messages (ts, sender, text, emotion, source) VALUES ('2001-01-01T00:00:00.000Z', 'senior', 'exec', 'neutral', 'legacy')");
  const row = await queryOne("SELECT * FROM messages WHERE ts = '2001-01-01T00:00:00.000Z'", []);
  assert.ok(row);
  await exec("DELETE FROM messages WHERE ts = '2001-01-01T00:00:00.000Z'");
});

test('기본 드라이버는 sqlite다 (DB_DRIVER 미설정 시)', () => {
  assert.strictEqual(driverName(), process.env.DB_DRIVER || 'sqlite');
});
