import { afterEach, describe, expect, it, vi } from "vitest";
import { streamTranslate } from "./streamTranslate";

afterEach(() => vi.unstubAllGlobals());

function capture() {
  const fm = vi.fn().mockImplementation(async () => new Response('{"t":"done","result":{"text":"hi"}}\n', { status: 200 }));
  vi.stubGlobal("fetch", fm);
  return () => JSON.parse(fm.mock.calls[0]![1].body);
}

describe("streamTranslate request body", () => {
  it("a fixed direction carries the glossary profile (the tapped side still decides the language)", async () => {
    const body = capture();
    await streamTranslate("hola", { from: "es", to: "en", profile: "hemophilia" }, () => {});
    expect(body()).toEqual({ text: "hola", direction: { from: "es", to: "en" }, profile: "hemophilia", stream: true });
  });
  it("a fixed direction without a profile sends none (the server default applies), and no auto flag", async () => {
    const body = capture();
    await streamTranslate("hola", { from: "es", to: "en" }, () => {});
    const b = body();
    expect(b.direction).toEqual({ from: "es", to: "en" });
    expect("profile" in b && b.profile !== undefined).toBe(false);
    expect(b.auto).toBeUndefined();
  });
  it("auto mode is unchanged: the model decides, hint and profile go along", async () => {
    const body = capture();
    await streamTranslate("hola", { auto: true, hint: "es", profile: "chapter" }, () => {});
    expect(body()).toEqual({ text: "hola", auto: true, hint: "es", profile: "chapter", stream: true });
  });
});
