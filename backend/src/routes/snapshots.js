const express = require('express');
const { asyncHandler } = require('../middleware');
const { config } = require('../config');
const snapshots = require('../services/snapshots');
const snapshotsRepo = require('../repositories/snapshots');

const router = express.Router();

/**
 * 분석 없는 스냅샷 경로 — 보호자가 방 안을 볼 수 있게 사진만 올린다.
 *
 * `POST /api/vision` 과의 차이가 이 파일의 존재 이유다: 저쪽은 프레임마다
 * Gemini Vision 을 부르는데, 무료 등급은 **대화와 같은 통(하루 40건)**을 쓴다.
 * 15초마다 부르면 10분 만에 하루치가 사라지고 대화·받아쓰기까지 같이 죽는다
 * (2026-09-04 실측). 그래서 Vision 을 끄면 보호자가 집 안을 볼 수단이 통째로
 * 사라졌다 — 이 경로는 **Gemini 를 한 번도 부르지 않고** 그 구멍만 메운다.
 *
 * 사진 파일은 services/snapshots.js 가 디스크나 S3 에 두고, DB 에는 파일명만 남는다.
 * 이미지 서빙(`GET /api/snapshots/:filename`)은 routes/alerts.js 에 있다 —
 * 응급 알림의 증거 사진과 같은 경로를 쓰기 때문이다.
 */
router.post('/snapshots', asyncHandler(async (req, res) => {
  const { image } = req.body || {};

  if (!image || typeof image !== 'string' || !snapshots.parseDataUri(image)) {
    return res.status(400).json({ error: 'data:image/ 로 시작하는 올바른 data URI가 필요합니다' });
  }
  if (Buffer.byteLength(image, 'utf8') > config.maxJsonBodyBytes) {
    return res.status(413).json({ error: '이미지 용량이 허용치를 초과했습니다' });
  }

  const filename = await snapshots.save(image);
  if (!filename) return res.status(500).json({ error: '스냅샷을 저장하지 못했습니다' });

  const saved = await snapshotsRepo.record(filename);

  // 보관 상한을 넘긴 것부터 정리한다. 행을 먼저 지우고 파일을 지우는 순서다 —
  // 반대로 하면 파일이 없는 행이 남아 보호자 화면에 깨진 사진이 뜬다.
  const removed = await snapshotsRepo.pruneToLimit(config.snapshotKeep);
  for (const name of removed) await snapshots.remove(name);

  res.json({ snapshot: saved, pruned: removed.length });
}));

/** 최신순 목록. 보호자 화면은 limit=1 로 "지금 방 안 모습"만 가져간다. */
router.get('/snapshots', asyncHandler(async (req, res) => {
  res.json({ snapshots: await snapshotsRepo.list(req.query.limit) });
}));

module.exports = router;
