/**
 * 웨이크워드 엔진 어댑터 계약 (lib/wake-engine.js).
 *
 * wasm 도 오디오도 없이 돈다 — 가짜 vosk 모듈을 loadVosk 로 주입한다.
 * 여기서 덮는 것은 **엔진이 켜지지 않았을 때 아무것도 안 받는지**와, 문법 제한이
 * 안 먹을 때 자유 발화로 떨어지되 조용히 죽지는 않는지다. 정확도는 실물 마이크의 몫이다.
 */

import { describe, it, expect, vi } from 'vitest';
import { createWakeEngine } from '../src/lib/wake-engine';

/** vosk-browser 의 Model/KaldiRecognizer 를 흉내 낸다 */
function makeFakeVosk({ grammarThrows = false } = {}) {
  const calls = { createModel: 0, recognizers: [], instances: [], fed: [], finals: 0, removed: 0, terminated: 0 };

  class FakeRecognizer {
    constructor(sampleRate, grammar) {
      if (grammar && grammarThrows) throw new Error('grammar not supported');
      this.sampleRate = sampleRate;
      this.grammar = grammar;
      this.listeners = {};
      calls.recognizers.push({ sampleRate, grammar });
      calls.instances.push(this);
    }
    on(event, fn) { this.listeners[event] = fn; }
    acceptWaveform(buf) { calls.fed.push(buf); }
    retrieveFinalResult() {
      calls.finals += 1;
      // 실제 워커처럼 비동기로 돌려준다
      setTimeout(() => this.listeners.result?.({ result: { text: this.nextText ?? '' } }), 0);
    }
    remove() { calls.removed += 1; }
  }

  const model = {
    KaldiRecognizer: FakeRecognizer,
    terminate() { calls.terminated += 1; },
  };

  return {
    calls,
    model,
    module: {
      createModel: vi.fn(async (url) => { calls.createModel += 1; calls.url = url; return model; }),
    },
  };
}

describe('createWakeEngine', () => {
  it('문법 목록을 넣으면 [unk] 를 붙여 인식기를 만든다', async () => {
    const fake = makeFakeVosk();
    const engine = createWakeEngine({
      mode: 'grammar',
      modelUrl: '/models/ko.tar.gz',
      phrases: ['돌봄아', '살려'],
      loadVosk: async () => fake.module,
    });

    const res = await engine.ready;
    expect(res.ok).toBe(true);
    expect(res.grammar).toBe(true);
    expect(fake.calls.url).toBe('/models/ko.tar.gz');
    // [unk] 가 없으면 목록 밖의 말이 억지로 목록 안의 낱말로 붙는다
    expect(JSON.parse(fake.calls.recognizers[0].grammar)).toEqual(['돌봄아', '살려', '[unk]']);
    engine.dispose();
  });

  it('문법 제한이 안 먹으면 자유 발화로 떨어지되 계속 돈다', async () => {
    const fake = makeFakeVosk({ grammarThrows: true });
    const engine = createWakeEngine({
      mode: 'grammar',
      modelUrl: '/m.tar.gz',
      phrases: ['돌봄아'],
      loadVosk: async () => fake.module,
    });

    const res = await engine.ready;
    // 조용히 죽는 것보다 덜 정확한 채로 도는 편이 낫다 — 측정은 어느 쪽이든 된다
    expect(res.ok).toBe(true);
    expect(res.grammar).toBe(false);
    expect(engine.grammar).toBe(false);
    expect(fake.calls.recognizers.at(-1).grammar).toBeUndefined();
    engine.dispose();
  });

  it('free 모드는 문법을 아예 안 건다', async () => {
    const fake = makeFakeVosk();
    const engine = createWakeEngine({
      mode: 'free', modelUrl: '/m.tar.gz', phrases: ['돌봄아'], loadVosk: async () => fake.module,
    });
    await engine.ready;
    expect(fake.calls.recognizers[0].grammar).toBeUndefined();
    engine.dispose();
  });

  it('finish() 는 여태 들은 것을 합쳐 돌려주고 비운다', async () => {
    const fake = makeFakeVosk();
    const engine = createWakeEngine({ modelUrl: '/m.tar.gz', loadVosk: async () => fake.module });
    await engine.ready;

    const rec = fake.calls.instances[0];

    // Kaldi 는 발화 도중 스스로 result 를 흘려보내기도 한다. 그 조각까지 담기지 않으면
    // 웨이크워드가 거기 실려 사라진다 — finish() 가 그때까지 모인 것을 합쳐야 한다.
    rec.listeners.result({ result: { text: '돌봄아' } });
    rec.nextText = '오늘 날씨 어때';

    const first = await engine.finish();
    expect(first.text).toBe('돌봄아 오늘 날씨 어때');
    expect(first.ready).toBe(true);
    expect(typeof first.ms).toBe('number');

    rec.nextText = '';

    // 두 번째 호출에 첫 번째 결과가 남아 있으면 안 된다 (발화가 서로 섞인다)
    const second = await engine.finish();
    expect(second.text).toBe('');
    engine.dispose();
  });

  it('모델 로딩이 실패해도 feed/finish 가 던지지 않는다', async () => {
    const engine = createWakeEngine({
      modelUrl: '/없는주소.tar.gz',
      loadVosk: async () => { throw new Error('네트워크 끊김'); },
    });

    const res = await engine.ready;
    expect(res.ok).toBe(false);
    // 마이크는 계속 돌아야 한다 — 엔진이 없다고 캡처를 멈추지 않는다
    expect(() => engine.feed({})).not.toThrow();
    await expect(engine.finish()).resolves.toMatchObject({ text: '', ready: false });
    engine.dispose();
  });

  it('dispose() 는 인식기와 워커를 함께 정리한다', async () => {
    const fake = makeFakeVosk();
    const engine = createWakeEngine({ modelUrl: '/m.tar.gz', loadVosk: async () => fake.module });
    await engine.ready;
    engine.dispose();
    expect(fake.calls.removed).toBe(1);
    expect(fake.calls.terminated).toBe(1);
    // 정리된 뒤 들어온 프레임은 조용히 버린다
    expect(() => engine.feed({})).not.toThrow();
  });
});
