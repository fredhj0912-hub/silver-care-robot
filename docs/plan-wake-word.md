# 온디바이스 웨이크워드 — "돌봄아" 뒤에만 API를 쓴다

> **상태: 관문 ① 끝(Porcupine 탈락). 관문 ② 측정기 완성 — 숫자를 재는 일만 남았다.**
> 2026-09-07 계획 수립 / 2026-09-08 Phase 0 착수.
>
> **다음 세션 시작 방법** — 노트북에서 이렇게 하면 된다:
>
> ```
> cd frontend && npm run dev
> 브라우저에서 http://localhost:5173/?wake=1 을 연다
> ```
>
> 좌하단 오버레이가 관문 ②의 숫자를 센다. **API는 0건이다**(dryRun 강제).
> 재고 나면 아래 관문 ② 표를 채우고, 통과하면 Phase 1로 간다.
>
> **다 끝나면 이 문서를 지우고** TODO.md 의 포인터 줄도 같이 지운다 — 이력은 `git log` 에 남는다.

## Context

**지금 구조의 결함은 순서다.** 웨이크워드 판정(`frontend/src/lib/wakeword.js` 의
`decideAction()`)이 **받아쓰기 *뒤*에** 돈다. "돌봄아"인지 알려면 먼저 Gemini 에 올려야 하고,
그 순간 이미 비용이 나간다. 게이트가 닫혀 있어도 값은 지불된 뒤다 — 2026-09-02 파이에서
한 시간에 100건을 그렇게 태웠다.

09-07 에 넣은 푸시투토크는 이 결함의 **우회**였다. 마이크를 아예 닫아 두고 버튼을 눌러야
열리게 했다. 비용은 막혔지만 두 가지를 잃었다:

1. **음성 응급 경로.** `wakeword.js` 의 우회 문구 22개("살려줘" 등)가 닿을 길이 없다.
   쓰러져서 화면에 손이 못 닿는 어르신에게 남은 것은 SOS 버튼 하나뿐이다.
2. **상시 대기.** 어르신이 버튼을 누를 줄 알아야 말을 걸 수 있다.

**온디바이스 웨이크워드는 순서를 바로잡는다.** 파이가 자기 안에서 "돌봄아"를 알아듣고,
그 뒤에만 업로드한다. 잡음·TV·옆 사람 말은 파이 안에서 걸러져 **API 0건**이고, 응급 문구도
같은 방식으로 되살아난다.

**이걸 하는 이유는 결제다.** 유료 결제를 켜면 `GEMINI_DAILY_BUDGET` 이 곧 요금 상한이 되고,
그때 "방 안의 소리 = 요금"인 지금 구조는 그대로 청구서가 된다.

## 이번 범위

- ✅ **웨이크워드만.** 화자 구분(성문 인식)은 넣지 않는다 — 다른 기술이고, 감기·눈물·다급한
  목소리에서 **어르신 본인을 거부하는** 새 실패 모드를 만든다. 응급 상황이 정확히 그 순간이다.
- ✅ **푸시투토크는 폴백으로 남긴다.** 이미 만들었고 테스트가 있다(`RobotFaceDisplay.ptt.test.jsx`).
  한국어 인식률이 어르신 발음에서 안 나오면 되돌릴 곳이 있어야 한다.
- ❌ **파이 네이티브 파이썬 서비스는 1순위가 아니다.** 브라우저가 이미 마이크를 쥐고 있어
  (`server-recognizer.js` 의 `open()`), 같은 프레임을 엔진에 흘리면 **마이크 경합 자체가 없다.**
  관문 ③에서 모델 크기가 감당 안 될 때만 다시 꺼낸다.

---

## Phase 0 — 실현 가능성 확인 (API 0건. 여기서 막히면 나머지가 의미 없다)

### 관문 ① — Porcupine 라이선스 ✅ **끝났다 (2026-09-08). 탈락.**

`console.picovoice.ai` 가입까지 갈 것도 없었다. 2026-09-07에 엇갈렸던 검색 결과의 정답은 이것이다:

