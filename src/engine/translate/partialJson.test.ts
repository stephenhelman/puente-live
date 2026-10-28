import { describe, expect, it } from "vitest";
import { JsonStringField } from "./partialJson";

const feed = (frags: string[], field = "translation") => {
  const f = new JsonStringField(field);
  return frags.map((x) => f.push(x)).join("");
};

describe("JsonStringField", () => {
  it("extracts the value across arbitrary fragment boundaries", () => {
    const json = JSON.stringify({ translation: 'Dijo "hola"\ny se fue. Café ☕ ñandú' });
    for (let size = 1; size <= 9; size++) {
      const frags = json.match(new RegExp(`.{1,${size}}`, "gs")) ?? [];
      expect(feed(frags)).toBe('Dijo "hola"\ny se fue. Café ☕ ñandú');
    }
  });
  it("stops at the closing quote and ignores other fields", () => {
    expect(feed(['{"translation":"Hi', '"}'])).toBe("Hi");
    expect(feed(['{"note":"x","translation":"Yo"}'])).toBe("Yo");
  });
  it("yields nothing for an incomplete key", () => {
    expect(feed(['{"transl'])).toBe("");
  });
});
