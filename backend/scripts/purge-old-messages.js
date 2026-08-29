#!/usr/bin/env node
/**
 * 오래된 대화 로그를 삭제한다.
 *
 *   npm run purge-old-messages                # 90일 초과 메시지 삭제
 *   npm run purge-old-messages -- --days 30    # 보관 기간 조정
 *   npm run purge-old-messages -- --dry-run    # 삭제하지 않고 대상 건수만 확인
 *
 * 어르신 대화 로그는 민감 정보이므로 무한 적재하지 않는다. 알림(alerts)은
 * 안전 관련 감사 기록이라 대상에서 제외한다 — 지운다면 별도 정책이 필요하다.
 *
 * 지금은 실행 스케줄이 없다(cron/작업 스케줄러 미설정). 배포 시 주기적으로
 * 돌리도록 등록하거나, 서버 부팅 훅에 연결하는 것을 고려할 것.
 */
const { getDB } = require('../src/db');
const messagesRepo = require('../src/repositories/messages');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const days = Number(arg('days', '90'));
const dryRun = process.argv.includes('--dry-run');

if (!Number.isFinite(days) || days <= 0) {
  console.error(`--days 는 양수여야 합니다 (받은 값: ${arg('days', '')})`);
  process.exit(1);
}

const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

if (dryRun) {
  const target = getDB()
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE ts < ?')
    .get(cutoff).n;
  console.log(`[dry-run] ${days}일(${cutoff} 이전) 초과 메시지 ${target}건이 삭제 대상입니다.`);
  console.log('실제로 삭제하려면 --dry-run 없이 다시 실행하세요.');
  process.exit(0);
}

// 리포지토리가 async라 IIFE로 감싼다 (CommonJS는 top-level await 불가).
(async () => {
  const total = getDB().prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const deleted = await messagesRepo.purgeOlderThan(cutoff);

  console.log(`${days}일(${cutoff} 이전) 초과 메시지 ${deleted}건 삭제 완료 (전체 ${total}건 중).`);
})().catch((err) => {
  console.error('삭제 실패:', err.stack || err);
  process.exit(1);
});
