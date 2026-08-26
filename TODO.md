# TODO

효돌이 프로젝트 작업 목록. Claude Code가 이 파일을 읽고 다음 작업을 이어간다.

**사용법**
- 작업 시작: "TODO.md 읽고 첫 번째 항목부터 시작해"
- 세션 종료: "TODO.md 업데이트해줘"

전체 아키텍처와 각 단계의 배경은 계획서를 참고할 것:
`C:\Users\fredh\.claude\plans\modular-rolling-wozniak.md`

---

## AWS 이전에 대하여 — 시작 전에 반드시 읽을 것

CLAUDE.md는 "`services/`·`repositories/` 분리가 되어 있어 대부분 어댑터 교체 수준"이라고
적고 있지만, **실측 결과 두 군데가 그 가정을 깬다.** 모르고 시작하면 견적이 크게 빗나간다.

1. **`services/history.js`에는 변환 계층이 아예 없다.** 저장 형식이 곧 Gemini 와이어
   포맷이다(`{role:'user'|'model', parts:[{text}]}`, `history.js:49`). `history.get()`이
   Gemini SDK의 `startChat({history})`로 **그대로** 들어간다(`gemini.js:125`).
   Bedrock/Claude는 `{role:'user'|'assistant', content:[...]}`라 **변환 계층을 새로 만들어야
   한다.** 덤으로 model 턴 인코딩이 두 가지로 섞여 있다 — 실시간 대화는
   `JSON.stringify({text,emotion})`을 저장하는데(`gemini.js:137`) 재시작 복원은 평문을
   넣는다(`history.js:62-70`).

2. **RDS 전환은 어댑터 교체가 아니라 전면 async 리팩터링이다.** `node:sqlite`의
   `DatabaseSync`는 **동기**라서 `repositories/*.js`가 전부 동기 함수고, 그 위의
   `emergency.raise()`도 동기다(Phase 5에서 푸시를 fire-and-forget으로 붙인 이유가 이것).
   `pg`는 비동기라 **모든 리포지토리와 호출자에 async가 번져 나간다.** 전체 이전에서
   가장 큰 숨은 비용이다.

**리전은 us-west-2(오레곤)**. Bedrock은 리전마다 쓸 수 있는 모델이 다르다.

---

## 지금 할 것 — Phase 6: Bedrock 전환 (대화 + 비전)

예산에서 가장 큰 항목(Bedrock 62,000원/월)을 실제로 쓰기 시작한다. 동시에 "어댑터만 갈면
된다"는 가정이 참인지 **가장 싼 단계에서 검증**된다 — 위 함정 1이 여기서 드러나므로,
더 큰 이전(RDS)에 들어가기 전에 실체를 알 수 있다.

**Gemini는 지우지 않고 폴백으로 남긴다.** 어르신이 기다리는 대화라 이중화가 의미 있고,
이미 재시도/대체모델 체인 패턴이 있다.

### 사전 작업 (사용자가 직접 — 대행 불가)
- [ ] AWS CLI 설치 후 `aws configure` (리전 `us-west-2`) — 자격증명 입력은 본인이 해야 함
- [ ] **Bedrock 콘솔에서 Claude 모델 액세스 신청** — 약관 동의가 필요해 대행할 수 없다.
      리전별·모델별로 따로 신청해야 한다
- [ ] 예산 알림 설정 (권장 — 안 걸어두면 초과를 청구서로 안다)

### 코드
- [ ] `@aws-sdk/client-bedrock-runtime` 추가 → `backend/src/services/bedrock.js` 신설
- [ ] **`gemini.js`와 동일한 시그니처 + 동일한 반환 shape**를 지킬 것. 호출부
      (`routes/chat.js`, `routes/vision.js`)를 안 고치는 게 목표:
      `chat()` → `{text, emotion, source, model, error}`
      `analyzeImage()` → `{hasPerson, isEmergency, expression, confidence, summary, source, error}`
- [ ] **`history.js`에 변환 계층 신설** (위 함정 1). model 턴 인코딩 불일치도 여기서 정리
- [ ] `LLM_PROVIDER` env로 provider 선택 + Bedrock 실패 시 Gemini 폴백.
      `tts.js`의 `PROVIDERS` 룩업 테이블 패턴을 그대로 따를 것
- [ ] `parseJSON`/`mockReply`는 provider 무관하니 재사용. 단 `gemini.js:29`의
      `isTransient()`는 **Google SDK 에러 문자열을 정규식으로 파싱**하므로 Bedrock 에러엔
      절대 안 걸린다 — 새로 써야 한다
- [ ] `RobotFaceDisplay.jsx:584` 개발용 뱃지가 `source === 'gemini'` 문자열 비교 → 수정
- [ ] `test/api.test.js:13`이 `GEMINI_API_KEY=''`로 mock 경로를 강제한다.
      **AWS 자격증명도 같이 막지 않으면 테스트가 실제 네트워크를 친다** — kill-switch 정비
