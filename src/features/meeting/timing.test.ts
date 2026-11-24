import { describe, expect, it } from "vitest";
import { DEFAULT_TUNING } from "@/engine";
import { computeStats, formatReport, TIMING_WINDOW, type PhraseTiming } from "./timing";

const rec = (id: number, o: Partial<PhraseTiming> = {}): PhraseTiming => ({
  id, cut: "final", words: 8, speechToEmit: 600, emitToFirst: 900, emitToDone: 1100, cacheRead: 2500, inputTokens: 60, retried: false, ...o,
});

describe("timing stats", () => {
  it("computes p50/p95/max per stage and the end-to-end sums", () => {
    const recs = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((v, i) => rec(i + 1, { speechToEmit: v, emitToFirst: v * 2, emitToDone: v * 3 }));
    const s = computeStats(recs);
    expect(s.n).toBe(10);
    expect(s.speechToEmit).toMatchObject({ n: 10, p50: 500, p95: 1000, max: 1000 });
    expect(s.emitToFirst).toMatchObject({ p50: 1000, max: 2000 });
    expect(s.emitToDone.p50).toBe(1500);
    expect(s.speechToFirst.p50).toBe(1500); // 500 + 1000
    expect(s.speechToDone.max).toBe(4000); // 1000 + 3000
  });

  it("counts phrases whose stage is not measured yet only in the stages that have a value", () => {
    const s = computeStats([rec(1), rec(2, { emitToFirst: null, emitToDone: null, cacheRead: null }), rec(3, { speechToEmit: null })]);
    expect(s.n).toBe(3);
    expect(s.speechToEmit.n).toBe(2);
    expect(s.emitToFirst.n).toBe(2);
    expect(s.speechToFirst.n).toBe(1); // needs both parts
    expect(s.cache.requests).toBe(2);
  });

  it("counts which rule cut each phrase and the cache hit rate", () => {
    const s = computeStats([rec(1, { cut: "final" }), rec(2, { cut: "pause" }), rec(3, { cut: "maxWords", cacheRead: 0 }), rec(4, { cut: "maxWords", cacheRead: 2600 })]);
    expect(s.cuts).toMatchObject({ final: 1, pause: 1, maxWords: 2, quiet: 0, maxAge: 0, hold: 0, flush: 0 });
    expect(s.cache).toMatchObject({ requests: 4, hits: 3, lastRead: 2600 });
  });

  it("an empty session is all nulls, not NaN", () => {
    const s = computeStats([]);
    expect(s.n).toBe(0);
    expect(s.speechToDone).toEqual({ n: 0, p50: null, p95: null, max: null });
    expect(formatReport({ tuning: DEFAULT_TUNING, profile: "chapter", stats: s })).not.toMatch(/NaN|undefined/);
  });

  it("keeps a rolling window of the newest phrases", () => {
    const recs = Array.from({ length: TIMING_WINDOW + 50 }, (_, i) => rec(i + 1, { speechToEmit: i < 50 ? 99_000 : 500 }));
    const s = computeStats(recs);
    expect(s.n).toBe(TIMING_WINDOW);
    expect(s.speechToEmit.max).toBe(500); // the 50 slow ones scrolled out
  });

  it("the copied report has the tuning, percentiles, cuts and cache, and never any transcript text", () => {
    const text = formatReport({
      tuning: { ...DEFAULT_TUNING, endpointingMs: 300 },
      profile: "hemophilia",
      stats: computeStats([rec(1), rec(2, { cut: "pause" })]),
      query: "ep=300&debug=1",
      now: new Date("2026-11-23T20:00:00Z"),
    });
    expect(text).toContain("2026-11-23T20:00:00.000Z");
    expect(text).toContain("url params: ep=300&debug=1");
    expect(text).toContain("tuning: ep=300 pause=450 max=28 age=8000 quiet=900 hold=2500 ctx=6");
    expect(text).toContain("glossary profile: hemophilia");
    expect(text).toMatch(/speech end -> emitted\s+0\.60s\s+0\.60s/);
    expect(text).toMatch(/emitted -> first text\s+0\.90s/);
    expect(text).toMatch(/emitted -> done\s+1\.10s/);
    expect(text).toContain("final 1 · pause 1");
    expect(text).toContain("2/2 requests read from cache");
  });
});
