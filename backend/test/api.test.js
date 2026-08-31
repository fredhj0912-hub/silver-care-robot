const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// config 는 require 시점에 환경변수를 읽는다. 반드시 app 을 부르기 전에 설정한다.
// 실제 대화 로그(backend/data/hyodol.sqlite)를 건드리지 않도록 임시 DB를 쓴다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hyodol-test-'));
// .env에 DB_DRIVER=pg 가 설정돼 있어도 테스트가 실제 RDS를 치지 않게 고정한다
// (SNAPSHOT_STORAGE='local' 과 같은 이유 — 통합 테스트는 임시 SQLite에서만 돈다).
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = path.join(TMP, 'test.sqlite');
process.env.SNAPSHOT_DIR = path.join(TMP, 'snapshots');
process.env.ROBOT_API_KEY = 'test-key';
process.env.GEMINI_API_KEY = '';          // 결정론적 테스트를 위해 mock 경로 고정
process.env.SNAPSHOT_STORAGE = 'local';   // 환경에 s3가 설정돼 있어도 테스트가 실제 S3를 치지 않게
process.env.AWS_ACCESS_KEY_ID = '';
process.env.AWS_SECRET_ACCESS_KEY = '';
process.env.AWS_SESSION_TOKEN = '';
process.env.AWS_REGION = '';
process.env.ALERT_COOLDOWN_MS = '60000';
process.env.PUBLIC_DIR = '';              // 실제 .env에 배포용 값이 있어도 개발 모드로 고정

const { createApp } = require('../src/app');
const { query, initDB, closeDB } = require('../src/db');

let server;
let BASE;

const H = { 'Content-Type': 'application/json', 'x-api-key': 'test-key' };
const get = (p) => fetch(BASE + p, { headers: H }).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) })
  .then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));

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

test('인증: 키가 없으면 401, /api/health 는 공개', async () => {
  assert.strictEqual((await fetch(BASE + '/api/status')).status, 401);
  assert.strictEqual((await fetch(BASE + '/api/health')).status, 200);
});

test('PUBLIC_DIR 미설정이면 / 는 기존 상태 페이지를 유지한다', async () => {
  const res = await fetch(BASE + '/');
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /효돌이 백엔드 API 서버/);
});

test('알 수 없는 경로는 HTML이 아니라 JSON 404를 반환한다', async () => {
  const r = await get('/api/nope');
  assert.strictEqual(r.s, 404);
  assert.strictEqual(r.b.error, 'Not Found');
});

test('무해한 발화는 알림을 만들지 않는다 (오탐 회귀)', async () => {
  for (const text of ['한숨 한 번 쉬었어', '숨쉬기 운동을 했어', '숨기고 싶은 게 있어']) {
    const r = await post('/api/chat', { text });
    assert.strictEqual(r.b.alert, null, `오탐 발생: "${text}"`);
  }
  assert.strictEqual((await get('/api/status')).b.isEmergency, false);
});

test('위급 발화는 critical 알림을 만들고 비상 상태를 켠다', async () => {
  const r = await post('/api/chat', { text: '가슴이 아프고 숨을 못 쉬겠어' });
  assert.strictEqual(r.b.alert.severity, 'critical');
  assert.ok(['gemini', 'mock'].includes(r.b.source));
  assert.strictEqual((await get('/api/status')).b.isEmergency, true);
});

test('같은 유형 알림은 쿨다운으로 억제된다', async () => {
  const r = await post('/api/chat', { text: '살려줘 도와줘' });
  assert.strictEqual(r.b.alert, null);
});

test('모든 알림을 해제하면 비상 상태가 내려간다', async () => {
  for (const a of (await get('/api/alerts?resolved=false')).b.alerts) {
    await post('/api/alerts/resolve', { id: a.id, by: 'guardian' });
  }
  assert.strictEqual((await get('/api/status')).b.isEmergency, false);
});

