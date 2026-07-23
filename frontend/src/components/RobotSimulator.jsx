import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Camera, Video, AlertCircle, AlertOctagon, Smile } from 'lucide-react';

function RobotSimulator({ status, onStatusChange }) {
  const [isListening, setIsListening] = useState(false);
  const [speechTranscript, setSpeechTranscript] = useState('');
  const [robotSpeech, setRobotSpeech] = useState('안녕하세요 할머니! 오늘도 좋은 하루 보내셨어요? 저와 함께 이야기 나눠요.');
  const [robotEmotion, setRobotEmotion] = useState('neutral'); // neutral, happy, sad, concerned, thinking, sleeping
  const [seniorSimState, setSeniorSimState] = useState('normal'); // normal, smiling, sleeping, sad, fell_down
  
  // Webcam states
  const [useWebcam, setUseWebcam] = useState(false);
  const [webcamStreaming, setWebcamStreaming] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  
  const [visionAnalysis, setVisionAnalysis] = useState('기기 모니터링 중입니다. 정상 감지.');
  const [isVisionLoading, setIsVisionLoading] = useState(false);
  const [isChatLoading, setIsChatLoading] = useState(false);
  
  // Audio alarm context
  const audioContextRef = useRef(null);
  const alarmIntervalRef = useRef(null);

  // Web Speech API setups
  const recognitionRef = useRef(null);
  
  useEffect(() => {
    // Initialize Web Speech API
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.lang = 'ko-KR';
      rec.interimResults = false;
      
      rec.onstart = () => {
        setIsListening(true);
        setSpeechTranscript('듣고 있어요... 말씀해 주세요.');
        setRobotEmotion('thinking');
      };
      
      rec.onresult = (event) => {
        const resultText = event.results[0][0].transcript;
        setSpeechTranscript(resultText);
        sendVoiceMessage(resultText);
      };
      
      rec.onerror = (e) => {
        console.error('Speech recognition error', e);
        setIsListening(false);
        setSpeechTranscript('목소리가 잘 들리지 않았어요. 다시 시도해 주세요.');
        setRobotEmotion('neutral');
      };
      
      rec.onend = () => {
        setIsListening(false);
      };
      
      recognitionRef.current = rec;
    }
  }, []);

  // Web Audio Alarm synthesis
  const startLocalAlarmSound = () => {
    if (alarmIntervalRef.current) return;
    
    // Create Audio Context
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    audioContextRef.current = ctx;

    const playBeep = () => {
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, ctx.currentTime); // A5 note
      osc.frequency.linearRampToValueAtTime(554, ctx.currentTime + 0.3); // Downwards siren effect
      
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    };

    playBeep();
    alarmIntervalRef.current = setInterval(playBeep, 800);
  };

  const stopLocalAlarmSound = () => {
    if (alarmIntervalRef.current) {
      clearInterval(alarmIntervalRef.current);
      alarmIntervalRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  };

  const resolveActiveAlert = async () => {
    try {
      const res = await fetch('/api/history');
      if (res.ok) {
        const data = await res.json();
        const activeAlert = data.alerts.find(a => !a.resolved);
        if (activeAlert) {
          const resolveRes = await fetch('/api/alerts/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: activeAlert.id })
          });
          if (resolveRes.ok) {
            stopLocalAlarmSound();
            onStatusChange();
            setSpeechTranscript('');
            setRobotSpeech('할머니, 경보를 해제했습니다. 이제 안심하셔도 돼요! 다치신 곳은 없으시죠?');
            setRobotEmotion('happy');
            speakText('할머니, 경보를 해제했습니다. 이제 안심하셔도 돼요! 다치신 곳은 없으시죠?');
          }
        } else {
          onStatusChange();
        }
      }
    } catch (err) {
      console.error('Failed to resolve alert locally:', err);
    }
  };

  // Monitor status emergencies
  useEffect(() => {
    if (status.isEmergency) {
      setRobotEmotion('concerned');
      startLocalAlarmSound();
    } else {
      stopLocalAlarmSound();
      if (robotEmotion === 'concerned' && status.seniorExpression !== 'pain') {
        setRobotEmotion('neutral');
      }
    }
    return () => stopLocalAlarmSound();
  }, [status.isEmergency]);

  // TTS response reader
  const speakText = (text) => {
    if (!window.speechSynthesis) return;
    
    // Cancel any active speech
    window.speechSynthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    
    // Attempt to set a friendly Korean voice
    const voices = window.speechSynthesis.getVoices();
    const koVoice = voices.find(v => v.lang.includes('KO') || v.lang.toLowerCase().includes('kr'));
    if (koVoice) utterance.voice = koVoice;
    
    utterance.rate = 0.85; // Slow down slightly for elderly comfort
    utterance.pitch = 1.0;
    
    utterance.onstart = () => {
      // Set speaking state (vibrate mouth)
      if (!status.isEmergency) {
        setRobotEmotion(prev => prev === 'neutral' || prev === 'thinking' ? 'happy' : prev);
      }
    };
    
    utterance.onend = () => {
      if (!status.isEmergency) {
        setRobotEmotion('neutral');
      }
    };
    
    window.speechSynthesis.speak(utterance);
  };

  // Handle guardian remote messages polling
  useEffect(() => {
    const pollRemoteMessages = async () => {
      try {
        const res = await fetch('/api/remote-message/poll');
        if (res.ok) {
          const data = await res.json();
          if (data.message) {
            console.log('Received remote message from guardian:', data.message.text);
            setRobotSpeech(`보호자님께서 보내신 말씀이에요: ${data.message.text}`);
            speakText(data.message.text);
            onStatusChange();
          }
        }
      } catch (err) {
        console.error('Error polling remote messages', err);
      }
    };

    const interval = setInterval(pollRemoteMessages, 2500);
    return () => clearInterval(interval);
  }, [onStatusChange]);

  // Webcam logic
  useEffect(() => {
    if (useWebcam) {
      navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } })
        .then(stream => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            setWebcamStreaming(true);
          }
        })
        .catch(err => {
          console.error("Webcam not available", err);
          setUseWebcam(false);
          alert("웹카메라를 시작할 수 없습니다. 시뮬레이터를 사용해 주세요.");
        });
    } else {
      if (videoRef.current && videoRef.current.srcObject) {
        const tracks = videoRef.current.srcObject.getTracks();
        tracks.forEach(track => track.stop());
        videoRef.current.srcObject = null;
        setWebcamStreaming(false);
      }
    }
    
    return () => {
      if (videoRef.current && videoRef.current.srcObject) {
        videoRef.current.srcObject.getTracks().forEach(t => t.stop());
      }
    };
  }, [useWebcam]);

  // Send conversation text to Backend
  const sendVoiceMessage = async (msgText) => {
    setIsChatLoading(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          text: msgText,
          seniorExpression: status.seniorExpression 
        })
      });
      if (res.ok) {
        const data = await res.json();
        setRobotSpeech(data.text);
        setRobotEmotion(data.emotion);
        speakText(data.text);
        onStatusChange();
      }
    } catch (err) {
      console.error(err);
      setRobotSpeech('서버와의 통신이 실패했어요. 할머니, 조금 있다가 다시 시도해 주세요!');
    } finally {
      setIsChatLoading(false);
    }
  };

  // Mic control
  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
    } else {
      if (recognitionRef.current) {
        recognitionRef.current.start();
      } else {
        // Mock keyboard input if browser speech recognition is not supported
        const mockPrompt = prompt("브라우저가 음성 인식을 지원하지 않습니다. 마이크 대신 텍스트로 말씀해 주세요:", "");
        if (mockPrompt) {
          setSpeechTranscript(mockPrompt);
          sendVoiceMessage(mockPrompt);
        }
      }
    }
  };

  // Capture image & trigger vision analysis
  const captureAndAnalyze = async () => {
    setIsVisionLoading(true);
    let base64Img = '';

    if (useWebcam && webcamStreaming && videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      base64Img = canvas.toDataURL('image/jpeg');
    } else {
      // Create a mocked SVG canvas snapshot to upload
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = seniorSimState === 'fell_down' ? '#450a0a' : '#1e293b';
      ctx.fillRect(0, 0, 320, 240);
      
      // Draw details based on simulated state
      ctx.fillStyle = '#ffffff';
      ctx.font = '14px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(`SIMULATED CAMERA STREAM`, 160, 40);
      
      ctx.fillStyle = '#64748b';
      ctx.fillText(`State: ${seniorSimState.toUpperCase()}`, 160, 80);
      
      // Draw simplified user shape
      if (seniorSimState === 'fell_down') {
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(60, 150, 200, 20); // lying down body
        ctx.beginPath();
        ctx.arc(260, 140, 15, 0, Math.PI * 2); // head on floor
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillText('🚨 USER ON THE FLOOR', 160, 190);
      } else {
        ctx.fillStyle = '#10b981';
        ctx.beginPath();
        ctx.arc(160, 130, 25, 0, Math.PI * 2); // head upright
        ctx.fill();
        
        ctx.fillStyle = '#ffffff';
        if (seniorSimState === 'smiling') ctx.fillText('Smiling Face', 160, 180);
        else if (seniorSimState === 'sleeping') ctx.fillText('Closed Eyes (Sleeping)', 160, 180);
        else ctx.fillText('Normal Sitting Position', 160, 180);
      }
      
      base64Img = canvas.toDataURL('image/jpeg');
    }

    try {
      const res = await fetch('/api/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: base64Img,
          simulatedState: useWebcam ? null : seniorSimState
        })
      });
      if (res.ok) {
        const data = await res.json();
        setVisionAnalysis(data.summary);
        
        // Match robot's expression based on result
        if (data.isEmergency) {
          setRobotEmotion('concerned');
        } else if (data.expression === 'happy') {
          setRobotEmotion('happy');
        } else if (data.expression === 'sleeping') {
          setRobotEmotion('sleeping');
        } else {
          setRobotEmotion('neutral');
        }
        
        onStatusChange();
      }
    } catch (err) {
      console.error(err);
      setVisionAnalysis('카메라 이미지 분석에 실패했습니다.');
    } finally {
      setIsVisionLoading(false);
    }
  };

  // Trigger snapshot when simulator state changes
  useEffect(() => {
    if (!useWebcam) {
      captureAndAnalyze();
    }
  }, [seniorSimState, useWebcam]);

  // Hardware triggers simulation
  const triggerManualAlert = async (type, desc) => {
    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          description: desc,
          image: null
        })
      });
      if (res.ok) {
        onStatusChange();
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Render Robot SVGs facial shapes
  const renderRobotFace = () => {
    let eyeLeftPath = <circle cx="110" cy="115" r="16" className="eye-blink" fill="#ffffff" />;
    let eyeRightPath = <circle cx="190" cy="115" r="16" className="eye-blink" fill="#ffffff" />;
    let mouthPath = <path d="M120 160 Q150 175 180 160" stroke="#ffffff" strokeWidth="6" strokeLinecap="round" fill="none" />;
    let eyebrows = null;
    let bgColor = 'linear-gradient(135deg, #1e2640 0%, #0f1322 100%)';
    let pulseBorder = '';

    if (status.isEmergency) {
      // Concerned / Flashing Red Face
      bgColor = 'linear-gradient(135deg, #7f1d1d 0%, #450a0a 100%)';
      pulseBorder = '0px 0px 30px rgba(239, 68, 68, 0.8)';
      eyebrows = (
        <>
          <path d="M95 95 L125 105" stroke="#ef4444" strokeWidth="4" strokeLinecap="round" />
          <path d="M205 95 L175 105" stroke="#ef4444" strokeWidth="4" strokeLinecap="round" />
        </>
      );
      eyeLeftPath = <circle cx="110" cy="118" r="14" fill="#ef4444" />;
      eyeRightPath = <circle cx="190" cy="118" r="14" fill="#ef4444" />;
      mouthPath = <path d="M130 165 Q150 150 170 165" stroke="#ef4444" strokeWidth="6" strokeLinecap="round" fill="none" />;
    } else {
      switch (robotEmotion) {
        case 'happy':
          eyeLeftPath = <path d="M95 120 C95 100 125 100 125 120" stroke="#10b981" strokeWidth="6" strokeLinecap="round" fill="none" />;
          eyeRightPath = <path d="M175 120 C175 100 205 100 205 120" stroke="#10b981" strokeWidth="6" strokeLinecap="round" fill="none" />;
          mouthPath = <path d="M115 150 Q150 180 185 150" stroke="#10b981" strokeWidth="8" strokeLinecap="round" fill="none" />;
          break;
        case 'sad':
          eyeLeftPath = <path d="M95 110 C95 125 125 125 125 110" stroke="#3b82f6" strokeWidth="6" strokeLinecap="round" fill="none" />;
          eyeRightPath = <path d="M175 110 C175 125 205 125 205 110" stroke="#3b82f6" strokeWidth="6" strokeLinecap="round" fill="none" />;
          mouthPath = <path d="M130 165 Q150 150 170 165" stroke="#3b82f6" strokeWidth="6" strokeLinecap="round" fill="none" />;
          break;
        case 'concerned':
          eyebrows = (
            <>
              <path d="M95 95 L125 105" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" />
              <path d="M205 95 L175 105" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" />
            </>
          );
          eyeLeftPath = <circle cx="110" cy="115" r="14" fill="#ffffff" />;
          eyeRightPath = <circle cx="190" cy="115" r="14" fill="#ffffff" />;
          mouthPath = <path d="M130 160 Q150 150 170 160" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" fill="none" />;
          break;
        case 'thinking':
          eyeLeftPath = <circle cx="110" cy="115" r="16" fill="#f59e0b" />;
          eyeRightPath = <circle cx="190" cy="115" r="16" fill="#f59e0b" />;
          // Straight mouth line
          mouthPath = <line x1="125" y1="160" x2="175" y2="160" stroke="#f59e0b" strokeWidth="6" strokeLinecap="round" />;
          break;
        case 'sleeping':
          eyeLeftPath = <path d="M95 115 L125 115" stroke="#64748b" strokeWidth="6" strokeLinecap="round" fill="none" />;
          eyeRightPath = <path d="M175 115 L205 115" stroke="#64748b" strokeWidth="6" strokeLinecap="round" fill="none" />;
          mouthPath = <path d="M140 155 A10 10 0 0 0 160 155" stroke="#64748b" strokeWidth="4" strokeLinecap="round" fill="none" />;
          break;
        case 'neutral':
        default:
          // Default eyes and curved mild smile
          break;
      }
    }

    return (
      <div 
        className={status.isEmergency ? "animate-emergency" : "animate-float"} 
        style={{
          width: '280px',
          height: '280px',
          background: bgColor,
          borderRadius: '60px',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          boxShadow: pulseBorder || '0 15px 45px rgba(0, 0, 0, 0.4), inset 0 2px 5px rgba(255,255,255,0.05)',
          border: status.isEmergency ? '2px solid var(--accent-crimson)' : '1px solid rgba(255, 255, 255, 0.08)',
          margin: '0 auto',
          position: 'relative'
        }}
      >
        {/* Antennas */}
        <div style={{
          position: 'absolute',
          top: '-25px',
          left: 'calc(50% - 10px)',
          width: '20px',
          height: '25px',
          background: 'rgba(255,255,255,0.1)',
          borderRadius: '5px'
        }}></div>
        <div style={{
          position: 'absolute',
          top: '-40px',
          left: 'calc(50% - 15px)',
          width: '30px',
          height: '15px',
          background: status.isEmergency ? 'var(--accent-crimson)' : robotEmotion === 'thinking' ? 'var(--accent-amber)' : 'var(--primary)',
          borderRadius: '15px 15px 0 0',
          boxShadow: status.isEmergency ? '0 0 15px var(--accent-crimson)' : 'none'
        }}></div>

        <svg width="240" height="240" viewBox="0 0 300 300">
          {/* Eyebrows */}
          {eyebrows}
          {/* Eyes */}
          {eyeLeftPath}
          {eyeRightPath}
          {/* Cheeks (if happy) */}
          {robotEmotion === 'happy' && (
            <>
              <circle cx="80" cy="140" r="10" fill="#10b981" opacity="0.25" />
              <circle cx="220" cy="140" r="10" fill="#10b981" opacity="0.25" />
            </>
          )}
          {/* Mouth */}
          {mouthPath}
          {/* Speaking Ripples */}
          {isListening && (
            <circle cx="150" cy="150" r="130" stroke="var(--accent-emerald)" strokeWidth="2" fill="none" opacity="0.4" style={{ animation: 'ripple 1.5s infinite linear' }} />
          )}
        </svg>
      </div>
    );
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: '1.5rem' }}>
      
      {/* Column 1: Robot Face & Speech */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: '520px' }}>
        
        {/* Robot screen box */}
        <div style={{ textAlign: 'center', padding: '1rem 0 2rem' }}>
          {renderRobotFace()}
        </div>

        {/* Conversation display panel */}
        <div style={{ 
          background: 'rgba(0, 0, 0, 0.25)', 
          border: '1px solid rgba(255, 255, 255, 0.03)',
          borderRadius: '16px',
          padding: '1.25rem',
          marginBottom: '1.5rem',
          minHeight: '140px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center'
        }}>
          {speechTranscript && (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <span style={{ width: '6px', height: '6px', backgroundColor: 'var(--accent-emerald)', borderRadius: '50%' }}></span>
              어르신 (STT): "{speechTranscript}"
            </div>
          )}
          
          <div style={{ 
            fontSize: '1.1rem', 
            fontWeight: 500, 
            color: status.isEmergency ? 'var(--accent-crimson)' : 'var(--text-primary)',
            lineHeight: 1.5
          }}>
            {isChatLoading ? (
              <span style={{ color: 'var(--text-muted)' }}>효돌이가 답변을 생각하고 있어요...</span>
            ) : (
              `🤖 효돌이: ${robotSpeech}`
            )}
          </div>
        </div>

        {/* Emergency Buttons directly on the Robot Display Screen */}
        <div style={{ padding: '0 0.25rem', marginBottom: '1.25rem' }}>
          {status.isEmergency ? (
            <button
              onClick={resolveActiveAlert}
              className="btn btn-danger"
              style={{
                width: '100%',
                padding: '0.8rem',
                fontSize: '1.1rem',
                borderRadius: '12px',
                justifyContent: 'center',
                boxShadow: '0 0 20px rgba(239, 68, 68, 0.4)',
                fontWeight: 'bold',
                color: '#ffffff'
              }}
            >
              💚 오작동 / 저 괜찮아요! (기기에서 경보 해제)
            </button>
          ) : (
            <button
              onClick={() => triggerManualAlert('manual_panic_button', '🚨 기기 터치스크린 비상 버튼 직접 누름')}
              className="btn"
              style={{
                width: '100%',
                padding: '0.8rem',
                fontSize: '1.1rem',
                borderRadius: '12px',
                justifyContent: 'center',
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                borderColor: 'var(--accent-crimson)',
                color: 'var(--accent-crimson)',
                fontWeight: 'bold'
              }}
            >
              🚨 SOS 긴급 비상 호출
            </button>
          )}
        </div>

        {/* Interaction Controls */}
        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
          <button
            onClick={toggleListening}
            disabled={isChatLoading || status.isEmergency}
            className={`btn ${status.isEmergency ? 'btn-disabled' : ''}`}
            style={{
              padding: '0.75rem 2rem',
              fontSize: '1.05rem',
              borderRadius: '50px',
              backgroundColor: isListening ? 'rgba(16, 185, 129, 0.15)' : 'var(--primary)',
              borderColor: isListening ? 'var(--accent-emerald)' : 'var(--primary)',
              color: '#ffffff',
              boxShadow: isListening ? '0 0 15px var(--accent-emerald-glow)' : 'var(--shadow-glow)',
              animation: isListening ? 'listening-pulse 1.5s infinite' : 'none'
            }}
          >
            {isListening ? (
              <>
                <MicOff size={20} color="var(--accent-emerald)" />
                말하기 완료 (클릭)
              </>
            ) : (
              <>
                <Mic size={20} />
                할머니 말씀하기 (마이크)
              </>
            )}
          </button>

          {window.speechSynthesis && (
            <button
              onClick={() => speakText(robotSpeech)}
              className="btn"
              style={{
                borderRadius: '50px',
                padding: '0.75rem 1.25rem'
              }}
            >
              다시 듣기 🔊
            </button>
          )}
        </div>

      </div>

      {/* Column 2: Simulated Inputs & Sensors */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        
        {/* Camera Feed Simulation */}
        <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h2 style={{ fontSize: '1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Camera size={18} color="var(--primary)" />
                실시간 카메라 시뮬레이션
              </h2>
              
              <button 
                onClick={() => setUseWebcam(!useWebcam)}
                className="btn"
                style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem', borderRadius: '6px' }}
              >
                <Video size={12} />
                {useWebcam ? '시뮬레이터 전환' : '실제 웹캠 사용'}
              </button>
            </div>

            {/* Viewport Box */}
            <div style={{ 
              width: '100%', 
              height: '180px', 
              background: '#07080e',
              border: '1px solid rgba(255, 255, 255, 0.05)',
              borderRadius: '12px',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              position: 'relative',
              overflow: 'hidden',
              marginBottom: '1rem'
            }}>
              
              {useWebcam ? (
                <>
                  <video 
                    ref={videoRef} 
                    autoPlay 
                    playsInline 
                    style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
                  />
                  <canvas ref={canvasRef} style={{ display: 'none' }} />
                  <div style={{ position: 'absolute', top: '8px', left: '8px', background: 'rgba(0,0,0,0.6)', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.7rem', color: 'var(--accent-emerald)', fontWeight: 600 }}>
                    ● LIVE WEBCAM
                  </div>
                </>
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '1rem', textAlign: 'center' }}>
                  {seniorSimState === 'fell_down' ? (
                    <>
                      <AlertOctagon size={48} color="var(--accent-crimson)" style={{ marginBottom: '0.5rem' }} />
                      <span style={{ color: 'var(--accent-crimson)', fontWeight: 700 }}>🚨 낙상 상황 시뮬레이션 중</span>
                    </>
                  ) : seniorSimState === 'sleeping' ? (
                    <>
                      <Cloud size={48} color="var(--text-secondary)" style={{ marginBottom: '0.5rem' }} />
                      <span style={{ color: 'var(--text-secondary)' }}>💤 어르신 취침 시뮬레이션 중</span>
                    </>
                  ) : seniorSimState === 'smiling' ? (
                    <>
                      <Smile size={48} color="var(--accent-emerald)" style={{ marginBottom: '0.5rem' }} />
                      <span style={{ color: 'var(--accent-emerald)' }}>😊 웃는 모습 시뮬레이션 중</span>
                    </>
                  ) : (
                    <>
                      <Video size={48} color="var(--text-muted)" style={{ marginBottom: '0.5rem' }} />
                      <span style={{ color: 'var(--text-secondary)' }}>👤 정상 관찰 상태 시뮬레이션 중</span>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Simulated selector when webcam is off */}
            {!useWebcam && (
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>어르신 상태 변경 (시뮬레이터)</label>
                <select
                  value={seniorSimState}
                  onChange={(e) => setSeniorSimState(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid var(--border-glass)',
                    color: '#ffffff',
                    padding: '0.5rem',
                    borderRadius: '8px',
                    fontSize: '0.85rem'
                  }}
                >
                  <option value="normal">정상 상태 (대기)</option>
                  <option value="smiling">미소 (대화 중)</option>
                  <option value="sleeping">낮잠/수면</option>
                  <option value="sad">우울/슬픔</option>
                  <option value="fell_down">⚠️ 낙상 발생! (바닥에 쓰러짐)</option>
                </select>
              </div>
            )}
          </div>

          <div>
            {/* Run manual check button */}
            <button
              onClick={captureAndAnalyze}
              disabled={isVisionLoading}
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', marginBottom: '0.75rem', fontSize: '0.85rem' }}
            >
              {isVisionLoading ? '분석 중...' : '📸 실시간 영상 캡쳐 & AI 분석'}
            </button>

            {/* Analysis report details */}
            <div style={{ background: 'rgba(255,255,255,0.02)', padding: '0.75rem', borderRadius: '8px', fontSize: '0.8rem', border: '1px solid rgba(255,255,255,0.03)' }}>
              <span style={{ color: 'var(--text-secondary)', display: 'block', marginBottom: '0.2rem' }}>AI 판단 결과:</span>
              <strong style={{ color: status.isEmergency ? 'var(--accent-crimson)' : 'var(--text-primary)' }}>
                {visionAnalysis}
              </strong>
            </div>
          </div>

        </div>

        {/* Hardware Sensors Emulation */}
        <div className="glass-panel">
          <h2 style={{ fontSize: '1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '1rem' }}>
            <AlertCircle size={18} color="var(--primary)" />
            H/W 센서 수동 발생기 (테스트용)
          </h2>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
            아직 하드웨어가 오지 않은 개발 환경을 위해, 기기의 물리적 센서 신호를 발생시킵니다.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <button
              onClick={() => triggerManualAlert('fall_sensor', '⚠️ 물리 가속도 센서: 낙상 감지 신호 임계값 돌파 (H/W 시뮬레이션)')}
              disabled={status.isEmergency}
              className={`btn ${status.isEmergency ? 'btn-disabled' : 'btn-danger'}`}
              style={{ 
                fontSize: '0.8rem', 
                flexDirection: 'column', 
                gap: '0.25rem',
                padding: '0.75rem 0.5rem',
                justifyContent: 'center',
                textAlign: 'center'
              }}
            >
              <AlertOctagon size={20} />
              낙상 센서 격발
            </button>

            <button
              onClick={() => triggerManualAlert('manual_panic_button', '🚨 기기 물리 비상 빨간 버튼 수동 입력')}
              disabled={status.isEmergency}
              className={`btn ${status.isEmergency ? 'btn-disabled' : 'btn-danger'}`}
              style={{ 
                fontSize: '0.8rem', 
                flexDirection: 'column', 
                gap: '0.25rem',
                padding: '0.75rem 0.5rem',
                justifyContent: 'center',
                textAlign: 'center'
              }}
            >
              <AlertCircle size={20} />
              비상 버튼 누름
            </button>
          </div>
        </div>

      </div>

    </div>
  );
}

export default RobotSimulator;
