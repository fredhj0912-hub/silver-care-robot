# 라즈베리파이 5 키오스크 배포

로봇 얼굴 화면을 파이 DSI 디스플레이에 상시 띄우는 절차다.
(실물 패널은 **720×1280 세로**, 09-03 실측. 그 전 문서의 "800×480 가로"는 틀린 값이었다.)

> 📋 **현장에서 순서대로 따라갈 것은 이 문서가 아니라 [`pi-runbook.md`](./pi-runbook.md)다.**
> 이 문서는 "왜 그렇게 하는가"와 한계·되돌리기를 담은 레퍼런스다.

> **✋ 2026-08-31 기준 이 문서는 실측이 아니다.** 하드웨어를 아직 붙여 보지 않았다.
> `docs/deploy-ec2-production.md`가 "아래는 전부 실측이다"로 시작하는 것과 정반대다.
> **09-01에 실제로 실행하면서 이 문서를 실측값으로 고칠 것.** 틀린 것을 찾으면 그게 성과다.

**파이에서는 아무것도 빌드하지 않는다.** 백엔드와 프론트엔드는 EC2에서 돌고(`PUBLIC_DIR`로
같은 오리진 서빙), 파이는 그 주소를 여는 **Chromium 하나**다. 그래서 앱을 고치면 파이가
아니라 EC2에 배포해야 한다 — `docs/deploy-ec2-production.md` 참고.

---

## ⚠️ 알려진 한계 — 반드시 먼저 읽을 것

### 1. HTTPS(터널 주소)로만 열어야 한다

`http://<파이 LAN IP>:3001`로 열면 **음성 인식·카메라·서비스워커가 전부 조용히 죽는다.**
브라우저가 보안 컨텍스트(HTTPS 또는 localhost)에서만 그 API를 주기 때문이다.

이제는 조용히 죽지 않는다 — 화면 상태 줄에 `안전하지 않은 주소로 열렸어요 (HTTPS 필요)`가
뜬다. 그게 보이면 주소부터 고칠 것.

### 2. 터널 주소는 EC2를 재시작할 때마다 바뀐다

cloudflared quick tunnel의 성질이다. 개발 PC에서 `npm run access -- <EC2 퍼블릭 IP>`로 새
주소를 확인하고, 파이에서 한 줄:

```bash
~/silver-care-robot/deploy/pi/set-url.sh https://<새 주소>.trycloudflare.com
```

### 3. 🔴 Chromium 음성 인식은 안 된다 → **서버측 STT로 우회했다** (2026-09-02)

**증상 (2026-09-01 실측 확정)**: 파이 OS 저장소의 Chromium이 구글 음성 서비스 키 없이
빌드돼 있다. `webkitSpeechRecognition` 객체는 있는데 매 세션이 `network` 오류로 끝난다.
화면에는 설계대로 `음성 인식 서버에 닿지 않아요 · 아래에 글로 말씀해 주세요`가 떴다 —
**하드닝은 의도대로 동작했고, 안 되는 것은 브라우저 쪽이었다.**

텍스트 폴백에도 구멍이 있었다: 파이에 **가상 키보드가 없어서** 화면 입력에는 물리 키보드가
필요하다. 즉 살아 있는 입력이 **폰 보호자 앱**뿐이었는데, 어르신은 폰을 쓰지 않는다.

**해결 (2026-09-02)**: 브라우저를 거치지 않고 **파이가 직접 마이크를 녹음해 백엔드로 보낸다.**
`POST /api/stt` → Gemini가 받아쓴다. arm64용 정식 크롬 빌드가 없어 브라우저 교체는
경로가 아니었으므로, 실사용 경로는 이것뿐이다.

| | |
|---|---|
| 전환 스위치 | `frontend/.env`의 `VITE_STT_MODE` = `server`(기본) | `browser` |
| 프론트 | `lib/server-recognizer.js` — Web Audio로 raw PCM 캡처 → `lib/vad.js`가 발화 경계 판정 → `lib/wav.js`로 WAV 인코딩 → 업로드 |
| 백엔드 | `routes/stt.js` → `services/gemini.js`의 `transcribeAudio()` (`analyzeImage`와 같은 `inlineData` 경로) |
| 인터페이스 | `lib/stt.js`의 `createRecognizer` 계약을 그대로 지킨다 — 호출부(`RobotFaceDisplay.jsx`)와 웨이크워드 게이트는 바뀌지 않았다 |

