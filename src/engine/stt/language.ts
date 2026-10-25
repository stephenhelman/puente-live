import { EN_TO_ES, ES_TO_EN, type Direction, type Lang } from "../types";
import type { SttWord } from "./types";

/** "en", "en-US" -> "en"; "es", "es-419" -> "es"; anything else (other languages, undefined) -> null. */
export function normalizeLang(tag: string | undefined): Lang | null {
  const base = tag?.toLowerCase().split(/[-_]/)[0];
  return base === "en" || base === "es" ? base : null;
}

const ES_WORDS = new Set(
  "el la los las un una unos unas de del que y en es son por con para no sí se lo le les como más pero su sus al muy está están estoy estamos bueno buenas buenos gracias hola días tardes noches yo tú usted nosotros qué cómo cuándo dónde porque también ya hay tengo tiene tenemos vamos voy va ser hacer puede pueden quiero necesito mi mis nuestro nuestra esto eso esta este".split(" "),
);
const EN_WORDS = new Set(
  "the and is are was were to of in that it you for with this have has not but be what we i they he she on at as do does did can will would should could my your our their there here just so if or an a me us about from yes no okay thanks thank hello good morning because also".split(" "),
);

const bare = (w: string) => w.toLowerCase().replace(/[.,;:!?¡¿…"'()]/g, "");

/** Text-only guess for when the vendor tagged no words. Null when it cannot tell. */
function guessFromText(text: string): Lang | null {
  let es = (text.match(/[ñáéíóúü¿¡]/gi) ?? []).length * 2;
  let en = 0;
  for (const w of text.split(/\s+/).map(bare)) {
    if (ES_WORDS.has(w)) es++;
    if (EN_WORDS.has(w)) en++;
  }
  return es === en ? null : es > en ? "es" : "en";
}

/**
 * Which language a phrase is in: the majority of the vendor's per-word tags (Deepgram language=multi), counting only
 * English and Spanish words. Used to pick the translation direction in continuous mode, where no one tells us who is
 * speaking. Falls back to a stopword guess, then to `fallback` (typically the previous phrase from the same source),
 * then English. Very short phrases are the weak spot: a lone "ok" or a name carries almost no signal.
 */
export function detectLang(words: SttWord[], text: string, fallback?: Lang | null): { lang: Lang; method: "tags" | "text" | "fallback" } {
  let en = 0;
  let es = 0;
  for (const w of words) {
    if (!/\p{L}/u.test(w.word)) continue;
    const l = normalizeLang(w.language);
    if (l === "en") en++;
    else if (l === "es") es++;
  }
  if (en !== es) return { lang: en > es ? "en" : "es", method: "tags" };
  const guess = guessFromText(text);
  if (guess) return { lang: guess, method: "text" };
  return { lang: fallback ?? "en", method: "fallback" };
}

/** English-majority -> translate to Spanish; Spanish-majority -> translate to English. */
export function directionFor(lang: Lang): Direction {
  return lang === "en" ? EN_TO_ES : ES_TO_EN;
}
