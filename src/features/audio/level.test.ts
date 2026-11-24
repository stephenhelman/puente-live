import { describe, expect, it } from "vitest";
import { meterPosition, rmsLevel } from "./level";

const pcm = (f: (i: number) => number, n = 800) => {
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = f(i);
  return a.buffer;
};

describe("level", () => {
  it("silence is 0 and a full-scale square wave is about 1", () => {
    expect(rmsLevel(pcm(() => 0))).toBe(0);
    expect(rmsLevel(pcm((i) => (i % 2 ? 32767 : -32768)))).toBeCloseTo(1, 2);
  });
  it("a sine at half scale is about 0.35 (RMS)", () => {
    expect(rmsLevel(pcm((i) => Math.sin(i / 5) * 16384))).toBeCloseTo(0.354, 1);
  });
  it("empty and odd-length buffers do not throw", () => {
    expect(rmsLevel(new ArrayBuffer(0))).toBe(0);
    expect(rmsLevel(new ArrayBuffer(3))).toBe(0);
  });
  it("the meter is empty at -60 dB, full at 0 dB, and never outside 0-1", () => {
    expect(meterPosition(0)).toBe(0);
    expect(meterPosition(0.001)).toBe(0); // -60 dB
    expect(meterPosition(1)).toBe(1);
    expect(meterPosition(0.1)).toBeCloseTo(2 / 3, 5); // -20 dB
    expect(meterPosition(5)).toBe(1);
    expect(meterPosition(NaN)).toBe(0);
  });
});
