/**
 * 웨이크워드 관측 스위치 (?wake=…) — 온디바이스 판정이 쓸 만한지 **공짜로** 재는 도구.
 *
 * lib/vad-debug.js와 같은 이유로 존재한다: "조정해야 하는 값에는 공짜로 관측하는 수단이
 * 같이 있어야 한다"(2026-09-02 교훈). 웨이크워드는 그중에서도 실물 마이크·실물 방에서만
 * 숫자가 나오는데, 발화 한 번이 받아쓰기 1건 + 대화 1건이라 재는 것 자체가 하루치를 태운다.
 *
 *   ?wake=1      문법 제한 Vosk 로 관측 (권장)
 *   ?wake=free   자유 발화 Vosk — 문법 제한이 실제로 도움이 되는지 비교하려고 둔다
 *   ?wake=model=<url>  … 은 없다. 모델 주소는 VITE_WAKE_MODEL_URL 로만 바꾼다
 *
 * ⚠️ **이 스위치가 켜지면 dryRun이 강제된다.** 마이크는 상시로 열리지만(TV 10분 오인식률을
 * 재려면 필수) /api/stt 로 나가는 길이 막힌다 — 측정이 예산을 쓸 수 있는 경로가 아예 없다.
 *
 * 여기서 나온 숫자는 docs/plan-wake-word.md 의 관문 ② 표에 적는다.
 */

/** 기본값은 로컬 파일. 채택되면 S3 고정 주소를 넣는다 — 터널 주소가 바뀌어도 캐시가 산다. */
const DEFAULT_MODEL_URL = '/models/vosk-model-small-ko-0.22.tar.gz';

/**
 * @param {string} [search]  location.search
 * @returns {{enabled: boolean, mode: 'grammar'|'free', modelUrl: string}}
 */
export function readWakeDebug(search = '') {
  const q = new URLSearchParams(search).get('wake');
  const enabled = q === '1' || q === 'free' || q === 'grammar';
  return {
    enabled,
    mode: q === 'free' ? 'free' : 'grammar',
    modelUrl: import.meta.env.VITE_WAKE_MODEL_URL || DEFAULT_MODEL_URL,
  };
}
