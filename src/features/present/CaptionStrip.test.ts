import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CaptionEntry } from "@/features/meeting/transcript";
import CaptionStrip from "./CaptionStrip";
import { buildCaptionView } from "./captionView";

const entry = (id: number, o: Partial<CaptionEntry> = {}): CaptionEntry => ({
  id, source: "meeting", at: id, lang: "en", original: `original ${id}`, translation: `traducción ${id}`, status: "done", ...o,
});
const html = (entries: CaptionEntry[], tail = "") => renderToStaticMarkup(createElement(CaptionStrip, { view: buildCaptionView(entries, tail) }));
const text = (h: string) => h.replace(/<[^>]+>/g, "|").replace(/\|+/g, " ").replace(/&nbsp;| /g, " ").replace(/\s+/g, " ").trim();

describe("the caption area", () => {
  it("renders captions with lang attributes and small EN/ES tags, the original smaller above the translation", () => {
    const h = html([entry(1), entry(2, { lang: "es", original: "hola a todos", translation: "hello everyone" })], "");
    expect(h).toContain('lang="es"'); // the Spanish translation of the English phrase
    expect(h).toContain('lang="en"'); // the English translation of the Spanish phrase
    expect(text(h)).toContain("ES traducción 1");
    expect(text(h)).toContain("EN hello everyone");
    expect(h.indexOf("hola a todos")).toBeLessThan(h.indexOf("traducción 1")); // original line first
  });

  it("shows the interim original immediately, even with no translation yet", () => {
    const h = html([], "good morning everyone");
    expect(text(h)).toContain("good morning everyone");
    expect(text(h)).toContain("EN");
  });

  it("empty: the same structure with no text (so the fixed-height area is identical when nothing is said)", () => {
    const empty = html([], "");
    const busy = html([entry(1)], "something being said");
    const shape = (h: string) => h.match(/<(section|p|div)\b/g)?.join("");
    expect(shape(empty)).toBe(shape(busy));
    expect(text(empty)).toBe("");
  });

  it("failed or untranslated phrases leave NO trace: no error text, no original in the wrong place", () => {
    const h = html([entry(1, { status: "error", translation: "" }), entry(2, { note: "untranslated", translation: "original 2" })], "");
    expect(text(h)).toBe("");
  });

  it("never contains words an operator error would have", () => {
    const h = html([entry(1), entry(2, { status: "error", translation: "" })], "talking").toLowerCase();
    for (const w of ["error", "failed", "retry", "offline", "reconnect", "signed", "no audio", "paused", "debug"]) expect(h).not.toContain(w);
  });
});

describe("guard: nothing but the view can reach the caption area", () => {
  const strip = readFileSync("src/features/present/CaptionStrip.tsx", "utf8");
  const client = readFileSync("src/features/present/PresentClient.tsx", "utf8");

  it("CaptionStrip takes exactly one prop, the view, and imports nothing that could hold state or errors", () => {
    expect(strip).toMatch(/export default function CaptionStrip\(\{ view \}: \{ view: CaptionView \}\)/);
    const imports = [...strip.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./captionView", "./present.module.css", "react"].sort());
  });

  it("PresentClient hands the strip only `view`; state, status and errors go only to Controls", () => {
    expect(client).toMatch(/<CaptionStrip view=\{view\} \/>/);
    expect(client).toMatch(/<Controls ctrl=\{ctrl\} state=\{state\} params=\{p\} \/>/);
    // `view` is built from the entries and the tail only
    expect(client).toMatch(/buildCaptionView\(state\.entries, state\.tail\)/);
  });
});
