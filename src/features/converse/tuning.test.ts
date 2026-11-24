import { afterEach, describe, expect, it, vi } from "vitest";
import { getTuning } from "@/features/converse/tuning";
import { CONVERSE_TUNING, TUNING } from "./tuning";
import { PRESENTER_TUNING } from "@/engine";

const at = (search: string) => vi.stubGlobal("window", { location: { search } });
afterEach(() => vi.unstubAllGlobals());

describe("/converse phrase boundaries", () => {
  it("defaults to the presenter values: short phrases that translate while the person keeps talking", () => {
    expect(CONVERSE_TUNING).toBe(PRESENTER_TUNING);
    at("");
    const t = getTuning(CONVERSE_TUNING);
    expect(t.segmenter).toMatchObject({ maxWords: 14, maxAgeMs: 4000, pauseMs: 350, quietMs: 600, holdMs: 1000 });
    expect(t.endpointingMs).toBe(300);
    expect(t.contextPhrases).toBe(3);
    expect(t.finalizeMs).toBe(0); // forced Finalize stays off
  });
  it("URL parameters still override each value, and the rest stay presenter values", () => {
    at("?max=20&age=6000&ep=250&ctx=2&pause=400&quiet=700&hold=1500");
    const t = getTuning(CONVERSE_TUNING);
    expect(t.segmenter).toMatchObject({ maxWords: 20, maxAgeMs: 6000, pauseMs: 400, quietMs: 700, holdMs: 1500 });
    expect(t.endpointingMs).toBe(250);
    expect(t.contextPhrases).toBe(2);
    at("?max=20");
    expect(getTuning(CONVERSE_TUNING).segmenter.quietMs).toBe(600);
  });
  it("the stock defaults used elsewhere (/meeting) are not changed by this", () => {
    at("");
    expect(getTuning()).toEqual(TUNING);
    expect(TUNING.segmenter.maxWords).toBe(28);
    expect(TUNING.contextPhrases).toBe(6);
  });
});
