import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { formatTime, relativeTime } from '../format';

const REFRESH_MS = 10000;

/**
 * 방 안 모습 — 마지막으로 찍힌 카메라 스냅샷.
 *
 * 실시간 영상이 아니라 정지 사진이다. 로봇이 카메라 모니터링을 켠 상태에서만
 * 갱신되므로(VITE_VISION_ENABLED), 꺼져 있으면 그 사실을 분명히 알려준다 —
 * 빈 화면을 보고 "로봇이 고장났나" 걱정하게 두지 않는다.
 */
function LiveScreen() {
  const [snapshot, setSnapshot] = useState(null);
  const [capturedAt, setCapturedAt] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/vision/latest');
      if (res.ok) {
        const data = await res.json();
        setSnapshot(data.image);
        setCapturedAt(data.capturedAt);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <main>
      <h1 className="g-section-title">방 안 모습</h1>

      {snapshot ? (
        <>
          <div className="g-live">
            <img className="g-live__img" src={snapshot} alt="로봇 카메라가 찍은 방 안 모습" />
            <div className="g-live__foot">
              {formatTime(capturedAt)} 촬영 · {relativeTime(capturedAt)}
            </div>
          </div>
          <p className="g-note-inline">
            실시간 영상이 아니라 마지막으로 찍힌 사진이에요. {REFRESH_MS / 1000}초마다 새로 확인해요.
          </p>
        </>
      ) : (
        <p className="g-empty">
          {loading
            ? '불러오는 중이에요.'
            : '아직 찍힌 사진이 없어요.\n로봇의 카메라 모니터링이 꺼져 있을 수 있어요.'}
        </p>
      )}
    </main>
  );
}

export default LiveScreen;
