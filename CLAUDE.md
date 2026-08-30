# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**효돌이 (Hyodol-i)** — a local software prototype for a multimodal LLM-powered "silver care" companion robot for elderly users living alone. It's a kiosk-style web app meant to run full-screen on a Raspberry Pi 7" display (800×480): a robot face reacts with emotions, listens via voice (Web Speech API, gated by a wake word), talks back via TTS (browser SpeechSynthesis or server-side Gemini/Cloud TTS), reminds the senior to take their medication out loud and confirms it by voice, and can trigger emergency/SOS alerts to a guardian. Google Gemini powers conversation and vision analysis; both fall back to Korean-language mock logic when no API key is present or a call fails.

The codebase (comments, prompts, UI copy) is primarily in Korean, since the product targets Korean-speaking senior users and guardians.

**AI stays on Gemini.** The competition-provided AWS account (한이음 드림업) supports only
cheap infrastructure — EC2, Lambda, RDS, DynamoDB, S3, API GW, Amplify, SQS, SNS — and
**no cloud AI at all** (Bedrock is explicitly denied; Polly/Transcribe are equally out of
scope). Don't propose migrating conversation, vision, or speech to AWS. That account also
**forbids Access Key issuance** — authentication is IAM-Role-only (`SafeInstanceProfile-{username}`
for EC2), which means any AWS integration can only be exercised from inside EC2, never locally.

The `services/`/`repositories/` split exists to keep external integrations swappable — keep new
ones behind that same pattern. **Two known gaps**, measured 2026-08-27:

- `services/history.js` has no conversion layer at all — the stored format *is* the Gemini wire
  format (`{role:'user'|'model', parts:[{text}]}`), passed straight into the SDK. Swapping to any
  other LLM provider would mean writing one from scratch. (A Bedrock adapter was built and then
  removed once the account limitation was confirmed — see TODO.md.)
- `node:sqlite`'s `DatabaseSync` is **synchronous**, so every repository (and `emergency.raise()`
  above them) is a sync function. Moving to RDS/`pg` turns that into an async refactor that
  propagates through every caller.

See TODO.md's AWS section for what's actually feasible before estimating this work.

## Repo layout

- `backend/` — Express API server. `server.js` is now just the entry point (~40 lines); real logic lives under `src/`. SQLite (`node:sqlite`, no native build) replaced the old flat-file `database.json`. See `backend/CLAUDE.md`.
- `frontend/` — Vite + React 19 app serving **two apps from one build**: `/` is the robot kiosk (dark, fixed 800×480), `/guardian/*` is the guardian PWA (light, phone, installable, receives Web Push for critical alerts). See `frontend/CLAUDE.md`.
- `start-all.js` — root orchestrator, spawns backend (3001) + frontend (5173) for local dev.
- `docs/architecture.md` — system diagrams (components, emergency alert flow, command queue, wake-word gate) referenced from "Architecture notes" below.
- `docs/fall-detection.md` — contract for a future YOLOv8 fall-detection service (`POST /api/detections`); not yet implemented, only the interface + a mock detector exist.
- `.agents/skills/` — gstack workflow skills. Not part of the application.

## Common commands

```bash
npm run install-all
npm run dev                          # backend (3001) + frontend (5173) via start-all.js
```

```bash
cd backend && npm start              # node server.js
cd backend && npm test               # node --test test/*.test.js
cd backend && npm run migrate        # one-time database.json → SQLite import (idempotent)
cd backend && npm run mock-detector -- --type fall --confidence 0.92
cd backend && npm run prewarm-tts    # pre-cache common TTS phrases
cd backend && npm run purge-old-messages   # delete conversation history older than 90 days

cd frontend && npm run dev
cd frontend && npm run build
cd frontend && npm test              # vitest run (jsdom + Testing Library)
cd frontend && npm run lint          # oxlint
```

Both packages have test suites, but **different runners**: backend is `node --test`, frontend is **Vitest** (it reuses `vite.config.js`, so JSX and `import.meta.env` work — `node --test` handles neither). Backend's `test/api.test.js` spins up a real Express app against a **temporary** SQLite DB (overrides `DB_PATH`/`SNAPSHOT_DIR` before requiring `src/app`) — it never touches real conversation history. Follow that pattern for new integration tests. Frontend component tests run in jsdom with Testing Library; see `frontend/CLAUDE.md`.

## Configuration

- `backend/.env`: `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3.6-flash` — see gotcha below), `ROBOT_API_KEY` (LAN shared secret; when set, all routes require an `x-api-key` header), `PORT`, `TTS_PROVIDER` (`browser`|`gemini`|`cloud`, default `browser`), `DETECTION_THRESHOLD`, `ALERT_COOLDOWN_MS`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` (Web Push; **all three required or push silently disables itself** — the startup banner warns when unset. Regenerate with `npx web-push generate-vapid-keys`).
- `frontend/.env`: `VITE_ROBOT_API_KEY` (must match backend's `ROBOT_API_KEY` — ships in the client bundle, a LAN speed-bump, not real auth), `VITE_VISION_ENABLED` (default `false`, camera capture is opt-in), `VITE_VISION_INTERVAL_MS`, `VITE_VAPID_PUBLIC_KEY` (must match backend's `VAPID_PUBLIC_KEY`).
- **Gotcha**: `gemini-3.7-flash` frequently returns 503 ("high demand") as of 2026-08. `services/gemini.js` retries transient errors and falls back from `GEMINI_MODEL` to `GEMINI_FALLBACK_MODEL` (default `gemini-3.5-flash`) — don't bump the default model without checking it's actually stable under load.
- **Gotcha (Windows)**: PowerShell's `Get-Content`/`ConvertFrom-Json` mangle this repo's Korean UTF-8 content into garbage. Read files / parse JSON with Node or the Read/Bash tools, not PowerShell cmdlets — reserve PowerShell for process management (starting/stopping servers, freeing ports).

## Architecture notes

See `docs/architecture.md` for the full system diagrams (components, emergency alert flow,
command queue, wake-word gate) and background on each subsystem. The five rules below are the
ones that matter when writing new code — everything else lives in that doc.

1. **Layering**: all external calls (Gemini, TTS providers) sit behind a `services/*.js` adapter
   with one function signature; all DB access goes through `repositories/*.js` — never call
   `db/index.js`'s `getDB()` directly from a route.
2. **All alert creation goes through `services/emergency.js`'s `raise()`/`evaluateUtterance()`**
   — that's where cooldown and severity logic live, and the only funnel for voice, vision,
   manual SOS, and external detectors alike. Missed medication goes through it too, but is always
   `warning` and only after 3 misses in 24h — see rule 5.
3. **Route any new chat-triggering input through `frontend/src/lib/wakeword.js`'s
   `decideAction()`** — it's the single wake-word/emergency-bypass gate.
4. **Kiosk-only global CSS is scoped to `.kiosk-root`**; putting it back on `*` breaks guardian
   scrolling.
5. **Guardian push goes through `services/notify.js` only, and only for `severity === 'critical'`**
   — `raise()` calls it fire-and-forget. Never push warnings: repeated false-positive
   notifications get the guardian to mute the app, and a muted guardian is this system's worst
   failure mode. `notify.js` must always log the send outcome for the same reason — a push that
   silently failed is indistinguishable from one that was never needed.

