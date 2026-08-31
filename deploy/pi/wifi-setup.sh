#!/usr/bin/env bash
#
# 와이파이를 여러 개 등록하고 우선순위를 준다 (NetworkManager).
#
# 왜 필요한가: 지금 파이는 한 곳의 SSID만 알고 있어서 옮기면 연결이 끊긴다.
# 키오스크는 터널 주소를 인터넷으로 받아오므로 네트워크가 끊기면 화면이 죽는다.
#
# 우선순위를 폰 핫스팟에 가장 높게 주는 것은 의도적이다 — 행사장 와이파이는 아예 없기보다
# **캡티브 포털로 막혀 있을** 가능성이 크고, NetworkManager는 핫스팟이 실제로 방송 중일
# 때만 그것을 고른다. 그래서 복구 동작이 "폰에서 핫스팟 켜기" 한 번이 된다.
# 파이에 키보드가 없다는 조건에서 이게 가장 빠른 복구다.
#
#   ./wifi-setup.sh
#
# 비밀번호는 인자로 받지 않는다(셸 히스토리에 남는다). 레포에도 적지 않는다.

set -eu

command -v nmcli >/dev/null 2>&1 || { echo "nmcli가 없습니다 (NetworkManager 필요)" >&2; exit 1; }

add_wifi() {
  local label="$1" priority="$2" ssid password

  echo
  echo "── $label (우선순위 $priority) ──"
  printf 'SSID (건너뛰려면 엔터): '
  read -r ssid
  [ -n "$ssid" ] || { echo "건너뜁니다."; return 0; }

  printf '비밀번호: '
  read -rs password
  echo

  # 같은 이름이 이미 있으면 지우고 다시 만든다 — 오래된 비밀번호가 남아 있으면
  # 조용히 연결 실패만 반복한다.
  nmcli con delete "$ssid" >/dev/null 2>&1 || true

  nmcli con add type wifi con-name "$ssid" ifname wlan0 ssid "$ssid" \
    wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$password" >/dev/null

  nmcli con modify "$ssid" \
    connection.autoconnect yes \
    connection.autoconnect-priority "$priority" \
    connection.autoconnect-retries 0      # 0 = 무한 재시도. 자다 깬 파이가 포기하면 안 된다

  echo "✅ $ssid 등록 (우선순위 $priority)"
}

echo "와이파이를 등록합니다. 비밀번호는 화면에 표시되지 않습니다."
add_wifi "동아리방"      10
add_wifi "행사장/학교"   20
add_wifi "폰 핫스팟"     30     # 가장 높다 — 위 주석 참고

echo
echo "── 등록된 연결 (우선순위 순) ──"
nmcli -t -f NAME,TYPE,AUTOCONNECT-PRIORITY con show \
  | awk -F: '$2=="802-11-wireless" { printf "  %-24s %s\n", $1, $3 }' \
  | sort -k2 -rn

cat <<'EOF'

메모
  - 캡티브 포털(로그인 페이지가 뜨는 와이파이)에서는 키오스크가 동작하지 않는다.
    터널 주소를 인터넷으로 받아오기 때문이다 → 폰 핫스팟을 켜는 것이 더 빠르다.
  - IP가 바뀌어도 SSH는 hyodol.local(mDNS)로 들어갈 수 있다.
  - 네트워크를 바꾼 뒤에는 ./preflight.sh 로 백엔드 연결을 다시 확인할 것.
EOF
