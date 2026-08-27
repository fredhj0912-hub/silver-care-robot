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

Bedrock 어댑터(`services/bedrock.js`, `services/llm.js`, `history.js`의 변환 계층)를 실제로
만들어 테스트까지 마쳤으나, 계정이 Bedrock을 지원하지 않는다는 것이 확정되어 **전부
제거했다**(2026-08-27). 안내 문서엔 사용 가능하다고 적혀 있었지만 `BedrockDeny` 명시적
거부 정책이 걸려 있었고, explicit deny는 EC2 IAM Role을 거쳐도 우회 불가다.

**그 과정에서 남은 유용한 부산물**: `backend/.env.example`,
`docs/deploy-ec2-aws-test.md`(EC2 생성 절차), S3 스냅샷 provider 스위치, `verify-s3` 스크립트.
그리고 "어댑터만 갈면 된다"는 가정이 스키마 CHECK 제약까지는 커버하지 못한다는 것도
확인했다(`messages.source`) — RDS 이전 때 참고할 것.

---

## 지금 할 것 — 원격조종 마무리 + 안전 로직 테스트

Phase 7(원격조종)이 마지막으로 붙인 기능인데 미해결 항목이 남아 있다. 특히
`services/motion.js`는 **데드맨 타이머·응급 잠금 같은 안전 로직인데 테스트가 하나도 없다**
(지금까지 curl 수동 검증만 했음). 데모에서 심사위원이 직접 눌러보는 화면이기도 하다.

- [ ] `services/motion.js` + `routes/control.js` 테스트 신설 — 데드맨 자동정지,
      응급 중 423 잠금, 잘못된 방향 400, `durationMs`가 데드맨보다 길 때의 동작
- [ ] `ControlScreen.jsx` 가상 위치 dot을 220×220 평면도 안으로 클램핑
      (연타 시 화면 밖으로 나감)
- [ ] `ControlScreen.jsx` D-패드 요청 진행 중 중복 요청 방지 — 응답 순서가 꼬이면
      위치 표시가 튄다
- [ ] `services/motion.js`의 자체 `nowISO()` → `db/index.js`의 공용 함수로 교체
      (backend/CLAUDE.md 규칙)

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
- [ ] **라즈베리파이 5 실물 배포** — kiosk 모드, systemd, 카메라/마이크 연결
      - [ ] 와이파이가 동아리방 SSID로만 등록돼 있어 다른 장소(기숙사 등) 이동 시 연결
            끊김. 실물 파이가 생기면: NetworkManager에 여러 SSID 등록(우선순위 설정) +
            대회장 등 미지의 장소 대비 스마트폰 핫스팟(고정 SSID/비번)도 등록
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
- [x] `npm run verify-s3` 스모크 테스트
- [ ] 버킷 생성(이름은 username으로 시작) + EC2에서 `SNAPSHOT_STORAGE=s3`로 실제 확인

### EC2 배포
`t3.nano`~`t3.small`. 인스턴스 생성 **후 별도 단계**로 `SafeInstanceProfile-{username}`
연결 필요(생성 마법사 중엔 안 보일 수 있음), 보안 그룹도 새로 만들어야 하고 태그가 붙기까지
5~10초 지연이 있다. EC2로 가면 cloudflared 터널이 불필요해진다(도메인 + ACM으로 정식 HTTPS)
— 아래 터널 안내는 그때 걷어낸다.

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

### Phase 0 — 기반 재설계 ✅ 2026-08-26
- [x] Gemini 실사용 여부 실측 → 정상 동작 확인, SDK 마이그레이션 불필요했음
- [x] `gemini-3.7-flash` 503 다발 → `gemini-3.6-flash` 기본값 + 재시도/대체 모델 체인
- [x] SQLite 전환 (`node:sqlite`, 네이티브 빌드 없음). 대화 53건 / 알림 22건 이관
- [x] `server.js` 575줄 → 진입점 + `src/` 22개 모듈로 분리
- [x] SSE 이벤트 채널 신설 (`GET /api/events`)
- [x] 파괴적 GET 폴링 제거 → 조회/ack 분리
- [x] 응급 키워드 오탐 수정 ('숨' 단독 매칭이 "한숨"에 걸리던 문제)
- [x] 스냅샷 base64 100자 절단 버그 수정 → 파일 저장

