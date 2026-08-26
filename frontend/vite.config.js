import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 보호자 앱을 휴대폰에서 열려면 같은 Wi-Fi의 다른 기기가 접속할 수 있어야 한다.
    // (기본값은 localhost 만 허용)
    host: true,
    // cloudflared 터널이 발급하는 호스트명(Web Push에 필요한 HTTPS 확보용).
    // Vite는 기본적으로 임의 Host 헤더를 차단하므로 명시적으로 허용해야 한다.
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      }
    }
  },
  preview: {
    // 서비스 워커는 프로덕션 빌드에서만 등록되므로(main.jsx), 푸시 알림 테스트는
    // dev 서버가 아니라 preview 서버를 cloudflared로 터널링해야 한다.
    host: true,
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      }
    }
  }
})
