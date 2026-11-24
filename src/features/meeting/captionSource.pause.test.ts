import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { words } from "@/test/fixtures";
import type { SttResult, SttStartOptions } from "@/engine";

/** The vendor, faked: records the options of the (single) socket and counts what is sent to it. */
const h = vi.hoisted(() => ({
  opts: null as null | { onResult: (r: SttResult) => void; onClose: (i: { code: number; reason: string }) => void; keepAliveMs?: number; timers?: unknown },
  sent: [] as number[],
  closed: 0,
  tap: { onChunk: null as null | ((pcm: ArrayBuffer) => void), dispose: () => {} },
}));

vi.mock("@/engine", async (orig) => {
  const m = await orig<typeof import("@/engine")>();
  class FakeProvider {
    async start(o: SttStartOptions) {
      h.opts = o as never;
      return {
        connectMs: 1,
        usedTokenRetry: false,
        sendAudio: (b: ArrayBuffer) => void h.sent.push(b.byteLength),
        finalize: () => {},
        close: () => void h.closed++,
      };
    }
  }
  return { ...m, DeepgramSttProvider: FakeProvider };
});
vi.mock("@/features/audio/streamPcm", () => ({ STT_SAMPLE_RATE: 16000, openPcmTap: async () => h.tap }));
vi.mock("@/features/audio/token", () => ({ getDeepgramToken: async () => "t" }));

import { CaptionSource, type PhraseEvent } from "./captionSource";
import { DEFAULT_TUNING } from "@/engine";

const stream = { getAudioTracks: () => [{ addEventListener() {} }], getTracks: () => [] } as unknown as MediaStream;
const tuning = { ...DEFAULT_TUNING, maxSessionMs: 0, warnAtMs: 0 };
/** One second of 16 kHz 16-bit audio, so each chunk moves the vendor's clock by exactly one second. */
const second = () => new ArrayBuffer(32000);

const res = (text: string, startAt: number, o: Partial<SttResult> = {}): SttResult => ({
  text, isFinal: true, speechFinal: true, fromFinalize: false, words: text ? words(text, "en", startAt) : [], languages: [], receivedAt: 0, ...o,
});

function make() {
  const phrases: PhraseEvent[] = [];
  const tails: string[] = [];
  const levels: number[] = [];
  const src = new CaptionSource({
    id: "meeting", stream, tuning, keyterms: [],
    onPhrase: (e) => phrases.push(e), onTail: (_i, t) => tails.push(t), onStatus: () => {}, onLevel: (r) => levels.push(r),
  });
  return { src, phrases, tails, levels };
}
const feed = (n: number) => { for (let i = 0; i < n; i++) h.tap.onChunk?.(second()); };

beforeEach(() => { h.opts = null; h.sent = []; h.closed = 0; h.tap.onChunk = null; });
afterEach(() => vi.useRealTimers());