test('수동 SOS 버튼: 기본값이 채워지고 쿨다운을 무시하고 항상 알림을 만든다', async () => {
  const first = await post('/api/alerts', {});
  assert.strictEqual(first.b.success, true);
  assert.strictEqual(first.b.alert.type, 'manual_panic_button');
  assert.strictEqual(first.b.alert.severity, 'critical');
  assert.strictEqual(first.b.alert.description, '어르신이 SOS 버튼을 직접 눌렀습니다');

  // 직전과 같은 유형이지만 skipCooldown 이라 음성 발화와 달리 억제되지 않아야 한다
  const second = await post('/api/alerts', {});
  assert.strictEqual(second.b.success, true);
  assert.notStrictEqual(second.b.alert.id, first.b.alert.id);

  for (const a of [first.b.alert, second.b.alert]) {
    await post('/api/alerts/resolve', { id: a.id, by: 'guardian' });
  }
  assert.strictEqual((await get('/api/status')).b.isEmergency, false);
});

test('수동 SOS: description을 직접 지정하면 그대로 반영된다', async () => {
  const r = await post('/api/alerts', { description: '커스텀 설명' });
  assert.strictEqual(r.b.alert.description, '커스텀 설명');
  await post('/api/alerts/resolve', { id: r.b.alert.id, by: 'guardian' });
});

test('명령 큐: 조회해도 큐가 비지 않고, ack 해야 사라진다 (구버전 버그 회귀)', async () => {
  const created = await post('/api/commands', { kind: 'speak', payload: { text: '약 드실 시간이에요' } });
  const id = created.b.command.id;

  const first = (await get('/api/commands/pending')).b.commands;
  const second = (await get('/api/commands/pending')).b.commands;
  assert.ok(first.some((c) => c.id === id), '첫 조회에 명령이 없다');
  assert.strictEqual(first.length, second.length, '조회만으로 큐가 비었다');

  await post(`/api/commands/${id}/ack`, {});
  const after = (await get('/api/commands/pending')).b.commands;
  assert.ok(!after.some((c) => c.id === id), 'ack 후에도 명령이 남아 있다');
});

test('보호자 메시지는 대화 로그에도 기록된다', async () => {
  const r = await get('/api/messages?sender=guardian&limit=10');
  assert.ok(r.b.messages.some((m) => m.text === '약 드실 시간이에요'));
});

test('비전: 유효한 이미지를 받아 최신 스냅샷으로 노출한다', async () => {
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const r = await post('/api/vision', { image: tinyPng });
  assert.strictEqual(r.s, 200);
  assert.ok(['gemini', 'mock'].includes(r.b.source));
  assert.strictEqual(typeof r.b.isEmergency, 'boolean');

  const latest = await get('/api/vision/latest');
  assert.strictEqual(latest.b.image, tinyPng);
  assert.ok(latest.b.capturedAt);
});

test('감지 이벤트에 스냅샷을 첨부하면 파일로 저장되고 알림에서 열람 가능하다', async () => {
  // 뒤이은 "감지 이벤트: 임계값" 테스트가 type:'fall' 을 쓰므로,
  // 쿨다운(같은 유형 알림 억제)에 걸리지 않도록 다른 유형을 쓴다.
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const r = await post('/api/detections', {
    source: 'mock', type: 'abnormal_posture', confidence: 0.99, snapshot: tinyPng,
  });
  assert.strictEqual(r.b.alertRaised, true);

  const alert = (await get(`/api/alerts/${r.b.alert.id}`)).b;
  assert.ok(alert.snapshotUrl, '스냅샷 URL이 비어 있다 (이전 버전은 base64를 100자로 잘라 저장해 열 수 없었다)');

  const img = await fetch(BASE + alert.snapshotUrl, { headers: H });
  assert.strictEqual(img.status, 200, '저장된 스냅샷 파일을 열 수 없다');
  // Content-Type 없이도 <img src>는 브라우저 스니핑 덕에 뜬다 — 그 운에 기대지 않는다.
  assert.strictEqual(img.headers.get('content-type'), 'image/png');
});

test('스냅샷: 존재하지 않는 파일은 404', async () => {
  const r = await get('/api/snapshots/does-not-exist.jpg');
  assert.strictEqual(r.s, 404);
});

