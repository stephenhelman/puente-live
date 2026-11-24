import { describe, expect, it } from "vitest";
import { CutRepair } from "./cutrepair";
import type { SttResult, SttWord } from "./types";

/** Words from "text" laid out from `start`, 0.3 s each, like the vendor's. */
const ws = (text: string, start: number): SttWord[] =>
  text.split(" ").map((word, i) => ({ word, start: +(start + i * 0.3).toFixed(2), end: +(start + i * 0.3 + 0.3).toFixed(2), confidence: 0.9 }));
const res = (text: string, start: number, o: Partial<SttResult> = {}): SttResult => ({
  text, isFinal: false, speechFinal: false, fromFinalize: false, words: text ? ws(text, start) : [], languages: [], receivedAt: 0, ...o,
});
const forced = (text: string, start: number) => res(text, start, { isFinal: true, speechFinal: true, fromFinalize: true });
const natural = (text: string, start: number) => res(text, start, { isFinal: true });

/**
 * Message sequence logged from a synthetic run (words were being spoken at the instant of the cut):
 *   final (forced)  '... your hemophilia'               ends 21.64
 *   interim         'treatment center'                  starts 21.85
 *   interim         'treatment center becomes your ...'
 *   final           'center becomes your most important partner'   <- "treatment" is gone
 */
describe("CutRepair", () => {
  it("puts back the leading word the vendor returned in an interim and then dropped from the final", () => {
    const cr = new CutRepair();
    cr.process(forced("hematologist at your hemophilia", 20.4)); // ends 21.6
    cr.process(res("treatment center", 21.85));
    cr.process(res("treatment center becomes your most important", 21.85));
    const out = cr.process(natural("center becomes your most important partner", 22.17));
    expect(out.text).toBe("treatment center becomes your most important partner");
    expect(out.words.map((w) => w.word)).toEqual(["treatment", "center", "becomes", "your", "most", "important", "partner"]);
    expect(out.words[0]).toMatchObject({ start: 21.85, end: 22.15 }); // the interim's own timestamps
    expect(out.words[1]!.start).toBe(22.17);
    expect(cr.restored).toBe(1);
  });

  it("restores up to two leading words", () => {
    const cr = new CutRepair();
    cr.process(forced("keep every follow-up visit", 34));
    cr.process(res("to report any bleed", 35.4));
    const out = cr.process(natural("any bleed to your care team", 36.3));
    expect(out.text).toBe("to report any bleed to your care team");
    expect(cr.restored).toBe(2);
  });

  it("does nothing when the final starts where the interim did (nothing was dropped)", () => {
    const cr = new CutRepair();
    cr.process(forced("works for people with hemophilia", 5));
    cr.process(res("prophylaxis with", 6.6));
    const f = natural("prophylaxis with factor VIII works", 6.6);
    expect(cr.process(f)).toBe(f);
    expect(cr.restored).toBe(0);
  });

  it("only repairs after a final WE forced; a natural final's next segment is left alone", () => {
    const cr = new CutRepair();
    cr.process(natural("some earlier words here", 1));
    cr.process(res("treatment center", 3));
    const f = natural("center becomes", 3.3);
    expect(cr.process(f)).toBe(f);
    expect(cr.restored).toBe(0);
  });

  it("does not touch a final whose first word is not the interim's next word (the two texts are not known to match)", () => {
    const cr = new CutRepair();
    cr.process(forced("at your hemophilia", 20));
    cr.process(res("a famine", 21));
    const f = natural("families but it is still", 21);
    expect(cr.process(f)).toBe(f);
  });

  it("leaves it alone when a restored word would repeat the final's first word", () => {
    const cr = new CutRepair();
    cr.process(forced("keep going", 10));
    cr.process(res("very very important", 11));
    const f = natural("very important to keep", 11.6);
    expect(cr.process(f)).toBe(f);
  });

  it("leaves it alone when the leading words start before the previous final ended (an echo, not a new word)", () => {
    const cr = new CutRepair();
    cr.process(forced("we will begin the talk about prophylaxis", 10)); // ends 12.1
    cr.process(res("the talk about prophylaxis today", 10.9)); // starts inside the previous final
    const f = natural("talk about prophylaxis today", 11.2);
    expect(cr.process(f)).toBe(f);
  });

  it("an empty final does not end the segment; the repair still applies to the next real final", () => {
    const cr = new CutRepair();
    cr.process(forced("bleeds before they ever start", 8));
    cr.process(res("infusions at home can prevent", 9.7));
    expect(cr.process(natural("", 0)).text).toBe("");
    const out = cr.process(natural("at home can prevent most joint bleeds", 10));
    expect(out.text).toBe("infusions at home can prevent most joint bleeds");
  });

  it("repairs each forced cut once, then goes back to normal", () => {
    const cr = new CutRepair();
    cr.process(forced("one two three", 1));
    cr.process(res("four five six", 2.1));
    const a = cr.process(forced("five six seven", 2.4)); // repaired (and itself forced: opens the next segment)
    expect(a.text).toBe("four five six seven");
    cr.process(res("eight nine ten", 3.6));
    const b = cr.process(natural("nine ten eleven", 3.9));
    expect(b.text).toBe("eight nine ten eleven");
    cr.process(res("twelve thirteen", 5));
    const c = natural("thirteen fourteen", 5.3); // the previous final was natural now: left alone
    expect(cr.process(c)).toBe(c);
    expect(cr.restored).toBe(2);
  });

  it("reset() forgets a pending segment (the socket dropped and its clock restarts)", () => {
    const cr = new CutRepair();
    cr.process(forced("hemophilia", 1));
    cr.process(res("treatment center", 1.3));
    cr.reset();
    const f = natural("center becomes", 1.6);
    expect(cr.process(f)).toBe(f);
  });
});

