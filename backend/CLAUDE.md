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
    index.js               getDB()/transaction()/nowISO() — node:sqlite DatabaseSync wrapper
  repositories/           one file per table; the only files that call getDB()
    messages.js, alerts.js, commands.js, detections.js, status.js, subscriptions.js, medications.js
  services/               business logic + external API adapters — routes call these, never SDKs directly
    gemini.js              chat()/analyzeImage(), retry + model-fallback chain, mock fallback
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
    status.js, chat.js, alerts.js, vision.js, commands.js, events.js, tts.js, push.js, control.js,
    medications.js
  middleware/index.js     securityHeaders, apiKeyAuth, asyncHandler, notFound, errorHandler
scripts/
  migrate-json-to-sqlite.js   one-time database.json import — idempotent (no-ops if messages already exist)
  mock-detector.js             fires a fake POST /api/detections to test the alert pipeline without a model
  prewarm-tts.js                pre-caches common phrases (see services/tts.js)
  purge-old-messages.js          deletes conversation history older than 90 days — run manually,
                                   no schedule set up yet
test/
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
- **All timestamps are ISO8601 UTC** (`db.nowISO()`). Migrated legacy data mixed `+09:00` and `Z` — don't reintroduce that.
- **IDs are `INTEGER PRIMARY KEY AUTOINCREMENT`**, not `array.length + 1` — safe under future deletion/pruning.
- New external API integrations (AWS or otherwise) belong in `services/`, called from routes — never an inline `fetch()` in a route handler.

## Testing

`npm test` → `node --test test/*.test.js`. `emergency.test.js` and `history.test.js` test pure functions directly — these are the safety-critical ones (false-positive/negative emergency detection, chat history truncation) and should stay dependency-free.

## Gotchas

- `node:sqlite` requires Node ≥ 22.5 (repo assumes 24). No native build step, unlike `better-sqlite3`.
- **`DatabaseSync` is synchronous**, which is why every repository function — and `emergency.raise()`
  on top of them — is sync, and why `raise()` calls `notify.send()` fire-and-forget instead of
  awaiting it. A move to RDS/`pg` makes all of that async and the change propagates to every caller;
  budget it as a refactor, not an adapter swap.
- The old `GET /api/history`, `POST /api/remote-message`, and `GET /api/remote-message/poll` compat shims were removed 2026-08-27 (no callers left). Use `/api/messages` + `/api/alerts` and `/api/commands/pending` + `/api/commands/:id/ack`.
- `config.geminiModel` defaults to `gemini-3.6-flash`, not the newer `gemini-3.7-flash` — the latter 503s under load as of 2026-08.
