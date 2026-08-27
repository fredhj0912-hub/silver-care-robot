import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

const STATE_POLL_MS = 1000;

// 화면에 그릴 가상 평면도 — motion.js의 좌표 단위를 픽셀로 대충 맞춘 스케일일 뿐,
// 실제 방 크기와는 무관하다 (실물 구동부가 없는 시뮬레이터).
const PLAN_SIZE = 220;
const PLAN_SCALE = 0.8;

/**
 * 원격조종 — D-패드 + 가상 평면도.
 *
 * 실물 구동부가 없어 backend/src/services/motion.js가 가상 좌표만 시뮬레이션한다.
 * 나중에 모터 드라이버가 붙어도 이 화면은 그대로 두고 백엔드 구현만 바뀐다.
 */
function ControlScreen({ isEmergency }) {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [error, setError] = useState(null);
  const [moving, setMoving] = useState(false);

  const refreshState = useCallback(async () => {
    try {
      const res = await apiFetch('/api/control/state');
      if (res.ok) {
        const data = await res.json();
        setPosition({ x: data.x, y: data.y });
      }
    } catch {
      // 조용히 넘어간다 — 다음 폴링에서 다시 시도
    }
  }, []);

  useEffect(() => {
    refreshState();
    const timer = setInterval(refreshState, STATE_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshState]);

  const move = async (direction) => {
    if (moving) return; // 이전 요청이 끝나기 전엔 연타를 무시 — 응답 순서가 꼬이면 위치 표시가 튄다
    setMoving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/control/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction, speed: 70, durationMs: 400 }),
      });
      if (res.ok) {
        const data = await res.json();
        setPosition({ x: data.state.x, y: data.state.y });
      } else if (res.status === 423) {
        setError('응급 상황 중에는 원격 조종을 사용할 수 없어요.');
      } else {
        setError('이동 명령을 보내지 못했어요.');
      }
    } catch {
      setError('로봇과 연결되지 않아요. 같은 Wi-Fi에 있는지 확인해 주세요.');
    } finally {
      setMoving(false);
    }
  };

  // 평면도 밖으로 나가지 않도록 dot 반지름(7px)만큼 여유를 두고 클램핑한다.
  const clamp = (v) => Math.min(Math.max(v, 7), PLAN_SIZE - 7);
  const dotX = clamp(PLAN_SIZE / 2 + position.x * PLAN_SCALE);
  const dotY = clamp(PLAN_SIZE / 2 + position.y * PLAN_SCALE);

  return (
    <main>
      <h1 className="g-section-title">원격 조종</h1>
      <p className="g-note-inline" style={{ margin: '0 20px 16px' }}>
        화살표를 누르면 효돌이가 그 방향으로 조금 움직여요. 지금은 시뮬레이션이에요.
      </p>

      <div
        style={{
          width: PLAN_SIZE, height: PLAN_SIZE, margin: '0 auto 20px',
          border: '1px solid var(--line)', borderRadius: 12,
          position: 'relative', background: 'var(--surface, #f8fafc)',
        }}
      >
        <div
          style={{
            position: 'absolute', width: 14, height: 14, borderRadius: '50%',
            background: 'var(--indigo)', left: dotX - 7, top: dotY - 7,
            transition: 'left 0.2s, top 0.2s',
          }}
          aria-hidden="true"
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 64px)',
          gridTemplateRows: 'repeat(3, 64px)',
          gap: 8,
          justifyContent: 'center',
          opacity: isEmergency ? 0.5 : 1,
        }}
      >
        <div />
        <button className="g-btn" style={{ gridColumn: 2 }} disabled={isEmergency || moving} onClick={() => move('up')}>⬆️</button>
        <div />
        <button className="g-btn" style={{ gridRow: 2 }} disabled={isEmergency || moving} onClick={() => move('left')}>⬅️</button>
        <div />
        <button className="g-btn" style={{ gridRow: 2, gridColumn: 3 }} disabled={isEmergency || moving} onClick={() => move('right')}>➡️</button>
        <div />
        <button className="g-btn" style={{ gridColumn: 2 }} disabled={isEmergency || moving} onClick={() => move('down')}>⬇️</button>
        <div />
      </div>

      {isEmergency && (
        <p className="g-note-inline" style={{ marginTop: 16 }}>
          응급 상황 중에는 원격 조종이 잠겨요. 어르신 상태 확인이 우선이에요.
        </p>
      )}
      {error && (
        <p className="g-note-inline" style={{ marginTop: 16, color: 'var(--alarm)' }}>{error}</p>
      )}
    </main>
  );
}

export default ControlScreen;