- **Picovoice가 2026-06-30자로 Free Tier를 폐지**했고 **기존 무료 AccessKey도 비활성화**했다.
  본인들이 **"no non-commercial tier planned"** 라고 확인했다 — 남은 건 7일 체험뿐이다.
  오늘이 09-08이므로 이미 지난 일이다. **대회 출품물에 유료 종속성을 만들지 않는다**는 원칙에 걸린다.
- 커뮤니티가 옮겨 간 대안 **openWakeWord도 우리에겐 막혔다**: 상류가 **영어 전용**이고
  (학습 데이터를 만드는 TTS가 전부 영어다) 사전학습 모델 라이선스가 **CC-BY-NC-SA(비상업)** 다.
  "20개 언어 지원"이라고 광고하는 곳들은 상류가 아니라 별개의 유료 호스팅 학습 서비스다.

⇒ **관문 ②(Vosk)로 간다.** 이 문서가 예측한 그대로다.

### 관문 ② — 한국어 정확도 🔧 **측정기 완성(09-08). 숫자를 재면 된다.**

무료 대안에는 **한국어 전용 웨이크워드 모델이 없다** — sherpa-onnx 의 KWS 사전학습 모델은
중국어·영어뿐이다(2026-09-07 확인). 그래서 오프라인 한국어 음성인식을 통째로 돌려 글자를
맞추는 방식이 된다: `vosk-browser` + `vosk-model-small-ko-0.22` (82MB, Apache-2.0, **WER 28.1**).

**WER 28.1은 자유 발화 숫자이고, 우리는 자유 발화를 안 쓴다.** 09-08에 확인한 두 가지:

1. **로컬 ASR은 "올릴지 말지"만 정한다.** 실제 받아쓰기는 통과한 오디오를 올려 Gemini가
   한다. 그래서 **로컬 WER이 대화 품질을 전혀 깎지 않는다.**
2. **문법 제한이 이 모델에서 실제로 먹는다** — `new model.KaldiRecognizer(16000, grammarJson)`.
   `wakeword.js` 의 오인식 변형 19개 + 이름 6개 + 응급 문구 22개를 `WAKE_GRAMMAR` 로 넘겨
   어휘를 그 47개(+`[unk]`)로 좁혔고, 브라우저에서 **"문법 제한"으로 뜨는 것을 확인했다.**

#### 재는 방법 (노트북. **API 0건**)

```
cd frontend && npm run dev
http://localhost:5173/?wake=1      # 문법 제한 (권장)
http://localhost:5173/?wake=free   # 자유 발화 — 문법 제한이 실제로 도움이 되는지 비교용
```

`?wake=` 는 마이크를 **상시로 열되**(TV 10분 오인식률을 재려면 필수) `dryRun` 을 강제한다 —
`/api/stt` 로 나가는 길이 아예 없다. 09-08에 발화 하나를 끝까지 처리시키고 업로드 0건을 확인했다.

좌하단 오버레이가 이렇게 센다: `발화` = VAD가 잡은 수 / `웨이크` = `containsWakeWord()` 통과 /
`응급` = `isBypassUtterance()` 통과 / 마지막 줄 = 들은 글자 · 판정까지 걸린 ms.
**판정은 기존 `wakeword.js` 가 그대로 한다** — 그래서 여기 숫자가 Phase 1의 동작을 그대로 예측한다.

#### 채울 표

| 재는 것 | 방법 | 판단 | 문법 제한 | 자유 발화 |
|---|---|---|---|---|
| **놓침률** | "돌봄아"를 20번 말해 몇 번 잡히는가 | 어르신이 두 번 불러야 하면 실패다 | ?/20 | ?/20 |
| **오인식률** | TV·라디오를 10분 틀어 놓고 몇 번 잘못 열리는가 | 열릴 때마다 예산이 샌다 | ? | ? |
| **응급 문구 놓침률** | "살려줘"·"도와줘"를 20번 | ⚠️ **안전 지표** | ?/20 | ?/20 |
| **판정 지연** | 오버레이의 ms | 길면 `vad.js` 의 `silenceMs` 부터 | ?ms | ?ms |

