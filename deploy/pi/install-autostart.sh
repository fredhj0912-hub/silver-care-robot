#!/usr/bin/env bash
#
# 파이 부팅 시 키오스크가 자동으로 뜨게 만든다 + 화면 꺼짐을 끈다.
#
# 한 번만 실행하면 된다. 무엇을 했는지 전부 출력한다 — 조용히 성공하는 설치 스크립트는
# 나중에 무엇이 왜 안 되는지 알 수 없게 만든다.

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
KIOSK_SH="$HERE/kiosk.sh"
CONFIG="${HYODOL_CONFIG:-$HOME/.config/hyodol/kiosk.env}"

[ -f "$KIOSK_SH" ] || { echo "kiosk.sh를 찾을 수 없습니다: $KIOSK_SH" >&2; exit 1; }
chmod +x "$HERE"/*.sh

echo "── 1. 설정 파일 ──────────────────────────────"
if [ -f "$CONFIG" ]; then
  echo "이미 있습니다: $CONFIG"
else
  mkdir -p "$(dirname "$CONFIG")"
  cp "$HERE/kiosk.env.example" "$CONFIG"
  chmod 600 "$CONFIG"
  echo "만들었습니다: $CONFIG"
  echo "⚠️  아직 비어 있습니다 — ./set-url.sh https://<터널 주소> 를 실행하세요."
fi

echo
echo "── 2. 자동실행 등록 ─────────────────────────"
echo "세션 타입: ${XDG_SESSION_TYPE:-(모름)} / WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-(없음)}"

AUTOSTART_DIR="$HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"
cat > "$AUTOSTART_DIR/hyodol-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Hyodol Kiosk
Exec=$KIOSK_SH
X-GNOME-Autostart-enabled=true
EOF
echo "썼습니다: $AUTOSTART_DIR/hyodol-kiosk.desktop"

# 등록은 **XDG 한 곳에만** 한다. 2026-09-01 파이5(labwc) 실측에서 XDG 자동실행만으로
# 정상 동작하는 것을 확인했다. 예전에는 labwc가 XDG를 안 읽는 경우에 대비해 양쪽에
# 걸었는데, 그러면 kiosk.sh 루프가 두 개 돌고 두 번째 Chromium이 첫 번째 인스턴스에
# URL만 넘기고 즉시 종료한다("Opening in existing browser session"). 감시 루프는 그것을
# 죽은 것으로 보고 3초마다 다시 띄운다 — 증상은 "Chromium이 두 개"가 아니라
# **화면이 3초 주기로 하얗게 깜빡이는 것**이라 원인을 찾기 어렵다.
LABWC="$HOME/.config/labwc/autostart"
if [ -f "$LABWC" ] && grep -q 'kiosk\.sh' "$LABWC"; then
  # 예전 버전이 남긴 줄을 지운다. 패턴은 경로 기준이어야 한다 — 그 줄에 'hyodol'이라는
  # 문자열은 없다(레포 경로가 silver-care-robot이다).
  sed -i '/kiosk\.sh/d' "$LABWC"
  echo "labwc autostart에 남아 있던 중복 등록을 지웠습니다: $LABWC"
fi
echo "자동실행은 XDG 한 곳에만 등록했습니다."

echo
echo "── 3. 화면 꺼짐 끄기 ────────────────────────"
if command -v raspi-config >/dev/null 2>&1; then
  sudo raspi-config nonint do_blanking 1 && echo "raspi-config: 화면 꺼짐 비활성화"
else
  echo "⚠️  raspi-config가 없습니다 — 화면 꺼짐을 직접 꺼야 합니다."
fi

if [ "${XDG_SESSION_TYPE:-}" = "x11" ] && command -v xset >/dev/null 2>&1; then
  xset s off -dpms && echo "xset: 이번 세션의 화면 절전도 껐습니다 (X11)"
fi

echo
echo "완료했습니다. 확인:"
echo "  ./preflight.sh      # 카메라·마이크·스피커·네트워크 점검"
echo "  sudo reboot         # 자동으로 뜨는지 확인"