test('스냅샷: 경로 순회 시도는 스냅샷 디렉터리를 벗어나지 못하고 404', async () => {
  // ../../package.json → safeFilename()이 path.basename()으로 디렉터리 부분을 모두
  // 벗겨내 'package.json'만 남긴다 — 스냅샷 폴더 밖 파일은 애초에 열 수 없다.
  const r = await get('/api/snapshots/%2e%2e%2f%2e%2e%2fpackage.json');
  assert.strictEqual(r.s, 404);
});

test('알림 상세: 존재하지 않는 id는 404', async () => {
  const r = await get('/api/alerts/999999');
  assert.strictEqual(r.s, 404);
  assert.strictEqual(r.b.error, '알림을 찾을 수 없습니다');
});

test('감지 이벤트: 임계값 미만은 기록만, 이상은 알림', async () => {
  const low = await post('/api/detections', { source: 'mock', type: 'fall', confidence: 0.3 });
  assert.strictEqual(low.b.alertRaised, false);
  assert.strictEqual(low.b.accepted, true);
  assert.strictEqual(low.b.suppressedBy, 'threshold');

  const high = await post('/api/detections', { source: 'mock', type: 'fall', confidence: 0.95 });
  assert.strictEqual(high.b.alertRaised, true);
  assert.strictEqual(high.b.suppressedBy, null);

  // 임계값을 넘겼는데도 알림이 안 나는 두 번째 이유가 쿨다운이다. 이 둘을 구분해 주지
  // 않으면 감지기 쪽에서 임계값 문제로 오해한다(실제로 그렇게 디버깅이 헛돌았다).
  const again = await post('/api/detections', { source: 'mock', type: 'fall', confidence: 0.95 });
  assert.strictEqual(again.b.alertRaised, false);
  assert.strictEqual(again.b.suppressedBy, 'cooldown');

  assert.ok((await get('/api/detections')).b.detections.length >= 2, '감지 원본이 기록되지 않았다');
});

test('메시지 커서 페이지네이션이 겹치지 않는다', async () => {
  const p1 = await get('/api/messages?limit=3');
  assert.strictEqual(p1.b.messages.length, 3);
  if (p1.b.nextCursor) {
    const p2 = await get(`/api/messages?limit=3&before=${p1.b.nextCursor}`);
    assert.ok(p2.b.messages.every((m) => m.id < p1.b.nextCursor), '페이지가 겹친다');
  }
});

test('메시지 검색(q)이 텍스트 부분일치로 동작한다', async () => {
  const marker = `검색마커${Date.now()}`;
  await post('/api/chat', { text: `${marker} 오늘 기분이 좋아요` });

  const found = await get(`/api/messages?q=${encodeURIComponent(marker)}&limit=10`);
  assert.ok(found.b.messages.some((m) => m.text.includes(marker)), '검색어가 포함된 메시지를 찾지 못했다');

  const notFound = await get(`/api/messages?q=존재하지않는검색어${Date.now()}`);
  assert.strictEqual(notFound.b.messages.length, 0);
});

test('일일 요약: KST 자정 기준으로 날짜 경계를 계산한다 (UTC 자정 기준이면 새벽 대화가 전날로 집계됨)', async () => {
  // KST 2026-08-26 03:00 은 UTC로 2026-08-25T18:00:00Z 다.
  // UTC 자정 기준이었다면 getUTCDate() 가 25일을 반환해 8/25로 잘못 집계됐을 시각이다.
  const kstEarlyMorning = new Date('2026-08-25T18:00:00.000Z');
  await query(
    `INSERT INTO messages (ts, sender, text, emotion, source) VALUES (?, 'senior', ?, 'neutral', 'legacy')`,
    [kstEarlyMorning.toISOString(), 'KST 새벽 3시 테스트 발화']
  );

  const summary = await get('/api/summary/daily?date=2026-08-26');
  assert.strictEqual(summary.b.date, '2026-08-26');
  assert.ok(
    summary.b.conversationTurns >= 1,
    `KST 새벽 3시(2026-08-26) 대화가 날짜 경계 밖으로 밀려났다 (turns=${summary.b.conversationTurns})`
  );

  // 같은 메시지가 UTC 기준 "전날"(2026-08-25) 요약에는 잡히지 않아야 한다
  const prevDay = await get('/api/summary/daily?date=2026-08-25');
  assert.strictEqual(prevDay.b.conversationTurns, 0, 'KST 새벽 대화가 UTC 기준 전날에 잘못 잡혔다');
});

