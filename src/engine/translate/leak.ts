/**
 * Defensive cleanup for model output. The structured-output tool already limits the model to a "translation" field, but
 * in the first field test ~15 translations had reasoning text INSIDE the translation ("Wait, the target language is...").
 * This strips those sentences, and a repeated copy of the previous phrase, and reports everything it removed.
 */

/** A sentence that can only be the model talking about its task, never meeting speech. */
const META: RegExp[] = [
  /\btarget[- ]language\b/i,
  /\b(the )?(user|system) (message|prompt|rules?|instructions?)\b/i,
  /\bsystem (prompt|rules?|instructions?)\b/i,
  /\b(only|just) (the )?new (text|phrase|part)\b/i,
  /^\s*(translating|translated|translation)\b[^.!?]{0,50}\b(only|new text|following|as requested)\b/i,
  /\bI (should|need to|must|will|'ll|am going to) (translate|output|respond|keep|note|treat|render)\b/i,
  /\b(garbled|mis-?transcri(bed|ption)|transcription (error|artifact|issue))\b/i,
  /\bthe (input|text|speaker|word|phrase|transcript) (seems|appears|might|may|probably|likely|could|is (garbled|unclear|ambiguous))\b/i,
  /\bidioma (de )?(destino|objetivo)\b/i,
  /\b(mensaje|instrucciones) del (usuario|sistema)\b/i,
  /\breglas del sistema\b/i,
  /^\s*(traduciendo|traducción)\b[^.!?]{0,50}\b(solo|sólo|únicamente|nuevo texto)\b/i,
];

/** Openers that are leaks only when they sit next to a META sentence ("Wait, ..." can be a real translation). */
const LEAD = /^\s*(wait|actually|hmm+|hold on|okay,? so|ok,? so|let me|so,? the|note:|nota:|espera|un momento|en realidad)\b/i;

const isMeta = (s: string) => META.some((r) => r.test(s));

export interface Cleaned {
  text: string;
  /** Each removed fragment, for logging. Empty when nothing was removed. */
  leaks: string[];
}

/** Sentences with their trailing whitespace kept, so rejoining restores the original spacing. */
function sentences(p: string): string[] {
  return p.match(/[^.!?:…]+(?:[.!?:…]+["')»\]]*|$)\s*/g) ?? [p];
}

function stripLeakSentences(paragraph: string, leaks: string[]): string {
  const ss = sentences(paragraph);
  const meta = ss.map(isMeta);
  if (!meta.some(Boolean)) return paragraph;
  const drop = ss.map((s, i) => meta[i] || (LEAD.test(s) && (meta[i - 1] || meta[i + 1] || false)));
  // Lead-ins chain: "Wait, ... Actually, ..." before a META sentence.
  for (let i = ss.length - 2; i >= 0; i--) if (!drop[i] && LEAD.test(ss[i]!) && drop[i + 1]) drop[i] = true;
  const kept: string[] = [];
  ss.forEach((s, i) => (drop[i] ? leaks.push(s.trim()) : kept.push(s)));
  return kept.join("").trim();
}

/** Removes meta-commentary. Returns the text unchanged (and `leaks` empty) when it is clean. */
export function stripLeaks(raw: string): Cleaned {
  const leaks: string[] = [];
  const paragraphs = raw.split(/\n+/).map((p) => stripLeakSentences(p, leaks));
  const text = paragraphs
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return { text, leaks };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Drops a copy of the previous phrase's translation from the start of this one (seen in the field when context was
 * repeated). Only when something else follows it: a speaker really can say the same thing twice.
 */
export function stripRepeatedPrefix(text: string, previous: string | undefined, leaks: string[]): string {
  const p = previous?.trim();
  if (!p || p.length < 12) return text;
  const lower = text.toLowerCase();
  const pl = p.toLowerCase().replace(/\s+/g, " ");
  const t = lower.replace(/\s+/g, " ");
  if (!t.startsWith(pl) || norm(text) === norm(p)) return text;
  // Walk the original text until the normalized prefix has been consumed.
  let i = 0;
  let consumed = 0;
  let prevSpace = false;
  while (i < text.length && consumed < pl.length) {
    const isSpace = /\s/.test(text[i]!);
    if (!(isSpace && prevSpace)) consumed++;
    prevSpace = isSpace;
    i++;
  }
  const rest = text.slice(i).replace(/^[\s,;:.\-–—]+/, "");
  if (!rest) return text;
  leaks.push(`repeat: ${p.slice(0, 80)}`);
  return rest;
}

/** The full pipeline for one finished translation. `previous` = the translation shown for the phrase just before. */
export function cleanTranslation(raw: string, previous?: string): Cleaned {
  const stripped = stripLeaks(raw);
  const text = stripRepeatedPrefix(stripped.text, previous, stripped.leaks);
  return { text, leaks: stripped.leaks };
}

const LEAD_START = /^\s*(wait|actually|hmm|ok(ay)?[, ]+so|let me|note|nota|translat|traduc|i |the (target|user|system)|espera|un momento)/i;

/**
 * Streaming guard. Text is shown as it arrives, which would flash a leak before the final cleanup replaces it. Output
 * that opens like a leak is withheld until the end (the final, cleaned text is then shown in one piece); anything else
 * passes straight through with no delay beyond the first few characters.
 */
export class LeakGuard {
  private mode: "undecided" | "pass" | "hold" = "undecided";
  private buf = "";

  /** Returns the text that may be shown now. */
  push(chunk: string): string {
    if (this.mode === "pass") return chunk;
    if (this.mode === "hold") return "";
    this.buf += chunk;
    const head = this.buf.trimStart();
    if (head.length < 9 && !/[\s,.:;!?]/.test(head.slice(-1))) return "";
    if (head.length === 0) return "";
    this.mode = LEAD_START.test(head) ? "hold" : "pass";
    if (this.mode === "hold") return "";
    const out = this.buf;
    this.buf = "";
    return out;
  }

  /** Output that ended while still undecided (very short): safe to show if it does not open like a leak. */
  flush(): string {
    if (this.mode !== "undecided") return "";
    this.mode = LEAD_START.test(this.buf.trimStart()) ? "hold" : "pass";
    if (this.mode === "hold") return "";
    const out = this.buf;
    this.buf = "";
    return out;
  }
}
