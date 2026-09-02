#!/usr/bin/env bash
#
# 파이 사전 점검 — 앱을 의심하기 전에 하드웨어와 네트워크부터 확인한다.
#
# 읽기 전용이다(스피커 테스트음만 낸다). 연쇄 실패가 먼저 드러나는 순서로 돈다:
# 네트워크가 죽었으면 카메라를 봐야 소용없다.
#
#   ./preflight.sh
#
# ❌ 가 하나라도 있으면 종료 코드가 1이다.

set -u

FAILED=0
ok()   { echo "✅ $*"; }
warn() { echo "⚠️  $*"; }
bad()  { echo "❌ $*"; FAILED=1; }
have() { command -v "$1" >/dev/null 2>&1; }

# 명령이 없는 환경(개발 PC 등)에서도 크래시하지 않고 넘어간다
need() {
  if have "$1"; then return 0; fi
  warn "$1 명령이 없습니다 — 이 항목은 건너뜁니다"
  return 1
}

CONFIG="${HYODOL_CONFIG:-$HOME/.config/hyodol/kiosk.env}"
if [ -f "$CONFIG" ]; then
  # shellcheck source=/dev/null
  . "$CONFIG"
fi

echo "════ 1. 기기 ════════════════════════════════"
if [ -r /proc/device-tree/model ]; then
  ok "$(tr -d '\0' < /proc/device-tree/model)"
else
  warn "라즈베리파이가 아닙니다 (개발 PC에서 도는 중일 수 있습니다)"
fi
[ -r /etc/os-release ] && ok "$(. /etc/os-release && echo "$PRETTY_NAME")"

echo
echo "════ 2. 그래픽 세션 ═════════════════════════"
echo "   XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-(없음)}  WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-(없음)}"
if pgrep -x labwc >/dev/null 2>&1; then ok "컴포지터: labwc"
elif pgrep -x wayfire >/dev/null 2>&1; then ok "컴포지터: wayfire"
elif [ "${XDG_SESSION_TYPE:-}" = "x11" ]; then ok "컴포지터: X11"
else warn "컴포지터를 확인하지 못했습니다 — 자동실행이 안 뜨면 여기부터 보세요"; fi
# 화면 방향 — 09-01에 세로로 떠서 레이아웃이 통째로 어긋났다. 키오스크는 800×480
# 가로 전제다. 여기서 현재 transform 을 눈으로 확인하고, 틀리면 ./set-rotation.sh 로 고친다.
if command -v wlr-randr >/dev/null 2>&1; then
  echo "   ── 출력/방향 ──"
  wlr-randr 2>/dev/null | sed "s/^/   /" || warn "wlr-randr 실행 실패 (그래픽 세션에서 실행해야 합니다)"
  echo "   가로(예: 800x480 + transform normal)가 아니면: ./set-rotation.sh 90"
else
  warn "wlr-randr 가 없어 화면 방향을 확인하지 못했습니다 (sudo apt install -y wlr-randr)"
fi

echo
echo "════ 3. 네트워크 ════════════════════════════"
if need nmcli; then
  active=$(nmcli -t -f NAME,DEVICE con show --active 2>/dev/null | head -5)
  [ -n "$active" ] && ok "활성 연결: $active" || bad "활성 네트워크 연결이 없습니다"
fi
if need ping; then
  ping -c1 -W3 1.1.1.1 >/dev/null 2>&1 && ok "인터넷 도달 가능" || bad "인터넷에 나가지 못합니다"
fi

echo
echo "════ 4. 백엔드 연결 (가장 자주 틀리는 항목) ══"
if [ -z "${KIOSK_URL:-}" ]; then
  bad "KIOSK_URL이 설정되지 않았습니다 — ./set-url.sh https://<터널 주소>"
elif need curl; then
  # curl은 실패해도 -w 로 '000'을 찍는다 — `|| echo 000`을 더하면 '000000'이 된다
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$KIOSK_URL/api/health" || true)
  if [ "$code" = "200" ]; then
    ok "$KIOSK_URL/api/health → 200"
  else
    bad "$KIOSK_URL/api/health → $code (터널 주소가 낡았을 가능성이 가장 큽니다)"
  fi

  if [ -n "${ROBOT_API_KEY:-}" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -H "x-api-key: $ROBOT_API_KEY" "$KIOSK_URL/api/status" || true)
    [ "$code" = "200" ] && ok "/api/status → 200 (API 키 유효)" \
      || bad "/api/status → $code (ROBOT_API_KEY 불일치 가능)"
  else
    warn "ROBOT_API_KEY가 없어 인증 확인을 건너뜁니다"
  fi
fi

