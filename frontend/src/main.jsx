import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// 서비스 워커는 프로덕션 빌드의 **보호자 앱에서만** 등록한다.
// - 개발 중에 등록하면 캐시된 셸이 Vite의 HMR을 가로채 변경이 반영되지 않는다.
// - sw.js는 보호자 PWA 전용이다(셸 캐시가 '/guardian'). 키오스크에서 등록하면 백엔드가
//   죽었을 때 새로고침한 로봇 화면에 보호자 폰 앱이 뜬다.
// 이미 등록된 워커를 unregister하지는 않는다 — 스코프가 '/'라 보호자 폰에 설치된 PWA까지
// 함께 날아간다.
if (import.meta.env.PROD && 'serviceWorker' in navigator
    && window.location.pathname.startsWith('/guardian')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('서비스 워커 등록 실패 (앱은 정상 동작합니다):', err.message);
    });
  });
}
