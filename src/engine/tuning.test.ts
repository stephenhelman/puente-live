import { describe, expect, it } from "vitest";
import { applyTuningParams, DEFAULT_TUNING, describeTuning, TUNING_PARAMS } from "./tuning";

/** The values the app shipped with before the tuning parameters existed. If one changes, this must be a decision. */
const TODAY = {
  endpointingMs: 400,
  segmenter: { maxWords: 28, maxAgeMs: 8000, holdMs: 2500, pauseMs: 450, quietMs: 900 },
  contextPhrases: 6,
  finalizeMs: 0, // forced Finalize is OFF unless ?fin= is set
  stopTailMs: 300,
};

describe("tuning", () => {
  it("the defaults are exactly today's values", () => {
    expect(DEFAULT_TUNING).toEqual(TODAY);
  });

  it("no parameters (or only unrelated ones) resolve to the defaults", () => {
    for (const q of ["", "?", "debug=1", "profile=hemophilia&foo=3"]) expect(applyTuningParams(DEFAULT_TUNING, q)).toEqual(TODAY);
  });

  it("each parameter sets its own value and nothing else", () => {
    const set = (q: string) => applyTuningParams(DEFAULT_TUNING, q);
    expect(set("ep=300").endpointingMs).toBe(300);
    expect(set("pause=350").segmenter.pauseMs).toBe(350);
    expect(set("max=14").segmenter.maxWords).toBe(14);
    expect(set("age=4000").segmenter.maxAgeMs).toBe(4000);
    expect(set("quiet=600").segmenter.quietMs).toBe(600);
    expect(set("hold=1000").segmenter.holdMs).toBe(1000);
    expect(set("ctx=3").contextPhrases).toBe(3);
    expect(set("ctx=0").contextPhrases).toBe(0);
    expect(set("fin=3000").finalizeMs).toBe(3000);
    // one parameter leaves every other field alone
    expect(set("max=14")).toEqual({ ...TODAY, segmenter: { ...TODAY.segmenter, maxWords: 14 } });
  });

  it("the whole tuned set from the field test", () => {
    const t = applyTuningParams(DEFAULT_TUNING, "max=14&age=4000&ep=300&pause=350&quiet=600&hold=1000&ctx=3&fin=3000");
    expect(t).toEqual({
      endpointingMs: 300,
      segmenter: { maxWords: 14, maxAgeMs: 4000, holdMs: 1000, pauseMs: 350, quietMs: 600 },
      contextPhrases: 3,
      finalizeMs: 3000,
      stopTailMs: 300,
    });
    expect(describeTuning(t)).toBe("ep=300 pause=350 max=14 age=4000 quiet=600 hold=1000 fin=3000 ctx=3");
  });

  it("clamps numbers outside the range and rounds to whole numbers", () => {
    const t = applyTuningParams(DEFAULT_TUNING, "ep=5&max=9999&age=1&quiet=99999&hold=0&ctx=99&pause=449.6");
    expect(t.endpointingMs).toBe(100);
    expect(t.segmenter.maxWords).toBe(80);
    expect(t.segmenter.maxAgeMs).toBe(1000);
    expect(t.segmenter.quietMs).toBe(3000);
    expect(t.segmenter.holdMs).toBe(200);
    expect(t.contextPhrases).toBe(6);
    expect(t.segmenter.pauseMs).toBe(450);
    expect(applyTuningParams(DEFAULT_TUNING, "ctx=-4").contextPhrases).toBe(0);
  });

  it("fin: 0 (or below) means off, 1-999 clamps up to 1000, large clamps to 15000, junk is ignored", () => {
    const fin = (v: string) => applyTuningParams(DEFAULT_TUNING, `fin=${v}`).finalizeMs;
    expect(fin("0")).toBe(0);
    expect(fin("-5")).toBe(0);
    expect(fin("500")).toBe(1000);
    expect(fin("1000")).toBe(1000);
    expect(fin("3000")).toBe(3000);
    expect(fin("99999")).toBe(15_000);
    expect(fin("abc")).toBe(0);
    expect(fin("")).toBe(0);
    // turning it off explicitly beats a page default that has it on
    const on = { ...DEFAULT_TUNING, finalizeMs: 3000 };
    expect(applyTuningParams(on, "fin=0").finalizeMs).toBe(0);
    expect(applyTuningParams(on, "").finalizeMs).toBe(3000);
  });

  it("ignores junk: not a number, empty, infinite", () => {
    for (const q of ["ep=abc", "ep=", "ep=%20", "max=NaN", "age=Infinity", "quiet=--1", "hold=1e999", "ctx=three"]) {
      expect(applyTuningParams(DEFAULT_TUNING, q), q).toEqual(TODAY);
    }
    // a bad value does not stop the good ones next to it
    expect(applyTuningParams(DEFAULT_TUNING, "ep=abc&max=14").segmenter.maxWords).toBe(14);
  });

  it("never mutates the base it was given, and uses the page's own defaults as the base", () => {
    const frozen = JSON.stringify(DEFAULT_TUNING);
    applyTuningParams(DEFAULT_TUNING, "max=14&ep=300");
    expect(JSON.stringify(DEFAULT_TUNING)).toBe(frozen);
    const presenter = { ...DEFAULT_TUNING, endpointingMs: 300, segmenter: { ...DEFAULT_TUNING.segmenter, maxWords: 14 } };
    const t = applyTuningParams(presenter, "max=20");
    expect(t.endpointingMs).toBe(300); // the page default survives
    expect(t.segmenter.maxWords).toBe(20); // the URL wins over it
  });

  it("every parameter has a sane range that contains its default", () => {
    for (const p of TUNING_PARAMS) {
      expect(p.min, p.param).toBeLessThan(p.max);
      if (p.zeroIsOff) expect(p.get(DEFAULT_TUNING), p.param).toBe(0); // "off" is the default
      else {
        expect(p.get(DEFAULT_TUNING), p.param).toBeGreaterThanOrEqual(p.min);
        expect(p.get(DEFAULT_TUNING), p.param).toBeLessThanOrEqual(p.max);
      }
    }
    expect(TUNING_PARAMS.map((p) => p.param)).toEqual(["ep", "pause", "max", "age", "quiet", "hold", "fin", "ctx"]);
  });
});