echo
echo "════ 5. 스피커 ══════════════════════════════"
if need aplay; then
  if aplay -l 2>/dev/null | grep -q '^card'; then
    ok "재생 장치: $(aplay -l 2>/dev/null | grep '^card' | head -2 | tr '\n' ' ')"
    # 기본 출력이 어디로 잡혔는지 보여준다. USB 마이크 어레이가 기본 sink를 가로채는
    # 일이 실제로 있었고(09-01 reSpeaker), 그러면 speaker-test가
    # "Playback open error: -524"만 뱉어 원인을 알 수 없다.
    if have wpctl; then
      # 구획을 Sources: 에서 끊는다. 예전에는 빈 줄로 끊으려 했는데 wpctl 출력의
      # 구획 사이는 빈 줄이 아니라 '│' 라서 끊기지 않았고, **마이크의 기본 장치까지
      # 함께 집혀** 멀쩡한 스피커를 두고 "기본 출력이 마이크입니다" 오탐이 났다
      # (2026-09-02 파이 실측). head -1 은 그래도 두 줄이 잡히는 경우의 안전판이다.
      sink=$(wpctl status 2>/dev/null         | sed -n "/Sinks:/,/Sources:/p"         | grep "[*]" | head -1         | sed "s/.*[*] *[0-9]*[.] *//")
      if [ -n "$sink" ]; then
        echo "   기본 출력: $sink"
        case "$sink" in
          *Mic*|*mic*|*Array*|*array*)
            warn "기본 출력이 마이크 장치입니다 — 소리가 안 납니다. wpctl set-default <스피커 ID>로 바꾸세요" ;;
        esac
      else
        warn "기본 출력을 확인하지 못했습니다 — wpctl status 를 직접 보세요"
      fi
    fi
    # 소리는 PipeWire 경로로 낸다. speaker-test 는 ALSA 'default' 를 직접 치는데
    # 파이에서는 그게 HDMI(vc4hdmi)로 잡혀 있어 USB 스피커를 쓰면 -524 만 뱉는다
    # — 실패해도 스피커가 고장난 것이 아니라 경로가 다른 것이다(2026-09-02 실측).
    SOUND=/usr/share/sounds/alsa/Front_Center.wav
    if have pw-play && [ -f "$SOUND" ]; then
      echo "   소리를 냅니다 — 들리는지 **귀로** 확인하세요."
      pw-play "$SOUND" >/dev/null 2>&1 || warn "pw-play 실패 — 기본 출력을 확인하세요 (wpctl status)"
    elif have speaker-test; then
      echo "   440Hz 소리를 냅니다 — 들리는지 확인하세요."
      speaker-test -t sine -f 440 -l 1 >/dev/null 2>&1         || warn "speaker-test 실행 실패 (ALSA default 경로 문제일 수 있습니다 — pw-play 로 확인하세요)"
    fi
  else
    bad "재생 장치가 없습니다 — 로봇이 말을 해도 들리지 않습니다"
  fi
fi

echo
echo "════ 6. 마이크 ══════════════════════════════"
if need arecord; then
  if arecord -l 2>/dev/null | grep -q '^card'; then
    ok "녹음 장치: $(arecord -l 2>/dev/null | grep '^card' | head -2 | tr '\n' ' ')"
    # Chromium은 --use-fake-ui-for-media-stream 때문에 '기본' 장치를 말없이 집는다.
    # USB 마이크가 기본이 아니면 아무 소리도 못 듣는데 화면에는 오류가 안 뜬다.
    echo "   ⚠️  Chromium은 아래 '기본' 장치를 씁니다. USB 마이크가 맞는지 확인하세요:"
    arecord -L 2>/dev/null | grep -A1 '^default' | head -2 | sed 's/^/      /'
  else
    bad "녹음 장치가 없습니다 — 음성 대화가 불가능합니다"
  fi
fi

echo
echo "════ 7. 카메라 ══════════════════════════════"
if have rpicam-hello; then
  rpicam-hello --list-cameras 2>/dev/null | grep -q ':' \
    && ok "$(rpicam-hello --list-cameras 2>/dev/null | head -3 | tr '\n' ' ')" \
    || bad "파이 카메라를 찾지 못했습니다"
elif have libcamera-hello; then
  libcamera-hello --list-cameras 2>/dev/null | grep -q ':' \
    && ok "libcamera로 카메라 확인" || bad "파이 카메라를 찾지 못했습니다"
elif have v4l2-ctl; then
  v4l2-ctl --list-devices 2>/dev/null | grep -q '/dev/video' \
    && ok "USB 카메라: $(v4l2-ctl --list-devices 2>/dev/null | head -1)" \
    || bad "카메라 장치가 없습니다"
else
  warn "카메라 확인 명령이 없습니다 (rpicam-hello / v4l2-ctl)"
fi

echo
echo "════ 8. Chromium ════════════════════════════"
for c in chromium-browser chromium; do
  if have "$c"; then ok "$($c --version 2>/dev/null)"; break; fi
done
have chromium-browser || have chromium || bad "Chromium이 설치돼 있지 않습니다"

echo
echo "════ 9. 화면에서 직접 볼 것 ═════════════════"
cat <<'EOF'
   여기서부터는 셸로 확인할 수 없습니다. 키오스크를 열고 **얼굴 아래 상태 줄**을 읽으세요:

     "효돌아" 하고 불러주세요        → 정상. 음성 인식이 살아 있습니다.
     안전하지 않은 주소로 열렸어요   → http로 열렸습니다. https 터널 주소를 쓰세요.
     마이크를 쓸 수 없어요           → 권한/장치 문제. 위 6번을 다시 보세요.
     음성 인식 서버에 닿지 않아요    → Chromium이 구글 음성 서비스에 닿지 못합니다.
                                       (파이 OS 저장소 Chromium의 알려진 위험 — 미검증)
     📷 카메라 없음                  → 위 7번을 다시 보세요.
EOF

echo
if [ "$FAILED" -eq 0 ]; then
  echo "════ 결과: 자동 점검 통과 ═══════════════════"
else
  echo "════ 결과: ❌ 항목이 있습니다 — 위를 확인하세요 ══"
fi
exit "$FAILED"
