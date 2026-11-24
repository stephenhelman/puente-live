import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TUNING } from "@/engine";
import type { AudioInputInfo } from "@/features/audio/inputDevice";
import type { DisposableTimers } from "@/features/audio/workerTimers";
import type { CaptionSourceOptions, PhraseEvent } from "@/features/meeting/captionSource";
import type { TranslateCall, TranslateFn } from "@/features/meeting/pipeline";
import { authLost } from "@/lib/nav";
import { PresentController, RETRY_AFTER_END_MS, RETRY_AFTER_FAILURE_MS, type PresentConfig, type SourceLike } from "./controller";
import { PRESENT_DEFAULTS, PRESENTER_TUNING, type PresentParams } from "./params";

// --- fakes -----------------------------------------------------------------------------------------------------------

/** Manual clock + timers: nothing fires until `advance`. */
function clock() {
  let now = 1_000_000;
  let id = 1;
  const pending = new Map<number, { at: number; fn: () => void; every?: number }>();
  const timers: DisposableTimers = {
    setTimeout: (fn, ms) => (pending.set(id, { at: now + ms, fn }), id++),
    setInterval: (fn, ms) => (pending.set(id, { at: now + ms, fn, every: ms }), id++),
    clearTimeout: (i) => void pending.delete(i),
    clearInterval: (i) => void pending.delete(i),
    dispose: () => pending.clear(),
  };
  return {
    timers,
    now: () => now,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [i, t] = due;
        now = t.at;
        if (t.every) t.at += t.every;
        else pending.delete(i);
        t.fn();
      }
      now = end;
    },
  };
}

class FakeSource implements SourceLike {
  paused = false;
  discards = 0;
  stopped = false;
  started = false;
  constructor(readonly o: CaptionSourceOptions) {}
  start = vi.fn(async () => void (this.started = true));
  stop = vi.fn(async () => void (this.stopped = true));
  setPaused = (p: boolean) => void (this.paused = p);
  discard = () => void this.discards++;
}

const stream = (label: string) => ({ getAudioTracks: () => [{ label }], getTracks: () => [{ stop() {} }] }) as unknown as MediaStream;
const dev = (deviceId: string, label: string): AudioInputInfo => ({ deviceId, label });
const MIC = dev("mic1", "MacBook Pro Microphone");
const CABLE = dev("cab1", "BlackHole 2ch");

