import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// 권한 배너는 permission === 'default' 일 때만 뜬다. 한 번 허용한 뒤 서버가 구독을
// 잃어버리면(백엔드 재배포로 DB가 새로 시작 등) 보호자에게는 아무것도 안 보이는데
// 응급 푸시만 조용히 안 가는 상태가 된다 — 그 재등록 경로를 지키는 테스트다.

const SUB = {
  toJSON: () => ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh: 'p256dh-값', auth: 'auth-값' },
  }),
};

let calls;
let subscribeSpy;

function stubBrowser({ permission = 'granted', existing = SUB } = {}) {
  calls = [];
  subscribeSpy = vi.fn(async () => SUB);
  vi.stubGlobal('Notification', { permission, requestPermission: async () => permission });
  vi.stubGlobal('PushManager', function PushManager() {});
  vi.stubGlobal('navigator', {
    serviceWorker: {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: async () => existing,
          subscribe: subscribeSpy,
        },
      }),
    },
  });
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return { ok: true, json: async () => ({ success: true }) };
  }));
}

async function loadPush() {
  vi.resetModules();          // VAPID 키를 읽는 모듈 최상단이 매번 다시 평가되도록
  return import('../src/lib/push.js');
}

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('ensurePushRegistered', () => {
  test('권한이 이미 granted면 배너 없이 구독을 다시 등록한다', async () => {
    stubBrowser({ permission: 'granted' });
    const { ensurePushRegistered } = await loadPush();

    expect(await ensurePushRegistered()).toBe(true);

    const post = calls.find((c) => c.url.includes('/api/push/subscribe'));
    expect(post, '구독 재등록 요청이 나가지 않았다').toBeTruthy();
    expect(post.options.method).toBe('POST');
    expect(JSON.parse(post.options.body)).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      keys: { p256dh: 'p256dh-값', auth: 'auth-값' },
    });
  });

  test('브라우저에 구독이 없으면 새로 만들어 등록한다', async () => {
    stubBrowser({ permission: 'granted', existing: null });
    const { ensurePushRegistered } = await loadPush();

    expect(await ensurePushRegistered()).toBe(true);
    expect(subscribeSpy).toHaveBeenCalledOnce();
    expect(calls.some((c) => c.url.includes('/api/push/subscribe'))).toBe(true);
  });

  // 권한을 거부한 사람에게 몰래 구독을 만들려 해서는 안 된다.
  test('권한이 default/denied면 아무 요청도 보내지 않는다', async () => {
    for (const permission of ['default', 'denied']) {
      stubBrowser({ permission });
      const { ensurePushRegistered } = await loadPush();
      expect(await ensurePushRegistered()).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  test('등록이 실패해도 예외를 던지지 않는다 (화면을 막으면 안 된다)', async () => {
    stubBrowser({ permission: 'granted' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('네트워크 끊김'); }));
    const { ensurePushRegistered } = await loadPush();

    await expect(ensurePushRegistered()).resolves.toBe(false);
  });
});
