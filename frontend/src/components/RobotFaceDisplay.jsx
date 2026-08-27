import React, { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '../lib/api';
import { createRecognizer, isSupported as isSTTSupported } from '../lib/stt';
import { decideAction, pickAcknowledgeReply, ACTIVE_WINDOW_MS } from '../lib/wakeword';
import { useCameraMonitor } from '../lib/useCameraMonitor';

// 카메라 모니터링은 기본 비활성 — 켜는 것 자체가 사용자 동의와 비용이 따르는 결정이라
// 명시적 옵트인으로 둔다. 켜려면 frontend/.env 에 VITE_VISION_ENABLED=true.
const VISION_ENABLED = import.meta.env.VITE_VISION_ENABLED === 'true';
const VISION_INTERVAL_MS = Number(import.meta.env.VITE_VISION_INTERVAL_MS) || 15000;

const MOVE_ARROWS = { up: '⬆️', down: '⬇️', left: '⬅️', right: '➡️' };

/**
 * RobotFaceDisplay — 라즈베리파이 7인치 디스플레이(800×480) 전용 전체 화면 로봇 얼굴 컴포넌트.
 * 
 * 핵심 기능:
 *  - 감정 기반 SVG 얼굴 표현 (neutral/happy/sad/concerned/thinking/sleeping)
 *  - 자동 음성 인식 (Web Speech API continuous) → AI 대화 → TTS 출력
 *  - SOS 긴급 호출 버튼
 *  - 보호자 원격 메시지 수신 및 TTS 재생
 */

function RobotFaceDisplay({ status, onStatusChange }) {
  const [robotEmotion, setRobotEmotion] = useState('neutral');
  const [robotSpeech, setRobotSpeech] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [textInput, setTextInput] = useState('');

  // 응답이 실제 Gemini에서 왔는지 mock 폴백인지.
  // 예전에는 Gemini 호출이 실패해도 조용히 통조림 응답으로 떨어져
  // 서버 로그를 보지 않는 한 아무도 눈치채지 못했다.
  const [aiSource, setAiSource] = useState(null);

  // 음성 인식 상태: 'idle' | 'listening' | 'processing' | 'speaking'
  const [voiceState, setVoiceState] = useState('idle');

  // Refs
  const recognitionRef = useRef(null);
  const audioContextRef = useRef(null);
  const alarmIntervalRef = useRef(null);
  const isSpeakingRef = useRef(false);
  const shouldListenRef = useRef(true);
  const audioRef = useRef(null);          // 서버 TTS 오디오 재생 핸들

  // status.isEmergency 를 ref로도 들고 있는다.
  // speakText가 상태값에 직접 의존하면 비상 상태가 바뀔 때마다 콜백이 새로 만들어지고,
  // 그 콜백에 의존하는 폴링 인터벌까지 통째로 재생성된다.
  const emergencyRef = useRef(false);
  useEffect(() => { emergencyRef.current = status.isEmergency; }, [status.isEmergency]);

  // 대화 창(웨이크워드 게이트)이 열려 있는지.
  // 화면 표시용 상태와, 콜백 안에서 최신값을 읽기 위한 ref를 함께 둔다.
  const [isGateActive, setIsGateActive] = useState(false);
  const gateActiveRef = useRef(false);
  const gateTimerRef = useRef(null);

  // 이 브라우저에서 음성 인식이 아예 안 되는 경우 (텍스트 입력만 안내)
  const [sttUnavailable, setSttUnavailable] = useState(false);

  // 보호자 원격조종 이동 인디케이터 — 방향을 잠깐 보여주고 사라진다
  const [moveDirection, setMoveDirection] = useState(null);
  const moveIndicatorTimerRef = useRef(null);

  // ──────────────────────────────────────────────
  // 카메라 모니터링 (기본 비활성 — VITE_VISION_ENABLED=true 로 켠다)
  //
  // 백엔드의 /api/vision + Gemini Vision 낙상 판정 파이프라인은 Phase 0부터
  // 완성되어 있었지만, 프론트가 한 번도 호출하지 않아 도달 불가능했다.
  // ──────────────────────────────────────────────
  const handleVisionEmergency = useCallback((analysis) => {
    console.warn('카메라에서 응급 상황이 감지되었습니다:', analysis.summary);
    onStatusChange(); // 서버가 이미 알림/isEmergency를 세팅했다 — 폴링을 기다리지 않고 즉시 반영
  }, [onStatusChange]);

  const { videoRef, canvasRef, cameraError } = useCameraMonitor({
    enabled: VISION_ENABLED,
    intervalMs: VISION_INTERVAL_MS,
    onEmergency: handleVisionEmergency,
  });

  useEffect(() => {
    if (cameraError) console.warn('카메라 모니터링 비활성 (음성 대화는 정상 동작):', cameraError);
  }, [cameraError]);

  // ──────────────────────────────────────────────
  // TTS 음성 출력
  //
  // 서버 TTS(Chirp 3 HD 등)를 먼저 시도하고, 서버가 204를 주거나 실패하면
  // 브라우저 SpeechSynthesis로 폴백한다. 네트워크가 끊겨도 어르신은 대답을 듣는다.
  //
  // 어느 경로든 자기 목소리 인식 방지 게이트(isSpeakingRef)는 동일하게 지킨다 —
  // 이게 풀리면 로봇이 자기 말을 듣고 무한히 대답한다.
  // ──────────────────────────────────────────────

  /** 말하기가 끝났을 때(정상/오류 모두) 공통으로 하는 뒷정리 */
  const finishSpeaking = useCallback(() => {
    isSpeakingRef.current = false;
    if (!emergencyRef.current) setRobotEmotion('neutral');
    setVoiceState('idle');
    startListening();
  }, []);

  const speakWithBrowser = useCallback((text) => {
    if (!window.speechSynthesis) return finishSpeaking();

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';

    const voices = window.speechSynthesis.getVoices();
    // 더 자연스러운 맑은 한국어 목소리 우선 (Google 한국어 / Natural / Heami)
    const koVoice =
      voices.find(v => (v.lang.includes('KO') || v.lang.toLowerCase().includes('kr'))
        && (v.name.includes('Google') || v.name.includes('Natural') || v.name.includes('Heami')))
      || voices.find(v => v.lang.includes('KO') || v.lang.toLowerCase().includes('kr'));
    if (koVoice) utterance.voice = koVoice;

    utterance.rate = 1.05;
    utterance.pitch = 1.2;

    utterance.onstart = () => {
      if (!emergencyRef.current) {
        setRobotEmotion(prev => (prev === 'neutral' || prev === 'thinking') ? 'happy' : prev);
      }
    };
    utterance.onend = finishSpeaking;
    utterance.onerror = finishSpeaking;

    window.speechSynthesis.speak(utterance);
  }, [finishSpeaking]);

  const speakText = useCallback(async (text) => {
    if (!text) return;

    // 인식을 먼저 멈춘다 — 서버 응답을 기다리는 동안에도 자기 목소리를 들으면 안 된다
    isSpeakingRef.current = true;
    setVoiceState('speaking');
    if (recognitionRef.current) recognitionRef.current.stop();
    window.speechSynthesis?.cancel();

    try {
      const res = await apiFetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });

      // 204 = 서버가 브라우저 TTS로 처리하라는 신호 (provider=browser 또는 합성 실패)
      if (res.status === 204 || !res.ok) {
        const serverError = res.headers.get('X-TTS-Error');
        if (serverError) console.warn('서버 TTS 실패 → 브라우저 TTS:', decodeURIComponent(serverError));
        return speakWithBrowser(text);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;

      const cleanup = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        finishSpeaking();
      };

      audio.onplay = () => {
        if (!emergencyRef.current) {
          setRobotEmotion(prev => (prev === 'neutral' || prev === 'thinking') ? 'happy' : prev);
        }
      };
      audio.onended = cleanup;
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        speakWithBrowser(text);
      };

      await audio.play();
    } catch (err) {
      console.warn('서버 TTS 요청 실패 → 브라우저 TTS:', err.message);
      speakWithBrowser(text);
    }
  }, [speakWithBrowser, finishSpeaking]);

  // ──────────────────────────────────────────────
  // AI 대화 요청
  // ──────────────────────────────────────────────
  const sendVoiceMessage = useCallback(async (msgText) => {
    setIsChatLoading(true);
    setVoiceState('processing');
    setRobotEmotion('thinking');
    try {
      const res = await apiFetch('/api/chat', {
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
        setAiSource({ source: data.source, model: data.model, reason: data.degradedReason });
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

  // 텍스트 채팅 직접 전송 처리.
  // 음성 경로(handleTranscript)와 같은 decideAction()을 거친다 — 안 그러면 웨이크워드만
  // 텍스트로 입력해도 불필요한 Gemini 호출이 나간다. 텍스트 입력은 명시적 행동이므로
  // isActive는 항상 true로 취급한다(게이트가 닫혀 있어도 타이핑한 내용은 무시하지 않는다).
  const handleTextSubmit = (e) => {
    e.preventDefault();
    if (!textInput.trim() || isChatLoading) return;
    const msg = textInput.trim();
    setTextInput('');
    openGate();   // 글로 말을 걸었으면 이어서 음성으로 대화할 수 있게 창을 연다

    const decision = decideAction(msg, true);
    if (decision.action === 'acknowledge') {
      const reply = pickAcknowledgeReply();
      setRobotSpeech(reply);
      setRobotEmotion('happy');
      speakText(reply);
      return;
    }
    sendVoiceMessage(decision.text || msg);
  };

  // ──────────────────────────────────────────────
  // 자동 음성 인식 (Always Listening)
  // ──────────────────────────────────────────────
  const startListening = useCallback(() => {
    if (isSpeakingRef.current || !shouldListenRef.current) return;
    recognitionRef.current?.start();
  }, []);

  /** 대화 창을 열고 30초 타이머를 (다시) 건다 */
  const openGate = useCallback(() => {
    setIsGateActive(true);
    gateActiveRef.current = true;
    clearTimeout(gateTimerRef.current);
    gateTimerRef.current = setTimeout(() => {
      setIsGateActive(false);
      gateActiveRef.current = false;
    }, ACTIVE_WINDOW_MS);
  }, []);

  /**
   * 인식된 발화를 어떻게 처리할지 결정한다.
   *
   * 이전에는 인식된 모든 발화를 그대로 /api/chat 으로 보내서
   * TV 소리, 혼잣말, 통화 소리에까지 로봇이 대답했다.
   */
  const handleTranscript = useCallback((transcript) => {
    const decision = decideAction(transcript, gateActiveRef.current);

    if (decision.action === 'ignore') {
      // dormant 상태에서 흘려보낸 말. 인식은 계속 돌지만 API는 부르지 않는다.
      return;
    }

    recognitionRef.current?.stop();
    openGate();

    if (decision.action === 'acknowledge') {
      // 웨이크워드만 불렀다 — API를 부르지 않고 즉시 대답한다
      const reply = pickAcknowledgeReply();
      setRobotSpeech(reply);
      setRobotEmotion('happy');
      speakText(reply);
      return;
    }

    sendVoiceMessage(decision.text);
  }, [openGate, speakText, sendVoiceMessage]);

  useEffect(() => {
    if (!isSTTSupported()) {
      console.warn('이 브라우저는 Web Speech API를 지원하지 않습니다. 텍스트 입력을 사용하세요.');
      setSttUnavailable(true);
      return;
    }

    const recognizer = createRecognizer({
      onStart: () => {
        if (!isSpeakingRef.current) setVoiceState('listening');
      },
      onResult: (text) => handleTranscript(text),
      onError: (err) => console.error('음성 인식 오류:', err),
      onEnd: () => {
        // TTS 출력 중이 아니고 계속 들어야 하면 자동 재시작.
        // 브라우저 STT는 장시간 세션에서 조용히 끊기므로 이 재시작이 필수다.
        if (!isSpeakingRef.current && shouldListenRef.current) {
          setTimeout(() => startListening(), 300);
        }
      },
    });

    recognitionRef.current = recognizer;
    shouldListenRef.current = true;

    const initTimer = setTimeout(() => startListening(), 1000);

    return () => {
      clearTimeout(initTimer);
      clearTimeout(gateTimerRef.current);
      shouldListenRef.current = false;
      recognizer.abort();
    };
  }, [handleTranscript, startListening]);

  // ──────────────────────────────────────────────
  // 보호자 명령 큐 폴링 (speak / move)
  //
  // 예전에는 deprecated GET /api/remote-message/poll 을 썼다 — SSE(command.issued)가
  // 이미 있는데도 프론트가 옮겨가지 않았던 것. 이제 현재 API(/api/commands/pending)로
  // 조회하고 ack 한다. 완전한 SSE 전환은 이번 범위 밖이라 폴링 방식은 유지한다.
  // ──────────────────────────────────────────────
  useEffect(() => {
    const pollCommands = async () => {
      try {
        const res = await apiFetch('/api/commands/pending');
        if (!res.ok) return;
        const data = await res.json();

        for (const command of data.commands) {
          if (command.kind === 'speak') {
            setRobotSpeech(`보호자님 메시지: ${command.payload.text}`);
            // 보호자가 말을 걸었으니 어르신이 바로 대답할 수 있게 창을 열어둔다.
            // 이때 "효돌아"부터 다시 불러야 한다면 대화가 끊긴다.
            openGate();
            speakText(command.payload.text);
            onStatusChange();
          } else if (command.kind === 'move') {
            setMoveDirection(command.payload.direction);
            clearTimeout(moveIndicatorTimerRef.current);
            moveIndicatorTimerRef.current = setTimeout(() => setMoveDirection(null), 1500);
          }
          await apiFetch(`/api/commands/${command.id}/ack`, { method: 'POST' });
        }
      } catch (err) {
        console.error('Command poll error:', err);
      }
    };

    const interval = setInterval(pollCommands, 2500);
    return () => {
      clearInterval(interval);
      clearTimeout(moveIndicatorTimerRef.current);
    };
  }, [onStatusChange, speakText, openGate]);

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
      const res = await apiFetch('/api/alerts?resolved=false&limit=1');
      if (res.ok) {
        const data = await res.json();
        const activeAlert = data.alerts[0];
        if (activeAlert) {
          const resolveRes = await apiFetch('/api/alerts/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: activeAlert.id })
          });
          if (resolveRes.ok) {
            const result = await resolveRes.json();
            onStatusChange();
            // 서버가 돌려주는 실제 isEmergency만 믿는다 — 다른 미해결 알림이 남아 있으면
            // 아직 위험한 상황일 수 있는데 "안심하세요"를 재생하면 안 된다.
            if (!result.isEmergency) {
              stopAlarmSound();
              setRobotSpeech('경보를 해제했습니다. 안심하세요!');
              setRobotEmotion('happy');
              speakText('경보를 해제했습니다. 이제 안심하셔도 돼요!');
            }
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
      await apiFetch('/api/alerts', {
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
  // 웨이크워드 게이트가 닫혀 있으면 "듣고 있어요"라고 말하면 안 된다.
  // 어르신이 말을 걸었는데 반응이 없으면 로봇이 고장난 줄 안다 —
  // 지금 불러야 하는 상태인지 아닌지가 화면에서 분명해야 한다.
  const getStateColor = () => {
    if (sttUnavailable) return '#64748b';
    switch (voiceState) {
      case 'listening': return isGateActive ? '#10b981' : '#64748b';
      case 'processing': return '#f59e0b';
      case 'speaking': return '#3b82f6';
      default: return '#64748b';
    }
  };

  const getStateText = () => {
    if (sttUnavailable) return '아래에 글로 말씀해 주세요';
    switch (voiceState) {
      case 'listening': return isGateActive ? '말씀하세요, 듣고 있어요' : '"효돌아" 하고 불러주세요';
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
        {/* 안테나 불빛은 "지금 내 말을 듣고 있나"를 알리는 가장 큰 신호다.
            대화 창이 열렸을 때만 초록으로 빛난다 — 닫혀 있으면 차분한 기본색. */}
        <div className="antenna-tip" style={{
          background: status.isEmergency ? 'var(--accent-crimson)' :
            robotEmotion === 'thinking' ? 'var(--accent-amber)' :
            (voiceState === 'listening' && isGateActive) ? 'var(--accent-emerald)' : 'var(--primary)',
          boxShadow: status.isEmergency ? '0 0 20px var(--accent-crimson)' :
            (voiceState === 'listening' && isGateActive) ? '0 0 15px var(--accent-emerald)' : 'none'
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
          {voiceState === 'listening' && isGateActive && (
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
      {/* 카메라 캡처용 숨은 엘리먼트. 화면에 보이지 않고 프레임을 찍어 서버로 보내는 용도. */}
      {VISION_ENABLED && (
        <>
          <video ref={videoRef} playsInline muted style={{ display: 'none' }} />
          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </>
      )}

      {/* 개발용 진단 배지 — mock 폴백으로 조용히 떨어지는 것을 눈에 보이게 한다.
          어르신에게 보일 화면이 아니므로 배포 시에는 import.meta.env.DEV 로 가려진다. */}
      {import.meta.env.DEV && aiSource && (
        <div className={`ai-source-badge ${aiSource.source === 'gemini' ? 'is-live' : 'is-mock'}`}>
          {aiSource.source === 'gemini'
            ? `AI 연결됨${aiSource.model ? ` · ${aiSource.model}` : ''}`
            : `mock 응답${aiSource.reason ? ` · ${aiSource.reason}` : ''}`}
        </div>
      )}

      {/* 보호자 원격조종 이동 인디케이터 — 명령을 받았다는 시각 피드백 */}
      {moveDirection && (
        <div className="move-indicator">
          {MOVE_ARROWS[moveDirection]} 이동 중
        </div>
      )}

      {/* 효돌이 답변 말풍선 자막 */}
      {robotSpeech && (
        <div className="speech-bubble-container">
          <div className="speech-bubble">
            <span className="speech-sender">🤖 효돌이:</span>
            <p className="speech-text">{robotSpeech}</p>
          </div>
        </div>
      )}

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

      {/* 텍스트 대화 테스트 입력창 */}
      <form onSubmit={handleTextSubmit} className="text-chat-form">
        <input
          type="text"
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          placeholder="말씀을 입력해 주세요 (예: 안녕, 날씨 어때, 가슴 아파)..."
          className="text-chat-input"
          disabled={isChatLoading}
        />
        <button type="submit" className="text-chat-submit" disabled={isChatLoading || !textInput.trim()}>
          {isChatLoading ? '생각 중...' : '전송 💬'}
        </button>
      </form>

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
