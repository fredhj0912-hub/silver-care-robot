# TODO

효돌이 프로젝트 작업 목록. Claude Code가 이 파일을 읽고 다음 작업을 이어간다.

**사용법**
- 작업 시작: "TODO.md 읽고 첫 번째 항목부터 시작해"
- 세션 종료: "TODO.md 업데이트해줘"

아키텍처는 `docs/architecture.md`, 초기 계획서는
`C:\Users\fredh\.claude\plans\modular-rolling-wozniak.md`.
완료 이력은 맨 아래 요약 + `git log`.

---

## 지금 할 것

**2026-09-01에 라즈베리파이 5 실물 연동 일정이 잡혔다** (08-31 갱신). 그래서 순서를 다시
짰다 — 아래 "내일 파이에서 확인할 것"이 1순위이고, 기술 부채(A 트랙)는 그 뒤다.

### 남은 마무리 (08-31 세션)

- [x] PR #8(문서) 머지
- [ ] **팀원에게 알리기** — 우리 테이블 7개가 팀원의 `silvercare` DB에 생겼고,
      RDS 보안 그룹에 규칙 2개(우리 EC2 SG, 개발 PC 공인 IP)를 추가했다.
      팀원 테이블·데이터는 그대로인 것을 확인했다.
- [ ] 보호자 앱을 열어 대화 로그 60건·알림 이력이 보이는지 육안 확인 →
      **푸시 구독 다시 등록**(이관된 구독은 origin이 NULL이라 정리 로직이 지운다. 의도된 동작)

### ✅ 트랙 분기 해소 — **B 트랙이 1순위다** (2026-08-31)

하드웨어가 생겼다. 파이 5에 **모니터·마이크·스피커·카메라·구동부**가 붙어 있고
**09-01에 연동**한다. 위의 트랙 분기는 여기서 끝났다 — 아래 "내일 파이에서 확인할 것"을 먼저 보고,
A 트랙은 그 뒤에 이어서 한다.

### 🔴 내일(09-01) 파이에서 확인할 것 — 순서대로

절차는 `docs/deploy-raspberry-pi.md`. **오늘 만든 것은 전부 미검증이다.**

- [ ] **EC2에 오늘 변경분 배포** (선행 필수 — 안 하면 파이가 옛 번들을 받는다).
      `git pull` → `frontend/.env`에 `VITE_VISION_ENABLED=true` → `npm run build` →
      `systemctl restart hyodol.service` → `npm run access` 로 새 터널 주소
- [ ] `deploy/pi/install-autostart.sh` → `set-url.sh` → `preflight.sh`
- [ ] **재부팅했을 때 키오스크가 자동으로 뜨는가** (자동실행의 유일한 진짜 검증)
- [ ] **🔴 Chromium 음성 인식이 되는가** — 가장 큰 미지수. 음성 기능 전체가 여기 달렸다.
      실패하면 화면에 `음성 인식 서버에 닿지 않아요`가 뜨고 텍스트 입력으로 넘어간다
- [ ] 로봇이 실제로 **소리를 내는가** (`--autoplay-policy` 플래그가 먹히는지 미검증)
- [ ] 마이크·스피커의 **기본 장치**가 맞게 잡히는가 (Chromium이 기본 장치를 말없이 집는다)
- [ ] 카메라가 잡히는가 (화면에 `📷 카메라 없음`이 안 뜨면 성공)
- [ ] **구동부가 파이 GPIO에 실제로 연결돼 있는가** — 원격조종의 첫 단계
- [ ] 원격조종 왕복 지연 측정 → **데드맨 500ms vs 폴링 2.5초** 정책 확정 (아래 B 트랙)

### A 트랙 — 소프트웨어 (기본값, 전부 로컬에서 가능)

- [ ] **RDS 마스터 암호 교체** — **팀원 앱 설정도 함께 바꿔야 하므로 조율이 필요**해
      제일 먼저 꺼내 둔다. 바꾼 뒤 로컬·EC2 양쪽 `.env`와 팀원 쪽을 모두 갱신하고
      `npm run verify-rds`로 확인한다. (암호 값은 이 레포에 적지 않는다.)
- [ ] **보호자 로그인(세션/JWT)** — 남은 것 중 **가장 큰 구조적 부채**. 여러 세션이 든다.
      상세는 아래 백로그.
- [ ] **`purge-old-messages` 정기 실행 등록** — 삭제 범위는 확인 끝났다(아래 백로그).
      남은 건 EC2에 cron/systemd timer를 다는 일이라 로컬에서는 못 끝낸다.
