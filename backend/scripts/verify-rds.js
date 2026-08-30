#!/usr/bin/env node
/**
 * RDS PostgreSQL 연결이 실제로 되는지 확인하는 스모크 테스트.
 *
 *   cd backend && npm run verify-rds
 *
 * `services/snapshots.js`의 `verify-s3.js`와 같은 역할이다. 다만 S3와 결정적으로 다른 점:
 * **RDS는 사용자/비밀번호 인증이라 대회 계정의 Access Key 발급 금지 제약에 걸리지 않는다.**
 * EC2 안에서만 확인 가능한 S3와 달리 **로컬에서 그대로 검증된다.**
 * 테스트 스위트는 SQLite로 돌기 때문에, pg 경로를 실제로 확인하는 수단은 이 스크립트뿐이다.
 *
 * 필요한 환경변수 (backend/.env):
 *   DB_DRIVER=pg
 *   DATABASE_URL=postgres://사용자:비밀번호@호스트:5432/DB이름
 */
const { config } = require('../src/config');
const { initDB, query, queryOne, transaction, closeDB, driverName, describeDB } = require('../src/db');

const TEST_TS = `verify-rds-${Date.now()}`;

async function main() {
  if (driverName() !== 'pg') {
    console.log(`❌ DB_DRIVER 가 '${driverName()}' 입니다. backend/.env 에 DB_DRIVER=pg 를 설정하세요.`);
    console.log('   (이 스크립트는 PostgreSQL 경로만 확인합니다)');
    process.exitCode = 1;
    return;
  }
  if (!config.databaseUrl) {
    console.log('❌ DATABASE_URL 이 비어 있습니다.');
    console.log('   postgres://사용자:비밀번호@호스트:5432/DB이름 형식으로 설정하세요.');
    process.exitCode = 1;
    return;
  }

  console.log(`대상: ${describeDB()}`);

  // 1) 연결 + 스키마 적용 (CREATE TABLE IF NOT EXISTS 라 여러 번 돌려도 안전하다)
  await initDB();
  console.log('✅ 연결 + 스키마 적용');

  // 2) 스키마가 기대한 테이블을 전부 갖췄는지
  const expected = ['messages', 'alerts', 'outbound_commands', 'robot_status', 'push_subscriptions', 'detections', 'medications'];
  const { rows } = await query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    []
  );
  const present = new Set(rows.map((r) => r.table_name));
  const missing = expected.filter((t) => !present.has(t));
  if (missing.length) throw new Error(`테이블 누락: ${missing.join(', ')}`);
  console.log(`✅ 테이블 ${expected.length}개 확인`);

  // 3) 상태 행이 정확히 하나인지 (INSERT ... ON CONFLICT DO NOTHING 이 제대로 도는지)
  const statusCount = Number((await queryOne('SELECT COUNT(*) AS n FROM robot_status', [])).n);
  if (statusCount !== 1) throw new Error(`robot_status 행이 ${statusCount}개입니다 (1개여야 함)`);
  console.log('✅ 상태 행 1개');

  // 4) 알림 왕복 — INSERT ... RETURNING / 타입 / DELETE 까지
  const created = await queryOne(
    `INSERT INTO alerts (ts, type, severity, description, confidence, resolved)
     VALUES (?, 'vision_anomaly', 'warning', ?, ?, 0)
     RETURNING *`,
    [new Date().toISOString(), TEST_TS, 0.5]
  );
  if (typeof created.id !== 'number') {
    throw new Error(`alerts.id 가 ${typeof created.id} 로 옵니다 — 스키마의 id 를 INTEGER 로 두세요 (BIGINT면 문자열이 옵니다)`);
  }
  console.log(`✅ INSERT ... RETURNING (id=${created.id}, 타입 number)`);

  const counted = await queryOne('SELECT COUNT(*) AS n FROM alerts WHERE description = ?', [TEST_TS]);
  if (typeof counted.n !== 'number') {
    throw new Error(`COUNT 가 ${typeof counted.n} 로 옵니다 — pg 드라이버의 int8 타입 파서를 확인하세요`);
  }
  console.log('✅ COUNT 가 숫자로 정규화됨');

  // 5) 트랜잭션 롤백 — emergency.raise()/resolveAlert() 가 여기에 기대고 있다
  await transaction(async (tx) => {
    await tx.query(`UPDATE alerts SET description = ? WHERE id = ?`, ['rollback-me', created.id]);
    throw new Error('의도적 롤백');
  }).catch(() => {});
  const afterRollback = await queryOne('SELECT description FROM alerts WHERE id = ?', [created.id]);
  if (afterRollback.description !== TEST_TS) throw new Error('롤백이 동작하지 않았습니다');
  console.log('✅ 트랜잭션 롤백');

  // 6) 뒷정리 — 확인용 행을 남기지 않는다
  const { rowCount } = await query('DELETE FROM alerts WHERE description = ?', [TEST_TS]);
  console.log(`✅ 정리 완료 (${rowCount}건 삭제)`);

  console.log('\n🎉 RDS PostgreSQL 연결 정상. DB_DRIVER=pg 로 서버를 띄울 수 있습니다.');
}

main()
  .catch((err) => {
    console.error('\n❌ 실패:', err.message);
    if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED/.test(err.message)) {
      console.error('   호스트에 닿지 못했습니다 — RDS 보안 그룹에 내 IP의 5432 인바운드가 열려 있는지,');
      console.error('   인스턴스가 중지 상태는 아닌지 확인하세요.');
    }
    if (/password|authentication/i.test(err.message)) {
      console.error('   인증 실패 — DATABASE_URL 의 사용자/비밀번호를 확인하세요.');
    }
    process.exitCode = 1;
  })
  .finally(() => closeDB());