**왜 MediaRecorder가 아니라 raw PCM인가**: Chromium의 MediaRecorder는
`audio/webm;codecs=opus`를 내놓는데 **Gemini의 지원 오디오 목록에 webm이 없다**
(wav/mp3/aiff/aac/ogg/flac). 서버에서 ffmpeg로 변환하면 EC2 의존성이 늘고, 그런 종류의
실패는 파이 앞에서만 드러난다. WAV로 직접 감싸면 컨테이너 협상 자체가 사라진다.

**감수한 것 두 가지** (선택이 아니라 사실로 적어 둔다):

- **방 안의 모든 발화가 Gemini로 올라간다.** 웨이크워드 판정이 받아쓰기 *뒤에* 일어나므로
  게이트가 닫혀 있어도 호출은 발생한다. 로컬 웨이크워드 감지 없이는 구조적으로 못 피한다.
  에너지 임계값 + 최소 발화 길이(0.4초) + 최대 길이(12초)로 잡음·정적만 걸러 낸다.
- **왕복 지연이 늘어난다.** 침묵 감지(0.9초) → 업로드 → 받아쓰기 → 대답 → 음성 합성.
  **실측은 아직 없다** — 파이에서 재야 한다.

**아직 실측 전이다.** 로컬(윈도우 Chrome) 테스트와 자동 테스트는 통과했지만, 파이의
reSpeaker 마이크에서 VAD 임계값(`lib/vad.js`의 `startThreshold`)이 맞는지는
거기서만 알 수 있다. 절차는 `docs/pi-runbook.md` §6-3.

### 3-2. 오디오 기본 장치를 USB 마이크가 가로챈다 (2026-09-01 실측)

USB 마이크 어레이(reSpeaker XVF3800)를 꽂으면 **기본 출력(sink)까지 그쪽으로 잡힌다.**
그러면 로봇이 말을 해도 아무 소리가 안 나고, `speaker-test`는
`Playback open error: -524`만 뱉어 원인을 알 수 없다. `wpctl status`의 Sinks에서 `*`가
어디 붙어 있는지 보고 `wpctl set-default <스피커 ID>`로 바꾼다. 한 번 바꾸면 재부팅해도
유지된다. `preflight.sh` 5번이 이제 기본 출력을 출력하고 마이크면 경고한다.

**브라우저 TTS(`TTS_PROVIDER=browser`)는 파이에서 쓰지 말 것.** 리눅스 Chromium은
`speech-dispatcher`가 있어야 하고, 있어도 한국어 보이스가 없으면 **아무 소리 없이 조용히
실패한다.** EC2에서 `TTS_PROVIDER=gemini`로 두면 브라우저 음성 엔진이 필요 없어지고
품질도 낫다. 폰 발화 왕복은 그 구성에서 **5초 안팎**이었다.

### 3-3. 화면이 세로로 뜬다 (2026-09-01 실측) — OS 레벨에서 돌린다

키오스크 레이아웃은 09-03부터 **화면 크기를 전제하지 않는다** — 얼굴이 남는 자리를 채운다.
09-01에 파이 화면이 세로로 떠서 레이아웃이 통째로 어긋났다.

**CSS로 돌리면 안 된다.** `transform: rotate()`는 그림만 돌리고 **터치 좌표는 그대로**
두기 때문에, 화면은 멀쩡해 보이는데 엉뚱한 곳이 눌린다. 어르신이 쓰는 화면에서 이것은
고장보다 나쁘다 — 눌리기는 눌리는데 다른 게 눌린다.

`kiosk.env`의 **`KIOSK_ROTATE`** 에 값을 넣으면 `kiosk.sh`가 감시 루프에 들어가기 전
`wlr-randr`로 한 번 적용한다. 비어 있으면 아무것도 건드리지 않는다(기존 동작).
값 찾기와 저장은 `deploy/pi/set-rotation.sh`가 한다.

XDG 자동실행이 아니라 `kiosk.sh` 안에서 돌리는 이유: 자동실행 등록은 **한 곳(XDG)에만**
둔다는 09-01의 교훈을 지키기 위해서다(두 곳에 걸려 화면이 3초마다 깜빡인 사고가 있었다).
`kiosk.sh`는 그래픽 세션의 자식이라 `WAYLAND_DISPLAY`가 이미 잡혀 있다.

**미검증 항목**: 화면을 돌렸을 때 **터치 좌표도 함께 도는지**. Wayland 컴포지터는 보통
같이 돌리지만 확인 전까지는 믿지 않는다 — 화면만 돌고 터치는 안 도는 것이 흔한 함정이다.

### 4. `move` 명령을 소비(ack)하는 것은 구동부 프로세스 하나뿐이다

키오스크는 이동 명령을 **보기만 하고 ack하지 않는다**(화면에 화살표만 띄운다).
브라우저가 ack해 버리면 모터가 명령을 영영 받지 못하기 때문이다.

