const test = require('node:test');
const assert = require('node:assert');

/**
 * pg 드라이버 경로를 인메모리 PostgreSQL(pg-mem)로 검증한다.
 *
 * 왜 필요한가: 나머지 테스트는 전부 SQLite로 돌기 때문에, 이것이 없으면
 * `schema.pg.sql`의 문법 오류나 pg 전용 동작 차이를 **RDS에 붙이는 순간에야**
 * 발견하게 된다. 여기서 리포지토리를 실제 pg 드라이버로 통과시켜 미리 잡는다.
 *
 * ⚠️ **pg-mem으로 검증되지 않는 것 (전부 변이 테스트로 확인한 실측이다):**
 *
 * 1. **트랜잭션 롤백.** pg-mem의 `pool.connect()`는 격리된 세션이 아니라 같은 객체를
 *    돌려주고 BEGIN/ROLLBACK이 no-op이다. SQLite 롤백은 `db-driver.test.js`가 검증한다.
 * 2. **COUNT/id의 타입.** 진짜 node-pg는 int8(COUNT, BIGINT)을 **문자열**로 주지만
 *    pg-mem은 항상 숫자를 준다. 그래서 아래 타입 단언들은 pg-mem 위에서는 통과만 할 뿐
 *    실제로 규칙을 지키는지 증명하지 못한다 — int8 파서를 지우거나 스키마를 BIGINT로
 *    바꿔도 여기서는 잡히지 않는다(변이 테스트로 확인).
 *
 * 이 두 가지는 **`npm run verify-rds`가 실제 RDS를 상대로 확인한다.** 그 스크립트에
 * 롤백 검사와 id/COUNT 타입 검사가 모두 들어 있다. RDS에 처음 붙일 때 반드시 실행할 것.
 *
 * 반대로 여기서 확실히 잡히는 것: 플레이스홀더 변환, `schema.pg.sql` 문법,
 * RETURNING, ON CONFLICT upsert, LIKE/커서, 트랜잭션 커밋 경로, JSON 왕복.
 */

const { newDb } = require('pg-mem');

// 실제 `pg` 자리에 pg-mem 어댑터를 끼워 넣는다. src/db/drivers/pg.js 는 이 사실을 모른다.
const mem = newDb();
require.cache[require.resolve('pg')] = {
  id: require.resolve('pg'),
  filename: require.resolve('pg'),
  loaded: true,
  exports: mem.adapters.createPg(),
};

process.env.DB_DRIVER = 'pg';
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.DATABASE_SSL = '0';
process.env.GEMINI_API_KEY = '';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';

const { initDB, queryOne, driverName } = require('../src/db');
const alertsRepo = require('../src/repositories/alerts');
const messagesRepo = require('../src/repositories/messages');
const medicationsRepo = require('../src/repositories/medications');
const commandsRepo = require('../src/repositories/commands');
const detectionsRepo = require('../src/repositories/detections');
const subscriptionsRepo = require('../src/repositories/subscriptions');
const statusRepo = require('../src/repositories/status');
const emergency = require('../src/services/emergency');

test.before(async () => {
  await initDB();
});

test('pg 드라이버가 선택되고 schema.pg.sql 이 적용된다', async () => {
  assert.strictEqual(driverName(), 'pg');

  const { rows } = await require('../src/db').query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    []
  );
  const present = new Set(rows.map((r) => r.table_name));
  for (const t of ['messages', 'alerts', 'outbound_commands', 'robot_status', 'push_subscriptions', 'detections', 'medications']) {
    assert.ok(present.has(t), `테이블 누락: ${t}`);
  }
});

test('상태 행이 정확히 하나 생긴다', async () => {
  const { n } = await queryOne('SELECT COUNT(*) AS n FROM robot_status', []);
  assert.strictEqual(Number(n), 1);

  // 재부팅 때 늘어나지 않는지(ON CONFLICT DO NOTHING 의 충돌 경로)는 여기서 확인할 수 없다 —
  // pg-mem 이 충돌이 실제로 일어나는 ON CONFLICT 를 'Not supported' 로 거부한다.
  // 표준 SQL 이라 실제 PostgreSQL 에서는 동작하며, npm run verify-rds 가 이를 확인한다
  // (initDB 후 robot_status 행 수를 검사하므로 두 번 실행하면 멱등성이 드러난다).
});

test('알림 생성이 pg 경로에서 동작한다 (id 타입은 verify-rds 가 확인)', async () => {
  const alert = await alertsRepo.create({
    type: 'fall_detected', severity: 'critical', description: 'id 타입 확인', confidence: 0.9,
  });
  assert.strictEqual(typeof alert.id, 'number');
});

