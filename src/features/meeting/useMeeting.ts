"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureError, captureMeetingAudio, captureMic, type CaptureFailure } from "@/features/audio/capture";
import { TokenError } from "@/features/audio/token";
import { createWorkerTimers, type DisposableTimers } from "@/features/audio/workerTimers";
import { streamTranslate } from "@/features/converse/streamTranslate";
import { DEFAULT_PROFILE, glossaryKeyterms, loadGlossary, type GlossaryProfile } from "@/engine";
import { CaptionSource, type PhraseEvent, type SourceStatus } from "./captionSource";
import { CaptionPipeline, type PipelineEvent } from "./pipeline";
import type { CaptionEntry, SourceId } from "./transcript";
import { getMeetingTuning, getProfile, type MeetingTuning } from "./tuning";
import type { PhraseTiming } from "./timing";

export type Phase = "idle" | "starting" | "live" | "stopping";
export type MeetingErrorKind = CaptureFailure | "offline" | "token" | "stt";
export interface MeetingError {
  kind: MeetingErrorKind;
  source: SourceId;
}
export type SourceState = SourceStatus | "off";

/** ?debug=1 diagnostics for the field: is the page being throttled, and what did the filters do. */
export interface DebugInfo {
  /** The 1 s heartbeat ran late by more than 3 s at least once: the browser throttled this page's timers. */
  throttleEvents: number;
  maxTickGapMs: number;
  hiddenMs: number;
  maxChunkGapMs: number;
  maxResultGapMs: number;
  filtered: number;
  /** Forced Finalize messages sent (all sources; 0 unless ?fin= is set). */
  finalizes: number;
  leaks: number;
  retries: number;
  /** isAlreadyIn word-list heuristic fired (debug only; nothing is passed through any more). */
  alreadyInTarget: number;
  /** The model returned the phrase unchanged (expected only for names and acronyms). */
  unchanged: number;
  untranslated: number;
  /** Most recent stripped fragments / dropped phrases, newest last. */
  log: string[];
}

const EMPTY_DEBUG: DebugInfo = {
  throttleEvents: 0, maxTickGapMs: 0, hiddenMs: 0, maxChunkGapMs: 0, maxResultGapMs: 0, finalizes: 0,
  filtered: 0, leaks: 0, retries: 0, alreadyInTarget: 0, unchanged: 0, untranslated: 0, log: [],
};
const THROTTLE_GAP_MS = 3000;
const LOG_LIMIT = 30;
const TIMING_KEEP = 500; // phrases of timing kept (the stats use the newest TIMING_WINDOW)