그래서 **구동부 프로세스가 없으면 `move` 명령은 큐에 쌓인 채 남는다.** 의도된 동작이다.
조회할 때 `?kind=move&maxAgeMs=2000`으로 나이 제한을 걸어, 끊겼다 돌아온 소비자가 낡은
"앞으로"를 실행하지 않게 한다.

> 아직 미정: 키오스크 폴링 주기는 2.5초인데 `services/motion.js`의 데드맨은 500ms다(5배 차이).
> 실제 구동부는 훨씬 빠른 폴링이나 다른 전송이 필요하다. **실물에서 측정해 결정할 것.**

### 5. 구동부가 파이 GPIO에 연결돼 있는지 미확인

예전에 따로 제어해 본 적은 있으나 이 파이에 물려 있는지는 확인하지 않았다.
**연결 확인이 원격조종 테스트의 첫 단계다.**

### 6. quick tunnel은 SSE를 통과시키지 못한다

EC2 배포 문서의 알려진 한계 1번과 같다. 키오스크는 원래 2.5초 폴링이라 영향이 없고,
보호자 앱은 30초 폴백 폴링으로 동작한다.

---

## 1. 준비

파이 OS Bookworm(64-bit) + 데스크톱 세션이 뜬 상태에서 시작한다.

> ⚠️ **`-b feat/pi-deployment`를 빠뜨리지 말 것.** `deploy/pi/` 스크립트는 이 브랜치에만
> 있고 `main`에는 아직 없다. 그냥 `git clone`하면 폴더 자체가 없다.
> (main에 머지한 뒤에는 `-b` 없이 받으면 된다.)

```bash
sudo apt update && sudo apt install -y chromium-browser git curl alsa-utils wlr-randr
git clone -b feat/pi-deployment https://github.com/fredhj0912-hub/silver-care-robot.git
cd silver-care-robot/deploy/pi && ls -l *.sh   # 실행 권한은 git에 들어 있다
```

`npm`도 `node`도 필요 없다 — 파이는 브라우저만 띄운다.

## 2. 설정 파일

```bash
./install-autostart.sh                       # 설정 파일 생성 + 자동실행 등록 + 화면 꺼짐 해제
./set-url.sh https://<터널 주소>.trycloudflare.com
```

`~/.config/hyodol/kiosk.env`(권한 600)에 저장된다. **레포 안이 아니다** — 이 레포는
공개이고 터널 주소는 사실상 접근 토큰이다(`ACCESS.html`을 gitignore하는 것과 같은 이유).

`preflight.sh`가 `/api/status`까지 확인하게 하려면 `ROBOT_API_KEY`도 채운다.
키오스크 실행 자체에는 필요 없다(키는 이미 프론트엔드 번들에 있다).

## 3. 자동실행

`install-autostart.sh`가 `~/.config/autostart/hyodol-kiosk.desktop`을 쓴다.

**systemd user 서비스를 쓰지 않은 이유**: Bookworm/파이5는 Wayland(labwc·wayfire)가 기본인데,
user 서비스는 SSH 로그인에서도 뜨고 컴포지터 환경변수(`WAYLAND_DISPLAY`,
`XDG_RUNTIME_DIR`)를 못 물려받는 경우가 있다. 그러면 증상이 "Chromium이 안 뜬다"로만 보이고
쓸 만한 로그가 없다. XDG 자동실행은 그래픽 세션의 자식이라 환경이 구조적으로 맞다.

대신 `Restart=always`를 잃으므로 `kiosk.sh`가 감시 루프(`while true; … sleep 3`)로
같은 복구력을 갖는다.

**등록은 XDG 한 곳에만 한다** (2026-09-01 실측으로 확정). 예전에는 labwc가 XDG를 안 읽는
경우에 대비해 `~/.config/labwc/autostart`에도 함께 걸었는데, 파이5(labwc)에서 **XDG만으로
정상 동작**했고 양쪽 등록은 실제로 사고를 냈다: `kiosk.sh` 루프가 두 개 돌면서 두 번째
Chromium이 첫 번째 인스턴스에 URL만 넘기고 코드 0으로 끝나고(`Opening in existing browser
session`), 감시 루프가 그것을 죽은 것으로 보고 3초마다 다시 띄웠다. **증상이 "Chromium이 두
개"가 아니라 "화면이 3초 주기로 하얗게 깜빡임"이라 원인을 찾기 어려웠다** — Chromium 프로세스
개수를 세면 1이 나오기 때문이다(세야 하는 것은 `kiosk.sh` 개수다).

