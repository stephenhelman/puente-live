export type SourceId = "meeting" | "you";

export interface CaptionEntry {
  id: number;
  source: SourceId;
  /** Wall-clock ms when the phrase was SPOKEN (Deepgram's first-word start time), not when it was transcribed or translated. */
  at: number;
  lang: "en" | "es";
  original: string;
  translation: string;
  status: "translating" | "done" | "error";
  /**
   * already: the phrase was already in the target language, so `translation` is the original (no API call).
   * untranslated: the translator returned nothing twice, so `translation` is the original.
   */
  note?: "already" | "untranslated";
}

const TARGET_NAME = { en: "English", es: "Spanish" } as const;

/** What to print as the translation line of the transcript. Never blank. */
export function translationText(e: CaptionEntry): string {
  if (e.status === "error") return "(not translated)";
  if (e.note === "already") {
    const target = e.lang === "en" ? "es" : "en";
    return `${e.original} (already in ${TARGET_NAME[target]})`;
  }
  if (e.note === "untranslated") return `${e.original} (untranslated)`;
  return e.translation || "(not translated)";
}

/** Entries by spoken time. Stable, so same-instant phrases keep their arrival order. */
export function bySpokenTime(entries: CaptionEntry[]): CaptionEntry[] {
  return entries.map((e, i) => ({ e, i })).sort((a, b) => a.e.at - b.e.at || a.i - b.i).map((x) => x.e);
}

const LABEL: Record<SourceId, string> = { meeting: "Meeting", you: "You" };
const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const LANG = { en: "English", es: "Español" } as const;

const NOTE =
  "AI translation. Not a substitute for a qualified interpreter in clinical, legal, or consent situations. / Traducción con IA. No sustituye a un intérprete calificado en situaciones clínicas, legales o de consentimiento.";

function header(startedAt: number): string {
  return `Puente Live meeting transcript - ${new Date(startedAt).toLocaleString()}`;
}

export function toText(all: CaptionEntry[]): string {
  const entries = bySpokenTime(all);
  const first = entries[0]?.at ?? Date.now();
  const body = entries
    .map(
      (e) =>
        `[${clock(e.at)}] ${LABEL[e.source]} (${LANG[e.lang]})\n  ${e.original}\n  -> ${translationText(e)}`,
    )
    .join("\n\n");
  return `${header(first)}\n${NOTE}\n\n${body}\n`;
}

export function toMarkdown(all: CaptionEntry[]): string {
  const entries = bySpokenTime(all);
  const first = entries[0]?.at ?? Date.now();
  const body = entries
    .map(
      (e) =>
        `**${clock(e.at)} · ${LABEL[e.source]}** _(${LANG[e.lang]})_\n\n> ${e.original}\n\n${e.status === "error" ? "_(not translated)_" : translationText(e)}`,
    )
    .join("\n\n---\n\n");
  return `# ${header(first)}\n\n_${NOTE}_\n\n${body}\n`;
}

/** Generated and saved entirely in the browser. Nothing is uploaded. */
export function downloadFile(name: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function stamp(ms = Date.now()): string {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
