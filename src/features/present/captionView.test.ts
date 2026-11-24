import { describe, expect, it } from "vitest";
import type { CaptionEntry } from "@/features/meeting/transcript";
import { buildCaptionView, guessLang, isCaptionLive, KEEP_PHRASES, ORIGINAL_MAX_CHARS, tailText } from "./captionView";

const entry = (id: number, o: Partial<CaptionEntry> = {}): CaptionEntry => ({
  id, source: "meeting", at: id * 1000, lang: "en", original: `original ${id}`, translation: `traducción ${id}`, status: "done", ...o,
});

describe("buildCaptionView", () => {
  it("shows the translation in the OTHER language, tagged where the language changes", () => {
    const v = buildCaptionView([entry(1), entry(2), entry(3, { lang: "es", original: "hola", translation: "hello" }), entry(4, { lang: "es", translation: "hello again" })], "");
    expect(v.lines.map((l) => [l.text, l.lang, l.tag])).toEqual([
      ["traducción 1", "es", true], // first line is tagged
      ["traducción 2", "es", false],
      ["hello", "en", true], // the language changed
      ["hello again", "en", false],
    ]);
  });

  it("the small line is the live interim when there is one (shown at once), else what the newest caption came from", () => {
    const live = buildCaptionView([entry(1)], "we are going to talk about the infusion schedule today");
    expect(live.original).toMatchObject({ text: "we are going to talk about the infusion schedule today", lang: "en" });
    const idle = buildCaptionView([entry(1, { original: "gracias a todos por venir", lang: "es" })], "");
    expect(idle.original).toEqual({ text: "gracias a todos por venir", lang: "es" });
    expect(buildCaptionView([], "").original).toBeNull();
  });

  it("the interim appears before any translation exists (nothing translated yet)", () => {
    const v = buildCaptionView([entry(1, { translation: "", status: "translating" })], "good morning everyone");
    expect(v.lines).toEqual([]);
    expect(v.original?.text).toBe("good morning everyone");
  });

  it("the small line does not vanish between a phrase leaving the segmenter and its first translated word", () => {
    // seen in a real run: interim shown, phrase emitted (interim cleared), ~1 s before the first translated text: the strip blanked
    const v = buildCaptionView([entry(1, { original: "we are going to talk about prophylaxis", translation: "", status: "translating" })], "");
    expect(v.lines).toEqual([]);
    expect(v.original).toEqual({ text: "we are going to talk about prophylaxis", lang: "en" });
  });

  it("but an errored phrase never keeps the small line alive", () => {
    expect(buildCaptionView([entry(1, { status: "error", translation: "" })], "").original).toBeNull();
  });

  it("a phrase that is still streaming shows its partial translation", () => {
    const v = buildCaptionView([entry(1, { translation: "Buenos días a to", status: "translating" })], "");
    expect(v.lines[0]).toMatchObject({ text: "Buenos días a to" });
  });

  it("NEVER shows a failure: errored and 'untranslated' phrases are skipped, not drawn, not replaced by an error", () => {
    const v = buildCaptionView(
      [entry(1), entry(2, { status: "error", translation: "" }), entry(3, { note: "untranslated", translation: "original 3" }), entry(4)],
      "",
    );
    expect(v.lines.map((l) => l.text)).toEqual(["traducción 1", "traducción 4"]);
    const text = JSON.stringify(v).toLowerCase();
    for (const word of ["error", "failed", "untranslated", "retry", "reconnect", "offline", "signed"]) expect(text).not.toContain(word);
  });

  it("keeps only the newest phrases", () => {
    const many = Array.from({ length: 20 }, (_, i) => entry(i + 1));
    const v = buildCaptionView(many, "");
    expect(v.lines).toHaveLength(KEEP_PHRASES);
    expect(v.lines[v.lines.length - 1]!.text).toBe("traducción 20");
  });

  it("a long interim shows only its end, from a word boundary", () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const t = tailText(long);
    expect(t.length).toBeLessThanOrEqual(ORIGINAL_MAX_CHARS + 2);
    expect(t.startsWith("… ")).toBe(true);
    expect(t.endsWith("word79")).toBe(true);
    expect(tailText("short text")).toBe("short text");
  });

  it("guesses the language of an interim by stopwords and accents; unknown when unsure", () => {
    expect(guessLang("we are going to the meeting")).toBe("en");
    expect(guessLang("vamos a la reunión con los niños")).toBe("es");
    expect(guessLang("Hemlibra")).toBeNull();
  });
});

describe("clearing after silence", () => {
  it("stays live inside the window, goes dark after it, and 0 means never", () => {
    expect(isCaptionLive(5_999, 0, 6)).toBe(true);
    expect(isCaptionLive(6_000, 0, 6)).toBe(false);
    expect(isCaptionLive(10_000_000, 0, 0)).toBe(true);
  });
});
