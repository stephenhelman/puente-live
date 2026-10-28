import { describe, expect, it } from "vitest";
import { words } from "@/test/fixtures";
import { classifyPhrase, isAlreadyIn } from "./language";

describe("phantom-language filter", () => {
  it("drops fillers rendered in non-Latin scripts", () => {
    for (const t of ["అజా", "અજા", "אהא", "آها"]) {
      expect(classifyPhrase(words(t, "te"), t, "es")).toEqual({ keep: false, reason: "non-latin" });
    }
  });
  it("removes a stray non-Latin word but keeps the rest", () => {
    const v = classifyPhrase(words("vamos అజా a empezar", "es"), "vamos అజా a empezar", "es");
    expect(v).toMatchObject({ keep: true, lang: "es", text: "vamos a empezar" });
  });
  it("drops short fillers tagged with other Latin-script languages", () => {
    for (const [t, l] of [["mhmm", "hu"], ["aha", "id"], ["ehm", "it"]] as const) {
      expect(classifyPhrase(words(t, l), t, "en")).toEqual({ keep: false, reason: "foreign-language" });
    }
  });
  it("keeps a foreign-tagged phrase whose words are plainly English or Spanish", () => {
    expect(classifyPhrase(words("sí, cierto", "id"), "sí, cierto", "en")).toMatchObject({ keep: true, lang: "es" });
    expect(classifyPhrase(words("okay", "it"), "okay", "es")).toMatchObject({ keep: true, lang: "en" });
  });
  it("lets a 1-2 word segment inherit the surrounding language", () => {
    expect(classifyPhrase(words("mm-hm", "es"), "mm-hm", "en")).toMatchObject({ keep: true, lang: "en", method: "inherited" });
  });
  it("leaves ordinary English and Spanish alone", () => {
    expect(classifyPhrase(words("we need the form by friday", "en"), "we need the form by friday", "es")).toMatchObject({ keep: true, lang: "en" });
    expect(classifyPhrase(words("necesitamos el formulario para el viernes", "es"), "necesitamos el formulario para el viernes", "en")).toMatchObject({ keep: true, lang: "es" });
  });
});

describe("already-in-target passthrough", () => {
  it("English text tagged Spanish is already English", () => {
    const t = "we have to send the form to the board";
    expect(isAlreadyIn("en", words(t, "es"), t)).toBe(true);
  });
  it("ordinary Spanish labelled English is already Spanish", () => {
    const t = "sí, vamos a revisar los estatutos";
    expect(isAlreadyIn("es", words(t, "en"), t)).toBe(true);
  });
  it("a code-switched phrase still gets translated", () => {
    const t = "vamos a hacer el meeting with the board";
    expect(isAlreadyIn("en", words(t), t)).toBe(false);
    expect(isAlreadyIn("es", words(t), t)).toBe(false);
  });
  it("a phrase in the other language is not passed through", () => {
    const t = "we have to send the form to the board";
    expect(isAlreadyIn("es", words(t, "en"), t)).toBe(false);
  });
  it("a lone ambiguous word is not passed through", () => {
    expect(isAlreadyIn("en", words("Sanofi", "en"), "Sanofi")).toBe(false);
  });
});
