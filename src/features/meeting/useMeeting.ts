"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { directionFor, type ContextPair } from "@/engine";
import { CaptureError, captureMeetingAudio, captureMic, type CaptureFailure } from "@/features/audio/capture";
import { TokenError } from "@/features/audio/token";
import { percentile } from "@/features/debug/stats";
import { streamTranslate } from "@/features/converse/streamTranslate";
import { CaptionSource, type PhraseEvent, type SourceStatus } from "./captionSource";
import type { CaptionEntry, SourceId } from "./transcript";
import { getMeetingTuning, type MeetingTuning } from "./tuning";

export type Phase = "idle" | "starting" | "live" | "stopping";
export type MeetingErrorKind = CaptureFailure | "offline" | "token" | "stt";
export interface MeetingError {
  kind: MeetingErrorKind;
  source: SourceId;
}
export type SourceState = SourceStatus | "off";

export interface LatencyStats {
  n: number;
  /** ms from the speaker's last word to the phrase leaving the segmenter. */
  phraseP50: number | null;
  phraseP95: number | null;
  /** ms from the speaker's last word to the first translated text. */
  firstP50: number | null;
  firstP95: number | null;
  /** ms from the speaker's last word to the finished translation. */
  doneP50: number | null;
  doneP95: number | null;
}

const EMPTY_STATS: LatencyStats = { n: 0, phraseP50: null, phraseP95: null, firstP50: null, firstP95: null, doneP50: null, doneP95: null };
const CONTEXT_PHRASES = 6;

