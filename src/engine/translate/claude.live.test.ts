import { describe, expect, it } from "vitest";
import { ClaudeTranslator } from "./claude";
import type { Lang } from "../types";
import type { GlossaryProfile } from "../glossary";
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

/**
 * Hemophilia profile: the glossary terms must come out right, including misheard ones. `must` = every pattern has to
 * appear in the output (case-insensitive); `mustNot` = none may.
 */
const hemo: { text: string; hint: Lang; source: SourceLang; must: RegExp[]; mustNot?: RegExp[] }[] = [
  { text: "People with hemophilia A need factor VIII infusions as prophylaxis", hint: "en", source: "en", must: [/hemofilia A/i, /factor VIII/i, /infusion|infusiones/i, /profilaxis/i] },
  { text: "Una inyección de factor ocho puede detener un sangrado articular", hint: "es", source: "es", must: [/factor VIII/i, /joint bleed|bleed/i] },
  { text: "he mo feelia is an inherited bleeding disorder", hint: "es", source: "en", must: [/hemofilia/i], mustNot: [/he mo/i] }, // misheard + wrong hint
  { text: "My son takes hem libra every week", hint: "en", source: "en", must: [/Hemlibra/], mustNot: [/hem libra/i, /\blibra\b/i] },
  { text: "El emicizumab ayuda a prevenir los sangrados en personas con inhibidores", hint: "es", source: "es", must: [/emicizumab/i, /inhibitors?/i, /bleed/i] },
  { text: "Talk to your hematologist at the hemophilia treatment center about the inhibitor test", hint: "en", source: "en", must: [/hematólogo/i, /centro de tratamiento de hemofilia/i, /inhibidor/i] },
  { text: "She is a carrier and her port was placed last year", hint: "en", source: "en", must: [/portadora/i, /puerto|catéter/i] },
  { text: "Please approve the minutes from the last meeting", hint: "en", source: "en", must: [/minutas|actas|reuni/i] }, // control: ordinary sentence still translates
];

describe.skipIf(!live)("live: the hemophilia profile", () => {
  const tr = new ClaudeTranslator({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  const profile: GlossaryProfile = "hemophilia";
  for (const c of hemo) {
    it(`${JSON.stringify(c.text)} (hint ${c.hint})`, async () => {
      const r = await tr.translate({ text: c.text, hint: c.hint, profile });
      console.log(`  ${JSON.stringify(c.text)} -> [${r.sourceLang}] ${JSON.stringify(r.text)}`);
      expect(r.sourceLang).toBe(c.source);
      for (const m of c.must) expect(r.text).toMatch(m);
      for (const m of c.mustNot ?? []) expect(r.text).not.toMatch(m);
    });
  }
});
