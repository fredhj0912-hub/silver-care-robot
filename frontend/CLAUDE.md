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
    screens/                      HomeScreen, AlertsScreen, LogScreen, SendScreen, LiveScreen,
                                    MedicationScreen
  lib/
    api.js                        apiFetch() — fetch wrapper that stamps x-api-key from VITE_ROBOT_API_KEY
    wakeword.js                    pure functions: containsWakeWord/isBypassUtterance/decideAction/
                                     stripWakeWord. Tested in test/wakeword.test.js — the safety-critical
                                     file (emergency-bypass logic lives here).
    stt.js                         createRecognizer() — dispatches on VITE_STT_MODE ('server' default |
                                     'browser'). Same return contract either way, so RobotFaceDisplay.jsx
                                     and the wake-word gate are implementation-agnostic.
    server-recognizer.js           the 'server' implementation: Web Audio raw PCM capture -> VAD ->
                                     WAV -> POST /api/stt. The Pi's Chromium has no Web Speech API
                                     (docs/deploy-raspberry-pi.md §3). stop() pauses capture but keeps
                                     the mic open — reopening prompts for permission on the Pi.
    vad.js                         pure state machine: RMS energy in, utterance boundaries out.
                                     Testable with plain numbers — no audio needed.
    wav.js                         encodeWav()/wavToDataUri()/rms(). Gemini accepts no webm, so we
                                     never touch MediaRecorder.
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
  vad.test.js, wav.test.js         pure functions (no DOM, no audio) — VAD is fed plain RMS numbers
  server-recognizer.test.js        the recognizer contract against a fake AudioContext
  RobotFaceDisplay.server-stt.test.jsx  the same gate wiring in the DEFAULT ('server') mode
  HomeScreen.test.jsx              guardian home: emergency-vs-note branch, resolve, offline notice
  AlertsScreen.test.jsx            alert history: empty state, resolve button gating, reload after resolve
  MedicationScreen.test.jsx        복약: 등록 시 UTC 변환, 복용 버튼 게이팅, 시리즈 삭제
  useGuardianData.test.jsx         SSE 정체 감지·재연결, 폴백 폴링 중에는 오프라인 안내 안 함
  RobotFaceDisplay.test.jsx        키오스크가 웨이크워드 게이트를 실제로 통과시키는지 (STT/TTS 스텁)
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
  emergency*, plus `useGuardianData`'s SSE/fallback path.
- **`RobotFaceDisplay.test.jsx`는 화면 전체가 아니라 게이트 배선만 덮는다** — 웨이크워드
  없는 발화가 `/api/chat`을 부르지 않는지, 응급 우회 발화는 통과하는지. 판정 로직 자체는
  `wakeword.test.js`가 덮으므로 되풀이하지 말 것. 얼굴 렌더·TTS 재생·카메라 경로는 여전히
  미검증이니 키오스크 변경은 `npm run dev`로 실제 백엔드에 붙여 확인한다.
- **`stt.js`는 모듈 로드 시점에 `window.SpeechRecognition`과 `VITE_STT_MODE`를 붙잡는다.**
  그래서 `RobotFaceDisplay.test.jsx`는 `vi.stubEnv`와 스텁을 먼저 심고 컴포넌트를
  **동적 import**한다 — 정적 import로 바꾸면 둘 다 늦어 STT 경로가 통째로 죽는다.
- **기본 모드는 `server`인데 `RobotFaceDisplay.test.jsx`는 `browser`로 고정해 돈다**
  (이벤트를 손으로 흘려보내야 해서). 그러면 **실제 배포 경로를 아무도 안 지나가므로**,
  같은 배선을 server 모드로 한 번 더 덮는 `RobotFaceDisplay.server-stt.test.jsx`가 있다.
  둘 중 하나만 고치고 넘어가지 말 것.
- **인식기 계약은 화면 테스트로 다 안 덮인다.** 빈 받아쓰기를 흘려보내도 웨이크워드
  게이트가 걸러 주기 때문에 컴포넌트 레벨에서는 가드를 지워도 통과한다(변이 테스트로 확인).
  `server-recognizer.test.js`가 그 층을 맡는다.

## Guardian app conventions

- **The home screen answers one question — "is my parent okay?"** It's a note from the robot, not a dashboard. `buildDailyNote()` turns `conversationTurns: 8` into "오늘 어르신과 여덟 번 이야기를 나눴어요". Don't add raw metrics to it; if a number matters, write the sentence that explains it.
- **Emergency is a whole-app state, not a banner.** `.is-emergency` on `.guardian-root` swaps the entire palette via CSS variables. Style new components with the tokens so they follow automatically.
- **The note takes structured tokens, not an HTML string.** `buildDailyNote()` returns `[{t, em}]` on purpose — emphasis via `dangerouslySetInnerHTML` would become an XSS hole the moment user text enters that sentence.
- **The conversation log opens at the newest message** (`LogScreen` scrolls to bottom on first load, and preserves position when older messages prepend). A chat that opens at the top reads as "my message didn't send".
- **Push permission is asked for on the home screen, not on load.** `HomeScreen` shows an "응급 알림 받기" banner only while `Notification.permission === 'default'`, and a recovery line when it's `denied`. Browsers only grant permission from a user gesture, and an unprompted popup on first paint is the fastest way to get denied permanently.

## Gotchas

- Kiosk-only globals in `index.css` (`user-select:none`, page-scroll lock via `body:has(.kiosk-root)`, hidden scrollbars) are scoped to `.kiosk-root`. Moving them back onto `*` or bare `body` breaks guardian-app scrolling.
- **800×480에는 남는 높이가 없다.** `.robot-face`는 `height` + `max-height: 100%` +
  `aspect-ratio: 1`로 **남는 자리에 맞춰 줄어든다** — 뷰포트 기준 고정값으로 되돌리면
  얼굴이 말풍선을 덮어 어르신이 읽어야 할 글을 가린다(09-02에 실제로 그랬다).
  `.face-area`의 `padding-top`은 안테나가 잘리지 않게 비워 둔 자리다.
  말풍선이 떠 있는 동안에는 `:has()`로 여백을 조여 얼굴 자리를 지킨다.
- The service worker never caches `/api/*` — a stale "평온해요" is worse than no answer. Keep it that way.
- **`main.jsx` registers `sw.js` in PROD builds only**, so `npm run dev` has no service worker and therefore no push at all. Testing push means `npm run build && npm run preview` (port 4173) — not the dev server. Web Push also requires HTTPS, so a phone test needs a tunnel; `vite.config.js` allows `.trycloudflare.com` in both `server` and `preview` for that.
- `VITE_*` env vars are inlined into the client bundle at build time — `VITE_ROBOT_API_KEY` is visible in devtools. LAN speed-bump only, not real auth.
- Fonts are split by app: Outfit/Noto Sans KR for the kiosk, IBM Plex Sans KR + Gowun Batang + Plex Mono for the guardian. Both load from one `<link>` in `index.html`.
