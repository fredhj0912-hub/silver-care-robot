-- 효돌이 로컬 데이터베이스 (node:sqlite / Node 24 내장)
-- 모든 시각은 ISO8601 UTC(끝에 Z)로 통일한다.
-- 이전 database.json은 +09:00 오프셋과 Z가 섞여 있어 정렬이 어긋났다.

PRAGMA journal_mode = WAL;   -- 읽기(보호자 앱 폴링)와 쓰기(로봇)가 서로를 막지 않게
PRAGMA foreign_keys = ON;

-- 어르신 ↔ 로봇 ↔ 보호자 대화 로그
CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT    NOT NULL,
  sender    TEXT    NOT NULL CHECK (sender IN ('senior', 'robot', 'guardian')),
  text      TEXT    NOT NULL,
  emotion   TEXT,
  -- 이 응답이 실제 Gemini에서 왔는지 mock 폴백인지. 예전엔 구분이 불가능해
  -- 실API 실패를 아무도 눈치채지 못했다.
  source    TEXT    CHECK (source IS NULL OR source IN ('gemini', 'mock', 'remote', 'legacy'))
);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender, id DESC);

-- 응급 알림
CREATE TABLE IF NOT EXISTS alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT    NOT NULL,
  type         TEXT    NOT NULL,   -- fall_detected | voice_trigger | manual_panic_button | vision_anomaly | no_motion | medication_missed
  severity     TEXT    NOT NULL DEFAULT 'critical' CHECK (severity IN ('critical', 'warning', 'info')),
  description  TEXT,
  confidence   REAL,               -- 감지기 신뢰도 0~1 (수동 버튼은 NULL)
  -- 스냅샷은 파일로 저장하고 경로만 담는다.
  -- 이전에는 base64를 100자로 잘라 저장해 열 수 없는 이미지가 들어갔다.
  snapshot_path TEXT,
  resolved     INTEGER NOT NULL DEFAULT 0,
  resolved_at  TEXT,
  resolved_by  TEXT CHECK (resolved_by IS NULL OR resolved_by IN ('senior', 'guardian', 'auto'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_unresolved ON alerts (resolved, ts DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_type_ts ON alerts (type, ts DESC);

-- 보호자/시스템 → 로봇 명령 큐 (기존 remoteMessages + 이동 명령 통합)
CREATE TABLE IF NOT EXISTS outbound_commands (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('speak', 'move', 'ping')),
  payload      TEXT    NOT NULL,   -- JSON 문자열
  -- 예전 GET /api/remote-message/poll 은 조회하는 순간 큐에서 제거해서(shift)
  -- 네트워크 재시도 한 번에 보호자 메시지가 사라졌다. 이제 로봇이 명시적으로 ack 한다.
  delivered    INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_commands_pending ON outbound_commands (delivered, id);

-- 로봇 상태 (단일 행)
CREATE TABLE IF NOT EXISTS robot_status (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  status            TEXT    NOT NULL DEFAULT 'online',
  battery           INTEGER NOT NULL DEFAULT 100,
  last_active       TEXT    NOT NULL,
  senior_expression TEXT    NOT NULL DEFAULT 'neutral',
  is_emergency      INTEGER NOT NULL DEFAULT 0
);

-- 보호자 기기 Web Push 구독 (Phase 5)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint   TEXT NOT NULL UNIQUE,
  keys_json  TEXT NOT NULL,
  label      TEXT,
  -- 구독을 만든 브라우저 주소. 터널 주소가 바뀌면 옛 origin의 구독이 남는데
  -- FCM은 그것을 404/410으로 거부하지 않고 성공으로 응답하므로, origin 없이는
  -- 죽은 구독과 살아 있는 구독을 구분할 방법이 없다. (레거시 행은 NULL)
  origin     TEXT,
  created_at TEXT NOT NULL
);

-- 감지기 원본 이벤트 (임계값 미만이라 알림이 되지 않은 것도 남긴다 — 임계값 튜닝 근거)
CREATE TABLE IF NOT EXISTS detections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  source      TEXT NOT NULL,   -- fall_yolov8 | vision_gemini | mock
  type        TEXT NOT NULL,   -- fall | no_motion | abnormal_posture
  confidence  REAL NOT NULL,
  meta_json   TEXT,
  alert_id    INTEGER REFERENCES alerts (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_detections_ts ON detections (ts DESC);

-- 복약 일정. 한 행 = 한 번의 복용.
-- 반복(매일 먹는 약)은 반복 규칙 테이블이나 RRULE 대신 등록 시점에 하루 간격 행을
-- 그만큼 만들어 둔다 — 스키마를 단순하게 두고 반복 로직을 한 곳(routes)에만 둔다.
CREATE TABLE IF NOT EXISTS medications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  medicine_name TEXT    NOT NULL,
  scheduled_at  TEXT    NOT NULL,   -- ISO8601 UTC
  status        TEXT    NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled', 'taken', 'missed')),
  taken_at      TEXT,
  taken_by      TEXT CHECK (taken_by IS NULL OR taken_by IN ('senior', 'guardian')),
  -- 로봇이 실제로 소리 내어 알린 시각. 스케줄러가 같은 약을 반복해서 말하지 않게 하는 가드다.
  reminded_at   TEXT,
  notes         TEXT,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_medications_due ON medications (status, scheduled_at);
