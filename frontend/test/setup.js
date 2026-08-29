// Vitest + jsdom 공용 셋업. vite.config.js의 test.setupFiles가 가리킨다.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom에는 Notification이 없다. HomeScreen이 마운트 때 pushSupported() 경로에서
// Notification.permission을 읽으므로, .env의 VITE_VAPID_PUBLIC_KEY 유무에 따라
// 테스트 결과가 달라지지 않도록 여기서 고정한다('granted'면 권한 배너가 안 뜬다).
vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' });

// 테스트끼리 DOM이 새는 것을 막는다 (RTL은 자동 정리를 하지 않는다).
afterEach(cleanup);
