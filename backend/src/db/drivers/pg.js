const fs = require('fs');
const path = require('path');
const { config } = require('../../config');

/**
 * PostgreSQL(RDS) 드라이버.
 *
 * S3(`services/snapshots.js`)와 달리 RDS는 **사용자/비밀번호 인증**이라 대회 계정의
 * Access Key 발급 금지 제약에 걸리지 않는다 — 로컬에서도 실제 연결 검증이 가능하다.
 * (`npm run verify-rds`)
 *
 * `pg`는 sqlite 모드에서는 전혀 필요 없으므로 지연 require 한다 —
 * `services/snapshots.js`가 `@aws-sdk/client-s3`를 다루는 방식과 같다.
 */

let Pool = null;
let pool = null;

function load() {
  if (Pool) return;
  try {
    const pg = require('pg');
    Pool = pg.Pool;

    // COUNT(*)는 int8(oid 20)이고, node-pg는 int8을 기본적으로 **문자열**로 준다.
    // 그대로 두면 `countMissedSince() >= 3` 같은 비교가 문자열 비교가 되어 조용히 어긋난다.
    // (SQLite는 number를 주므로 두 드라이버의 결과 타입을 여기서 맞춘다.)
    pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  } catch {
    throw new Error("DB_DRIVER=pg 인데 'pg' 패키지를 불러오지 못했습니다 — npm install pg 를 실행하세요");
  }
}

/**
 * 리포지토리는 계속 `?`로 쓰고 여기서 `$1, $2…`로 바꾼다.
 * 이 레포의 SQL에는 문자열 리터럴 안에 든 `?`가 없다(`text LIKE ?`도 `%q%`를
 * 파라미터로 넘긴다). 새 쿼리를 쓸 때 리터럴 안에 `?`를 넣지 말 것.
 */
function toPlaceholders(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function getPool() {
  if (pool) return pool;
  load();

  if (!config.databaseUrl) {
    throw new Error('DB_DRIVER=pg 인데 DATABASE_URL이 설정되지 않았습니다');
  }

  pool = new Pool({
    connectionString: config.databaseUrl,
    // RDS는 SSL을 요구한다. 대회 계정 RDS는 사설 CA를 쓰므로 체인 검증은 끄되
    // 전송 암호화는 유지한다 (팀원 FastAPI도 sslmode=require 로 같은 설정을 쓴다).
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
    max: 5,
  });
  return pool;
}

async function query(sql, params = []) {
  const res = await getPool().query(toPlaceholders(sql), params);
  return { rows: res.rows, rowCount: res.rowCount };
}

async function queryOne(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows.length ? rows[0] : null;
}

async function exec(sql) {
  await getPool().query(sql);
}

/** 스키마를 적용하고 상태 행을 보장한다. 부팅과 verify-rds가 함께 쓴다. */
async function applySchema() {
  const ddl = fs.readFileSync(path.join(__dirname, '..', 'schema.pg.sql'), 'utf8');
  await exec(ddl);
  await query(
    `INSERT INTO robot_status (id, status, battery, last_active, senior_expression, is_emergency)
     VALUES (1, 'online', 100, ?, 'neutral', 0)
     ON CONFLICT (id) DO NOTHING`,
    [new Date().toISOString()]
  );
}

/**
 * 트랜잭션. BEGIN/COMMIT은 **한 커넥션에서만** 유효하므로 풀에서 클라이언트를
 * 하나 빌려 그 위에서만 질의한다 — 콜백은 반드시 넘겨받은 `tx`를 써야 하고,
 * 전역 `query()`를 쓰면 다른 커넥션으로 새어 트랜잭션 밖이 된다.
 */
async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const tx = {
      query: async (sql, params = []) => {
        const res = await client.query(toPlaceholders(sql), params);
        return { rows: res.rows, rowCount: res.rowCount };
      },
      queryOne: async (sql, params = []) => {
        const res = await client.query(toPlaceholders(sql), params);
        return res.rows.length ? res.rows[0] : null;
      },
    };
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** 부팅 배너용. 비밀번호가 로그에 찍히지 않도록 호스트/DB 이름만 보여준다. */
function describe() {
  try {
    const u = new URL(config.databaseUrl);
    return `postgres (${u.hostname}${u.pathname})`;
  } catch {
    return 'postgres (DATABASE_URL 형식 오류)';
  }
}

module.exports = { query, queryOne, exec, transaction, close, describe, applySchema, toPlaceholders };
