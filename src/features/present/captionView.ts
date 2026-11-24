import { textScores, type Lang } from "@/engine";
import type { CaptionEntry } from "@/features/meeting/transcript";

export interface ViewLine {
  id: number;
  text: string;
  /** The language the text is IN (the translation's language, not the speaker's). */
  lang: Lang;
  /** Show the small EN/ES tag before this phrase (the first one, and wherever the language changes). */
  tag: boolean;
}

export interface CaptionView {
  /** Translation phrases, oldest first. The strip is bottom-anchored, so older ones scroll out of the top. */
  lines: ViewLine[];
  /** The small line: what is being said right now (interim), else what the newest caption was translated from. */
  original: { text: string; lang: Lang | null } | null;
}

/** How many of the newest phrases are rendered (the CSS clips the strip to its line count). */
export const KEEP_PHRASES = 6;
/** The small original line shows at most this many trailing characters of a long interim. */
export const ORIGINAL_MAX_CHARS = 150;

const other = (l: Lang): Lang => (l === "en" ? "es" : "en");

/** The end of a long text, starting at a word boundary, with an ellipsis. */
export function tailText(text: string, max = ORIGINAL_MAX_CHARS): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(t.length - max);
  const sp = cut.indexOf(" ");
  return "… " + (sp >= 0 && sp < 20 ? cut.slice(sp + 1) : cut);
}

/** English or Spanish by stopwords and accents; null when it cannot tell (a name, one word). */
export function guessLang(text: string): Lang | null {
  const { en, es } = textScores(text);
  return es === en ? null : es > en ? "es" : "en";
}

/**
 * What the broadcast shows. It is built ONLY from captions and the live interim: there is no input for an error, a status or
 * a debug value, so none can ever be drawn. A phrase whose translation failed (or came back empty twice) is skipped entirely
 * instead of being shown as an error or as untranslated text in the wrong language.
 */
export function buildCaptionView(entries: CaptionEntry[], tail: string, keep = KEEP_PHRASES): CaptionView {
  const shown = entries.filter((e) => e.status !== "error" && e.note !== "untranslated");
  const lines: ViewLine[] = [];
  for (const e of shown.slice(-keep)) {
    const text = e.translation.trim();
    if (!text) continue; // not started streaming yet
    const lang = other(e.lang);
    lines.push({ id: e.id, text, lang, tag: lines.length === 0 || lines[lines.length - 1]!.lang !== lang });
  }
  const live = tail.trim();
  if (live) return { lines, original: { text: tailText(live), lang: guessLang(live) } };
  // No interim pending: keep the newest caption's source visible, INCLUDING while its translation has not produced a first word
  // yet (a phrase has just left the segmenter). Without this the small line, and so the whole strip, went blank for ~1 s.
  const last = shown[shown.length - 1];
  if (last) return { lines, original: { text: tailText(last.original), lang: last.lang } };
  return { lines, original: null };
}

/** True while there is something on screen that should stay: activity (speech or a caption change) within `clearSec`. 0 = never clear. */
export function isCaptionLive(now: number, lastActivityAt: number, clearSec: number): boolean {
  if (clearSec <= 0) return true;
  return now - lastActivityAt < clearSec * 1000;
}
