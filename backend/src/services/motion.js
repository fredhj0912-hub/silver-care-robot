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
 *
 * 보호자가 화살표를 **누르고 있는 동안** 앱이 move()를 반복해 부르고, 손을 떼면 반복이
 * 끊겨 만료된다. 그래서 **정지는 신호가 도착해서가 아니라 신호가 끊겨서** 일어난다 —
 * 폰이 꺼져도, 와이파이가 끊겨도 같은 결과다. POST /api/control/stop 은 그걸 빠르게
 * 만들 뿐이고, 안전의 근거가 아니다.
 */

const { nowISO } = require('../db');

const DEADMAN_MS = 500;
const MAX_DURATION_MS = 3000;
const MAX_SPEED = 100;

const DEFAULT_SPEED = 50;
const DEFAULT_DURATION_MS = 500;

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
  speed: 0,
  moving: false,
  updatedAt: new Date().toISOString(),
};

// 이 시각이 지나면 이동 의도는 만료된다. 타이머와 **별도로** 두는 이유는 아래 getState() 참고.
let expiresAt = 0;

let deadmanTimer = null;

const clampSpeed = (speed) => Math.min(Math.max(Number(speed) || 0, 0), MAX_SPEED);
const clampDuration = (durationMs) => Math.min(Math.max(Number(durationMs) || 0, 0), MAX_DURATION_MS);

function move({ direction, speed = DEFAULT_SPEED, durationMs = DEFAULT_DURATION_MS }) {
  const vector = VECTORS[direction];
  if (!vector) {
    throw new Error(`알 수 없는 방향입니다: ${direction}`);
  }

  const clampedSpeed = clampSpeed(speed);
  const clampedDuration = clampDuration(durationMs);

  const distance = UNITS_PER_SECOND * (clampedSpeed / MAX_SPEED) * (clampedDuration / 1000);
  state = {
    x: state.x + vector.x * distance,
    y: state.y + vector.y * distance,
    direction,
    // 구동부가 읽는 값이라 **클램핑된 뒤의** 속도를 싣는다 (요청 원본이 아니다)
    speed: clampedSpeed,
    moving: true,
    updatedAt: nowISO(),
  };

  resetDeadman(clampedDuration);
  return getState();
}

function stop() {
  clearTimeout(deadmanTimer);
  deadmanTimer = null;
  expiresAt = 0;
  state = { ...state, direction: null, speed: 0, moving: false, updatedAt: nowISO() };
  return getState();
}

function resetDeadman(durationMs) {
  clearTimeout(deadmanTimer);
  const timeout = Math.max(DEADMAN_MS, durationMs);
  expiresAt = Date.now() + timeout;
  deadmanTimer = setTimeout(() => {
    console.log(`[MOTION] 데드맨 스위치 작동 — 명령 없이 ${timeout}ms 경과, 자동 정지`);
    stop();
  }, timeout);
}

/**
 * 실물 구동부는 이 값을 믿고 바퀴를 돌린다. 그래서 **타이머가 아니라 시계로** 판정한다 —
 * 이벤트 루프가 밀리거나 프로세스가 멈췄다 깨어나면 타이머는 늦게 도는데, 그 사이
 * 낡은 상태가 "이동 중"으로 읽히면 로봇이 명령 없이 계속 간다.
 *
 * `expiresAt`(절대 시각)은 밖으로 내보내지 않는다. 파이와 EC2의 시계가 어긋나면
 * 소비자가 그 값으로 잘못 판정한다 — 구동부는 자기 시계로 "마지막 성공 조회 이후
 * 얼마나 지났는가"만 보게 한다.
 */
function getState() {
  if (state.moving && Date.now() >= expiresAt) {
    return { ...state, direction: null, speed: 0, moving: false };
  }
  return { ...state };
}

module.exports = {
  move, stop, getState,
  // 큐에 넣는 값도 같은 한계를 거치게 하려고 내보낸다 — 한계가 두 곳에 갈리면 안 된다
  clampSpeed, clampDuration,
  DEADMAN_MS, MAX_DURATION_MS, MAX_SPEED, DEFAULT_SPEED, DEFAULT_DURATION_MS,
};
