import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startContinuousStt } from "./continuous";
import type { Timers } from "./timers";
import type { SttProvider, SttResult, SttStartOptions } from "./types";

const interim = (text: string): SttResult => ({ text, isFinal: false, speechFinal: false, fromFinalize: false, words: [], languages: [], receivedAt: 0 });
const final = (text: string, fromFinalize = false): SttResult => ({ ...interim(text), isFinal: true, fromFinalize });

/** A provider whose socket is a spy; `emit` plays vendor results into the stream. */
function fake() {
  const finalize = vi.fn();
  const sent: number[] = [];
  let opts!: SttStartOptions;
  const provider: SttProvider = {
    async start(o) {
      opts = o;
      return { connectMs: 1, usedTokenRetry: false, sendAudio: (b) => void sent.push(b.byteLength), finalize, close: () => {} };
    },
  };
  return { provider, finalize, sent, emit: (r: SttResult) => opts.onResult(r), opts: () => opts };
}

const base = { getToken: async () => "t", sampleRate: 16000, endpointingMs: 400, onStatus: () => {}, onDrop: () => {} };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startContinuousStt: forced Finalize", () => {
  it("sends Finalize when interim text goes forceFinalizeMs without a final, and counts it", async () => {
    const f = fake();
    const got: SttResult[] = [];
    const s = await startContinuousStt(f.provider, { ...base, forceFinalizeMs: 3000, onResult: (r) => got.push(r) });
    f.emit(interim("we are going to talk about"));
    await vi.advanceTimersByTimeAsync(1500);
    f.emit(interim("we are going to talk about"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.finalize).toHaveBeenCalledTimes(1);
    expect(s.finalizesSent).toBe(1);
    expect(got).toHaveLength(2); // results still reach the caller untouched
    s.close();
  });

  it("is not sent while finals keep arriving, and the interval restarts on each final", async () => {
    const f = fake();
    const s = await startContinuousStt(f.provider, { ...base, forceFinalizeMs: 3000, onResult: () => {} });
    for (let i = 0; i < 6; i++) {
      f.emit(interim("some words are being said"));
      await vi.advanceTimersByTimeAsync(2500);
      f.emit(final("some words are being said"));
    }
    expect(f.finalize).not.toHaveBeenCalled();
    expect(s.finalizesSent).toBe(0);
    s.close();
  });

  it("is off when forceFinalizeMs is 0 or unset: never sends, however long the vendor holds its finals", async () => {
    for (const forceFinalizeMs of [0, undefined]) {
      const f = fake();
      const s = await startContinuousStt(f.provider, { ...base, forceFinalizeMs, onResult: () => {} });
      f.emit(interim("a long run of speech"));
      await vi.advanceTimersByTimeAsync(20_000);
      f.emit(interim("a long run of speech continues"));
      expect(f.finalize).not.toHaveBeenCalled();
      s.close();
    }
  });

  it("stops watching once closed", async () => {
    const f = fake();
    const s = await startContinuousStt(f.provider, { ...base, forceFinalizeMs: 3000, onResult: () => {} });
    f.emit(interim("some words here"));
    s.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.finalize).not.toHaveBeenCalled();
  });
});

describe("startContinuousStt: timers", () => {
  it("hands the injected (worker) timers to the provider, so its keep-alive is not throttled", async () => {
    const f = fake();
    const timers: Timers = { setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 2, clearInterval: () => {} };
    const s = await startContinuousStt(f.provider, { ...base, timers, onResult: () => {} });
    expect(f.opts().timers).toBe(timers);
    s.close();
  });
});
