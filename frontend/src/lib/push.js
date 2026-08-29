// Web Push 구독 헬퍼. 보호자 브라우저를 backend/src/services/notify.js의 발송 대상으로 등록한다.
import { apiFetch } from './api';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || '';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function pushSupported() {
  return Boolean(VAPID_PUBLIC_KEY) && 'serviceWorker' in navigator && 'PushManager' in window;
}

/** 구독을 확보해 백엔드에 등록한다. 권한이 이미 granted 인 상태를 전제로 한다. */
async function registerSubscription() {
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const { endpoint, keys } = subscription.toJSON();
  await apiFetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, keys }),
  });
}

/** 알림 권한을 요청하고 구독을 백엔드에 등록한다. */
export async function subscribeToPush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { granted: false };

  await registerSubscription();
  return { granted: true };
}

/**
 * 권한이 이미 허용된 기기의 구독을 백엔드에 다시 등록한다.
 *
 * 권한 요청 배너는 permission === 'default' 일 때만 뜨므로, 한 번 허용한 뒤 서버가
 * 구독을 잃어버리면(백엔드 재배포로 DB가 새로 시작, 기기 초기화 등) 보호자에게는
 * 아무 배너도 보이지 않는데 응급 푸시는 조용히 안 가는 상태가 된다 — 이 시스템에서
 * 가장 위험한 실패 모드다. 그래서 보호자 홈이 뜰 때마다 재등록을 시도한다.
 * 백엔드의 저장은 endpoint 기준 upsert라 몇 번을 불러도 안전하다.
 */
export async function ensurePushRegistered() {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  try {
    await registerSubscription();
    return true;
  } catch {
    // 재등록 실패가 화면을 막아서는 안 된다. 다음 방문에 다시 시도한다.
    return false;
  }
}
