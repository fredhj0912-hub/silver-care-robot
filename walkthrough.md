# 워크스루 - 실버 케어 반려 로봇 로컬 프로토타입

로컬 프로젝트 디렉토리 내에 **멀티모달 LLM 실버 케어 반려 로봇(보고 듣고 말하는 효도 AI 봇)**의 고성능 로컬 소프트웨어 프로토타입 구축을 완료했습니다. 또한, 프로젝트의 기술 아키텍처 구성도와 서비스 흐름도 이미지를 생성하여 프로젝트 루트 폴더에 저장했습니다.

---

## 📂 프로젝트 구조

모든 파일이 아래 경로에 성공적으로 생성 및 설정되었습니다:
`C:\Users\fredh\.gemini\antigravity\scratch\silver-care-robot`

- **`architecture_diagram.png`**: 프로젝트 아키텍처 구성도.
- **`flowchart.png`**: 단계별 서비스 흐름도.
- **`start-all.js`**: 프론트엔드와 백엔드를 동시에 실행하는 오케스트레이터 스크립트.
- **`backend/`**: Node.js Express 서버. 대화 생성, 웹캠 분석, 가상 AWS CLI/SDK 명령 로그 출력을 수행합니다.
- **`frontend/`**: Vite + React SPA. 애니메이션 로봇 얼굴 시뮬레이터와 보호자 모니터링 대시보드를 제공합니다.

---

## 🛠️ 로컬에서 프로젝트 실행하는 방법

컴퓨터에서 애플리케이션을 실행하려면 다음 단계를 따르세요:

1. 터미널에서 **프로젝트 디렉토리로 이동**합니다:
   ```bash
   cd C:\Users\fredh\.gemini\antigravity\scratch\silver-care-robot
   ```
2. 프론트엔드와 백엔드 서비스를 **동시에 실행**합니다:
   ```bash
   node start-all.js
   ```
3. **웹 브라우저 열기**:
   - 프로토타입 시뮬레이터 및 대시보드 접속 주소: **`http://localhost:5173`**
   - 백엔드 서버 주소: **`http://localhost:3001`**

---

## 🔍 핵심 기능 안내

### 1. 🤖 대화형 로봇 시뮬레이터
- **애니메이션 SVG 얼굴**: 로봇의 감정 상태(`happy`, `sad`, `thinking`, `concerned`, `sleeping`)에 따라 눈과 얼굴 표정이 동적으로 업데이트됩니다.
- **핸즈프리 음성 상호작용 (STT / TTS)**:
  - **"할머니 말씀하기 (마이크)"** 버튼을 클릭합니다.
  - 마이크에 대고 한국어로 말씀해 보세요 (예: *"오늘 날씨는 어떠니?"*). 브라우저의 Web Speech API가 음성을 실시간으로 인식하여 텍스트로 변환합니다.
  - 로컬 서버가 다정한 답변을 생성하면, 브라우저의 음성 합성(TTS) 엔진이 어르신이 듣기 편하도록 조금 느린 속도로 답변을 읽어 드립니다.
- **웹캠 및 시뮬레이터 분석**:
  - **"실제 웹캠 사용"**을 체크하여 노트북/컴퓨터 웹캠을 켜고 스냅샷을 캡처해 백엔드에 업로드할 수 있습니다.
  - 웹캠이 없거나 테스트 목적으로 어르신의 상태를 직접 지정하려면 시뮬레이터 드롭다운 메뉴(예: `Sleeping` 취침, `Fell Down` 낙상)를 사용하면 됩니다.
  - **"실시간 영상 캡쳐 & AI 분석"**을 클릭하면 비주얼 분석이 시작됩니다.

### 2. 🛡️ 보호자 안심 대시보드
- **긴급 응급 알림 피드**: 낙상이나 비상 버튼이 작동하면 대시보드에 빨간색 비상 경보 배너가 깜빡입니다. 보호자는 세부 사항을 확인한 후 **"상황 해결 및 경보 해제"**를 클릭하여 로봇의 상태를 정상으로 리셋할 수 있습니다.
- **주간 요약 보고서**: 어르신의 감정 상태 비율(기쁨/미소 vs. 보통/평온 vs. 우울/고통)을 보여주는 동적인 커스텀 차트가 내장되어 있습니다.
- **원격 음성 방송**: 보호자가 원격 메시지 입력란에 전달할 말을 입력하고 전송하면, 로봇 시뮬레이터가 이를 수신하여 어르신에게 TTS 목소리로 직접 말해줍니다.

### 3. ☁️ AWS 클라우드 SDK 콘솔 출력
어르신 낙상이 감지되거나 비상 호출 버튼을 누르면 백엔드 서버 콘솔에 클라우드 연동 시 실제로 전송될 AWS SDK 호출 명령의 상세 정보가 로그로 출력됩니다:
- **`S3Client.send(new PutObjectCommand(...))`**: 카메라 캡처 스냅샷을 S3 버킷에 업로드.
- **`SNSClient.send(new PublishCommand(...))`**: 보호자 연락처로 즉각적인 응급 문자(SMS) 발송.
- **`DynamoDBClient.send(new PutItemCommand(...))`**: 과거 기록 조회를 위해 알림 로그를 DynamoDB 테이블에 저장.

---

## 🖼️ 기술 다이어그램 안내

프로젝트 폴더 내에 고해상도 다이어그램 이미지 파일이 저장되어 있습니다:

1. **시스템 구성도**: [architecture_diagram.png](file:///C:/Users/fredh/.gemini/antigravity/scratch/silver-care-robot/architecture_diagram.png)
2. **서비스 흐름도**: [flowchart.png](file:///C:/Users/fredh/.gemini/antigravity/scratch/silver-care-robot/flowchart.png)

> [!TIP]
> **작업 공간 추천**
> 코드를 실행하고 커스터마이징하려면 IDE(예: VS Code)에서 **`C:\Users\fredh\.gemini\antigravity\scratch\silver-care-robot`** 디렉토리를 작업 공간으로 설정하고 여시는 것을 추천합니다.
