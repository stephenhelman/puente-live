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
    f.push(interim("we are going to talk about"));
    c.advance(1500);
    f.push(interim("we are going to talk about")); // the same words again: the last word has settled
    c.advance(1499);
    expect(finalize).not.toHaveBeenCalled();
    c.advance(1);
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
    f.push(final("first words of a long run"));
    f.push(interim("and then more words come"));
    c.advance(2900); // 5.4 s after the first interim, but only 2.9 s after the final
    f.push(interim("and then more words come"));
    expect(finalize).not.toHaveBeenCalled();
    c.advance(200);
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
    f.push(interim("Hello there, folks"));
    c.advance(2900);
    f.push(interim("hello there folks!")); // same words
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
    f.push(interim("one two three"));
    c.advance(1500);
    f.push(interim("one two three"));
    c.advance(1500);
    expect(finalize).toHaveBeenCalledTimes(1);
    c.advance(30_000); // no new interim, no new Finalize
    expect(finalize).toHaveBeenCalledTimes(1);
    f.push(interim("four five six"));
    c.advance(1500);
    f.push(interim("four five six"));
    c.advance(1500);
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
    f.push(interim("we are going to talk"));
    c.advance(3100); // a frozen timer never fired
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
