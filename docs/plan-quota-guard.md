# Gemini 할당량 폭주 차단 — 푸시투토크 + 서버측 예산 상한

> **상태: 미착수.** 2026-09-06 계획 수립. 코드는 한 줄도 안 건드렸다.
>
> **다음 세션 시작 방법** — 새 세션에서 이렇게 말하면 된다:
>
> ```
> docs/plan-quota-guard.md 읽고 그대로 실행해.
> Part 1(백엔드 예산 상한)부터 끝내고 보고한 다음 Part 2(푸시투토크)로 넘어가.
> ```
>
> **다 끝나면 이 문서를 지우고** TODO.md의 포인터 줄도 같이 지운다 — 완료 이력은 `git log`에 남는다.
>
> **작업 순서** — Part 1과 Part 2는 독립이다. Part 1(백엔드)이 먼저다:
> 그것만으로도 "청구 폭탄"은 막히고, 할당량 0건으로 전부 검증되며, 파이가 없어도 끝난다.
> 한 세션 = 한 파트로 끊을 것.
>
> **착수 전 확인 3가지** — 계획은 2026-09-06 기준 코드에서 세웠다:
> 1. `frontend/src/components/RobotFaceDisplay.jsx`의 줄 번호(L501-509, L515, L856)는 그동안
>    바뀌었을 수 있다. 줄 번호가 아니라 **`onEnd` 재시작 / 마운트 시 `startListening` / DEV 배지**를
>    이름으로 찾을 것.
> 2. `backend/.env`의 `DB_DRIVER`가 `pg`면 새 테이블이 **실제 RDS(팀원과 공용 DB)에 생긴다.**
>    이름이 `api_usage`라 팀원 테이블과 겹치지 않는지 먼저 볼 것(TODO 백로그의 충돌 항목).
> 3. 시작 전에 `backend/.env`에 `GEMINI_ENABLED=0`을 먼저 넣어라 — 그러면 개발 중 호출이 0건이다.
>    (이 스위치를 만드는 게 Part 1의 일부이므로, 만들자마자 켤 것)

## Context

지금 구조에서는 **방 안에서 나는 400ms 이상, RMS 0.02 이상의 모든 소리가 Gemini 호출 1건**이다.
서버측 STT(`VITE_STT_MODE=server`, 파이의 기본값)는 VAD가 발화를 자르는 즉시 `/api/stt`로
올리고, 웨이크워드 판정(`decideAction()`)은 그 **받아쓰기 결과를 받은 뒤에** 돈다. 게이트가
닫혀 있어도 받아쓰기 값은 이미 지불된 뒤다. 무료 등급은 모델당 하루 20건(대화+받아쓰기 합쳐 40)이라
잡음 몇 번이면 하루치가 사라진다 — 09-02에 실제로 한 시간에 100건을 태운 적이 있다
(`RobotFaceDisplay.jsx`의 `disableStt` 주석).

여기에 더해 **서버에는 어떤 종류의 상한도 없다.** `express-rate-limit`도, 일일 카운터도,
토큰 집계도 없다. 할당량 소진은 429 에러 문자열을 정규식으로 알아채는 **사후 감지**뿐이다
(`gemini.js`의 `QUOTA_EXHAUSTED`). 무료 등급에서는 통이 막히고 끝나지만, **행사 전에 결제를 켜면
같은 폭주가 그대로 요금이 된다.** 상한이 없으니 상한선이 곧 카드 한도다.

목표 두 가지:

1. **근본 차단** — 마이크가 상시로 열려 있지 않게 한다. 화면을 눌러야 듣는다(푸시투토크).
2. **보험** — 서버에 하루 예산 상한을 걸어, 넘으면 실제 호출 대신 mock으로 떨어뜨린다.
   무료 등급에서는 "통을 다 쓰기 전에 우리가 먼저 멈추는" 장치이고, 결제 후에는 **요금 상한**이다.

사용자가 고른 방식이며, 온디바이스 웨이크워드(Porcupine 등)는 이번 범위에서 제외한다.

