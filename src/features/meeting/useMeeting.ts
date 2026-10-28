"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureError, captureMeetingAudio, captureMic, type CaptureFailure } from "@/features/audio/capture";
import { TokenError } from "@/features/audio/token";
import { percentile } from "@/features/debug/stats";
import { createWorkerTimers, type DisposableTimers } from "@/features/audio/workerTimers";
import { streamTranslate } from "@/features/converse/streamTranslate";
import { CaptionSource, type PhraseEvent, type SourceStatus } from "./captionSource";
import { CaptionPipeline, type PipelineEvent } from "./pipeline";
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
  /** Worst-case delays (ms from the speaker's last word): the number that shows a stall, which percentiles hide. */
  phraseMax: number | null;
  firstMax: number | null;
  doneMax: number | null;
}

const EMPTY_STATS: LatencyStats = {
  n: 0, phraseP50: null, phraseP95: null, firstP50: null, firstP95: null, doneP50: null, doneP95: null,
  phraseMax: null, firstMax: null, doneMax: null,
};

/** ?debug=1 diagnostics for the field: is the page being throttled, and what did the filters do. */
export interface DebugInfo {
  /** The 1 s heartbeat ran late by more than 3 s at least once: the browser throttled this page's timers. */
  throttleEvents: number;
  maxTickGapMs: number;
  hiddenMs: number;
  maxChunkGapMs: number;
  maxResultGapMs: number;
  filtered: number;
  leaks: number;
  retries: number;
  alreadyInTarget: number;
  untranslated: number;
  /** Most recent stripped fragments / dropped phrases, newest last. */
  log: string[];
}

