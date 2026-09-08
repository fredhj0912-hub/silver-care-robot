#!/usr/bin/env python3
"""파이에 SSH로 들어가 바로 실행하는 수동 모터 테스트. 서버/폴링과 무관하다.

    ssh pi@<파이IP>
    cd ~/silver-care-robot/deploy/pi/drivetrain
    python3 manual_drive.py f 2      # 전진 2초 후 정지
    python3 manual_drive.py s        # 즉시 정지

우노 펌웨어(hyodol-drivetrain.ino)는 500ms 동안 새 명령이 없으면 스스로 멈추므로,
지정한 시간 동안 같은 글자를 반복해서 보낸다. Ctrl+C 를 눌러도 정지 명령을 보내고 끝난다.
"""

import os
import signal
import sys
import termios
import time

PORT = "/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0"
PORT_FALLBACK = "/dev/ttyUSB0"
BAUD = termios.B115200
BOOTLOADER_WAIT_S = 2.0  # 포트를 여는 순간 DTR이 토글되며 우노가 리셋된다

COMMANDS = {"f": b"F", "b": b"B", "l": b"L", "r": b"R", "s": b"S"}
REPEAT_S = 0.15  # 워치독(500ms)보다 넉넉히 짧게


def open_port():
    path = PORT if os.path.exists(PORT) else PORT_FALLBACK
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY)
    attrs = termios.tcgetattr(fd)
    iflag, oflag, cflag, lflag, _i, _o, cc = attrs
    cflag = (cflag | termios.CS8 | termios.CREAD | termios.CLOCAL) & ~termios.PARENB
    cflag &= ~termios.CSTOPB & ~termios.HUPCL & ~termios.CRTSCTS
    termios.tcsetattr(fd, termios.TCSANOW, [0, 0, cflag, 0, BAUD, BAUD, cc])
    print(f"[manual_drive] {path} 열림 — 부트로더 {BOOTLOADER_WAIT_S}초 대기", file=sys.stderr)
    time.sleep(BOOTLOADER_WAIT_S)
    return fd


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(f"사용법: python3 {sys.argv[0]} <f|b|l|r|s> [초]", file=sys.stderr)
        return 1

    payload = COMMANDS[sys.argv[1]]
    duration = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0

    fd = open_port()

    def stop_and_exit(*_a):
        os.write(fd, b"S")
        os.close(fd)
        sys.exit(0)

    signal.signal(signal.SIGINT, stop_and_exit)
    signal.signal(signal.SIGTERM, stop_and_exit)

    if payload == b"S":
        os.write(fd, b"S")
        print("[manual_drive] S 전송", file=sys.stderr)
    else:
        end = time.monotonic() + duration
        while time.monotonic() < end:
            os.write(fd, payload)
            time.sleep(REPEAT_S)
        os.write(fd, b"S")
        print(f"[manual_drive] {payload.decode()} {duration}초 후 정지", file=sys.stderr)

    os.close(fd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