### Phase 1 — 대화 안정화 + 웨이크워드 + 서버 TTS ✅ 2026-08-26
- [x] 히스토리 슬라이딩 윈도우 버그 수정 (턴 쌍 단위 절단)
- [x] 웨이크워드 게이팅 — "효돌아" + 오인식 변형 24개, **응급어는 게이트 우회**
- [x] STT 어댑터 분리 (`lib/stt.js`) — 나중에 Cloud STT로 교체 가능
- [x] 서버 TTS 3-provider 구조 + 디스크 캐시 (4221ms → 8ms)

### Phase 2 — 응급 감지 파이프라인 ✅ 2026-08-26
- [x] 카메라 캡처 연결 (`useCameraMonitor.js`) — 기본 비활성, 옵트인
- [x] `docs/fall-detection.md` 인수인계 문서

### Phase 3 — 대화 로그 조회 ✅ 2026-08-26
- [x] 보관 정책 스크립트 (`purge-old-messages.js`, 90일)
- [x] 일일 요약 시간대 버그 수정 (UTC 자정 → KST 자정)
- [x] 일일 요약 과거 날짜 조회 버그 수정 (200건 초과 시 0건 반환하던 문제)

### Phase 4 — 보호자 PWA ✅ 2026-08-26
- [x] react-router 도입, 한 빌드에 키오스크 + 보호자 앱
- [x] 5개 화면: 안부(홈) / 알림 / 대화 / 보내기 / 방 안 모습
- [x] 홈을 대시보드가 아닌 "효돌이가 남긴 안부 쪽지"로 설계
- [x] 응급 시 화면 전체 상태 전환
- [x] PWA 매니페스트 + 서비스 워커 (`/api/*`는 캐시하지 않음)
- [x] 키오스크 전용 전역 CSS를 `.kiosk-root`로 스코핑
- [x] **안드로이드 실기기 검증 완료** — SSE 실시간 전환, 확인 버튼 왕복, PWA 설치
- [x] 실기기에서 발견: 대화 로그가 최신 메시지에서 열리지 않던 문제 수정

### Phase 5 — 응급 푸시 알림 ✅ 2026-08-27
- [x] **표준 Web Push(VAPID)로 결정** — AWS SNS Mobile Push를 검토했으나, 보호자 앱이
      네이티브가 아니라 PWA라 SNS를 쓰려면 Firebase(FCM)를 반드시 경유해야 한다.
      결과물은 같은데 설정 레이어만 늘어난다. AWS 자원은 Bedrock/Polly/Transcribe/S3에 쓴다.
- [x] `services/notify.js` — `raise()`가 **critical일 때만** fire-and-forget 호출.
      만료 구독(404/410) 자동 정리, 발송 결과를 반드시 로그로 남긴다
      (`[PUSH] n/m대 발송 완료` 또는 실패 사유) — 조용한 실패가 이 시스템에서 가장 위험하다
- [x] `routes/push.js` — subscribe/unsubscribe. `repositories/subscriptions.js`는
      이미 있었지만 어디에도 연결돼 있지 않던 것을 그대로 재사용
- [x] `public/sw.js` — `push` + `notificationclick` 핸들러
- [x] `lib/push.js` + HomeScreen 권한 요청 배너 (iOS 설치 안내 포함)
- [x] cloudflared quick tunnel로 HTTPS 확보 (AWS 계정에 도메인이 없어 ACM 불가)
- [x] **안드로이드 실기기 검증 완료** — 낙상 감지 → 잠금화면 푸시 수신 → 클릭 →
      앱 진입 → "확인했어요" → 비상 상태 자동 해제까지 왕복 전부 확인

**남은 것**: 푸시 클릭 시 `/guardian/alerts`(목록)로 간다. 개별 알림 상세 화면
(`/guardian/alerts/:id`)이 없어서 딥링크를 걸 수 없었다 — 필요하면 별도 작업.
iOS는 홈 화면에 설치한 PWA에서만 푸시가 동작 (미검증, 안드로이드만 확인함).

### 코드리뷰 CONFIRMED 5건 수정 ✅ 2026-08-27
- [x] `alerts.js` 쿨다운이 severity를 무시 → `hasRecentOfType()`에 severity 인자 추가,
      severity별로 쿨다운 창 분리 (warning이 critical을 억제하던 문제)
- [x] 스냅샷 `<img>`가 인증 없이 요청돼 `ROBOT_API_KEY` 설정 시 401 →
      `lib/api.js`에 `assetUrl()` 헬퍼 추가(`?key=` 부착), 두 화면에 적용