function rig(over: { params?: Partial<PresentParams>; devices?: AudioInputInfo[] | (() => Promise<AudioInputInfo[]>); saved?: string | null } = {}) {
  const c = clock();
  const sources: FakeSource[] = [];
  const calls: { call: TranslateCall; resolve: (t: string) => void }[] = [];
  const translate: TranslateFn = (call) =>
    new Promise((resolve, reject) => {
      calls.push({ call, resolve });
      call.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const opened: string[] = [];
  const saved: { id: string | null } = { id: over.saved ?? null };
  const list = over.devices ?? [MIC, CABLE];
  const cfg: PresentConfig = {
    params: { ...PRESENT_DEFAULTS, device: "blackhole", ...over.params },
    tuning: PRESENTER_TUNING,
    profile: "hemophilia",
  };
  const ctrl = new PresentController(cfg, {
    listInputs: typeof list === "function" ? list : async () => list,
    openInput: async (id) => (opened.push(id), stream(id === "cab1" ? "BlackHole 2ch" : "MacBook Pro Microphone")),
    createSource: (o) => {
      const s = new FakeSource(o);
      sources.push(s);
      return s;
    },
    createTimers: () => c.timers,
    translate,
    loadSaved: () => saved.id,
    saveDevice: (id) => void (saved.id = id),
    now: c.now,
  });
  const phrase = (text: string, lang: "en" | "es" = "en", over: Partial<PhraseEvent> = {}): PhraseEvent => ({
    source: "meeting", text, lang, cut: "final", emittedAtLocal: 0, spokenAt: c.now(), alreadyHint: false, ...over,
  });
  return { ctrl, c, sources, calls, opened, saved, phrase, last: () => sources[sources.length - 1]! };
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// --- tests -----------------------------------------------------------------------------------------------------------

describe("auto-start", () => {
  it("starts listening by itself on the input whose name matches ?device=, with the presenter tuning and the hemophilia keyterms", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    expect(r.opened).toEqual(["cab1"]); // BlackHole, not the microphone
    expect(r.sources).toHaveLength(1);
    const o = r.last().o;
    expect(o.id).toBe("meeting");
    expect(o.tuning.segmenter).toMatchObject({ maxWords: 14, maxAgeMs: 4000, quietMs: 600 });
    expect(o.tuning.finalizeMs).toBe(0); // forced Finalize is off by default
    expect(o.keyterms).toEqual(expect.arrayContaining(["hemophilia", "Hemlibra"]));
    expect(r.last().start).toHaveBeenCalled();
    const s = r.ctrl.getSnapshot();
    expect(s).toMatchObject({ source: "live", starting: false, deviceMissing: false, deviceLabel: "BlackHole 2ch", paused: false });
    await r.ctrl.dispose();
  });

  it("one stream only: no second source is ever created while one is running", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    await r.ctrl.attempt();
    await r.ctrl.attempt();
    expect(r.sources).toHaveLength(1);
    await r.ctrl.dispose();
  });

  it("with no ?device=, uses the input remembered from an earlier pick", async () => {
    const r = rig({ params: { device: "" }, saved: "cab1" });
    r.ctrl.start();
    await settle();
    expect(r.opened).toEqual(["cab1"]);
    await r.ctrl.dispose();
  });

  it("with ?device= that matches nothing, it does NOT fall back to the remembered input (that could be a microphone)", async () => {
    const r = rig({ params: { device: "vb-cable" }, saved: "mic1" });
    r.ctrl.start();
    await settle();
    expect(r.opened).toEqual([]);
    expect(r.sources).toEqual([]);
    expect(r.ctrl.getSnapshot()).toMatchObject({ deviceMissing: true, source: "off", starting: false });
    expect(r.ctrl.getSnapshot().devices.map((d) => d.label)).toEqual(["MacBook Pro Microphone", "BlackHole 2ch"]);
    await r.ctrl.dispose();
  });

  it("with no name and nothing remembered, shows the list; picking one starts it and remembers it", async () => {
    const r = rig({ params: { device: "" } });
    r.ctrl.start();
    await settle();
    expect(r.ctrl.getSnapshot().deviceMissing).toBe(true);
    await r.ctrl.selectDevice("cab1");
    r.c.advance(1000);
    await settle();
    expect(r.saved.id).toBe("cab1");
    expect(r.opened).toEqual(["cab1"]);
    expect(r.ctrl.getSnapshot()).toMatchObject({ deviceMissing: false, source: "live" });
    await r.ctrl.dispose();
  });

  it("when the input appears later (cable started after the page), it picks it up on the next retry", async () => {
    let list: AudioInputInfo[] = [MIC];
    const r = rig({ devices: async () => list });
    r.ctrl.start();
    await settle();
    expect(r.ctrl.getSnapshot().deviceMissing).toBe(true);
    list = [MIC, CABLE];
    r.c.advance(RETRY_AFTER_FAILURE_MS);
    await settle();
    expect(r.ctrl.getSnapshot()).toMatchObject({ deviceMissing: false, source: "live" });
    await r.ctrl.dispose();
  });

  it("unlabelled inputs (an embedded browser that hides names) cannot match: the list is shown instead of guessing", async () => {
    const r = rig({ devices: [dev("x1", ""), dev("x2", "")] });
    r.ctrl.start();
    await settle();
    expect(r.ctrl.getSnapshot().deviceMissing).toBe(true);
    expect(r.opened).toEqual([]);
    await r.ctrl.dispose();
  });
});

describe("restarting", () => {
  it("retries after the first connection fails", async () => {
    const r = rig();
    let first = true;
    const orig = r.ctrl as unknown as { deps: { createSource: (o: CaptionSourceOptions) => SourceLike } };
    const make = orig.deps.createSource;
    orig.deps.createSource = (o) => {
      const s = make(o) as FakeSource;
      if (first) {
        first = false;
        s.start.mockRejectedValueOnce(new Error("token"));
      }
      return s;
    };
    r.ctrl.start();
    await settle();
    expect(r.ctrl.getSnapshot().source).toBe("failed");
    expect(r.sources[0]!.stop).toHaveBeenCalled();
    r.c.advance(RETRY_AFTER_FAILURE_MS);
    await settle();
    expect(r.sources).toHaveLength(2);
    expect(r.ctrl.getSnapshot().source).toBe("live");
    await r.ctrl.dispose();
  });

  it("starts over after the speech socket gives up, and after the input disappears (cable unplugged)", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    r.sources[0]!.o.onStatus("meeting", "failed");
    await settle();
    expect(r.sources[0]!.stop).toHaveBeenCalled();
    r.c.advance(RETRY_AFTER_FAILURE_MS);
    await settle();
    expect(r.sources).toHaveLength(2);
    r.sources[1]!.o.onStatus("meeting", "ended");
    await settle();
    r.c.advance(RETRY_AFTER_END_MS);
    await settle();
    expect(r.sources).toHaveLength(3);
    expect(r.ctrl.getSnapshot().source).toBe("live");
    await r.ctrl.dispose();
  });

  it("a late callback from a replaced source is ignored", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    const old = r.sources[0]!;
    old.o.onStatus("meeting", "failed");
    await settle();
    r.c.advance(RETRY_AFTER_FAILURE_MS);
    await settle();
    old.o.onPhrase(r.phrase("a ghost from the old source"));
    old.o.onTail("meeting", "ghost interim");
    expect(r.calls).toHaveLength(0);
    expect(r.ctrl.getSnapshot().tail).toBe("");
    await r.ctrl.dispose();
  });

  it("a restart while paused stays paused", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    r.ctrl.pause();
    r.sources[0]!.o.onStatus("meeting", "failed");
    await settle();
    r.c.advance(RETRY_AFTER_FAILURE_MS);
    await settle();
    expect(r.sources).toHaveLength(2);
    expect(r.sources[1]!.paused).toBe(true);
    await r.ctrl.dispose();
  });
});