test('COUNT 계열 함수가 pg 경로에서 동작한다 (숫자 정규화 여부는 verify-rds 가 확인)', async () => {
  // ⚠️ pg-mem 은 int8 을 이미 숫자로 주므로 아래 단언은 정규화를 증명하지 못한다.
  //    실제 node-pg 에서 문자열이 오는지는 verify-rds 가 검사한다.
  const n = await alertsRepo.unresolvedCount();
  assert.strictEqual(typeof n, 'number');

  const since = await messagesRepo.countSince('2000-01-01T00:00:00.000Z');
  assert.strictEqual(typeof since, 'number');

  const missed = await medicationsRepo.countMissedSince('2000-01-01T00:00:00.000Z');
  assert.strictEqual(typeof missed, 'number');
});

test('boolean 자리(정수 0/1)가 왕복한다', async () => {
  const on = await statusRepo.update({ isEmergency: true });
  assert.strictEqual(on.isEmergency, true);
  const off = await statusRepo.update({ isEmergency: false });
  assert.strictEqual(off.isEmergency, false);
});

test('LIKE 검색과 커서 페이지네이션이 동작한다', async () => {
  for (let i = 0; i < 3; i += 1) {
    await messagesRepo.add({ sender: 'senior', text: `커서확인${i}` });
  }
  const page = await messagesRepo.list({ q: '커서확인', limit: 2 });
  assert.strictEqual(page.messages.length, 2);
  assert.strictEqual(typeof page.nextCursor, 'number', 'nextCursor 가 숫자가 아니다');
});

test('명령 큐: enqueue → pending → ack', async () => {
  const cmd = await commandsRepo.enqueue({ kind: 'speak', payload: { text: '안녕하세요', label: '복약 알림' } });
  assert.strictEqual(cmd.delivered, false);
  assert.deepStrictEqual(cmd.payload, { text: '안녕하세요', label: '복약 알림' });

  const pending = await commandsRepo.pending({ kind: 'speak' });
  assert.ok(pending.some((c) => c.id === cmd.id));

  const { found } = await commandsRepo.ack(cmd.id);
  assert.strictEqual(found, true);
  assert.strictEqual((await commandsRepo.byId(cmd.id)).delivered, true);
});

test('푸시 구독 upsert (ON CONFLICT ... DO UPDATE)', async () => {
  await subscriptionsRepo.save({ endpoint: 'https://push/one', keys: { p256dh: 'a', auth: 'b' }, label: '폰' });
  await subscriptionsRepo.save({ endpoint: 'https://push/one', keys: { p256dh: 'c', auth: 'd' }, label: '폰(재등록)' });

  const all = await subscriptionsRepo.all();
  const mine = all.filter((s) => s.endpoint === 'https://push/one');
  assert.strictEqual(mine.length, 1, '같은 endpoint 가 중복 저장됐다');
  assert.strictEqual(mine[0].label, '폰(재등록)');

  await subscriptionsRepo.remove('https://push/one');
});

test('감지 기록: RETURNING 으로 id를 받는다', async () => {
  const id = await detectionsRepo.record({ source: 'mock', type: 'fall', confidence: 0.8, meta: { x: 1 } });
  assert.strictEqual(typeof id, 'number');

  const list = await detectionsRepo.list({ limit: 10 });
  const mine = list.find((d) => d.id === id);
  assert.deepStrictEqual(mine.meta, { x: 1 });
});

test('복약 반복 등록이 트랜잭션 안에서 여러 행을 만든다', async () => {
  const rows = await medicationsRepo.createMany({
    medicineName: '혈압약', scheduledAt: '2026-09-01T00:00:00.000Z', repeatDays: 3,
  });
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(
    rows.map((r) => r.scheduledAt),
    ['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z']
  );
});

test('emergency.raise()/resolveAlert() 가 pg 경로에서 상태까지 바꾼다', async () => {
  // 트랜잭션 커밋 경로. (롤백은 pg-mem이 지원하지 않아 verify-rds 가 실제 RDS에서 확인한다)
  const alert = await emergency.raise({
    type: 'manual_panic_button', severity: 'critical',
    description: 'pg 경로 확인', skipCooldown: true,
  });
  assert.ok(alert, '알림이 생성되지 않았다');
  assert.strictEqual((await statusRepo.get()).isEmergency, true);

  const result = await emergency.resolveAlert(alert.id, 'guardian');
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.alert.resolvedBy, 'guardian');
});
