import { describe, expect, it, vi } from "vitest";
import { ForcedFinalizer } from "./finalizer";
import type { Timers } from "./timers";
import type { SttResult } from "./types";

/** A hand-driven clock with timers that fire when `advance` passes them. `frozen` timers never fire (a throttled window). */
function clock(opts: { frozen?: boolean } = {}) {
  let now = 1_000_000;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      if (!opts.frozen) pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void pending.delete(id),
    setInterval: () => 0,
    clearInterval: () => {},
  };
  return {
    timers,
    now: () => now,
    pending: () => pending.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

const interim = (text: string): SttResult => ({ text, isFinal: false, speechFinal: false, fromFinalize: false, words: [], languages: [], receivedAt: 0 });
const final = (text = "done here", fromFinalize = false): SttResult => ({ ...interim(text), isFinal: true, fromFinalize });

function rig(limitMs = 3000, frozen = false) {
  const c = clock({ frozen });
  const finalize = vi.fn();
  const f = new ForcedFinalizer({ limitMs, finalize, timers: c.timers, now: c.now });
  return { c, f, finalize };
}

describe("ForcedFinalizer", () => {
  it("sends Finalize once interim text has gone `limit` without a final (last word stable: right at the limit)", () => {
    const { c, f, finalize } = rig();
    f.push(interim("we are going"));
    c.advance(1500);
    f.push(interim("we are going to talk about")); // the recognizer is working: it changed
    c.advance(900);
    f.push(interim("we are going to talk about")); // the same words again: the last word has settled
    c.advance(599);
    expect(finalize).not.toHaveBeenCalled();
    c.advance(1); // the limit
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(f.finalizesSent).toBe(1);
  });

  it("is not sent while finals keep arriving", () => {
    const { c, f, finalize } = rig();
    for (let i = 0; i < 10; i++) {
      f.push(interim("some words are being said"));
      c.advance(2000); // less than the limit between finals
      f.push(final());
    }
    c.advance(10_000); // nothing pending afterwards
    expect(finalize).not.toHaveBeenCalled();
  });

  it("the timer resets on a final: the limit counts from the newest final, not from the first interim", () => {
    const { c, f, finalize } = rig();
    f.push(interim("first words of a long run"));
    c.advance(2500);
    f.push(final("first words of a long run")); // t = 2500: the interval restarts
    f.push(interim("and then more"));
    c.advance(1900);
    f.push(interim("and then more words come")); // t = 4400
    c.advance(500);
    f.push(interim("and then more words come")); // t = 4900, settled
    c.advance(500); // t = 5400: 5.4 s after the first interim, only 2.9 s after the final
    expect(finalize).not.toHaveBeenCalled();
    c.advance(200); // t = 5600, past final + 3000
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("is completely off with limit 0 (or less): no timers, no calls", () => {
    for (const limit of [0, -1]) {
      const { c, f, finalize } = rig(limit);
      f.push(interim("words words words"));
      expect(c.pending()).toBe(0);
      c.advance(60_000);
      f.push(interim("words words words more"));
      expect(finalize).not.toHaveBeenCalled();
      expect(f.enabled).toBe(false);
    }
  });

  it("when the last word is still changing, waits up to 500 ms more and then finalizes anyway", () => {
    const { c, f, finalize } = rig();
    f.push(interim("we are going"));
    c.advance(1000);
    f.push(interim("we are going to talk")); // new words keep arriving
    c.advance(1900);
    f.push(interim("we are going to talk about"));
    c.advance(100); // limit reached with an unsettled last word
    expect(finalize).not.toHaveBeenCalled();
    c.advance(499);
    expect(finalize).not.toHaveBeenCalled();
    c.advance(1);
    expect(finalize).toHaveBeenCalledTimes(1); // 3000 + 500
  });

  it("finalizes as soon as the last word settles inside the extra 500 ms", () => {
    const { c, f, finalize } = rig();
    f.push(interim("we are going"));
    c.advance(2900);
    f.push(interim("we are going to talk"));
    c.advance(100); // limit; "talk" is new -> grace
    expect(finalize).not.toHaveBeenCalled();
    c.advance(200);
    f.push(interim("we are going to talk")); // unchanged -> settled
    expect(finalize).toHaveBeenCalledTimes(1);
    c.advance(5000);
    expect(finalize).toHaveBeenCalledTimes(1); // and the grace timer did not fire a second one
  });

  it("a word changing to a different word is not stable; punctuation and case do not matter", () => {
    const { c, f, finalize } = rig();
    f.push(interim("Hello there"));
    c.advance(1500);
    f.push(interim("Hello there, folks"));
    c.advance(1400);
    f.push(interim("hello there folks!")); // t = 2900: the same words
    c.advance(100);
    expect(finalize).toHaveBeenCalledTimes(1);
    const r2 = rig();
    r2.f.push(interim("we need the vector"));
    r2.c.advance(2900);
    r2.f.push(interim("we need the factor")); // the last word was revised
    r2.c.advance(100);
    expect(r2.finalize).not.toHaveBeenCalled();
  });

  it("at most one Finalize per interval: it needs new interim text to start the next one", () => {
    const { c, f, finalize } = rig();
    f.push(interim("one two"));
    c.advance(1500);
    f.push(interim("one two three"));
    c.advance(1000);
    f.push(interim("one two three")); // settled
    c.advance(500); // t = 3000
    expect(finalize).toHaveBeenCalledTimes(1);
    c.advance(30_000); // no new interim, no new Finalize
    expect(finalize).toHaveBeenCalledTimes(1);
    f.push(interim("four five"));
    c.advance(1500);
    f.push(interim("four five six seven"));
    c.advance(1000);
    f.push(interim("four five six seven"));
    c.advance(500);
    expect(finalize).toHaveBeenCalledTimes(2);
  });

  it("silence (empty interims) starts nothing", () => {
    const { c, f, finalize } = rig();
    f.push(interim(""));
    f.push(interim("   "));
    expect(c.pending()).toBe(0);
    c.advance(60_000);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("still enforces the limit from the clock when its timers are frozen (background window)", () => {
    const { c, f, finalize } = rig(3000, true);
    f.push(interim("we are going"));
    c.advance(1500);
    f.push(interim("we are going to talk"));
    c.advance(1600); // t = 3100: a frozen timer never fired
    expect(finalize).not.toHaveBeenCalled();
    f.push(interim("we are going to talk")); // the next vendor message is the wake-up: the limit passed, word is stable
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("reset() (a dropped socket) and dispose() cancel everything", () => {
    const a = rig();
    a.f.push(interim("some words here"));
    a.f.reset();
    expect(a.c.pending()).toBe(0);
    a.c.advance(60_000);
    expect(a.finalize).not.toHaveBeenCalled();
    const b = rig();
    b.f.push(interim("some words here"));
    b.f.dispose();
    b.c.advance(60_000);
    b.f.push(interim("more words"));
    expect(b.finalize).not.toHaveBeenCalled();
  });
});

/**
 * Regression for the measured loss at an English -> Spanish switch (synthetic speech, logged Deepgram messages).
 * The interims were: 'wherever you go.' ... 'you go. Sobrella prophylaxis o sobrellel' (the new language half-heard), then
 * 'you go.' again (the recognizer threw the Spanish words away while it decided what it was hearing). The old "stable"
 * rule saw the same word at the same position and finalized at once; that committed ~2.5 s of undecoded Spanish as
 * "you go." and about ten words were lost for good. A shrinking interim is the recognizer reconsidering, not settling.
 */
describe("ForcedFinalizer: an interim that shrinks is not stable", () => {
  /** limit 3000: armed by the first interim, the limit lands at t = 3000. */
  function toLimitWithShrink() {
    const r = rig();
    r.f.push(interim("carry your treatment card wherever you go"));
    r.c.advance(2000);
    r.f.push(interim("you go. Sobrella prophylaxis o sobrellel")); // grew: the new language, half heard
    r.c.advance(900);
    r.f.push(interim("you go.")); // t = 2900: the recognizer dropped the Spanish words
    return r;
  }

  it("does not finalize at the limit right after a shrink (the old rule did)", () => {
    const { c, f, finalize } = toLimitWithShrink();
    c.advance(100); // the limit
    expect(finalize).not.toHaveBeenCalled();
    f.push(interim("you go.")); // unchanged since: would have been "stable" immediately
    expect(finalize).not.toHaveBeenCalled();
  });

  it("waits until 1500 ms have passed since the shrink, then finalizes once the interim is stable", () => {
    const { c, f, finalize } = toLimitWithShrink(); // shrink at t = 2900
    c.advance(100);
    c.advance(600);
    f.push(interim("you go.")); // t = 3600, stable but only 700 ms after the shrink
    expect(finalize).not.toHaveBeenCalled();
    c.advance(800);
    f.push(interim("you go.")); // t = 4400: 1500 ms after the shrink, stable
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("if the recognizer recovers the words in the meantime, they are in the interim when we finalize", () => {
    const { c, f, finalize } = toLimitWithShrink();
    c.advance(1000);
    f.push(interim("you go. Sobre la profilaxis o sobre el")); // it settled on the Spanish: growth, not stable
    expect(finalize).not.toHaveBeenCalled();
    c.advance(700); // t = 4600: grace over (shrink + 1500 = 4400), finalize now
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("finalizes on its own timer at shrink + settle even if no more interims arrive", () => {
    const { c, finalize } = toLimitWithShrink();
    c.advance(1499 + 100 - 1); // up to t = 4498: the shrink was at 2900, settle ends at 4400
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("never holds longer than maxHoldMs past the limit, however often it shrinks", () => {
    const { c, f, finalize } = rig();
    f.push(interim("one two three four five six"));
    let n = 6;
    for (let t = 0; t < 3000; t += 500) {
      c.advance(500);
      f.push(interim(Array.from({ length: n-- % 5 + 3 }, (_, i) => `w${i}`).join(" "))); // keeps changing length
    }
    expect(finalize).not.toHaveBeenCalled();
    c.advance(3500); // the cap: limit (3000) + 3500
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("an interim that only grows is unchanged from before: finalizes at limit + 500 ms", () => {
    const { c, f, finalize } = rig();
    f.push(interim("one two"));
    c.advance(1500);
    f.push(interim("one two three four"));
    c.advance(1500);
    f.push(interim("one two three four five six")); // still growing at the limit
    expect(finalize).not.toHaveBeenCalled();
    c.advance(499);
    expect(finalize).not.toHaveBeenCalled();
    c.advance(1);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("a shrink long before the limit does not delay anything", () => {
    const { c, f, finalize } = rig();
    f.push(interim("one two three four"));
    c.advance(300);
    f.push(interim("one two")); // shrink at t = 300
    c.advance(1900);
    f.push(interim("one two three")); // t = 2200, grew again
    c.advance(500);
    f.push(interim("one two three")); // t = 2700, settled
    c.advance(300);
    expect(finalize).toHaveBeenCalledTimes(1); // at the limit (3000), 2700 ms after the shrink
  });
});

/**
 * Regression for the second measured Spanish loss: the interim sat at 'you go.' for ~3 s while Spanish audio flowed (the
 * recognizer was still deciding on the language and showed nothing). An unchanged interim looked "settled", Finalize
 * committed the undecoded audio, and the flush returned only 'you go.'.
 */
describe("ForcedFinalizer: an interim that stopped changing is stuck, not settled", () => {
  it("does not finalize a stale interim at the limit, however long it stays that way", () => {
    const { c, f, finalize } = rig();
    f.push(interim("carry your treatment card wherever you go."));
    for (let i = 0; i < 12; i++) {
      c.advance(1000);
      f.push(interim("carry your treatment card wherever you go.")); // identical every second: audio flows, nothing decoded
    }
    expect(finalize).not.toHaveBeenCalled(); // 12 s, well past the limit
  });

  it("once the recognizer moves again it applies the normal rules: finalizes at +500 ms if still changing", () => {
    const { c, f, finalize } = rig();
    f.push(interim("you go."));
    c.advance(5000); // stale past the limit
    expect(finalize).not.toHaveBeenCalled();
    f.push(interim("you go. Sobre la profilaxis")); // the Spanish finally decoded
    expect(finalize).not.toHaveBeenCalled();
    c.advance(499);
    expect(finalize).not.toHaveBeenCalled();
    c.advance(1);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("an interim that changes at least every couple of seconds is live", () => {
    const { c, f, finalize } = rig();
    f.push(interim("one"));
    c.advance(1900);
    f.push(interim("one two")); // changed 1.9 s ago... 
    c.advance(1000);
    f.push(interim("one two")); // t = 2900
    c.advance(100); // limit; last change was 1100 ms ago and it is settled
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("a stale interim that is still pending when a natural final arrives costs nothing: the interval just resets", () => {
    const { c, f, finalize } = rig();
    f.push(interim("you go."));
    c.advance(5000);
    f.push(final("you go."));
    f.push(interim("Sobre la profilaxis o sobre"));
    c.advance(2000);
    expect(finalize).not.toHaveBeenCalled();
  });
});

