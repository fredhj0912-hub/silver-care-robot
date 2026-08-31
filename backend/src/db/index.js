const { config } = require('../config');

/**
 * DB 접근의 단일 창구. 리포지토리는 여기서 나오는 `query`/`queryOne`/`transaction`만 쓴다.
 *
 * 드라이버 스위치(`DB_DRIVER=sqlite|pg`)는 `services/snapshots.js`의
 * `SNAPSHOT_STORAGE=local|s3`와 같은 패턴이다 — 루트 CLAUDE.md가 새 외부 연동을
 * 그 패턴 뒤에 두라고 정하고 있다.
 *
 * **SQL은 두 드라이버에서 그대로 돌아가야 한다.** 지킬 규칙:
 *  1. 플레이스홀더는 항상 `?` — pg 드라이버가 `$1,$2…`로 바꾼다.
 *     (문자열 리터럴 안에 `?`를 넣지 말 것)
 *  2. 새로 만든 행의 id가 필요하면 `lastInsertRowid`가 아니라 `RETURNING id`를 쓴다.
 *     node:sqlite도 RETURNING을 지원한다(실측: SQLite 3.53.1).
 *  3. boolean 컬럼은 양쪽 다 **정수 0/1**이다. node:sqlite는 true/false 바인딩을
 *     아예 거부하고, PG를 BOOLEAN으로 만들면 0/1 바인딩이 거부된다.
 *     읽을 때는 `Boolean(row.x)`가 양쪽 모두에서 동작한다.
 */

const DRIVERS = {
  sqlite: () => require('./drivers/sqlite'),
  pg: () => require('./drivers/pg'),
};

const name = DRIVERS[config.dbDriver] ? config.dbDriver : 'sqlite';
const driver = DRIVERS[name]();

/**
 * 이미 만들어진 테이블에 덧붙일 컬럼. 스키마 파일은 `CREATE TABLE IF NOT EXISTS` 뿐이라
 * 기존 DB에는 새 컬럼이 붙지 않는다. SQLite는 `ADD COLUMN IF NOT EXISTS`를 지원하지 않으므로
 * "이미 있음" 예외만 삼키는 것이 두 드라이버에서 통하는 유일한 방법이다.
 */
const ADDED_COLUMNS = [
  'ALTER TABLE push_subscriptions ADD COLUMN origin TEXT',
];

const ALREADY_EXISTS = /duplicate column|already exists/i;

async function addMissingColumns() {
  for (const sql of ADDED_COLUMNS) {
    try {
      await driver.exec(sql);
    } catch (err) {
      if (!ALREADY_EXISTS.test(err.message)) throw err;
    }
  }
}

/** 스키마를 적용한다. 부팅(server.js)과 테스트 준비에서 한 번 호출한다. */
async function initDB() {
  if (driver.applySchema) await driver.applySchema();
  else await driver.exec('SELECT 1'); // sqlite는 첫 접속에서 스키마가 적용된다
  await addMissingColumns();
}

const query = (sql, params) => driver.query(sql, params);
const queryOne = (sql, params) => driver.queryOne(sql, params);
const exec = (sql) => driver.exec(sql);
const transaction = (fn) => driver.transaction(fn);
const closeDB = () => driver.close();

/** 부팅 배너·진단용 */
const driverName = () => name;
const describeDB = () => driver.describe();

const nowISO = () => new Date().toISOString();

module.exports = {
  initDB, query, queryOne, exec, transaction, closeDB,
  driverName, describeDB, nowISO,
};
