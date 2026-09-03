#!/usr/bin/env bash
#
# 키오스크가 열 주소를 바꾼다.
#
# EC2를 재시작하면 cloudflared quick tunnel 주소가 매번 바뀐다. 그때마다 파이에서
# 텍스트 편집기를 여는 대신 이 한 줄을 쓴다.
#
#   ./set-url.sh https://xxxx-yyyy.trycloudflare.com
#
# 개발 PC에서 새 주소를 확인하는 방법은 `npm run access -- <EC2 퍼블릭 IP>`.

set -eu

CONFIG="${HYODOL_CONFIG:-$HOME/.config/hyodol/kiosk.env}"
URL="${1:-}"

if [ -z "$URL" ]; then
  echo "사용법: $0 https://<주소>" >&2
  exit 1
fi

case "$URL" in
  https://*) ;;
  *) echo "https 주소여야 합니다 — http로는 음성 인식과 카메라가 동작하지 않습니다." >&2; exit 1 ;;
esac

URL="${URL%/}"   # 끝의 슬래시를 떼어 둔다 (KIOSK_URL/api/... 로 이어 붙이므로)

mkdir -p "$(dirname "$CONFIG")"
touch "$CONFIG"
chmod 600 "$CONFIG"

if grep -q '^KIOSK_URL=' "$CONFIG"; then
  # 주소에 &, | 가 없다고 보장할 수 없으므로 sed 구분자를 안 쓰고 통째로 다시 쓴다
  awk -v url="$URL" '/^KIOSK_URL=/ { print "KIOSK_URL=" url; next } { print }' \
    "$CONFIG" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"
  chmod 600 "$CONFIG"
else
  echo "KIOSK_URL=$URL" >> "$CONFIG"
fi

echo "KIOSK_URL을 $URL 로 바꿨습니다."

# 살아 있는지 먼저 확인하고 나서 재시작한다 — 주소가 틀렸으면 지금 알아야 한다.
if command -v curl >/dev/null 2>&1; then
  # curl은 실패해도 -w 로 '000'을 찍는다 — 여기에 `|| echo 000`을 더하면 '000000'이 된다
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL/api/health" || true)
  if [ "$code" = "200" ]; then
    echo "✅ $URL/api/health → 200"
  else
    echo "⚠️  $URL/api/health → $code — 주소나 EC2 상태를 확인하세요." >&2
  fi
fi

if pgrep -f 'chromium.*--kiosk' >/dev/null 2>&1; then
  echo "키오스크를 재시작합니다..."
  pkill -f 'chromium.*--kiosk' || true   # kiosk.sh의 감시 루프가 3초 뒤 새 주소로 다시 띄운다
else
  echo "키오스크가 실행 중이 아닙니다 — 다음 시작 때 새 주소가 적용됩니다."
fi
