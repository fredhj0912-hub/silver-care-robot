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
    messages.js, alerts.js, commands.js, detections.js, status.js, subscriptions.js, medications.js
  services/               business logic + external API adapters — routes call these, never SDKs directly
    gemini.js              chat()/analyzeImage()/transcribeAudio(), retry + model-fallback chain,
                             mock fallback. transcribeAudio() is server-side STT — the Pi's Chromium
                             cannot do Web Speech API (see docs/deploy-raspberry-pi.md §3)
    tts.js                  synthesize()/prewarm(), 3-provider switch, disk cache (sha1 of provider|voice|text)
    emergency.js            classifyUtterance()/evaluateUtterance()/raise()/resolveAlert() — single funnel
                              for all alert creation; cooldown + severity logic lives here only
    notify.js               send() — Web Push (VAPID) to subscribed guardian browsers. critical only.
                              Drops subscriptions the push service reports gone (404/410), and always
                              logs the outcome (sent / all-failed / no subscribers)
    history.js              Gemini multi-turn history sliding window (trimToTurns — always starts on 'user')
    events.js                SSE pub/sub (EventEmitter-based), role-scoped event filtering
    prompts.js                Gemini system instructions
    snapshots.js               data-URI → file on disk, path-traversal-safe read-back
    medication.js            classifyUtterance()/evaluateUtterance()/tick() — emergency.js와 같은 형태.
                              tick()이 시간이 된 약을 기존 speak 명령 큐에 넣고, 24시간 내 3회
                              미복용을 emergency.raise()로 **warning** 알림 1건으로 올린다
    motion.js                  move()/stop()/getState() — remote-control virtual position + dead-man
                                 timer safety switch. No real actuator yet; simulates coordinates in memory
  routes/                 one file per resource, mounted under /api in app.js
    status.js, chat.js, alerts.js, vision.js, commands.js, events.js, tts.js, stt.js, push.js,
    control.js, medications.js
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

- `node:sqlite` requires Node ≥ 22.5 (repo assumes 24). No native build step, unlike `better-sqlite3`.
- **`POST /api/stt`는 받아쓰기만 한다.** 웨이크워드 판정("효돌아")과 응급 우회는
  프론트의 `lib/wakeword.js`에 그대로 둔다 — 서버로 옮기면 그 판정이 두 곳으로 갈라진다.
- **받아쓰기를 못 하는 상태는 200이 아니라 503으로 알린다.** 빈 `text`로 조용히 성공시키면
  프론트가 음성 경로를 접지 못해, 어르신은 로봇이 못 알아듣는다고만 느낀다.
- **리포지토리는 전부 async다** (2026-08-29 전환 완료). `raise()`가 `notify.send()`를
  fire-and-forget으로 부르는 것은 푸시 지연이 알림 생성을 막지 않게 하기 위함이다.
- **`emergency.raise()`/`resolveAlert()`는 트랜잭션 안에서 돈다.** 이벤트 발행·푸시·모터
  정지 같은 **되돌릴 수 없는 부수효과는 반드시 커밋 이후**에 둘 것 — 롤백된 알림으로
  보호자 폰이 울리면 존재하지 않는 응급을 보호자가 믿게 된다.
- **pg 경로에서 pg-mem이 검증하지 못하는 것 둘**: 트랜잭션 롤백, COUNT/id의 타입.
  RDS에 처음 붙일 때 `npm run verify-rds`를 반드시 돌릴 것 (둘 다 거기서 검사한다).
- The old `GET /api/history`, `POST /api/remote-message`, and `GET /api/remote-message/poll` compat shims were removed 2026-08-27 (no callers left). Use `/api/messages` + `/api/alerts` and `/api/commands/pending` + `/api/commands/:id/ack`.
- `config.geminiModel` defaults to `gemini-3.6-flash`, not the newer `gemini-3.7-flash` — the latter 503s under load as of 2026-08.
