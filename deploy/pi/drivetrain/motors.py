"""모터 제어 — 아두이노 우노에 시리얼로 한 글자를 보낸다.

**이 골격에서 하드웨어를 아는 파일은 이것 하나다.** drivetrain.py 는 배선과 무관하므로
여기만 바꾸면 된다.

## 배선 (2026-09-03 파이 실사로 확인)

    라즈베리파이 5 ──USB──> 아두이노 우노(CH340) ──> 모터 드라이버 ──> 바퀴 4개

파이의 GPIO 40핀은 **전부 미사용**이고 `/dev/i2c-1` 도 없다 — 직결도 모터 HAT도 아니다.
유일한 길은 `1a86:7523` CH340 → `/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0`
(→ `/dev/ttyUSB0`). `dialout` 그룹이라 sudo 없이 열린다.

## 프로토콜 (우노 펌웨어를 덤프해서 알아냈다)

스케치 원본(.ino)을 못 찾아, 우노의 플래시를 읽고(읽기 전용) 기계어의 비교 명령에서
문자를 뽑아냈다 — 한 글자 비교라 `strings` 로는 안 잡혔다.

    avrdude -c arduino -p m328p -P /dev/ttyUSB0 -b 115200 -U flash:r:/tmp/fw.bin:r
    avr-objdump -D -m avr5 -b binary /tmp/fw.bin | grep cpi
      → 0x74e 부근에서 같은 레지스터를 연속 비교: 0x4C 'L' 0x42 'B' 0x46 'F' 0x52 'R' 0x53 'S'

**115200 보드율에서 'F'를 보내 바퀴 4개가 도는 것을 실물로 확인했다.**

⚠️ **이 펌웨어에는 속도 개념이 없다.** 명령이 한 글자뿐이라 speed 인자는 버려진다.
   drivetrain.py 의 MAX_SPEED(40)는 이 하드웨어에서 **아무것도 제한하지 않는다** —
   "속도를 낮게 잡아 뒀으니 괜찮다"는 근거는 여기서는 성립하지 않는다.
   속도를 정말 낮추려면 우노 펌웨어를 바꿔야 한다.

⚠️ **펌웨어가 스스로 멈추는지는 모른다.** 'S' 를 받아야만 서는 것으로 보인다. 그래서
   이 프로세스가 SIGKILL 로 죽으면 아무도 멈추지 못한다(README "아직 못 미더운 것").
   drivetrain.py 는 종료 신호·예외·조회 실패 어디서든 stop() 을 부르지만, 그건
   프로세스가 살아 있을 때의 이야기다.

## 지켜야 할 것 (drivetrain.py 가 이 계약을 믿는다)

  - stop() 은 **몇 번 불려도 안전해야 한다.** 폴링 실패·종료·예외 어디서든 불린다.
  - stop() 은 **절대 예외를 던지지 않는다.** 정지 경로에서 던지면 멈출 방법이 사라진다.
  - drive() 는 오래 붙잡고 있지 않는다(블로킹 금지). 폴링 주기(200ms) 안에 돌아와야 한다.
"""

import os
import sys
import termios
import time

DIRECTIONS = ("up", "down", "left", "right")

# 우노 펌웨어가 아는 글자. 이 표 밖의 것은 보내지 않는다.
COMMANDS = {"up": b"F", "down": b"B", "left": b"L", "right": b"R"}
STOP = b"S"

PORT = "/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0"
# by-id 가 없는 환경(다른 어댑터로 교체 등)을 위한 대비책. by-id 를 먼저 쓰는 이유는
# USB 장치가 여러 개일 때 ttyUSB 번호가 부팅마다 바뀔 수 있기 때문이다.
PORT_FALLBACK = "/dev/ttyUSB0"

# 포트를 여는 순간 DTR이 토글되며 **우노가 리셋된다.** 부트로더가 끝나기 전에 보낸
# 글자는 그대로 사라진다 — 실물에서 첫 명령이 먹히지 않던 것이 이것이었다.
BOOTLOADER_WAIT_S = 2.0

_fd = None


def _log(msg):
    print(f"[MOTORS] {msg}", file=sys.stderr, flush=True)


def _open():
    """포트를 한 번만 연다. 명령마다 열고 닫으면 그때마다 우노가 리셋된다."""
    global _fd
    if _fd is not None:
        return _fd

    path = PORT if os.path.exists(PORT) else PORT_FALLBACK
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        attrs = termios.tcgetattr(fd)
        iflag, oflag, cflag, lflag, _ispeed, _ospeed, cc = attrs
        # raw 8N1. CLOCAL은 모뎀 신호를 무시하라는 뜻이고, HUPCL을 꺼야 닫을 때
        # 우노가 또 리셋되지 않는다.
        cflag = (cflag | termios.CS8 | termios.CREAD | termios.CLOCAL) & ~termios.PARENB
        cflag &= ~termios.CSTOPB & ~termios.HUPCL & ~termios.CRTSCTS
        iflag = 0
        oflag = 0
        lflag = 0
        termios.tcsetattr(
            fd, termios.TCSANOW,
            [iflag, oflag, cflag, lflag, termios.B115200, termios.B115200, cc],
        )
    except Exception:
        os.close(fd)
        raise

    _log(f"{path} 115200 — 부트로더를 {BOOTLOADER_WAIT_S}초 기다린다")
    time.sleep(BOOTLOADER_WAIT_S)
    _fd = fd
    return _fd


def _write(payload):
    """한 글자를 보낸다. 실패하면 포트를 놓아 다음 호출이 다시 열게 한다."""
    global _fd
    try:
        os.write(_open(), payload)
        return True
    except Exception as err:
        _log(f"쓰기 실패 ({err})")
        if _fd is not None:
            try:
                os.close(_fd)
            except Exception:
                pass
            _fd = None
        return False


def drive(direction, speed):
    """direction 방향으로 돈다. speed는 이 펌웨어에 전달할 방법이 없다(머리말 참고).

    폴링마다 같은 글자를 다시 보낸다 — 한 글자가 유실돼도 다음 주기에 복구되고,
    펌웨어에 자체 시한이 있더라도 그것을 갱신해 준다. 초당 5바이트라 부담이 없다.
    """
    payload = COMMANDS.get(direction)
    if payload is None:
        # 모르는 방향을 아두이노에 보내느니 멈춘다. drivetrain.py가 거르지만,
        # 정지가 기본값이라는 원칙은 이 층에서도 지킨다.
        _log(f"모르는 방향: {direction} — 정지한다")
        stop()
        return
    _write(payload)


def stop():
    """즉시 정지. 여러 번 불려도, 이미 멈춰 있어도, 포트가 사라졌어도 안전해야 한다."""
    try:
        _write(STOP)
    except Exception as err:
        # _write가 이미 삼키지만, 정지 경로에서는 어떤 예외도 밖으로 내보내지 않는다.
        _log(f"정지 중 예외 무시 ({err})")
