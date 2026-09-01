#!/usr/bin/env bash
#
# 효돌이 키오스크 실행기 — 라즈베리파이 5 / Chromium.
#
# systemd 유닛이 아니라 셸 스크립트인 이유: Bookworm/파이5는 Wayland(labwc·wayfire)가
# 기본이라 systemd **user** 서비스가 컴포지터 환경변수(WAYLAND_DISPLAY, XDG_RUNTIME_DIR)를
# 물려받지 못하는 경우가 있고, 그러면 증상이 "Chromium이 안 뜬다"로만 보이고 로그가 없다.
# 그래픽 세션의 자식으로 띄우는 XDG 자동실행이 환경을 구조적으로 맞춰 준다.
# 대신 systemd의 Restart=always를 잃으므로, 아래 감시 루프로 되찾는다.
#
# 설치: ./install-autostart.sh
# 주소 변경: ./set-url.sh https://....trycloudflare.com

set -u

CONFIG="${HYODOL_CONFIG:-$HOME/.config/hyodol/kiosk.env}"

die() {
  # 파이에는 키보드가 없을 수 있다. 화면에도 남도록 tty와 로그 양쪽에 쓴다.
  echo "[효돌이 키오스크] $*" >&2
  command -v wall >/dev/null 2>&1 && wall "[효돌이 키오스크] $*" 2>/dev/null
  exit 1
}

[ -f "$CONFIG" ] || die "설정 파일이 없습니다: $CONFIG (kiosk.env.example을 복사하세요)"
# shellcheck source=/dev/null
. "$CONFIG"

[ -n "${KIOSK_URL:-}" ] || die "KIOSK_URL이 비어 있습니다. set-url.sh 로 터널 주소를 넣으세요."

case "$KIOSK_URL" in
  https://*) ;;
  http://localhost*|http://127.0.0.1*) ;;   # localhost도 보안 컨텍스트다
  *) die "KIOSK_URL이 https가 아닙니다 ($KIOSK_URL) — 음성 인식과 카메라가 동작하지 않습니다." ;;
esac

# Bookworm은 chromium, 이전 버전은 chromium-browser
CHROMIUM=""
for candidate in chromium-browser chromium; do
  if command -v "$candidate" >/dev/null 2>&1; then CHROMIUM="$candidate"; break; fi
done
[ -n "$CHROMIUM" ] || die "Chromium을 찾을 수 없습니다 (sudo apt install chromium-browser)"

PROFILE="$HOME/.config/hyodol/chromium"
mkdir -p "$PROFILE"

# 루프는 반드시 하나여야 한다. 자동실행이 두 곳에 걸리는 사고가 실제로 있었고(09-01),
# 그때 증상이 "화면이 3초 주기로 깜빡임"이라 원인을 찾기 어려웠다. 등록이 어떻게
# 꼬이든 여기서 막는다.
exec 9>"$HOME/.config/hyodol/kiosk.lock"
if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
  echo "[효돌이 키오스크] 이미 실행 중입니다 — 이 인스턴스는 종료합니다."
  exit 0
fi

# 플래그 하나하나가 이유가 있다:
#  --autoplay-policy: 키오스크에는 클릭할 사람이 없다. 이게 없으면 로봇이 말을 못 한다
#                     (TTS 오디오 재생이 사용자 제스처 없이는 차단된다).
#  --use-fake-ui-for-media-stream: 마이크·카메라 권한 대화상자를 자동 수락한다. 키보드가
#                     없으면 그 대화상자를 누를 방법이 없다.
#                     ⚠️ **기본 입력 장치**를 집는다 — USB 마이크가 기본이 아니면 조용히
#                     엉뚱한 장치를 잡는다. preflight.sh가 기본 장치를 출력하는 이유다.
#  --disable-pinch: 어르신이 화면을 짚다가 확대해 버리는 것을 막는다(키오스크에만 적용 —
#                     index.html의 viewport를 건드리면 보호자 폰 앱까지 확대가 막힌다).
FLAGS=(
  --kiosk
  --autoplay-policy=no-user-gesture-required
  --use-fake-ui-for-media-stream
  --user-data-dir="$PROFILE"
  --noerrdialogs
  --disable-infobars
  --disable-session-crashed-bubble
  --disable-pinch
  --overscroll-history-navigation=0
  --check-for-update-interval=31536000
  --password-store=basic
  --disable-features=Translate
)

echo "[효돌이 키오스크] $CHROMIUM → $KIOSK_URL"

# 감시 루프 — Chromium이 죽으면 3초 뒤 다시 띄운다(systemd Restart=always 대용).
while true; do
  started=$(date +%s)
  "$CHROMIUM" "${FLAGS[@]}" "$KIOSK_URL"
  code=$?
  ran=$(( $(date +%s) - started ))

  # 같은 프로필을 쓰는 Chromium이 이미 떠 있으면 새 프로세스는 URL만 넘기고 즉시
  # 코드 0으로 끝난다("Opening in existing browser session"). 그대로 재시작하면
  # 무한 루프가 되어 화면이 깜빡인다 — 재시작이 아니라 원인을 적고 멈추는 게 맞다.
  if [ "$code" -eq 0 ] && [ "$ran" -lt 5 ]; then
    echo "[효돌이 키오스크] Chromium이 ${ran}초 만에 코드 0으로 끝났습니다."
    echo "[효돌이 키오스크] 같은 프로필의 인스턴스가 이미 떠 있는 것으로 보입니다 — 재시작하지 않습니다."
    exit 0
  fi

  echo "[효돌이 키오스크] Chromium 종료 (코드 $code) — 3초 뒤 재시작"
  sleep 3
done
