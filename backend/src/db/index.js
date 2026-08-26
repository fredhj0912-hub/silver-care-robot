const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('../config');

let db = null;

/**
 * SQLite 연결을 열고 스키마를 적용한다.
 * node:sqlite는 Node 24 내장이라 네이티브 빌드가 없다 — 라즈베리파이에서도 설치 이슈가 없다.
 */
function getDB() {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.mkdirSync(config.snapshotDir, { recursive: true });

  db = new DatabaseSync(config.dbPath);
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  // 상태 행은 항상 정확히 하나 존재해야 한다
  db.exec(`
    INSERT OR IGNORE INTO robot_status (id, status, battery, last_active, senior_expression, is_emergency)
    VALUES (1, 'online', 100, '${new Date().toISOString()}', 'neutral', 0)
  `);

  return db;
}

function closeDB() {
  if (db) {
    db.close();
    db = null;
  }
}

/** 여러 쓰기를 한 트랜잭션으로 묶는다. node:sqlite에는 better-sqlite3의 .transaction()이 없다. */
function transaction(fn) {
  const conn = getDB();
  conn.exec('BEGIN');
  try {
    const result = fn(conn);
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

const nowISO = () => new Date().toISOString();

module.exports = { getDB, closeDB, transaction, nowISO };
