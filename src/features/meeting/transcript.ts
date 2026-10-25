export type SourceId = "meeting" | "you";

export interface CaptionEntry {
  id: number;
  source: SourceId;
  /** Wall-clock ms when the phrase was finalized. */
  at: number;
  lang: "en" | "es";
  original: string;
  translation: string;
  status: "translating" | "done" | "error";
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

export function toText(entries: CaptionEntry[]): string {
  const first = entries[0]?.at ?? Date.now();
  const body = entries
    .map(
      (e) =>
        `[${clock(e.at)}] ${LABEL[e.source]} (${LANG[e.lang]})\n  ${e.original}\n  -> ${e.status === "error" ? "(not translated)" : e.translation}`,
    )
    .join("\n\n");
  return `${header(first)}\n${NOTE}\n\n${body}\n`;
}

export function toMarkdown(entries: CaptionEntry[]): string {
  const first = entries[0]?.at ?? Date.now();
  const body = entries
    .map(
      (e) =>
        `**${clock(e.at)} · ${LABEL[e.source]}** _(${LANG[e.lang]})_\n\n> ${e.original}\n\n${e.status === "error" ? "_(not translated)_" : e.translation}`,
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