describe("captions", () => {
  it("a phrase is translated (hemophilia profile, model decides the direction) and shown; the transcript keeps it", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    r.last().o.onPhrase(r.phrase("good morning everyone"));
    await settle();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.call).toMatchObject({ text: "good morning everyone", hint: "en", profile: "hemophilia" });
    r.calls[0]!.call.onText("Buenos días a todos");
    expect(r.ctrl.getSnapshot().entries[0]).toMatchObject({ translation: "Buenos días a todos", status: "translating" });
    r.calls[0]!.resolve("Buenos días a todos.");
    await settle();
    expect(r.ctrl.getSnapshot().entries[0]).toMatchObject({ status: "done" });
    expect(r.ctrl.transcript().map((e) => e.translation)).toEqual(["Buenos días a todos."]);
    expect(r.ctrl.getSnapshot().transcriptSize).toBe(1);
    await r.ctrl.dispose();
  });

  it("the live interim is exposed immediately, before any translation", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    r.last().o.onTail("meeting", "we are going to talk about prophylaxis");
    expect(r.ctrl.getSnapshot().tail).toBe("we are going to talk about prophylaxis");
    await r.ctrl.dispose();
  });

  it("blanks the screen after the silence window (6 s default) but never touches the transcript", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    r.last().o.onPhrase(r.phrase("good morning everyone"));
    await settle();
    r.calls[0]!.resolve("Buenos días a todos");
    await settle();
    r.c.advance(5_000);
    expect(r.ctrl.getSnapshot().entries).toHaveLength(1); // still inside the window
    r.c.advance(1_500);
    expect(r.ctrl.getSnapshot().entries).toEqual([]);
    expect(r.ctrl.getSnapshot().tail).toBe("");
    expect(r.ctrl.transcript()).toHaveLength(1);
    await r.ctrl.dispose();
  });

  it("new speech keeps the captions alive, and clear=0 means never blank", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    r.last().o.onPhrase(r.phrase("first phrase of the talk"));
    await settle();
    r.calls[0]!.resolve("Primera frase de la charla");
    await settle();
    for (let i = 0; i < 5; i++) {
      r.c.advance(4_000);
      r.last().o.onTail("meeting", `still talking ${i}`); // a new interim every 4 s
    }
    expect(r.ctrl.getSnapshot().entries).toHaveLength(1);
    await r.ctrl.dispose();
    const never = rig({ params: { clearSec: 0 } });
    never.ctrl.start();
    await settle();
    never.last().o.onPhrase(never.phrase("first phrase of the talk"));
    await settle();
    never.calls[0]!.resolve("Primera frase");
    await settle();
    never.c.advance(600_000);
    expect(never.ctrl.getSnapshot().entries).toHaveLength(1);
    await never.ctrl.dispose();
  });

  it("Clear wipes the screen and the buffered words now, keeps listening and keeps the transcript", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    r.last().o.onPhrase(r.phrase("good morning everyone"));
    await settle();
    r.calls[0]!.resolve("Buenos días a todos");
    await settle();
    r.last().o.onTail("meeting", "and now the agenda");
    r.ctrl.clear();
    expect(r.ctrl.getSnapshot()).toMatchObject({ entries: [], tail: "", source: "live" });
    expect(r.last().discards).toBe(1);
    expect(r.ctrl.transcript()).toHaveLength(1);
    await r.ctrl.dispose();
  });
});

