const { getDB, transaction, nowISO } = require('../db');

/**
 * 복약 일정. 한 행 = 한 번의 복용.
 *
 * 팀원(seola0219/silver-care-medication-api)의 `medication_records` 모델을 가져오되
 * 이 프로젝트 규칙에 맞췄다: `senior_id` 제거(어르신 1인 전용), 시각은 ISO8601 UTC TEXT,
 * `reminded_at` 추가(로봇이 같은 약을 반복해서 말하지 않게 하는 가드).
 */

function toApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    medicineName: row.medicine_name,
    scheduledAt: row.scheduled_at,
    status: row.status,
    takenAt: row.taken_at,
    takenBy: row.taken_by,
    remindedAt: row.reminded_at,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

async function byId(id) {
  return toApi(getDB().prepare('SELECT * FROM medications WHERE id = ?').get(Number(id)));
}

/**
 * 하루 간격으로 `repeatDays`개의 행을 만든다. 반복 규칙을 따로 저장하지 않고
 * 등록 시점에 펼쳐 두는 것이 이 기능의 유일한 반복 처리다 — 스케줄러는 행만 보면 된다.
 *
 * 여러 행을 한 트랜잭션으로 묶는다. 중간에 실패해서 "3일치 중 1일치만 등록됨" 상태가
 * 되면 보호자는 등록에 성공한 줄 알고 나머지 이틀을 놓친다.
 */
async function createMany({ medicineName, scheduledAt, notes = null, repeatDays = 1 }) {
  const start = new Date(scheduledAt).getTime();
  const created = nowISO();

  const ids = transaction((conn) => {
    const stmt = conn.prepare(
      'INSERT INTO medications (medicine_name, scheduled_at, notes, created_at) VALUES (?, ?, ?, ?)'
    );
    const out = [];
    for (let day = 0; day < repeatDays; day += 1) {
      const at = new Date(start + day * 24 * 60 * 60 * 1000).toISOString();
      out.push(stmt.run(medicineName, at, notes, created).lastInsertRowid);
    }
    return out;
  });

  return Promise.all(ids.map(byId));
}

async function list({ from = null, to = null, status = null, limit = 100 } = {}) {
  const where = [];
  const params = [];

  if (from) { where.push('scheduled_at >= ?'); params.push(from); }
  if (to) { where.push('scheduled_at < ?'); params.push(to); }
  if (status) { where.push('status = ?'); params.push(status); }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return getDB()
    .prepare(`SELECT * FROM medications ${clause} ORDER BY scheduled_at ASC, id ASC LIMIT ?`)
    .all(...params, Math.min(Number(limit) || 100, 500))
    .map(toApi);
}

/**
 * 복용 시각이 지났는데 아직 로봇이 알리지 않은 건. 스케줄러가 이것만 본다.
 *
 * `notBeforeIso`(유예 시간 시작점)보다 오래된 건은 제외한다 — 로봇이 몇 시간 꺼져
 * 있다가 켜지면 밀린 알림을 한꺼번에 쏟아내는데, 이미 지난 약을 뒤늦게 알리는 것은
 * 도움이 안 되고 어르신을 혼란스럽게 한다. 그런 건은 알리지 않고 미복용으로만 남긴다.
 */
async function due(nowIso, notBeforeIso) {
  return getDB()
    .prepare(
      `SELECT * FROM medications
       WHERE status = 'scheduled' AND reminded_at IS NULL
         AND scheduled_at <= ? AND scheduled_at >= ?
       ORDER BY scheduled_at ASC`
    )
    .all(nowIso, notBeforeIso)
    .map(toApi);
}

async function markReminded(id) {
  return getDB()
    .prepare('UPDATE medications SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL')
    .run(nowISO(), Number(id)).changes > 0;
}

async function markTaken(id, by = 'senior') {
  const changes = getDB()
    .prepare(
      `UPDATE medications SET status = 'taken', taken_at = ?, taken_by = ?
       WHERE id = ? AND status != 'taken'`
    )
    .run(nowISO(), by, Number(id)).changes;
  return { found: changes > 0, medication: await byId(id) };
}

/** 유예 시간이 지나도 복용 표시가 없는 건을 missed로 넘긴다. @returns 바뀐 행 수 */
async function markMissedBefore(iso) {
  return getDB()
    .prepare("UPDATE medications SET status = 'missed' WHERE status = 'scheduled' AND scheduled_at < ?")
    .run(iso).changes;
}

async function countMissedSince(iso) {
  return getDB()
    .prepare("SELECT COUNT(*) AS n FROM medications WHERE status = 'missed' AND scheduled_at >= ?")
    .get(iso).n;
}

/**
 * 어르신이 "약 먹었어"라고 했을 때 어느 건을 복용 처리할지 고른다.
 * 복용 시각이 이미 지난 미복용 건 중 **가장 최근** 것 하나. 미래 일정은 건드리지 않는다 —
 * 아직 오지도 않은 저녁 약이 아침 발화로 복용 처리되면 안 된다.
 */
async function latestPendingBefore(iso) {
  return toApi(
    getDB()
      .prepare(
        `SELECT * FROM medications
         WHERE status IN ('scheduled', 'missed') AND scheduled_at <= ?
         ORDER BY scheduled_at DESC, id DESC LIMIT 1`
      )
      .get(iso)
  );
}

async function remove(id) {
  return getDB().prepare('DELETE FROM medications WHERE id = ?').run(Number(id)).changes > 0;
}

/**
 * 같은 등록(시리즈)에서 나온 **앞으로 남은** 일정을 한꺼번에 지운다.
 *
 * 반복 등록은 행을 30일치까지 미리 펼쳐 두므로, 잘못 등록했을 때 한 건씩 지우게 하면
 * 지우다 만 나머지가 미복용으로 쌓여 보호자에게 경고까지 올라간다.
 * 같은 시리즈는 `created_at`이 동일하다 — 그것을 시리즈 키로 쓴다.
 * 이미 지난 일정과 복용 기록은 건드리지 않는다.
 */
async function removeSeriesFrom(id, fromIso) {
  const row = getDB().prepare('SELECT medicine_name, created_at FROM medications WHERE id = ?').get(Number(id));
  if (!row) return 0;

  return getDB()
    .prepare(
      `DELETE FROM medications
       WHERE medicine_name = ? AND created_at = ?
         AND status = 'scheduled' AND scheduled_at >= ?`
    )
    .run(row.medicine_name, row.created_at, fromIso).changes;
}

module.exports = {
  byId, createMany, list, due, markReminded, markTaken,
  markMissedBefore, countMissedSince, latestPendingBefore, remove, removeSeriesFrom,
};
