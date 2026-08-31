const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// config 는 require 시점에 환경변수를 읽는다. 반드시 app 을 부르기 전에 설정한다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hyodol-medication-test-'));
// .env에 DB_DRIVER=pg 가 설정돼 있어도 테스트가 실제 RDS를 치지 않게 고정한다
// (SNAPSHOT_STORAGE='local' 과 같은 이유 — 통합 테스트는 임시 SQLite에서만 돈다).
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = path.join(TMP, 'test.sqlite');
process.env.SNAPSHOT_DIR = path.join(TMP, 'snapshots');
process.env.ROBOT_API_KEY = 'test-key';
process.env.GEMINI_API_KEY = '';
process.env.SNAPSHOT_STORAGE = 'local';
process.env.ALERT_COOLDOWN_MS = '60000';
process.env.PUBLIC_DIR = '';
// 실제 .env에 VAPID 키가 있으면 알림 테스트가 푸시 경로를 건드릴 수 있다 — 확실히 끈다.
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';

const { createApp } = require('../src/app');
const { exec, initDB, closeDB } = require('../src/db');
const medication = require('../src/services/medication');
const medicationsRepo = require('../src/repositories/medications');
const commandsRepo = require('../src/repositories/commands');
const alertsRepo = require('../src/repositories/alerts');
const statusRepo = require('../src/repositories/status');

let server;
let BASE;

const H = { 'Content-Type': 'application/json', 'x-api-key': 'test-key' };
const get = (p) => fetch(BASE + p, { headers: H }).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) })
  .then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const del = (p) => fetch(BASE + p, { method: 'DELETE', headers: H })
  .then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));

/** 틱 테스트끼리 서로의 행을 보지 않도록 초기화한다. */
async function reset() {
  await exec('DELETE FROM medications');
  await exec('DELETE FROM outbound_commands');
}

const minutesAgo = (from, n) => new Date(from.getTime() - n * 60 * 1000).toISOString();