test('일일 요약: 전체 메시지가 200건을 넘어도 과거 날짜를 정확히 조회한다', async () => {
  // list({limit:200}) + JS 필터 방식이었다면, 이 200건 채우기 이후로는
  // 과거 날짜 조회가 항상 0건을 반환했다 (그 날짜의 메시지가 "최신 200건" 밖으로 밀려나서).
  const targetDate = '2026-01-15T09:00:00.000Z'; // KST 2026-01-15 18:00
  await query(
    `INSERT INTO messages (ts, sender, text, emotion, source) VALUES (?, 'senior', '과거 날짜 테스트', 'neutral', 'legacy')`,
    [targetDate]
  );

  for (let i = 0; i < 205; i++) {
    await query(
      `INSERT INTO messages (ts, sender, text, emotion, source) VALUES (?, 'senior', '채우기', 'neutral', 'legacy')`,
      [new Date().toISOString()]
    );
  }

  const summary = await get('/api/summary/daily?date=2026-01-15');
  assert.ok(summary.b.conversationTurns >= 1, '200건 초과 후 과거 날짜 조회가 누락되었다');
});

test('입력 검증', async () => {
  assert.strictEqual((await post('/api/chat', { text: '' })).s, 400);
  assert.strictEqual((await post('/api/chat', { text: 'a'.repeat(1001) })).s, 400);
  assert.strictEqual((await post('/api/commands', { kind: 'launch' })).s, 400);
  assert.strictEqual((await post('/api/detections', { source: 'mock', type: 'fall', confidence: 5 })).s, 400);
  assert.strictEqual((await post('/api/vision', { image: 'not-a-data-uri' })).s, 400);
});

test('SSE: 연결 시 현재 상태를 보내고 이후 이벤트를 실시간 전달한다', async () => {
  const ctrl = new AbortController();
  const seen = [];

  const reading = fetch(`${BASE}/api/events?role=guardian&key=test-key`, { signal: ctrl.signal })
    .then(async (r) => {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (const m of buf.matchAll(/event: (\S+)/g)) if (!seen.includes(m[1])) seen.push(m[1]);
      }
    })
    .catch(() => {});

  await new Promise((r) => setTimeout(r, 300));
  await post('/api/commands', { kind: 'speak', payload: { text: 'SSE 확인' } });
  await new Promise((r) => setTimeout(r, 500));
  ctrl.abort();
  await reading;

  assert.ok(seen.includes('hello'), `hello 미수신 (수신: ${seen.join(', ')})`);
  assert.ok(seen.includes('command.issued'), `command.issued 미수신 (수신: ${seen.join(', ')})`);
});

test('푸시 구독: 새 origin으로 구독하면 옛 터널 주소의 구독은 정리된다', async () => {
  const subscribe = (origin, endpoint) => fetch(BASE + '/api/push/subscribe', {
    method: 'POST',
    headers: { ...H, Origin: origin },
    body: JSON.stringify({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
  }).then((r) => r.json());

  assert.deepStrictEqual(await subscribe('https://old.example', 'https://fcm.test/old'), { success: true });
  await subscribe('https://new.example', 'https://fcm.test/new');

  // 옛 origin의 구독을 FCM은 410으로 거부하지 않고 성공으로 응답한다 —
  // notify.js의 자동 정리에 안 걸리므로 구독 시점에 여기서 걷어내야 한다.
  const { rows } = await query('SELECT endpoint, origin FROM push_subscriptions', []);
  assert.deepStrictEqual(
    rows.map((r) => r.endpoint),
    ['https://fcm.test/new'],
    '사라진 터널 주소의 구독이 남아 있다'
  );
  assert.strictEqual(rows[0].origin, 'https://new.example');
});