---

## ⚠️ 이 변경이 만드는 안전 회귀 — 먼저 읽을 것

**상시 청취를 끄면 로봇은 "살려줘"를 못 듣는다.** 지금은 `wakeword.js`의 `BYPASS_PHRASES` 22개가
웨이크워드 없이도 통과해 응급 알림으로 이어지는데, 마이크가 닫혀 있으면 그 경로 자체가 사라진다.
쓰러져서 화면에 손이 못 닿는 어르신에게는 **음성 응급 경로가 없어진다.**

남는 대체 수단은 이미 있는 것들이다:

- **SOS 버튼** (`routes/alerts.js`, `skipCooldown`) — 화면 터치. Gemini 0건.
- **낙상 감지** (`POST /api/detections`) — 아직 미구현(TODO B 트랙). 구현되면 이게 진짜 대체재다.

그래서 이 작업에는 **키오스크의 SOS 버튼을 항상 보이고 크게 두는 것**을 포함한다.
근본적으로는 낙상 감지(YOLOv8)가 들어오기 전까지 음성 응급 경로가 없다는 사실을 TODO.md에
명시해 남긴다.

---

## Part 1 — 서버측 일일 예산 상한 (백엔드)

호출 경로가 어떻게 바뀌든 서버가 마지막 방어선이 되게 한다. 클라이언트 휴리스틱(VAD, 게이트)은
낡은 빌드 · 두 번째 탭 · curl 한 줄이면 전부 우회된다.

### 1-1. 사용량 테이블

`backend/src/db/schema.sql` + `backend/src/db/schema.pg.sql` **둘 다에** 추가:

```sql
CREATE TABLE IF NOT EXISTS api_usage (
  day    TEXT NOT NULL,
  bucket TEXT NOT NULL,
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, bucket)
);
```

`day`는 **미국 태평양 시각 기준 `YYYY-MM-DD`** — Gemini 무료 등급의 리셋 경계가 PT 자정이라
우리 카운터도 같은 경계를 써야 실제 통과 어긋나지 않는다. 의존성 없이
`Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })`로 만든다.

### 1-2. `backend/src/repositories/usage.js` (신규)

`db/index.js` 헤더의 5가지 규칙을 따른다(플레이스홀더 `?`, `RETURNING`, `COUNT`는 `Number()`).

```js
// 원자적 증가 — 양 드라이버 공통
INSERT INTO api_usage (day, bucket, n) VALUES (?, ?, 1)
ON CONFLICT (day, bucket) DO UPDATE SET n = api_usage.n + 1
RETURNING n
```

`emergency.js`의 쿨다운(`hasRecentOfType`)은 **check-then-write라 pg에서 racy**하다고 그 파일에
적혀 있다. 여기서는 그 패턴을 따라가지 말고 위처럼 **한 문장 UPSERT로 원자적으로** 센다.

함수: `increment(day, bucket)` → 증가 후 값, `getDay(day)` → `{bucket: n}`.

### 1-3. `backend/src/services/budget.js` (신규)

```
consume(bucket)  // 증가시키고, 예산을 넘으면 BUDGET_EXHAUSTED 에러를 던진다
snapshot()       // { text: {used, budget}, tts: {used, budget} }  — 상태 표시용
```

버킷은 **두 개뿐**:

| 버킷 | 포함 | 이유 |
|---|---|---|
| `text` | `chat` + `transcribeAudio` + `analyzeImage` | 셋이 **같은 모델 통**을 쓴다(TODO 1순위 표) |
| `tts` | `synthesize` | 별도 모델, 별도 통 |

`consume()`은 **호출 시도 1회당 1건**을 센다 — 재시도와 대체 모델 전환도 각각 Google이 세는
실제 요청이므로 똑같이 센다.

### 1-4. `backend/src/config.js`

```
GEMINI_ENABLED       기본 1.  0이면 Gemini를 아예 안 부른다(개발용 킬 스위치)
GEMINI_DAILY_BUDGET  기본 36  (실제 통 40 중 여유 4를 남긴다)
TTS_DAILY_BUDGET     기본 18  (실제 20 중 여유 2)
```