test.before(async () => {
  await initDB();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await closeDB();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ──────────────────────────────────────────────
// 발화 분류 (순수 함수)
// ──────────────────────────────────────────────

test('약을 명시한 확인은 바로 복용으로 분류한다', () => {
  for (const text of ['약 먹었어', '아까 약을 먹었지', '약 챙겨 먹었어요', '약 다 먹었다']) {
    const r = medication.classifyUtterance(text);
    assert.strictEqual(r.intent, 'taken', `분류 실패: "${text}"`);
    assert.strictEqual(r.needsRecentReminder, false, `약을 명시했는데 알림을 요구함: "${text}"`);
  }
});

test('부정을 복용으로 오인하지 않는다 (부정 문구가 먼저 걸러져야 한다)', () => {
  // 전부 '먹었'을 포함하므로, 긍정 문구를 먼저 검사하면 복용으로 잘못 잡힌다.
  for (const text of ['아직 안 먹었어', '약 아직 못 먹었어', '안 먹었는데', '나중에 먹을게']) {
    assert.strictEqual(medication.classifyUtterance(text).intent, 'not_yet', `오분류: "${text}"`);
  }
});

test('약을 명시하지 않은 짧은 확인은 최근 알림을 요구한다 ("밥 먹었어" 오탐 방지)', () => {
  // 어르신이 로봇에게 가장 자주 하는 말 중 하나가 "밥 먹었어"다.
  // 이걸 복약 확인으로 처리하면 보호자는 약을 드신 줄 알고 넘어간다.
  const r = medication.classifyUtterance('밥 먹었어');
  assert.strictEqual(r.intent, 'taken');
  assert.strictEqual(r.needsRecentReminder, true, '최근 알림 없이도 복용 처리될 수 있다');
});

test('복약과 무관한 발화는 아무 의도도 없다', () => {
  for (const text of ['오늘 날씨 좋네', '', '   ', '손자가 왔어']) {
    assert.strictEqual(medication.classifyUtterance(text).intent, null, `오분류: "${text}"`);
  }
});

// ──────────────────────────────────────────────
// 등록 API
// ──────────────────────────────────────────────

test('등록하면 목록에 나오고, repeatDays 만큼 하루 간격 행이 생긴다', async () => {
  await reset();
  const at = '2026-09-01T09:00:00.000Z';
  const res = await post('/api/medications', { medicineName: '혈압약', scheduledAt: at, repeatDays: 3 });

  assert.strictEqual(res.s, 200);
  assert.strictEqual(res.b.medications.length, 3);
  assert.deepStrictEqual(
    res.b.medications.map((m) => m.scheduledAt),
    ['2026-09-01T09:00:00.000Z', '2026-09-02T09:00:00.000Z', '2026-09-03T09:00:00.000Z']
  );
  assert.strictEqual(res.b.medications[0].status, 'scheduled');

  const list = await get('/api/medications?from=2026-09-01T00:00:00.000Z&to=2026-09-04T00:00:00.000Z');
  assert.strictEqual(list.b.medications.length, 3);
});

test('잘못된 입력은 400으로 막는다', async () => {
  const bad = [
    [{ scheduledAt: '2026-09-01T09:00:00Z' }, '약 이름 없음'],
    [{ medicineName: '  ', scheduledAt: '2026-09-01T09:00:00Z' }, '공백뿐인 이름'],
    [{ medicineName: '혈압약', scheduledAt: '아무말' }, '날짜 아님'],
    [{ medicineName: '혈압약' }, '시각 없음'],
    [{ medicineName: '혈압약', scheduledAt: '2026-09-01T09:00:00Z', repeatDays: 0 }, '반복 0'],
    [{ medicineName: '혈압약', scheduledAt: '2026-09-01T09:00:00Z', repeatDays: 31 }, '반복 상한 초과'],
    [{ medicineName: '혈압약', scheduledAt: '2026-09-01T09:00:00Z', repeatDays: 1.5 }, '반복 소수'],
  ];
  for (const [body, why] of bad) {
    const res = await post('/api/medications', body);
    assert.strictEqual(res.s, 400, `통과하면 안 됨: ${why}`);
  }
});

test('보호자가 복용을 표시하면 takenBy 가 guardian 으로 남는다', async () => {
  await reset();
  const created = await post('/api/medications', { medicineName: '당뇨약', scheduledAt: '2026-09-01T09:00:00.000Z' });
  const id = created.b.medications[0].id;

  const res = await post(`/api/medications/${id}/taken`, {});
  assert.strictEqual(res.s, 200);
  assert.strictEqual(res.b.medication.status, 'taken');
  assert.strictEqual(res.b.medication.takenBy, 'guardian');
  assert.ok(res.b.medication.takenAt);
});

test('없는 일정은 404 (복용 표시/삭제 모두)', async () => {
  assert.strictEqual((await post('/api/medications/99999/taken', {})).s, 404);
  assert.strictEqual((await del('/api/medications/99999')).s, 404);
});

test('삭제하면 목록에서 사라진다', async () => {
  await reset();
  const created = await post('/api/medications', { medicineName: '지울약', scheduledAt: '2026-09-05T09:00:00.000Z' });
  const id = created.b.medications[0].id;

  assert.strictEqual((await del(`/api/medications/${id}`)).s, 200);
  const list = await get('/api/medications');
  assert.strictEqual(list.b.medications.find((m) => m.id === id), undefined);
});

// ──────────────────────────────────────────────
// 스케줄러
// ──────────────────────────────────────────────

test('시간이 되면 기존 speak 명령 큐에 복약 알림이 들어간다', async () => {
  await reset();
  const now = new Date();
  await medicationsRepo.createMany({
    medicineName: '혈압약', scheduledAt: minutesAgo(now, 5), notes: '식후에 드세요',
  });

  const result = await medication.tick(now);
  assert.strictEqual(result.reminded, 1);

  const pending = await commandsRepo.pending({ kind: 'speak' });
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].payload.text, '혈압약 드실 시간이에요. 식후에 드세요');
  // 라벨이 없으면 키오스크가 "보호자님 메시지"로 잘못 표시한다.
  assert.strictEqual(pending[0].payload.label, '복약 알림');
});

test('틱이 두 번 돌아도 같은 약을 두 번 말하지 않는다', async () => {
  await reset();
  const now = new Date();
  await medicationsRepo.createMany({ medicineName: '혈압약', scheduledAt: minutesAgo(now, 5) });

  await medication.tick(now);
  const second = await medication.tick(now);

  assert.strictEqual(second.reminded, 0);
  assert.strictEqual((await commandsRepo.pending({ kind: 'speak' })).length, 1);
});

test('아직 시간이 안 된 약은 알리지 않는다', async () => {
  await reset();
  const now = new Date();
  await medicationsRepo.createMany({ medicineName: '저녁약', scheduledAt: minutesAgo(now, -30) });

  assert.strictEqual((await medication.tick(now)).reminded, 0);
  assert.strictEqual((await commandsRepo.pending({ kind: 'speak' })).length, 0);
});

test('유예 시간을 넘긴 약은 뒤늦게 알리지 않고 미복용으로만 넘긴다', async () => {
  // 로봇이 몇 시간 꺼져 있다 켜졌을 때 밀린 알림을 쏟아내면 안 된다.
  await reset();
  const now = new Date();
  await medicationsRepo.createMany({ medicineName: '아침약', scheduledAt: minutesAgo(now, 5 * 60) });

  const result = await medication.tick(now);
  assert.strictEqual(result.reminded, 0, '지난 약을 뒤늦게 말했다');
  assert.strictEqual(result.missed, 1);
  assert.strictEqual((await commandsRepo.pending({ kind: 'speak' })).length, 0);
});

