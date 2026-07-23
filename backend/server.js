const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Try to require Google Generative AI SDK, fallback to mock if not installed or fails
let GoogleGenAI;
try {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  GoogleGenAI = GoogleGenerativeAI;
} catch (e) {
  console.log('Google Generative AI SDK not loaded. Using local mock services.');
}

const app = express();
const PORT = process.env.PORT || 3001;
const DB_PATH = path.join(__dirname, 'database.json');

// In-memory cache for the latest camera snapshot (CCTV stream)
let latestSnapshot = null;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// HTTP Security Headers Middleware to prevent clickjacking and XSS
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Helper to read database
function readDB() {
  try {
    const data = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading database file, returning defaults.', err);
    return { status: { status: "online", battery: 100, lastActive: new Date().toISOString(), seniorExpression: "neutral", isEmergency: false }, history: [], alerts: [], remoteMessages: [] };
  }
}

// Helper to write database
function writeDB(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing database file.', err);
  }
}

// Simulated AWS Command Logger
function logAWSIntegration(alertDetail, base64Image) {
  console.log('\n========================================================================');
  console.log('📡 [LOCAL SIMULATION] CONNECTING TO AWS CLOUD SERVICES...');
  console.log('========================================================================');
  
  // 1. Amazon S3 Upload Simulation
  console.log(`[AWS S3] Uploading Snapshot to S3 Bucket...`);
  const s3Key = `alerts/snapshot_${Date.now()}.jpg`;
  console.log(`   - Command: S3Client.send(new PutObjectCommand({ ... }))`);
  console.log(`   - Target Bucket: "silver-care-robot-storage-bucket"`);
  console.log(`   - Object Key: "${s3Key}"`);
  console.log(`   - Content-Type: "image/jpeg"`);
  console.log(`   - Data: [Binary Buffer Length: ${base64Image ? base64Image.length : 0} bytes]`);
  console.log(`   - Result: HTTP 200 OK (https://silver-care-robot-storage-bucket.s3.ap-northeast-2.amazonaws.com/${s3Key})`);
  
  // 2. Amazon SNS Notification Simulation
  console.log(`\n[AWS SNS] Publishing Emergency Alert Message to Topic/SMS...`);
  const smsMessage = `[위급상황 알림] 효도 AI 봇 감지: ${alertDetail.description || '낙상 감지'}. 일시: ${new Date().toLocaleString('ko-KR')}. 즉시 모니터링 대시보드를 확인하세요!`;
  console.log(`   - Command: SNSClient.send(new PublishCommand({ ... }))`);
  console.log(`   - TopicArn: "arn:aws:sns:ap-northeast-2:123456789012:SilverCareEmergencyTopic"`);
  console.log(`   - Target Phone: "+82 10-XXXX-XXXX"`);
  console.log(`   - Message: "${smsMessage}"`);
  console.log(`   - MessageAttributes: { Importance: 'High', DataType: 'String' }`);
  console.log(`   - Result: Published (MessageId: "${Math.random().toString(36).substring(2, 15)}")`);
  
  // 3. Amazon DynamoDB Database logging Simulation
  console.log(`\n[AWS DynamoDB] Saving Alert Record to Table...`);
  console.log(`   - Command: DynamoDBClient.send(new PutItemCommand({ ... }))`);
  console.log(`   - TableName: "SilverCareAlerts"`);
  console.log(`   - Item: {`);
  console.log(`       AlertID: { S: "${Math.random().toString(36).substring(2, 10).toUpperCase()}" },`);
  console.log(`       Timestamp: { S: "${new Date().toISOString()}" },`);
  console.log(`       RobotID: { S: "BOT-HYODO-001" },`);
  console.log(`       Type: { S: "${alertDetail.type}" },`);
  console.log(`       Description: { S: "${alertDetail.description}" },`);
  console.log(`       Resolved: { BOOL: false },`);
  console.log(`       SnapshotURL: { S: "https://silver-care-robot-storage-bucket.s3.ap-northeast-2.amazonaws.com/${s3Key}" }`);
  console.log(`     }`);
  console.log(`   - Result: Item Saved Successfully (HTTP 200 OK)`);
  console.log('========================================================================\n');
}

