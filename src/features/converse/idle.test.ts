import { describe, expect, it } from "vitest";
import { DEFAULT_IDLE_SECONDS, MAX_IDLE_SECONDS, MIN_IDLE_SECONDS, parseIdleSeconds, silenceState, warnSeconds } from "./idle";

describe("?idle= (seconds of silence before a turn stops by itself)", () => {
  it("defaults to 60", () => {
    expect(DEFAULT_IDLE_SECONDS).toBe(60);
    expect(parseIdleSeconds("")).toBe(60);
    expect(parseIdleSeconds("ep=300&profile=chapter")).toBe(60);
  });
  it("reads a value and clamps it to 10-600 s; junk keeps the default; there is no 'off'", () => {
    expect(parseIdleSeconds("idle=90")).toBe(90);
    expect(parseIdleSeconds("idle=5")).toBe(MIN_IDLE_SECONDS);
    expect(parseIdleSeconds("idle=99999")).toBe(MAX_IDLE_SECONDS);
    expect(parseIdleSeconds("idle=0")).toBe(MIN_IDLE_SECONDS); // never "no limit": the microphone must not stay open for ever
    expect(parseIdleSeconds("idle=-3")).toBe(MIN_IDLE_SECONDS);
    expect(parseIdleSeconds("idle=29.6")).toBe(30);
    for (const bad of ["idle=", "idle=abc", "idle=NaN", "idle=Infinity", "idle=%20"]) expect(parseIdleSeconds(bad), bad).toBe(60);
  });
});

describe("warning window", () => {
  it("10 s before the stop; a third of a short limit", () => {
    expect(warnSeconds(60)).toBe(10);
    expect(warnSeconds(600)).toBe(10);
    expect(warnSeconds(30)).toBe(10);
    expect(warnSeconds(15)).toBe(5);
    expect(warnSeconds(10)).toBe(4);
  });
});

describe("silenceState", () => {
  const T0 = 1_000_000;
  it("starts with the full idle time and no warning", () => {
    expect(silenceState(T0, T0, 60)).toEqual({ secondsLeft: 60, warn: false, expired: false });
  });
  it("counts down in whole seconds, warns inside the last 10 s, expires at 60", () => {
    expect(silenceState(T0 + 49_900, T0, 60)).toEqual({ secondsLeft: 11, warn: false, expired: false });
    expect(silenceState(T0 + 50_000, T0, 60)).toEqual({ secondsLeft: 10, warn: true, expired: false });
    expect(silenceState(T0 + 59_999, T0, 60)).toEqual({ secondsLeft: 1, warn: true, expired: false });
    expect(silenceState(T0 + 60_000, T0, 60)).toEqual({ secondsLeft: 0, warn: false, expired: true });
    expect(silenceState(T0 + 120_000, T0, 60).expired).toBe(true);
  });
  it("speaking restarts the countdown: the warning disappears", () => {
    expect(silenceState(T0 + 55_000, T0, 60).warn).toBe(true);
    expect(silenceState(T0 + 55_000, T0 + 55_000, 60)).toEqual({ secondsLeft: 60, warn: false, expired: false });
  });
  it("a long answer is NEVER cut off: someone who speaks at least every 20 s can talk for ever", () => {
    let last = T0;
    for (let t = T0; t <= T0 + 30 * 60_000; t += 250) {
      if ((t - T0) % 20_000 === 0) last = t; // words recognised every 20 s, for 30 minutes
      expect(silenceState(t, last, 60).expired, `at ${(t - T0) / 1000}s`).toBe(false);
    }
  });
  it("the old 60 s turn limit is gone: a turn that has been going for 10 minutes is fine while words keep coming", () => {
    expect(silenceState(T0 + 600_000, T0 + 599_000, 60).expired).toBe(false);
  });
  it("respects a custom idle time", () => {
    expect(silenceState(T0 + 20_000, T0, 30)).toMatchObject({ secondsLeft: 10, warn: true });
    expect(silenceState(T0 + 30_000, T0, 30).expired).toBe(true);
  });
});
