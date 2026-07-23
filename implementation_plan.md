# 구현 계획서 - 멀티모달 LLM 실버 케어 반려 로봇 (효도 AI 봇) S/W 프로토타입

이 문서에서는 **멀티모달 LLM 실버 케어 반려 로봇(보고 듣고 말하는 효도 AI 봇)**의 로컬 소프트웨어 프로토타입 설계 및 구현 계획을 설명합니다. 하드웨어 제품이 도착하기 전이므로, 멀티모달 상호작용과 AWS 클라우드 연동 기능을 모두 시뮬레이션할 수 있는 고성능 로컬 시뮬레이터 및 보호자 대시보드를 구축합니다. 또한 프로젝트 아키텍처 구성도와 서비스 흐름도를 별도의 이미지 파일로 생성합니다.

---

## 사용자 확인 필요 사항

> [!IMPORTANT]
> **API 키 및 AWS 설정 안내**
> - 본 프로토타입은 API 키 없이도 로컬에서 모든 핵심 기능을 시뮬레이션할 수 있는 완성도 높은 가상(Mock) 시스템을 기본 제공합니다.
> - `.env` 파일에 `GEMINI_API_KEY`를 제공하면 백엔드는 실제 Gemini 멀티모달 API를 사용해 대화 및 카메라 이미지를 직접 분석합니다. 키가 없으면 로컬 가상 응답 모드로 전환됩니다.
> - AWS 연동은 공식 `@aws-sdk` 클라이언트 코드를 기반으로 구조화되어 있습니다. 로컬 AWS 자격 증명이 있는 경우 실제 AWS 리소스와 연동이 가능하며, 없는 경우 터미널 콘솔에 가상의 AWS SDK 실행 명령어를 상세히 출력하여 향후 클라우드 배포 시 동작을 직접 눈으로 확인할 수 있도록 설계되었습니다.

---

## 제안된 변경 사항

`C:\Users\fredh\.gemini\antigravity\scratch\silver-care-robot` 디렉토리에 백엔드 서버와 프론트엔드 애플리케이션을 포함한 새 프로젝트를 생성합니다.

```
silver-care-robot/
├── package.json (프로젝트 일괄 실행용 스크립트 설정)
├── backend/
│   ├── package.json
│   ├── server.js (Express 서버, Gemini 및 AWS 시뮬레이션 로직)
│   ├── database.json (대화 기록 및 알림 데이터를 유지하는 로컬 데이터베이스)
│   └── .env (Gemini API 키 및 포트 설정)
└── frontend/
    ├── package.json
    ├── vite.config.js
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx (메인 허브, 탭 네비게이션)
        ├── index.css (다크/글래스모피즘 테마 및 페이스 애니메이션 전용 프리미엄 CSS)
        └── components/
            ├── RobotSimulator.jsx (눈 깜빡임 얼굴, Web Speech STT/TTS, 카메라 분석 시뮬레이터, 비상 버튼)
            └── GuardianDashboard.jsx (안전 진단, 과거 알림 상태 제어판, 대화 내역 피드, 감정 분포 차트, 원격 메시지 발송)
```

---

### 1. 루트 설정 및 백엔드 구축 (Node.js + Express)

#### [NEW] [package.json](file:///C:/Users/fredh/.gemini/antigravity/scratch/silver-care-robot/package.json)
클라이언트와 서버를 동시에 구동하기 위한 루트 설정 파일입니다.

#### [NEW] [server.js](file:///C:/Users/fredh/.gemini/antigravity/scratch/silver-care-robot/backend/server.js)
Express.js 기반 백엔드 API 서버입니다:
- `/api/chat`: 어르신의 음성 텍스트를 수신하여 Gemini API(또는 로컬 가상 로직)로 자연스러운 답변을 생성합니다.
- `/api/vision`: 카메라 이미지(웹캠 또는 시뮬레이터 스냅샷)를 분석하여 어르신의 감정 상태나 낙상 여부를 판별합니다.
- `/api/alerts`: 긴급 응급 상황을 처리하며 가상 AWS 호출 로그(`S3`, `SNS`, `DynamoDB`)를 출력하고 상태를 기록합니다.
- `/api/history`: 과거 대화 기록과 감정 추이 분석 데이터, 경보 내역을 반환합니다.
- `/api/remote-message`: 보호자가 어르신께 원격으로 전달할 음성 메시지를 큐에 등록합니다.

---

### 2. 프론트엔드 구축 (Vite + React)

