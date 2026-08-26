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
