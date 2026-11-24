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
    f.emit(interim("we are going"));
    await vi.advanceTimersByTimeAsync(1500);
    f.emit(interim("we are going to talk about"));
    await vi.advanceTimersByTimeAsync(900);
    f.emit(interim("we are going to talk about")); // settled
    await vi.advanceTimersByTimeAsync(600); // t = 3000: the limit
    expect(f.finalize).toHaveBeenCalledTimes(1);
    expect(s.finalizesSent).toBe(1);
    expect(got).toHaveLength(3); // results still reach the caller untouched
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

describe("startContinuousStt: cut repair", () => {
  it("restores a word dropped at a forced cut before the caller sees the final, and counts it", async () => {
    const f = fake();
    const got: SttResult[] = [];
    const w = (word: string, start: number) => ({ word, start, end: start + 0.3, confidence: 0.9 });
    const s = await startContinuousStt(f.provider, { ...base, forceFinalizeMs: 3000, onResult: (r) => got.push(r) });
    f.emit({ ...final("at your hemophilia", true), words: [w("at", 20.4), w("your", 20.7), w("hemophilia", 21)] });
    f.emit({ ...interim("treatment center"), words: [w("treatment", 21.85), w("center", 22.15)] });
    f.emit({ ...final("center becomes your"), words: [w("center", 22.17), w("becomes", 22.5), w("your", 22.8)] });
    expect(got[2]!.text).toBe("treatment center becomes your");
    expect(got[2]!.words).toHaveLength(4);
    expect(s.wordsRestored).toBe(1);
    s.close();
  });

  it("does not repair anything when forced Finalize is off (the stream is exactly the vendor's)", async () => {
    const f = fake();
    const got: SttResult[] = [];
    const w = (word: string, start: number) => ({ word, start, end: start + 0.3, confidence: 0.9 });
    const s = await startContinuousStt(f.provider, { ...base, onResult: (r) => got.push(r) });
    f.emit({ ...final("at your hemophilia", true), words: [w("at", 20.4), w("your", 20.7), w("hemophilia", 21)] });
    f.emit({ ...interim("treatment center"), words: [w("treatment", 21.85), w("center", 22.15)] });
    const last = { ...final("center becomes your"), words: [w("center", 22.17), w("becomes", 22.5), w("your", 22.8)] };
    f.emit(last);
    expect(got[2]).toBe(last);
    expect(s.wordsRestored).toBe(0);
    s.close();
  });
});

describe("startContinuousStt: empty answer to a forced Finalize", () => {
  it("hands the caller the interim the vendor discarded, flagged as the forced final", async () => {
    const f = fake();
    const got: SttResult[] = [];
    const w = (word: string, start: number) => ({ word, start, end: start + 0.3, confidence: 0.9 });
    const s = await startContinuousStt(f.provider, { ...base, forceFinalizeMs: 3000, onResult: (r) => got.push(r) });
    f.emit({ ...interim("infusions at home can prevent"), words: [w("infusions", 9.3), w("at", 9.6), w("home", 9.9), w("can", 10.2), w("prevent", 10.5)] });
    f.emit({ ...final("", true), speechFinal: true });
    expect(got[1]!.text).toBe("infusions at home can prevent");
    expect(got[1]!.isFinal).toBe(true);
    expect(got[1]!.fromFinalize).toBe(true);
    expect(s.wordsRestored).toBe(5);
    s.close();
  });

  it("does not interfere when forced Finalize is off: an empty final stays empty", async () => {
    const f = fake();
    const got: SttResult[] = [];
    const w = (word: string, start: number) => ({ word, start, end: start + 0.3, confidence: 0.9 });
    const s = await startContinuousStt(f.provider, { ...base, onResult: (r) => got.push(r) });
    f.emit({ ...interim("some pending words"), words: [w("some", 1), w("pending", 1.3), w("words", 1.6)] });
    const e = { ...final("", true), speechFinal: true };
    f.emit(e);
    expect(got[1]).toBe(e);
    s.close();
  });
});

