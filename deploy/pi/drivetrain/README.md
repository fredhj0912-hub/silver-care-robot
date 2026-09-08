# 구동부 프로세스

보호자 앱의 화살표를 실제 바퀴 회전으로 바꾸는 자리. **지금은 골격만 있고 모터는 안 돈다.**

로봇에서 `move` 를 소비하는 것은 **이 프로세스 하나뿐이어야 한다.** 키오스크(브라우저)는
2026-08-31부터 보기만 하고 ack 하지 않는다 — 브라우저가 먼저 ack 하면 모터가 명령을
영영 못 받기 때문이다.

## 파일

| | |
|---|---|
| `drivetrain.py` | 200ms마다 `GET /api/control/state` → 신선하면 `drive()`, 아니면 `stop()` |
| `motors.py` | **하드웨어를 아는 유일한 파일.** 지금은 로그만 찍는 스텁 |
| `hyodol-drivetrain.service` | systemd **사용자** 유닛 |

## 왜 이렇게 생겼나 — 정지가 안전의 기본값이다

정지는 **정지 신호가 도착해서** 일어나지 않는다. **신선한 이동 의도가 끊겨서** 일어난다.

```
보호자가 화살표를 누르고 있는 동안
  → 앱이 250ms마다 이동 명령을 보냄
  → 서버가 "이동 중"으로 유지 (700ms 안에 갱신될 때만)
  → 이 프로세스가 그걸 읽고 바퀴를 돌림
```

손을 떼든, 폰이 꺼지든, 와이파이가 끊기든, EC2가 죽든 결과는 같다 — 조회가 실패하거나
"이동 중"이 아니게 되고, 그러면 **즉시 멈춘다.**

**조회에 실패했을 때 직전 상태를 유지하면 안 된다.** 그건 네트워크가 끊긴 채로 계속
가는 것과 같은 말이다. `POST /api/control/stop` 은 이걸 빠르게 만들 뿐이고,
안전의 근거가 아니다.

## 실제 모터를 붙일 때

예전에 로봇을 움직이던 제어 코드를 찾으면 **`motors.py` 하나만** 바꾼다.
`drivetrain.py` 는 배선과 무관하므로 손대지 않는다.

먼저 무엇이 어떻게 붙어 있는지 확인한다 (`docs/pi-runbook.md` §9):

```bash
pinctrl get                 # Bookworm (예전 raspi-gpio 대체)
gpioinfo 2>/dev/null | head -40
ls /dev/i2c-* 2>/dev/null
i2cdetect -y 1 2>/dev/null  # 모터 HAT이 I2C면 여기 주소가 뜬다
```

`motors.py` 를 채울 때 지켜야 할 것:

- **`stop()` 은 몇 번 불려도 안전해야 한다** — 폴링 실패·종료·예외 어디서든 불린다.
- **`stop()` 은 절대 예외를 던지지 않는다** — 정지 경로에서 던지면 멈출 방법이 사라진다.
- **`drive()` 는 블로킹하지 않는다** — 폴링 주기(200ms) 안에 돌아와야 한다.

## 아직 못 미더운 것

- **이 프로세스가 죽는 순간 모터가 켜져 있으면 아무도 멈추지 못한다.** 종료 신호와
  예외는 전부 받아 `stop()` 하지만 SIGKILL·전원 문제는 소프트웨어로 못 막는다.
  진짜 로봇은 하드웨어 워치독을 쓴다. **그래서 속도 상한(`MAX_SPEED = 40`)을 낮게 잡았다.**
- **폴링·만료 값은 09-03 파이 실측으로 확정했다** (`docs/pi-runbook.md` §7-2):
  왕복 206~227ms, 정지 판정 210~230ms, 손 뗀 뒤 실제 정지 0.9초 안팎.
  `POLL_MS 200`은 왕복과 거의 같아 사실상 쉬지 않고 조회한다 — 더 줄여도 소용이 없다.
- **속도 상한(`MAX_SPEED = 40`)은 아직 잠정값이다.** 모터가 스텁이라 올릴 근거가 없고,
  남은 지연의 대부분인 서버 TTL(700ms)은 **폰↔EC2 구간을 재기 전에는 못 줄인다.**

## 사용

먼저 지연 측정 — 모터를 건드리지 않는다:

```bash
cd ~/silver-care-robot/deploy/pi/drivetrain
python3 drivetrain.py --api https://<터널 주소> --key <ROBOT_API_KEY> --dry-run
```

폰에서 `/guardian/control` 의 화살표를 누르고 있으면 `drive(up, 40)` 이,
떼면 `stop()` 이 찍힌다. **찍히기까지 걸리는 시간이 §7에서 재려던 그 숫자다.**

상시 실행 (모터를 실제로 붙인 뒤):

```bash
mkdir -p ~/.config/systemd/user
cp hyodol-drivetrain.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hyodol-drivetrain
systemctl --user status hyodol-drivetrain
journalctl --user -u hyodol-drivetrain -f
```

주소와 키는 키오스크와 **같은 파일**(`~/.config/hyodol/kiosk.env`)에서 읽는다.
`set-url.sh` 로 터널 주소를 바꾸면 여기도 함께 따라간다.
