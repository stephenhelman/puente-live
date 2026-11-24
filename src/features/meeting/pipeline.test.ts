import { describe, expect, it, vi } from "vitest";
import { CaptionPipeline, type PhraseInput, type TranslateCall, type TranslateFn } from "./pipeline";
import { toText, type CaptionEntry } from "./transcript";

const phrase = (text: string, over: Partial<PhraseInput> = {}): PhraseInput => ({
  source: "meeting", lang: "es", text, spokenAt: 1_000, ...over,
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

  it("never passes a phrase through: an already-in-target hint still goes to the model, which decides the direction", async () => {
    const m = manual();
    const events: string[] = [];
    const p = new CaptionPipeline({ translate: m.fn }, { onChange: () => {}, onEvent: (e) => events.push(e.kind) });
    // Deepgram tagged this English sentence "es", and the word-list heuristic fired. Both are only hints.
    p.add(phrase("we have to send the form", { lang: "es", alreadyHint: true }));
    await tick();
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.call.hint).toBe("es");
    m.calls[0]!.call.onSource("en");
    m.calls[0]!.resolve("tenemos que enviar el formulario");
    await p.idle();
    expect(events).toContain("already-hint");
    expect(p.entries[0]).toMatchObject({ lang: "en", mixed: false, translation: "tenemos que enviar el formulario", status: "done" });
    expect(p.entries[0]!.note).toBeUndefined();
  });

  it("takes the language tag from the model: Spanish tagged en becomes es", async () => {
    const m = manual();
    const p = new CaptionPipeline({ translate: m.fn }, { onChange: () => {} });
    p.add(phrase("necesitamos las actas", { lang: "en" }));
    await tick();
    m.calls[0]!.call.onSource("es");
    m.calls[0]!.resolve("we need the minutes");
    await p.idle();
    expect(p.entries[0]).toMatchObject({ lang: "es", translation: "we need the minutes" });
  });

  it("mixed keeps the recognizer's majority as the tag and flags the entry", async () => {
    const m = manual();
    const p = new CaptionPipeline({ translate: m.fn }, { onChange: () => {} });
    p.add(phrase("vamos a hacer el meeting con el board", { lang: "es" }));
    await tick();
    m.calls[0]!.call.onSource("mixed");
    m.calls[0]!.resolve("we are going to hold the meeting with the board");
    await p.idle();
    expect(p.entries[0]).toMatchObject({ lang: "es", mixed: true });
  });

  it("counts a translation identical to the original (debug only; it is still shown)", async () => {
    const m = manual();
    const events: string[] = [];
    const p = new CaptionPipeline({ translate: m.fn }, { onChange: () => {}, onEvent: (e) => events.push(e.kind) });
    p.add(phrase("NBDC", { lang: "en" }));
    await tick();
    m.calls[0]!.resolve("NBDC");
    await p.idle();
    expect(events).toContain("unchanged");
    expect(p.entries[0]).toMatchObject({ translation: "NBDC", status: "done" });
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
    // Fake timers: the stall deadline is crossed by advancing the clock, not by racing real time.
    vi.useFakeTimers();
    try {
      const m = manual();
      const p = new CaptionPipeline({ translate: m.fn, stallMs: 30 }, { onChange: () => {} });
      p.add(phrase("lenta"));
      p.add(phrase("rápida"));
      await vi.advanceTimersByTimeAsync(0);
      expect(m.calls).toHaveLength(2);
      m.calls[1]!.resolve("fast");
      await vi.advanceTimersByTimeAsync(29);
      expect(m.calls).toHaveLength(2); // not stalled yet
      await vi.advanceTimersByTimeAsync(1); // 30 ms with no progress: abandoned, retried
      expect(m.calls[0]!.call.signal.aborted).toBe(true);
      expect(m.calls).toHaveLength(3); // the retry of "lenta"
      expect(p.entries[1]!.translation).toBe("fast");
      m.calls[2]!.resolve("slow");
      await p.idle();
      expect(p.entries[0]!.translation).toBe("slow");
    } finally {
      vi.useRealTimers();
    }
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

describe("translation context size (?ctx=)", () => {
  async function withHistory(contextPhrases?: number) {
    const m = manual();
    const p = new CaptionPipeline({ translate: m.fn, contextPhrases }, { onChange: () => {} });
    for (const t of ["uno", "dos", "tres", "cuatro"]) {
      p.add(phrase(t));
      await tick();
      m.calls[m.calls.length - 1]!.resolve(`${t}!`);
      await p.idle();
    }
    return { m, p };
  }
  const last = (m: ReturnType<typeof manual>) => m.calls[m.calls.length - 1]!.call.context;

  it("defaults to 6 earlier phrases", async () => {
    const { m, p } = await withHistory();
    p.add(phrase("cinco"));
    await tick();
    expect(last(m).map((c) => c.source)).toEqual(["uno", "dos", "tres", "cuatro"]);
  });

  it("ctx=2 sends only the last two; ctx=0 sends none (not everything)", async () => {
    const { m, p } = await withHistory(2);
    p.add(phrase("cinco"));
    await tick();
    expect(last(m).map((c) => c.source)).toEqual(["tres", "cuatro"]);
    p.setContextPhrases(0);
    p.add(phrase("seis"));
    await tick();
    expect(last(m)).toEqual([]);
    p.setContextPhrases(1);
    p.add(phrase("siete"));
    await tick();
    expect(last(m).map((c) => c.source)).toEqual(["seis"]);
  });

  it("hands the request's token usage to the finished callback", async () => {
    const usage = { inputTokens: 40, outputTokens: 20, cacheReadTokens: 2500, cacheWriteTokens: 0 };
    const fn: TranslateFn = async (c) => {
      c.onText("hi");
      c.onResult({ usage });
      return "hi!";
    };
    const p = new CaptionPipeline({ translate: fn }, { onChange: () => {} });
    const done = vi.fn();
    p.add(phrase("hola"), undefined, done);
    await p.idle();
    expect(done).toHaveBeenCalledWith({ usage });
  });
});

describe("discardInFlight (pause)", () => {
  it("aborts every request in flight and removes the phrases still being translated; finished captions stay", async () => {
    const m = manual();
    const p = new CaptionPipeline({ translate: m.fn }, { onChange: () => {} });
    p.add(phrase("uno"));
    await tick();
    m.calls[0]!.resolve("one");
    await p.idle();
    p.add(phrase("dos"));
    p.add(phrase("tres"));
    await tick();
    m.calls[1]!.call.onText("tw"); // half translated
    p.discardInFlight();
    expect(m.calls[1]!.call.signal.aborted).toBe(true);
    expect(m.calls[2]!.call.signal.aborted).toBe(true);
    expect(p.entries.map((e) => [e.original, e.translation, e.status])).toEqual([["uno", "one", "done"]]);
  });

  it("a late answer for a discarded phrase never comes back", async () => {
    const m = manual();
    const events: string[] = [];
    const p = new CaptionPipeline({ translate: m.fn }, { onChange: () => {}, onEvent: (e) => events.push(e.kind) });
    p.add(phrase("dos"));
    await tick();
    p.discardInFlight();
    m.calls[0]!.resolve("two"); // the abort already rejected it; resolving later changes nothing
    await p.idle();
    expect(p.entries).toEqual([]);
    expect(events).not.toContain("done");
    expect(events).not.toContain("retry"); // an abort is not a failure to retry
  });

  it("new phrases after the pause translate normally", async () => {
    const m = manual();
    const p = new CaptionPipeline({ translate: m.fn }, { onChange: () => {} });
    p.add(phrase("dos"));
    await tick();
    p.discardInFlight();
    p.add(phrase("tres"));
    await tick();
    m.calls[1]!.resolve("three");
    await p.idle();
    expect(p.entries.map((e) => [e.original, e.translation])).toEqual([["tres", "three"]]);
  });
});

describe("transcript", () => {
  it("never prints a blank translation and orders by spoken time", () => {
    const base: CaptionEntry = { id: 1, source: "meeting", at: 2_000, lang: "es", original: "dos", translation: "", status: "translating" };
    const entries: CaptionEntry[] = [
      base,
      { ...base, id: 2, at: 1_000, original: "uno", translation: "we need it", status: "done" },
      { ...base, id: 3, at: 3_000, original: "ajá", translation: "ajá", note: "untranslated", status: "done" },
    ];
    const text = toText(entries);
    expect(text.indexOf("uno")).toBeLessThan(text.indexOf("dos"));
    expect(text).toContain("-> we need it");
    expect(text).toContain("ajá (untranslated)");
    expect(text).toMatch(/dos\n {2}-> \(not translated\)/);
  });
});
