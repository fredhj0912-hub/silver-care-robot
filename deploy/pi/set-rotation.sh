#!/usr/bin/env bash
#
# 화면 방향을 정하고 부팅 때마다 유지되게 저장한다.
#
#   ./set-rotation.sh 90        # 지금 돌려 보고, 맞으면 저장
#   ./set-rotation.sh normal    # 원래대로
#   ./set-rotation.sh           # 지금 상태만 보여준다
#
# 09-01에 파이 화면이 세로로 떴다. 키오스크는 800×480 **가로**를 전제로 만들었다.
# CSS로 돌리면 안 된다 — 터치 좌표가 같이 돌지 않아 엉뚱한 곳이 눌린다.
#
# ⚠️ **터치스크린이면 화면을 돌린 뒤 터치가 맞는 자리에 눌리는지 반드시 확인할 것.**
#    화면만 돌고 터치는 안 도는 것이 흔한 함정이다.

set -eu

CONFIG="${HYODOL_CONFIG:-$HOME/.config/hyodol/kiosk.env}"
ROTATE="${1:-}"

command -v wlr-randr >/dev/null 2>&1 || {
  echo "wlr-randr 가 없습니다: sudo apt install -y wlr-randr" >&2
  exit 1
}

echo "── 현재 출력 상태 ───────────────────────────"
wlr-randr || true
echo

if [ -z "$ROTATE" ]; then
  echo "값을 주면 그 방향으로 돌리고 저장합니다: $0 90|180|270|normal"
  exit 0
fi

OUTPUT="${KIOSK_ROTATE_OUTPUT:-$(wlr-randr | awk 'NR==1 {print $1}')}"
[ -n "$OUTPUT" ] || { echo "출력을 찾지 못했습니다." >&2; exit 1; }

echo "── $OUTPUT 을(를) $ROTATE 로 돌립니다 ──────"
wlr-randr --output "$OUTPUT" --transform "$ROTATE"

# 저장은 눈으로 확인한 뒤에 한다. 잘못된 값을 부팅마다 적용하면
# 화면이 매번 뒤집혀 뜨는데, 그 상태에서는 고치기가 훨씬 번거롭다.
printf '화면이 제대로 보이나요? 저장하려면 y: '
read -r answer
case "$answer" in
  y|Y) ;;
  *) echo "저장하지 않았습니다. 재부팅하면 원래대로 돌아옵니다."; exit 0 ;;
esac

mkdir -p "$(dirname "$CONFIG")"
touch "$CONFIG"
chmod 600 "$CONFIG"

if grep -q '^KIOSK_ROTATE=' "$CONFIG"; then
  awk -v v="$ROTATE" '/^KIOSK_ROTATE=/ { print "KIOSK_ROTATE=" v; next } { print }' \
    "$CONFIG" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"
  chmod 600 "$CONFIG"
else
  echo "KIOSK_ROTATE=$ROTATE" >> "$CONFIG"
fi

echo "저장했습니다: $CONFIG (KIOSK_ROTATE=$ROTATE)"
echo "kiosk.sh 가 부팅 때마다 적용합니다. 확인: sudo reboot"
