import { afterEach, describe, expect, it, vi } from "vitest";
import { toolStream } from "@/test/fixtures";
import { ClaudeTranslator } from "./claude";
import type { TranslateStreamEvent } from "./types";

const sse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
const json = (translation: string, stop_reason = "tool_use", source_language?: string) =>
  new Response(JSON.stringify({ model: "m", stop_reason, content: [{ type: "tool_use", input: { translation, source_language } }], usage: {} }), { status: 200 });

const req = { text: "necesitamos las actas", direction: { from: "es", to: "en" } as const };
const tr = () => new ClaudeTranslator({ apiKey: "k" });

async function collect(gen: AsyncGenerator<TranslateStreamEvent>) {
  const ev: TranslateStreamEvent[] = [];
  for await (const e of gen) ev.push(e);
  return ev;
}
const done = (ev: TranslateStreamEvent[]) => {
  const d = ev.find((e) => e.type === "done");
  if (d?.type !== "done") throw new Error("no done");
  return d.result;
};

afterEach(() => vi.unstubAllGlobals());

describe("ClaudeTranslator", () => {
  it("forces the tool, states the target once and only returns the translation field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse(toolStream("We need the minutes")));
    vi.stubGlobal("fetch", fetchMock);
    const ev = await collect(tr().translateStream(req));
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.tool_choice).toEqual({ type: "tool", name: "submit_translation" });
    expect(body.max_tokens).toBeGreaterThanOrEqual(1024);
    expect(body.messages[0].content.match(/English|Spanish/g)).toHaveLength(1);
    expect(ev.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("")).toBe("We need the minutes");
    expect(done(ev).text).toBe("We need the minutes");
  });

  it("strips reasoning that leaked into the translation field and reports it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse(toolStream("Wait, the target language is English. We need the minutes."))));
    const ev = await collect(tr().translateStream(req));
    expect(done(ev).text).toBe("We need the minutes.");
    expect(done(ev).leaks?.length).toBeGreaterThan(0);
    expect(ev.some((e) => e.type === "delta")).toBe(false); // withheld, never flashed on screen
  });

  it("a stream that ends mid-translation is retried, never reported as done", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sse(toolStream("Who's going to do it? You", { cutAfter: 3 })))
      .mockResolvedValueOnce(json("Who's going to do it? You?"));
    vi.stubGlobal("fetch", fetchMock);
    const ev = await collect(tr().translateStream({ ...req, text: "¿quién lo va a hacer? tú" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(done(ev)).toMatchObject({ text: "Who's going to do it? You?", retried: true });
  });

  it("a stream with no message_stop is retried even if the JSON looks whole", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sse(toolStream("the Agu", { noStop: true }))).mockResolvedValueOnce(json("the Aguilar family"));
    vi.stubGlobal("fetch", fetchMock);
    expect(done(await collect(tr().translateStream(req))).text).toBe("the Aguilar family");
  });

  it("max_tokens is treated as truncation and retried with a bigger budget", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sse(toolStream("half a", { stopReason: "max_tokens" }))).mockResolvedValueOnce(json("a whole sentence."));
    vi.stubGlobal("fetch", fetchMock);
    const ev = await collect(tr().translateStream(req));
    expect(done(ev).text).toBe("a whole sentence.");
    const first = JSON.parse(fetchMock.mock.calls[0]![1].body).max_tokens;
    const second = JSON.parse(fetchMock.mock.calls[1]![1].body).max_tokens;
    expect(second).toBeGreaterThan(first);
  });

  it("throws when the retry is also incomplete", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => json("cut", "max_tokens")));
    await expect(tr().translate(req)).rejects.toThrow(/incomplete/);
  });

  it("removes a repeated previous translation", async () => {
    const prev = "We will vote on the budget next week.";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(`${prev} Please send questions.`)));
    const r = await tr().translate({ ...req, context: [{ source: "x", translation: prev }] });
    expect(r.text).toBe("Please send questions.");
  });
});

