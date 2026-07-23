import React, { useState, useEffect, useRef } from 'react';
import { Heart, RefreshCw, AlertOctagon, Send } from 'lucide-react';

function GuardianDashboard({ status, onStatusChange }) {
  const [history, setHistory] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [remoteMessage, setRemoteMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [latestImage, setLatestImage] = useState(null);
  
  const lastSpokenIdRef = useRef(0);
  const [isFirstLoad, setIsFirstLoad] = useState(true);
  const chatEndRef = useRef(null);

  // Scroll to bottom of chat
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [history]);

  // Speak senior messages automatically when they arrive
  useEffect(() => {
    if (history.length === 0) return;

    if (isFirstLoad) {
      // Find the maximum ID in the current history to initialize lastSpokenId
      const maxId = Math.max(...history.map(h => h.id), 0);
      lastSpokenIdRef.current = maxId;
      setIsFirstLoad(false);
      return;
    }

    const latestMsg = history[history.length - 1];
    if (latestMsg.sender === 'senior' && latestMsg.id > lastSpokenIdRef.current) {
      lastSpokenIdRef.current = latestMsg.id;

      if (window.speechSynthesis) {
        window.speechSynthesis.cancel(); // Cancel any active TTS speech
        const utterance = new SpeechSynthesisUtterance(latestMsg.text);
        utterance.lang = 'ko-KR';
        const voices = window.speechSynthesis.getVoices();
        const koVoice = voices.find(v => v.lang.includes('KO') || v.lang.toLowerCase().includes('kr'));
        if (koVoice) utterance.voice = koVoice;
        utterance.rate = 1.0;
        window.speechSynthesis.speak(utterance);
      }
    }
  }, [history, isFirstLoad]);

  // Update mock system time for status bar
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch dialogue history, alerts, and latest CCTV image
  const fetchLogs = async () => {
    setIsLoadingLogs(true);
    try {
      const [historyRes, latestImageRes] = await Promise.all([
        fetch('/api/history'),
        fetch('/api/vision/latest').catch(e => null)
      ]);

      if (historyRes && historyRes.ok) {
        const data = await historyRes.json();
        setHistory(data.history || []);
        
        const sortedAlerts = (data.alerts || []).sort((a, b) => 
          new Date(b.timestamp) - new Date(a.timestamp)
        );
        setAlerts(sortedAlerts);
      }

      if (latestImageRes && latestImageRes.ok) {
        const imgData = await latestImageRes.json();
        setLatestImage(imgData.image);
      }
    } catch (err) {
      console.error('Error fetching logs', err);
    } finally {
      setIsLoadingLogs(false);
    }
  };

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 4000);
    return () => clearInterval(interval);
  }, []);

  // Send remote TTS message to robot
  const handleSendRemoteMessage = async (e) => {
    e.preventDefault();
    if (!remoteMessage.trim()) return;

    setIsSending(true);
    try {
      const res = await fetch('/api/remote-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: remoteMessage })
      });
      if (res.ok) {
        setRemoteMessage('');
        fetchLogs();
        alert('로봇에게 메시지가 성공적으로 송신되었습니다. 곧 음성으로 재생됩니다.');
      }
    } catch (err) {
      console.error(err);
      alert('메시지 전송에 실패했습니다.');
    } finally {
      setIsSending(false);
    }
  };

  // Resolve emergency alert
  const handleResolveAlert = async (alertId) => {
    try {
      const res = await fetch('/api/alerts/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: alertId })
      });
      if (res.ok) {
        fetchLogs();
        onStatusChange();
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Calculate some analytics
  const totalConversations = history.filter(h => h.sender === 'senior').length;
  const activeAlertsCount = alerts.filter(a => !a.resolved).length;
  
  // Calculate emotion distribution
  const emotionStats = history.reduce((acc, curr) => {
    if (curr.sender === 'senior') {
      acc[curr.emotion] = (acc[curr.emotion] || 0) + 1;
      acc.total += 1;
    }
    return acc;
  }, { happy: 0, neutral: 0, sad: 0, pain: 0, total: 0 });

  const getEmotionPercentage = (type) => {
    if (emotionStats.total === 0) return 0;
    return Math.round(((emotionStats[type] || 0) / emotionStats.total) * 100);
  };

  const happyPct = getEmotionPercentage('happy');
  const sadPct = getEmotionPercentage('sad') + getEmotionPercentage('pain');
  const neutralPct = Math.max(0, 100 - happyPct - sadPct);

  return (
    <div className="phone-container">
      {/* Smartphone Device Mockup Bezel */}
      <div className="phone-mockup">
        {/* Notch Area */}
        <div className="phone-notch">
          <div className="phone-speaker"></div>
          <div className="phone-camera"></div>
        </div>

        {/* Status Bar */}
        <div className="phone-status-bar">
          <span>{currentTime.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
          <div className="phone-status-icons">
            <span>LTE</span>
            <span>📶</span>
            <span>🔋 {status.battery}%</span>
          </div>
        </div>

        {/* Home Screen App Content */}
        <div className="phone-screen">
          {/* Mock App Header */}
          <div style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center', 
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)', 
            paddingBottom: '0.6rem',
            marginBottom: '0.1rem',
            userSelect: 'none'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Heart size={16} color="var(--accent-crimson)" fill="var(--accent-crimson)" style={{ animation: 'float 2s infinite' }} />
              <span style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary)' }}>효돌이 안심 케어</span>
            </div>
            <button 
              onClick={fetchLogs} 
              disabled={isLoadingLogs}
              style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
            >
              <RefreshCw size={13} className={isLoadingLogs ? "animate-spin" : ""} />
            </button>
          </div>

          {/* Real-time Senior Safety Diagnosis Card */}
          <div className="glass-panel" style={{
            padding: '1rem',
            borderRadius: '16px',
            borderLeft: status.isEmergency ? '4px solid var(--accent-crimson)' : '4px solid var(--accent-emerald)',
            animation: status.isEmergency ? 'emergency-pulse 2s infinite' : 'none'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>실시간 안전 진단</span>
              <span style={{
                fontSize: '0.65rem',
                padding: '0.25rem 0.5rem',
                borderRadius: '6px',
                fontWeight: 700,
                backgroundColor: status.isEmergency ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                color: status.isEmergency ? 'var(--accent-crimson)' : 'var(--accent-emerald)',
                border: status.isEmergency ? '1px solid rgba(239, 68, 68, 0.2)' : '1px solid rgba(16, 185, 129, 0.2)'
              }}>
                {status.isEmergency ? '⚠️ 위급 상황' : '✓ 안전 상태'}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.78rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.03)', paddingBottom: '0.4rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>최근 얼굴 표정:</span>
                <strong style={{ color: 'var(--text-primary)' }}>
                  {status.seniorExpression === 'happy' ? '😊 매우 밝음 (미소)' : 
                   status.seniorExpression === 'sad' ? '😢 우울/쓸쓸함' : 
                   status.seniorExpression === 'pain' ? '😫 고통/신음' : 
                   status.seniorExpression === 'sleeping' ? '💤 수면 중' : '😐 평온함 (보통)'}
                </strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)' }}>마지막 활동 시각:</span>
                <span style={{ color: 'var(--text-primary)' }}>{status.lastActive ? new Date(status.lastActive).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-'}</span>
              </div>
            </div>
          </div>

          {/* 실시간 CCTV 모니터링 패널 */}
          <div className="glass-panel" style={{ padding: '0.8rem', borderRadius: '16px', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                📹 실시간 CCTV 모니터링
              </span>
              {latestImage && (
                <span style={{ 
                  fontSize: '0.62rem', 
                  color: 'var(--accent-crimson)', 
                  fontWeight: 800, 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '3px'
                }}>
                  <span className="live-dot" style={{ display: 'inline-block', width: '6px', height: '6px', backgroundColor: 'var(--accent-crimson)', borderRadius: '50%' }}></span>
                  LIVE
                </span>
              )}
            </div>
            
            <div style={{ 
              position: 'relative', 
              width: '100%', 
              height: '160px', 
              backgroundColor: '#07080d', 
              borderRadius: '12px', 
              overflow: 'hidden', 
              display: 'flex', 
              justifyContent: 'center', 
              alignItems: 'center',
              border: '1px solid rgba(255, 255, 255, 0.05)'
            }}>
              {latestImage ? (
                <>
                  <img 
                    src={latestImage} 
                    alt="CCTV Feed" 
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }} 
                  />
                  {/* CCTV Scan Line overlay effect */}
                  <div style={{
                    position: 'absolute',
                    top: 0, left: 0, right: 0, bottom: 0,
                    background: 'linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.03), rgba(0, 255, 0, 0.01), rgba(0, 0, 255, 0.03))',
                    backgroundSize: '100% 4px, 6px 100%',
                    pointerEvents: 'none'
                  }}></div>
                  {/* CCTV grid layout overlay text */}
                  <span style={{ position: 'absolute', bottom: '8px', left: '8px', fontSize: '0.58rem', color: 'rgba(255,255,255,0.7)', fontFamily: 'monospace', textShadow: '1px 1px 1px #000' }}>
                    CAM01 - SENIOR_ROOM
                  </span>
                  <span style={{ position: 'absolute', top: '8px', right: '8px', fontSize: '0.58rem', color: 'rgba(255,255,255,0.7)', fontFamily: 'monospace', textShadow: '1px 1px 1px #000' }}>
                    {currentTime.toLocaleDateString('ko-KR')}
                  </span>
                </>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)' }}>
                  <span style={{ fontSize: '1.5rem' }}>📺</span>
                  <span style={{ fontSize: '0.7rem' }}>기기 영상 신호 대기 중...</span>
                </div>
              )}
            </div>
          </div>

          {/* Active Emergency Alert Push Notification */}
          {activeAlertsCount > 0 && (
            <div className="glass-panel" style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid var(--accent-crimson)', padding: '1rem', borderRadius: '16px' }}>
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', marginBottom: '0.6rem' }}>
                <AlertOctagon color="var(--accent-crimson)" size={20} style={{ flexShrink: 0, marginTop: '2px' }} />
                <div>
                  <h4 style={{ color: 'var(--accent-crimson)', fontWeight: 700, fontSize: '0.8rem' }}>긴급 응급 경보 알림!</h4>
                  <p style={{ fontSize: '0.72rem', color: 'var(--text-primary)', marginTop: '0.2rem', lineHeight: '1.4' }}>
                    {alerts.find(a => !a.resolved)?.description}
                  </p>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button 
                  onClick={() => handleResolveAlert(alerts.find(a => !a.resolved)?.id)}
                  className="btn btn-danger" 
                  style={{ flex: 1, justifyContent: 'center', fontSize: '0.72rem', padding: '0.45rem', borderRadius: '10px' }}
                >
                  경보 해제 및 조치 완료
                </button>
                <button 
                  onClick={() => {
                    const alert = alerts.find(a => !a.resolved);
                    if (alert && alert.snapshotUrl) {
                      alert('위급 상황 캡처 스냅샷 로드 완료 (서버 로그 참조)');
                    } else {
                      alert('저장된 스냅샷이 없습니다.');
                    }
                  }}
                  className="btn" 
                  style={{ fontSize: '0.72rem', padding: '0.45rem', borderRadius: '10px' }}
                >
                  스냅샷
                </button>
              </div>
            </div>
          )}

          {/* 💬 어르신과의 1:1 안심 대화방 (통합 메신저) */}
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', height: '360px', padding: '0.9rem', borderRadius: '16px' }}>
            <h3 style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              💬 어르신과의 1:1 안심 대화방
            </h3>

            {/* 대화 버블 영역 */}
            <div style={{ 
              flex: 1, 
              overflowY: 'auto', 
              display: 'flex', 
              flexDirection: 'column',
              gap: '0.5rem',
              paddingRight: '0.15rem',
              marginBottom: '0.6rem'
            }}>
              {history.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', textAlign: 'center', padding: '2rem 0' }}>
                  기록된 대화 피드가 없습니다.
                </div>
              ) : (
                history.map((msg) => {
                  const isSenior = msg.sender === 'senior';
                  const isGuardian = msg.sender === 'guardian';
                  
                  let bubbleClass = 'chat-bubble senior';
                  let senderName = '👵 어르신';
                  let alignSelf = 'flex-start';
                  
                  if (isGuardian) {
                    bubbleClass = 'chat-bubble guardian';
                    senderName = '보호자 (나)';
                    alignSelf = 'flex-end';
                  } else if (isSenior) {
                    bubbleClass = 'chat-bubble senior';
                    senderName = '👵 어르신';
                    alignSelf = 'flex-start';
                  } else {
                    bubbleClass = 'chat-bubble robot';
                    senderName = '🤖 효돌이 (AI)';
                    alignSelf = 'flex-start';
                  }

                  return (
                    <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', alignSelf, maxWidth: '85%' }}>
                      <span style={{ fontSize: '0.58rem', color: 'var(--text-muted)', marginBottom: '0.1rem', padding: '0 0.1rem', textAlign: alignSelf === 'flex-end' ? 'right' : 'left' }}>
                        {senderName} • {new Date(msg.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <div className={bubbleClass} style={{ padding: '0.5rem 0.75rem', fontSize: '0.78rem', borderRadius: '12px', marginBottom: '0px' }}>
                        {msg.text}
                        {isSenior && msg.emotion && msg.emotion !== 'neutral' && (
                          <span style={{
                            display: 'inline-block',
                            fontSize: '0.58rem',
                            background: msg.emotion === 'happy' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                            color: msg.emotion === 'happy' ? 'var(--accent-emerald)' : 'var(--accent-crimson)',
                            padding: '0.05rem 0.2rem',
                            borderRadius: '3px',
                            marginLeft: '0.3rem',
                            fontWeight: 600
                          }}>
                            {msg.emotion === 'happy' ? '행복' : msg.emotion === 'sad' ? '슬픔' : msg.emotion === 'pain' ? '통증' : msg.emotion}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={chatEndRef} />
            </div>

            {/* 통합 채팅 입력 폼 */}
            <form onSubmit={handleSendRemoteMessage} style={{ display: 'flex', gap: '0.4rem', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '0.6rem' }}>
              <input
                type="text"
                placeholder="어르신께 메시지 보내기 (로봇이 읽어드립니다)..."
                value={remoteMessage}
                onChange={(e) => setRemoteMessage(e.target.value)}
                disabled={isSending}
                style={{
                  flex: 1,
                  background: 'rgba(0, 0, 0, 0.25)',
                  border: '1px solid var(--border-glass)',
                  borderRadius: '8px',
                  padding: '0.45rem 0.6rem',
                  color: '#ffffff',
                  fontSize: '0.75rem',
                  outline: 'none'
                }}
              />
              <button
                type="submit"
                disabled={isSending || !remoteMessage.trim()}
                className="btn btn-primary"
                style={{ padding: '0.45rem 0.8rem', fontSize: '0.75rem', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '0.2rem' }}
              >
                <Send size={12} />
                전송
              </button>
            </form>
          </div>

          {/* Weekly Emotion Distribution Report */}
          <div className="glass-panel" style={{ padding: '0.9rem', borderRadius: '16px' }}>
            <h3 style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: '0.6rem' }}>📊 주간 정서 진단 분포</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem', fontSize: '0.72rem' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.15rem' }}>
                  <span>긍정 (기쁨/안정)</span>
                  <span style={{ color: 'var(--accent-emerald)', fontWeight: 600 }}>{happyPct}%</span>
                </div>
                <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.03)', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{ width: `${happyPct}%`, height: '100%', background: 'var(--accent-emerald)' }}></div>
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.15rem' }}>
                  <span>평온 (보통)</span>
                  <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{neutralPct}%</span>
                </div>
                <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.03)', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{ width: `${neutralPct}%`, height: '100%', background: 'var(--primary)' }}></div>
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.15rem' }}>
                  <span>주의 (우울/통증)</span>
                  <span style={{ color: 'var(--accent-crimson)', fontWeight: 600 }}>{sadPct}%</span>
                </div>
                <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.03)', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{ width: `${sadPct}%`, height: '100%', background: 'var(--accent-crimson)' }}></div>
                </div>
              </div>
            </div>
          </div>

          {/* Sensor Alert Logs Feed */}
          <div className="glass-panel" style={{ padding: '0.9rem', borderRadius: '16px', marginBottom: '0.5rem' }}>
            <h3 style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: '0.5rem' }}>🚨 센서 감지 이력</h3>
            <div style={{ maxHeight: '110px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {alerts.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', textAlign: 'center', padding: '1rem 0' }}>
                  감지 이력이 없습니다.
                </div>
              ) : (
                alerts.map((alertItem) => (
                  <div 
                    key={alertItem.id} 
                    style={{
                      background: alertItem.resolved ? 'rgba(255,255,255,0.01)' : 'rgba(239,68,68,0.03)',
                      border: alertItem.resolved ? '1px solid rgba(255,255,255,0.03)' : '1px solid rgba(239,68,68,0.2)',
                      borderRadius: '8px',
                      padding: '0.4rem 0.5rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: '0.7rem'
                    }}
                  >
                    <div>
                      <strong style={{ color: alertItem.resolved ? 'var(--text-secondary)' : 'var(--accent-crimson)' }}>
                        {alertItem.type === 'fall_sensor' ? '낙상 감지' : 
                         alertItem.type === 'voice_trigger' ? '음성 위급' : '비상 버튼'}
                      </strong>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.62rem', marginTop: '0.05rem' }}>
                        {new Date(alertItem.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    <span style={{ color: alertItem.resolved ? 'var(--text-muted)' : 'var(--accent-crimson)', fontSize: '0.65rem', fontWeight: 600 }}>
                      {alertItem.resolved ? '조치 완료' : '미조치'}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Home Indicator Bar */}
        <div className="phone-home-indicator"></div>
      </div>
    </div>
  );
}

export default GuardianDashboard;
