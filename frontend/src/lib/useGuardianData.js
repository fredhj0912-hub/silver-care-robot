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
  const [sseConnected, setSseConnected] = useState(false);
  // 폴백 폴링이 성공하는 한 화면 데이터는 최신이다. 프록시가 SSE를 버퍼링하는 배포에서는
  // SSE가 영영 조용하므로, "실시간 연결"만 보고 오프라인 안내를 띄우면 멀쩡히 갱신되는
  // 화면 위에 경고만 60초마다 깜빡인다. 보호자가 알아야 할 건 데이터가 최신인지다.
  const [dataFresh, setDataFresh] = useState(true);

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
      setDataFresh(Boolean(s));
    } catch {
      // 서버에 아예 닿지 못한 상태 — 이때만 화면에 연결 끊김을 알린다
      setDataFresh(false);
    }
  }, []);

  // SSE 연결. EventSource는 커스텀 헤더를 붙일 수 없어 키를 쿼리로 넘긴다
  // (백엔드 apiKeyAuth가 req.query.key 도 받아준다).
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  const connectedRef = useRef(sseConnected);
  useEffect(() => { connectedRef.current = sseConnected; }, [sseConnected]);

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
        setSseConnected(true);
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
      source.onerror = () => setSseConnected(false);
      source.onopen = () => { touch(); setSseConnected(true); };
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
          setSseConnected(false);
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

  // 화면이 쓰는 `connected`는 "SSE가 살아 있나"가 아니라 "화면이 최신인가"다.
  return { status, openAlerts, summary, connected: sseConnected || dataFresh, refresh };
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
