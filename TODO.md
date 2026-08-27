# TODO

효돌이 프로젝트 작업 목록. Claude Code가 이 파일을 읽고 다음 작업을 이어간다.

**사용법**
- 작업 시작: "TODO.md 읽고 첫 번째 항목부터 시작해"
- 세션 종료: "TODO.md 업데이트해줘"

전체 아키텍처와 각 단계의 배경은 계획서를 참고할 것:
`C:\Users\fredh\.claude\plans\modular-rolling-wozniak.md`

---

## AWS에 대하여 — 시작 전에 반드시 읽을 것

**대회(한이음 드림업) 제공 계정으로 할 수 있는 것과 없는 것** (2026-08-27 실측 확정):

| 가능 | 불가능 |
|---|---|
| EC2, Lambda, RDS, DynamoDB, S3, API GW, Amplify, SQS, SNS | **Bedrock, Polly, Transcribe 등 클라우드 AI 전부** |

→ **AI는 Gemini API를 계속 쓴다.** 대화·비전·음성을 AWS로 옮기는 계획은 세우지 말 것.

**계정 공통 제약**
- **Access Key 발급 절대 불가.** 인증은 IAM Role만 — EC2는 `SafeInstanceProfile-{username}`,
  그 외(Lambda 등)는 `SafeRole-{username}`. IAM Role은 AWS 인프라 안에서 도는 프로세스에만
  붙으므로 **로컬에서는 어떤 AWS 서비스도 인증 테스트가 불가능**하다. 검증은 EC2에서만.
- MFA 설정 후 재로그인해야 자원 생성 가능(`DenyAllWithoutMFA`).
- 지정 리전 밖에서는 모든 활동 제한 — **문제 생기면 리전부터 확인**. 본인이 만든 리소스만
  중지/시작/삭제 가능.
- EC2는 `t3.nano`~`t3.small`만. S3 버킷 이름은 본인 username으로 시작해야 함.
- RDS는 MySQL/PostgreSQL + Free Tier만, 샌드박스 생성 시 EC2 연결 불가·퍼블릭 액세스 허용.
- 콘솔 **CloudShell**은 로그인 세션 자격증명을 자동으로 쓰므로 Access Key 없이 CLI 사용 가능
  — 사전 확인은 여기서 하는 게 가장 싸다.

**남아 있는 아키텍처 함정** (AWS와 별개로 유효)
1. **`services/history.js`에는 변환 계층이 아예 없다.** 저장 형식이 곧 Gemini 와이어
   포맷이다(`{role:'user'|'model', parts:[{text}]}`). `history.get()`이 Gemini SDK의
   `startChat({history})`로 **그대로** 들어간다. 다른 LLM provider로 갈아탈 일이 생기면
   변환 계층을 새로 만들어야 한다. 덤으로 model 턴 인코딩이 두 가지로 섞여 있다 —
   실시간 대화는 `JSON.stringify({text,emotion})`을 저장하는데 재시작 복원은 평문을 넣는다.
2. **RDS 전환은 어댑터 교체가 아니라 전면 async 리팩터링이다.** `node:sqlite`의
   `DatabaseSync`는 **동기**라서 `repositories/*.js`가 전부 동기 함수고, 그 위의
   `emergency.raise()`도 동기다(Phase 5에서 푸시를 fire-and-forget으로 붙인 이유가 이것).
   `pg`는 비동기라 **모든 리포지토리와 호출자에 async가 번져 나간다.**

### 취소됨 — Phase 6(Bedrock) / Phase 8(Polly·Transcribe)

Bedrock 어댑터까지 실제로 만들어 테스트했으나, 계정이 Bedrock을 지원하지 않는다는 것이
확정되어 **전부 제거했다**(2026-08-27, 상세는 git log). 안내 문서엔 사용 가능하다고
적혀 있었지만 `BedrockDeny` 명시적 거부 정책이 걸려 있었고, explicit deny는 EC2 IAM
Role을 거쳐도 우회 불가다. "어댑터만 갈면 된다"는 가정이 스키마 CHECK 제약까지는
커버하지 못한다는 것도 확인했다(`messages.source`) — RDS 이전 때 참고할 것.

---

## 지금 할 것 — 원격조종 마무리 + 안전 로직 테스트

Phase 7(원격조종)이 마지막으로 붙인 기능인데 미해결 항목이 남아 있다. 특히
`services/motion.js`는 **데드맨 타이머·응급 잠금 같은 안전 로직인데 테스트가 하나도 없다**
(지금까지 curl 수동 검증만 했음). 데모에서 심사위원이 직접 눌러보는 화면이기도 하다.

- [x] `services/motion.js` + `routes/control.js` 테스트 신설 ✅ 2026-08-27 —
      데드맨 자동정지, 응급 중 423 잠금, 잘못된 방향 400, `durationMs`가 데드맨보다
      길 때의 동작(회귀) 4가지 모두 커버 (`test/motion.test.js`, `test/control.test.js`)