const EMPTY_DEBUG: DebugInfo = {
  throttleEvents: 0, maxTickGapMs: 0, hiddenMs: 0, maxChunkGapMs: 0, maxResultGapMs: 0,
  filtered: 0, leaks: 0, retries: 0, alreadyInTarget: 0, untranslated: 0, log: [],
};
const THROTTLE_GAP_MS = 3000;
const LOG_LIMIT = 30;
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
  const [debugInfo, setDebugInfo] = useState<DebugInfo>(EMPTY_DEBUG);

  const phaseRef = useRef<Phase>("idle");
  const srcs = useRef<Partial<Record<SourceId, CaptionSource>>>({});
  const tuningRef = useRef<MeetingTuning | null>(null);
  const [limits, setLimits] = useState<{ maxSessionMs: number; warnAtMs: number } | null>(null);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const timings = useRef<{ phrase: number[]; first: number[]; done: number[] }>({ phrase: [], first: [], done: [] });
  const timersRef = useRef<DisposableTimers | null>(null);

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const bumpDebug = useCallback((fn: (d: DebugInfo) => DebugInfo) => setDebugInfo(fn), []);

  const logLine = useCallback(
    (line: string) => bumpDebug((d) => ({ ...d, log: [...d.log, line].slice(-LOG_LIMIT) })),
    [bumpDebug],
  );

  const recordTiming = useCallback((kind: "phrase" | "first" | "done", ms: number) => {
    timings.current[kind].push(ms);
    const t = timings.current;
    const max = (a: number[]) => (a.length ? Math.max(...a) : null);
    setStats({
      n: t.done.length,
      phraseP50: percentile(t.phrase, 50),
      phraseP95: percentile(t.phrase, 95),
      firstP50: percentile(t.first, 50),
      firstP95: percentile(t.first, 95),
      doneP50: percentile(t.done, 50),
      doneP95: percentile(t.done, 95),
      phraseMax: max(t.phrase),
      firstMax: max(t.first),
      doneMax: max(t.done),
    });
  }, []);

  const onPipelineEvent = useCallback(
    (e: PipelineEvent) => {
      if (e.kind === "leak") {
        console.warn("[puente] stripped model meta-text from translation", e.leaks);
        bumpDebug((d) => ({ ...d, leaks: d.leaks + 1, log: [...d.log, `leak #${e.id}: ${e.leaks.join(" | ").slice(0, 160)}`].slice(-LOG_LIMIT) }));
      } else if (e.kind === "retry") {
        bumpDebug((d) => ({ ...d, retries: d.retries + 1, log: [...d.log, `retry #${e.id} (${e.why})`].slice(-LOG_LIMIT) }));
      } else if (e.kind === "passthrough") bumpDebug((d) => ({ ...d, alreadyInTarget: d.alreadyInTarget + 1 }));
      else if (e.kind === "untranslated") bumpDebug((d) => ({ ...d, untranslated: d.untranslated + 1 }));
    },
    [bumpDebug],
  );

  const pipeline = useMemo(
    () =>
      new CaptionPipeline(
        {
          contextPhrases: CONTEXT_PHRASES,
          translate: (c) =>
            streamTranslate(c.text, c.direction, c.onText, c.signal, c.context, c.onResult),
        },
        { onChange: (list) => setEntries(list), onEvent: onPipelineEvent },
      ),
    [onPipelineEvent],
  );

  const onPhrase = useCallback(
    (e: PhraseEvent) => {
      if (e.endedAtLocal !== undefined) recordTiming("phrase", e.emittedAtLocal - e.endedAtLocal);
      const ended = e.endedAtLocal;
      pipeline.add(
        { source: e.source, lang: e.lang, text: e.text, spokenAt: e.spokenAt, alreadyInTarget: e.alreadyInTarget },
        () => ended !== undefined && recordTiming("first", performance.now() - ended),
        () => ended !== undefined && recordTiming("done", performance.now() - ended),
      );
    },
    [pipeline, recordTiming],
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
    await pipeline.idle();
    timersRef.current?.dispose();
    timersRef.current = null;
    if (!mounted.current) return;
    setSources({ meeting: "off", you: "off" });
    setTails({ meeting: "", you: "" });
    setPhase("idle");
  }, [clearTimer, pipeline, setPhase]);

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
      timersRef.current ??= createWorkerTimers();
      const src = new CaptionSource({
        id,
        stream,
        tuning,
        onPhrase,
        onTail,
        onStatus,
        timers: timersRef.current,
        onFiltered: (sid, text, reason) => {
          bumpDebug((d) => ({ ...d, filtered: d.filtered + 1 }));
          logLine(`dropped (${reason}) ${sid}: ${text.slice(0, 60)}`);
        },
      });
      srcs.current[id] = src;
      try {
        await src.start();
      } catch (e) {
        delete srcs.current[id];
        await src.stop();
        throw e;
      }
    },
    [onPhrase, onTail, onStatus, bumpDebug, logLine],
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
      timersRef.current?.dispose();
      timersRef.current = null;
      setError({ kind: e instanceof TokenError ? "token" : navigator.onLine ? "stt" : "offline", source: "meeting" });
      setSources({ meeting: "off", you: "off" });
      setPhase("idle");
      return;
    }
    const t0 = Date.now();
    setElapsedMs(0);
    setPhase("live");
    // Deliberately a plain (throttleable) interval: how late it runs is the measure of whether the browser is throttling
    // this page. Nothing time-critical depends on it (the segmenter and reconnect timers run in a Worker).
    let lastTick = Date.now();
    timer.current = setInterval(() => {
      const nowMs = Date.now();
      const gap = nowMs - lastTick;
      lastTick = nowMs;
      const ms = nowMs - t0;
      setElapsedMs(ms);
      const health = Object.values(srcs.current).map((s) => s?.health());
      const late = gap > THROTTLE_GAP_MS;
      if (late) console.warn(`[puente] page timers ran ${(gap / 1000).toFixed(1)}s late (throttled)`);
      const hidden = document.visibilityState === "hidden";
      bumpDebug((d) => ({
        ...d,
        throttleEvents: d.throttleEvents + (late ? 1 : 0),
        maxTickGapMs: Math.max(d.maxTickGapMs, gap),
        hiddenMs: d.hiddenMs + (hidden ? gap : 0),
        maxChunkGapMs: Math.max(d.maxChunkGapMs, ...health.map((h) => h?.maxChunkGapMs ?? 0)),
        maxResultGapMs: Math.max(d.maxResultGapMs, ...health.map((h) => h?.maxResultGapMs ?? 0)),
        log: late ? [...d.log, `page throttled: heartbeat ${(gap / 1000).toFixed(1)}s late`].slice(-LOG_LIMIT) : d.log,
      }));
      if (ms >= tuning.maxSessionMs) void stop();
    }, 1000);
  }, [bumpDebug, setPhase, startSource, stop, useMic]);

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
      pipeline.retry(id);
    },
    [pipeline],
  );

  /** Only when stopped. Forgets every caption. */
  const clear = useCallback(() => {
    if (phaseRef.current !== "idle") return;
    pipeline.clear();
    setDebugInfo(EMPTY_DEBUG);
    timings.current = { phrase: [], first: [], done: [] };
    setStats(EMPTY_STATS);
    setDownloaded(0);
    setError(null);
  }, [pipeline]);

  const markDownloaded = useCallback(() => setDownloaded(pipeline.entries.length), [pipeline]);
  const dismissError = useCallback(() => setError(null), []);

  // Leaving the page: stop capture and drop in-flight requests.
  useEffect(() => {
    mounted.current = true;
    const live = srcs;
    const timers = timersRef;
    return () => {
      mounted.current = false;
      clearTimer();
      pipeline.abortAll();
      for (const s of Object.values(live.current)) void s?.stop();
      live.current = {};
      timers.current?.dispose();
      timers.current = null;
    };
  }, [clearTimer, pipeline]);

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
    phase, entries, tails, sources, error, elapsedMs, useMic, setUseMic, stats, unsaved, debugInfo,
    maxSessionMs: limits?.maxSessionMs,
    warnAtMs: limits?.warnAtMs,
    start, stop, clear, retryEntry, reshareMeeting, markDownloaded, dismissError,
  };
}

export type Meeting = ReturnType<typeof useMeeting>;
