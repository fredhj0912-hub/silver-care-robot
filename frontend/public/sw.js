/**
 * 서비스 워커 — PWA 설치와 오프라인 셸.
 *
 * 의도적으로 최소한만 한다:
 *  - 앱 셸(HTML/JS/CSS)만 캐시한다
 *  - /api/* 는 절대 캐시하지 않는다. 어르신 상태와 알림은 오래된 값을 보여주느니
 *    안 보여주는 편이 낫다 — 보호자가 "괜찮음"이라는 캐시된 화면을 믿으면 안 된다.
 */
const CACHE = 'hyodol-shell-v1';
const SHELL = ['/guardian', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API 응답은 캐시하지 않는다 — 오래된 안부는 위험하다
  if (url.pathname.startsWith('/api/')) return;

  // 화면 이동(navigation)은 네트워크 우선, 실패하면 캐시된 셸로 폴백
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/guardian').then((r) => r || caches.match('/')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});

// critical 알림 전용 (backend/src/services/notify.js). warning은 푸시로 오지 않는다.
self.addEventListener('push', (event) => {
  let data = { title: '효돌이 응급 알림', body: '', url: '/guardian/alerts' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // 파싱 실패해도 알림은 뜨게 한다 — 제목만 있는 알림이 아예 없는 것보다 낫다
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/guardian';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => new URL(c.url).pathname === url);
      if (existing) return existing.focus();

      // 앱이 다른 화면에 이미 열려 있으면 새 창을 띄우는 대신 그 창을 이동시킨다.
      // navigate()가 실패해도(엔진 미지원 등) 새 창 폴백으로 이어져야 클릭이 무반응이 안 된다.
      const guardianWindow = clients.find((c) => new URL(c.url).pathname.startsWith('/guardian'));
      if (guardianWindow) {
        return guardianWindow.navigate(url).then((c) => c.focus()).catch(() => self.clients.openWindow(url));
      }

      return self.clients.openWindow(url);
    })
  );
});
