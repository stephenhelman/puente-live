import { afterEach, describe, expect, it, vi } from "vitest";
import { toolStream } from "@/test/fixtures";
import { ClaudeTranslator } from "./claude";
import type { TranslateStreamEvent } from "./types";

const sse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
const json = (translation: string, stop_reason = "tool_use") =>
  new Response(JSON.stringify({ model: "m", stop_reason, content: [{ type: "tool_use", input: { translation } }], usage: {} }), { status: 200 });

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