지금은 두 겹으로 막는다:
- `install-autostart.sh`가 XDG에만 등록하고, labwc autostart에 남은 `kiosk.sh` 줄은 지운다.
- `kiosk.sh`가 `flock`으로 잠금을 잡아 **루프가 하나만** 돌게 하고, Chromium이 5초 안에
  코드 0으로 끝나면 재시작하지 않고 원인을 적고 멈춘다.

## 4. 와이파이

```bash
./wifi-setup.sh
```

동아리방 10 / 행사장 20 / **폰 핫스팟 30(가장 높음)** 우선순위로 등록한다.
핫스팟이 가장 높은 것은 의도적이다 — 행사장 와이파이는 아예 없기보다 캡티브 포털로 막혀
있을 가능성이 크고, NetworkManager는 핫스팟이 실제로 방송 중일 때만 그것을 고른다.
그래서 복구가 **폰에서 핫스팟 켜기 한 번**이 된다. 파이에 키보드가 없다는 조건에서 이게 맞다.

IP가 바뀌어도 SSH는 `<파이 호스트명>.local`(mDNS, 파이 OS 기본값은 `raspberrypi`)로
들어갈 수 있다. 호스트명은 파이에서 `hostname`, IP는 `hostname -I`로 확인한다.

## 5. 사전 점검

```bash
./preflight.sh
```

기기 → 컴포지터 → 네트워크 → **백엔드 연결** → 스피커 → 마이크 → 카메라 → Chromium 순으로
확인한다. 연쇄 실패가 먼저 드러나는 순서다. ❌가 하나라도 있으면 종료 코드가 1이다.

**4번(백엔드 연결)이 내일 가장 자주 틀릴 항목이다** — 터널 주소가 낡았을 때다.

마지막 9번은 셸로 확인할 수 없는 것들을 화면에서 읽으라고 안내한다. 얼굴 아래 상태 줄이
그대로 진단 메시지다:

| 화면 문구 | 뜻 |
|---|---|
| `"효돌아" 하고 불러주세요` | 정상 |
| `안전하지 않은 주소로 열렸어요` | http로 열렸다 → 한계 1 |
| `마이크를 쓸 수 없어요` | 권한/장치 문제 → preflight 6번 |
| `음성 인식 서버에 닿지 않아요` | Chromium STT 실패 → 한계 3 |
| `📷 카메라 없음` | 카메라 미인식 → preflight 7번 |

> ⚠️ Chromium은 `--use-fake-ui-for-media-stream`으로 권한 대화상자를 자동 수락하는데
> (키보드가 없으면 누를 수 없으므로 필요하다), 이때 **기본 입력 장치**를 집는다.
> USB 마이크가 기본이 아니면 조용히 엉뚱한 장치를 잡는다 — `preflight.sh` 6번이 기본 장치를
> 출력하는 이유다.

## 6. 검증

```bash
sudo reboot        # 자동으로 키오스크가 뜨는지 (자동실행의 유일한 진짜 검증)
```

그다음 순서대로:

1. **화면** — 로봇 얼굴이 전체 화면으로 뜨고 마우스 커서가 안 보이는지
2. **소리** — 보호자 앱에서 메시지를 보내 로봇이 실제로 말하는지
   (자동재생 차단은 `--autoplay-policy` 플래그로 막았지만 실측한 적이 없다)
3. **음성** — "효돌아" 하고 부르면 반응하는지 → 안 되면 한계 3
4. **원격조종** — 보호자 앱 D-pad → 화면에 화살표가 뜨는지
   (여기까지가 소프트웨어. 모터가 실제로 도는 것은 구동부 프로세스가 있어야 한다 — 한계 4·5)
5. **카메라** — `VITE_VISION_ENABLED=true`로 빌드된 번들이어야 한다.
   화면에 `📷 카메라 없음`이 안 뜨면 잡힌 것이다
6. **낙상 알림 경로** — 모델 없이 먼저 배관부터 확인한다:
   ```bash
   # 개발 PC 또는 EC2에서
   cd backend && npm run mock-detector -- --type fall --confidence 0.92
   ```
   보호자 폰에 푸시가 오면 감지 → 알림 → 푸시 경로가 살아 있는 것이다.
   남은 것은 실제 YOLOv8 detector뿐이다 (`docs/fall-detection.md`).

## 7. 되돌리기

```bash
rm ~/.config/autostart/hyodol-kiosk.desktop     # 자동실행 해제
pkill -f 'chromium.*--kiosk'                    # 지금 뜬 키오스크 종료
sudo raspi-config nonint do_blanking 0          # 화면 꺼짐 원복
```

`~/.config/hyodol/`을 지우면 설정과 Chromium 프로필까지 사라진다.
