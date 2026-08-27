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
  await client.send(new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: name,
    Body: buffer,
    ContentType: mime,
  }));
}

const SAVE_PROVIDERS = { local: saveLocal, s3: saveS3 };

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

  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const provider = SAVE_PROVIDERS[config.snapshotStorage] || saveLocal;
  await provider(name, buffer, parsed.mime);
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
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(full).pipe(res);
}

/** S3 객체를 res로 스트리밍한다. 없으면 404. */
async function serveS3(filename, res) {
  const safe = safeFilename(filename);
  if (!safe) {
    res.status(404).json({ error: '스냅샷을 찾을 수 없습니다' });
    return;
  }
  const client = getS3Client();
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: safe }));
    res.setHeader('Cache-Control', 'private, max-age=86400');
    object.Body.pipe(res);
  } catch (err) {
    if (NoSuchKey && err instanceof NoSuchKey) {
      res.status(404).json({ error: '스냅샷을 찾을 수 없습니다' });
      return;
    }
    throw err;
  }
}

const SERVE_PROVIDERS = { local: serveLocal, s3: serveS3 };

/**
 * 스냅샷을 res에 직접 스트리밍한다(응답까지 이 함수가 책임진다) —
 * 라우트가 저장 방식(로컬 파일 vs S3 객체)을 몰라도 되게 하기 위함.
 */
async function serve(filename, res) {
  const provider = SERVE_PROVIDERS[config.snapshotStorage] || serveLocal;
  await provider(filename, res);
}

module.exports = { save, serve, parseDataUri };
