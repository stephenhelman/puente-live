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
  "the and is are was were to of in that it you for with this have has not but be what we i they he she on at as do does did can will would should could my your our their there here just so if or an us about from yes okay thanks thank hello good morning because also".split(" "),
);

const bare = (w: string) => w.toLowerCase().replace(/[.,;:!?¡¿…"'()]/g, "");

/** Stopword / accent evidence per language for a text. Accented letters count double: they are rare in English. */
export function textScores(text: string): { en: number; es: number } {
  let es = (text.match(/[ñáéíóúü¿¡]/gi) ?? []).length * 2;
  let en = 0;
  for (const w of text.split(/\s+/).map(bare)) {
    if (ES_WORDS.has(w)) es++;
    if (EN_WORDS.has(w)) en++;
  }
  return { en, es };
}

/** Text-only guess for when the vendor tagged no words. Null when it cannot tell. */
function guessFromText(text: string): Lang | null {
  const { en, es } = textScores(text);
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

const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

export type PhraseVerdict =
  | { keep: true; lang: Lang; text: string; method: "tags" | "text" | "fallback" | "inherited" }
  | { keep: false; reason: "non-latin" | "foreign-language" };

function tagCounts(words: SttWord[]) {
  let en = 0;
  let es = 0;
  let foreign = 0;
  for (const w of words) {
    if (!/\p{L}/u.test(w.word)) continue;
    const l = normalizeLang(w.language);
    if (l === "en") en++;
    else if (l === "es") es++;
    else if (w.language) foreign++;
  }
  return { en, es, foreign };
}

/**
 * Guards against phantom languages. With language=multi, Deepgram sometimes renders short fillers ("ajá", "okay",
 * "mhmm") in Telugu, Gujarati, Hebrew, Persian, Hungarian, Indonesian or Italian. `language_hint` only biases the model,
 * it does not restrict it, so the filtering has to happen here:
 *  - words in a non-Latin script are removed; nothing left means the phrase is dropped;
 *  - a phrase tagged only with languages other than en/es is dropped unless its own words are recognisably English or
 *    Spanish ("sí, cierto" tagged Indonesian is kept as Spanish);
 *  - a 1-2 word phrase whose tag disagrees with the previous phrase's language, without text evidence, inherits it.
 */
export function classifyPhrase(words: SttWord[], text: string, fallback?: Lang | null): PhraseVerdict {
  let kept = words;
  let clean = text;
  if (NON_LATIN_LETTER.test(text) || words.some((w) => NON_LATIN_LETTER.test(w.word))) {
    kept = words.filter((w) => !NON_LATIN_LETTER.test(w.word));
    clean = text
      .split(/\s+/)
      .filter((t) => !NON_LATIN_LETTER.test(t))
      .join(" ")
      .trim();
    if (!/\p{L}/u.test(clean)) return { keep: false, reason: "non-latin" };
  }
  const tags = tagCounts(kept);
  const letterWords = clean.split(/\s+/).filter((t) => /\p{L}/u.test(t)).length;
  const scores = textScores(clean);
  const confirmed = scores.en + scores.es > 0;
  if (tags.foreign > tags.en + tags.es && !confirmed) return { keep: false, reason: "foreign-language" };

  const detected = detectLang(kept, clean, fallback);
  let { lang, method } = detected;
  const guess = guessFromText(clean);
  if (letterWords <= 2 && fallback && lang !== fallback && method === "tags" && guess !== lang) {
    return { keep: true, lang: fallback, text: clean, method: "inherited" };
  }
  if (tags.foreign > tags.en + tags.es && guess) {
    lang = guess; // the vendor mislabelled it; the words themselves say which of the two it is
    method = "text";
  }
  return { keep: true, lang, text: clean, method };
}

/**
 * True when the phrase is already in `target`, so translating it would only make the model return nothing. The words
 * themselves outrank the vendor's tag: English text labelled Spanish (the tag was wrong) is still English. Needs real
 * evidence (two stopwords or accents, none from the other language) so a code-switched phrase is still translated.
 */
export function isAlreadyIn(target: Lang, words: SttWord[], text: string): boolean {
  const other: Lang = target === "en" ? "es" : "en";
  const sc = textScores(text);
  if ((sc[target] >= 2 && sc[other] === 0) || (sc[target] >= 4 && sc[other] <= 1)) return true;
  const tags = tagCounts(words);
  return tags[target] >= 1 && tags[other] === 0 && sc[other] === 0 && tags[target] + sc[target] >= 2;
}