- [ ] (선택) **Cloud TTS 전환** — 목소리 품질을 급히 올려야 할 때만. 상세는 아래 백로그.

### B 트랙 — 하드웨어 (1순위)

- [x] **파이 배포 자산 작성** (08-31) — `deploy/pi/` + `docs/deploy-raspberry-pi.md`.
      kiosk 실행기(Chromium 플래그·감시 루프), XDG 자동실행, 터널 주소 교체, 사전 점검,
      와이파이 다중 SSID. **전부 미검증** — 위 09-01 목록에서 확인한다.
      systemd user 서비스가 아니라 XDG 자동실행을 고른 이유는 문서 §3에 적었다.
- [ ] **라즈베리파이 5 실물 배포** — 위 "내일 확인할 것" 목록이 실행 절차다
      - [ ] **원격조종 네트워크 지연/단절 정책** (Phase 7 잔여) — 500ms 데드맨보다 명령
            전송이 늦어지면 로봇이 끊겨 이동하거나 정지 요청이 유실될 수 있다.
            시뮬레이션에선 안 드러나고 실물에서만 문제가 되므로 거기서 결정한다.
            **부분 해결(08-31)**: 조회에 `?maxAgeMs=`를 걸어 낡은 이동 명령을 빼도록 했다.
            키오스크 폴링 2.5초 vs 데드맨 500ms의 5배 격차는 **실물에서 측정해 정한다.**
      - [x] 와이파이 다중 SSID — `deploy/pi/wifi-setup.sh` (미검증)
      - [ ] 파이 ↔ 백엔드(EC2) ↔ 보호자 앱 네트워크 구성 미정
            (퍼블릭 도메인 vs 터널 유지). 터널 유지 시 재시작마다 `set-url.sh` 한 번이 필요하다
      - [ ] **구동부 소비자 프로세스** — 아직 없다. `move`를 ack하는 것은 이 프로세스
            **하나뿐**이어야 한다(키오스크는 08-31부터 보기만 하고 ack하지 않는다).
            GPIO 배선을 확인한 뒤에 만든다 — 지금 만들면 쓰이지 않는 코드다
- [ ] **YOLOv8 낙상 감지 실제 구현** — 백엔드 계약(`POST /api/detections`)과 mock은 이미
      완성돼 있어 **백엔드 변경은 불필요**하다. `detector/`에 Python(FastAPI) 서비스를 만들어
      계약대로 POST만 하면 된다. `docs/fall-detection.md` 참고.
      배포 골격은 팀원 레포의 `deploy/silvercare-api.service`(systemd)를 그대로 쓸 만하다.
      - [ ] **선행: detector용 presigned 업로드** (아래 백로그). detector가 없는 지금 미리
            만들면 쓰이지 않는 코드가 되므로 **A 트랙에 두지 않았다.**
      - [ ] 카메라 → detector 데이터 흐름 미정 (RTSP / HTTP 스트리밍 / 파일 감시)
      - [ ] 파이5 CPU 추론 가속(ONNX Runtime/OpenVINO) 여부와 목표 FPS 미정

> **낙상 감지에 GPU는 필요 없다** (08-31 판단). 대회 계정에 클라우드 GPU가 없다는 것과
> 낙상 감지를 못 한다는 것은 별개다. YOLOv8n은 GPU 없이 도는 것을 전제로 만든 모델이고,
> 파이5(Cortex-A76 4코어)에서 입력을 320~416px로 낮추면 실용 FPS가 나온다 — **추론은 파이
> 로컬에서 돈다.**
>
> Gemini API로 낙상을 대체하는 것은 **구조적으로 맞지 않는다.** 낙상은 하강 속도를 가진
> *움직임*인데 Gemini에 보내는 것은 정지 프레임 한 장이라, 바닥에 누운 사람이 "넘어진 것"인지
> "누워 쉬는 것"인지 구분되지 않는다. 호출당 1~3초 지연 + 프레임당 과금도 상시 감시에 부적합하다.
> → **YOLOv8n = 순간 이벤트(고빈도) / Gemini = 표정·상태 요약(저빈도).** 지금 코드가 이미 그렇다.

---

## 프로젝트 제약 — 시작 전에 반드시 읽을 것

**대회(한이음 드림업) 제공 AWS 계정** (2026-08-27 실측 확정):

