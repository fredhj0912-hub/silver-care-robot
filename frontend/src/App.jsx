import React, { useState, useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import RobotFaceDisplay from './components/RobotFaceDisplay';
import GuardianApp from './guardian/GuardianApp';
import { apiFetch } from './lib/api';

/**
 * 한 빌드에 두 개의 앱이 들어 있다.
 *   /          로봇 키오스크 (라즈베리파이 7인치, 다크, 800×480 고정)
 *   /guardian  보호자 앱 (휴대폰, 밝은 화면, PWA)
 *
 * 백엔드와 API 클라이언트를 공유하므로 별도 프로젝트로 나누지 않았다.
 */
function KioskApp() {
  const [status, setStatus] = useState({
    status: 'online',
    battery: 100,
    seniorExpression: 'neutral',
    isEmergency: false,
  });

  const fetchStatus = async () => {
    try {
      const res = await apiFetch('/api/status');
      if (res.ok) setStatus(await res.json());
    } catch (err) {
      console.error('로봇 상태를 불러오지 못했습니다.', err);
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

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<KioskApp />} />
        <Route path="/guardian/*" element={<GuardianApp />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
