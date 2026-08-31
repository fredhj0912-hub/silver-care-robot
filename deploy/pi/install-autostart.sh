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

# labwc는 이미지에 따라 XDG 자동실행을 읽지 않는 경우가 있다. 그때만 보조 경로를 건다.
if pgrep -x labwc >/dev/null 2>&1; then
  LABWC="$HOME/.config/labwc/autostart"
  mkdir -p "$(dirname "$LABWC")"
  if [ -f "$LABWC" ] && grep -q 'hyodol' "$LABWC"; then
    echo "labwc autostart에 이미 등록돼 있습니다: $LABWC"
  else
    echo "$KIOSK_SH &" >> "$LABWC"
    echo "labwc를 감지해 함께 등록했습니다: $LABWC"
    echo "⚠️  둘 다 걸렸으므로 Chromium이 두 번 뜨면 한쪽을 지우세요."
  fi
else
  echo "labwc가 아닙니다 — XDG 자동실행만 등록했습니다."
fi

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
