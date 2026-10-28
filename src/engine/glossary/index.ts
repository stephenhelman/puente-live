import raw from "./glossary.json";

export interface GlossaryEntry {
  en: string;
  es: string;
  note?: string;
  /** Things the speech recognizer (or a Spanish speaker saying the English word) often produces instead of this term. */
  soundsLike?: string[];
  /** Not filled in yet. Placeholders are ignored by the prompt and by the recognizer hints. */
  placeholder?: boolean;
}

export interface Glossary {
  entries: GlossaryEntry[];
}

/** Default glossary bundled with the engine. A future admin UI can supply its own via the Translator constructor. */
export function loadDefaultGlossary(): Glossary {
  return raw as Glossary;
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
 * Terms to boost in the speech recognizer (Deepgram `keyterm`). Correct spellings only, no mishearings. Deepgram caps a
 * request at 500 tokens in total, so this stays under `maxTokens` by a rough chars/3 estimate and keeps the order of the
 * glossary (most important first).
 */
export function glossaryKeyterms(g: Glossary, maxTokens = 350): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let tokens = 0;
  for (const e of g.entries.filter(isActive)) {
    for (const term of [e.en, e.es]) {
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
