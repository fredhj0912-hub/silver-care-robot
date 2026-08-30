#!/usr/bin/env node
/**
 * SQLite(backend/data/hyodol.sqlite) → RDS PostgreSQL 데이터 이관.
 *
 *   cd backend && npm run migrate-pg [-- --dry-run]
 *
 * 여러 번 실행해도 안전하다 — 대상 DB에 이미 데이터가 있으면 중단한다.
 * `migrate-json-to-sqlite.js`의 멱등성 패턴을 그대로 따른다.
 *
 * 필요한 환경변수: DB_DRIVER=pg, DATABASE_URL (대상), DB_PATH(원본, 기본값 사용 가능)
 *
 * 주의: 원본 SQLite 파일은 **읽기만** 한다. 이관 후에도 그대로 남으므로
 * 문제가 생기면 DB_DRIVER=sqlite 로 되돌리면 된다.
 */
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('../src/config');
const { initDB, query, queryOne, transaction, closeDB, driverName, describeDB } = require('../src/db');

const DRY_RUN = process.argv.includes('--dry-run');

// id는 원본 값을 그대로 옮긴다 — alerts.id 를 참조하는 detections.alert_id 가 있고,
// 보호자 앱의 알림 딥링크(/guardian/alerts/:id)도 id를 그대로 쓴다.
const TABLES = [
  { name: 'messages', columns: ['id', 'ts', 'sender', 'text', 'emotion', 'source'] },
  { name: 'alerts', columns: ['id', 'ts', 'type', 'severity', 'description', 'confidence', 'snapshot_path', 'resolved', 'resolved_at', 'resolved_by'] },
  { name: 'outbound_commands', columns: ['id', 'ts', 'kind', 'payload', 'delivered', 'delivered_at'] },
  { name: 'push_subscriptions', columns: ['id', 'endpoint', 'keys_json', 'label', 'created_at'] },
  // detections 는 alerts.alert_id 를 참조하므로 alerts 뒤에 와야 한다
  { name: 'detections', columns: ['id', 'ts', 'source', 'type', 'confidence', 'meta_json', 'alert_id'] },
  { name: 'medications', columns: ['id', 'medicine_name', 'scheduled_at', 'status', 'taken_at', 'taken_by', 'reminded_at', 'notes', 'created_at'] },
];

const countOf = async (table) => Number((await queryOne(`SELECT COUNT(*) AS n FROM ${table}`, [])).n);

async function main() {
  if (driverName() !== 'pg') {
    console.log(`❌ DB_DRIVER 가 '${driverName()}' 입니다. 이관 대상이 PostgreSQL 이어야 합니다.`);
    console.log('   backend/.env 에 DB_DRIVER=pg 와 DATABASE_URL 을 설정하세요.');
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(config.dbPath)) {
    console.log(`원본 SQLite 파일이 없습니다: ${config.dbPath}`);
    console.log('이관할 데이터가 없으므로 종료합니다.');
    return;
  }

  console.log(`원본: ${config.dbPath}`);
  console.log(`대상: ${describeDB()}`);

  const src = new DatabaseSync(config.dbPath, { readOnly: true });
  await initDB();

  // 멱등성 — 대상에 이미 데이터가 있으면 손대지 않는다.
  const existing = await countOf('messages');
  if (existing > 0) {
    console.log(`\n대상 DB에 이미 메시지 ${existing}건이 있습니다. 중복 이관을 막기 위해 중단합니다.`);
    console.log('다시 이관하려면 대상 테이블을 비우고 실행하세요.');
    src.close();
    return;
  }

  const plan = TABLES.map(({ name }) => ({
    name,
    rows: src.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n,
  }));
  console.log('\n이관 대상:');
  for (const { name, rows } of plan) console.log(`  ${name.padEnd(20)} ${rows}건`);

  if (DRY_RUN) {
    console.log('\n--dry-run 이므로 실제로 쓰지 않았습니다.');
    src.close();
    return;
  }

  // 전부 한 트랜잭션으로 — 중간에 실패해서 절반만 옮겨진 DB로 서비스가 뜨면
  // 대화 로그와 알림 이력이 어긋난 채 보호자에게 보인다.
  await transaction(async (tx) => {
    for (const { name, columns } of TABLES) {
      const rows = src.prepare(`SELECT ${columns.join(', ')} FROM ${name}`).all();
      const placeholders = columns.map(() => '?').join(', ');
      for (const row of rows) {
        await tx.query(
          `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${placeholders})`,
          columns.map((c) => row[c])
        );
      }
      console.log(`  ${name} ${rows.length}건 이관`);
    }

    // 단일 행 테이블이라 INSERT가 아니라 UPDATE 다.
    const s = src.prepare('SELECT * FROM robot_status WHERE id = 1').get();
    if (s) {
      await tx.query(
        `UPDATE robot_status SET status = ?, battery = ?, last_active = ?, senior_expression = ?, is_emergency = ?
         WHERE id = 1`,
        [s.status, s.battery, s.last_active, s.senior_expression, s.is_emergency]
      );
      console.log('  robot_status 이관');
    }
  });

  // id를 명시적으로 넣었으므로 IDENTITY 시퀀스가 그대로면 다음 INSERT가 중복 id로 실패한다.
  // 각 테이블의 시퀀스를 현재 최대 id 다음으로 밀어 준다.
  for (const { name } of TABLES) {
    await query(
      `SELECT setval(pg_get_serial_sequence('${name}', 'id'), COALESCE((SELECT MAX(id) FROM ${name}), 0) + 1, false)`,
      []
    );
  }
  console.log('\n✅ id 시퀀스 재설정 완료 (다음 INSERT가 중복 id로 실패하지 않도록)');

  const after = {};
  for (const { name } of TABLES) after[name] = await countOf(name);
  console.log('✅ 이관 완료:', after);
  console.log(`\n원본 ${config.dbPath} 은 그대로 두었습니다.`);
  console.log('문제가 생기면 DB_DRIVER=sqlite 로 되돌릴 수 있습니다.');

  src.close();
}

main()
  .catch((err) => {
    console.error('\n❌ 이관 실패:', err.stack || err);
    process.exitCode = 1;
  })
  .finally(() => closeDB());