describe("pause", () => {
  it("stops the source's audio, aborts translations in flight, removes the half-translated phrase, and ignores everything said meanwhile", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    r.last().o.onPhrase(r.phrase("this is finished"));
    await settle();
    r.calls[0]!.resolve("Esto está terminado");
    await settle();
    r.last().o.onPhrase(r.phrase("this one is still being translated"));
    await settle();
    r.calls[1]!.call.onText("Esta todavía se está");
    r.last().o.onTail("meeting", "words being said right now");

    r.ctrl.pause();
    expect(r.last().paused).toBe(true); // the source stops sending audio
    expect(r.calls[1]!.call.signal.aborted).toBe(true); // the request is aborted
    const s = r.ctrl.getSnapshot();
    expect(s.paused).toBe(true);
    expect(s.tail).toBe("");
    expect(s.entries.map((e) => e.original)).toEqual(["this is finished"]); // the unfinished phrase is gone

    // anything that still arrives from the source during the pause is dropped
    r.last().o.onPhrase(r.phrase("said during the pause"));
    r.last().o.onTail("meeting", "also during the pause");
    await settle();
    expect(r.calls).toHaveLength(2); // no new translation request
    expect(r.ctrl.getSnapshot().tail).toBe("");
    expect(r.ctrl.getSnapshot().entries.map((e) => e.original)).toEqual(["this is finished"]);
    // the half-translated phrase and the pause speech never reach the transcript
    expect(r.ctrl.transcript().map((e) => e.original)).toEqual(["this is finished"]);
    await r.ctrl.dispose();
  });

  it("resume listens again: speech after the pause is captioned", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    r.ctrl.pause();
    r.ctrl.resume();
    expect(r.last().paused).toBe(false);
    r.last().o.onPhrase(r.phrase("welcome back everyone"));
    await settle();
    expect(r.calls).toHaveLength(1);
    r.calls[0]!.resolve("Bienvenidos de nuevo a todos");
    await settle();
    expect(r.ctrl.transcript().map((e) => e.original)).toEqual(["welcome back everyone"]);
    await r.ctrl.dispose();
  });

  it("the light says paused, and togglePause flips it", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    r.ctrl.togglePause();
    expect(r.ctrl.getSnapshot().paused).toBe(true);
    r.ctrl.togglePause();
    expect(r.ctrl.getSnapshot().paused).toBe(false);
    await r.ctrl.dispose();
  });

  it("an in-flight translation that finishes after the abort never reaches the screen or the transcript", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    r.last().o.onPhrase(r.phrase("said just before the pause"));
    await settle();
    r.ctrl.pause();
    r.calls[0]!.resolve("Dicho justo antes de la pausa"); // too late
    await settle();
    expect(r.ctrl.getSnapshot().entries).toEqual([]);
    expect(r.ctrl.transcript()).toEqual([]);
    await r.ctrl.dispose();
  });
});

describe("a lost session (401)", () => {
  it("only records it: no navigation (the login page must never be drawn on air); stops the source and the retries", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    expect(() => authLost()).not.toThrow(); // the default handler would touch window.location and throw here
    await settle();
    const s = r.ctrl.getSnapshot();
    expect(s.authLost).toBe(true);
    expect(r.sources[0]!.stop).toHaveBeenCalled();
    r.c.advance(60_000);
    await settle();
    expect(r.sources).toHaveLength(1); // no restart attempts on a rejected session
    await r.ctrl.dispose();
  });

  it("restores the normal 401 behaviour when /present goes away", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    await r.ctrl.dispose();
    expect(() => authLost()).toThrow(); // default handler again (needs window)
  });
});

describe("what the caption area can ever receive", () => {
  it("errors, a failed source and a missing device live in separate fields; the entries and tail hold only captions", async () => {
    const r = rig();
    r.ctrl.start();
    await settle();
    r.sources[0]!.o.onStatus("meeting", "failed");
    await settle();
    const s = r.ctrl.getSnapshot();
    expect(s.source).toBe("failed");
    expect(s.entries).toEqual([]);
    expect(s.tail).toBe("");
    await r.ctrl.dispose();
  });
});

describe("misc", () => {
  it("defaults: presenter tuning is the base even though DEFAULT_TUNING differs", () => {
    expect(PRESENTER_TUNING.segmenter.maxWords).not.toBe(DEFAULT_TUNING.segmenter.maxWords);
  });
});
