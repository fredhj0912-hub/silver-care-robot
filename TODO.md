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

### 1순위 — 남은 백로그

**RDS 이전은 2026-08-31에 EC2 배포까지 끝났다** (아래 "RDS 운영 메모" 참고).
아래 "백로그" 섹션에 상세가 있다.

- [ ] 감정 이력을 남길 곳이 없다 (`detections`에 한 줄 기록하면 됨)
- [ ] `purge-old-messages` 정기 실행 등록
- [ ] 보호자 로그인(제대로 된 인증)

### 막혀 있음 — 실물 하드웨어가 있어야 함

- [ ] **YOLOv8 낙상 감지 실제 구현** — 백엔드 계약(`POST /api/detections`)과 mock은 이미
      완성돼 있어 **백엔드 변경은 불필요**하다. `detector/`에 Python(FastAPI) 서비스를 만들어
      계약대로 POST만 하면 된다. `docs/fall-detection.md` 참고.
      배포 골격은 팀원 레포의 `deploy/silvercare-api.service`(systemd)를 그대로 쓸 만하다.
      - [ ] 카메라 → detector 데이터 흐름 미정 (RTSP / HTTP 스트리밍 / 파일 감시)
      - [ ] 낙상 스냅샷 전송 인코딩 미정 (백로그의 presigned 업로드 항목 참고)
      - [ ] 파이5 CPU 추론 가속(ONNX Runtime/OpenVINO) 여부와 목표 FPS 미정
- [ ] **라즈베리파이 5 실물 배포** — kiosk 모드, systemd, 카메라/마이크 연결
      - [ ] **원격조종 네트워크 지연/단절 정책** (Phase 7 잔여) — 500ms 데드맨보다 명령
            전송이 늦어지면 로봇이 끊겨 이동하거나 정지 요청이 유실될 수 있다.
            시뮬레이션에선 안 드러나고 실물에서만 문제가 되므로 거기서 결정한다
      - [ ] 와이파이가 동아리방 SSID로만 등록돼 있어 이동 시 연결 끊김.
            NetworkManager에 여러 SSID(우선순위) + 대회장 대비 폰 핫스팟도 등록
      - [ ] 파이 ↔ 백엔드(EC2) ↔ 보호자 앱 네트워크 구성 미정
            (퍼블릭 도메인 vs 터널 유지)

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

- [ ] **감정 이력을 남길 곳이 없다** (2026-08-30, 팀원 코드 검토 중 확인). `routes/vision.js`가
      Gemini에서 `expression`/`confidence`를 받아 놓고 `robot_status.senior_expression`에
      **덮어쓰기만** 한다 — 시간에 따른 추이를 볼 방법이 없다. 팀원 레포엔 `emotion_records`
      테이블이 따로 있는데, 우리는 새 테이블 없이 기존 `detections`(`source`/`confidence`/
      `meta_json` 이미 있음)에 한 줄 기록하면 된다. 보호자 홈의 `emotionCounts`가 robot 발화
      emotion만 세고 있는 것도 이걸로 보강할 수 있다.
- [ ] **detector용 presigned 업로드** (2026-08-30). YOLOv8 detector가 낙상 스냅샷을 보낼 때
      지금 계약(`POST /api/detections`의 base64 data URI)은 12MB JSON 바디를 Express로
      통과시킨다. 팀원 `app/s3_service.py`의 presigned PUT 방식이 이 경우엔 더 낫다
      (`incoming/{category}/{YYYY}/{MM}/{DD}/{uuid}.{ext}` 키 규칙까지 쓸 만하다).
      **보호자 앱 경로에는 쓰지 말 것** — `/api/snapshots/:filename` 프록시 서빙은 LAN 키
      인증이 안 깨지게 일부러 그렇게 만든 것이다.
- [ ] **보호자 로그인(제대로 된 인증)** — 2026-08-29 EC2 상시 배포로 **위험도가 올라갔다.**
      `ROBOT_API_KEY`는 `VITE_ROBOT_API_KEY`로 프론트 번들에 평문으로 들어가므로, 이제는
      "터널 주소를 아는 사람만 쓴다" 수준이다. 주소를 아는 사람은 번들에서 키를 읽어
      SOS·카메라·원격조종 API를 부를 수 있다. 시연·발표용으로 수용한 상태이며 실사용
      전에는 세션/JWT 기반 로그인이 필요하다.
- [ ] `purge-old-messages` 정기 실행 등록 (지금은 수동, 스케줄 없음)
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
| 08-31 | **RDS 실연결 + EC2 전환 완료** — 보안 그룹(VPC 내부는 source-group), `silvercare` DB로 108건 이관, EC2 배포까지. `verify-rds` 6개 항목 로컬·EC2 양쪽 통과 | 위 "RDS 운영 메모" |
| 08-31 | **백로그 4건** — 스냅샷 `Content-Type`, 감지 응답의 `suppressedBy`(쿨다운/임계값 구분), 푸시 구독 origin 정리, 보호자 앱 오프라인 안내 기준 변경 | `fix/backlog` 브랜치 |
| 08-31 | **테스트 보강** — `useGuardianData`(SSE 정체/폴백), `RobotFaceDisplay`(웨이크워드 게이트 배선). 백엔드 95→96 / 프론트 29→39 | `frontend/CLAUDE.md` |
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
