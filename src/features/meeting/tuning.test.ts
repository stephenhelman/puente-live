import { afterEach, describe, expect, it, vi } from "vitest";
import { getTuning, TUNING } from "@/features/converse/tuning";
import { getMeetingTuning, getProfile, MAX_SESSION_MINUTES } from "./tuning";

const at = (search: string) => vi.stubGlobal("window", { location: { search } });
afterEach(() => vi.unstubAllGlobals());

const TODAY_PHRASES = {
  endpointingMs: 400,
  segmenter: { maxWords: 28, maxAgeMs: 8000, holdMs: 2500, pauseMs: 450, quietMs: 900 },
  contextPhrases: 6,
  finalizeMs: 0,
  stopTailMs: 300,
};

describe("/converse and /meeting defaults are unchanged", () => {
  it("/converse with no parameters resolves to today's tuning", () => {
    at("");
    expect(getTuning()).toEqual(TODAY_PHRASES);
    expect(TUNING).toEqual(TODAY_PHRASES);
  });

  it("/meeting with no parameters resolves to today's tuning plus the 3 h session cap and 10 min warning", () => {
    at("");
    expect(getMeetingTuning()).toEqual({ ...TODAY_PHRASES, maxSessionMs: 180 * 60_000, warnAtMs: 170 * 60_000 });
    expect(MAX_SESSION_MINUTES).toBe(180);
  });

  it("forced Finalize is off on /meeting and /converse unless ?fin= is given", () => {
    at("");
    expect(getTuning().finalizeMs).toBe(0);
    expect(getMeetingTuning().finalizeMs).toBe(0);
    at("?ep=300&max=14&age=4000&quiet=600&hold=1000&ctx=3"); // the presenter values alone do not turn it on
    expect(getMeetingTuning().finalizeMs).toBe(0);
    at("?fin=3000");
    expect(getMeetingTuning().finalizeMs).toBe(3000);
    expect(getTuning().finalizeMs).toBe(3000);
  });

  it("the existing ?ep= and ?pause= still work on both pages", () => {
    at("?ep=300&pause=350");
    for (const t of [getTuning(), getMeetingTuning()]) {
      expect(t.endpointingMs).toBe(300);
      expect(t.segmenter.pauseMs).toBe(350);
      expect(t.segmenter.maxWords).toBe(28);
    }
  });

  it("the new parameters reach /meeting; ?max= is now max WORDS and the session length moved to ?mins=", () => {
    at("?max=14&age=4000&quiet=600&hold=1000&ctx=3&fin=3000&mins=60");
    const t = getMeetingTuning();
    expect(t.segmenter).toMatchObject({ maxWords: 14, maxAgeMs: 4000, quietMs: 600, holdMs: 1000 });
    expect(t.contextPhrases).toBe(3);
    expect(t.finalizeMs).toBe(3000);
    expect(t.maxSessionMs).toBe(60 * 60_000);
    at("?max=14");
    expect(getMeetingTuning().maxSessionMs).toBe(180 * 60_000); // ?max= no longer touches the session cap
    at("?mins=0&mins2=5");
    expect(getMeetingTuning().maxSessionMs).toBe(180 * 60_000); // out-of-range session length is ignored
    at("?mins=abc");
    expect(getMeetingTuning().maxSessionMs).toBe(180 * 60_000);
  });

  it("a page can pass its own defaults, and the URL still overrides them", () => {
    at("?max=20");
    const presenter = { ...TODAY_PHRASES, endpointingMs: 300, segmenter: { ...TODAY_PHRASES.segmenter, maxWords: 14, quietMs: 600 } };
    const t = getMeetingTuning(presenter);
    expect(t.endpointingMs).toBe(300);
    expect(t.segmenter.quietMs).toBe(600);
    expect(t.segmenter.maxWords).toBe(20);
  });

  it("the glossary profile override ignores unknown names", () => {
    at("?profile=hemophilia");
    expect(getProfile()).toBe("hemophilia");
    at("?profile=admin");
    expect(getProfile()).toBe("chapter");
    expect(getProfile("hemophilia")).toBe("hemophilia");
  });
});
