# PPT 발표용 핵심 소스코드 정리 (3페이지 분량)

발표 자료(PPT)에 바로 복사하여 붙여넣으실 수 있도록 주석과 핵심 라인 위주로 컴팩트하게 정리한 코드입니다.

---

## 📄 Slide 1. 프론트엔드 실시간 음성 제어 알고리즘 (Web Speech STT/TTS)
* **파일명**: `frontend/src/components/RobotSimulator.jsx` (단말기 음성 입출력 제어)
* **설명**: 브라우저 표준 마이크를 통해 어르신 음성을 텍스트화(STT)하고, 생성된 답변을 0.85배속의 다정한 목소리(TTS)로 재생하는 프론트엔드 핵심 오디오 루프입니다.

```javascript
// 1. Web Speech API 음성인식 (STT) 활성화 및 설정
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  const rec = new SpeechRecognition();
  rec.continuous = false; // 단발형 대화 설정
  rec.lang = 'ko-KR';     // 한국어 설정
  rec.interimResults = false;

  rec.onstart = () => {
    setIsListening(true);
    setSpeechTranscript('듣고 있어요...');
    setRobotEmotion('thinking'); // 대기 표정 전환
  };

  rec.onresult = (event) => {
    const resultText = event.results[0][0].transcript;
    setSpeechTranscript(resultText);
    sendVoiceMessage(resultText); // 백엔드 API 송신
  };
}

// 2. 어르신 맞춤형 음성합성 (TTS) 재생 로직
const speakText = (text) => {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel(); // 진행중인 음성 중단

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ko-KR';
  
  // 한국어 정격 보이스 탐색 및 지정
  const voices = window.speechSynthesis.getVoices();
  const koVoice = voices.find(v => v.lang.includes('KO') || v.lang.toLowerCase().includes('kr'));
  if (koVoice) utterance.voice = koVoice;
  
  utterance.rate = 0.85; // 고령층 인지를 돕기 위한 0.85 배속 감속 재생
  utterance.pitch = 1.0;
  
  utterance.onstart = () => setRobotEmotion('happy'); // 말하는 도중 미소 표정
  utterance.onend = () => setRobotEmotion('neutral'); // 종료 후 기본 표정

  window.speechSynthesis.speak(utterance);
};
```

---

## 📄 Slide 2. 백엔드 Gemini Vision API 멀티모달 분석 알고리즘
* **파일명**: `backend/server.js` (실시간 카메라 스냅샷 비전 판독)
* **설명**: 기기 카메라 모듈에서 전송받은 Base64 이미지를 디코딩하여 Gemini 멀티모달 비전 모델에 전송하고 낙상 여부(`isEmergency`) 및 정서 상태를 판정하는 백엔드 비전 로직입니다.

```javascript
// 카메라 캡처 스냅샷 AI 비전 분석 엔드포인트
app.post('/api/vision', async (req, res) => {
  const { image } = req.body; // Base64 포맷 JPEG 이미지 수신
  const apiKey = process.env.GEMINI_API_KEY;

  if (GoogleGenAI && apiKey) {
    try {
      const genAI = new GoogleGenAI(apiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
      
      // Base64 문자열을 바이너리 버퍼 객체로 복원
      const buffer = Buffer.from(image.split(',')[1], 'base64');
      const imagePart = {
        inlineData: { data: buffer.toString('base64'), mimeType: 'image/jpeg' }
      };

      const prompt = `어르신 방 안의 웹캠 스냅샷입니다. 노약자 복지 상태를 체크해 주세요.
      결과는 엄격하게 아래 JSON 포맷으로만 응답해 주세요:
      {
        "hasPerson": 인물 감지 여부 (true/false),
        "isEmergency": 낙상/쓰러짐 비상상태 여부 (true/false),
        "expression": 얼굴 표정 감정 상태 ('happy', 'sad', 'pain' 등),
        "summary": "어르신에 대한 한국어 요약 설명 1문장"
      }`;

      const result = await model.generateContent([prompt, imagePart]);
      const parsed = JSON.parse(result.response.text());
      
      // 낙상 위급 상황 판정 시 전역 비상 모드 가동
      if (parsed.isEmergency) {
        db.status.isEmergency = true;
        logAWSIntegration(parsed, image); // AWS 클라우드 연동 트리거
      }
      res.json(parsed);
    } catch (err) {
      console.error('AI 분석 실패, 로컬 폴백 가동', err);
    }
  }
});
```

---

## 📄 Slide 3. 클라우드 연동 가상 AWS SDK 알림 파이프라인
* **파일명**: `backend/server.js` (S3 업로드, SNS 단문 발송, DynamoDB 저장)
* **설명**: 기기 비상 상황 발생 시 호출되는 실제 AWS 클라우드 SDK 모듈 연결 규격을 시뮬레이션 및 로깅하여 이관 준비성을 확보한 알고리즘입니다.

```javascript
// 위급 상황 감지 시 클라우드 통합 알림 전송 (AWS SDK 연동 모사)
function logAWSIntegration(alertDetail, base64Image) {
  
  // 1. Amazon S3: 캡처된 낙상 현장 스냅샷 보안 업로드
  console.log(`[AWS S3] Uploading Snapshot to S3 Bucket...`);
  const s3Key = `alerts/snapshot_${Date.now()}.jpg`;
  console.log(`   - Command: S3Client.send(new PutObjectCommand({
       Bucket: "silver-care-robot-storage-bucket",
       Key: "${s3Key}",
       Body: [Binary Buffer Length: ${base64Image.length} bytes],
       ContentType: "image/jpeg"
     }))`);
  
  // 2. Amazon SNS: 보호자 모바일 기기로 비상 경고 문자(SMS) 즉시 전송
  console.log(`[AWS SNS] Publishing Emergency Alert Message to Topic/SMS...`);
  const smsMessage = `[위급상황] 효돌이 낙상 감지: ${alertDetail.description}. 모니터링 페이지를 확인하세요!`;
  console.log(`   - Command: SNSClient.send(new PublishCommand({
       TopicArn: "arn:aws:sns:ap-northeast-2:123456789012:SilverCareEmergencyTopic",
       Message: "${smsMessage}",
       MessageAttributes: { Importance: 'High' }
     }))`);
  
  // 3. Amazon DynamoDB: 기록 추적을 위한 데이터베이스 테이블 이력 보존
  console.log(`[AWS DynamoDB] Saving Alert Record to Table...`);
  console.log(`   - Command: DynamoDBClient.send(new PutItemCommand({
       TableName: "SilverCareAlerts",
       Item: {
         AlertID: { S: "${Math.random().toString(36).substring(2, 10).toUpperCase()}" },
         Timestamp: { S: "${new Date().toISOString()}" },
         Type: { S: "${alertDetail.type}" },
         Resolved: { BOOL: false }
       }
     }))`);
}
```