`.env.example` 두 곳에 주석과 함께 추가. 시작 배너(`config.js` L136 근처)에 예산도 같이 찍는다.

### 1-5. 강제 지점 — 딱 두 곳

- **`services/gemini.js`의 `withRetry()`** — 모든 chat/vision/stt가 지나는 유일한 병목이다.
  각 시도 직전에 `await budget.consume('text')`. `BUDGET_EXHAUSTED`는 **transient가 아니게**
  만들어 즉시 던지면, `chat`/`analyzeImage`/`transcribeAudio`의 **기존 catch가 그대로 mock으로**
  떨어뜨린다. 새 폴백 경로를 만들 필요가 없다.
- **`services/tts.js`의 `synthesize()`** — **캐시 미스일 때만**, fetch 직전에 `consume('tts')`.
  예열된 문구는 계속 0건이다.

킬 스위치는 더 얕게: `config.geminiEnabled === false`면 `gemini.js`의 `getClient()`가 `null`을
돌려주고(이미 `!apiKey`일 때 그러는 자리다), `tts.js`의 `isServerTtsAvailable()`이 false가 된다.
→ 전부 기존 mock/204 경로. **Claude가 로컬에서 붙어 작업할 때 `.env`에 `GEMINI_ENABLED=0` 한 줄이면
호출이 구조적으로 0건이 된다.**

### 1-6. 보이게 하기

- `consume()`마다 `[QUOTA] text 12/36` 한 줄. 지금 이 코드베이스에는 **호출을 세는 곳이 하나도 없다.**
- `GET /api/status`(`routes/status.js`)에 `usage: budget.snapshot()` 추가.
  키오스크의 DEV 배지(`RobotFaceDisplay.jsx` L856)가 이미 `source`를 보여 주므로,
  mock으로 떨어진 순간이 화면에서 구분된다.

---

## Part 2 — 푸시투토크 (프론트)

### 2-1. 모드 스위치

`?snapshot=1`과 같은 패턴을 따른다 — **URL이 env를 이긴다**:

```
VITE_MIC_MODE = 'ptt' | 'always'   기본 'ptt'
?mic=always                         디버깅용 상시 청취 복귀
```

`RobotFaceDisplay.jsx` 상단(L14~37의 기존 플래그 블록 옆)에서 한 번 계산.

### 2-2. 배선 변경 — `frontend/src/components/RobotFaceDisplay.jsx`

기존 인식기 계약(`lib/stt.js`의 `createRecognizer`)과 `server-recognizer.js`는 **손대지 않는다.**
`start()`/`stop()`이 이미 있고, `stop()`이 마이크를 열어 둔 채 캡처만 멈추므로(파이에서 권한
재요청을 피하려고 그렇게 만든 것) 푸시투토크에 그대로 맞는다.

- **L515 마운트 시 `setTimeout(startListening, 1000)`** → `ptt` 모드에서는 실행하지 않는다.
- **L501-509 `onEnd`의 자동 재시작** → `ptt` 모드에서는 재시작하지 않는다
  (실패 backoff 로직은 `always` 모드용으로 남긴다).
- **`onResult`** → 발화 하나를 처리한 뒤 `ptt` 모드면 자동으로 `stop()`. 한 번 누름 = 한 발화.
- **무발화 타임아웃** `PTT_TIMEOUT_MS`(8초) — 눌렀는데 아무 말이 없으면 스스로 닫는다.
  마이크가 열린 채 잊히는 경로를 없앤다.
- `decideAction()`은 **그대로 통과시킨다** — 버튼을 누른 것 자체가 의도 표명이므로
  `isActive=true`로 부른다. 응급 우회·잡음 필터(`isMeaningfulUtterance`)는 계속 일한다.

### 2-3. 화면

- 얼굴 아래 **큰 버튼 하나**: `🎤 눌러서 말하기` → 듣는 중에는 `🔴 듣고 있어요` + 남은 시간 표시.
  720×1280 세로 패널이고 어르신이 쓰므로 **터치 타깃을 크게**(최소 높이 100px 수준).