- [x] `ControlScreen.jsx` 가상 위치 dot을 220×220 평면도 안으로 클램핑 ✅ 2026-08-27
- [x] `ControlScreen.jsx` D-패드 요청 진행 중 중복 요청 방지 ✅ 2026-08-27 —
      `moving` 상태로 버튼 비활성화 + 응답 전 재클릭 무시
- [x] `services/motion.js`의 자체 `nowISO()` → `db/index.js`의 공용 함수로 교체 ✅ 2026-08-27
- [ ] 네트워크 지연/단절 시 동작 미정 — 500ms 데드맨보다 명령 전송이 늦어지면 로봇이
      끊겨 이동하거나 정지 요청이 유실될 수 있음. 실물 배포 전 정책 필요

---

## 그다음 — 정리 라운드 (작고 확실한 것들)

- [ ] 구버전 호환 라우트 제거 — `GET /api/history`(`routes/alerts.js`),
      `POST /remote-message`·`GET /remote-message/poll`(`routes/commands.js`).
      키오스크가 Phase 7에서 이미 새 엔드포인트로 옮겨갔다
- [ ] `backend/database.json` 삭제 (SQLite 이관 완료됨)
- [ ] PLAUSIBLE 2건 재검증 — 아래 "코드 리뷰 발견 사항" 참고
- [ ] `lucide-react` 쓰거나 제거 (설치돼 있으나 import 0건)
- [ ] 미사용 CSS 토큰 정리 (`--bg-secondary`, `--shadow-premium` 등)
- [ ] `--primary: #5c64ec`인데 실제 CSS는 `rgba(99,102,241,…)`를 쓰는 불일치

---

## 그다음 — 큰 것들

- [ ] **YOLOv8 낙상 감지 실제 구현** — 백엔드 계약(`POST /api/detections`)과 mock은 이미
      완성돼 있다. `detector/` 디렉터리에 Python(FastAPI) 서비스를 만들어 계약대로
      POST만 하면 되고 **백엔드 변경은 불필요**하다. `docs/fall-detection.md` 참고
      - [ ] 카메라 → detector 데이터 흐름 설계 필요 (RTSP/HTTP 스트리밍/파일 감시 중
            방식 미정, 낙상 스냅샷을 `POST /api/detections`로 보낼 인코딩도 미정)
- [ ] **라즈베리파이 5 실물 배포** — kiosk 모드, systemd, 카메라/마이크 연결
      - [ ] 와이파이가 동아리방 SSID로만 등록돼 있어 다른 장소(기숙사 등) 이동 시 연결
            끊김. 실물 파이가 생기면: NetworkManager에 여러 SSID 등록(우선순위 설정) +
            대회장 등 미지의 장소 대비 스마트폰 핫스팟(고정 SSID/비번)도 등록
      - [ ] YOLOv8을 파이5에서 CPU로 돌릴 때 가속(ONNX Runtime/OpenVINO) 여부와
            목표 FPS 미정
      - [ ] 파이 ↔ 백엔드(EC2 이전 시) ↔ 보호자 앱 간 네트워크 구성 미정
            (퍼블릭 도메인 vs 로컬 터널 유지 여부)
- [ ] 프론트엔드 컴포넌트 테스트 환경(jsdom/RTL) 도입

---

## 마지막 — AWS (EC2 / S3 / RDS만)

"대회에서 AWS를 실제로 썼다"를 보여주는 용도. 제품 기능이 정리된 뒤에 착수.
전체 절차는 `docs/deploy-ec2-aws-test.md`.

### S3 스냅샷 — 코드 완료 ✅ 2026-08-27, 실제 연결 검증만 남음
"`services/snapshots.js` 하나만 바꾸면 된다"는 처음 예상은 **정확히는 아니었다** —
`save()`가 네트워크 I/O로 async가 되면서 호출부(`routes/vision.js` 2곳, `routes/alerts.js`
1곳)에 `await`를 추가해야 했다. `GET /snapshots/:filename`의 스트리밍 로직도 새 `serve()`
함수로 `snapshots.js` 안으로 옮겨 라우트가 로컬/S3를 몰라도 되게 했다. 다행히
`emergency.raise()`는 `snapshots.js`를 직접 부르지 않고 계산된 `snapshotPath` 문자열만
받으므로, 아래 "리포지토리 async 전환"의 전제조건은 아니었다.
- [x] `local`/`s3` provider 스위치 (`SNAPSHOT_STORAGE` env), `@aws-sdk/client-s3` 추가
- [x] 프론트엔드 `assetUrl()`은 그대로 — 항상 `/api/snapshots/:filename` 프록시로 서빙해서
      S3 여부와 무관하게 LAN 키 인증이 안 깨지게 설계
- [x] `npm run verify-s3` 스모크 테스트 (로컬은 `SNAPSHOT_STORAGE=local` 왕복만 확인 —
      `s3` 모드는 스크립트 주석대로 로컬에서 Access Key 문제로 항상 실패하는 게 정상)
- [ ] 버킷 생성(이름은 username으로 시작) + EC2에서 `SNAPSHOT_STORAGE=s3`로 실제 확인