/** `defaultProfile`: the glossary profile this page uses unless the URL says `?profile=`. /meeting: "chapter". */
export function useMeeting(defaultProfile: GlossaryProfile = DEFAULT_PROFILE) {
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [entries, setEntries] = useState<CaptionEntry[]>([]);
  const [tails, setTails] = useState<Record<SourceId, string>>({ meeting: "", you: "" });
  const [sources, setSources] = useState<Record<SourceId, SourceState>>({ meeting: "off", you: "off" });
  const [error, setError] = useState<MeetingError | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [useMic, setUseMic] = useState(true);
  const [timings, setTimings] = useState<PhraseTiming[]>([]);
  const [tuning, setTuning] = useState<MeetingTuning | null>(null);
  const [profile, setProfile] = useState<GlossaryProfile>(defaultProfile);
  const [downloaded, setDownloaded] = useState(0);
  const [debugInfo, setDebugInfo] = useState<DebugInfo>(EMPTY_DEBUG);

  const phaseRef = useRef<Phase>("idle");
  const srcs = useRef<Partial<Record<SourceId, CaptionSource>>>({});
  const tuningRef = useRef<MeetingTuning | null>(null);
  /** Resolved when the session starts; read by every translation request and by each source's keyterms. */
  const profileRef = useRef<GlossaryProfile>(defaultProfile);
  const keytermsRef = useRef<string[]>([]);
  const [limits, setLimits] = useState<{ maxSessionMs: number; warnAtMs: number } | null>(null);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const timingsRef = useRef<PhraseTiming[]>([]);
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

  const publishTimings = useCallback(() => setTimings(timingsRef.current.slice()), []);

  const onPipelineEvent = useCallback(
    (e: PipelineEvent) => {
      if (e.kind === "leak") {
        console.warn("[puente] stripped model meta-text from translation", e.leaks);
        bumpDebug((d) => ({ ...d, leaks: d.leaks + 1, log: [...d.log, `leak #${e.id}: ${e.leaks.join(" | ").slice(0, 160)}`].slice(-LOG_LIMIT) }));
      } else if (e.kind === "retry") {
        bumpDebug((d) => ({ ...d, retries: d.retries + 1, log: [...d.log, `retry #${e.id} (${e.why})`].slice(-LOG_LIMIT) }));
      } else if (e.kind === "already-hint") bumpDebug((d) => ({ ...d, alreadyInTarget: d.alreadyInTarget + 1 }));
      else if (e.kind === "unchanged") bumpDebug((d) => ({ ...d, unchanged: d.unchanged + 1 }));
      else if (e.kind === "untranslated") bumpDebug((d) => ({ ...d, untranslated: d.untranslated + 1 }));
    },
    [bumpDebug],
  );

  const pipeline = useMemo(
    () =>
      new CaptionPipeline(
        {
          contextPhrases: 6, // the session's `?ctx=` is applied in start() via setContextPhrases
          translate: (c) =>
            streamTranslate(c.text, { auto: true, hint: c.hint, profile: c.profile }, c.onText, c.signal, c.context, c.onResult, c.onSource),
        },
        { onChange: (list) => setEntries(list), onEvent: onPipelineEvent },
      ),
    [onPipelineEvent],
  );

  const onPhrase = useCallback(
    (e: PhraseEvent) => {
      const rec: PhraseTiming = {
        id: 0,
        cut: e.cut,
        words: e.text.split(/\s+/).filter(Boolean).length,
        speechToEmit: e.endedAtLocal !== undefined ? Math.max(0, e.emittedAtLocal - e.endedAtLocal) : null,
        emitToFirst: null,
        emitToDone: null,
        cacheRead: null,
        inputTokens: null,
        retried: false,
      };
      timingsRef.current = [...timingsRef.current, rec].slice(-TIMING_KEEP);
      rec.id = pipeline.add(
        { source: e.source, lang: e.lang, text: e.text, spokenAt: e.spokenAt, alreadyHint: e.alreadyHint, profile: profileRef.current },
        () => {
          rec.emitToFirst = performance.now() - e.emittedAtLocal;
          publishTimings();
        },
        (r) => {
          rec.emitToDone = performance.now() - e.emittedAtLocal;
          if (r?.usage) Object.assign(rec, { cacheRead: r.usage.cacheReadTokens, inputTokens: r.usage.inputTokens });
          rec.retried = !!r?.retried;
          publishTimings();
        },
      );
      publishTimings();
    },
    [pipeline, publishTimings],
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
        keyterms: keytermsRef.current,
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
    setTuning(tuning);
    pipeline.setContextPhrases(tuning.contextPhrases);
    profileRef.current = getProfile(defaultProfile);
    setProfile(profileRef.current);
    keytermsRef.current = glossaryKeyterms(loadGlossary(profileRef.current));
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
        finalizes: Math.max(d.finalizes, health.reduce((n, h) => n + (h?.finalizes ?? 0), 0)),
        log: late ? [...d.log, `page throttled: heartbeat ${(gap / 1000).toFixed(1)}s late`].slice(-LOG_LIMIT) : d.log,
      }));
      if (ms >= tuning.maxSessionMs) void stop();
    }, 1000);
  }, [bumpDebug, defaultProfile, pipeline, setPhase, startSource, stop, useMic]);

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
    timingsRef.current = [];
    setTimings([]);
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
    phase, entries, tails, sources, error, elapsedMs, useMic, setUseMic, timings, tuning, profile, unsaved, debugInfo,
    maxSessionMs: limits?.maxSessionMs,
    warnAtMs: limits?.warnAtMs,
    start, stop, clear, retryEntry, reshareMeeting, markDownloaded, dismissError,
  };
}

export type Meeting = ReturnType<typeof useMeeting>;
