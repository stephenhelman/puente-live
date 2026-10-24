import raw from "./glossary.json";

export interface GlossaryEntry {
  en: string;
  es: string;
  note?: string;
}

export interface Glossary {
  entries: GlossaryEntry[];
}

/** Default glossary bundled with the engine. A future admin UI can supply its own via the Translator constructor. */
export function loadDefaultGlossary(): Glossary {
  return raw as Glossary;
}

/** Renders the glossary as prompt text. Stable output so the prompt cache stays valid. */
export function formatGlossary(g: Glossary): string {
  if (g.entries.length === 0) return "(none)";
  return g.entries
    .map((e) => `- "${e.en}" <-> "${e.es}"${e.note ? ` (${e.note})` : ""}`)
    .join("\n");
}
