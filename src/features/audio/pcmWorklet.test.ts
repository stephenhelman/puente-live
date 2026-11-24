import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Loads public/pcm-worklet.js with just enough of the AudioWorklet globals to run its process() in Node. */
function load(): { process(inputs: Float32Array[][]): boolean; posted: Int16Array[] } {
  const posted: Int16Array[] = [];
  class AudioWorkletProcessor {
    port = { postMessage: (buf: ArrayBuffer) => void posted.push(new Int16Array(buf)) };
  }
  let Ctor: new () => { process(i: Float32Array[][]): boolean };
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", readFileSync("public/pcm-worklet.js", "utf8"))(
    AudioWorkletProcessor,
    (_name: string, c: typeof Ctor) => (Ctor = c),
    16000, // the context already runs at 16 kHz here, so one input sample = one output sample
  );
  const node = new Ctor!();
  return { process: (i) => node.process(i), posted };
}

const block = (v: number) => new Float32Array(128).fill(v);
/** Feed 128-sample blocks until the worklet posts its first ~50 ms chunk (800 samples). */
function run(channels: number[]) {
  const w = load();
  for (let i = 0; i < 7; i++) w.process([channels.map(block)]);
  return w.posted[0]!;
}

describe("pcm-worklet channel handling", () => {
  it("mono is passed through unchanged", () => {
    const out = run([0.5]);
    expect(out.length).toBeGreaterThanOrEqual(800); // posted once 800+ samples are ready (7 blocks of 128 = 896)
    expect(Math.abs(out[10]! / 0x7fff - 0.5)).toBeLessThan(0.001);
  });

  it("stereo is averaged: audio panned hard to ONE side is no longer lost (a virtual cable is 2-channel)", () => {
    const left = run([0.6, 0]);
    expect(Math.abs(left[10]! / 0x7fff - 0.3)).toBeLessThan(0.001);
    const right = run([0, 0.6]);
    expect(Math.abs(right[10]! / 0x7fff - 0.3)).toBeLessThan(0.001);
  });

  it("identical channels (the usual case) give the same level as mono", () => {
    expect(Math.abs(run([0.4, 0.4])[10]! - run([0.4])[10]!)).toBeLessThanOrEqual(1);
  });

  it("opposite channels cancel, as an average should", () => {
    expect(Math.abs(run([0.5, -0.5])[10]!)).toBeLessThanOrEqual(1);
  });

  it("no input yet is not an error", () => {
    const w = load();
    expect(w.process([[]])).toBe(true);
    expect(w.process([])).toBe(true);
  });
});