#### [NEW] [index.css](file:///C:/Users/fredh/.gemini/antigravity/scratch/silver-care-robot/frontend/src/index.css)
글로벌 디자인 시스템 테마 파일입니다:
- 심우주 느낌의 세련된 다크 블루 배경과 선명한 녹색/적색의 상태 표시 배지.
- 대시보드 카드용 글래스모피즘 효과 적용.
- 로봇 얼굴용 눈 깜빡임, 마이크 파동, 비상등 점멸 키프레임 애니메이션 구현.

#### [NEW] [RobotSimulator.jsx](file:///C:/Users/fredh/.gemini/antigravity/scratch/silver-care-robot/frontend/src/components/RobotSimulator.jsx)
로봇의 실물 디스플레이 화면을 모사합니다:
- **반려 로봇 얼굴**: 평소에는 눈을 깜빡이고, 들을 때는 파동이 일며, 답변 시 미소를 짓고, 비상시에는 빨갛게 깜빡입니다.
- **음성 에이전트 인터페이스**:
  - 브라우저 내장 **Web Speech API (`SpeechRecognition`)**를 활용하여 직접 목소리로 대화할 수 있습니다.
  - 브라우저 **`SpeechSynthesis` (TTS)**를 사용하여 답변을 정겹고 상냥한 목소리로 읽어줍니다.
- **카메라 및 센서 시뮬레이터**:
  - 상태 설정 드롭다운 메뉴(`Smiling` 미소, `Sleeping` 취침, `Fell Down` 낙상) 제공.
  - 웹캠 사용 토글 버튼을 통해 실제 웹캠 스트림 스냅샷 업로드 테스트 지원.
  - H/W 센서 수동 격발 버튼("낙상 센서 격발", "비상 버튼 누름")으로 위급 상황을 강제 발생시킬 수 있습니다.

#### [NEW] [GuardianDashboard.jsx](file:///C:/Users/fredh/.gemini/antigravity/scratch/silver-care-robot/frontend/src/components/GuardianDashboard.jsx)
가족을 위한 원격 돌봄 모니터링 애플리케이션입니다:
- **실시간 종합 안전 진단**: 어르신의 현재 안전 여부 및 최종 기기 활동 시간을 표기합니다.
- **긴급 응급 알림 제어**: 비상사태 발생 시 선명한 적색 배너가 켜지며 사건 일시 파악 및 해제 처리가 가능합니다.
- **감정 지수 대화 피드**: 과거 대화 피드 및 감정 상태 분석 통계를 시각화합니다.
- **원격 메시지 스피커**: 약 복용 안내 메시지 등을 로봇에게 원격으로 텍스트 송신하여 즉시 목소리로 말하게 만듭니다.

---

### 3. 기술 구성도 및 흐름도 (이미지 파일 생성)
`generate_image`를 사용하여 고해상도 이미지 파일로 직접 다이어그램을 생성합니다:
1. `architecture_diagram.png`: 로컬 컴포넌트(리액트, 백엔드)와 AWS 클라우드 아키텍처 및 Gemini API 통신 구조 시각화.
2. `flowchart.png`: 음성/시각 신호 입력부터 로봇 상태 처리 및 응급 알림 분기까지의 단계별 프로세스 흐름 시각화.

---

## 검증 계획

### 수동 테스트 시나리오
1. **서버 구동**: `npm.cmd install` 완료 후 `node start-all.js` 명령어로 프론트엔드와 백엔드를 동시에 켭니다.
2. **대화 기능**: 마이크 버튼을 켜고 말을 건넨 뒤 로봇이 대답을 텍스트로 보여주고 소리로 읽어주는지 확인합니다.
3. **응급 격발 및 경보 해제**:
   - 시뮬레이터에서 '낙상 발생'을 지정하거나 '낙상 센서 격발'을 클릭합니다.
   - 로봇 얼굴이 빨갛게 깜빡이고 로컬 사이렌 경보음이 울리는지 확인합니다.
   - 백엔드 터미널 창에 가상 AWS SNS/S3/DynamoDB SDK 명령 로그가 대량으로 출력되는지 확인합니다.
   - 보호자 대시보드 탭으로 전환하여 비상 알림 배너가 떴는지 보고, 조치 완료 버튼을 눌러 정상 복구되는지 테스트합니다.
4. **이미지 파일 확인**: 프로젝트 폴더 루트에 `architecture_diagram.png`와 `flowchart.png` 파일이 정상적으로 저장되었는지 확인합니다.