describe("ClaudeTranslator, auto mode (the model decides the direction)", () => {
  const auto = (text: string, hint?: "en" | "es") => ({ text, hint });
  const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, i = 0) => JSON.parse(fetchMock.mock.calls[i]![1].body);

  it("states no target language: the hint goes in its own tag and the tool asks for source_language first", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse(toolStream("tenemos que enviar el formulario", { source: "en" })));
    vi.stubGlobal("fetch", fetchMock);
    await collect(tr().translateStream(auto("we have to send the form", "es")));
    const body = bodyOf(fetchMock);
    const msg: string = body.messages[0].content;
    expect(msg).toContain("<transcriber_hint>es</transcriber_hint>");
    expect(msg).not.toContain("target_language");
    expect(Object.keys(body.tools[0].input_schema.properties)).toEqual(["source_language", "target_language", "translation"]);
    expect(body.tools[0].input_schema.required).toEqual(["source_language", "target_language", "translation"]);
    expect(body.tool_choice).toEqual({ type: "tool", name: "submit_translation" });
  });

  it("the system prompt carries the direction rules, including the courtesy-phrase and acronym cases", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse(toolStream("De nada", { source: "en" })));
    vi.stubGlobal("fetch", fetchMock);
    await collect(tr().translateStream(auto("You're welcome")));
    const sys: string = bodyOf(fetchMock).system[0].text;
    expect(sys).toMatch(/OTHER language/);
    expect(sys).toMatch(/MORE words/);
    expect(sys).toMatch(/FEWER words/);
    expect(sys).toContain('"You\'re welcome" -> "De nada"');
    expect(sys).toContain("NBDC");
    expect(sys).toMatch(/words themselves decide/);
  });

  it("English tagged es: reports source en first, then streams the Spanish", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse(toolStream("tenemos que enviar el formulario", { source: "en" }))));
    const ev = await collect(tr().translateStream(auto("we have to send the form", "es")));
    expect(ev[0]).toEqual({ type: "source", lang: "en" }); // before any text
    expect(ev.findIndex((e) => e.type === "source")).toBeLessThan(ev.findIndex((e) => e.type === "delta"));
    expect(done(ev)).toMatchObject({ text: "tenemos que enviar el formulario", sourceLang: "en" });
  });

  it("Spanish tagged en: source es, English out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse(toolStream("We need the minutes", { source: "es" }))));
    const ev = await collect(tr().translateStream(auto("necesitamos las actas", "en")));
    expect(ev[0]).toEqual({ type: "source", lang: "es" });
    expect(done(ev)).toMatchObject({ text: "We need the minutes", sourceLang: "es" });
  });

  it("You're welcome -> Spanish; mixed -> reported as mixed; NBDC unchanged is accepted", async () => {
    const run = async (text: string, out: string, source: string) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse(toolStream(out, { source }))));
      return done(await collect(tr().translateStream(auto(text))));
    };
    expect(await run("You're welcome", "De nada", "en")).toMatchObject({ text: "De nada", sourceLang: "en" });
    expect(await run("vamos a hacer el meeting con el board", "we are going to hold the meeting with the board", "mixed")).toMatchObject({ sourceLang: "mixed" });
    expect(await run("NBDC", "NBDC", "en")).toMatchObject({ text: "NBDC" });
  });

  it("leak guard still applies in auto mode and source is still reported", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse(toolStream("Wait, the target language is English. We need the minutes.", { source: "es" }))));
    const ev = await collect(tr().translateStream(auto("necesitamos las actas")));
    expect(done(ev)).toMatchObject({ text: "We need the minutes.", sourceLang: "es" });
    expect(ev.some((e) => e.type === "delta")).toBe(false);
  });

  it("a cut-off stream is retried (non-streaming) and the retry's source_language is used", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sse(toolStream("Who's going", { source: "es", cutAfter: 5 })))
      .mockResolvedValueOnce(json("Who's going to do it?", "tool_use", "es"));
    vi.stubGlobal("fetch", fetchMock);
    const ev = await collect(tr().translateStream(auto("¿quién lo va a hacer?")));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(done(ev)).toMatchObject({ text: "Who's going to do it?", sourceLang: "es", retried: true });
  });

  it("an invalid source_language is ignored, not fatal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json("hola", "tool_use", "klingon")));
    const r = await tr().translate(auto("hello"));
    expect(r).toMatchObject({ text: "hola" });
    expect(r.sourceLang).toBeUndefined();
  });

  it("fixed-direction mode (converse) is unchanged: old tool, target_language, no source event", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse(toolStream("We need the minutes")));
    vi.stubGlobal("fetch", fetchMock);
    const ev = await collect(tr().translateStream(req));
    const body = bodyOf(fetchMock);
    expect(Object.keys(body.tools[0].input_schema.properties)).toEqual(["translation"]);
    expect(body.messages[0].content).toContain("<target_language>English</target_language>");
    expect(ev.some((e) => e.type === "source")).toBe(false);
    expect(done(ev).sourceLang).toBeUndefined();
  });
});

