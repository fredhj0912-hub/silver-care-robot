import React, { useState, useEffect } from 'react';
import RobotFaceDisplay from './components/RobotFaceDisplay';

const API_BASE = import.meta.env.VITE_API_URL || '';

function App() {
  const [status, setStatus] = useState({
    status: 'online',
    battery: 100,
    seniorExpression: 'neutral',
    isEmergency: false
  });

  // 백엔드에서 상태 주기적 조회
  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/status`);
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
    <div className="kiosk-root">
      <RobotFaceDisplay status={status} onStatusChange={fetchStatus} />
    </div>
  );
}

export default App;
