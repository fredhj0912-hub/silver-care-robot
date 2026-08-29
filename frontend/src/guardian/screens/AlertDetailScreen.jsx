import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { apiFetch, assetUrl } from '../../lib/api';
import { alertLabel, formatDay, formatTime, relativeTime } from '../format';

/** 알림 상세 — 목록 카드에서 "자세히 보기"로 들어온다 */
function AlertDetailScreen({ onChange }) {
  const { id } = useParams();
  const [alert, setAlert] = useState(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ok' | 'notfound' | 'error'

  const load = () => {
    setStatus('loading');
    apiFetch(`/api/alerts/${id}`)
      .then((res) => {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`unexpected status ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (data) {
          setAlert(data);
          setStatus('ok');
        } else {
          setStatus('notfound');
        }
      })
      .catch(() => setStatus('error'));
  };

  useEffect(load, [id]);

  const resolve = async () => {
    await apiFetch('/api/alerts/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: alert.id, by: 'guardian' }),
    });
    load();
    onChange?.();
  };

  if (status === 'loading') {
    return (
      <main>
        <Link className="g-recent__more" to="/guardian/alerts">← 알림 목록</Link>
        <p className="g-empty">불러오는 중이에요.</p>
      </main>
    );
  }

  if (status === 'notfound') {
    return (
      <main>
        <Link className="g-recent__more" to="/guardian/alerts">← 알림 목록</Link>
        <p className="g-empty">알림을 찾을 수 없어요.</p>
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main>
        <Link className="g-recent__more" to="/guardian/alerts">← 알림 목록</Link>
        <p className="g-empty">
          불러오지 못했어요.<br />
          <button className="g-btn g-btn--resolve" onClick={load}>다시 시도</button>
        </p>
      </main>
    );
  }

  const tone = alert.resolved ? 'is-resolved'
    : alert.severity === 'warning' ? 'is-warning' : 'is-open';

  return (
    <main>
      <Link className="g-recent__more" to="/guardian/alerts">← 알림 목록</Link>
      <div className={`g-alert ${tone}`}>
        <div className="g-alert__head">
          <span className="g-alert__type">{alertLabel(alert.type)}</span>
          <span className="g-alert__time">{formatDay(alert.timestamp)} {formatTime(alert.timestamp)}</span>
        </div>
        <p className="g-alert__desc">{alert.description}</p>
        <p className="g-alert__time">{relativeTime(alert.timestamp)}</p>
        {alert.snapshotUrl && (
          <img className="g-emergency__shot" src={assetUrl(alert.snapshotUrl)} alt="감지 당시 화면" />
        )}
        {alert.resolved ? (
          <span className="g-alert__state">
            확인함 · {formatTime(alert.resolvedAt)}
            {alert.resolvedBy === 'guardian' ? ' (보호자)' : alert.resolvedBy === 'senior' ? ' (어르신)' : ''}
          </span>
        ) : (
          <button className="g-btn g-btn--resolve" onClick={resolve}>확인했어요</button>
        )}
      </div>
    </main>
  );
}

export default AlertDetailScreen;
