import React from 'react';
import { Link } from 'react-router';
import { apiFetch, assetUrl } from '../../lib/api';
import { usePagedList } from '../../lib/useGuardianData';
import { alertLabel, formatTime, formatDay, dayKey } from '../format';

/** 알림 이력 — 언제, 무슨 일이, 처리됐는지 */
function AlertsScreen({ onChange }) {
  const { items, loading, done, loadMore, reload } = usePagedList('/api/alerts?limit=30', 'alerts');

  const resolve = async (id) => {
    await apiFetch('/api/alerts/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, by: 'guardian' }),
    });
    reload();
    onChange?.();
  };

  if (!loading && items.length === 0) {
    return (
      <main>
        <h1 className="g-section-title">알림</h1>
        <p className="g-empty">아직 알림이 없어요.<br />어르신께 별일 없다는 뜻이에요.</p>
      </main>
    );
  }

  let lastDay = null;

  return (
    <main>
      <h1 className="g-section-title">알림</h1>
      <div className="g-list">
        {items.map((alert) => {
          const day = dayKey(alert.timestamp);
          const showDay = day !== lastDay;
          lastDay = day;

          const tone = alert.resolved ? 'is-resolved'
            : alert.severity === 'warning' ? 'is-warning' : 'is-open';

          return (
            <React.Fragment key={alert.id}>
              {showDay && <div className="g-daymark">{formatDay(alert.timestamp)}</div>}
              <div className={`g-alert ${tone}`}>
                <div className="g-alert__head">
                  <span className="g-alert__type">{alertLabel(alert.type)}</span>
                  <span className="g-alert__time">{formatTime(alert.timestamp)}</span>
                </div>
                <p className="g-alert__desc">{alert.description}</p>
                {alert.snapshotUrl && (
                  <img className="g-emergency__shot" src={assetUrl(alert.snapshotUrl)} alt="감지 당시 화면" />
                )}
                <div><Link className="g-recent__more" to={`/guardian/alerts/${alert.id}`}>자세히 보기</Link></div>
                {alert.resolved ? (
                  <span className="g-alert__state">
                    확인함 · {formatTime(alert.resolvedAt)}
                    {alert.resolvedBy === 'guardian' ? ' (보호자)' : alert.resolvedBy === 'senior' ? ' (어르신)' : ''}
                  </span>
                ) : (
                  <button className="g-btn g-btn--resolve" onClick={() => resolve(alert.id)}>
                    확인했어요
                  </button>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {!done && (
        <button className="g-more" onClick={loadMore} disabled={loading}>
          {loading ? '불러오는 중' : '이전 알림 더 보기'}
        </button>
      )}
    </main>
  );
}

export default AlertsScreen;
