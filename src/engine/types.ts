/** Languages the engine supports in v1. */
export type Lang = "en" | "es";

export interface Direction {
  from: Lang;
  to: Lang;
}

export const EN_TO_ES: Direction = { from: "en", to: "es" };
export const ES_TO_EN: Direction = { from: "es", to: "en" };

export function otherLang(l: Lang): Lang {
  return l === "en" ? "es" : "en";
}