test('한 번 걸렀다고 알림을 만들지는 않는다', async () => {
  await reset();
  const now = new Date();
  await medicationsRepo.createMany({ medicineName: '한번약', scheduledAt: minutesAgo(now, 5 * 60) });

  const result = await medication.tick(now);
  assert.strictEqual(result.missed, 1);
  assert.strictEqual(result.alert, null, '한 번 거른 것으로 알림이 생겼다');
});

test('24시간 내 3번 거르면 warning 알림이 생기고, 응급 상태는 켜지지 않는다', async () => {
  await reset();
  const now = new Date();
  for (const n of [5 * 60, 8 * 60, 11 * 60]) {
    await medicationsRepo.createMany({ medicineName: '혈압약', scheduledAt: minutesAgo(now, n) });
  }

  const result = await medication.tick(now);
  assert.strictEqual(result.missed, 3);
  assert.ok(result.alert, '반복 미복용인데 알림이 없다');

  // 규칙 5: 미복용은 절대 critical 이 아니다. raise() 는 critical 일 때만 푸시를 보내므로
  // severity 가 warning 이면 보호자 폰으로 푸시가 나가지 않는다.
  assert.strictEqual(result.alert.severity, 'warning');
  assert.strictEqual(result.alert.type, 'medication_missed');
  assert.strictEqual((await statusRepo.get()).isEmergency, false, '미복용으로 비상 모드가 켜졌다');

  const stored = await alertsRepo.byId(result.alert.id);
  assert.strictEqual(stored.severity, 'warning');
});

// ──────────────────────────────────────────────
// 음성 복용 확인
// ──────────────────────────────────────────────

test('"약 먹었어" 발화로 지난 일정이 복용 처리된다', async () => {
  await reset();
  const now = new Date();
  await medicationsRepo.createMany({ medicineName: '혈압약', scheduledAt: minutesAgo(now, 10) });

  const taken = await medication.evaluateUtterance('약 먹었어', now);
  assert.ok(taken, '복용 처리되지 않았다');
  assert.strictEqual(taken.status, 'taken');
  assert.strictEqual(taken.takenBy, 'senior');
});

test('아직 오지 않은 일정은 발화로 복용 처리되지 않는다', async () => {
  await reset();
  const now = new Date();
  await medicationsRepo.createMany({ medicineName: '저녁약', scheduledAt: minutesAgo(now, -180) });

  assert.strictEqual(await medication.evaluateUtterance('약 먹었어', now), null);
});

test('"밥 먹었어"는 방금 복약 알림을 받은 경우에만 복용으로 인정한다', async () => {
  await reset();
  const now = new Date();
  await medicationsRepo.createMany({ medicineName: '혈압약', scheduledAt: minutesAgo(now, 30) });

  // 알림을 받은 적이 없으면 무시한다.
  assert.strictEqual(await medication.evaluateUtterance('밥 먹었어', now), null);

  // 방금 알림을 받았다면 짧은 대답도 복용 확인으로 인정한다.
  await medication.tick(now);
  const taken = await medication.evaluateUtterance('밥 먹었어', now);
  assert.ok(taken, '알림 직후의 짧은 확인이 무시됐다');
  assert.strictEqual(taken.status, 'taken');
});

test('부정 발화는 복용 처리하지 않는다', async () => {
  await reset();
  const now = new Date();
  await medicationsRepo.createMany({ medicineName: '혈압약', scheduledAt: minutesAgo(now, 10) });

  assert.strictEqual(await medication.evaluateUtterance('아직 안 먹었어', now), null);
  const [med] = await medicationsRepo.list({});
  assert.strictEqual(med.status, 'scheduled');
});

test('대화 API 가 복약 확인을 함께 처리한다', async () => {
  await reset();
  const now = new Date();
  await medicationsRepo.createMany({ medicineName: '혈압약', scheduledAt: minutesAgo(now, 10) });

  const res = await post('/api/chat', { text: '방금 약 먹었어' });
  assert.strictEqual(res.s, 200);
  assert.ok(res.b.medicationTaken, '대화에서 복약 확인이 처리되지 않았다');
  assert.strictEqual(res.b.medicationTaken.medicineName, '혈압약');
  assert.strictEqual(res.b.alert, null, '복약 확인이 응급 알림을 만들었다');
});

test('시리즈 삭제는 앞으로 남은 예정만 지우고 지난 기록은 남긴다', async () => {
  await reset();
  const now = new Date();
  const created = await medicationsRepo.createMany({
    medicineName: '혈압약', scheduledAt: minutesAgo(now, 60), repeatDays: 5,
  });

  // 이미 지난 첫 건은 복용 처리해 둔다 — 기록이 지워지면 안 된다.
  await medicationsRepo.markTaken(created[0].id, 'senior');

  const res = await del(`/api/medications/${created[4].id}?scope=series`);
  assert.strictEqual(res.s, 200);
  assert.strictEqual(res.b.removed, 4, '앞으로 남은 4건이 지워져야 한다');

  const left = await medicationsRepo.list({});
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].status, 'taken', '복용 기록이 지워졌다');
});
