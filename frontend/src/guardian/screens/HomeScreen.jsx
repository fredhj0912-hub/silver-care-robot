import React, { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { apiFetch, assetUrl } from '../../lib/api';
import { pushSupported, subscribeToPush } from '../../lib/push';
import { buildDailyNote, stateLabel, formatTime, formatWhen, relativeTime, alertLabel } from '../format';

const SENDER_NAME = { senior: '어르신', robot: '효돌이', guardian: '나' };

/**
 * 홈 — "엄마 괜찮으신가?"에 한 화면으로 답한다.
 *
 * 평상시엔 효돌이가 남긴 안부 쪽지를 보여주고,
 * 미해결 알림이 있으면 화면 전체가 응급 상태로 바뀌며 쪽지 자리에 알림이 들어온다.
 */
function HomeScreen({ status, openAlerts, summary, connected, refresh }) {
  const state = stateLabel({ status, openAlerts, connected });
  const note = buildDailyNote(summary, status);
  const active = openAlerts[0];

  // 응급 알림을 앱을 열어두지 않아도 받으려면 브라우저 푸시 구독이 필요하다.
  // iOS는 홈 화면에 설치된 PWA에서만 이 권한 요청이 동작한다.
  const [notifStatus, setNotifStatus] = useState(() =>
    pushSupported() ? Notification.permission : 'unsupported'
  );
  const enableNotifications = async () => {
    const { granted } = await subscribeToPush();
    setNotifStatus(granted ? 'granted' : Notification.permission);
  };

  // 최근 대화 몇 마디. 이 앱에서 유일하게 '확인'이 아니라 '연결'을 위한 부분이라,
  // 홈에 두어 보호자가 매번 대화 탭까지 가지 않아도 읽을 수 있게 한다.
  const [recent, setRecent] = useState([]);
  useEffect(() => {
    let alive = true;
    apiFetch('/api/messages?limit=4')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setRecent([...d.messages].reverse()); })
      .catch(() => {});
    return () => { alive = false; };
  }, [summary]);

  const resolve = async (id) => {
    await apiFetch('/api/alerts/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, by: 'guardian' }),
    });
    refresh();
  };

  return (
    <main>
      <div className="g-state">
        <span className={`g-state__dot is-${state.tone}`} />
        <span className="g-state__label">{state.text}</span>
      </div>

      {active ? (
        <section className="g-emergency">
          <span className="g-emergency__type">{alertLabel(active.type)}</span>
          <p className="g-emergency__desc">{active.description}</p>
          <p className="g-emergency__time">{formatTime(active.timestamp)} · {relativeTime(active.timestamp)}</p>
          {active.snapshotUrl && (
            <img className="g-emergency__shot" src={assetUrl(active.snapshotUrl)} alt="감지 당시 화면" />
          )}
          <button className="g-btn g-btn--resolve" onClick={() => resolve(active.id)}>
            확인했어요
          </button>
          {openAlerts.length > 1 && (
            <p className="g-note-inline" style={{ margin: '14px 0 0' }}>
              확인하지 않은 알림이 {openAlerts.length - 1}건 더 있어요.
            </p>
          )}
        </section>
      ) : (
        <section className="g-note">
          <p className="g-note__body">
            {note
              ? note.map((seg, i) => (seg.em ? <em key={i}>{seg.t}</em> : <span key={i}>{seg.t}</span>))
              : '오늘 기록을 불러오는 중이에요.'}
          </p>
          <div className="g-note__foot">
            <span>마지막 대화 {status?.lastActive ? formatTime(status.lastActive) : '—'}</span>
            <span>배터리 {status?.battery ?? '—'}%</span>
          </div>
        </section>
      )}

      <div className="g-tiles">
        <Link className="g-tile" to="/guardian/live">
          <span className="g-tile__label">방 안 모습</span>
          <span className="g-tile__value">지금 보기</span>
        </Link>
        <Link className="g-tile" to="/guardian/alerts">
          <span className="g-tile__label">확인 안 한 알림</span>
          <span className={`g-tile__value${openAlerts.length ? ' is-alarm' : ''}`}>
            {openAlerts.length}건
          </span>
        </Link>
      </div>

      {recent.length > 0 && (
        <section className="g-recent">
          <div className="g-recent__head">
            <h2 className="g-recent__title">최근 나눈 이야기</h2>
            <Link className="g-recent__more" to="/guardian/log">모두 보기</Link>
          </div>
          {recent.map((msg) => (
            <div key={msg.id} className={`g-msg g-msg--${msg.sender}`}>
              <div>
                <div className="g-msg__bubble">{msg.text}</div>
                <div className="g-msg__meta">
                  {SENDER_NAME[msg.sender] || msg.sender} · {formatWhen(msg.timestamp)}
                </div>
              </div>
            </div>
          ))}
        </section>
      )}

      {!connected && (
        <p className="g-note-inline">
          로봇과 실시간 연결이 끊겼어요. 화면은 30초마다 새로 불러옵니다.
        </p>
      )}

      {notifStatus === 'default' && (
        <section style={{ margin: '20px 16px 0' }}>
          <button className="g-btn g-btn--quiet" onClick={enableNotifications}>
            응급 알림 받기
          </button>
          <p className="g-note-inline" style={{ margin: '8px 4px 0' }}>
            앱을 열어두지 않아도 응급 상황을 바로 알 수 있어요.
            아이폰은 먼저 홈 화면에 추가해야 알림을 받을 수 있어요.
          </p>
        </section>
      )}
      {notifStatus === 'denied' && (
        <p className="g-note-inline">
          알림이 꺼져 있어요. 브라우저 설정에서 알림 권한을 허용하면 응급 상황을 바로 알 수 있어요.
        </p>
      )}
    </main>
  );
}

export default HomeScreen;
