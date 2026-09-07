# backend/CLAUDE.md

Guidance specific to the Express API server. See root `CLAUDE.md` for project-wide context.

## Layout

```
server.js              entry point — wires src/app, restores chat history from DB, prints startup banner
src/
  app.js                Express assembly: CORS (private-network allowlist), body limit, security headers,
                          auth, route mounting, 404/error handlers. Serves frontend/dist at the
                          same origin when PUBLIC_DIR is set (EC2 deploy), with an SPA fallback that
                          never swallows /api/* — otherwise just the status landing page.
  config.js              single source of all env-derived config — check here before adding a new env var
  db/
    schema.sql            full SQLite schema (messages, alerts, outbound_commands, robot_status,
                            push_subscriptions, detections, medications)
    schema.pg.sql          같은 스키마의 PostgreSQL 판. **한쪽을 고치면 반드시 다른 쪽도 고칠 것**
    index.js               query()/queryOne()/exec()/transaction()/initDB()/nowISO().
                             DB_DRIVER=sqlite|pg 로 드라이버를 고른다. 헤더 주석의
                             '두 드라이버 공통 SQL 규칙 5가지'를 반드시 읽고 새 쿼리를 쓸 것.
                             **기존 테이블에 컬럼을 더할 때는 `ADDED_COLUMNS`에 ALTER 한 줄을
                             추가한다** — 스키마 파일은 CREATE TABLE IF NOT EXISTS 뿐이라 이미
                             있는 DB에는 새 컬럼이 안 붙고, SQLite는 ADD COLUMN IF NOT EXISTS를
                             지원하지 않아 "이미 있음" 예외를 삼키는 방식이 유일하다
    drivers/sqlite.js      node:sqlite DatabaseSync (개발·테스트 기본값)
    drivers/pg.js          node-pg 풀. ?→$n 변환, int8→number 파서, 풀에서 빌린 단일
                             커넥션 트랜잭션
  repositories/           one file per table; the only files that touch db/index.js
    messages.js, alerts.js, commands.js, detections.js, status.js, subscriptions.js, medications.js,
      usage.js      Gemini 호출 일일 카운터 (day, bucket) — 원자적 UPSERT 한 문장.
                      조회 후 삽입으로 바꾸지 말 것(예산은 세는 게 어긋나면 의미가 없다)
      snapshots.js  (카메라 스냅샷 **기록만** — 이미지 바이트는 DB에 안 들어간다.
                       services/snapshots.js가 디스크/S3에 두고 여기엔 파일명만.
                       pruneToLimit()이 지운 파일명을 돌려주므로 호출부가 파일도 지운다)
  services/               business logic + external API adapters — routes call these, never SDKs directly
    gemini.js              chat()/analyzeImage()/transcribeAudio(), retry + model-fallback chain,
                             mock fallback. transcribeAudio() is server-side STT — the Pi's Chromium
                             cannot do Web Speech API (see docs/deploy-raspberry-pi.md §3)
    budget.js               consume(bucket)/snapshot() — Gemini 하루 예산 상한.
                              버킷은 둘: 'text'(대화+받아쓰기+표정, 같은 모델 통) / 'tts'.
                              날짜 경계는 **미국 태평양 시각**(무료 등급 리셋이 PT 자정)
    tts.js                  synthesize()/prewarm(), 3-provider switch, disk cache (sha1 of provider|voice|text)
    emergency.js            classifyUtterance()/evaluateUtterance()/raise()/resolveAlert() — single funnel
                              for all alert creation; cooldown + severity logic lives here only
    notify.js               send() — Web Push (VAPID) to subscribed guardian browsers. critical only.
                              Drops subscriptions the push service reports gone (404/410), and always
                              logs the outcome (sent / all-failed / no subscribers)
    history.js              Gemini multi-turn history sliding window (trimToTurns — always starts on 'user')
    events.js                SSE pub/sub (EventEmitter-based), role-scoped event filtering
    prompts.js                Gemini system instructions
    snapshots.js               data-URI → file on disk(또는 S3), path-traversal-safe read-back,
                                 remove()로 보관 상한 정리. 파일명 접두어가 저장 당시 provider다
    medication.js            classifyUtterance()/evaluateUtterance()/tick() — emergency.js와 같은 형태.
                              tick()이 시간이 된 약을 기존 speak 명령 큐에 넣고, 24시간 내 3회
                              미복용을 emergency.raise()로 **warning** 알림 1건으로 올린다
    motion.js                  move()/stop()/getState() — remote-control virtual position + dead-man
                                 timer safety switch. No real actuator yet; simulates coordinates in memory
  routes/                 one file per resource, mounted under /api in app.js
    status.js, chat.js, alerts.js, vision.js, commands.js, events.js, tts.js, stt.js, push.js,
    control.js, medications.js,
    snapshots.js             POST/GET /api/snapshots — 분석 없이 사진만 올리고 목록을 준다.
                               **Gemini를 안 부른다**(vision.js와의 차이가 존재 이유다).
                               이미지 서빙 GET /api/snapshots/:filename 은 alerts.js에 있다
  middleware/index.js     securityHeaders, apiKeyAuth, asyncHandler, notFound, errorHandler
scripts/
  migrate-json-to-sqlite.js   one-time database.json import — idempotent (no-ops if messages already exist)
  mock-detector.js             fires a fake POST /api/detections to test the alert pipeline without a model
  prewarm-tts.js                pre-caches common phrases (see services/tts.js)
  purge-old-messages.js          deletes conversation history older than 90 days — run manually,
                                   no schedule set up yet
test/
  db-driver.test.js       드라이버 계약 (플레이스홀더, RETURNING, COUNT 타입, rowCount, 롤백)
  pg-driver.test.js       pg 경로를 pg-mem(인메모리 PostgreSQL)로 검증. 헤더에 적힌
                            '검증되지 않는 것' 두 가지를 읽을 것
  *.test.js               node --test. api.test.js and control.test.js spin up a real app against a temp
                            SQLite DB — set DB_PATH/SNAPSHOT_DIR before requiring src/app. New integration
                            tests must do the same; never point a test at backend/data/hyodol.sqlite (real
                            conversation log). motion.test.js tests services/motion.js's dead-man timer
                            directly (no DB needed) — call motion.stop() in afterEach/after so its
                            setTimeout doesn't leak into the next test or keep the process alive.
```

