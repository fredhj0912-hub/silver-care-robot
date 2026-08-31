const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');

let S3Client = null;
let PutObjectCommand = null;
let GetObjectCommand = null;
let NoSuchKey = null;
try {
  ({ S3Client, PutObjectCommand, GetObjectCommand, NoSuchKey } = require('@aws-sdk/client-s3'));
} catch {
  console.log('@aws-sdk/client-s3 를 불러오지 못했습니다 — SNAPSHOT_STORAGE=s3는 동작하지 않습니다');
}

// 자격증명은 코드에 두지 않고 SDK 기본 체인(EC2 인스턴스 프로필)에 맡긴다.
let s3Client = null;
function getS3Client() {
  if (!S3Client) return null;
  if (!s3Client) s3Client = new S3Client({ region: config.awsRegion });
  return s3Client;
}

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/**
 * 파일명 확장자로 Content-Type을 정한다. 헤더가 없으면 브라우저의 내용 스니핑에
 * 기대게 되는데(<img src>는 봐주지만 fetch/다운로드는 아니다) 그건 운에 맡기는 것이다.
 */
function mimeFromFilename(filename) {
  const ext = path.extname(String(filename || '')).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/** data URI를 파싱한다. 유효하지 않으면 null. */
function parseDataUri(dataUri) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(String(dataUri || ''));
  if (!match) return null;
  return { mime: match[1], base64: match[2] };
}

/** 경로 조작(../)을 막는다. 파일명이 안전하지 않으면 null. */
function safeFilename(filename) {
  const safe = path.basename(String(filename || ''));
  return (!safe || safe.startsWith('.')) ? null : safe;
}

async function saveLocal(name, buffer) {
  fs.mkdirSync(config.snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(config.snapshotDir, name), buffer);
}

async function saveS3(name, buffer, mime) {
  const client = getS3Client();
  if (!client) throw new Error('S3 클라이언트를 사용할 수 없습니다 (@aws-sdk/client-s3 로드 실패)');
  await client.send(new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: name,
    Body: buffer,
    ContentType: mime,
  }));
}

const SAVE_PROVIDERS = { local: saveLocal, s3: saveS3 };
const SERVE_PROVIDERS = { local: serveLocal, s3: serveS3 };

/**
 * 파일명 접두어로 저장 당시의 provider를 알아낸다. `SNAPSHOT_STORAGE`를 바꿔도 이미
 * 저장된 파일은 저장될 때의 provider로 계속 조회돼야 하므로, 조회 시점의 전역 config가
 * 아니라 파일명 자체를 진실의 원천으로 쓴다. 접두어가 없는 레거시 파일명(이 변경 이전에
 * 저장된 것들)은 local로 간주한다.
 */
function providerFromFilename(filename) {
  const prefix = String(filename || '').split('-')[0];
  return SERVE_PROVIDERS[prefix] ? prefix : 'local';
}

/**
 * 스냅샷을 저장하고 파일명을 반환한다. tts.js의 PROVIDERS 룩업 패턴을 따른다 —
 * 호출부(routes/vision.js, routes/alerts.js)는 저장 방식(로컬 파일/S3)을 몰라도 된다.
 *
 * 이전에는 alert.snapshotUrl 에 base64를 **앞 100자만 잘라** 넣었다(server.js:437).
 * 열 수 없는 이미지 조각이 DB에 쌓였고, 보호자가 낙상 순간을 확인할 방법이 없었다.
 *
 * @returns {Promise<string|null>} 저장된 파일명 (DB에는 이 값만 넣는다)
 */
async function save(dataUri) {
  const parsed = parseDataUri(dataUri);
  if (!parsed) return null;

  const ext = EXT_BY_MIME[parsed.mime] || 'jpg';
  const buffer = Buffer.from(parsed.base64, 'base64');
  if (!buffer.length || buffer.length > config.maxImageBytes) return null;

  // 파일명에 provider를 새겨 둔다 — SNAPSHOT_STORAGE를 나중에 바꿔도 이 파일은
  // 저장 당시의 provider로 계속 조회된다 (providerFromFilename 참고).
  const providerKey = SAVE_PROVIDERS[config.snapshotStorage] ? config.snapshotStorage : 'local';
  const name = `${providerKey}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  try {
    await SAVE_PROVIDERS[providerKey](name, buffer, parsed.mime);
  } catch (err) {
    // 저장 실패(네트워크/S3 장애 등)로 emergency.raise()까지 함께 죽으면 안 된다 —
    // 호출부(routes/vision.js, routes/alerts.js)는 이미 null을 "사진 없이 계속"으로
    // 처리하고 있으므로 그 계약을 그대로 지킨다.
    console.error('[SNAPSHOT] 저장 실패, 사진 없이 진행:', err.message);
    return null;
  }
  return name;
}

/** 로컬 파일을 res로 스트리밍한다. 없으면 404. */
function serveLocal(filename, res) {
  const safe = safeFilename(filename);
  const full = safe ? path.join(config.snapshotDir, safe) : null;
  if (!full || !fs.existsSync(full)) {
    res.status(404).json({ error: '스냅샷을 찾을 수 없습니다' });
    return;
  }
  res.setHeader('Content-Type', mimeFromFilename(safe));
  res.setHeader('Cache-Control', 'private, max-age=86400');
  const stream = fs.createReadStream(full);
  // 스트림 도중 에러(예: 두 체크 사이 파일 삭제)가 나면 unhandled 'error'로
  // 프로세스 전체가 죽는다 — 요청 하나만 500으로 끝나야 한다.
  stream.on('error', (err) => {
    console.error('[SNAPSHOT] 로컬 스트리밍 실패:', err.message);
    if (!res.headersSent) res.status(500).json({ error: '스냅샷을 읽을 수 없습니다' });
    else res.destroy();
  });
  stream.pipe(res);
}

/** S3 객체를 res로 스트리밍한다. 없으면 404. */
async function serveS3(filename, res) {
  const safe = safeFilename(filename);
  if (!safe) {
    res.status(404).json({ error: '스냅샷을 찾을 수 없습니다' });
    return;
  }
  const client = getS3Client();
  if (!client) throw new Error('S3 클라이언트를 사용할 수 없습니다 (@aws-sdk/client-s3 로드 실패)');
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: safe }));
    // 업로드 때 PutObjectCommand에 ContentType을 저장하므로 보통 그대로 쓸 수 있다.
    res.setHeader('Content-Type', object.ContentType || mimeFromFilename(safe));
    res.setHeader('Cache-Control', 'private, max-age=86400');
    object.Body.on('error', (err) => {
      console.error('[SNAPSHOT] S3 스트리밍 실패:', err.message);
      if (!res.headersSent) res.status(500).json({ error: '스냅샷을 읽을 수 없습니다' });
      else res.destroy();
    });
    object.Body.pipe(res);
  } catch (err) {
    if (NoSuchKey && err instanceof NoSuchKey) {
      res.status(404).json({ error: '스냅샷을 찾을 수 없습니다' });
      return;
    }
    throw err;
  }
}

/**
 * 스냅샷을 res에 직접 스트리밍한다(응답까지 이 함수가 책임진다) —
 * 라우트가 저장 방식(로컬 파일 vs S3 객체)을 몰라도 되게 하기 위함.
 */
async function serve(filename, res) {
  const provider = SERVE_PROVIDERS[providerFromFilename(filename)];
  await provider(filename, res);
}

module.exports = { save, serve, parseDataUri };