| 가능 | 불가능 |
|---|---|
| EC2, Lambda, RDS, DynamoDB, S3, API GW, Amplify, SQS, SNS | **Bedrock, Polly, Transcribe 등 클라우드 AI 전부** |

→ **AI는 Gemini API를 계속 쓴다.** 대화·비전·음성을 AWS로 옮기는 계획은 세우지 말 것.
Bedrock 어댑터를 실제로 만들어 테스트했으나 `BedrockDeny` 명시적 거부 정책이 걸려 있었고,
explicit deny는 EC2 IAM Role을 거쳐도 우회 불가라 **전부 제거했다**(2026-08-27).

**계정 공통 제약**
- **Access Key 발급 절대 불가.** 인증은 IAM Role만 — EC2는 `SafeInstanceProfile-{username}`.
  IAM Role은 AWS 안에서 도는 프로세스에만 붙으므로 **로컬에서는 인증 테스트가 불가능**하다.
  **예외: RDS**(사용자/비밀번호 인증) — 아래 "RDS 운영 메모" 참고.
- MFA 설정 후 재로그인해야 자원 생성 가능(`DenyAllWithoutMFA`).
- 지정 리전 밖에서는 모든 활동 제한 — **문제 생기면 리전부터 확인.**
- EC2는 `t3.nano`~`t3.small`만. S3 버킷 이름은 본인 username으로 시작해야 함.
- 콘솔 **CloudShell**은 로그인 세션 자격증명을 자동으로 쓰므로 Access Key 없이 CLI 사용 가능.

**남아 있는 아키텍처 함정**
- **`services/history.js`에는 변환 계층이 아예 없다.** 저장 형식이 곧 Gemini 와이어
  포맷(`{role, parts:[{text}]}`)이고 SDK의 `startChat({history})`로 **그대로** 들어간다.
  다른 LLM으로 갈아탈 일이 생기면 변환 계층을 새로 만들어야 한다. 덤으로 model 턴 인코딩이
  두 가지로 섞여 있다 — 실시간 대화는 `JSON.stringify({text,emotion})`, 재시작 복원은 평문.

---

## RDS 운영 메모

2026-08-31에 EC2까지 PostgreSQL로 전환 완료. `DB_DRIVER=sqlite`로 되돌리면 즉시
파일 DB로 복귀한다 (EC2의 `data/hyodol.sqlite`는 백업으로 남겨 뒀다).

**팀원과 같은 `silvercare` DB를 쓴다.** 우리 7개 테이블이 팀원 테이블
(`emergency_records`/`emotion_records`/`medication_records`) 옆에 있다. 지금은 이름이
겹치지 않지만 **양쪽이 테이블을 추가할 때 충돌할 수 있다.**

**네트워크 구성**(실측) — EC2·RDS·팀원 EC2가 전부 같은 기본 VPC 안에 있다. 그래서 EC2는
RDS를 **사설 IP로** 해석하고 소스도 사설 IP가 된다. 공인 IP로 인바운드를 열어도 EC2
경로에는 적용되지 않으므로 **보안 그룹 참조(source-group)로 열어야 한다.** 개발 PC는
VPC 밖이라 공인 IP(`/32`)로 열려 있고, **공인 IP가 바뀌면 다시 막힌다** — 그때는
`https://checkip.amazonaws.com`으로 새 IP를 확인해 RDS 보안 그룹에 넣는다.

**로컬 `.env`도 pg를 본다.** 로컬에서 본 것이 곧 보호자 앱에 보이는 것이라 편하지만,
로컬 대화 테스트 데이터가 실제 RDS에 쌓인다는 뜻이기도 하다.

**테스트는 `.env`와 무관하게 항상 SQLite로 돈다** — 각 테스트 파일이 `DB_DRIVER='sqlite'`를
직접 고정한다. 이 핀을 빼면 `retention.test.js`가 실제 RDS의 메시지를 지운다.

**⚠️ `verify-rds`를 반드시 돌려야 하는 이유** — `pg-driver.test.js`는 pg-mem으로 도는데,
**변이 테스트로 확인한 결과** 아래 둘은 코드를 망가뜨려도 통과해 버린다:

| | 왜 안 잡히나 |
|---|---|
| 트랜잭션 **롤백** | pg-mem의 `pool.connect()`가 격리 세션이 아니라 BEGIN/ROLLBACK이 no-op |
| **COUNT/id 타입** | 진짜 node-pg는 int8(COUNT·BIGINT)을 **문자열**로 주는데 pg-mem은 늘 숫자 |

