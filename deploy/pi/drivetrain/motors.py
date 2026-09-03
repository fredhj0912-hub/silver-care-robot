"""모터 제어 — 지금은 로그만 찍는 스텁.

**이 골격에서 하드웨어를 아는 파일은 이것 하나다.** 예전에 로봇을 움직이던 제어 코드를
찾으면 아래 두 함수의 속만 바꾸면 되고, drivetrain.py 는 손대지 않는다.

**2026-09-03 파이 실사로 배선 경로는 밝혀졌다 — 남은 것은 프로토콜뿐이다.**

  · GPIO 40핀이 **전부 미사용**(pinctrl get 전 핀 none) — L298N 직결이 아니다
  · `/dev/i2c-1`이 **없다**(4·6·10·11·13·14는 DSI/HDMI 등 내부 버스) — 모터 HAT이 아니다
  · **USB 시리얼 하나가 유일한 길**: `1a86:7523` CH340 →
    `/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0` → `/dev/ttyUSB0`
    (`dialout` 그룹이라 sudo 없이 열린다)

즉 파이가 모터를 직접 돌리지 않는다. **시리얼 건너편의 마이크로컨트롤러가 돌린다.**
그래서 이 파일은 GPIO 코드가 아니라 **시리얼에 한 줄 쓰는 코드**가 된다.

막힌 지점: **어떤 문자열을 보내야 하는지 모른다.** 115200·9600 둘 다에서 보드가
아무것도 뱉지 않는다(명령을 받기만 하는 펌웨어다). 모르는 프로토콜에 임의의 바이트를
보내면 로봇이 예상 못 한 방향으로 움직이므로 **추측해서 채우지 않는다.**

풀 방법 두 가지:
  1. 그 보드에 올린 아두이노 스케치(.ino)를 찾는다 — 프로토콜이 거기 있다
  2. 펌웨어를 덤프해 문자열을 본다(읽기 전용):
     avrdude -c arduino -p m328p -P /dev/ttyUSB0 -b 115200 -U flash:r:/tmp/fw.bin:r
     strings -n 3 /tmp/fw.bin

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
