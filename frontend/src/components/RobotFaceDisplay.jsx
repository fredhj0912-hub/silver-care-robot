import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * RobotFaceDisplay — 라즈베리파이 7인치 디스플레이(800×480) 전용 전체 화면 로봇 얼굴 컴포넌트.
 * 
 * 핵심 기능:
 *  - 감정 기반 SVG 얼굴 표현 (neutral/happy/sad/concerned/thinking/sleeping)
 *  - 자동 음성 인식 (Web Speech API continuous) → AI 대화 → TTS 출력
 *  - SOS 긴급 호출 버튼
 *  - 보호자 원격 메시지 수신 및 TTS 재생
 */

// API base URL — 로컬 개발 시 프록시 경유, EC2 배포 후 환경변수로 전환
const API_BASE = import.meta.env.VITE_API_URL || '';

function RobotFaceDisplay({ status, onStatusChange }) {
  const [robotEmotion, setRobotEmotion] = useState('neutral');
  const [robotSpeech, setRobotSpeech] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);

  // 음성 인식 상태: 'idle' | 'listening' | 'processing' | 'speaking'
  const [voiceState, setVoiceState] = useState('idle');

  // Refs
  const recognitionRef = useRef(null);
  const audioContextRef = useRef(null);
  const alarmIntervalRef = useRef(null);
  const isSpeakingRef = useRef(false);
  const shouldListenRef = useRef(true);

  // ──────────────────────────────────────────────
  // TTS 음성 출력
  // ──────────────────────────────────────────────
  const speakText = useCallback((text) => {
    if (!window.speechSynthesis || !text) return;

    window.speechSynthesis.cancel();

    // TTS 시작 전 인식 일시 중지 (로봇 음성 오인식 방지)
    isSpeakingRef.current = true;
    setVoiceState('speaking');
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch (e) { /* ignore */ }
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    
    const voices = window.speechSynthesis.getVoices();
    const koVoice = voices.find(v => v.lang.includes('KO') || v.lang.toLowerCase().includes('kr'));
    if (koVoice) utterance.voice = koVoice;
    
    utterance.rate = 0.85;
    utterance.pitch = 1.0;

    utterance.onstart = () => {
      if (!status.isEmergency) {
        setRobotEmotion(prev => (prev === 'neutral' || prev === 'thinking') ? 'happy' : prev);
      }
    };

    utterance.onend = () => {
      isSpeakingRef.current = false;
      if (!status.isEmergency) {
        setRobotEmotion('neutral');
      }
      // TTS 종료 후 음성 인식 재시작
      setVoiceState('idle');
      startListening();
    };

    utterance.onerror = () => {
      isSpeakingRef.current = false;
      setVoiceState('idle');
      startListening();
    };

    window.speechSynthesis.speak(utterance);
  }, [status.isEmergency]);

  // ──────────────────────────────────────────────
  // AI 대화 요청
  // ──────────────────────────────────────────────
  const sendVoiceMessage = useCallback(async (msgText) => {
    setIsChatLoading(true);
    setVoiceState('processing');
    setRobotEmotion('thinking');
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
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
      } else {
        setRobotEmotion('neutral');
        setVoiceState('idle');
        startListening();
      }
    } catch (err) {
      console.error('Chat API error:', err);
      setRobotEmotion('concerned');
      setVoiceState('idle');
      startListening();
    } finally {
      setIsChatLoading(false);
    }
  }, [status.seniorExpression, onStatusChange, speakText]);

  // ──────────────────────────────────────────────
  // 자동 음성 인식 (Always Listening)
  // ──────────────────────────────────────────────
  const startListening = useCallback(() => {
    if (isSpeakingRef.current || !shouldListenRef.current) return;
    if (!recognitionRef.current) return;

    try {
      recognitionRef.current.start();
    } catch (e) {
      // already started — ignore
    }
  }, []);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('Web Speech API not supported on this browser.');
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.lang = 'ko-KR';
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      if (!isSpeakingRef.current) {
        setVoiceState('listening');
      }
    };

    rec.onresult = (event) => {
      // 마지막 결과만 처리
      const lastResult = event.results[event.results.length - 1];
      if (lastResult.isFinal) {
        const transcript = lastResult[0].transcript.trim();
        if (transcript.length > 0) {
          // 인식 중지 후 AI 대화 처리
          try { rec.stop(); } catch (e) { /* ignore */ }
          sendVoiceMessage(transcript);
        }
      }
    };

    rec.onerror = (e) => {
      // 'no-speech'나 'aborted'는 무시하고 자동 재시작
      if (e.error === 'no-speech' || e.error === 'aborted') {
        return;
      }
      console.error('Speech recognition error:', e.error);
    };

    rec.onend = () => {
      // TTS 출력 중이 아니고 리스닝을 계속해야 하면 자동 재시작
      if (!isSpeakingRef.current && shouldListenRef.current) {
        setTimeout(() => {
          startListening();
        }, 300);
      }
    };

    recognitionRef.current = rec;

    // 초기 음성 인식 시작
    const initTimer = setTimeout(() => {
      startListening();
    }, 1000);

    return () => {
      clearTimeout(initTimer);
      shouldListenRef.current = false;
      try { rec.stop(); } catch (e) { /* ignore */ }
    };
  }, [sendVoiceMessage, startListening]);

  // ──────────────────────────────────────────────
  // 보호자 원격 메시지 폴링
  // ──────────────────────────────────────────────
  useEffect(() => {
    const pollRemoteMessages = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/remote-message/poll`);
        if (res.ok) {
          const data = await res.json();
          if (data.message) {
            setRobotSpeech(`보호자님 메시지: ${data.message.text}`);
            speakText(data.message.text);
            onStatusChange();
          }
        }
      } catch (err) {
        console.error('Remote message poll error:', err);
      }
    };

    const interval = setInterval(pollRemoteMessages, 2500);
    return () => clearInterval(interval);
  }, [onStatusChange, speakText]);

  // ──────────────────────────────────────────────
  // 긴급 알람 사운드
  // ──────────────────────────────────────────────
  const startAlarmSound = () => {
    if (alarmIntervalRef.current) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    audioContextRef.current = ctx;

    const playBeep = () => {
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(554, ctx.currentTime + 0.3);
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

  const stopAlarmSound = () => {
    if (alarmIntervalRef.current) {
      clearInterval(alarmIntervalRef.current);
      alarmIntervalRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  };

  // 긴급 상태 모니터링
  useEffect(() => {
    if (status.isEmergency) {
      setRobotEmotion('concerned');
      startAlarmSound();
    } else {
      stopAlarmSound();
      if (robotEmotion === 'concerned') {
        setRobotEmotion('neutral');
      }
    }
    return () => stopAlarmSound();
  }, [status.isEmergency]);

  // ──────────────────────────────────────────────
  // 경보 해제
  // ──────────────────────────────────────────────
  const resolveActiveAlert = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/history`);
      if (res.ok) {
        const data = await res.json();
        const activeAlert = data.alerts.find(a => !a.resolved);
        if (activeAlert) {
          const resolveRes = await fetch(`${API_BASE}/api/alerts/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: activeAlert.id })
          });
          if (resolveRes.ok) {
            stopAlarmSound();
            onStatusChange();
            setRobotSpeech('경보를 해제했습니다. 안심하세요!');
            setRobotEmotion('happy');
            speakText('경보를 해제했습니다. 이제 안심하셔도 돼요!');
          }
        } else {
          onStatusChange();
        }
      }
    } catch (err) {
      console.error('Failed to resolve alert:', err);
    }
  };

  // SOS 긴급 호출
  const triggerSOS = async () => {
    try {
      await fetch(`${API_BASE}/api/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'manual_panic_button',
          description: '🚨 기기 터치스크린 SOS 버튼 직접 누름',
          image: null
        })
      });
      onStatusChange();
    } catch (err) {
      console.error('SOS trigger error:', err);
    }
  };

  // ──────────────────────────────────────────────
  // 음성 인식 상태 표시 색상
  // ──────────────────────────────────────────────
  const getStateColor = () => {
    switch (voiceState) {
      case 'listening': return '#10b981';   // 초록 — 듣고 있어요
      case 'processing': return '#f59e0b';  // 노란 — 생각 중
      case 'speaking': return '#3b82f6';    // 파란 — 말하는 중
      default: return '#64748b';            // 회색 — 대기
    }
  };

  const getStateText = () => {
    switch (voiceState) {
      case 'listening': return '듣고 있어요...';
      case 'processing': return '생각하는 중...';
      case 'speaking': return '말하는 중...';
      default: return '준비 중...';
    }
  };

  // ──────────────────────────────────────────────
  // 로봇 얼굴 SVG 렌더링
  // ──────────────────────────────────────────────
  const renderRobotFace = () => {
    let eyeLeftPath = <circle cx="110" cy="115" r="20" className="eye-blink" fill="#ffffff" />;
    let eyeRightPath = <circle cx="190" cy="115" r="20" className="eye-blink" fill="#ffffff" />;
    let mouthPath = <path d="M120 170 Q150 190 180 170" stroke="#ffffff" strokeWidth="7" strokeLinecap="round" fill="none" />;
    let eyebrows = null;
    let bgColor = 'linear-gradient(135deg, #1e2640 0%, #0f1322 100%)';
    let pulseBorder = '';

    if (status.isEmergency) {
      bgColor = 'linear-gradient(135deg, #7f1d1d 0%, #450a0a 100%)';
      pulseBorder = '0px 0px 40px rgba(239, 68, 68, 0.8)';
      eyebrows = (
        <>
          <path d="M90 90 L130 103" stroke="#ef4444" strokeWidth="5" strokeLinecap="round" />
          <path d="M210 90 L170 103" stroke="#ef4444" strokeWidth="5" strokeLinecap="round" />
        </>
      );
      eyeLeftPath = <circle cx="110" cy="118" r="18" fill="#ef4444" />;
      eyeRightPath = <circle cx="190" cy="118" r="18" fill="#ef4444" />;
      mouthPath = <path d="M130 175 Q150 158 170 175" stroke="#ef4444" strokeWidth="7" strokeLinecap="round" fill="none" />;
    } else {
      switch (robotEmotion) {
        case 'happy':
          eyeLeftPath = <path d="M90 120 C90 96 130 96 130 120" stroke="#10b981" strokeWidth="7" strokeLinecap="round" fill="none" />;
          eyeRightPath = <path d="M170 120 C170 96 210 96 210 120" stroke="#10b981" strokeWidth="7" strokeLinecap="round" fill="none" />;
          mouthPath = <path d="M110 158 Q150 195 190 158" stroke="#10b981" strokeWidth="9" strokeLinecap="round" fill="none" />;
          break;
        case 'sad':
          eyeLeftPath = <path d="M90 108 C90 128 130 128 130 108" stroke="#3b82f6" strokeWidth="7" strokeLinecap="round" fill="none" />;
          eyeRightPath = <path d="M170 108 C170 128 210 128 210 108" stroke="#3b82f6" strokeWidth="7" strokeLinecap="round" fill="none" />;
          mouthPath = <path d="M130 175 Q150 158 170 175" stroke="#3b82f6" strokeWidth="7" strokeLinecap="round" fill="none" />;
          break;
        case 'concerned':
          eyebrows = (
            <>
              <path d="M90 92 L130 105" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" />
              <path d="M210 92 L170 105" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" />
            </>
          );
          eyeLeftPath = <circle cx="110" cy="118" r="18" fill="#ffffff" />;
          eyeRightPath = <circle cx="190" cy="118" r="18" fill="#ffffff" />;
          mouthPath = <path d="M130 170 Q150 158 170 170" stroke="#ffffff" strokeWidth="6" strokeLinecap="round" fill="none" />;
          break;
        case 'thinking':
          eyeLeftPath = <circle cx="110" cy="115" r="20" fill="#f59e0b" />;
          eyeRightPath = <circle cx="190" cy="115" r="20" fill="#f59e0b" />;
          mouthPath = <line x1="125" y1="170" x2="175" y2="170" stroke="#f59e0b" strokeWidth="7" strokeLinecap="round" />;
          break;
        case 'sleeping':
          eyeLeftPath = <path d="M90 115 L130 115" stroke="#64748b" strokeWidth="7" strokeLinecap="round" fill="none" />;
          eyeRightPath = <path d="M170 115 L210 115" stroke="#64748b" strokeWidth="7" strokeLinecap="round" fill="none" />;
          mouthPath = <path d="M140 165 A12 12 0 0 0 160 165" stroke="#64748b" strokeWidth="5" strokeLinecap="round" fill="none" />;
          break;
        default:
          break;
      }
    }

    return (
      <div
        className={status.isEmergency ? 'robot-face animate-emergency' : 'robot-face animate-float'}
        style={{
          background: bgColor,
          boxShadow: pulseBorder || '0 20px 60px rgba(0, 0, 0, 0.5), inset 0 2px 5px rgba(255,255,255,0.05)',
          border: status.isEmergency ? '3px solid var(--accent-crimson)' : '1px solid rgba(255, 255, 255, 0.08)'
        }}
      >
        {/* 안테나 */}
        <div className="antenna-stem"></div>
        <div className="antenna-tip" style={{
          background: status.isEmergency ? 'var(--accent-crimson)' :
            robotEmotion === 'thinking' ? 'var(--accent-amber)' :
            voiceState === 'listening' ? 'var(--accent-emerald)' : 'var(--primary)',
          boxShadow: status.isEmergency ? '0 0 20px var(--accent-crimson)' :
            voiceState === 'listening' ? '0 0 15px var(--accent-emerald)' : 'none'
        }}></div>

        <svg width="100%" height="100%" viewBox="0 0 300 300" preserveAspectRatio="xMidYMid meet">
          {eyebrows}
          {eyeLeftPath}
          {eyeRightPath}
          {robotEmotion === 'happy' && (
            <>
              <circle cx="75" cy="145" r="14" fill="#10b981" opacity="0.2" />
              <circle cx="225" cy="145" r="14" fill="#10b981" opacity="0.2" />
            </>
          )}
          {mouthPath}
          {voiceState === 'listening' && (
            <circle cx="150" cy="150" r="140" stroke="var(--accent-emerald)" strokeWidth="2" fill="none" opacity="0.3" className="ripple-animation" />
          )}
        </svg>
      </div>
    );
  };

  // ──────────────────────────────────────────────
  // 렌더링
  // ──────────────────────────────────────────────
  return (
    <div className="kiosk-container">
      {/* 로봇 얼굴 */}
      <div className="face-area">
        {renderRobotFace()}
      </div>

      {/* 음성 인식 상태 표시 */}
      <div className="voice-status">
        <span
          className="voice-indicator"
          style={{
            backgroundColor: getStateColor(),
            boxShadow: `0 0 12px ${getStateColor()}`
          }}
        ></span>
        <span className="voice-status-text" style={{ color: getStateColor() }}>
          {getStateText()}
        </span>
      </div>

      {/* SOS / 경보 해제 버튼 */}
      <div className="sos-area">
        {status.isEmergency ? (
          <button
            onClick={resolveActiveAlert}
            className="sos-btn sos-resolve"
          >
            💚 괜찮아요! (경보 해제)
          </button>
        ) : (
          <button
            onClick={triggerSOS}
            className="sos-btn sos-trigger"
          >
            🚨 SOS 긴급 호출
          </button>
        )}
      </div>
    </div>
  );
}

export default RobotFaceDisplay;