describe("ClaudeTranslator, glossary profiles", () => {
  const sys = (fm: ReturnType<typeof vi.fn>, i = 0): string => JSON.parse(fm.mock.calls[i]![1].body).system[0].text;

  it("sends the profile's own system prompt; no profile means chapter; the two never mix", async () => {
    const fm = vi.fn().mockImplementation(async () => sse(toolStream("x", { source: "en" })));
    vi.stubGlobal("fetch", fm);
    const t = tr();
    await collect(t.translateStream({ text: "hello", hint: "en" }));
    await collect(t.translateStream({ text: "hello", hint: "en", profile: "chapter" }));
    await collect(t.translateStream({ text: "hello", hint: "en", profile: "hemophilia" }));
    expect(sys(fm, 0)).toBe(sys(fm, 1)); // default = chapter, identical text so the cache entry is shared
    expect(sys(fm, 0)).toContain("bylaws");
    expect(sys(fm, 0)).not.toContain("Hemlibra");
    expect(sys(fm, 2)).toContain("Hemlibra");
    expect(sys(fm, 2)).toContain("hem libra");
    expect(sys(fm, 2)).not.toContain("estatutos");
    expect(sys(fm, 2)).not.toContain("bylaws");
  });

  it("fixed-direction requests honor the profile too, and keep cache_control on the system block", async () => {
    const fm = vi.fn().mockResolvedValue(sse(toolStream("x")));
    vi.stubGlobal("fetch", fm);
    await collect(tr().translateStream({ ...req, profile: "hemophilia" }));
    const body = JSON.parse(fm.mock.calls[0]![1].body);
    expect(body.system[0].text).toContain("Hemlibra");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("an explicit glossary option still overrides every profile", async () => {
    const fm = vi.fn().mockResolvedValue(sse(toolStream("x", { source: "en" })));
    vi.stubGlobal("fetch", fm);
    const t = new ClaudeTranslator({ apiKey: "k", glossary: { entries: [{ en: "zebra", es: "cebra" }] } });
    await collect(t.translateStream({ text: "hi", hint: "en", profile: "hemophilia" }));
    expect(sys(fm)).toContain("zebra");
    expect(sys(fm)).not.toContain("Hemlibra");
  });
});

describe("ClaudeTranslator, usage for the debug readout", () => {
  it("the done event carries the token usage, including cache reads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse(toolStream("hola", { source: "en", cacheRead: 2664 }))));
    const ev = await collect(tr().translateStream({ text: "hello", hint: "en" }));
    expect(done(ev).usage).toMatchObject({ inputTokens: 10, cacheReadTokens: 2664, outputTokens: 5 });
  });
});
