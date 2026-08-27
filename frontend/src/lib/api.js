// 백엔드 API 호출 공용 헬퍼.
// 모든 /api/* 요청에 공유 비밀키(x-api-key)를 자동으로 실어 보내
// backend/server.js의 인증 미들웨어를 통과하도록 한다.

export const API_BASE = import.meta.env.VITE_API_URL || '';

const ROBOT_API_KEY = import.meta.env.VITE_ROBOT_API_KEY || '';

export function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (ROBOT_API_KEY) {
    headers['x-api-key'] = ROBOT_API_KEY;
  }
  return fetch(`${API_BASE}${path}`, { ...options, headers });
}

/**
 * <img src> 처럼 커스텀 헤더를 못 붙이는 곳에서 쓰는 URL 빌더.
 * 백엔드 미들웨어가 x-api-key 대신 ?key= 쿼리도 허용한다.
 */
export function assetUrl(path) {
  if (!path) return path;
  if (!ROBOT_API_KEY) return `${API_BASE}${path}`;
  const sep = path.includes('?') ? '&' : '?';
  return `${API_BASE}${path}${sep}key=${encodeURIComponent(ROBOT_API_KEY)}`;
}
