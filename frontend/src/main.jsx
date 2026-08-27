import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// 서비스 워커는 프로덕션 빌드에서만 등록한다.
// 개발 중에 등록하면 캐시된 셸이 Vite의 HMR을 가로채 변경이 반영되지 않는다.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('서비스 워커 등록 실패 (앱은 정상 동작합니다):', err.message);
    });
  });
}
