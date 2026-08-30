import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { formatTime, formatDay, dayKey, kstDayStartISO } from '../format';

const MAX_NAME = 100;
const DAYS_AHEAD = 7;

const STATE_TEXT = {
  scheduled: '아직 확인 전이에요',
  taken: '드셨어요',
  missed: '못 드셨어요',
};

/** datetime-local 기본값 — 오늘 오전 9시(보호자 기기의 로컬 시각) */
function defaultWhen() {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 복약 — 보호자가 약 일정을 등록하면 시간이 됐을 때 효돌이가 소리 내어 알린다.
 *
 * 어르신이 "약 먹었어"라고 대답하면 백엔드가 알아서 복용 처리하므로
 * (`services/medication.js`), 이 화면의 「드셨어요」 버튼은 보호자가 대신 표시하는 용도다.
 */
function MedicationScreen() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [when, setWhen] = useState(defaultWhen);
  const [repeatDays, setRepeatDays] = useState('7');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const from = kstDayStartISO(0);
      const to = kstDayStartISO(DAYS_AHEAD);
      const res = await apiFetch(`/api/medications?from=${from}&to=${to}&limit=200`);
      if (res.ok) {
        const data = await res.json();
        setItems(data.medications);
      }
    } catch {
      setError('효돌이와 연결되지 않아요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    const medicineName = name.trim();
    if (!medicineName || saving) return;

    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/medications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          medicineName,
          // datetime-local 은 기기 로컬 시각이다. 백엔드는 UTC만 받으므로 여기서 변환한다.
          scheduledAt: new Date(when).toISOString(),
          repeatDays: Number(repeatDays),
        }),
      });
      if (res.ok) {
        setName('');
        await load();
      } else {
        const body = await res.json().catch(() => null);
        setError(body?.error || '등록하지 못했어요.');
      }
    } catch {
      setError('효돌이와 연결되지 않아요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  const markTaken = async (id) => {
    await apiFetch(`/api/medications/${id}/taken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'guardian' }),
    });
    load();
  };

  /** 반복 등록은 행을 며칠치 미리 만들어 두므로, 앞으로 남은 것을 한 번에 지운다. */
  const removeSeries = async (id) => {
    await apiFetch(`/api/medications/${id}?scope=series`, { method: 'DELETE' });
    load();
  };

  let lastDay = null;

  return (
    <main>
      <h1 className="g-section-title">복약</h1>
      <p className="g-note-inline" style={{ margin: '0 20px 16px' }}>
        시간이 되면 효돌이가 어르신께 소리로 알려드려요.
      </p>

      <form className="g-medform" onSubmit={submit}>
        <div>
          <label className="g-medform__label" htmlFor="med-name">약 이름</label>
          <input
            id="med-name"
            className="g-field__input"
            type="text"
            maxLength={MAX_NAME}
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            placeholder="예) 혈압약"
          />
        </div>

        <div className="g-medform__row">
          <div>
            <label className="g-medform__label" htmlFor="med-when">복용 시각</label>
            <input
              id="med-when"
              className="g-field__input"
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </div>
          <div>
            <label className="g-medform__label" htmlFor="med-days">며칠 동안</label>
            <input
              id="med-days"
              className="g-field__input"
              type="number"
              min={1}
              max={30}
              value={repeatDays}
              onChange={(e) => setRepeatDays(e.target.value)}
            />
          </div>
        </div>

        <button className="g-btn g-btn--primary" type="submit" disabled={!name.trim() || saving}>
          {saving ? '등록하는 중' : '일정 등록하기'}
        </button>
      </form>

      {error && (
        <p className="g-note-inline" style={{ color: 'var(--alarm)' }}>{error}</p>
      )}

      {!loading && items.length === 0 ? (
        <p className="g-empty">
          아직 등록된 약이 없어요.<br />
          약 이름과 시각을 넣으면 효돌이가 챙겨드릴게요.
        </p>
      ) : (
        <div className="g-list">
          {items.map((med) => {
            const day = dayKey(med.scheduledAt);
            const showDay = day !== lastDay;
            lastDay = day;

            return (
              <React.Fragment key={med.id}>
                {showDay && <div className="g-daymark">{formatDay(med.scheduledAt)}</div>}
                <div className={`g-med is-${med.status}`}>
                  <div className="g-med__head">
                    <span className="g-med__name">{med.medicineName}</span>
                    <span className="g-med__time">{formatTime(med.scheduledAt)}</span>
                  </div>
                  {med.notes && <p className="g-med__notes">{med.notes}</p>}

                  <div className="g-med__foot">
                    {med.status === 'taken' ? (
                      <span className="g-med__state is-taken">
                        {STATE_TEXT.taken}
                        {med.takenBy === 'guardian' ? ' (보호자 확인)' : ''}
                        {med.takenAt ? ` · ${formatTime(med.takenAt)}` : ''}
                      </span>
                    ) : (
                      <>
                        <button
                          className="g-med__btn g-med__btn--take"
                          type="button"
                          onClick={() => markTaken(med.id)}
                        >
                          드셨어요
                        </button>
                        <span className={`g-med__state is-${med.status}`}>
                          {STATE_TEXT[med.status]}
                        </span>
                      </>
                    )}
                    <button
                      className="g-med__btn"
                      type="button"
                      onClick={() => removeSeries(med.id)}
                    >
                      일정 지우기
                    </button>
                  </div>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </main>
  );
}

export default MedicationScreen;
