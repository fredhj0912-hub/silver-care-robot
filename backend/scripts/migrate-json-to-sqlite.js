#!/usr/bin/env node
/**
 * database.json → DB 일회성 이관.
 *
 *   node backend/scripts/migrate-json-to-sqlite.js [--dry-run]
 *
 * 여러 번 실행해도 안전하다(이미 메시지가 있으면 중단).
 *
 * 이름은 sqlite로 남아 있지만 실제로는 `DB_DRIVER`가 가리키는 DB로 들어간다 —
 * 원본 `database.json`이 2026-08-27에 삭제돼 이 스크립트는 사실상 이력용이다.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { initDB, queryOne, transaction, describeDB } = require('../src/db');

const DRY_RUN = process.argv.includes('--dry-run');

/** 이전 데이터는 +09:00 오프셋과 Z가 섞여 있었다. 전부 UTC로 통일한다. */
function toUTC(ts) {
  if (!ts) return new Date().toISOString();
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** 예전 알림 유형을 새 어휘로 옮긴다. */
const TYPE_MAP = {
  fall_sensor: 'fall_detected',
  manual_panic_button: 'manual_panic_button',
  voice_trigger: 'voice_trigger',
};

const countOf = async (sql) => Number((await queryOne(sql, [])).n);

async function main() {
  if (!fs.existsSync(config.legacyJsonPath)) {
    console.log(`이관할 ${config.legacyJsonPath} 파일이 없습니다. 건너뜁니다.`);
    return;
  }

  await initDB();

  const legacy = JSON.parse(fs.readFileSync(config.legacyJsonPath, 'utf8'));

  const existing = await countOf('SELECT COUNT(*) AS n FROM messages');
  if (existing > 0) {
    console.log(`DB에 이미 메시지 ${existing}건이 있습니다. 중복 이관을 막기 위해 중단합니다.`);
    console.log('다시 이관하려면 DB를 비우고 실행하세요:', describeDB());
    return;
  }

  const history = legacy.history || [];
  const alerts = legacy.alerts || [];
  const remote = legacy.remoteMessages || [];

  console.log(`이관 대상 — 대화 ${history.length}건, 알림 ${alerts.length}건, 미전달 메시지 ${remote.length}건`);
  if (DRY_RUN) {
    console.log('--dry-run 이므로 실제로 쓰지 않았습니다.');
    return;
  }

  await transaction(async (tx) => {
    for (const m of history) {
      const sender = ['senior', 'robot', 'guardian'].includes(m.sender) ? m.sender : 'robot';
      await tx.query(
        'INSERT INTO messages (ts, sender, text, emotion, source) VALUES (?, ?, ?, ?, ?)',
        [toUTC(m.timestamp), sender, String(m.text ?? ''), m.emotion || 'neutral', 'legacy']
      );
    }

    for (const a of alerts) {
      // 예전 snapshotUrl 은 base64를 100자로 자른 조각이라 복원 불가능하다. 버린다.
      await tx.query(
        `INSERT INTO alerts (ts, type, severity, description, confidence, snapshot_path, resolved, resolved_at, resolved_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          toUTC(a.timestamp),
          TYPE_MAP[a.type] || a.type || 'vision_anomaly',
          'critical',
          String(a.description ?? ''),
          null,
          null,
          a.resolved ? 1 : 0,
          a.resolvedAt ? toUTC(a.resolvedAt) : null,
          a.resolved ? 'senior' : null,
        ]
      );
    }

    for (const r of remote) {
      await tx.query(
        'INSERT INTO outbound_commands (ts, kind, payload) VALUES (?, ?, ?)',
        [toUTC(r.timestamp), 'speak', JSON.stringify({ text: String(r.text ?? '') })]
      );
    }

    const s = legacy.status || {};
    await tx.query(
      `UPDATE robot_status SET status = ?, battery = ?, last_active = ?, senior_expression = ?, is_emergency = ?
       WHERE id = 1`,
      [
        s.status || 'online',
        Number.isFinite(s.battery) ? s.battery : 100,
        toUTC(s.lastActive),
        s.seniorExpression || 'neutral',
        // 예전 데이터에서 미해결 알림이 남아 있으면 비상 상태를 유지한다
        alerts.some((a) => !a.resolved) ? 1 : 0,
      ]
    );
  });

  const counts = {
    messages: await countOf('SELECT COUNT(*) AS n FROM messages'),
    alerts: await countOf('SELECT COUNT(*) AS n FROM alerts'),
    commands: await countOf('SELECT COUNT(*) AS n FROM outbound_commands WHERE delivered = 0'),
  };

  console.log('✅ 이관 완료:', counts);
  console.log('   DB:', describeDB());
  console.log(`   원본 ${path.basename(config.legacyJsonPath)} 은 그대로 두었습니다. 확인 후 삭제하세요.`);
}

main().catch((err) => {
  console.error('이관 실패:', err.stack || err);
  process.exit(1);
});
