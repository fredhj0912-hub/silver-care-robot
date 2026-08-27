/**
 * 원격조종 이동 — 시뮬레이터.
 *
 * 실물 구동부가 없으므로 가상 좌표를 메모리에만 유지한다. 나중에 모터 드라이버가
 * 붙으면 move()/stop() 내부 구현만 바뀌고, 인터페이스(routes/control.js)는 그대로다.
 *
 * 데드맨 스위치: move() 호출마다 타이머를 재설정한다(요청한 durationMs와 DEADMAN_MS 중
 * 더 큰 값 — 이동이 끝나기 전에 자동 정지되지 않도록). 그 안에 다음 명령이 안 오면
 * 자동으로 stop() — 원격 조종 로봇에서 이건 선택이 아니라 필수 안전장치다
 * (네트워크가 끊긴 채로 계속 움직이면 안 된다).
 */

const { nowISO } = require('../db');

const DEADMAN_MS = 500;
const MAX_DURATION_MS = 3000;
const MAX_SPEED = 100;

// 한 스텝(속도 100, 1초 이동) 당 이동 거리 — 임의의 가상 단위
const UNITS_PER_SECOND = 40;

const VECTORS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

let state = {
  x: 0,
  y: 0,
  direction: null,
  moving: false,
  updatedAt: new Date().toISOString(),
};

let deadmanTimer = null;

function move({ direction, speed = 50, durationMs = 500 }) {
  const vector = VECTORS[direction];
  if (!vector) {
    throw new Error(`알 수 없는 방향입니다: ${direction}`);
  }

  const clampedSpeed = Math.min(Math.max(Number(speed) || 0, 0), MAX_SPEED);
  const clampedDuration = Math.min(Math.max(Number(durationMs) || 0, 0), MAX_DURATION_MS);

  const distance = UNITS_PER_SECOND * (clampedSpeed / MAX_SPEED) * (clampedDuration / 1000);
  state = {
    x: state.x + vector.x * distance,
    y: state.y + vector.y * distance,
    direction,
    moving: true,
    updatedAt: nowISO(),
  };

  resetDeadman(clampedDuration);
  return getState();
}

function stop() {
  clearTimeout(deadmanTimer);
  deadmanTimer = null;
  state = { ...state, direction: null, moving: false, updatedAt: nowISO() };
  return getState();
}

function resetDeadman(durationMs) {
  clearTimeout(deadmanTimer);
  const timeout = Math.max(DEADMAN_MS, durationMs);
  deadmanTimer = setTimeout(() => {
    console.log(`[MOTION] 데드맨 스위치 작동 — 명령 없이 ${timeout}ms 경과, 자동 정지`);
    stop();
  }, timeout);
}

function getState() {
  return { ...state };
}

module.exports = { move, stop, getState, DEADMAN_MS, MAX_DURATION_MS };
