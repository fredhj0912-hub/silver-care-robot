import React from 'react';
import { NavLink, Route, Routes } from 'react-router';
import { useGuardianData } from '../lib/useGuardianData';
import { formatTime } from './format';
import HomeScreen from './screens/HomeScreen';
import AlertsScreen from './screens/AlertsScreen';
import LogScreen from './screens/LogScreen';
import SendScreen from './screens/SendScreen';
import LiveScreen from './screens/LiveScreen';
import './guardian.css';

const TABS = [
  { to: '/guardian', label: '안부', end: true },
  { to: '/guardian/alerts', label: '알림' },
  { to: '/guardian/log', label: '대화' },
  { to: '/guardian/send', label: '보내기' },
];

function GuardianApp() {
  const data = useGuardianData();
  const { status, openAlerts } = data;
  const emergency = Boolean(status?.isEmergency || openAlerts.length);

  return (
    <div className={`guardian-root${emergency ? ' is-emergency' : ''}`}>
      <header className="g-header">
        <span className="g-header__name">효돌이</span>
        <span className="g-header__clock">{formatTime(new Date().toISOString())}</span>
      </header>

      <Routes>
        <Route index element={<HomeScreen {...data} />} />
        <Route path="alerts" element={<AlertsScreen onChange={data.refresh} />} />
        <Route path="log" element={<LogScreen />} />
        <Route path="send" element={<SendScreen />} />
        <Route path="live" element={<LiveScreen />} />
      </Routes>

      <nav className="g-tabs">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) => `g-tab${isActive ? ' is-active' : ''}`}
          >
            {tab.label}
            {tab.label === '알림' && openAlerts.length > 0 && (
              <span className="g-tab__badge">{openAlerts.length}</span>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export default GuardianApp;