둘 다 실제 RDS에서 통과하는 것을 확인했다(로컬·EC2 양쪽). 드라이버를 건드리면 다시 돌릴 것.

## 운영 메모

**인스턴스를 껐다 켤 때마다** — 새 퍼블릭 IP로 한 줄만 돌리면 `ACCESS.html`(gitignore)에
파이용/폰용 링크와 QR이 갱신된다. `reboot`은 IP가 유지되지만 **stop/start는 바뀐다.**

```bash
npm run access -- <새 퍼블릭 IP>     # 끌 때는: npm run access -- --stopped
```

**배포된 앱의 알려진 한계 3가지** — 전부 `docs/deploy-ec2-production.md`의 "알려진 한계"에
상세가 있다. 요약만:
1. **quick tunnel은 SSE를 통과시키지 못한다**(실측, 코드로 못 고침). 응급 푸시는 FCM
   직통이라 무사하고, 보호자 앱은 30초 폴백 폴링으로 동작한다.
2. **터널 주소가 재시작마다 바뀐다** → 브라우저 기준 다른 사이트라 **푸시 구독을 다시 해야
   한다.** 고정 주소 + 실시간이 동시에 필요해지면 도메인 + Let's Encrypt 직결.
3. `ROBOT_API_KEY`는 진짜 인증이 아니다 → 백로그의 "보호자 로그인" 항목.

**인스턴스 크기**: `t3.small`(1.9Gi)면 충분하다(실측 — `npm install` ×2 + 프론트 빌드 +
백엔드 상시 기동에 여유 1.1Gi 이상). `t3.nano`(512MB)는 `@aws-sdk/client-s3` 설치에서
OOM 위험이 있어 권하지 않는다. 24시간 가동 시 월 $15 안팎.

**로컬에서 HTTPS로 폰 테스트할 때** — `npm run dev`가 아니라 **preview를 터널링**해야 한다.
서비스 워커는 `main.jsx`의 `import.meta.env.PROD` 가드 때문에 프로덕션 빌드에서만 등록된다.

```bash
cd frontend && npm run build && npm run preview        # 4173
C:\Users\fredh\bin\cloudflared-windows-amd64.exe tunnel --url http://localhost:4173
```

preview가 `/api`를 3001로 프록시하므로 터널은 하나면 된다.

---

## 백로그

로드맵에 안 들어갔지만 언젠가 해야 할 것들. 발견 시점과 이유를 함께 적는다.

- [ ] **미처리 `move` 명령이 쌓인다** (2026-08-31, 키오스크를 관찰자로 바꾸면서 생김).
      예전에는 키오스크가 `move`를 ack했지만 이제 하지 않는다(구동부 프로세스가 유일한
      소비자여야 하므로). 그 프로세스가 없는 동안 D-패드를 누를 때마다 `outbound_commands`에
      미처리 행이 하나씩 남는다. 응급 알림이 뜨면 `dropPending('move')`가 한 번에 비우지만
      평상시에는 계속 쌓인다. **구동부 소비자를 만들면 자연히 해소된다** — 그때까지도 문제가
      되면 오래된 미처리 `move`를 정리하는 쪽을 검토할 것(양이 적어 급하지 않다).
- [ ] **detector용 presigned 업로드** (2026-08-30). YOLOv8 detector가 낙상 스냅샷을 보낼 때
      지금 계약(`POST /api/detections`의 base64 data URI)은 12MB JSON 바디를 Express로
      통과시킨다. 팀원 `app/s3_service.py`의 presigned PUT 방식이 이 경우엔 더 낫다
      (`incoming/{category}/{YYYY}/{MM}/{DD}/{uuid}.{ext}` 키 규칙까지 쓸 만하다).
      **보호자 앱 경로에는 쓰지 말 것** — `/api/snapshots/:filename` 프록시 서빙은 LAN 키
      인증이 안 깨지게 일부러 그렇게 만든 것이다.
- [ ] **보호자 로그인(제대로 된 인증)** — 2026-08-29 EC2 상시 배포로 **위험도가 올라갔다.**
      `ROBOT_API_KEY`는 클라이언트 번들에 들어가므로 진짜 인증이 아니다. 시연·발표용으로
      수용한 상태이며 실사용 전에는 세션/JWT 기반 로그인이 필요하다.
