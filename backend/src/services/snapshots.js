const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** data URI를 파싱한다. 유효하지 않으면 null. */
function parseDataUri(dataUri) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(String(dataUri || ''));
  if (!match) return null;
  return { mime: match[1], base64: match[2] };
}

/**
 * 스냅샷을 디스크에 저장하고 파일명을 반환한다.
 *
 * 이전에는 alert.snapshotUrl 에 base64를 **앞 100자만 잘라** 넣었다(server.js:437).
 * 열 수 없는 이미지 조각이 DB에 쌓였고, 보호자가 낙상 순간을 확인할 방법이 없었다.
 *
 * @returns {string|null} 저장된 파일명 (DB에는 이 값만 넣는다)
 */
function save(dataUri) {
  const parsed = parseDataUri(dataUri);
  if (!parsed) return null;

  const ext = EXT_BY_MIME[parsed.mime] || 'jpg';
  const buffer = Buffer.from(parsed.base64, 'base64');
  if (!buffer.length || buffer.length > config.maxImageBytes) return null;

  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.mkdirSync(config.snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(config.snapshotDir, name), buffer);
  return name;
}

/** 경로 조작(../)을 막고 실제 파일 경로를 돌려준다. */
function resolvePath(filename) {
  const safe = path.basename(String(filename || ''));
  if (!safe || safe.startsWith('.')) return null;
  const full = path.join(config.snapshotDir, safe);
  return fs.existsSync(full) ? full : null;
}

module.exports = { save, resolvePath, parseDataUri };
