# 낙상 감지 서비스 인수인계

이 문서는 다음 라운드에서 실제 YOLOv8 낙상 감지를 붙일 때 필요한 계약과 참고 자료를 정리한다. 이번 단계에서는 **인터페이스와 파이프라인만 완성**했고, 실제 모델 추론은 구현하지 않았다.

전체 시스템 구조와 응급 알림 흐름은 `docs/architecture.md` 참고.

## 지금 있는 것 / 없는 것

**있음** — `backend/src/routes/vision.js`, `backend/src/services/emergency.js`
- `POST /api/detections` — 감지기 → 백엔드 이벤트 수신구 (아래 계약 참고)
- 신뢰도 임계값(`DETECTION_THRESHOLD`, 기본 0.7) 판정, 쿨다운, 알림 생성, SSE 통지까지 전체 파이프라인 완성
- `backend/scripts/mock-detector.js` — 이 계약으로 CLI에서 낙상 이벤트를 흉내내는 스크립트
- `backend/src/services/snapshots.js` — 감지 시점 스냅샷을 파일로 저장

**없음**
- 실제 카메라 프레임에서 사람을 찾고 포즈를 추정하는 코드 (YOLOv8, MediaPipe 전부 없음)
- Python 프로세스/서비스 자체가 저장소에 없다 (`backend/`는 Node.js뿐)
- 라즈베리파이 엣지 최적화(TFLite 변환, 프레임 스킵 등)

## 참고 저장소

- 주 참고: https://github.com/alijawad07/fall_detection_yolov8
- 보조 참고: https://github.com/rhafaelc/Fall-Detection-YOLO-MediaPipe

## 권장 파이프라인

```
카메라 프레임
  → YOLOv8n (사람 감지, bounding box)
  → MediaPipe Pose (33개 신체 랜드마크 추출)
  → 규칙 기반 1차 판정: 토르소 기울기 각도 + 수직 속도
  → (선택) LSTM 시퀀스 분류기로 2차 판정 — 순간적인 자세 변화(눕기, 앉기)와
    실제 낙상을 구분하는 데 규칙 기반보다 유리하다
  → confidence 산출 → POST /api/detections
```

라즈베리파이 5 엣지 환경에서는 YOLOv8n을 TFLite로 경량화하는 것을 권장한다(원본 저장소에 변환 스크립트 참고).

## `POST /api/detections` 계약

Python 서비스가 백엔드로 보내야 하는 요청 형태. `backend/scripts/mock-detector.js`가 정확히 이 형태를 만든다 — 실제 감지기를 짤 때 이 스크립트를 참고 구현으로 삼으면 된다.

```jsonc
POST /api/detections
Headers: { "x-api-key": "<ROBOT_API_KEY>", "Content-Type": "application/json" }
Body:
{
  "source": "fall_yolov8",              // 감지기 식별자 — 자유 문자열
  "type": "fall",                        // "fall" | "no_motion" | "abnormal_posture"
  "confidence": 0.92,                    // 0.0 ~ 1.0
  "detectedAt": "2026-08-26T04:10:00Z",  // 선택. 생략 시 서버 수신 시각 사용
  "snapshot": "data:image/jpeg;base64,...",  // 선택. 감지 순간 프레임
  "meta": {                              // 선택. 자유 형식 — 임계값 튜닝 근거로 그대로 저장됨
    "torsoAngle": 78.4,
    "verticalVelocity": 1.42,
    "keypointCount": 33
  }
}
```

**응답**:
```jsonc
{
  "detectionId": 42,
  "accepted": true,
  "alertRaised": true,          // confidence가 임계값 이상이면 true
  "alert": { "id": 24 },        // 알림이 만들어졌으면 그 id
  "threshold": 0.7
}
```

**동작 원칙**:
- `confidence`가 `DETECTION_THRESHOLD`(기본 0.7, `backend/.env`로 조정) 미만이면 **기록만 하고 알림은 만들지 않는다**. 이 기록은 버려지지 않고 `detections` 테이블에 남아 나중에 임계값을 튜닝할 근거가 된다 — 오탐이 잦으면 임계값을 올리고, 놓치는 낙상이 있으면 내린다.
- 같은 유형(`fall_detected` 등) 알림은 `ALERT_COOLDOWN_MS`(기본 10분) 안에는 중복 생성되지 않는다. 감지기가 초당 여러 번 신호를 보내도 알림이 도배되지 않는다.
- `snapshot`을 보내면 `backend/data/snapshots/`에 파일로 저장되고 알림에 경로가 남는다. **base64를 잘라서 저장하지 않는다** — 이전 버전의 실수였다(스냅샷이 열리지 않는 조각으로 저장됐었다).
- 인증은 다른 API와 동일하게 `x-api-key` 헤더(`ROBOT_API_KEY`)를 쓴다.

## 감지기 서비스를 어떻게 붙일지

`start-all.js`(루트 오케스트레이터)가 지금은 backend + frontend 두 프로세스만 띄운다. Python 감지기를 붙일 때는:

1. 별도 디렉터리(예: `detector/`)에 FastAPI 또는 단순 루프 스크립트로 작성
2. 감지 결과를 위 계약대로 `POST /api/detections`에 보내기만 하면 된다 — 백엔드 내부 구조를 알 필요가 없다
3. `start-all.js`에 세 번째 child process로 추가

## 테스트 방법 (지금 가능한 것)

실제 모델 없이도 전체 파이프라인(감지 → 알림 → SSE → 화면 전환)을 끝까지 확인할 수 있다:

```bash
npm --prefix backend run mock-detector -- --type fall --confidence 0.92
npm --prefix backend run mock-detector -- --confidence 0.3   # 임계값 미만 → 기록만
```