- [ ] 참고: `routes/vision.js:49`는 `'vision_gemini'`를 **DB 컬럼 값**으로 기록한다.
      코드가 아니라 데이터라 과거 행은 그대로 남는다

---

## 다음 — Phase 7: 원격 조종 (시뮬레이션)

실물 구동부가 없으므로 명령 채널과 시각화를 먼저 만든다. 나중에 모터 드라이버만 갈아끼운다.

- [ ] `POST /api/control/move` — `{ direction, speed, durationMs }`,
      `outbound_commands`(kind=`move`)에 적재 후 SSE로 즉시 푸시
- [ ] **데드맨 스위치**: 마지막 명령 후 500ms 내 갱신이 없으면 자동 정지.
      원격 조종 로봇에서 이건 선택이 아니라 필수 안전장치다
- [ ] `backend/src/services/motion.js` — 인터페이스는 `move()`/`stop()`,
      현재 구현은 가상 좌표를 메모리에 유지하는 시뮬레이터
- [ ] `GET /api/control/state` — 시뮬레이션 좌표 노출
- [ ] 보호자 앱에 원격 조종 화면 (D-패드 + 가상 평면도)
- [ ] 키오스크 화면에 이동 방향 인디케이터 (로봇이 명령을 받았다는 시각 피드백)
- [ ] **응급 상황 중에는 원격 조종을 잠근다**

---

## Phase 8 — 음성 AWS 이전 (Polly / Transcribe)

TTS(Polly)는 작고, STT(Transcribe)는 크다. 한 덩어리로 보지 말 것.

### TTS → Polly (작음)
- [ ] `services/tts.js`에 `synthWithPolly` 추가 (`PROVIDERS` 테이블에 등록)
- [ ] `tts.js:111` `isEnabled()`가 `config.geminiApiKey`를 요구한다 →
      **이 조건 때문에 Polly provider가 그냥 꺼진다.** 자격증명 검사를 provider별로 분리
- [ ] `tts.js:125` 캐시 확장자가 `provider === 'cloud' ? 'mp3' : 'wav'` 하드코딩 →
      새 provider는 **캐시가 항상 미스**난다 (쓰기는 `result.ext`로 하는데 읽기는 ternary)
- [ ] `npm run prewarm-tts`로 공용 문구 재예열

### STT → Transcribe (큼 — 교체가 아니라 재구현)
- [ ] `frontend/src/lib/stt.js`는 **마이크 캡처를 직접 하지 않는다.** 브라우저 Web Speech
      API가 내부적으로 처리해준다. Transcribe로 가면 `getUserMedia` + PCM 인코딩 +
      웹소켓 스트리밍을 `createRecognizer` 안에 전부 새로 넣어야 한다
- [ ] **발화 종료 판정(endpointing)을 직접 구현해야 한다.** Web Speech API가 공짜로 주던
      `isFinal`에 대응물이 없다 — 이게 이 항목에서 가장 어려운 부분
- [ ] `RobotFaceDisplay.jsx`의 자기 소리 차단 게이트(`isSpeakingRef`/`shouldListenRef`)가
      그대로 동작해야 하고, `abort()`는 즉시 끊겨야 한다

---

## Phase 9 — 인프라 이전 (S3 / RDS / EC2)

쉬운 것부터. **S3 → RDS → EC2** 순서를 지킬 것.

- [ ] **S3 스냅샷** — `services/snapshots.js` 하나만 바꾸면 된다. 가장 쉽고 위험이 적다
- [ ] **[선행 필수] 리포지토리 async 전환** — RDS보다 먼저, 독립 작업으로.
      `repositories/*.js` 전부와 그 호출자가 async가 된다. `emergency.raise()`가 동기라는
      전제가 깨지므로 **Phase 5의 푸시 호출부도 같이 손봐야 한다**
- [ ] **RDS PostgreSQL** — `node:sqlite` → `pg`. 스키마 이관 + 기존 데이터 마이그레이션
- [ ] **EC2 배포** — t3.micro, systemd, 보안그룹
- [ ] EC2로 가면 cloudflared 터널이 불필요해진다 (도메인 + ACM으로 정식 HTTPS).
      아래 터널 안내는 그때 걷어낸다

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

### 확정 (CONFIRMED — 소스 직접 검증됨)
- [ ] `backend/src/repositories/alerts.js:82` — `hasRecentOfType()`가 severity/resolved를
      안 보고 type만으로 쿨다운을 걸어, warning급 음성 알림 직후 critical급 알림이
      쿨다운(기본 10분) 동안 억제될 수 있음. 진짜 응급상황에서 보호자 미통지 위험.
