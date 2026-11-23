import { describe, expect, it } from "vitest";
import { ClaudeTranslator } from "./claude";
import type { Lang } from "../types";
import type { SourceLang } from "./types";

/**
 * Live check against the real Anthropic API. Off by default (costs a few cents and needs a network):
 *   set -a; . ./.env; set +a; LIVE_ANTHROPIC=1 pnpm vitest run src/engine/translate/claude.live.test.ts
 * Asserts the direction decision (source_language + output language), not exact wording.
 */
const live = process.env.LIVE_ANTHROPIC === "1" && !!process.env.ANTHROPIC_API_KEY;

const ES = /\b(el|la|los|las|de|que|y|es|un|una|para|con|por|nada|gracias|buenos|días|tenemos|enviar|formulario|vamos|reunión|junta|hacer|favor|bienvenido)\b|[ñáéíóú¿¡]/i;
const EN = /\b(the|and|is|are|we|to|of|that|you|for|with|welcome|thanks|thank|meeting|board|need|minutes|please|send|form)\b/i;

const cases: { text: string; hint?: Lang; source: SourceLang[]; out: "es" | "en" | "same" }[] = [
  { text: "we have to send the form before Friday", hint: "es", source: ["en"], out: "es" }, // English tagged es
  { text: "necesitamos enviar el formulario antes del viernes", hint: "en", source: ["es"], out: "en" }, // Spanish tagged en
  { text: "You're welcome", hint: "en", source: ["en"], out: "es" },
  { text: "De nada", hint: "es", source: ["es"], out: "en" },
  { text: "ayer terminamos el report para la reunión con los sponsors", hint: "es", source: ["mixed", "es"], out: "en" }, // Spanish-majority mix -> English
  { text: "I told them that necesitamos más tiempo para la review of the plan", hint: "en", source: ["mixed", "en"], out: "es" }, // English-majority mix -> Spanish
  { text: "NBDC", hint: "es", source: ["en", "es", "mixed"], out: "same" },
];

describe.skipIf(!live)("live: the model decides the direction", () => {
  const tr = new ClaudeTranslator({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  for (const c of cases) {
    it(`${JSON.stringify(c.text)} (hint ${c.hint})`, async () => {
      const r = await tr.translate({ text: c.text, hint: c.hint });
      console.log(`  ${JSON.stringify(c.text)} -> [${r.sourceLang}] ${JSON.stringify(r.text)}  (${Math.round(r.latencyMs)} ms, out ${r.usage?.outputTokens}, cache read ${r.usage?.cacheReadTokens})`);
      expect(c.source).toContain(r.sourceLang);
      if (c.out === "same") expect(r.text.trim()).toBe(c.text);
      else if (c.out === "es") expect(ES.test(r.text) && !/\b(the|we|to|of|and)\b/i.test(r.text)).toBe(true);
      else expect(EN.test(r.text) && !/[ñáéíóú¿¡]/i.test(r.text)).toBe(true);
    });
  }
});
