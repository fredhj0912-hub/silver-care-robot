# frontend/CLAUDE.md

Guidance specific to the Vite/React kiosk app. See root `CLAUDE.md` for project-wide context.

## Layout

Two apps ship from this one package: the **kiosk** at `/` (dark, fixed 800×480, for the robot's Pi display) and the **guardian PWA** at `/guardian/*` (light, phone-sized, for the adult child checking on their parent). Routing lives in `App.jsx`.

```
src/
  main.jsx                       StrictMode + createRoot; registers sw.js in PROD only
  App.jsx                        react-router: / -> kiosk, /guardian/* -> guardian app
  index.css                      kiosk styling + shared :root tokens
  components/
    RobotFaceDisplay.jsx          the whole kiosk: SVG face, voice loop, SOS, TTS playback, camera hooks.
                                    Large — read lib/ first before editing this file.
  guardian/
    GuardianApp.jsx               shell: header, routes, bottom tab bar
    guardian.css                  guardian palette + components; .is-emergency swaps the whole palette
    format.js                     Korean copy + KST time formatting; buildDailyNote() writes the home
                                    screen's note in the robot's first-person voice
    screens/                      HomeScreen, AlertsScreen, LogScreen, SendScreen, LiveScreen
  lib/
    api.js                        apiFetch() — fetch wrapper that stamps x-api-key from VITE_ROBOT_API_KEY
    wakeword.js                    pure functions: containsWakeWord/isBypassUtterance/decideAction/
                                     stripWakeWord. Tested in test/wakeword.test.js — the safety-critical
                                     file (emergency-bypass logic lives here).
    stt.js                         createRecognizer() — wraps Web Speech API behind an adapter so a future
                                     Cloud STT swap doesn't touch RobotFaceDisplay.jsx
    useCameraMonitor.js             React hook: captures a frame every intervalMs, POSTs to /api/vision,
                                     off by default (VITE_VISION_ENABLED)
    useGuardianData.js              SSE subscription (+30s fallback poll) and usePagedList() cursor helper
    push.js                          pushSupported()/subscribeToPush() — Notification permission +
                                       PushManager subscribe, registered via POST /api/push/subscribe
  scripts/make-icons.js          regenerates public/icon-*.png (encodes PNG directly, no image dep)
public/
  manifest.webmanifest, sw.js, icon-192.png, icon-512.png
test/
  setup.js                         vitest setupFile: jest-dom matchers, RTL cleanup, Notification stub
  wakeword.test.js                 pure functions (no DOM)
  HomeScreen.test.jsx              guardian home: emergency-vs-note branch, resolve, offline notice
  AlertsScreen.test.jsx            alert history: empty state, resolve button gating, reload after resolve
```

## Conventions

- **Voice-related state changes go through `setRobotEmotion`/`setVoiceState`**, not direct style/DOM writes — the SVG face and antenna color derive from these plus `status.isEmergency`.
- **`isSpeakingRef`/`shouldListenRef` gate self-hearing prevention** (recognition stops before TTS starts, restarts on end/error). Route any new speech-output path through `speakText`/`finishSpeaking` — don't bypass this gate.
- **`emergencyRef`/`gateActiveRef` exist so long-lived callbacks/effects can read current `status.isEmergency`/gate state without retriggering.** Read the ref; don't add the state value to a dependency array just to read its current value.
- **New chat-triggering input (voice, text, button) should go through `decideAction()`** from `lib/wakeword.js`, not call `sendVoiceMessage` directly — that's how the wake-word gate and emergency bypass stay consistent across input methods.
- **TTS**: `speakText` tries `POST /api/tts` first, falls back to browser `SpeechSynthesis` on a 204 or any failure. Always design for the fallback path being the one that's actually live.

## Testing

`npm test` → `vitest run` (jsdom + `@testing-library/react`). Vitest reads `vite.config.js`, so
`@vitejs/plugin-react` transforms JSX and `import.meta.env` is populated — that's why this package
uses Vitest while the backend stays on `node --test`.

- **Mock `fetch`, not `lib/api.js`.** Stub the global with `vi.stubGlobal('fetch', …)` and let
  `apiFetch`/`assetUrl` run for real, so a regression in key-stamping still gets caught. Assert on
  the request **path and body only** — `VITE_ROBOT_API_KEY` differs per environment, so asserting
  on the `x-api-key` value makes the suite machine-dependent.
- **Wrap anything with a `<Link>` in `MemoryRouter`** (from `react-router`).
- **`test/setup.js` stubs `Notification`**, because jsdom has none and `HomeScreen` reads
  `Notification.permission` on mount whenever `VITE_VAPID_PUBLIC_KEY` is set.
- Covered so far: the guardian screens whose branches decide *whether the guardian sees an
  emergency*. `RobotFaceDisplay.jsx` is still untested (Web Speech / TTS / camera APIs) — verify
  kiosk changes by running `npm run dev` against the real backend.

## Guardian app conventions

- **The home screen answers one question — "is my parent okay?"** It's a note from the robot, not a dashboard. `buildDailyNote()` turns `conversationTurns: 8` into "오늘 어르신과 여덟 번 이야기를 나눴어요". Don't add raw metrics to it; if a number matters, write the sentence that explains it.
- **Emergency is a whole-app state, not a banner.** `.is-emergency` on `.guardian-root` swaps the entire palette via CSS variables. Style new components with the tokens so they follow automatically.
- **The note takes structured tokens, not an HTML string.** `buildDailyNote()` returns `[{t, em}]` on purpose — emphasis via `dangerouslySetInnerHTML` would become an XSS hole the moment user text enters that sentence.
- **The conversation log opens at the newest message** (`LogScreen` scrolls to bottom on first load, and preserves position when older messages prepend). A chat that opens at the top reads as "my message didn't send".
- **Push permission is asked for on the home screen, not on load.** `HomeScreen` shows an "응급 알림 받기" banner only while `Notification.permission === 'default'`, and a recovery line when it's `denied`. Browsers only grant permission from a user gesture, and an unprompted popup on first paint is the fastest way to get denied permanently.

## Gotchas

- Kiosk-only globals in `index.css` (`user-select:none`, page-scroll lock via `body:has(.kiosk-root)`, hidden scrollbars) are scoped to `.kiosk-root`. Moving them back onto `*` or bare `body` breaks guardian-app scrolling.
- The service worker never caches `/api/*` — a stale "평온해요" is worse than no answer. Keep it that way.
- **`main.jsx` registers `sw.js` in PROD builds only**, so `npm run dev` has no service worker and therefore no push at all. Testing push means `npm run build && npm run preview` (port 4173) — not the dev server. Web Push also requires HTTPS, so a phone test needs a tunnel; `vite.config.js` allows `.trycloudflare.com` in both `server` and `preview` for that.
- `VITE_*` env vars are inlined into the client bundle at build time — `VITE_ROBOT_API_KEY` is visible in devtools. LAN speed-bump only, not real auth.
- Fonts are split by app: Outfit/Noto Sans KR for the kiosk, IBM Plex Sans KR + Gowun Batang + Plex Mono for the guardian. Both load from one `<link>` in `index.html`.
