// Vitest + jsdom 공용 셋업. vite.config.js의 test.setupFiles가 가리킨다.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// jsdom에는 Notification이 없다. HomeScreen이 마운트 때 pushSupported() 경로에서
// Notification.permission을 읽으므로, .env의 VITE_VAPID_PUBLIC_KEY 유무에 따라
// 테스트 결과가 달라지지 않도록 여기서 고정한다('granted'면 권한 배너가 안 뜬다).
vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' });

// jsdom은 isSecureContext를 false로 준다. 키오스크는 보안 컨텍스트가 아니면 음성 인식을
// 아예 시작하지 않으므로(HTTPS·localhost에서만 동작), 실제 배포와 같은 조건으로 맞춘다.
//
// beforeEach인 이유: 테스트 파일이 afterEach에서 vi.unstubAllGlobals()를 부르면 여기서 건
// 스텁까지 함께 풀린다. 파일 최상단에서 한 번만 걸면 각 파일의 첫 테스트에서만 유효하다.
// 'insecure' 경로를 검증하는 테스트는 자기 본문에서 이 값을 덮어쓴다.
beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
});

// 테스트끼리 DOM이 새는 것을 막는다 (RTL은 자동 정리를 하지 않는다).
afterEach(cleanup);
