import { describe, expect, it } from "vitest";
import { words } from "@/test/fixtures";
import { DEFAULT_SEGMENTER_OPTIONS, PhraseSegmenter } from "./segmenter";
import type { Timers } from "./timers";
import type { SttResult } from "./types";

/** Timers that never fire: a background window whose timers the browser froze. */
const frozen: Timers = { setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {} };

const result = (text: string, startAt: number, isFinal = true, speechFinal = false): SttResult => ({
  text, isFinal, speechFinal, fromFinalize: false, words: text ? words(text, "en", startAt) : [], languages: [], receivedAt: 0,
});

describe("segmenter under throttled timers", () => {
  it("still emits a quiet phrase when the next vendor message arrives, with no timer firing", () => {
    let clock = 1_000_000;
    const out: string[] = [];
    const s = new PhraseSegmenter((t) => out.push(t), DEFAULT_SEGMENTER_OPTIONS, () => clock, frozen);
    s.push(result("we should start the meeting now", 0));
    expect(out).toEqual([]);
    clock += 1000; // longer than quietMs; Deepgram's next (empty) message is the only wake-up
    s.push(result("", 0));
    expect(out).toEqual(["we should start the meeting now"]);
  });
  it("reports the phrase's spoken start", () => {
    const infos: (number | undefined)[] = [];
    const s = new PhraseSegmenter((_t, i) => infos.push(i.startSec), DEFAULT_SEGMENTER_OPTIONS, () => 0, frozen);
    s.push(result("thank you all for joining today", 12.5, true, true));
    expect(infos).toEqual([12.5]);
  });
});

describe("which rule ended each phrase (cut)", () => {
  /** A segmenter on a hand-driven clock; returns what it emitted as [text, cut]. */
  function rig(opts: Partial<typeof DEFAULT_SEGMENTER_OPTIONS> = {}) {
    let clock = 1_000_000;
    const out: [string, string][] = [];
    const s = new PhraseSegmenter((t, i) => out.push([t, i.cut]), { ...DEFAULT_SEGMENTER_OPTIONS, ...opts }, () => clock, frozen);
    return { s, out, advance: (ms: number) => (clock += ms) };
  }

  it("final: the vendor flagged speech_final", () => {
    const r = rig();
    r.s.push(result("we should start the meeting now", 0, true, true));
    expect(r.out).toEqual([["we should start the meeting now", "final"]]);
  });

  it("pause: a word gap >= pauseMs, found when the next word arrives", () => {
    const r = rig();
    r.s.push(result("we should start now", 0));
    r.s.push(result("and then the budget", 5)); // 5 s later in vendor time
    expect(r.out).toEqual([["we should start now", "pause"]]);
  });

  it("quiet: nothing new for quietMs", () => {
    const r = rig();
    r.s.push(result("we should start the meeting now", 0));
    r.advance(1000);
    r.s.push(result("", 0));
    expect(r.out).toEqual([["we should start the meeting now", "quiet"]]);
  });

  it("maxWords: long buffer at the next final", () => {
    const r = rig({ maxWords: 6 });
    r.s.push(result("one two three four five six seven eight", 0)); // no gaps, no speech_final
    expect(r.out).toEqual([["one two three four five six seven eight", "maxWords"]]);
  });

  it("maxAge: an old buffer at the next final", () => {
    const r = rig({ maxAgeMs: 4000, quietMs: 60_000 }); // quiet out of the way: only age can cut
    r.s.push(result("we should start the", 0));
    r.advance(4500);
    r.s.push(result("meeting now with everyone", 1.6)); // 0.1 s word gap: not a pause
    expect(r.out).toEqual([["we should start the meeting now with everyone", "maxAge"]]);
  });

  it("hold: a short fragment nothing joined within holdMs", () => {
    const r = rig({ holdMs: 1000 });
    r.s.push(result("okay", 0, true, true)); // held (one word, no sentence end)
    expect(r.out).toEqual([]);
    r.advance(1500);
    r.s.push(result("", 0));
    expect(r.out).toEqual([["okay", "hold"]]);
  });

  it("flush: end of turn, a dropped socket or stop", () => {
    const r = rig();
    r.s.push(result("we should start the meeting", 0));
    r.s.flush();
    expect(r.out).toEqual([["we should start the meeting", "flush"]]);
  });

  it("the thresholds come from the options, so a tuned page cuts sooner", () => {
    const tuned = rig({ maxWords: 4 });
    const stock = rig();
    for (const r of [tuned, stock]) r.s.push(result("one two three four five six", 0));
    expect(tuned.out.map((o) => o[1])).toEqual(["maxWords"]);
    expect(stock.out).toEqual([]);
  });
});

describe("forced cuts (a final that came from our own Finalize)", () => {
  const forcedFinal = (text: string, startAt: number): SttResult => ({ ...result(text, startAt, true, false), fromFinalize: true });

  it("a maxWords cut at a Finalize-induced final is reported as forced", () => {
    const out: [string, string][] = [];
    const s = new PhraseSegmenter((t, i) => out.push([t, i.cut]), { ...DEFAULT_SEGMENTER_OPTIONS, maxWords: 6 }, () => 0, frozen);
    s.push(forcedFinal("one two three four five six seven", 0));
    expect(out).toEqual([["one two three four five six seven", "forced"]]);
  });

  it("a maxAge cut at a Finalize-induced final is forced too", () => {
    let clock = 1_000_000;
    const out: string[] = [];
    const s = new PhraseSegmenter((_t, i) => out.push(i.cut), { ...DEFAULT_SEGMENTER_OPTIONS, maxAgeMs: 4000, quietMs: 60_000 }, () => clock, frozen);
    s.push(result("we should start the", 0));
    clock += 4500;
    s.push(forcedFinal("meeting now with everyone", 1.6));
    expect(out).toEqual(["forced"]);
  });

  it("the existing rules are unchanged: a forced final under the limits is simply buffered, then cut by a normal rule", () => {
    const out: [string, string][] = [];
    const s = new PhraseSegmenter((t, i) => out.push([t, i.cut]), DEFAULT_SEGMENTER_OPTIONS, () => 0, frozen);
    s.push(forcedFinal("we are going to talk about it", 0)); // 7 words: under maxWords, young, no speech_final
    expect(out).toEqual([]);
    s.push(result("and that is all", 2.8, true, true)); // contiguous speech, then a natural final
    expect(out).toEqual([["we are going to talk about it and that is all", "final"]]);
  });

  it("the vendor flags a Finalize result speech_final too; it is still labelled forced (a natural final stays final)", () => {
    const out: string[] = [];
    const s = new PhraseSegmenter((_t, i) => out.push(i.cut), DEFAULT_SEGMENTER_OPTIONS, () => 0, frozen);
    s.push({ ...result("thank you all for joining today", 0, true, true), fromFinalize: true });
    s.push(result("and now the first question please", 5, true, true)); // from_finalize false: a natural endpoint
    expect(out).toEqual(["forced", "final"]);
  });
});
