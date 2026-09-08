/**
 * Float32 PCM → WAV(16bit LE) 인코더.
 *
 * 왜 MediaRecorder를 안 쓰는가: Chromium의 MediaRecorder가 내놓는 것은
 * `audio/webm;codecs=opus`인데 **Gemini의 지원 오디오 목록에 webm이 없다**
 * (wav/mp3/aiff/aac/ogg/flac). 파이의 Chromium이 ogg 컨테이너를 지원하는지도
 * 확실치 않고, 서버에서 ffmpeg로 변환하면 EC2에 의존성이 하나 늘면서
 * **파이 앞에서만 드러나는 종류의 실패**가 생긴다.
 *
 * raw PCM을 받아 직접 WAV로 감싸면 컨테이너 협상 자체가 사라진다.
 * 16kHz 모노 16bit면 10초 발화가 320KB — base64로 감싸도 백엔드 한계에 한참 못 미친다.
 *
 * 헤더 규격은 backend/src/services/tts.js 의 pcmToWav 와 같은 44바이트 RIFF다
 * (그쪽은 Gemini TTS의 PCM 출력을 감싸는 반대 방향이다).
 */

const HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;

/**
 * @param {Float32Array} samples  -1.0 ~ 1.0 범위의 모노 샘플
 * @param {number} sampleRate
 * @returns {ArrayBuffer}  재생 가능한 WAV 한 덩어리
 */
export function encodeWav(samples, sampleRate) {
  const channels = 1;
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);                                    // fmt 청크 길이
  view.setUint16(20, 1, true);                                     // 1 = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // byteRate
  view.setUint16(32, channels * bytesPerSample, true);              // blockAlign
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    // 클리핑을 먼저 한다. 범위를 넘은 값이 그대로 곱해지면 정수가 겹쳐서
    // 큰 소리가 잡음으로 뭉개진다.
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(HEADER_BYTES + i * bytesPerSample, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return buffer;
}

/** ArrayBuffer → `data:audio/wav;base64,...` (백엔드 POST /api/stt 가 받는 형식) */
export function wavToDataUri(buffer) {
  const bytes = new Uint8Array(buffer);
  // btoa는 문자열을 받는다. 통째로 String.fromCharCode(...bytes)를 하면 인자 수가
  // 스택 한계를 넘어 터진다(10초 발화면 32만 개다) — 조각내서 이어 붙인다.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/** 프레임의 RMS(제곱평균제곱근) 에너지. VAD가 발화 여부를 가르는 유일한 신호다. */
export function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
