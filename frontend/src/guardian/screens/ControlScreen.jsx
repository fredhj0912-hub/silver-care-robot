import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../lib/api';

const STATE_POLL_MS = 1000;

// 누르고 있는 동안 이 주기로 같은 명령을 다시 보낸다(심박). 서버는 마지막 명령이
// MOVE_TTL_MS 안에 갱신될 때만 "이동 중"으로 본다 — 심박 하나를 잃어도 안 끊기도록
// 주기의 두 배 넘게 잡았다.
const HEARTBEAT_MS = 250;
const MOVE_TTL_MS = 700;

// 2026-09-03 파이 실측: 손을 뗀 뒤 정지까지 **0.9초 안팎**이다
// (서버 TTL 700ms + 구동부 폴링 1회, 파이↔EC2 왕복은 206~227ms).
// 남은 지연의 대부분이 위 MOVE_TTL_MS라 그것을 줄이는 것이 다음 지렛대인데,
// **폰↔EC2 구간은 아직 안 쟀다** — 심박이 그 구간을 지나므로 그것을 재기 전에는
// 못 줄인다. 그래서 속도는 그대로 둔다. 모터도 아직 스텁이라 올릴 근거가 없다.
const SPEED = 40;

// 화면에 그릴 가상 평면도 — motion.js의 좌표 단위를 픽셀로 대충 맞춘 스케일일 뿐,
// 실제 방 크기와는 무관하다 (실물 구동부가 없는 시뮬레이터).
const PLAN_SIZE = 220;
const PLAN_SCALE = 0.8;

/**
 * 원격조종 — 꾹 누르는 D-패드 + 가상 평면도.
 *
 * 화살표를 누르고 있는 동안 250ms마다 이동 명령을 보내고, 떼면 멈춘다.
 * **정지는 정지 신호가 도착해서가 아니라 심박이 끊겨서 일어난다** — 폰이 꺼지거나
 * 와이파이가 끊겨도 로봇은 선다. 그래서 아래 releaseAll()이 새는 경로(탭 전환, 언마운트,
 * 포인터가 버튼 밖으로 나감)를 하나도 빠뜨리면 안 된다. 하나라도 새면 손을 뗐는데
 * 로봇이 계속 간다.
 *
 * 실물 구동부가 없어 backend/src/services/motion.js가 가상 좌표만 시뮬레이션한다.
 */
function ControlScreen({ isEmergency }) {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [error, setError] = useState(null);
  const [held, setHeld] = useState(null);

  const heartbeatRef = useRef(null);

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

  const sendMove = useCallback(async (direction) => {
    try {
      const res = await apiFetch('/api/control/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction, speed: SPEED, durationMs: MOVE_TTL_MS }),
      });
      if (res.ok) {
        setError(null);
      } else if (res.status === 423) {
        setError('응급 상황 중에는 원격 조종을 사용할 수 없어요.');
      } else {
        setError('이동 명령을 보내지 못했어요.');
      }
    } catch {
      setError('로봇과 연결되지 않아요. 같은 Wi-Fi에 있는지 확인해 주세요.');
    }
  }, []);

  /**
   * 손을 뗐다. 심박을 끊고 정지를 보낸다.
   * 심박이 끊긴 것만으로도 로봇은 서지만, 명시적 정지가 그걸 빠르게 만든다.
   */
  const releaseAll = useCallback(() => {
    // 여러 경로(버튼 pointerup, window pointerup, 탭 전환, 언마운트)에서 불리므로
    // 누르고 있지 않을 때는 아무것도 하지 않는다 — 아니면 정지 요청이 중복으로 나간다.
    if (!heartbeatRef.current) return;
    clearInterval(heartbeatRef.current);
    heartbeatRef.current = null;
    setHeld(null);
    apiFetch('/api/control/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => { /* 실패해도 심박이 끊겼으니 로봇은 선다 */ });
  }, []);

  const press = useCallback((direction) => {
    if (isEmergency) return;
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    setHeld(direction);
    sendMove(direction);
    heartbeatRef.current = setInterval(() => sendMove(direction), HEARTBEAT_MS);
  }, [isEmergency, sendMove]);

  // 손을 떼는 것을 놓치는 경로를 전부 막는다. 폰을 잠그거나 앱을 전환하면
  // pointerup 이 오지 않는다 — 그대로 두면 로봇이 계속 간다.
  useEffect(() => {
    const onHidden = () => { if (document.visibilityState === 'hidden') releaseAll(); };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('blur', releaseAll);
    window.addEventListener('pointerup', releaseAll);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('blur', releaseAll);
      window.removeEventListener('pointerup', releaseAll);
      releaseAll(); // 화면을 벗어날 때도 반드시 멈춘다
    };
  }, [releaseAll]);

  // 응급이 뜨면 누르고 있던 것도 즉시 놓는다 (서버도 423으로 막지만, 심박을 계속
  // 보내면서 오류 문구만 띄우는 것은 의미가 없다).
  useEffect(() => {
    if (isEmergency) releaseAll();
  }, [isEmergency, releaseAll]);

  // 평면도 밖으로 나가지 않도록 dot 반지름(7px)만큼 여유를 두고 클램핑한다.
  const clamp = (v) => Math.min(Math.max(v, 7), PLAN_SIZE - 7);
  const dotX = clamp(PLAN_SIZE / 2 + position.x * PLAN_SCALE);
  const dotY = clamp(PLAN_SIZE / 2 + position.y * PLAN_SCALE);

  const padButton = (direction, label, style) => (
    <button
      className="g-btn"
      style={{
        ...style,
        touchAction: 'none',
        // 꾹 누르는 것이 이 화면의 조작 방식인데, 폰은 그것을 **글자 선택**으로 읽는다.
        // 09-03 실측에서 화살표를 누르고 있으면 복사·공유 메뉴가 떠서 조종이 끊겼다.
        // 이모지도 텍스트라 선택 대상이 된다 — 아래 셋이 각각 다른 브라우저를 막는다.
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
      }}
      type="button"
      aria-label={label}
      aria-pressed={held === direction}
      disabled={isEmergency}
      // 길게 누르면 뜨는 컨텍스트 메뉴를 막는다. 메뉴가 뜨는 순간 pointerup을 놓쳐
      // **손을 뗐는데 심박이 계속 나가는** 상태가 될 수 있어, 보기 문제가 아니라 안전 문제다.
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => { e.preventDefault(); press(direction); }}
      onPointerUp={releaseAll}
      onPointerLeave={releaseAll}
      onPointerCancel={releaseAll}
    >
      {label}
    </button>
  );

  return (
    <main>
      <h1 className="g-section-title">원격 조종</h1>
      <p className="g-note-inline" style={{ margin: '0 20px 16px' }}>
        화살표를 <strong>누르고 있는 동안</strong> 효돌이가 그 방향으로 움직여요.
        손을 떼면 멈춰요. 지금은 시뮬레이션이에요.
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
        {padButton('up', '⬆️', { gridColumn: 2 })}
        <div />
        {padButton('left', '⬅️', { gridRow: 2 })}
        <div />
        {padButton('right', '➡️', { gridRow: 2, gridColumn: 3 })}
        <div />
        {padButton('down', '⬇️', { gridColumn: 2 })}
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
