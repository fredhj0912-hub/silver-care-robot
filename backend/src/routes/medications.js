const express = require('express');
const { asyncHandler } = require('../middleware');
const { config } = require('../config');
const medicationsRepo = require('../repositories/medications');

const router = express.Router();

/**
 * 복약 일정 등록. `repeatDays`만큼 하루 간격 행을 그 자리에서 만든다 —
 * 반복 규칙을 따로 저장하지 않으므로 스케줄러(`services/medication.js`)는 행만 보면 된다.
 */
router.post('/medications', asyncHandler(async (req, res) => {
  const { medicineName, scheduledAt, notes, repeatDays } = req.body || {};

  const name = typeof medicineName === 'string' ? medicineName.trim() : '';
  if (!name) {
    return res.status(400).json({ error: '약 이름(medicineName)이 필요합니다' });
  }
  if (name.length > config.maxMedicineNameChars) {
    return res.status(400).json({ error: `약 이름은 ${config.maxMedicineNameChars}자를 넘을 수 없습니다` });
  }

  const at = new Date(scheduledAt);
  if (!scheduledAt || Number.isNaN(at.getTime())) {
    return res.status(400).json({ error: '복용 시각(scheduledAt)이 올바른 날짜여야 합니다' });
  }

  const days = repeatDays === undefined ? 1 : Number(repeatDays);
  if (!Number.isInteger(days) || days < 1 || days > config.maxRepeatDays) {
    return res.status(400).json({ error: `반복 일수는 1~${config.maxRepeatDays} 사이의 정수여야 합니다` });
  }

  let note = null;
  if (notes !== undefined && notes !== null && notes !== '') {
    if (typeof notes !== 'string') {
      return res.status(400).json({ error: '메모(notes)는 문자열이어야 합니다' });
    }
    if (notes.length > config.maxMedicationNotesChars) {
      return res.status(400).json({ error: `메모는 ${config.maxMedicationNotesChars}자를 넘을 수 없습니다` });
    }
    note = notes.trim() || null;
  }

  const medications = await medicationsRepo.createMany({
    medicineName: name,
    scheduledAt: at.toISOString(),
    notes: note,
    repeatDays: days,
  });

  res.json({ success: true, medications });
}));

/** 기간·상태로 조회한다. 날짜 경계(KST)는 화면이 정하고 여기서는 받은 구간만 본다. */
router.get('/medications', asyncHandler(async (req, res) => {
  const { from, to, status, limit } = req.query;
  res.json({ medications: await medicationsRepo.list({ from, to, status, limit }) });
}));

/** 보호자가 대신 복용을 표시한다. 어르신 음성 확인은 `services/medication.js`가 처리한다. */
router.post('/medications/:id/taken', asyncHandler(async (req, res) => {
  const by = (req.body || {}).by === 'senior' ? 'senior' : 'guardian';
  const { found, medication } = await medicationsRepo.markTaken(req.params.id, by);

  if (!medication) return res.status(404).json({ error: '복약 일정을 찾을 수 없습니다' });
  res.json({ success: found, medication });
}));

/**
 * 일정 삭제. `?scope=series`면 같은 등록에서 나온 앞으로 남은 일정을 한꺼번에 지운다 —
 * 30일치를 잘못 등록했을 때 한 건씩 지우게 하면 남은 것이 미복용으로 쌓인다.
 */
router.delete('/medications/:id', asyncHandler(async (req, res) => {
  if (req.query.scope === 'series') {
    const removed = await medicationsRepo.removeSeriesFrom(req.params.id, new Date().toISOString());
    if (!removed) return res.status(404).json({ error: '지울 수 있는 예정 일정이 없습니다' });
    return res.json({ success: true, removed });
  }

  const removed = await medicationsRepo.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: '복약 일정을 찾을 수 없습니다' });
  res.json({ success: true, removed: 1 });
}));

module.exports = router;