> ⚠️ **응급 문구 놓침률은 다른 지표들과 무게가 다르다.** 여기서 놓치면 "응급 경로가
> 돌아왔다"고 문서에 쓰면 안 된다. 오인식은 돈이 새는 것이지만 이건 사람이 다치는 쪽이다.

#### 모델 파일

레포에 **없다**(87MB, 공개 레포라 `.gitignore` 로 막았다). 각자 한 번 받아 둔다:

```bash
curl -O https://alphacephei.com/vosk/models/vosk-model-small-ko-0.22.zip
unzip vosk-model-small-ko-0.22.zip
tar -czf vosk-model-small-ko-0.22.tar.gz vosk-model-small-ko-0.22
mv vosk-model-small-ko-0.22.tar.gz frontend/public/models/
```

vosk-browser 는 **gzip tar 만** 받는다(alphacephei 는 zip 으로 준다). 아카이브 안의 최상위
폴더 이름은 상관없다 — 워커가 첫 칸을 떼고 푼다. 주소는 `VITE_WAKE_MODEL_URL` 로 바꾼다.

### 관문 ③ — 82MB 가 이 배포에서 감당되는가

**터널 주소가 재시작마다 바뀐다**(TODO 운영 메모). 브라우저 기준 다른 사이트가 되므로
캐시가 무효화되고 **모델을 처음부터 다시 받는다.**

**해법은 정해졌다(09-08): 모델을 S3 고정 주소에 올린다.** username 으로 시작하는 버킷에
공개 읽기 + CORS 로 올리고 `VITE_WAKE_MODEL_URL` 로 가리키면, 캐시 키가 터널이 아니라 S3
오리진이 되어 **터널 주소가 바뀌어도 다시 안 받는다.** 코드 변경 없이 `.env` 한 줄이다.
관문 ②를 통과한 뒤에 올린다 — 채택도 안 된 82MB를 먼저 올릴 이유가 없다.

파이에서 남는 확인은 **재다운로드 시간이 아니라 CPU** 다: 스트리밍 ASR 이 파이 5 에서
실시간을 내는지. 못 견디면 그때 파이 네이티브 서비스를 검토한다 — 모델이 SD카드에 있어
이 문제가 없다. 대신 마이크 경합과 "웨이크워드 판정이 두 곳으로 갈라지는" 문제를 떠안는다
(`backend/CLAUDE.md` 가 경고하는 바로 그것).

---

## Phase 1 — 업로드 판정을 웨이크워드 뒤로 옮긴다

> **관문 ②를 통과한 뒤에 시작한다.** 09-08 시점에 **배선의 절반은 이미 들어가 있다** —
> 어댑터(`lib/wake-engine.js`)와 프레임 공급(`server-recognizer.js`)이 그것이다.
> 남은 것은 **업로드 판정 한 줄**과 세 번째 마이크 모드다.

### 이미 들어간 것 (09-08)

- `frontend/src/lib/wake-engine.js` — 엔진 어댑터. `vosk-browser` 를 **동적 import** 한다
  (`?wake=` 없이는 wasm 도 모델도 안 받는다. 프로덕션 빌드에서 별도 청크로 갈라지는 것 확인).
  문법 제한이 안 먹으면 자유 발화로 떨어지고, 판정에 3초 시한이 있다.
- `frontend/src/lib/wake-debug.js` — `?wake=` 스위치. `vad-debug.js` 와 같은 꼴.
- `server-recognizer.js` — `wakeEngine` 을 받아 발화 프레임을 흘리고(`event.inputBuffer`
  그대로. 16kHz mono 라 변환 코드가 없다), 발화가 끝나면 `finish()` 를 불러 `onWake` 로
  **보고만 한다.** 버려진 발화도 물어본다 — 안 그러면 그 조각이 다음 발화에 섞인다.
- `wakeword.js` 의 `WAKE_GRAMMAR` export. **판정 로직은 한 줄도 안 고쳤다.**

### 남은 것 ①: 업로드 판정

