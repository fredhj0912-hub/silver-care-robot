import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch, assetUrl } from '../../lib/api';
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
      // 저장된 사진이 먼저다. /api/vision/latest 는 메모리에만 있어서 백엔드가
      // 재시작하면 사라지고, Gemini 분석 경로(할당량을 쓰는 쪽)를 켰을 때만 채워진다.
      const res = await apiFetch('/api/snapshots?limit=1');
      if (res.ok) {
        const { snapshots } = await res.json();
        if (snapshots.length) {
          setSnapshot(assetUrl(snapshots[0].url));
          setCapturedAt(snapshots[0].capturedAt);
          return;
        }
      }

      // 저장된 것이 없으면 분석 경로가 메모리에 들고 있는 마지막 프레임을 본다.
      const fallback = await apiFetch('/api/vision/latest');
      if (fallback.ok) {
        const data = await fallback.json();
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
            : '아직 찍힌 사진이 없어요.\n로봇의 카메라가 꺼져 있을 수 있어요.'}
        </p>
      )}
    </main>
  );
}

export default LiveScreen;
