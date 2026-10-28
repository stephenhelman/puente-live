import { describe, expect, it } from "vitest";
import { LEAK_FIXTURES } from "@/test/fixtures";
import { LeakGuard, cleanTranslation, stripLeaks, stripRepeatedPrefix } from "./leak";

describe("leak filter", () => {
  for (const [i, f] of LEAK_FIXTURES.entries()) {
    it(`strips reasoning pattern #${i + 1} and reports it`, () => {
      const r = stripLeaks(f.raw);
      expect(r.text).toBe(f.clean);
      expect(r.leaks.length).toBeGreaterThan(0);
    });
  }

  it("leaves clean translations alone, including a real 'Wait,'", () => {
    for (const t of ["Wait, let me check the form.", "Vamos a votar el lunes.", "Who is going to do it? You?"]) {
      const r = stripLeaks(t);
      expect(r.text).toBe(t);
      expect(r.leaks).toEqual([]);
    }
  });

  it("does not treat ordinary meeting talk about translating as a leak", () => {
    const t = "We need to translate the flyer into Spanish.";
    expect(stripLeaks(t).text).toBe(t);
  });

  it("returns empty text when everything was commentary", () => {
    expect(stripLeaks("Wait, the target language is English.").text).toBe("");
  });

  it("strips a copy of the previous translation from the start", () => {
    const leaks: string[] = [];
    const prev = "We will vote on the budget next week.";
    const out = stripRepeatedPrefix(`${prev} Please send your questions by email.`, prev, leaks);
    expect(out).toBe("Please send your questions by email.");
    expect(leaks[0]).toMatch(/^repeat:/);
  });

  it("keeps a phrase that is only a genuine repeat", () => {
    const prev = "We will vote on the budget next week.";
    expect(stripRepeatedPrefix(prev, prev, [])).toBe(prev);
  });

  it("cleanTranslation combines both", () => {
    const prev = "Gracias por estar aquí hoy.";
    const r = cleanTranslation(`Translating only the new text: ${prev} Empecemos con las actas.`, prev);
    expect(r.text).toBe("Empecemos con las actas.");
    expect(r.leaks.length).toBe(2);
  });
});

describe("LeakGuard (streaming)", () => {
  const run = (chunks: string[]) => {
    const g = new LeakGuard();
    return chunks.map((c) => g.push(c)).join("") + g.flush();
  };
  it("passes normal text through, with only the first few characters delayed", () => {
    expect(run(["Vamos ", "a ", "empezar."])).toBe("Vamos a empezar.");
    const g = new LeakGuard();
    expect(g.push("Va")).toBe("");
    expect(g.push("mos a")).toBe("");
    expect(g.push(" ver")).toBe("Vamos a ver");
    expect(g.push(" todo")).toBe(" todo");
  });
  it("withholds output that opens like reasoning", () => {
    expect(run(["Wa", "it, the target", " language is English. Hello."])).toBe("");
    expect(run(["Translating ", "only the new text: Hola"])).toBe("");
  });
  it("shows very short text", () => {
    expect(run(["Sí."])).toBe("Sí.");
  });
});
