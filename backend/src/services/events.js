const { EventEmitter } = require('node:events');

/**
 * 서버 → 클라이언트 단방향 이벤트 버스.
 *
 * 이전에는 푸시 채널이 전혀 없어 모든 것이 폴링이었다:
 * 상태 3초, 보호자 메시지 2.5초. 원격 조종에는 이 지연이 그대로 체감되고,
 * 응급 알림이 보호자 화면에 뜨기까지 최대 3초가 밀렸다.
 */
const bus = new EventEmitter();
bus.setMaxListeners(50);

const EVENTS = {
  ALERT_CREATED: 'alert.created',
  ALERT_RESOLVED: 'alert.resolved',
  STATUS_CHANGED: 'status.changed',
  COMMAND_ISSUED: 'command.issued',
  MESSAGE_ADDED: 'message.added',
};

/** 어느 역할(로봇/보호자)이 어떤 이벤트를 받을지. 로봇에 보호자용 소음을 보내지 않는다. */
const ROLE_EVENTS = {
  robot: [EVENTS.COMMAND_ISSUED, EVENTS.ALERT_CREATED, EVENTS.ALERT_RESOLVED, EVENTS.STATUS_CHANGED],
  guardian: Object.values(EVENTS),
};

function emit(type, payload) {
  bus.emit('event', { type, payload, ts: new Date().toISOString() });
}

function subscribe(role, listener) {
  const allowed = new Set(ROLE_EVENTS[role] || ROLE_EVENTS.guardian);
  const handler = (event) => {
    if (allowed.has(event.type)) listener(event);
  };
  bus.on('event', handler);
  return () => bus.off('event', handler);
}

module.exports = { EVENTS, emit, subscribe };
