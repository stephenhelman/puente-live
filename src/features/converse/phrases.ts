import type { Lang } from "@/engine";
import data from "./phrases.json";

export interface Phrase {
  id: string;
  en: string;
  es: string;
}

export const PHRASES: Phrase[] = data.phrases;

export function phraseText(p: Phrase, lang: Lang): string {
  return p[lang];
}
