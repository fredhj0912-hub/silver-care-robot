import React, { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '../lib/api';
import { createRecognizer, isSupported as isSTTSupported, classifySttError } from '../lib/stt';
import { decideAction, pickAcknowledgeReply, ACTIVE_WINDOW_MS } from '../lib/wakeword';
import { useCameraMonitor } from '../lib/useCameraMonitor';

// 카메라 모니터링은 기본 비활성 — 켜는 것 자체가 사용자 동의와 비용이 따르는 결정이라
// 명시적 옵트인으로 둔다. 켜려면 frontend/.env 에 VITE_VISION_ENABLED=true.
const VISION_ENABLED = import.meta.env.VITE_VISION_ENABLED === 'true';
const VISION_INTERVAL_MS = Number(import.meta.env.VITE_VISION_INTERVAL_MS) || 15000;

const MOVE_ARROWS = { up: '⬆️', down: '⬇️', left: '⬅️', right: '➡️' };

// 일시적 STT 오류가 이만큼 연속되면 음성 인식을 포기하고 텍스트 입력으로 안내한다.
const STT_FAIL_LIMIT = 3;

// 음성 인식이 안 될 때 화면에 뜨는 문구. 원인을 말해야 앞에 선 사람이 고칠 수 있다.
const STT_UNAVAILABLE_TEXT = {
  insecure: '안전하지 않은 주소로 열렸어요 (HTTPS 필요) · 아래에 글로 말씀해 주세요',
  denied: '마이크를 쓸 수 없어요 · 아래에 글로 말씀해 주세요',
  network: '음성 인식 서버에 닿지 않아요 · 아래에 글로 말씀해 주세요',
  unsupported: '아래에 글로 말씀해 주세요',
};

// 화면에 뜨는 이동 화살표는 '방금 내린 명령'만 반영한다. 이보다 오래된 미처리 명령은
// 네트워크가 끊겼다 돌아온 흔적이므로 지금 실행하면 안 된다.
const MOVE_MAX_AGE_MS = 2000;

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
  const speechWatchdogRef = useRef(null); // 발화 완료 콜백이 영영 안 올 때를 대비한 타이머

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

  // 음성 인식이 안 되는 '이유' — 'insecure' | 'unsupported' | 'denied' | 'network'.
  // 이 화면 앞에는 devtools를 열어 둘 사람이 없다. 콘솔이 아니라 7인치 화면에 떠야 한다.
  const [sttReason, setSttReason] = useState(null);

  // 일시적 오류(주로 'network')의 연속 횟수. onresult가 오면 0으로 되돌린다.
  const sttFailStreakRef = useRef(0);

  // 보호자 원격조종 이동 인디케이터 — 방향을 잠깐 보여주고 사라진다.
  // id를 함께 담는 이유는 같은 방향을 연속으로 눌렀을 때도 상태가 바뀌어
  // 아래 자동 소멸 효과가 다시 걸리게 하기 위해서다.
  const [moveIndicator, setMoveIndicator] = useState(null);
  // 같은 move 명령을 폴링마다 다시 그리지 않도록 마지막으로 본 id를 기억한다
  const lastSeenMoveIdRef = useRef(null);

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

  /**
   * 말하기가 끝났을 때(정상/오류/워치독 모두) 공통으로 하는 뒷정리.
   * 워치독과 실제 완료 콜백이 겹칠 수 있으므로 **멱등**이어야 한다.
   */
  const finishSpeaking = useCallback(() => {
    clearTimeout(speechWatchdogRef.current);
    speechWatchdogRef.current = null;
    if (!isSpeakingRef.current) return;

    isSpeakingRef.current = false;
    if (!emergencyRef.current) setRobotEmotion('neutral');
    setVoiceState('idle');
    startListening();
  }, []);

  /**
   * 발화 완료 콜백이 영영 오지 않는 경우를 대비한 워치독.
   *
   * speech-dispatcher/espeak가 없는 리눅스에서는 `speechSynthesis.speak()`가 조용히
   * 무시되어 onend/onerror가 **한 번도 오지 않는다.** 그러면 isSpeakingRef가 true로 잠기고
   * startListening()이 영구 차단되어 **로봇이 완전히 귀머거리가 된다.**
   * 워치독이 그 상태를 "한 문장 유실"로 낮춘다.
   */
  const armSpeechWatchdog = useCallback((text) => {
    clearTimeout(speechWatchdogRef.current);
    const budget = Math.min(30000, 3000 + text.length * 200);
    speechWatchdogRef.current = setTimeout(() => {
      console.warn(`발화 완료 신호가 ${budget}ms 안에 오지 않았습니다 — 강제로 듣기를 재개합니다.`);
      finishSpeaking();
    }, budget);
  }, [finishSpeaking]);

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
    // 실제 재생이 시작되는 시점 기준으로 예산을 다시 잡는다
    armSpeechWatchdog(text);
  }, [finishSpeaking, armSpeechWatchdog]);

  const speakText = useCallback(async (text) => {
    if (!text) return;

    // 인식을 먼저 멈춘다 — 서버 응답을 기다리는 동안에도 자기 목소리를 들으면 안 된다
    isSpeakingRef.current = true;
    setVoiceState('speaking');
    // 여기서부터 무장한다 — /api/tts 응답이 영영 안 와도 같은 교착에 빠지기 때문이다
    armSpeechWatchdog(text);
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
  }, [speakWithBrowser, finishSpeaking, armSpeechWatchdog]);

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
    // 보안 컨텍스트(HTTPS 또는 localhost)가 아니면 음성 인식·카메라·서비스워커가 전부
    // 조용히 죽는다. 파이를 http://<LAN IP>:3001 로 연 경우가 정확히 이것이다.
    if (!window.isSecureContext) {
      console.warn('보안 컨텍스트가 아닙니다 (HTTPS 필요) — 음성 인식을 쓸 수 없습니다.');
      setSttUnavailable(true);
      setSttReason('insecure');
      return;
    }

    if (!isSTTSupported()) {
      console.warn('이 브라우저는 Web Speech API를 지원하지 않습니다. 텍스트 입력을 사용하세요.');
      setSttUnavailable(true);
      setSttReason('unsupported');
      return;
    }

    let restartTimer = null;

    /** 음성 인식을 포기하고 텍스트 입력으로 안내한다 (재시작 루프도 멈춘다) */
    const disableStt = (reason) => {
      shouldListenRef.current = false;
      setSttUnavailable(true);
      setSttReason(reason);
      setVoiceState('idle');
    };

    const recognizer = createRecognizer({
      onStart: () => {
        if (!isSpeakingRef.current) setVoiceState('listening');
      },
      onResult: (text) => {
        sttFailStreakRef.current = 0;  // 한 번이라도 들렸으면 연속 실패가 아니다
        handleTranscript(text);
      },
      onError: (err) => {
        console.error('음성 인식 오류:', err);
        if (classifySttError(err) === 'fatal') {
          disableStt('denied');
          return;
        }
        // 일시적 오류는 연속 횟수를 센다. 구글 음성 키 없이 빌드된 Chromium은
        // 매 세션 'network'로 끝나므로, 세지 않으면 영원히 재시작만 반복한다.
        sttFailStreakRef.current += 1;
        if (sttFailStreakRef.current >= STT_FAIL_LIMIT) disableStt('network');
      },
      onEnd: () => {
        // TTS 출력 중이 아니고 계속 들어야 하면 자동 재시작.
        // 브라우저 STT는 장시간 세션에서 조용히 끊기므로 이 재시작이 필수다.
        // 다만 실패가 이어지면 간격을 늘린다 — 예전에는 고정 300ms였고,
        // 영구 실패 상태에서는 초당 3회짜리 무한 루프가 됐다.
        if (isSpeakingRef.current || !shouldListenRef.current) return;
        const delay = Math.min(300 * 2 ** sttFailStreakRef.current, 10000);
        restartTimer = setTimeout(() => startListening(), delay);
      },
    });

    recognitionRef.current = recognizer;
    shouldListenRef.current = true;

    const initTimer = setTimeout(() => startListening(), 1000);

    return () => {
      clearTimeout(initTimer);
      clearTimeout(restartTimer);
      clearTimeout(gateTimerRef.current);
      clearTimeout(speechWatchdogRef.current);
      shouldListenRef.current = false;
      recognizer.abort();
    };
  }, [handleTranscript, startListening]);

  // ──────────────────────────────────────────────
  // 보호자 명령 큐 폴링
  //
  // 예전에는 deprecated GET /api/remote-message/poll 을 썼다 — SSE(command.issued)가
  // 이미 있는데도 프론트가 옮겨가지 않았던 것. 이제 현재 API(/api/commands/pending)로
  // 조회하고 ack 한다. 완전한 SSE 전환은 이번 범위 밖이라 폴링 방식은 유지한다.
  //
  // **speak만 소비(ack)하고 move는 보기만 한다.** move의 소비자는 실물 구동부를 돌리는
  // 프로세스 하나뿐이어야 한다 — 여기서 ack해 버리면 모터가 명령을 영영 못 받는다.
  // 화살표를 계속 그리는 이유는, 구동부가 아직 없을 때 화면에 아무 반응이 없으면
  // "원격조종이 고장난 것"과 구분이 안 되기 때문이다.
  // ──────────────────────────────────────────────
  useEffect(() => {
    const pollSpeak = async () => {
      const res = await apiFetch('/api/commands/pending?kind=speak');
      if (!res.ok) return;
      const data = await res.json();

      for (const command of data.commands) {
        // 발화의 출처 라벨. 보호자 메시지가 기본이고, 복약 스케줄러처럼
        // 시스템이 넣은 명령은 payload.label로 자기 이름을 밝힌다.
        const label = command.payload.label || '보호자님 메시지';
        setRobotSpeech(`${label}: ${command.payload.text}`);
        // 보호자가 말을 걸었으니 어르신이 바로 대답할 수 있게 창을 열어둔다.
        // 이때 "효돌아"부터 다시 불러야 한다면 대화가 끊긴다.
        openGate();
        speakText(command.payload.text);
        onStatusChange();
        await apiFetch(`/api/commands/${command.id}/ack`, { method: 'POST' });
      }
    };

    const observeMove = async () => {
      const res = await apiFetch(`/api/commands/pending?kind=move&maxAgeMs=${MOVE_MAX_AGE_MS}`);
      if (!res.ok) return;
      const data = await res.json();

      const latest = data.commands[data.commands.length - 1];
      if (!latest || latest.id === lastSeenMoveIdRef.current) return;

      lastSeenMoveIdRef.current = latest.id;
      setMoveIndicator({ id: latest.id, direction: latest.payload.direction });
    };

    const pollCommands = async () => {
      try {
        await pollSpeak();
        await observeMove();
      } catch (err) {
        console.error('Command poll error:', err);
      }
    };

    const interval = setInterval(pollCommands, 2500);
    return () => clearInterval(interval);
  }, [onStatusChange, speakText, openGate]);

  // 인디케이터의 소멸은 **자기 상태에만** 묶는다. 명령 폴링 효과에 얹어 두면
  // 그 효과가 재실행될 때 정리 함수가 타이머를 지워 표시가 화면에 박제된다
  // (09-01 파이 실측에서 실제로 겪었다).
  useEffect(() => {
    if (!moveIndicator) return undefined;
    const timer = setTimeout(() => setMoveIndicator(null), 1500);
    return () => clearTimeout(timer);
  }, [moveIndicator]);

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
    // 고칠 수 있는 실패(주소·권한·음성 서버)는 회색이 아니라 주황으로 — 눈에 띄어야 한다
    if (sttUnavailable) return sttReason && sttReason !== 'unsupported' ? '#f59e0b' : '#64748b';
    switch (voiceState) {
      case 'listening': return isGateActive ? '#10b981' : '#64748b';
      case 'processing': return '#f59e0b';
      case 'speaking': return '#3b82f6';
      default: return '#64748b';
    }
  };

  const getStateText = () => {
    if (sttUnavailable) return STT_UNAVAILABLE_TEXT[sttReason] || STT_UNAVAILABLE_TEXT.unsupported;
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
      {moveIndicator && (
        <div className="move-indicator">
          {MOVE_ARROWS[moveIndicator.direction]} 이동 중
        </div>
      )}

      {/* 카메라를 못 잡았을 때 — 대화는 정상이라는 것까지 알려준다 */}
      {cameraError && (
        <div className="camera-error-chip">📷 카메라 없음 · 대화는 정상</div>
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