`server-recognizer.js` 의 `handleFrame()`. 지금은 `onWake` 로 보고만 하고 지나간다.

```
지금:  verdict === 'ended'  →  onWake(들은 것)  →  transcribe()   // 무조건 올린다
바뀜:  verdict === 'ended'  →  웨이크워드가 열려 있나?
                              ├ 예   → transcribe()
                              └ 아니오 → dropBuffer()              // API 0건
```

⚠️ **판정이 비동기라는 것이 여기서 걸린다.** `finish()` 가 워커의 `result` 이벤트를 기다리므로
업로드 판정이 `await` 를 타야 하고, 그만큼 지연이 붙는다(침묵 900ms + 판정 ms).
`oneShot` 의 "업로드 전에 캡처를 닫는다"도 그 사이에 끼워야 한다 — 안 그러면 기다리는 동안
다음 발화가 잡힌다.

나온 글자는 **기존 `decideAction()` 에 그대로 먹인다** — 오인식 변형 19개와 응급 문구 22개가
손대지 않고 그대로 일한다. **`lib/wakeword.js` 를 한 줄도 안 고친다.**

### 남은 것 ②: `VITE_MIC_MODE='wake'` 세 번째 모드

`frontend/src/components/RobotFaceDisplay.jsx`:

- `readMicMode()` 에 `'wake'` 를 더한다. 우선순위는 지금 그대로 **URL 이 env 를 이긴다**
  (`?mic=wake` / `?mic=ptt` / `?mic=always`).
- `'wake'` 에서는 마운트 때 마이크를 연다(상시 캡처, API 0건). `?wake=` 관측이 이미
  `PTT_ACTIVE` 상수로 그 길을 내 뒀다 — **그 상수를 재사용하고 새 우회로를 만들지 말 것.**
- 웨이크워드가 울리면 **기존 `openGate()`** 를 부른다. 다만 `'wake'` 에서는 창을
  **10초 안팎으로 줄인다**(지금 `ACTIVE_WINDOW_MS` 30초). 창이 열려 있는 동안이 유일하게
  잡음이 샐 수 있는 구간이라, 짧을수록 새는 양이 준다.
- **푸시투토크 버튼은 `'wake'` 에서도 남긴다.** 웨이크워드가 안 먹힐 때의 손잡이이고,
  SOS 버튼과 함께 화면에 있어야 할 것이다.
- `stopPtt` / `beginPttCountdown` / `pttTimerRef` 는 그대로 둔다 — `'ptt'` 전용이다.

### 백엔드는 안 건드린다

예산 상한도 `/api/stt` 도 그대로다. 이 변경은 **업로드 횟수를 줄이는 것**이지 서버 계약을
바꾸는 게 아니다. 줄어든 결과는 `[QUOTA]` 로그와 `GET /api/status` 의 `usage` 에 그대로 보인다.

---

## Phase 2 — 파이 실측 (파이가 있는 날)

`?mic=wake` 로 열어 확인한다.

- 어르신 발음으로 "돌봄아" 놓침률 · TV 틀어 놓고 오인식률
- **한 시간 방치했을 때 `journalctl -u hyodol | grep QUOTA` 가 조용한지** ← 이 작업의 목적
- 웨이크워드 → 대답까지 걸리는 시간(로컬 ASR 방식이면 침묵 900ms 가 더해진다)
- **응급 문구 놓침률** — 통과 못 하면 문서에 "응급 경로가 돌아왔다"고 쓰지 않는다

---

## 건드리는 파일

**09-08에 이미 만든 것**: `frontend/src/lib/wake-engine.js`, `frontend/src/lib/wake-debug.js`,
`frontend/test/wake-engine.test.js`, `frontend/test/server-recognizer.test.js`(웨이크 배선 4건 추가),
`frontend/src/index.css`(`.wake-debug`), `frontend/package.json`(`vosk-browser`), `.gitignore`
**09-08에 고친 것**: `server-recognizer.js`(프레임 공급 + `onWake` 보고),
`stt.js`(옵션 통과), `RobotFaceDisplay.jsx`(`?wake=` 배선 · `PTT_ACTIVE`),
`wakeword.js`(`WAKE_GRAMMAR` **export 추가만**)

