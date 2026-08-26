import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { usePagedList } from '../../lib/useGuardianData';
import { formatTime, formatDay, dayKey } from '../format';

const SENDER_NAME = { senior: '어르신', robot: '효돌이', guardian: '나' };

/**
 * 대화 로그 — 감시 기록이 아니라, 오늘 부모님이 무슨 이야기를 하셨는지 읽는 화면.
 * 이 앱에서 유일하게 '확인'이 아니라 '연결'을 위한 화면이다.
 */
function LogScreen() {
  const { items, loading, done, loadMore } = usePagedList('/api/messages?limit=40', 'messages');

  // 채팅 화면은 최신 메시지에서 열려야 한다.
  // 오래된 것이 위에 쌓이는 구조라, 맨 위에서 열면 방금 보낸 메시지가
  // 한참 아래에 있어 "안 보내진 것"처럼 느껴진다.
  const didInitialScroll = useRef(false);
  const restoreFrom = useRef(null);

  useEffect(() => {
    if (didInitialScroll.current || items.length === 0) return;
    didInitialScroll.current = true;
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    });
  }, [items.length]);

  // "이전 대화 더 보기"로 위쪽에 내용이 붙으면 읽던 위치가 밀린다.
  // 늘어난 높이만큼 스크롤을 내려 보던 자리를 유지한다.
  useLayoutEffect(() => {
    if (restoreFrom.current === null) return;
    const grew = document.documentElement.scrollHeight - restoreFrom.current;
    restoreFrom.current = null;
    if (grew > 0) window.scrollBy({ top: grew, behavior: 'instant' });
  }, [items.length]);

  const handleLoadMore = () => {
    restoreFrom.current = document.documentElement.scrollHeight;
    loadMore();
  };

  if (!loading && items.length === 0) {
    return (
      <main>
        <h1 className="g-section-title">대화</h1>
        <p className="g-empty">아직 나눈 대화가 없어요.</p>
      </main>
    );
  }

  // API는 최신순으로 주므로, 읽기 순서(오래된 것부터)로 뒤집는다
  const ordered = [...items].reverse();
  let lastDay = null;

  return (
    <main>
      <h1 className="g-section-title">대화</h1>

      {!done && (
        <button className="g-more" onClick={handleLoadMore} disabled={loading}>
          {loading ? '불러오는 중' : '이전 대화 더 보기'}
        </button>
      )}

      <div className="g-list" style={{ marginTop: 12 }}>
        {ordered.map((msg) => {
          const day = dayKey(msg.timestamp);
          const showDay = day !== lastDay;
          lastDay = day;

          return (
            <React.Fragment key={msg.id}>
              {showDay && <div className="g-daymark">{formatDay(msg.timestamp)}</div>}
              <div className={`g-msg g-msg--${msg.sender}`}>
                <div>
                  <div className="g-msg__bubble">{msg.text}</div>
                  <div className="g-msg__meta">
                    {SENDER_NAME[msg.sender] || msg.sender} · {formatTime(msg.timestamp)}
                  </div>
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </main>
  );
}

export default LogScreen;