- **SOS 버튼을 항상 보이고 크게** — 위 안전 회귀 절의 완화책이다.
- `.kiosk-root` 스코프 안에서만 스타일링(루트 CLAUDE.md 규칙 4).

---

## 건드리는 파일

**백엔드 (신규)**: `src/repositories/usage.js`, `src/services/budget.js`, `test/budget.test.js`
**백엔드 (수정)**: `src/db/schema.sql`, `src/db/schema.pg.sql`, `src/config.js`,
`src/services/gemini.js`, `src/services/tts.js`, `src/routes/status.js`, `.env.example`
**프론트 (수정)**: `src/components/RobotFaceDisplay.jsx`, `src/index.css`, `.env.example`
**프론트 (신규)**: `test/RobotFaceDisplay.ptt.test.jsx`
**문서**: `TODO.md`, `backend/CLAUDE.md`, `frontend/CLAUDE.md`, `docs/architecture.md`(웨이크워드 게이트 그림)

---

## 검증

**전부 할당량 0건으로 확인 가능하다.**

1. `cd backend && npm test` — 기존 148개 통과. 새 `budget.test.js`가 덮을 것:
   - `api.test.js` 패턴 그대로(임시 SQLite에 `DB_PATH`/`SNAPSHOT_DIR` 오버라이드) 예산을 **1로 낮춰**
     두 번째 `/api/chat`이 `source: 'mock'`으로 떨어지는지
   - `day` 경계가 태평양 기준으로 갈리는지, `text`/`tts` 버킷이 서로 안 섞이는지
   - `GEMINI_ENABLED=0`이면 카운터가 **아예 안 오르는지**(호출 자체가 없으므로)
2. `cd backend && npm run migrate-pg -- --dry-run` 은 아니고 — 새 테이블은 `CREATE TABLE IF NOT EXISTS`라
   기존 DB에 자동으로 붙는다. **컬럼 추가가 아니라 테이블 추가라 `ADDED_COLUMNS`는 불필요.**
   `pg-driver.test.js`(pg-mem)로 UPSERT 문이 pg에서 파싱되는지 확인하고,
   **드라이버를 건드리는 변경이므로 `npm run verify-rds`도 돌린다**(루트 CLAUDE.md 경고).
3. `cd frontend && npm test && npm run lint` — 새 ptt 테스트는
   `RobotFaceDisplay.server-stt.test.jsx`의 **`vi.stubEnv` + 동적 import** 패턴을 반드시 따를 것
   (`stt.js`가 모듈 로드 시점에 env를 붙잡는다).
4. **로컬 육안**: `npm run dev` + `.env`에 `GEMINI_ENABLED=0` →
   `?vad=1`로 VAD 오버레이를 켜고 방에서 떠들어도 `/api/stt`가 **한 번도 안 나가는지**
   (devtools 네트워크 탭). 버튼을 눌렀을 때만 나가는지.
5. **`GET /api/status`** 로 `usage` 숫자가 실제로 오르는지 (`GEMINI_ENABLED=1` + 예산 2로 낮춰
   한두 번만 태우고 확인).
6. **파이 실측은 TODO 2순위 C에 붙인다** — 버튼이 720×1280에서 누를 만한지, 어르신 손에 맞는지.
   이건 실물 앞에서만 확인된다.

## TODO.md 갱신

- 1순위에 **"음성 응급 경로가 사라졌다 — 낙상 감지가 들어올 때까지 SOS 버튼이 유일하다"**를 명시
- 2순위 C의 "서버측 STT 실측"을 **"푸시투토크 실측"**으로 바꾸고 예상 소모를 다시 적는다
  (버튼 한 번 = 받아쓰기 1 + 대화 1 = 2건, 잡음은 0건)
- "행사 전에는 결제를 켠다" 항목에 **`GEMINI_DAILY_BUDGET`이 이제 요금 상한 역할을 한다**를 덧붙인다