- [ ] **팀원과 테이블 이름이 충돌할 위험** (2026-08-31, RDS 전환하며 생김). 같은
      `silvercare` DB를 쓰게 됐다. 지금은 안 겹치지만(우리 `medications` vs 팀원
      `medication_records`) 양쪽이 테이블을 추가하면 언제든 겹친다. `initDB()`가
      `CREATE TABLE IF NOT EXISTS`를 돌리므로 **먼저 만든 쪽 스키마가 조용히 이긴다.**
      PostgreSQL 스키마 분리(`hyodol.` 접두)를 검토할 것.
- [ ] **EC2의 `data/hyodol.sqlite` 정리** (2026-08-31). RDS 전환 후 백업으로 남겨 뒀다.
      한동안 문제없이 도는 것을 확인하면 지운다. 지금 지우면 되돌릴 곳이 없어진다.
- [ ] `purge-old-messages` 정기 실행 등록 (지금은 수동, 스케줄 없음).
      삭제 범위는 확인했다(2026-08-31) — `repositories/messages.js`의
      `DELETE FROM messages` 하나뿐이라 **팀원 테이블에 닿지 않는다.**
- [ ] 목소리 품질을 급히 올려야 하면 Cloud TTS 전환 — `TTS_PROVIDER=cloud` +
      `npm run prewarm-tts`. 콘솔에서 API 활성화 1회 필요.
      (Polly는 계정에서 불가능하므로 이게 유일한 업그레이드 경로다)

**하지 말 것**
- ⛔ **팀원 `requirements.txt`를 그대로 설치하지 말 것** (2026-08-30). 오염된 venv의
  `pip freeze`라 FastAPI와 무관한 `agent-detector==1.1.0`, `detect-installer==0.1.0`,
  `fastar==0.12.0`이 섞여 있다. `detector/` venv를 만들 때도 재사용하지 말고
  fastapi/uvicorn/ultralytics만 직접 명시할 것.

---

## 완료 요약

상세는 `git log`와 각 문서에 있다. 여기엔 **날짜와 한 줄**만 남긴다.

| 날짜 | 항목 | 상세 위치 |
|---|---|---|
| 08-31 | **파이 연동 사전 준비** — 키오스크가 실패를 화면에 드러내도록 하드닝(보안 컨텍스트·STT 오류 분류·발화 워치독·SW 경로), `move` ack 충돌 해소, `deploy/pi/` 자산. 테스트 백엔드 99→100 / 프론트 43→52 | `docs/deploy-raspberry-pi.md` |
| 08-31 | **RDS 실연결 + EC2 전환 완료** — 보안 그룹(VPC 내부는 source-group), `silvercare` DB로 108건 이관, EC2 배포까지. `verify-rds` 6개 항목 로컬·EC2 양쪽 통과 | 위 "RDS 운영 메모" |
| 08-31 | **감정 이력** — 표정이 바뀔 때만 `detections`에 기록. 보호자 홈이 로봇 발화가 아니라 어르신 표정을 근거로 말한다. 테스트 백엔드 96→99 / 프론트 39→43 | `git log` |
| 08-31 | **백로그 4건** — 스냅샷 `Content-Type`, 감지 응답의 `suppressedBy`(쿨다운/임계값 구분), 푸시 구독 origin 정리, 보호자 앱 오프라인 안내 기준 변경 | `fix/backlog` 브랜치 |
| 08-31 | **테스트 보강** — `useGuardianData`(SSE 정체/폴백), `RobotFaceDisplay`(웨이크워드 게이트 배선). 백엔드 95→96 / 프론트 29→39 | `frontend/CLAUDE.md` |
| 08-31 | 테스트가 `.env`의 `DB_DRIVER`를 따라가 실제 RDS를 지울 수 있던 결함 수정 / 이관 스크립트가 옛 SQLite에서 실패하던 문제 수정 | 아래 "살아남은 교훈" |
| 08-30 | **RDS PostgreSQL 이전** — `DB_DRIVER=sqlite\|pg` 드라이버, `schema.pg.sql`, 이관/검증 스크립트, `emergency` 트랜잭션화. 테스트 75→95 | `backend/CLAUDE.md`, 위 "RDS 운영 메모" |
| 08-30 | **복약 관리** — 팀원 코드에서 복약만 흡수. 로봇 알림 + 음성 복용 확인. 테스트 백엔드 54→75 / 프론트 22→29 | 아래 "살아남은 교훈" |
| 08-29 | 접속 주소 파일(`ACCESS.html`) + `npm run access` 갱신 스크립트 | 위 운영 메모 |
| 08-29 | 푸시 구독 재등록 버그 수정 (`ensurePushRegistered()`) | 아래 "살아남은 교훈" |
| 08-29 | **EC2 상시 배포** — `PUBLIC_DIR` 같은 오리진 서빙 + cloudflared + systemd | `docs/deploy-ec2-production.md` |
| 08-29 | **S3 스냅샷 실연결 검증** — 버킷 `project9-80-oregon-hyodol-snapshots`(`us-west-2`) | `docs/deploy-ec2-aws-test.md` |
| 08-29 | 프론트엔드 테스트 환경(Vitest + jsdom/RTL) 도입 | `frontend/CLAUDE.md` |
| 08-29 | 리포지토리 전면 async 전환 (RDS 선행 작업) + `/review` 발견 5건 수정 | `git log` |
| 08-29 | INVESTIGATE 2건 — SSE 정체 감지(named heartbeat), 스냅샷 provider 접두어 | `git log` |
| 08-28 | 알림 상세 화면 + 푸시 딥링크 / `/ship` 커버리지 감사 + 안정성 수정 | `git log` |
| 08-27 | Phase 5(응급 푸시), Phase 7(원격조종), 코드리뷰 5건, 정리 라운드 | `git log` |
| 08-27 | Bedrock 어댑터 구현 → 계정 미지원 확인 → 전면 제거 | 위 "프로젝트 제약" |
| 08-26 | Phase 0~4 (기반 재설계·대화 안정화·응급 감지·대화 로그·보호자 PWA) | 계획서 |

