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
