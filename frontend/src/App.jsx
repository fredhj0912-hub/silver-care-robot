import React, { useState, useEffect } from 'react';
import RobotSimulator from './components/RobotSimulator';
import GuardianDashboard from './components/GuardianDashboard';
import { Heart, Activity, ShieldAlert } from 'lucide-react';

function App() {
  const [activeTab, setActiveTab] = useState('robot'); // 'robot' or 'guardian'
  const [status, setStatus] = useState({
    status: 'online',
    battery: 100,
    seniorExpression: 'neutral',
    isEmergency: false
  });

  // Fetch status from backend periodically
  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch (err) {
      console.error('Failed to fetch status from backend.', err);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="app-container">
      {/* Header */}
      <header className="glass-panel" style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        marginBottom: '2rem',
        padding: '1.25rem 2rem',
        borderRadius: '16px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{
            background: 'linear-gradient(135deg, #5c64ec, #3b82f6)',
            padding: '0.6rem',
            borderRadius: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 4px 15px rgba(92, 100, 236, 0.4)'
          }}>
            <Heart size={24} color="#ffffff" fill="#ffffff" />
          </div>
          <div>
            <h1 style={{ fontSize: '1.4rem', fontWeight: 800, letterSpacing: '-0.025em', background: 'linear-gradient(to right, #f8fafc, #cbd5e1)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              실버 케어 반려 로봇 효돌이
            </h1>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>보고 듣고 말하는 효도 AI 봇</p>
          </div>
        </div>

        {/* System Badges */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {status.isEmergency && (
            <div className="animate-emergency" style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              color: 'var(--accent-crimson)',
              fontSize: '0.85rem',
              fontWeight: 700,
              padding: '0.4rem 0.8rem',
              borderRadius: '8px',
              border: '1px solid rgba(239, 68, 68, 0.4)'
            }}>
              <ShieldAlert size={16} />
              위급 상황 발생!
            </div>
          )}

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid var(--border-glass)',
            padding: '0.4rem 0.8rem',
            borderRadius: '8px',
            fontSize: '0.85rem'
          }}>
            <span style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: status.status === 'online' ? 'var(--accent-emerald)' : 'var(--text-muted)',
              display: 'inline-block',
              boxShadow: status.status === 'online' ? '0 0 8px var(--accent-emerald)' : 'none'
            }}></span>
            <span style={{ color: 'var(--text-secondary)' }}>기기 상태:</span>
            <span style={{ fontWeight: 600 }}>{status.status === 'online' ? '정상 작동' : '오프라인'}</span>
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid var(--border-glass)',
            padding: '0.4rem 0.8rem',
            borderRadius: '8px',
            fontSize: '0.85rem'
          }}>
            <Activity size={16} color="var(--accent-emerald)" />
            <span style={{ color: 'var(--text-secondary)' }}>배터리:</span>
            <span style={{ fontWeight: 600 }}>{status.battery}%</span>
          </div>
        </div>
      </header>

      {/* Tab Navigation */}
      <div style={{
        display: 'flex',
        background: 'rgba(22, 25, 41, 0.4)',
        padding: '0.4rem',
        borderRadius: '12px',
        border: '1px solid var(--border-glass)',
        marginBottom: '1.5rem',
        width: 'fit-content'
      }}>
        <button
          onClick={() => setActiveTab('robot')}
          className="btn"
          style={{
            background: activeTab === 'robot' ? 'var(--primary)' : 'transparent',
            borderColor: activeTab === 'robot' ? 'var(--primary)' : 'transparent',
            boxShadow: activeTab === 'robot' ? 'var(--shadow-glow)' : 'none',
            padding: '0.5rem 1.5rem',
            borderRadius: '8px'
          }}
        >
          🤖 효돌이 기기 화면
        </button>
        <button
          onClick={() => setActiveTab('guardian')}
          className="btn"
          style={{
            background: activeTab === 'guardian' ? 'var(--primary)' : 'transparent',
            borderColor: activeTab === 'guardian' ? 'var(--primary)' : 'transparent',
            boxShadow: activeTab === 'guardian' ? 'var(--shadow-glow)' : 'none',
            padding: '0.5rem 1.5rem',
            borderRadius: '8px'
          }}
        >
          🛡️ 보호자 대시보드
        </button>
      </div>

      {/* Main Content Areas */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'robot' ? (
          <RobotSimulator status={status} onStatusChange={fetchStatus} />
        ) : (
          <GuardianDashboard status={status} onStatusChange={fetchStatus} />
        )}
      </main>

      {/* Footer */}
      <footer style={{
        textAlign: 'center',
        padding: '2rem 0 1rem',
        color: 'var(--text-muted)',
        fontSize: '0.8rem',
        borderTop: '1px solid rgba(255, 255, 255, 0.03)',
        marginTop: '3rem'
      }}>
        &copy; 2026 한이음 드림업 - (멀티모달 LLM) 실버 케어 반려 로봇 프로젝트 S/W 프로토타입
      </footer>
    </div>
  );
}

export default App;
