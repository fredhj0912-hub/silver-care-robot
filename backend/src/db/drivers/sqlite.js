const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('../../config');

/**
 * SQLite 드라이버 (개발·테스트 기본값).
 *
 * node:sqlite는 Node 24 내장이라 네이티브 빌드가 없다 — 라즈베리파이에서도 설치 이슈가 없다.
 * `DatabaseSync`는 **동기**이므로 아래 함수들은 실제로는 즉시 값을 반환하지만,
 * pg 드라이버와 계약을 맞추기 위해 async로 감싼다.
 */

let db = null;

/**
 * 이 문장이 행을 돌려주는가?
 * node:sqlite는 SELECT/RETURNING에는 `.all()`, 나머지에는 `.run()`을 써야
 * `changes`를 얻을 수 있다(plain INSERT에 `.all()`을 쓰면 `[]`만 오고 changes를 잃는다).
 * 이 레포의 SQL은 전부 1차 작성물이라 이 단순한 판별로 충분하다.
 */
const RETURNS_ROWS = /^\s*(SELECT|WITH)\b|\bRETURNING\b/i;

/** node:sqlite가 주는 행은 프로토타입이 null이다 — 평범한 객체로 바꿔 놓는다. */
const plain = (row) => (row ? { ...row } : null);

function conn() {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.mkdirSync(config.snapshotDir, { recursive: true });

  db = new DatabaseSync(config.dbPath);
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));

  // 상태 행은 항상 정확히 하나 존재해야 한다
  db.exec(`
    INSERT OR IGNORE INTO robot_status (id, status, battery, last_active, senior_expression, is_emergency)
    VALUES (1, 'online', 100, '${new Date().toISOString()}', 'neutral', 0)
  `);

  return db;
}

function runOn(connection, sql, params) {
  const stmt = connection.prepare(sql);
  if (RETURNS_ROWS.test(sql)) {
    const rows = stmt.all(...params).map(plain);
    return { rows, rowCount: rows.length };
  }
  const info = stmt.run(...params);
  return { rows: [], rowCount: Number(info.changes) };
}

async function query(sql, params = []) {
  return runOn(conn(), sql, params);
}

async function queryOne(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** 스키마 적용·테스트 정리처럼 파라미터가 없는 raw DDL/DML 용도. */
async function exec(sql) {
  conn().exec(sql);
}

/**
 * 여러 쓰기를 한 트랜잭션으로 묶는다.
 * SQLite는 단일 커넥션이라 tx가 곧 같은 연결이다. `DatabaseSync`가 동기라
 * 이 안에서 await를 해도 다른 요청이 끼어들 수 없다.
 */
async function transaction(fn) {
  const connection = conn();
  connection.exec('BEGIN');
  try {
    const tx = {
      query: async (sql, params = []) => runOn(connection, sql, params),
      queryOne: async (sql, params = []) => {
        const { rows } = runOn(connection, sql, params);
        return rows.length ? rows[0] : null;
      },
    };
    const result = await fn(tx);
    connection.exec('COMMIT');
    return result;
  } catch (err) {
    connection.exec('ROLLBACK');
    throw err;
  }
}

async function close() {
  if (db) {
    db.close();
    db = null;
  }
}

/** 부팅 배너에 표시할 한 줄. */
const describe = () => `sqlite (${config.dbPath})`;

module.exports = { query, queryOne, exec, transaction, close, describe };
