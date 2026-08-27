#!/usr/bin/env node
/**
 * PWA 아이콘(PNG) 생성.
 *
 *   node scripts/make-icons.js
 *
 * 이미지 라이브러리를 의존성으로 추가하지 않으려고 PNG를 직접 인코딩한다.
 * 아이콘은 효돌이 얼굴을 단순화한 것 — 키오스크 화면의 로봇 얼굴과 같은
 * 인디고 배경에 흰 눈 두 개와 미소. 홈 화면에서 작게 보여도 알아볼 수 있다.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INDIGO = [0x5c, 0x64, 0xec];
const WHITE = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, pixelAt) {
  // 각 스캔라인 앞에 필터 바이트(0 = None)를 붙인다
  const raw = Buffer.alloc(size * (1 + size * 3));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelAt(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 효돌이 얼굴. maskable 아이콘이 잘려도 남도록 중앙 80% 안에만 그린다. */
function facePixel(size) {
  const eyeR = size * 0.072;
  const eyeY = size * 0.43;
  const eyeLX = size * 0.37;
  const eyeRX = size * 0.63;

  // 미소: 중심에서 일정 거리에 있는 아래쪽 호
  const mouthCX = size * 0.5;
  const mouthCY = size * 0.34;
  const mouthR = size * 0.24;
  const mouthT = size * 0.033;

  return (x, y) => {
    const dL = Math.hypot(x - eyeLX, y - eyeY);
    const dR = Math.hypot(x - eyeRX, y - eyeY);
    if (dL <= eyeR || dR <= eyeR) return WHITE;

    const dM = Math.hypot(x - mouthCX, y - mouthCY);
    if (y > size * 0.55 && Math.abs(dM - mouthR) <= mouthT) return WHITE;

    return INDIGO;
  };
}

const outDir = path.join(__dirname, '..', 'public');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, encodePNG(size, facePixel(size)));
  console.log(`${path.relative(process.cwd(), file)} (${size}×${size})`);
}
