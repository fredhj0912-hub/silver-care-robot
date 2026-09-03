/**
 * VAD 관측 스위치 — URL 쿼리 하나로 켜고 끈다.
 *
 * 왜 있는가: VAD 임계값(vad.js의 startThreshold)은 마이크와 방에 따라 달라지는데,
 * 맞추는 방법이 **실제로 말해 보는 것**뿐이었다. 그런데 발화 한 번이 받아쓰기 1건 +
 * 대화 1건이라 Gemini 무료 등급(모델당 하루 20건)에서는 **20번이면 하루치가 사라진다.**
 * 조정해야 하는 값에는 공짜로 관측하는 수단이 같이 있어야 한다(2026-09-02 교훈).
 *
 *   ?vad=1                     오버레이를 켜고 **업로드를 막는다**(할당량 0건)
 *   ?vad=1&vadstart=0.01       임계값을 그 자리에서 바꿔 본다 — 재빌드가 필요 없다
 *   ?vadstart=0.01             오버레이 없이 값만 적용(확정한 값을 실제 받아쓰기로 검증할 때)
 *
 * 현장에서 확정한 값은 나중에 vad.js의 DEFAULTS에 반영한다.
 */

/**
 * 유한수일 때만 돌려준다 — NaN이 DEFAULTS를 덮으면 VAD가 통째로 죽는다.
 * 빈 값(`?vadend=`)도 걸러야 한다: Number('')는 0이라, 그대로 두면 종료 임계값이
 * 0이 되어 **발화가 영영 끝나지 않는다**(모든 프레임이 임계값 이상이 된다).
 */
function num(raw) {
  if (raw === null || raw.trim() === '') return undefined;
  const v = Number(raw);
  return Number.isFinite(v) ? v : undefined;
}

/**
 * @param {string} [search]  location.search
 * @returns {{enabled: boolean, vadOptions: object}}
 */
export function readVadDebug(search = '') {
  const q = new URLSearchParams(search);
  const vadOptions = {};
  for (const [param, key] of [
    ['vadstart', 'startThreshold'],
    ['vadend', 'endThreshold'],
    ['vadsilence', 'silenceMs'],
  ]) {
    const v = num(q.get(param));
    if (v !== undefined) vadOptions[key] = v;
  }
  return { enabled: q.get('vad') === '1', vadOptions };
}
