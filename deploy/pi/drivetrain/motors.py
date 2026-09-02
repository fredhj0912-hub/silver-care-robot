"""모터 제어 — 지금은 로그만 찍는 스텁.

**이 골격에서 하드웨어를 아는 파일은 이것 하나다.** 예전에 로봇을 움직이던 제어 코드를
찾으면 아래 두 함수의 속만 바꾸면 되고, drivetrain.py 는 손대지 않는다.

배선을 아직 모르므로(TODO.md B트랙 / docs/pi-runbook.md §9) 실제 GPIO 호출은 없다.
`pinctrl get` / `i2cdetect -y 1` 로 무엇이 붙어 있는지 확인한 뒤에 채운다.

바꿀 때 지켜야 할 것:
  - stop() 은 **몇 번 불려도 안전해야 한다.** drivetrain.py 가 폴링 실패·종료·예외
    어디서든 부른다.
  - stop() 은 **절대 예외를 던지지 않는다.** 정지 경로에서 던지면 멈출 방법이 사라진다.
  - drive() 는 오래 붙잡고 있지 않는다(블로킹 금지). 폴링 주기 안에 돌아와야 한다.
"""

import sys

DIRECTIONS = ("up", "down", "left", "right")


def drive(direction, speed):
    """direction 방향으로 speed(0~100)만큼 돈다. 다음 호출까지 그 상태를 유지한다."""
    print(f"drive({direction}, {speed})", file=sys.stderr, flush=True)


def stop():
    """즉시 정지. 여러 번 불려도, 이미 멈춰 있어도 안전해야 한다."""
    print("stop()", file=sys.stderr, flush=True)