- [x] `resolveActiveAlert()`가 다중 알림 시 안심 TTS 오재생 → deprecated `/api/history`
      대신 `/api/alerts?resolved=false` 사용, 서버가 준 실제 `isEmergency`로만 판단
- [x] `handleTextSubmit`이 웨이크워드 게이트 우회 → `decideAction()` 경유하도록 수정
- [x] 스냅샷 저장 실패(8MB 초과 등)가 로그 없이 조용히 넘어가던 문제 → `console.error` 추가

### Phase 7 — 원격조종 시뮬레이션 ✅ 2026-08-27
- [x] `backend/src/services/motion.js` — `move()`/`stop()`/`getState()`,
      500ms 데드맨 스위치 (명령 갱신 없으면 자동 정지)
- [x] `backend/src/routes/control.js` — `POST /api/control/move`(응급 중 423 잠금),
      `GET /api/control/state`
- [x] `emergency.js` — 응급 진입 시 밀린 move 명령 폐기(`dropPending('move')`) + `motion.stop()`
- [x] 키오스크: deprecated `/api/remote-message/poll` 폴링 → `/api/commands/pending` + ack로
      교체(`speak`/`move` 둘 다 처리), 이동 방향 인디케이터 표시.
      **PLAUSIBLE 발견사항 1건(SSE 있는데 deprecated 폴링 씀)도 같이 해결됨**
- [x] 보호자 앱 `/guardian/control` 신설 — D-패드 + 가상 평면도, 홈 화면에 진입 타일 추가
- [x] curl로 수동 검증: 이동/좌표 갱신, 잘못된 방향 400, 데드맨 자동정지, 응급 중 423 잠금

**남은 것**: 실물 구동부 연결(라즈베리파이 배포 라운드에서), D-패드는 클릭 단발만 지원
(누르고 있기/연속 이동 없음), 평면도 좌표는 가상 단위라 실제 방 치수와 무관.
`useGuardianData.js`의 SSE 이벤트마다 전체 재조회하는 문제(PLAUSIBLE)는 미해결로 남음.

### Phase 7 code-review (2026-08-27) — Medium 수정, Low는 백로그로 이동 ✅
- [x] `motion.js` — 데드맨 타이머(500ms)가 요청한 `durationMs`(최대 3000ms)보다 먼저
      끝나 긴 이동이 도중에 끊기던 문제. `resetDeadman()`이 `max(DEADMAN_MS, durationMs)`로
      타이머를 잡도록 수정
- Low 4건은 "백로그 → 정리"로 이동 (아래 참고): `nowISO()` 중복 구현, control 라우트/motion
  서비스 테스트 부재, 가상 위치 dot 클램핑 누락, D-패드 연타 시 요청 중복

### PR #1 — main에 merge 완료 ✅ 2026-08-27
백엔드 모듈화 + SQLite + 보호자 PWA + 응급 푸시 알림 + 원격조종 시뮬레이션,
`e90616a`~`26b2124` 전체가 `main`에 반영됨.

### Bedrock 어댑터 구현 → 계정 미지원 확인 → 전면 제거 ✅ 2026-08-27
Bedrock 전환(Phase 6)을 코드까지 완성했으나 대회 계정이 Bedrock을 지원하지 않는 것이
확정되어 되돌렸다. 절대 실행되지 않는 죽은 코드를 남기지 않기 위한 결정.
- [x] 제거: `services/bedrock.js`, `services/llm.js`, `services/jsonUtil.js`,
      `scripts/verify-bedrock.js`, `scripts/migrate-add-bedrock-source.js`,
      `@aws-sdk/client-bedrock-runtime` 의존성
- [x] 되돌림: `parseJSON`을 `gemini.js` 안으로 복귀, `history.js`의 `toBedrockMessages()`
      제거, 라우트는 다시 `gemini`를 직접 호출, `schema.sql` CHECK 제약 원복
      (실제 DB엔 마이그레이션이 적용된 적 없어 데이터 작업 불필요했음)
- [x] 유지: `@aws-sdk/client-s3`와 S3 스냅샷 코드, `.env.example`,
      `docs/deploy-ec2-aws-test.md`(S3/EC2 전용으로 재작성)
- [x] `test/api.test.js`의 kill-switch를 `LLM_PROVIDER` → `SNAPSHOT_STORAGE='local'`로 교체