describe("CaptionSource pause", () => {
  it("sends audio while live, nothing while paused, and everything again after resume", async () => {
    const { src } = make();
    await src.start();
    feed(3);
    expect(h.sent).toHaveLength(3);
    src.setPaused(true);
    feed(5);
    expect(h.sent).toHaveLength(3);
    src.setPaused(false);
    feed(2);
    expect(h.sent).toHaveLength(5);
    await src.stop();
  });

  it("keeps the socket open during a pause (the provider's keep-alive is configured; the stream is not closed)", async () => {
    const { src } = make();
    await src.start();
    expect(h.opts?.keepAliveMs).toBeGreaterThan(0);
    src.setPaused(true);
    feed(30);
    expect(h.closed).toBe(0);
    await src.stop();
  });

  it("the level meter keeps reporting while paused (the operator still sees the signal)", async () => {
    const { src, levels } = make();
    await src.start();
    const loud = new Int16Array(16000).fill(8000).buffer;
    src.setPaused(true);
    h.tap.onChunk?.(loud);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toBeGreaterThan(0.2);
    await src.stop();
  });

  it("discards words buffered before the pause: they are never emitted, not even when the source stops", async () => {
    const { src, phrases, tails } = make();
    await src.start();
    feed(2);
    h.opts!.onResult(res("we should start the meeting now", 0, { speechFinal: false })); // buffered, no phrase yet
    expect(tails.at(-1)).toContain("we should start");
    src.setPaused(true);
    expect(tails.at(-1)).toBe("");
    await src.stop(); // stop flushes whatever is buffered: nothing may be left
    expect(phrases).toEqual([]);
  });

  it("ignores everything the vendor returns while paused (late results for audio sent before the pause)", async () => {
    const { src, phrases, tails } = make();
    await src.start();
    feed(10);
    src.setPaused(true);
    const before = tails.length;
    h.opts!.onResult(res("this was said just before the pause", 8)); // arrives a moment late
    h.opts!.onResult(res("and this", 9, { isFinal: false, speechFinal: false }));
    expect(phrases).toEqual([]);
    expect(tails).toHaveLength(before);
    await src.stop();
  });

  it("after a resume, words timed before the pause point are dropped and new ones pass", async () => {
    const { src, phrases } = make();
    await src.start();
    feed(10); // vendor clock = 10 s
    src.setPaused(true);
    feed(20); // nothing sent: the clock stays at 10 s
    src.setPaused(false);
    feed(3);
    // a late result that still covers pre-pause speech (8-10 s) is dropped entirely
    h.opts!.onResult(res("said right before the pause", 8.0));
    expect(phrases).toEqual([]);
    // a result mixing old and new words keeps only the new ones
    h.opts!.onResult(res("said before and now fresh words follow here", 9.0));
    expect(phrases).toHaveLength(1);
    expect(phrases[0]!.text).not.toMatch(/said|before/);
    expect(phrases[0]!.text).toMatch(/fresh words follow here$/);
    await src.stop();
  });

  it("speech after a resume captions normally", async () => {
    const { src, phrases } = make();
    await src.start();
    feed(5);
    src.setPaused(true);
    src.setPaused(false);
    feed(1);
    h.opts!.onResult(res("thank you all for joining today", 5.2));
    expect(phrases.map((p) => p.text)).toEqual(["thank you all for joining today"]);
    await src.stop();
  });

  it("a reconnect restarts the vendor clock: the stale-word filter is reset with it", async () => {
    const { src, phrases } = make();
    await src.start();
    feed(50); // the vendor's clock is at 50 s
    src.setPaused(true);
    src.setPaused(false); // anything the vendor timed before 50 s is now "stale"
    const first = h.opts;
    first!.onClose({ code: 1006, reason: "" }); // the socket drops; the wrapper reconnects (~300 ms backoff)
    await vi.waitFor(() => expect(h.opts).not.toBe(first), { timeout: 3000 });
    // the new socket's clock starts at 0 again: words timed 1-3 s are NEW speech and must not be dropped as stale
    h.opts!.onResult(res("thank you all for joining today", 1.0));
    expect(phrases.map((p) => p.text)).toEqual(["thank you all for joining today"]);
    await src.stop();
  });

  it("setPaused is idempotent and does nothing after stop", async () => {
    const { src, tails } = make();
    await src.start();
    src.setPaused(true);
    const n = tails.length;
    src.setPaused(true);
    expect(tails).toHaveLength(n);
    await src.stop();
    src.setPaused(false);
    expect(src.isPaused).toBe(true);
  });

  it("discard() (Clear) drops buffered words but keeps listening", async () => {
    const { src, phrases } = make();
    await src.start();
    h.opts!.onResult(res("we should start the meeting now", 0, { speechFinal: false }));
    src.discard();
    h.opts!.onResult(res("thank you all for joining today", 5));
    expect(phrases.map((p) => p.text)).toEqual(["thank you all for joining today"]);
    await src.stop();
  });
});