**Phase 1에 남은 것**: `server-recognizer.js`(`handleFrame` 의 업로드 판정),
`RobotFaceDisplay.jsx`(`readMicMode` 에 `'wake'` · 게이트 배선 · 창 길이),
`frontend/.env.example`, `frontend/CLAUDE.md`, `docs/architecture.md`(웨이크워드 게이트
그림 — 순서가 바뀐다), `TODO.md`
**끝까지 안 건드림**: `lib/wakeword.js` 의 판정 로직, `lib/vad.js`, 백엔드 전체

## 검증

**09-08에 통과한 것**:

1. `cd frontend && npm test` — **136개 통과**(126 → +10). 새 테스트가 덮는 것:
   문법 목록에 `[unk]` 가 붙는지 / 문법이 안 먹을 때 자유 발화로 떨어지되 죽지 않는지 /
   `finish()` 가 발화 사이에 글자를 안 흘리는지 / 모델 로딩이 실패해도 마이크가 계속 도는지 /
   **관측 중에 `/api/stt` 가 한 번도 안 나가는지** / **엔진이 없으면 기존 경로가 그대로인지**.
   ⚠️ `stt.js` 와 모듈 상수는 **로드 시점에 env/URL 을 붙잡는다** —
   `RobotFaceDisplay.server-stt.test.jsx` 의 `vi.stubEnv` + 동적 import 패턴을 따를 것.
2. `npm run lint` — 경고 **3건 그대로**(안 늘었다).
3. `npm run build` — 통과. **vosk 가 별도 청크(5.8MB)로 갈라져 본 번들은 287KB 그대로**다.
   `?wake=` 를 안 켜면 파이는 그 청크를 안 받는다.
4. **브라우저 육안**: `?wake=1` 로 열어 오버레이가 **"문법 제한"** 으로 뜨는 것 확인.
   발화 하나를 끝까지 처리시키고 `/api/stt` **0건** 확인(`fetch` 를 감싸 세었다).

**남은 것**: 관문 ② 표의 숫자(실물 마이크·실물 방), 그리고 파이에서의 CPU·재다운로드.

## 하지 않는 것 (의도적으로)

- **화자 구분(성문)** — 어르신 본인을 거부하는 실패 모드를 만든다
- **파이 네이티브 파이썬 서비스** — 관문 ③에서 막힐 때만
- **백엔드 변경** — 예산 상한은 그대로 두고, 이 작업의 효과를 그 숫자로 측정한다
- **푸시투토크 제거** — 폴백으로 남긴다

## 참고

**관문 ① 근거 (2026-09-08 확인)** — Porcupine 을 못 쓰는 이유:
- Picovoice Free Tier 폐지(2026-06-30, 기존 무료 AccessKey 비활성화, "no non-commercial tier planned"):
  https://community.home-assistant.io/t/fyi-picovoice-confirmed-free-tier-accesskeys-will-stop-working-after-june-30-2026/1012744
- Picovoice 가격: https://picovoice.ai/pricing/
- openWakeWord(**영어 전용** + 사전학습 모델 **CC-BY-NC-SA**): https://github.com/dscripka/openWakeWord

**쓰기로 한 것**:
- Vosk 모델 목록(`vosk-model-small-ko-0.22`, 82MB, WER 28.1, Apache-2.0. **한국어는 이것 하나뿐**):
  https://alphacephei.com/vosk/models
- vosk-browser 0.0.8 (Apache-2.0, wasm 이 번들에 인라인돼 별도 에셋이 없다):
  https://www.npmjs.com/package/vosk-browser
- 어휘 제한: https://alphacephei.com/vosk/adaptation
  (`HCLr.fst` + `Gr.fst` = 동적 그래프 = 런타임 어휘 재구성 가능. 이 한국어 모델이 그것이다)

**막다른 길이라 다시 보지 말 것**:
- sherpa-onnx KWS 사전학습 목록 — **한국어 없음**(중국어·영어뿐):
  https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html
