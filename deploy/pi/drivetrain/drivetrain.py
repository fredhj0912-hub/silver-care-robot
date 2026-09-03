#!/usr/bin/env python3
"""구동부 프로세스 — 서버의 이동 의도를 읽어 바퀴를 돌린다.

**로봇에서 move 를 소비하는 것은 이 프로세스 하나뿐이다.** 키오스크(브라우저)는
2026-08-31부터 보기만 하고 ack 하지 않는다 — 브라우저가 먼저 ack 해 버리면 모터가
명령을 영영 못 받기 때문이다.

## 안전 — 이 파일에서 가장 중요한 부분

정지는 **정지 신호가 도착해서** 일어나지 않는다. **신선한 이동 의도가 끊겨서** 일어난다.

    보호자가 화살표를 누르고 있는 동안 → 앱이 250ms마다 이동 명령을 보냄
    → 서버가 "이동 중"으로 유지 → 여기서 그걸 읽고 바퀴를 돌림

손을 떼든, 폰이 꺼지든, 와이파이가 끊기든, EC2가 죽든 결과는 같다 — 조회가 실패하거나
"이동 중"이 아니게 되고, 그러면 **즉시 멈춘다.** 조회에 실패했을 때 직전 상태를 유지하면
안 된다. 그건 네트워크가 끊긴 채로 계속 가는 것과 같은 말이다.

## 한계 (정직하게)

이 프로세스가 죽는 순간 모터가 켜져 있으면 아무도 멈추지 못한다. 종료 신호·예외는
아래에서 다 받아 stop() 하지만, SIGKILL 이나 전원 문제는 소프트웨어로 못 막는다.
진짜 로봇은 하드웨어 워치독을 쓴다. 지금은 이 한계를 안고 간다 —
그래서 속도 상한을 낮게 잡는다.

## 사용

    python3 drivetrain.py --api https://<터널 주소> --key <ROBOT_API_KEY>
    python3 drivetrain.py --api ... --key ... --dry-run   # 모터 없이 지연만 측정

의존성 없이 표준 라이브러리만 쓴다 (파이에 pip install 을 요구하지 않는다).
"""

import argparse
import json
import signal
import sys
import time
import urllib.error
import urllib.request

import motors

# 서버가 "이동 중"이라고 답하는 한 계속 돈다. 이 주기가 곧 정지 지연의 일부다.
POLL_MS = 200

# **조회에 실패했을 때만** 쓰는 창이다. 서버가 "안 움직인다"고 명확히 답하면 기다리지
# 않고 즉시 멈춘다 — 답을 받았는데 더 기다릴 이유가 없다.
#
# 2026-09-03 실측 전에는 둘을 똑같이 취급해서, 서버 만료(500ms)에 이 700ms가 그대로
# 얹혀 손을 뗀 뒤 **1.2~1.4초**를 더 갔다. 지금은 서버 만료 + 폴링 1회(0.7초 안팎)다.
#
# 값의 근거: 왕복이 206~227ms(09-03 실측, 편차 21ms)라 700ms면 연속 3회 실패까지
# 버틴다. 우리 시계로만 재므로 파이와 EC2의 시계가 어긋나도 상관없다.
STALE_MS = 700

HTTP_TIMEOUT_S = 1.0

# 정지 지연(TTL + 폴링 + 왕복)이 1초 안팎이라 빠르게 몰면 안 된다.
# docs/pi-runbook.md §7에서 실제 왕복을 재고 나서 올린다.
MAX_SPEED = 40

_running = True


def _log(msg):
    # 시각을 함께 찍는다 — 이 로그로 재려는 것이 "언제"가 아니라 "얼마나 걸렸나"이고,
    # 시각이 없으면 뗀 순간과 선 순간 사이를 눈대중으로 재게 된다.
    print(f"[DRIVETRAIN {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def fetch_state(api, key):
    """현재 이동 의도를 읽는다. 실패하면 None — 호출부는 그걸 '멈춰라'로 읽는다."""
    req = urllib.request.Request(f"{api.rstrip('/')}/api/control/state")
    if key:
        req.add_header("x-api-key", key)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as res:
            return json.loads(res.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as err:
        _log(f"조회 실패 ({err}) — 정지")
        return None


def run(api, key, dry_run):
    # **로그는 실주행에서도 찍는다.** 예전에는 --dry-run 에서만 찍었는데, 정작 실물이
    # 도는 동안 화면에 아무것도 안 나와서 "로봇이 왜 섰나"를 밖에서 볼 수가 없었다
    # (2026-09-03에 실제로 그 상황을 만났다). 표시만 구분한다.
    tag = "[dry-run] " if dry_run else ""
    last_fresh_ms = 0.0
    driving = False
    last_direction = None

    while _running:
        started = time.monotonic()
        state = fetch_state(api, key)
        now_ms = time.monotonic() * 1000

        moving = bool(state and state.get("moving"))
        direction = state.get("direction") if state else None

        if moving and direction in motors.DIRECTIONS:
            last_fresh_ms = now_ms
            speed = min(MAX_SPEED, int(state.get("speed") or MAX_SPEED))
            if not driving or direction != last_direction:
                _log(f"{tag}drive({direction}, {speed}) — 왕복 {(time.monotonic() - started) * 1000:.0f}ms")
            if not dry_run:
                motors.drive(direction, speed)
            driving, last_direction = True, direction

        elif driving:
            # 이동 의도가 끊겼다. **왜 끊겼는지에 따라 기다리는 시간이 다르다.**
            #
            #  · 조회는 됐는데 "안 움직임"이다 → 서버가 명확히 답했다. 즉시 멈춘다.
            #  · 조회 자체가 실패했다        → 못 믿는 상태다. STALE_MS 만큼만 버틴다
            #    (한 번의 네트워크 딸꾹질로 바퀴가 끊겼다 이어지지 않도록).
            #
            # 둘을 같이 취급하면 서버 만료 위에 이 창이 통째로 얹혀 정지가 두 배로 늦는다.
            answered = state is not None
            waited = now_ms - last_fresh_ms
            if answered or waited >= STALE_MS:
                why = "서버가 정지" if answered else f"조회 실패 {waited:.0f}ms"
                _log(f"{tag}stop() — {why} (마지막 신선한 의도로부터 {waited:.0f}ms)")
                if not dry_run:
                    motors.stop()
                driving, last_direction = False, None

        elapsed = time.monotonic() - started
        time.sleep(max(0.0, POLL_MS / 1000 - elapsed))


def main():
    parser = argparse.ArgumentParser(description="효돌이 구동부 — 이동 명령 소비자")
    parser.add_argument("--api", required=True, help="백엔드 주소 (예: https://xxx.trycloudflare.com)")
    parser.add_argument("--key", default="", help="ROBOT_API_KEY (설정돼 있으면 필수)")
    parser.add_argument("--dry-run", action="store_true", help="모터를 건드리지 않고 로그만 찍는다")
    args = parser.parse_args()

    def shutdown(signum, _frame):
        global _running
        _running = False
        _log(f"신호 {signum} — 정지 후 종료")

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    mode = " / dry-run" if args.dry_run else ""
    _log(f"시작 — {args.api} / 폴링 {POLL_MS}ms / 만료 {STALE_MS}ms{mode}")
    try:
        run(args.api, args.key, args.dry_run)
    finally:
        # 어떤 경로로 빠져나오든 마지막에 반드시 멈춘다 — 예외로 죽는 길도 포함이다.
        motors.stop()
        _log("정지하고 종료했습니다")


if __name__ == "__main__":
    sys.exit(main())
