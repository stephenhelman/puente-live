import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepgramSttProvider } from "./deepgram";
import type { Timers } from "./timers";

/** Just enough WebSocket: opens on the next tick, records what is sent. */
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static last: FakeSocket;
  readyState = 0;
  binaryType = "";
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(public url: string, public protocols: string[]) {
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
}

afterEach(() => vi.unstubAllGlobals());

function recorder() {
  const intervals: { fn: () => void; ms: number; id: number }[] = [];
  const cleared: number[] = [];
  const timers: Timers = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: (fn, ms) => {
      const id = intervals.length + 1;
      intervals.push({ fn, ms, id });
      return id;
    },
    clearInterval: (id) => void cleared.push(id),
  };
  return { timers, intervals, cleared };
}

const start = (timers?: Timers) =>
  new DeepgramSttProvider().start({
    getToken: async () => "tok",
    sampleRate: 16000,
    endpointingMs: 400,
    keepAliveMs: 4000,
    timers,
    onResult: () => {},
    onError: () => {},
    onClose: () => {},
  });

describe("DeepgramSttProvider keep-alive", () => {
  it("runs on the injected timers, not the global setInterval (which a hidden window throttles to once a minute)", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const globalInterval = vi.spyOn(globalThis, "setInterval");
    const r = recorder();
    const s = await start(r.timers);
    expect(r.intervals).toHaveLength(1);
    expect(r.intervals[0]!.ms).toBe(2000); // half the keep-alive cadence
    expect(globalInterval).not.toHaveBeenCalled();
    s.close();
    globalInterval.mockRestore();
  });

  it("sends KeepAlive when no audio went out for keepAliveMs, and not while audio flows", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const r = recorder();
    const s = await start(r.timers);
    const ws = FakeSocket.last;
    s.sendAudio(new ArrayBuffer(10)); // audio just went out
    r.intervals[0]!.fn();
    expect(ws.sent.filter((m) => typeof m === "string")).toEqual([]);
    const realNow = performance.now.bind(performance);
    const spy = vi.spyOn(performance, "now").mockImplementation(() => realNow() + 5000); // 5 s of silence
    r.intervals[0]!.fn();
    expect(ws.sent.filter((m) => typeof m === "string")).toEqual([JSON.stringify({ type: "KeepAlive" })]);
    spy.mockRestore();
    s.close();
  });

  it("clears its timer through the injected timers when the stream closes", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const r = recorder();
    const s = await start(r.timers);
    s.close();
    expect(r.cleared).toEqual([1]);
  });

  it("falls back to the global timers when none are injected", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
    try {
      const s = await start();
      const ws = FakeSocket.last;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ws.sent.some((m) => typeof m === "string" && m.includes("KeepAlive"))).toBe(true);
      s.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