// Initialize database file if it doesn't exist
if (!fs.existsSync(DB_PATH)) {
  writeDB({
    status: { status: "online", battery: 92, lastActive: new Date().toISOString(), seniorExpression: "neutral", isEmergency: false },
    history: [],
    alerts: [],
    remoteMessages: []
  });
}

// ---------------------------------------------------------
// Express REST API Endpoints
// ---------------------------------------------------------

// Default root landing page showing server status
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>효돌이 백엔드 서버 상태</title>
        <style>
          body { font-family: sans-serif; background: #0a0b10; color: #f8fafc; padding: 3rem; text-align: center; }
          .card { background: #121420; padding: 2rem; border-radius: 12px; display: inline-block; border: 1px solid rgba(255,255,255,0.08); }
          h1 { color: #5c64ec; }
          .badge { background: #10b981; color: white; padding: 0.3rem 0.6rem; border-radius: 4px; font-size: 0.8rem; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>🤖 효돌이 백엔드 API 서버</h1>
          <p>상태: <span class="badge">정상 작동 중 (Running)</span></p>
          <p>포트: 3001</p>
          <p style="color: #64748b; font-size: 0.9rem; margin-top: 1.5rem;">
            프론트엔드 시뮬레이터 웹앱을 열어주세요:<br/>
            <a href="http://localhost:5173" style="color: #5c64ec; text-decoration: none; font-weight: bold;">http://localhost:5173</a>
          </p>
        </div>
      </body>
    </html>
  `);
});

// Get current system status & stats
app.get('/api/status', (req, res) => {
  const db = readDB();
  db.status.lastActive = new Date().toISOString();
  writeDB(db);
  res.json(db.status);
});

// Update battery status or other minor statuses
app.post('/api/status', (req, res) => {
  const db = readDB();
  const { battery, seniorExpression } = req.body;
  if (battery !== undefined) db.status.battery = battery;
  if (seniorExpression !== undefined) db.status.seniorExpression = seniorExpression;
  db.status.lastActive = new Date().toISOString();
  writeDB(db);
  res.json(db.status);
});

// Get log history (conversation history & alerts)
app.get('/api/history', (req, res) => {
  const db = readDB();
  res.json({
    history: db.history || [],
    alerts: db.alerts || []
  });
});

// Post a chat message from senior to robot (STT transcript processed via LLM)
app.post('/api/chat', async (req, res) => {
  const { text, seniorExpression } = req.body;
  
  // Input Validation
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Text prompt is required and must be a string' });
  }
  if (text.length > 1000) {
    return res.status(400).json({ error: 'Text prompt cannot exceed 1000 characters' });
  }
  if (seniorExpression && typeof seniorExpression !== 'string') {
    return res.status(400).json({ error: 'Senior expression must be a string' });
  }

  const db = readDB();
  const timestamp = new Date().toISOString();

  // 1. Log senior's message
  const seniorMsg = {
    id: db.history.length + 1,
    timestamp,
    sender: 'senior',
    text,
    emotion: seniorExpression || 'neutral'
  };
  db.history.push(seniorMsg);

  let responseText = '';
  let robotEmotion = 'neutral';

  // 2. Process with real Gemini API if key is available
  const apiKey = process.env.GEMINI_API_KEY;
  if (GoogleGenAI && apiKey) {
    try {
      console.log('Sending query to real Gemini API...');
      const genAI = new GoogleGenAI(apiKey);
      // Using gemini-3.5-flash as default fast model
      const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
      
      const prompt = `당신은 독거 어르신을 케어하고 말동무가 되어 드리는 귀여운 효도 AI 반려 로봇 '효돌이'입니다.
어르신의 감정 상태는 현재 '${seniorExpression || 'neutral'}' 입니다.
어르신의 말씀: "${text}"

어르신께 아주 다정하고 상냥하며, 귀엽고 친근한 목소리로 한국어로 답변해 주세요. 대답은 2~3문장 정도로 간결하고 알기 쉽게 작성하세요.
그리고 대답에 맞춘 반려 로봇의 감정 표현을 단어 하나로 골라주세요: [happy, neutral, sad, concerned, thinking].

출력 결과는 아래의 JSON 형식으로만 응답해 주세요. 다른 텍스트는 포함하지 마십시오:
{
  "text": "답변 내용",
  "emotion": "감정 단어"
}`;

      const result = await model.generateContent(prompt);
      const resultText = result.response.text();
      
      // Parse JSON from code blocks or raw response
      const jsonStart = resultText.indexOf('{');
      const jsonEnd = resultText.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const jsonStr = resultText.substring(jsonStart, jsonEnd + 1);
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed.text === 'string') {
          responseText = parsed.text.trim();
        }
        if (parsed && typeof parsed.emotion === 'string') {
          const allowed = ['happy', 'neutral', 'sad', 'concerned', 'thinking'];
          robotEmotion = allowed.includes(parsed.emotion) ? parsed.emotion : 'neutral';
        }
      } else {
        responseText = resultText.trim();
      }
    } catch (err) {
      console.error('Gemini API call failed, falling back to mock logic.', err);
    }
  }

  // 3. Fallback Mock Dialogue Logic (if API key not present or call failed)
  if (!responseText) {
    robotEmotion = 'happy';
    
    // Alert triggers based on speech content
    if (text.includes('아프') || text.includes('가슴') || text.includes('숨') || text.includes('넘어져')) {
      responseText = '할머니, 몸이 많이 불편하신가요? 걱정돼요. 제가 보호자님께 연락을 드리고 응급 상황을 알려드릴게요. 무리하게 움직이지 마시고 가만히 누워 계세요!';
      robotEmotion = 'concerned';
      
      // Auto trigger emergency alert in mock db
      db.status.isEmergency = true;
      const newAlert = {
        id: db.alerts.length + 1,
        timestamp: new Date().toISOString(),
        type: 'voice_trigger',
        description: `어르신 음성 위급 감지: "${text}"`,
        resolved: false,
        resolvedAt: null,
        snapshotUrl: null
      };
      db.alerts.push(newAlert);
      logAWSIntegration(newAlert, null);
    } 
    // Weather
    else if (text.includes('날씨') || text.includes('비') || text.includes('눈') || text.includes('더워') || text.includes('추워')) {
      responseText = '오늘 날씨는 아주 화창해요! 방 안 환기를 한번 시켜주시면 상쾌해질 것 같아요. 조금 있다 같이 가벼운 손체조를 해볼까요?';
      robotEmotion = 'happy';
    } 
    // Food/Meal
    else if (text.includes('밥') || text.includes('배고파') || text.includes('식사') || text.includes('먹었')) {
      responseText = '할머니, 건강을 위해서 식사는 제때 꼭 챙겨 드셔야 해요. 따뜻하고 맛있는 밥 챙겨 드셨을까요? 물도 한 잔 잊지 마세요!';
      robotEmotion = 'happy';
    } 
    // Loneliness/Boredom
    else if (text.includes('심심') || text.includes('외로') || text.includes('노래') || text.includes('말동무')) {
      responseText = '제가 곁에 늘 있으니 외로워하지 마세요! 언제든 저에게 말을 걸어주시면 재밌는 이야기도 들려드릴게요. 트로트 한 곡 같이 들으실래요?';
      robotEmotion = 'happy';
    } 
    // Greetings/Affection
    else if (text.includes('안녕') || text.includes('고마워') || text.includes('사랑')) {
      responseText = '헤헤, 저도 할머니가 세상에서 제일 좋고 고마워요! 오늘도 저랑 즐겁게 지내요. 사랑해요!';
      robotEmotion = 'happy';
    } 
    // Default fallback
    else {
      responseText = `할머니께서 "${text}"라고 말씀해 주셨군요! 어르신 말씀 잘 기억해 둘게요. 오늘 하루 기분은 좀 어떠신가요?`;
      robotEmotion = 'neutral';
    }
  }

  // 4. Save Robot Message
  const robotMsg = {
    id: db.history.length + 1,
    timestamp: new Date().toISOString(),
    sender: 'robot',
    text: responseText,
    emotion: robotEmotion
  };
  db.history.push(robotMsg);
  
  db.status.seniorExpression = seniorExpression || 'neutral';
  writeDB(db);

  res.json({
    text: responseText,
    emotion: robotEmotion
  });
});

// Analyze image from camera (simulated snapshot upload or real webcam capture)
app.post('/api/vision', async (req, res) => {
  const { image, simulatedState } = req.body;
  
  // Input Validation
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'Image data is required and must be a Base64 data URI string' });
  }
  if (!image.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Image must be a valid data URI (starting with data:image/)' });
  }
  if (image.length > 20000000) { // Limit to ~15MB base64 payload
    return res.status(400).json({ error: 'Image payload size exceeds the 15MB limit' });
  }

  // Update real-time CCTV cache in memory
  latestSnapshot = image;

  const db = readDB();
  const apiKey = process.env.GEMINI_API_KEY;

  let hasPerson = true;
  let isEmergency = false;
  let expression = 'neutral';
  let summary = '어르신 생활 모니터링 중';

  // 1. Process via Gemini Multimodal Vision API if available and simulatedState is not set to force mock
  if (GoogleGenAI && apiKey && !simulatedState) {
    try {
      console.log('Analyzing image using real Gemini Vision API...');
      const genAI = new GoogleGenAI(apiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
      
      const buffer = Buffer.from(image.split(',')[1], 'base64');
      const imagePart = {
        inlineData: {
          data: buffer.toString('base64'),
          mimeType: 'image/jpeg'
        }
      };

      const prompt = `This is a camera stream snapshot from a senior care home companion robot.
Analyze this image to check the welfare of the senior citizen.
Provide the response strictly in JSON format with the following keys:
- hasPerson: boolean (true if a person is visible, false if the room is empty)
- isEmergency: boolean (true if the person has fallen on the floor, is in visible pain, or is laying in a highly abnormal position, false otherwise)
- expression: string (one of: 'happy', 'sad', 'neutral', 'pain', 'sleeping', or 'unknown')
- summary: string (a short, 1-sentence Korean description of the scene)

Response JSON format:
{
  "hasPerson": true/false,
  "isEmergency": true/false,
  "expression": "happy" or others,
  "summary": "어르신이 침대에 누워 편안하게 주무시고 계십니다."
}`;

      const result = await model.generateContent([prompt, imagePart]);
      const resultText = result.response.text();
      
      const jsonStart = resultText.indexOf('{');
      const jsonEnd = resultText.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const jsonStr = resultText.substring(jsonStart, jsonEnd + 1);
        const parsed = JSON.parse(jsonStr);
        if (parsed) {
          hasPerson = typeof parsed.hasPerson === 'boolean' ? parsed.hasPerson : true;
          isEmergency = typeof parsed.isEmergency === 'boolean' ? parsed.isEmergency : false;
          if (typeof parsed.expression === 'string') {
            const allowed = ['happy', 'sad', 'neutral', 'pain', 'sleeping', 'unknown'];
            expression = allowed.includes(parsed.expression) ? parsed.expression : 'neutral';
          }
          if (typeof parsed.summary === 'string') {
            summary = parsed.summary.trim();
          }
        }
      }
    } catch (err) {
      console.error('Gemini Vision API failed. Falling back to simulator logic.', err);
    }
  }

  // 2. Local Simulator States (Overrides or Fallbacks)
  if (simulatedState) {
    console.log(`Using simulated simulator state: ${simulatedState}`);
    if (simulatedState === 'fell_down') {
      hasPerson = true;
      isEmergency = true;
      expression = 'pain';
      summary = '⚠️ 낙상 위급 상황 감지: 어르신이 거실 바닥에 쓰러져 누워 계십니다!';
    } else if (simulatedState === 'smiling') {
      hasPerson = true;
      isEmergency = false;
      expression = 'happy';
      summary = '어르신이 활짝 웃으며 로봇을 바라보고 계십니다. 정서 안정 상태.';
    } else if (simulatedState === 'sleeping') {
      hasPerson = true;
      isEmergency = false;
      expression = 'sleeping';
      summary = '어르신이 침대에서 편안하게 낮잠을 청하고 계십니다.';
    } else if (simulatedState === 'sad') {
      hasPerson = true;
      isEmergency = false;
      expression = 'sad';
      summary = '어르신이 다소 쓸쓸하고 우울한 표정으로 휠체어에 앉아 계십니다.';
    } else if (simulatedState === 'empty') {
      hasPerson = false;
      isEmergency = false;
      expression = 'unknown';
      summary = '거실에 사람이 없습니다. 로봇이 충전 스테이션 근처에서 순찰 중입니다.';
    }
  }

  // 3. Handle Emergency Flow
  if (isEmergency) {
    db.status.isEmergency = true;
    
    // Log new alert
    const newAlert = {
      id: db.alerts.length + 1,
      timestamp: new Date().toISOString(),
      type: 'fall_sensor',
      description: summary,
      resolved: false,
      resolvedAt: null,
      snapshotUrl: `data:image/jpeg;base64,${image.split(',')[1] ? image.split(',')[1].substring(0, 100) : ''}...` // truncate for local db storage
    };
    db.alerts.push(newAlert);
    
    // Output simulated AWS logs to the terminal console
    logAWSIntegration(newAlert, image);
  }

  db.status.seniorExpression = expression;
  writeDB(db);

  res.json({
    hasPerson,
    isEmergency,
    expression,
    summary
  });
});

// Get the latest camera snapshot for CCTV monitoring
app.get('/api/vision/latest', (req, res) => {
  res.json({ image: latestSnapshot });
});

// Force trigger emergency alert from front-end button
app.post('/api/alerts', (req, res) => {
  const { type, description, image } = req.body;
  const db = readDB();
  
  db.status.isEmergency = true;
  const newAlert = {
    id: db.alerts.length + 1,
    timestamp: new Date().toISOString(),
    type: type || 'manual_panic_button',
    description: description || '사용자 긴급 비상 버튼 수동 조작',
    resolved: false,
    resolvedAt: null,
    snapshotUrl: image || null
  };
  
  db.alerts.push(newAlert);
  writeDB(db);
  
  // Console log AWS
  logAWSIntegration(newAlert, image);
  
  res.json({ success: true, alert: newAlert });
});

// Resolve emergency alert
app.post('/api/alerts/resolve', (req, res) => {
  const { id } = req.body;
  const db = readDB();
  
  let found = false;
  db.alerts = db.alerts.map(alert => {
    if (alert.id === Number(id)) {
      alert.resolved = true;
      alert.resolvedAt = new Date().toISOString();
      found = true;
    }
    return alert;
  });
  
  // If all alerts are resolved, set status emergency to false
  const activeAlerts = db.alerts.filter(a => !a.resolved);
  if (activeAlerts.length === 0) {
    db.status.isEmergency = false;
  }
  
  writeDB(db);
  res.json({ success: found, isEmergency: db.status.isEmergency });
});

// Guardian sends a remote message (e.g. reminder) to play as TTS on the robot
app.post('/api/remote-message', (req, res) => {
  const { text } = req.body;
  
  // Input Validation
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Text message is required and must be a string' });
  }
  if (text.length > 500) {
    return res.status(400).json({ error: 'Text message cannot exceed 500 characters' });
  }

  const db = readDB();
  const newMsg = {
    id: Math.random().toString(36).substring(2, 9),
    text,
    timestamp: new Date().toISOString()
  };
  db.remoteMessages.push(newMsg);
  
  db.history.push({
    id: db.history.length + 1,
    timestamp: new Date().toISOString(),
    sender: 'guardian',
    text: text,
    emotion: 'neutral'
  });
  
  writeDB(db);
  res.json({ success: true, message: newMsg });
});

// Robot polls for remote messages to speak
app.get('/api/remote-message/poll', (req, res) => {
  const db = readDB();
  if (db.remoteMessages && db.remoteMessages.length > 0) {
    const nextMsg = db.remoteMessages.shift(); // take first
    writeDB(db);
    return res.json({ message: nextMsg });
  }
  res.json({ message: null });
});

// Generic fallback error-handling middleware to prevent stack traces exposure (A05: Security Misconfiguration)
app.use((err, req, res, next) => {
  console.error('Unhandled internal server error:', err.stack || err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🤖 Silver Care Robot Local Backend is running!`);
  console.log(`   URL: http://localhost:${PORT}`);
  console.log(`   Database File: ${DB_PATH}`);
  if (!process.env.GEMINI_API_KEY) {
    console.log(`------------------------------------------------------`);
    console.log(`⚠️  [INFO] GEMINI_API_KEY is currently empty in .env.`);
    console.log(`   Webcam vision & voice will run in MOCK SIMULATION mode.`);
    console.log(`   To enable real AI, get a FREE API key from Google AI Studio:`);
    console.log(`   🔗 https://aistudio.google.com/`);
  }
  console.log(`======================================================\n`);
});
