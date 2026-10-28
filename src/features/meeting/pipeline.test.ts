import { describe, expect, it, vi } from "vitest";
import { CaptionPipeline, type PhraseInput, type TranslateCall, type TranslateFn } from "./pipeline";
import { toText, type CaptionEntry } from "./transcript";

const phrase = (text: string, over: Partial<PhraseInput> = {}): PhraseInput => ({
  source: "meeting", lang: "es", text, spokenAt: 1_000, alreadyInTarget: false, ...over,
});

/** A translate function whose requests the test resolves by hand. */
function manual() {
  const calls: { call: TranslateCall; resolve: (t: string) => void; reject: (e: Error) => void }[] = [];
  const fn: TranslateFn = (call) =>
    new Promise((resolve, reject) => {
      calls.push({ call, resolve, reject });
      call.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  return { calls, fn };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("caption pipeline", () => {
  it("translates in parallel; a slow request does not block later phrases and order never changes", async () => {
    const m = manual();
    const p = new CaptionPipeline({ translate: m.fn }, { onChange: () => {} });
    p.add(phrase("uno"));
    p.add(phrase("dos"));
    p.add(phrase("tres"));
    await tick();
    expect(m.calls).toHaveLength(3); // all started without waiting for the first
    m.calls[2]!.resolve("three");
    m.calls[1]!.resolve("two");
    await tick();
    expect(p.entries.map((e) => [e.original, e.translation, e.status])).toEqual([
      ["uno", "", "translating"],
      ["dos", "two", "done"],
      ["tres", "three", "done"],
    ]);
    m.calls[0]!.resolve("one");
    await p.idle();
    expect(p.entries.map((e) => e.translation)).toEqual(["one", "two", "three"]);
  });

  it("a new phrase never aborts an earlier in-flight translation", async () => {
    const m = manual();
    const p = new CaptionPipeline({ translate: m.fn }, { onChange: () => {} });
    p.add(phrase("primera frase larga"));
    await tick();
    m.calls[0]!.call.onText("The first long");
    p.add(phrase("segunda"));
    await tick();
    expect(m.calls[0]!.call.signal.aborted).toBe(false);
    m.calls[0]!.resolve("The first long phrase");
    m.calls[1]!.resolve("second");
    await p.idle();
    expect(p.entries[0]!.translation).toBe("The first long phrase");
  });

  it("keeps the spoken time, not the time the translation finished", async () => {
    const m = manual();
    const p = new CaptionPipeline({ translate: m.fn }, { onChange: () => {} });
    p.add(phrase("a", { spokenAt: 5_000 }));
    p.add(phrase("b", { spokenAt: 9_000 }));
    await tick();
    m.calls[1]!.resolve("b!");
    m.calls[0]!.resolve("a!");
    await p.idle();
    expect(p.entries.map((e) => e.at)).toEqual([5_000, 9_000]);
  });

  it("passes an already-in-target phrase through with no API call", async () => {
    const fn = vi.fn<TranslateFn>();
    const p = new CaptionPipeline({ translate: fn }, { onChange: () => {} });
    p.add(phrase("we have to send the form", { lang: "es", alreadyInTarget: true }));
    await p.idle();
    expect(fn).not.toHaveBeenCalled();
    expect(p.entries[0]).toMatchObject({ translation: "we have to send the form", status: "done", note: "already" });
  });

  it("retries an empty translation once, then shows the original marked untranslated", async () => {
    const fn = vi.fn<TranslateFn>().mockResolvedValue("  ");
    const p = new CaptionPipeline({ translate: fn }, { onChange: () => {} });
    p.add(phrase("ajá"));
    await p.idle();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(p.entries[0]).toMatchObject({ translation: "ajá", status: "done", note: "untranslated" });
  });

  it("an empty first answer followed by a real one is shown normally", async () => {
    const fn = vi.fn<TranslateFn>().mockResolvedValueOnce("").mockResolvedValueOnce("uh-huh");
    const p = new CaptionPipeline({ translate: fn }, { onChange: () => {} });
    p.add(phrase("ajá"));
    await p.idle();
    expect(p.entries[0]).toMatchObject({ translation: "uh-huh", status: "done" });
    expect(p.entries[0]!.note).toBeUndefined();
  });

  it("retries a failed request once, then marks the slot as an error (original stays visible)", async () => {
    const fn = vi.fn<TranslateFn>().mockRejectedValue(new Error("boom"));
    const p = new CaptionPipeline({ translate: fn }, { onChange: () => {} });
    p.add(phrase("hola"));
    await p.idle();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(p.entries[0]).toMatchObject({ status: "error", original: "hola" });
  });

  it("abandons a stalled request and retries without blocking others", async () => {
    const m = manual();
    const p = new CaptionPipeline({ translate: m.fn, stallMs: 30 }, { onChange: () => {} });
    p.add(phrase("lenta"));
    p.add(phrase("rápida"));
    await tick();
    m.calls[1]!.resolve("fast");
    await new Promise((r) => setTimeout(r, 60));
    expect(m.calls.length).toBe(3); // the retry of "lenta"
    expect(p.entries[1]!.translation).toBe("fast");
    m.calls[2]!.resolve("slow");
    await p.idle();
    expect(p.entries[0]!.translation).toBe("slow");
  });

  it("sends earlier phrases from the same source as context only", async () => {
    const m = manual();
    const p = new CaptionPipeline({ translate: m.fn }, { onChange: () => {} });
    p.add(phrase("hola a todos"));
    await tick();
    m.calls[0]!.resolve("hello everyone");
    await p.idle();
    p.add(phrase("gracias"));
    await tick();
    expect(m.calls[1]!.call.text).toBe("gracias");
    expect(m.calls[1]!.call.context).toEqual([{ source: "hola a todos", translation: "hello everyone" }]);
  });
});

describe("transcript", () => {
  it("never prints a blank translation and orders by spoken time", () => {
    const base: CaptionEntry = { id: 1, source: "meeting", at: 2_000, lang: "es", original: "dos", translation: "", status: "translating" };
    const entries: CaptionEntry[] = [
      base,
      { ...base, id: 2, at: 1_000, original: "uno", translation: "we need it", note: "already", status: "done" },
      { ...base, id: 3, at: 3_000, original: "ajá", translation: "ajá", note: "untranslated", status: "done" },
    ];
    const text = toText(entries);
    expect(text.indexOf("uno")).toBeLessThan(text.indexOf("dos"));
    expect(text).toContain("uno (already in English)");
    expect(text).toContain("ajá (untranslated)");
    expect(text).toMatch(/dos\n {2}-> \(not translated\)/);
  });
});