/**
 * The biggest measured loss: the vendor answered our Finalize with an EMPTY final and discarded a whole pending segment
 * that its own interim had shown in full a moment before (synthetic speech; 16 words per occurrence).
 */
describe("CutRepair: an empty answer to Finalize", () => {
  const empty = (fromFinalize: boolean): SttResult => ({ ...res("", 0), isFinal: true, speechFinal: true, fromFinalize });

  it("promotes the last interim when the final that answers Finalize is empty", () => {
    const cr = new CutRepair();
    cr.process(res("infusions at home", 9.28));
    cr.process(res("infusions at home can prevent most joint bleeds before they ever start", 9.28));
    const out = cr.process(empty(true));
    expect(out.text).toBe("infusions at home can prevent most joint bleeds before they ever start");
    expect(out.words).toHaveLength(12);
    expect(out.isFinal).toBe(true);
    expect(out.fromFinalize).toBe(true);
    expect(out.speechFinal).toBe(true);
    expect(cr.promoted).toBe(12);
    expect(cr.restored).toBe(12);
  });

  it("never touches a natural empty final (silence): only ones flagged from_finalize", () => {
    const cr = new CutRepair();
    cr.process(res("some words that are pending", 3));
    const e = empty(false);
    expect(cr.process(e)).toBe(e);
    expect(cr.promoted).toBe(0);
  });

  it("does nothing when a final with text already consumed the interim (the empty one is just the echo of a race)", () => {
    const cr = new CutRepair();
    cr.process(res("carry your treatment card wherever you go.", 38.9));
    cr.process(natural("carry your treatment card wherever you go.", 38.9)); // the natural final won the race
    const e = empty(true); // our Finalize found nothing left
    expect(cr.process(e)).toBe(e);
    expect(cr.promoted).toBe(0);
  });

  it("does nothing when there was no interim text pending", () => {
    const cr = new CutRepair();
    cr.process(res("", 0));
    const e = empty(true);
    expect(cr.process(e)).toBe(e);
  });

  it("the promoted final counts as a forced final: the next segment's dropped first word is still repaired", () => {
    const cr = new CutRepair();
    cr.process(res("bleeds before they ever start", 11));
    cr.process(empty(true)); // promoted; ends at 12.5
    cr.process(res("and then we", 12.8));
    const out = cr.process(natural("then we will look", 13.1));
    expect(out.text).toBe("and then we will look");
  });

  it("promotes only once: a second empty answer with no new interim is left alone", () => {
    const cr = new CutRepair();
    cr.process(res("some pending words here", 1));
    cr.process(empty(true));
    const again = empty(true);
    expect(cr.process(again)).toBe(again);
    expect(cr.promoted).toBe(4);
  });
});