- [ ] `frontend/src/guardian/screens/AlertsScreen.jsx:53`, `HomeScreen.jsx:53` —
      `<img src={alert.snapshotUrl}>`가 `apiFetch`의 API_BASE 접두사/x-api-key를
      안 붙임. `ROBOT_API_KEY` 설정된 환경에서 스냅샷 이미지가 전부 401.
      (`middleware/index.js`가 이미 `?key=` 쿼리 폴백을 지원하니 그걸 붙이면 됨)
- [ ] `frontend/src/components/RobotFaceDisplay.jsx:394` — `resolveActiveAlert()`가
      미해결 알림 중 첫 번째만 처리하고, 서버가 반환하는 실제 `isEmergency` 값을
      무시한 채 "해제됐다" TTS를 재생 → 알림이 여러 개면 직후 사이렌이 재발동해
      사용자 혼란.
- [ ] `frontend/src/components/RobotFaceDisplay.jsx:225` — `handleTextSubmit`이
      `wakeword.js`의 `decideAction()`을 거치지 않고 `sendVoiceMessage()`를 직접 호출
      (음성 경로는 거침, CLAUDE.md 규칙 3 위반). 웨이크워드만 텍스트로 입력해도
      불필요한 Gemini 호출 발생.
- [ ] `backend/src/routes/vision.js:25` — JSON 바디 허용 한도(`maxJsonBodyBytes` 12MB)가
      실제 이미지 저장 한도(`maxImageBytes` 8MB)보다 커서, 그 사이 크기의 base64
      이미지는 분석까지는 되지만 `snapshots.save()`가 조용히 실패(null 반환) →
      critical 알림에 증거 사진이 누락되는데 에러 로그도 없음.

### 추정 (PLAUSIBLE — 단일 finder, 재검증 필요)
- [ ] `frontend/src/components/RobotFaceDisplay.jsx:334` — SSE `command.issued` +
      `/api/commands/pending`을 도입했는데도 deprecated `/api/remote-message/poll`을
      2.5초마다 계속 폴링 중. SSE 리스너로 교체.
- [ ] `frontend/src/lib/useGuardianData.js:54` — 모든 SSE 이벤트(채팅 턴마다)가
      3개 엔드포인트 전체 재조회를 트리거하고, SSE가 정상 연결 중에도 30초 폴백
      폴링이 무조건 실행됨. 이벤트 페이로드로 로컬 상태만 갱신하도록 개선 검토.
- [ ] `backend/src/services/gemini.js:166` — `analyzeImage()`가 `services/snapshots.js`의
      `parseDataUri()`를 재사용하지 않고 자체 정규식을 재구현, 두 정규식의 허용
      범위가 미묘하게 다름(빈 base64 페이로드 처리 차이). 하나로 통합 검토.

---

## 백로그 (급하지 않음)

### 정리
- [x] CLAUDE.md 구조 정리 — "Architecture notes"를 `docs/architecture.md`(Mermaid 다이어그램)로
      분리. `purge-old-messages` 커맨드 문서화 누락 수정.
- [ ] `lucide-react` — 설치돼 있으나 한 번도 import되지 않음. 쓰거나 제거
- [ ] 미사용 CSS 토큰 정리 (`--bg-secondary`, `--shadow-premium` 등)
- [ ] `--primary: #5c64ec`인데 실제 CSS는 `rgba(99,102,241,…)`를 쓰는 불일치
- [ ] `backend/database.json` — SQLite 이관 완료됨. 확인 후 삭제
- [ ] 구버전 호환 라우트 제거 (`GET /api/history`, `GET /api/remote-message/poll`) —
      키오스크가 신규 API로 옮겨간 뒤에

### 운영
- [ ] `purge-old-messages` 정기 실행 등록 (지금은 수동, 스케줄 없음)
- [ ] Cloud TTS 활성화 시 `TTS_PROVIDER=cloud` 전환 + `npm run prewarm-tts`
      (콘솔에서 API 활성화 1회 필요:
      https://console.cloud.google.com/apis/library/texttospeech.googleapis.com)
      ※ Phase 8에서 Polly로 갈 거면 이 항목은 건너뛰어도 된다 — 급히 목소리 품질을
      올려야 할 때만 쓰는 임시방편

### 테스트 커버리지
- [ ] 프론트엔드 컴포넌트 테스트 환경 없음 (jsdom/RTL 미설정).
      현재는 순수 함수만 테스트하고 UI는 실기기로 확인 중

---

## 다음 라운드 (이번 범위 밖)

- [ ] **YOLOv8 낙상 감지 실제 구현** — 계약과 mock은 준비됨. `docs/fall-detection.md` 참고.
      Python(FastAPI) 서비스가 `POST /api/detections`로 이벤트만 보내면 된다
- [ ] 라즈베리파이 5 실물 배포 (kiosk 모드, systemd, 카메라/마이크 연결)

(AWS 마이그레이션은 Phase 6/8/9로 승격됐다 — 위를 볼 것)

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
