const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');

/**
 * 음성 합성.
 *
 * 실측 지연 (2026-08-26, 38자 한국어 문장):
 *   browser  0ms      브라우저 SpeechSynthesis — 즉시, 무료, 대신 목소리 캐릭터를 고를 수 없다
 *   gemini   ~4900ms  gemini-3.1-flash-tts-preview — 지금 API 키로 바로 됨. 너무 느리다.
 *   cloud    미측정   Cloud TTS Chirp 3 HD — 보통 수백 ms. API 활성화만 하면 같은 키로 됨.
 *
 * 어르신이 말을 걸고 대답까지 7초(대화 1.5초 + TTS 5초)를 기다리면 로봇이 고장난 줄 안다.
 * 그래서 두 가지 완충을 둔다:
 *   1) 디스크 캐시 — 같은 문장은 두 번 다시 합성하지 않는다
 *   2) 자주 쓰는 문구 예열(prewarm) — 인사·알림 해제 등은 첫 사용부터 지연 0
 * 그래도 처음 듣는 문장은 provider 지연을 그대로 받는다. 근본 해결은 cloud 전환이다.
 */

const GEMINI_TTS_SAMPLE_RATE = 24000;

function cacheKey(text, provider, voice) {
  return crypto.createHash('sha1').update(`${provider}|${voice}|${text}`).digest('hex');
}

function cachePath(key, ext) {
  return path.join(config.ttsCacheDir, `${key}.${ext}`);
}

/** Gemini TTS는 헤더 없는 raw PCM(24kHz/16bit/mono)을 준다. 브라우저가 재생하도록 WAV 헤더를 붙인다. */
function pcmToWav(pcm, sampleRate = GEMINI_TTS_SAMPLE_RATE, channels = 1, bits = 16) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bits) / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function synthWithGemini(text, voice) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.ttsGeminiModel}:generateContent?key=${config.geminiApiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
  });

  const json = await res.json();
  if (json.error) throw new Error(`Gemini TTS ${json.error.code}: ${json.error.message}`);

  const b64 = json.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) throw new Error('Gemini TTS 응답에 오디오가 없습니다');

  return { buffer: pcmToWav(Buffer.from(b64, 'base64')), ext: 'wav', mime: 'audio/wav' };
}

async function synthWithCloud(text, voice) {
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${config.geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: 'ko-KR', name: voice },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: config.ttsSpeakingRate,
          pitch: config.ttsPitch,
        },
      }),
    }
  );

  const json = await res.json();
  if (json.error) {
    // 가장 흔한 실패: API 미활성화. 무엇을 해야 하는지 알려준다.
    if (json.error.status === 'PERMISSION_DENIED') {
      throw new Error(
        'Cloud TTS API가 활성화되지 않았습니다. ' +
        'https://console.cloud.google.com/apis/library/texttospeech.googleapis.com 에서 활성화하세요.'
      );
    }
    throw new Error(`Cloud TTS ${json.error.code}: ${json.error.message}`);
  }
  if (!json.audioContent) throw new Error('Cloud TTS 응답에 오디오가 없습니다');

  return { buffer: Buffer.from(json.audioContent, 'base64'), ext: 'mp3', mime: 'audio/mpeg' };
}

const PROVIDERS = { gemini: synthWithGemini, cloud: synthWithCloud };

const isEnabled = () =>
  config.ttsProvider !== 'browser' && Boolean(config.geminiApiKey) && Boolean(PROVIDERS[config.ttsProvider]);

/**
 * 문장을 음성으로 합성한다. 캐시에 있으면 즉시 반환한다.
 * @returns {Promise<{buffer: Buffer, mime: string, cached: boolean, ms: number}|null>}
 *          provider가 browser면 null (프론트가 자체 TTS로 처리)
 */
async function synthesize(text, { voice = config.ttsVoice } = {}) {
  if (!isEnabled()) return null;

  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  const key = cacheKey(trimmed, config.ttsProvider, voice);
  const ext = config.ttsProvider === 'cloud' ? 'mp3' : 'wav';
  const mime = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav';
  const file = cachePath(key, ext);

  if (fs.existsSync(file)) {
    return { buffer: fs.readFileSync(file), mime, cached: true, ms: 0 };
  }

  const started = Date.now();
  const result = await PROVIDERS[config.ttsProvider](trimmed, voice);
  const ms = Date.now() - started;

  fs.mkdirSync(config.ttsCacheDir, { recursive: true });
  fs.writeFileSync(cachePath(key, result.ext), result.buffer);

  return { buffer: result.buffer, mime: result.mime, cached: false, ms };
}

/**
 * 자주 쓰는 문구를 미리 합성해 캐시에 넣는다.
 * 이 문구들은 첫 사용부터 지연 0이 된다.
 */
const COMMON_PHRASES = [
  '네 어르신, 듣고 있어요.',
  '네, 무슨 일이세요?',
  '네! 말씀하세요.',
  '경보를 해제했습니다. 이제 안심하셔도 돼요!',
  '잘 못 들었어요. 다시 한 번 말씀해 주시겠어요?',
  '네 어르신, 효돌이가 늘 곁에서 말씀 잘 듣고 있어요. 오늘 하루는 어떻게 보내고 계신가요?',
  '제가 곁에 늘 있으니 외로워하지 마세요! 언제든 말을 걸어주세요.',
  '어르신, 식사는 제때 꼭 챙겨 드셔야 해요. 물도 한 잔 잊지 마세요!',
  '헤헤, 저도 어르신이 제일 좋아요! 오늘도 저랑 즐겁게 지내요.',
];

async function prewarm() {
  if (!isEnabled()) return { skipped: true, reason: `provider=${config.ttsProvider}` };

  let generated = 0;
  let cached = 0;
  const failures = [];

  for (const phrase of COMMON_PHRASES) {
    try {
      const r = await synthesize(phrase);
      if (r?.cached) cached++;
      else generated++;
    } catch (err) {
      failures.push(err.message);
    }
  }

  return { skipped: false, generated, cached, failures };
}

module.exports = { synthesize, prewarm, isEnabled, COMMON_PHRASES, pcmToWav };