## Conventions

- **Routes stay thin**: validate input, call one or two service/repo functions, shape the response. Business logic belongs in `services/`.
- **모든 Gemini 호출은 `services/budget.js` 의 `consume()` 을 지난다.** 강제 지점은 딱 두 곳 —
  `gemini.js` 의 `withRetry()`(chat/vision/stt 가 전부 지나는 병목)와 `tts.js` 의
  `synthWithRetry()`. **새 Gemini 호출을 그 밖에 만들지 말 것** — 세는 곳을 빠져나가면 상한이
  상한이 아니게 된다. 예산 초과는 `err.code === 'BUDGET_EXHAUSTED'` 이고 **transient 가 아니라서**
  모델 체인까지 빠져나와 기존 mock 폴백으로 떨어진다.
- **`GEMINI_ENABLED=0` 은 로컬 작업용 킬 스위치다** — `getClient()` 가 `null` 을 돌려주고
  `tts.isEnabled()` 가 false 가 되어 호출이 구조적으로 0건이 된다. 코드를 만지는 동안 켜 둘 것.
- **All alert creation goes through `services/emergency.js`'s `raise()`**, never `alertsRepo.create()` directly from a route — that's where the cooldown and `robot_status.is_emergency` flip happen.
- **DB 접근은 `db/index.js`의 `query`/`queryOne`/`transaction`만 쓴다.** 드라이버를 직접
  require하지 말 것. SQL은 두 드라이버에서 모두 돌아야 한다(플레이스홀더 `?`, `RETURNING`,
  정수 0/1 boolean, `COUNT`는 `Number()`로 감싸기).
- **All timestamps are ISO8601 UTC** (`db.nowISO()`). Migrated legacy data mixed `+09:00` and `Z` — don't reintroduce that.
- **IDs are `INTEGER PRIMARY KEY AUTOINCREMENT`**, not `array.length + 1` — safe under future deletion/pruning.
- New external API integrations (AWS or otherwise) belong in `services/`, called from routes — never an inline `fetch()` in a route handler.

## Testing

`npm test` → `node --test test/*.test.js`. `emergency.test.js` and `history.test.js` test pure functions directly — these are the safety-critical ones (false-positive/negative emergency detection, chat history truncation) and should stay dependency-free.

## Gotchas

- **테스트는 개발자의 `backend/.env` 를 읽는다.** `config` 가 require 시점에 환경변수를 읽으므로,
  `.env` 의 `GEMINI_ENABLED=0` 이나 `DB_DRIVER=pg` 가 그대로 테스트에 새어 든다
  (09-07 에 `tts.test.js`/`stt.test.js` 가 실제로 이것 때문에 깨졌다). 새 테스트는 파일 맨 위에서
  `DB_DRIVER`/`DB_PATH` 와 필요한 스위치를 **직접 핀으로 박을 것**.
- `node:sqlite` requires Node ≥ 22.5 (repo assumes 24). No native build step, unlike `better-sqlite3`.
- **`POST /api/stt`는 받아쓰기만 한다.** 웨이크워드 판정("돌봄아")과 응급 우회는
  프론트의 `lib/wakeword.js`에 그대로 둔다 — 서버로 옮기면 그 판정이 두 곳으로 갈라진다.
- **받아쓰기를 못 하는 상태는 200이 아니라 503으로 알린다.** 빈 `text`로 조용히 성공시키면
  프론트가 음성 경로를 접지 못해, 어르신은 로봇이 못 알아듣는다고만 느낀다.
- **리포지토리는 전부 async다** (2026-08-29 전환 완료). `raise()`가 `notify.send()`를
  fire-and-forget으로 부르는 것은 푸시 지연이 알림 생성을 막지 않게 하기 위함이다.
- **`emergency.raise()`/`resolveAlert()`는 트랜잭션 안에서 돈다.** 이벤트 발행·푸시·모터
  정지 같은 **되돌릴 수 없는 부수효과는 반드시 커밋 이후**에 둘 것 — 롤백된 알림으로
  보호자 폰이 울리면 존재하지 않는 응급을 보호자가 믿게 된다.
- **pg 경로에서 pg-mem이 검증하지 못하는 것 셋**: 트랜잭션 롤백, COUNT/id의 타입,
  `ON CONFLICT ... DO UPDATE ... WHERE` 의 가드(조건이 거짓이면 진짜 PostgreSQL 은 아무것도
  돌려주지 않는데 pg-mem 은 갱신 전 행을 돌려준다 — 09-07 RDS 실측). **예산 상한이 그 한 줄에**
  **걸려 있다.** RDS에 처음 붙일 때 `npm run verify-rds`를 반드시 돌릴 것 (셋 다 거기서 검사한다).
- The old `GET /api/history`, `POST /api/remote-message`, and `GET /api/remote-message/poll` compat shims were removed 2026-08-27 (no callers left). Use `/api/messages` + `/api/alerts` and `/api/commands/pending` + `/api/commands/:id/ack`.
- `config.geminiModel` defaults to `gemini-3.6-flash`, not the newer `gemini-3.7-flash` — the latter 503s under load as of 2026-08.