### 살아남은 교훈 — 다시 겪지 않기 위해

- **"어댑터만 갈면 된다"는 세 번 중 한 번만 맞았다.** S3는 정말 `.env` 세 줄로 끝났지만,
  Bedrock은 계정의 explicit deny에 막혔고(스키마 CHECK 제약까지는 어댑터가 못 덮는다),
  pg는 리포지토리 40곳 + 트랜잭션 구조 변경이었다. 추정 전에 호출 지점부터 세어 볼 것.
- **로컬에서 절대 못 찾는 버그가 있다.** 푸시 구독 재등록 버그는 EC2에서 DB가 새로
  시작해야만 재현됐다(폰은 "허용됨"인데 서버엔 구독 0건 → 배너가 안 떠서 재등록 경로가
  없음). 배포 환경에서만 드러나는 상태 차이를 의심할 것.
- **테스트는 일부러 깨뜨려 보고 믿는다.** 이 프로젝트의 관례다. 실제로 복약·드라이버
  작업에서 "통과하지만 아무것도 증명하지 않는" 단언을 이 방법으로 두 번 찾아냈다
  (pg-mem이 COUNT/id 타입을 정규화해 버리는 문제 — 위 "RDS 운영 메모"의 표 참고).
- **알림 경로는 하나여야 한다.** 팀원 `emergency_records`를 합치지 않은 이유이고,
  복약 미복용도 `raise()`를 거치게 한 이유다. `warning`으로만 올리는 것도 같은 맥락 —
  약 한 번 걸렀다고 푸시를 보내면 보호자가 알림을 꺼버린다(CLAUDE.md 규칙 5).
- **계획 때 배제한 이유를 새 후보에도 적용할 것.** API Gateway를 "SSE가 깨져서" 배제해
  놓고 cloudflared는 확인하지 않아 같은 함정에 빠졌다.
- **환경 설정이 테스트로 샌다.** `.env`에 `DB_DRIVER=pg`를 넣는 순간 통합 테스트가 실제
  RDS를 치게 돼 있었다 — `retention.test.js`는 메시지를 **삭제**한다. 테스트가 무엇을
  덮어쓰는지(`DB_PATH`)만 보고 무엇을 **안 덮어쓰는지**(`DB_DRIVER`)는 안 본 탓이다.
  격리는 "덮어쓴 목록"이 아니라 "설정이 흘러들어올 수 있는 경로" 기준으로 확인할 것.
- **배포 환경의 코드 버전부터 확인할 것.** EC2가 `main`보다 14커밋 뒤에 있어서 "`.env`
  두 줄 추가"라고 계획했던 일이 실제로는 pull + 의존성 설치 + 프론트 재빌드였다.
  설정 변경이라고 가정하기 전에 거기서 도는 커밋을 먼저 볼 것.
- **같은 VPC 안에서는 공인 IP 규칙이 소용없다.** EC2가 RDS를 사설 IP로 해석하므로 소스도
  사설 IP가 된다. 증상이 연결 거부가 아니라 **타임아웃**이라 원인을 찾는 데 시간이 걸렸다.