### EC2 배포
`t3.nano`~`t3.small`. 인스턴스 생성 **후 별도 단계**로 `SafeInstanceProfile-{username}`
연결 필요(생성 마법사 중엔 안 보일 수 있음), 보안 그룹도 새로 만들어야 하고 태그가 붙기까지
5~10초 지연이 있다. EC2로 가면 cloudflared 터널이 불필요해진다(도메인 + ACM으로 정식 HTTPS)
— 아래 터널 안내는 그때 걷어낸다.
`t3.nano`(512MB)/`t3.small`(2GB)에서 백엔드+스냅샷 처리를 같이 돌리면 메모리 부족
가능성이 있다 — 실사용 전 메모리 사용량 확인.

### RDS PostgreSQL — 가장 비쌈, 마지막
**[선행 필수] 리포지토리 async 전환**을 독립 작업으로 먼저 해야 한다. `repositories/*.js`
전부와 그 호출자가 async가 되고, `emergency.raise()`가 동기라는 전제가 깨지므로
**Phase 5의 푸시 호출부도 같이 손봐야 한다**. 그 뒤에 `node:sqlite` → `pg`,
스키마 이관 + 기존 데이터 마이그레이션.

---

**로컬에서 HTTPS로 폰 테스트가 필요할 때** (Phase 5에서 확립한 방법):
`npm run dev`가 아니라 **preview 서버를 터널링해야 한다** — 서비스 워커는 `main.jsx`의
`import.meta.env.PROD` 가드 때문에 프로덕션 빌드에서만 등록된다.
```
cd frontend && npm run build && npm run preview        # 4173
C:\Users\fredh\bin\cloudflared-windows-amd64.exe tunnel --url http://localhost:4173
```
preview가 `/api`를 3001로 프록시하므로 터널은 하나면 된다. quick tunnel은 실행할 때마다
주소가 바뀌고, 주소가 바뀌면 브라우저 기준 다른 사이트라 **푸시 구독을 다시 해야 한다.**

---

## 코드 리뷰 발견 사항 (2026-08-26 /code-review)

CONFIRMED 5건은 전부 수정 완료 — 완료 섹션의 "코드리뷰 CONFIRMED 5건 수정" 참고.

### 추정 (PLAUSIBLE — 단일 finder, 재검증 필요)
- [ ] `frontend/src/lib/useGuardianData.js:54` — 모든 SSE 이벤트(채팅 턴마다)가
      3개 엔드포인트 전체 재조회를 트리거하고, SSE가 정상 연결 중에도 30초 폴백
      폴링이 무조건 실행됨. 이벤트 페이로드로 로컬 상태만 갱신하도록 개선 검토.
      (EC2 t3.nano/small처럼 자원이 제한된 환경으로 옮기면 서버 부하로 이어질 수 있어
      우선순위가 올라갈 수 있음)
- [ ] `backend/src/services/gemini.js:166` — `analyzeImage()`가 `services/snapshots.js`의
      `parseDataUri()`를 재사용하지 않고 자체 정규식을 재구현, 두 정규식의 허용
      범위가 미묘하게 다름(빈 base64 페이로드 처리 차이). 하나로 통합 검토.

---

## 백로그 (위 로드맵에 안 들어간 것들)

- [ ] `purge-old-messages` 정기 실행 등록 (지금은 수동, 스케줄 없음)
- [ ] 목소리 품질을 급히 올려야 하면 Cloud TTS 전환 — `TTS_PROVIDER=cloud` +
      `npm run prewarm-tts`. 콘솔에서 API 활성화 1회 필요:
      https://console.cloud.google.com/apis/library/texttospeech.googleapis.com
      (Polly는 계정에서 불가능하므로 이게 유일한 업그레이드 경로다)
- [x] CLAUDE.md 구조 정리 — "Architecture notes"를 `docs/architecture.md`(Mermaid 다이어그램)로
      분리. `purge-old-messages` 커맨드 문서화 누락 수정.

---

## 완료

상세 변경 이력은 git log 참고 (`PR #1`, `e90616a`~`26b2124`가 main에 merge됨).

- Phase 0~4(기반 재설계·대화 안정화·응급 감지·대화 로그·보호자 PWA) ✅ 2026-08-26 —
  안드로이드 실기기 검증 완료.
- Phase 5 — 응급 푸시 알림 ✅ 2026-08-27. 안드로이드 실기기 검증 완료.
  남은 것: 알림 상세 화면(`/guardian/alerts/:id`) 없어 딥링크 불가, iOS 미검증.
- 코드리뷰 CONFIRMED 5건 수정 ✅ 2026-08-27 (쿨다운 severity 무시, 스냅샷 401, 다중 알림
  오재생, 웨이크워드 게이트 우회, 저장 실패 무음)
- Phase 7 — 원격조종 시뮬레이션 ✅ 2026-08-27. 남은 것은 "지금 할 것" 섹션 참고.
- Phase 7 code-review 수정 ✅ 2026-08-27 — 데드맨 타이머가 `durationMs`보다 먼저 끝나던
  버그. Low 4건은 "지금 할 것"으로 이동 완료.
- Bedrock 어댑터 구현 → 계정 미지원 확인 → 전면 제거 ✅ 2026-08-27 — 이유는 위
  "취소됨" 참고.
