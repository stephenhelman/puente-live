import chapter from "./profiles/chapter.json";
import hemophilia from "./profiles/hemophilia.json";

export interface GlossaryEntry {
  en: string;
  es: string;
  note?: string;
  /** Things the speech recognizer (or a Spanish speaker saying the English word) often produces instead of this term. */
  soundsLike?: string[];
  /** Not filled in yet. Placeholders are ignored by the prompt and by the recognizer hints. */
  placeholder?: boolean;
  /**
   * Medical entries start as `reviewed: false`: a clinician should check them before a public event. Informational
   * only, nothing is blocked on it. See the README ("Glossary profiles").
   */
  reviewed?: boolean;
  /**
   * What to send the speech recognizer for this entry instead of the default [en, es]: the spellings (or spoken forms,
   * e.g. "factor eight") worth boosting. An empty list sends nothing, for everyday words that would only distort
   * recognition ("bleed", "port").
   */
  keyterms?: string[];
}

export interface Glossary {
  /** Where the terms apply, in the prompt's words ("chapter business, taxes, ..."). Default: the chapter wording. */
  context?: string;
  entries: GlossaryEntry[];
}

/** Each profile has its own entries, its own recognizer keyterms and its own cached system prompt. */
export const GLOSSARY_PROFILES = ["chapter", "hemophilia"] as const;
export type GlossaryProfile = (typeof GLOSSARY_PROFILES)[number];
export const DEFAULT_PROFILE: GlossaryProfile = "chapter";

const BUNDLED: Record<GlossaryProfile, Glossary> = { chapter, hemophilia } as Record<GlossaryProfile, Glossary>;

/** Validates a name from a URL or request body. Null for anything that is not a known profile. */
export function parseProfile(v: unknown): GlossaryProfile | null {
  return typeof v === "string" && (GLOSSARY_PROFILES as readonly string[]).includes(v) ? (v as GlossaryProfile) : null;
}

export function loadGlossary(profile: GlossaryProfile = DEFAULT_PROFILE): Glossary {
  return BUNDLED[profile];
}

/** The chapter profile. A future admin UI can supply its own glossary via the Translator constructor. */
export function loadDefaultGlossary(): Glossary {
  return BUNDLED[DEFAULT_PROFILE];
}

const DEFAULT_CONTEXT = "chapter business, taxes, mail, finances, governance";
/** The "where do these terms apply" wording the prompt uses. The chapter text is unchanged from before profiles. */
export function glossaryContext(g: Glossary): string {
  return g.context ?? DEFAULT_CONTEXT;
}

const isActive = (e: GlossaryEntry) => !e.placeholder && !/^\[.*\]$/.test(e.en.trim());

/** Renders the glossary as prompt text. Stable output so the prompt cache stays valid. */
export function formatGlossary(g: Glossary): string {
  const entries = g.entries.filter(isActive);
  if (entries.length === 0) return "(none)";
  return entries
    .map((e) => {
      const same = e.en.toLowerCase() === e.es.toLowerCase();
      const head = same ? `- "${e.en}" (keep as is)` : `- "${e.en}" <-> "${e.es}"`;
      const note = e.note ? ` (${e.note})` : "";
      const heard = e.soundsLike?.length ? ` | often heard as: ${e.soundsLike.map((s) => `"${s}"`).join(", ")}` : "";
      return head + note + heard;
    })
    .join("\n");
}

/**
 * Terms to boost in the speech recognizer (Deepgram `keyterm`). Correct spellings only, no mishearings (an entry may name
 * its own list in `keyterms`, e.g. the spoken "factor eight"; an empty list opts the entry out). Deepgram caps a
 * request at 500 tokens in total, so this stays under `maxTokens` by a rough chars/3 estimate and keeps the order of the
 * glossary (most important first).
 */
/** Rough Deepgram token cost of a keyterm list (chars/3 + 1 each), the same estimate glossaryKeyterms enforces. */
export function keytermTokens(terms: string[]): number {
  return terms.reduce((n, t) => n + Math.ceil(t.length / 3) + 1, 0);
}

/** Our own cap, under Deepgram's hard limit of 500 tokens per request (the estimate is rough, so keep a margin). */
export const KEYTERM_SELF_CAP = 350;

export function glossaryKeyterms(g: Glossary, maxTokens = KEYTERM_SELF_CAP): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let tokens = 0;
  for (const e of g.entries.filter(isActive)) {
    for (const term of e.keyterms ?? [e.en, e.es]) {
      const t = term.trim();
      const k = t.toLowerCase();
      if (!t || seen.has(k)) continue;
      const cost = Math.ceil(t.length / 3) + 1;
      if (tokens + cost > maxTokens) return out;
      seen.add(k);
      tokens += cost;
      out.push(t);
    }
  }
  return out;
}