export function useMeeting() {
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [entries, setEntries] = useState<CaptionEntry[]>([]);
  const [tails, setTails] = useState<Record<SourceId, string>>({ meeting: "", you: "" });
  const [sources, setSources] = useState<Record<SourceId, SourceState>>({ meeting: "off", you: "off" });
  const [error, setError] = useState<MeetingError | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [useMic, setUseMic] = useState(true);
  const [stats, setStats] = useState<LatencyStats>(EMPTY_STATS);
  const [downloaded, setDownloaded] = useState(0);

  const phaseRef = useRef<Phase>("idle");
  const entriesRef = useRef<CaptionEntry[]>([]);
  const srcs = useRef<Partial<Record<SourceId, CaptionSource>>>({});
  const tuningRef = useRef<MeetingTuning | null>(null);
  const [limits, setLimits] = useState<{ maxSessionMs: number; warnAtMs: number } | null>(null);
  const controllers = useRef<Set<AbortController>>(new Set());
  const inflight = useRef<Set<Promise<void>>>(new Set());
  const nextId = useRef(1);
  const generation = useRef(0);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const timings = useRef<{ phrase: number[]; first: number[]; done: number[] }>({ phrase: [], first: [], done: [] });

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const commit = useCallback((fn: (prev: CaptionEntry[]) => CaptionEntry[]) => {
    entriesRef.current = fn(entriesRef.current);
    setEntries(entriesRef.current);
  }, []);

  const patch = useCallback(
    (id: number, p: Partial<CaptionEntry>) => commit((prev) => prev.map((e) => (e.id === id ? { ...e, ...p } : e))),
    [commit],
  );

  const recordTiming = useCallback((kind: "phrase" | "first" | "done", ms: number) => {
    timings.current[kind].push(ms);
    const t = timings.current;
    setStats({
      n: t.done.length,
      phraseP50: percentile(t.phrase, 50),
      phraseP95: percentile(t.phrase, 95),
      firstP50: percentile(t.first, 50),
      firstP95: percentile(t.first, 95),
      doneP50: percentile(t.done, 50),
      doneP95: percentile(t.done, 95),
    });
  }, []);

  const translateEntry = useCallback(
    async (id: number, gen: number, endedAtLocal?: number) => {
      const list = entriesRef.current;
      const idx = list.findIndex((e) => e.id === id);
      if (idx < 0) return;
      const entry = list[idx]!;
      // Context: earlier phrases from the SAME source going the same way (a language flip starts fresh).
      const context: ContextPair[] = list
        .slice(0, idx)
        .filter((e) => e.source === entry.source && e.lang === entry.lang)
        .slice(-CONTEXT_PHRASES)
        .map((e) => ({ source: e.original, translation: e.status === "done" && e.translation ? e.translation : undefined }));
      const ctrl = new AbortController();
      controllers.current.add(ctrl);
      patch(id, { status: "translating", translation: "" });
      let sawFirst = false;
      try {
        const final = await streamTranslate(
          entry.original,
          directionFor(entry.lang),
          (soFar) => {
            if (gen !== generation.current) return;
            if (!sawFirst && endedAtLocal !== undefined) {
              sawFirst = true;
              recordTiming("first", performance.now() - endedAtLocal);
            }
            patch(id, { translation: soFar });
          },
          ctrl.signal,
          context,
        );
        if (gen === generation.current) {
          patch(id, { translation: final, status: "done" });
          if (endedAtLocal !== undefined) recordTiming("done", performance.now() - endedAtLocal);
        }
      } catch {
        if (ctrl.signal.aborted || gen !== generation.current || !mounted.current) return;
        patch(id, { status: "error" });
      } finally {
        controllers.current.delete(ctrl);
      }
    },
    [patch, recordTiming],
  );

  const onPhrase = useCallback(
    (e: PhraseEvent) => {
      const id = nextId.current++;
      commit((prev) => [...prev, { id, source: e.source, at: Date.now(), lang: e.lang, original: e.text, translation: "", status: "translating" }]);
      if (e.endedAtLocal !== undefined) recordTiming("phrase", e.emittedAtLocal - e.endedAtLocal);
      const p = translateEntry(id, generation.current, e.endedAtLocal).finally(() => inflight.current.delete(p));
      inflight.current.add(p);
    },
    [commit, recordTiming, translateEntry],
  );

  const onTail = useCallback((id: SourceId, text: string) => {
    setTails((t) => (t[id] === text ? t : { ...t, [id]: text }));
  }, []);

  const clearTimer = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  const stop = useCallback(async () => {
    if (phaseRef.current !== "live" && phaseRef.current !== "starting") return;
    setPhase("stopping");
    clearTimer();
    await Promise.all(Object.values(srcs.current).map((s) => s?.stop()));
    srcs.current = {};
    await Promise.allSettled([...inflight.current]);
    if (!mounted.current) return;
    setSources({ meeting: "off", you: "off" });
    setTails({ meeting: "", you: "" });
    setPhase("idle");
  }, [clearTimer, setPhase]);

  const onStatus = useCallback(
    (id: SourceId, s: SourceStatus, reason?: string) => {
      if (!mounted.current) return;
      void reason;
      setSources((cur) => ({ ...cur, [id]: s }));
      if (s === "failed") setError({ kind: navigator.onLine ? "stt" : "offline", source: id });
      // A source that ended while the session is running: the user stopped sharing or unplugged the mic.
      if (s === "ended" && phaseRef.current === "live") {
        delete srcs.current[id];
        setError({ kind: id === "meeting" ? "no-audio" : "mic-failed", source: id });
        if (Object.keys(srcs.current).length === 0) void stop();
      }
    },
    [stop],
  );

  const startSource = useCallback(
    async (id: SourceId, stream: MediaStream, tuning: MeetingTuning) => {
      const src = new CaptionSource({ id, stream, tuning, onPhrase, onTail, onStatus });
      srcs.current[id] = src;
      try {
        await src.start();
      } catch (e) {
        delete srcs.current[id];
        await src.stop();
        throw e;
      }
    },
    [onPhrase, onTail, onStatus],
  );

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    setError(null);
    if (!navigator.onLine) {
      setError({ kind: "offline", source: "meeting" });
      return;
    }
    setPhase("starting");
    const tuning = getMeetingTuning();
    tuningRef.current = tuning;
    setLimits({ maxSessionMs: tuning.maxSessionMs, warnAtMs: tuning.warnAtMs });
    // The picker needs the click's user activation, so it is the first await.
    let meeting: MediaStream;
    try {
      meeting = await captureMeetingAudio();
    } catch (e) {
      setError({ kind: e instanceof CaptureError ? e.kind : "unsupported", source: "meeting" });
      setPhase("idle");
      return;
    }
    let mic: MediaStream | null = null;
    if (useMic) {
      try {
        mic = await captureMic();
      } catch (e) {
        // The mic is optional: carry on with meeting audio only, and say so.
        setError({ kind: e instanceof CaptureError ? e.kind : "mic-failed", source: "you" });
      }
    }
    try {
      await startSource("meeting", meeting, tuning);
      if (mic) await startSource("you", mic, tuning);
    } catch (e) {
      meeting.getTracks().forEach((t) => t.stop());
      mic?.getTracks().forEach((t) => t.stop());
      await Promise.all(Object.values(srcs.current).map((s) => s?.stop()));
      srcs.current = {};
      setError({ kind: e instanceof TokenError ? "token" : navigator.onLine ? "stt" : "offline", source: "meeting" });
      setSources({ meeting: "off", you: "off" });
      setPhase("idle");
      return;
    }
    const t0 = Date.now();
    setElapsedMs(0);
    setPhase("live");
    timer.current = setInterval(() => {
      const ms = Date.now() - t0;
      setElapsedMs(ms);
      if (ms >= tuning.maxSessionMs) void stop();
    }, 1000);
  }, [setPhase, startSource, stop, useMic]);

  /** After the user ended screen sharing: pick the meeting audio again without stopping the session. */
  const reshareMeeting = useCallback(async () => {
    if (phaseRef.current !== "live") return;
    setError(null);
    try {
      await startSource("meeting", await captureMeetingAudio(), tuningRef.current ?? getMeetingTuning());
    } catch (e) {
      setError({ kind: e instanceof CaptureError ? e.kind : "stt", source: "meeting" });
    }
  }, [startSource]);

  const retryEntry = useCallback(
    (id: number) => {
      void translateEntry(id, generation.current);
    },
    [translateEntry],
  );

  /** Only when stopped. Forgets every caption. */
  const clear = useCallback(() => {
    if (phaseRef.current !== "idle") return;
    generation.current++;
    for (const c of controllers.current) c.abort();
    controllers.current.clear();
    timings.current = { phrase: [], first: [], done: [] };
    setStats(EMPTY_STATS);
    setDownloaded(0);
    setError(null);
    commit(() => []);
  }, [commit]);

  const markDownloaded = useCallback(() => setDownloaded(entriesRef.current.length), []);
  const dismissError = useCallback(() => setError(null), []);

  // Leaving the page: stop capture and drop in-flight requests.
  useEffect(() => {
    mounted.current = true;
    const ctrls = controllers.current;
    const live = srcs;
    return () => {
      mounted.current = false;
      generation.current++; // eslint-disable-line react-hooks/exhaustive-deps -- a counter, not a DOM ref
      clearTimer();
      for (const c of ctrls) c.abort();
      for (const s of Object.values(live.current)) void s?.stop();
      live.current = {};
    };
  }, [clearTimer]);

  // Warn before closing while live, or while captions exist that were never downloaded.
  const unsaved = entries.length > downloaded;
  useEffect(() => {
    if (phase === "idle" && !unsaved) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [phase, unsaved]);

  return {
    phase, entries, tails, sources, error, elapsedMs, useMic, setUseMic, stats, unsaved,
    maxSessionMs: limits?.maxSessionMs,
    warnAtMs: limits?.warnAtMs,
    start, stop, clear, retryEntry, reshareMeeting, markDownloaded, dismissError,
  };
}

export type Meeting = ReturnType<typeof useMeeting>;
