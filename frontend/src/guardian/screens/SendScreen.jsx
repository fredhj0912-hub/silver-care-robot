import React, { useState } from 'react';
import { Link } from 'react-router';
import { apiFetch } from '../../lib/api';

const MAX = 500;

// 보호자가 자주 보낼 법한 말 — 매번 타이핑하지 않아도 되도록
const QUICK = [
  '약 드실 시간이에요',
  '식사 잘 챙겨 드세요',
  '오늘 저녁에 들를게요',
  '물 한 잔 드세요',
  '창문 좀 열어서 환기하세요',
];

/**
 * 메시지 보내기 — 보낸 말은 효돌이가 어르신께 소리 내어 읽어준다.
 * 어르신은 화면을 읽지 않으므로, 소리로 들었을 때 자연스러운 문장이어야 한다.
 */
function SendScreen() {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(null);
  const [error, setError] = useState(null);

  const send = async (e) => {
    e.preventDefault();
    const message = text.trim();
    if (!message || sending) return;

    setSending(true);
    setError(null);
    try {
      const res = await apiFetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'speak', payload: { text: message } }),
      });
      if (res.ok) {
        setSent(message);
        setText('');
      } else {
        const body = await res.json().catch(() => null);
        setError(body?.error || '보내지 못했어요. 잠시 후 다시 시도해 주세요.');
      }
    } catch {
      setError('로봇과 연결되지 않아요. 같은 Wi-Fi에 있는지 확인해 주세요.');
    } finally {
      setSending(false);
    }
  };

  return (
    <main>
      <h1 className="g-section-title">보내기</h1>
      <p className="g-note-inline" style={{ margin: '0 20px 16px' }}>
        보낸 말은 효돌이가 어르신께 소리로 전해드려요.
      </p>

      <div className="g-chips">
        {QUICK.map((q) => (
          <button key={q} type="button" className="g-chip" onClick={() => setText(q)}>
            {q}
          </button>
        ))}
      </div>

      <form onSubmit={send}>
        <div className="g-field">
          <textarea
            className="g-field__input"
            rows={4}
            maxLength={MAX}
            value={text}
            onChange={(e) => { setText(e.target.value); setSent(null); }}
            placeholder="어르신께 전할 말을 적어주세요"
            aria-label="어르신께 전할 말"
          />
          <div className="g-field__count">{text.length} / {MAX}</div>
        </div>

        <div className="g-field" style={{ marginTop: 8 }}>
          <button className="g-btn g-btn--primary" type="submit" disabled={!text.trim() || sending}>
            {sending ? '보내는 중' : '효돌이에게 전하기'}
          </button>
        </div>
      </form>

      {sent && (
        <p className="g-note-inline">
          전했어요 — “{sent}”<br />
          효돌이가 어르신께 읽어드릴 거예요.{' '}
          <Link to="/guardian/log" style={{ color: 'var(--indigo)', fontWeight: 500 }}>
            대화에서 보기
          </Link>
        </p>
      )}
      {error && (
        <p className="g-note-inline" style={{ color: 'var(--alarm)' }}>{error}</p>
      )}
    </main>
  );
}

export default SendScreen;
