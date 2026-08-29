import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, API_BASE } from './api';

const ROBOT_API_KEY = import.meta.env.VITE_ROBOT_API_KEY || '';

/**
 * 보호자 앱의 공용 상태 — 로봇 상태, 미해결 알림, 오늘 요약.
 *
 * SSE(`GET /api/events?role=guardian`)로 서버가 밀어주는 이벤트를 받고,
 * 연결이 끊기면 폴링으로 떨어진다. 응급 알림이 보호자 화면에 뜨기까지
 * 폴링 간격만큼 밀리면 안 되므로 SSE가 기본 경로다.
 */
export function useGuardianData() {
  const [status, setStatus] = useState(null);
  const [openAlerts, setOpenAlerts] = useState([]);
  const [summary, setSummary] = useState(null);
  const [connected, setConnected] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, a, d] = await Promise.all([
        apiFetch('/api/status').then((r) => (r.ok ? r.json() : null)),
        apiFetch('/api/alerts?resolved=false&limit=50').then((r) => (r.ok ? r.json() : null)),
        apiFetch('/api/summary/daily').then((r) => (r.ok ? r.json() : null)),
      ]);
      if (s) setStatus(s);
      if (a) setOpenAlerts(a.alerts);
      if (d) setSummary(d);
    } catch {
      // 네트워크가 끊긴 상태 — connected 플래그가 화면에 이미 반영된다
    }
  }, []);

  // SSE 연결. EventSource는 커스텀 헤더를 붙일 수 없어 키를 쿼리로 넘긴다
  // (백엔드 apiKeyAuth가 req.query.key 도 받아준다).
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  const connectedRef = useRef(connected);
  useEffect(() => { connectedRef.current = connected; }, [connected]);

  // 서버 하트비트(25초 간격) 포함, 어떤 이벤트든 받을 때마다 갱신된다. onerror 없이
  // 소켓만 조용히 죽는 경우(모바일 PWA 백그라운드 전환 등) 이 값이 오래된 채로 남아
  // "정체"를 감지하는 유일한 신호가 된다.
  const lastEventAtRef = useRef(Date.now());
  const sourceRef = useRef(null);

  useEffect(() => {
    refreshRef.current();

    const url = `${API_BASE}/api/events?role=guardian${ROBOT_API_KEY ? `&key=${encodeURIComponent(ROBOT_API_KEY)}` : ''}`;

    let source;
    const connect = () => {
      source = new EventSource(url);
      sourceRef.current = source;

      const touch = () => { lastEventAtRef.current = Date.now(); };

      const onHello = (e) => {
        touch();
        const data = JSON.parse(e.data);
        setStatus(data.status);
        setOpenAlerts(data.unresolvedAlerts);
        setConnected(true);
      };

      // 어떤 이벤트가 오든 서버가 진실의 원천이므로 전체를 다시 읽는다.
      // 화면 수가 적고 응답이 가벼워서, 이벤트별 부분 갱신보다 이 편이 틀릴 여지가 적다.
      const onChange = () => { touch(); refreshRef.current(); };

      source.addEventListener('hello', onHello);
      source.addEventListener('alert.created', onChange);
      source.addEventListener('alert.resolved', onChange);
      source.addEventListener('status.changed', onChange);
      source.addEventListener('message.added', onChange);
      source.addEventListener('heartbeat', touch);
      source.onerror = () => setConnected(false);
      source.onopen = () => { touch(); setConnected(true); };
    };
    connect();

    // SSE가 죽어 있어도 화면이 완전히 멈추지 않도록 느린 폴링을 함께 둔다.
    // 25초 하트비트의 ~2.4배(60초) 이상 아무 이벤트도 못 받았으면 onerror가 안 떴어도
    // 정체로 간주해 연결을 새로 연다 — 단순 폴링만으로는 SSE가 다시 살아나지 않는다.
    const fallback = setInterval(() => {
      const stale = Date.now() - lastEventAtRef.current > 60000;
      if (!connectedRef.current || stale) {
        refreshRef.current();
        if (stale) {
          setConnected(false);
          sourceRef.current?.close();
          connect();
        }
      }
    }, 30000);

    return () => {
      clearInterval(fallback);
      sourceRef.current?.close();
    };
  }, []);

  return { status, openAlerts, summary, connected, refresh };
}

/** 커서 페이지네이션 목록 (대화 로그 / 알림 이력 공용) */
export function usePagedList(path, key) {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);

  const load = useCallback(async (before = null) => {
    setLoading(true);
    try {
      const sep = path.includes('?') ? '&' : '?';
      const res = await apiFetch(`${path}${before ? `${sep}before=${before}` : ''}`);
      if (res.ok) {
        const data = await res.json();
        setItems((prev) => (before ? [...prev, ...data[key]] : data[key]));
        setCursor(data.nextCursor);
        setDone(!data.nextCursor);
      }
    } finally {
      setLoading(false);
    }
  }, [path, key]);

  useEffect(() => { load(); }, [load]);

  return { items, loading, done, loadMore: () => cursor && load(cursor), reload: () => load() };
}
