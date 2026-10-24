"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EN_TO_ES, ES_TO_EN, PhraseSegmenter, otherLang, type ContextPair, type Direction, type Lang } from "@/engine";
import { openMic, type MicCapture } from "@/features/audio/mic";
import { SpeechCapture } from "@/features/audio/speechCapture";
import { TokenError } from "@/features/audio/token";
import type { ErrorKind } from "./strings";
import { streamTranslate } from "./streamTranslate";
import { PHRASES, phraseText } from "./phrases";
import { getTuning, TUNING, type Tuning } from "./tuning";

export const MAX_TURN_SECONDS = 60;
export const COUNTDOWN_FROM_SECONDS = 10;
const HISTORY_LIMIT = 40; // kept in memory; each half only renders the last few

export type Phase = "idle" | "starting" | "recording" | "processing";

/** One phrase of a turn: what was said and its (streaming) translation. */
export interface Segment {
  id: number;
  source: string;
  translation: string;
  status: "translating" | "done" | "error";
}

export interface ConvTurn {
  id: number;
  speaker: Lang;
  source: "speech" | "phrase";
  /** Phrases in spoken order. Translations are shown to the listener strictly in this order. */
  segments: Segment[];
  /** Live text not yet a phrase (finalized-but-buffered words plus the current interim). Speaker's half only. */
  tail: string;
  live: boolean;
}

export interface ConvError {
  kind: ErrorKind;
  side: Lang;
}

export type Notice = "no-speech" | "auto-stop" | null;

function directionFrom(speaker: Lang): Direction {
  return speaker === "en" ? EN_TO_ES : ES_TO_EN;
}

function micErrorKind(e: unknown): ErrorKind {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "mic-denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "mic-missing";
  return "mic-failed";
}

/** A recording in progress. */
interface Recording {
  turnId: number;
  speaker: Lang;
  gen: number;
  segmenter: PhraseSegmenter;
  tuning: Tuning;
  /** Current interim text (not yet final). */
  interim: string;
  /** Translations still in flight for this turn. */
  inflight: Set<Promise<void>>;
}

/**
 * All conversation state lives here, in memory only. One turn at a time:
 * idle -> starting -> recording -> processing (flush + finish translating) -> idle.
 * While recording, each finished phrase is translated immediately; the turn is never re-translated as a whole.
 */
export function useConversation() {
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [side, setSide] = useState<Lang | null>(null);
  const [turns, setTurns] = useState<ConvTurn[]>([]);
  const [error, setError] = useState<ConvError | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [secondsLeft, setSecondsLeft] = useState(MAX_TURN_SECONDS);

  // Refs are the source of truth for logic running in callbacks/timers; state mirrors them for rendering.
  const turnsRef = useRef<ConvTurn[]>([]);
  const phaseRef = useRef<Phase>("idle");
  const sideRef = useRef<Lang | null>(null);
  const mic = useRef<MicCapture | null>(null);
  const capture = useRef<SpeechCapture | null>(null);
  const recording = useRef<Recording | null>(null);
  const controllers = useRef<Set<AbortController>>(new Set());
  const turnTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelStart = useRef(false);
  const nextId = useRef(1);
  const mounted = useRef(true);
  /** Bumped by clear(): anything started in an earlier generation drops its results. */
  const generation = useRef(0);

  const commit = useCallback((fn: (prev: ConvTurn[]) => ConvTurn[]) => {
    turnsRef.current = fn(turnsRef.current).slice(-HISTORY_LIMIT);
    setTurns(turnsRef.current);
  }, []);

  const patchTurn = useCallback(
    (turnId: number, patch: (t: ConvTurn) => ConvTurn) => commit((prev) => prev.map((t) => (t.id === turnId ? patch(t) : t))),
    [commit],
  );

  const patchSegment = useCallback(
    (turnId: number, segId: number, patch: Partial<Segment>) =>
      patchTurn(turnId, (t) => ({ ...t, segments: t.segments.map((s) => (s.id === segId ? { ...s, ...patch } : s)) })),
    [patchTurn],
  );

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const setActiveSide = useCallback((s: Lang | null) => {
    sideRef.current = s;
    setSide(s);
  }, []);

  const clearTurnTimer = useCallback(() => {
    if (turnTimer.current) clearInterval(turnTimer.current);
    turnTimer.current = null;
  }, []);

  const showNotice = useCallback((n: Notice) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(n);
    if (n) noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  }, []);

  const toIdle = useCallback(() => {
    clearTurnTimer();
    recording.current = null;
    setActiveSide(null);
    setPhase("idle");
  }, [clearTurnTimer, setActiveSide, setPhase]);

  /** Translate one phrase, streaming into its segment. Failure marks only this phrase; the turn carries on. */
  const translateSegment = useCallback(
    async (turnId: number, segId: number, gen: number, rec?: Recording) => {
      const turn = turnsRef.current.find((t) => t.id === turnId);
      const idx = turn?.segments.findIndex((s) => s.id === segId) ?? -1;
      if (!turn || idx < 0) return;
      const seg = turn.segments[idx]!;
      // Per-turn context only: earlier phrases (source, plus their translation when it has arrived). Never persisted.
      const context: ContextPair[] = turn.segments.slice(Math.max(0, idx - (rec?.tuning ?? TUNING).contextPhrases), idx).map((s) => ({
        source: s.source,
        translation: s.status === "done" && s.translation ? s.translation : undefined,
      }));
      const ctrl = new AbortController();
      controllers.current.add(ctrl);
      patchSegment(turnId, segId, { status: "translating", translation: "" });
      try {
        const final = await streamTranslate(
          seg.source,
          directionFrom(turn.speaker),
          (soFar) => {
            if (gen === generation.current) patchSegment(turnId, segId, { translation: soFar });
          },
          ctrl.signal,
          context,
        );
        if (gen === generation.current) patchSegment(turnId, segId, { translation: final, status: "done" });
      } catch {
        if (ctrl.signal.aborted || gen !== generation.current || !mounted.current) return;
        patchSegment(turnId, segId, { status: "error" });
      } finally {
        controllers.current.delete(ctrl);
      }
    },
    [patchSegment],
  );

  /** A phrase is ready: add it to the turn and start translating it right away. */
  const onPhrase = useCallback(
    (rec: Recording, text: string) => {
      if (rec.gen !== generation.current) return;
      const segId = nextId.current++;
      patchTurn(rec.turnId, (t) => ({
        ...t,
        segments: [...t.segments, { id: segId, source: text, translation: "", status: "translating" }],
      }));
      const p = translateSegment(rec.turnId, segId, rec.gen, rec).finally(() => rec.inflight.delete(p));
      rec.inflight.add(p);
    },
    [patchTurn, translateSegment],
  );

  /** End a recording: flush leftovers into phrases, wait for translations, then go idle. */
  const finishRecording = useCallback(
    async (rec: Recording, opts: { silentIfEmpty: boolean }) => {
      // Words Deepgram never finalized (it can skip its final flush) still count.
      if (rec.interim.trim()) rec.segmenter.addFinalText(rec.interim);
      rec.segmenter.flush();
      await Promise.allSettled([...rec.inflight]);
      if (!mounted.current || rec.gen !== generation.current) return;
      const turn = turnsRef.current.find((t) => t.id === rec.turnId);
      if (turn && turn.segments.length === 0) {
        commit((prev) => prev.filter((t) => t.id !== rec.turnId));
        if (!opts.silentIfEmpty) showNotice("no-speech");
      } else {
        patchTurn(rec.turnId, (t) => ({ ...t, tail: "", live: false }));
      }
      toIdle();
    },
    [commit, patchTurn, showNotice, toIdle],
  );

  const stop = useCallback(
    async (reason: "manual" | "auto") => {
      const rec = recording.current;
      const cap = capture.current;
      if (phaseRef.current !== "recording" || !rec || !cap) return;
      clearTurnTimer();
      capture.current = null;
      setPhase("processing"); // immediately: blocks double taps while the tail is captured
      if (reason === "auto") showNotice("auto-stop");
      await new Promise((r) => setTimeout(r, rec.tuning.stopTailMs));
      if (rec.gen !== generation.current) {
        cap.cancel();
        return;
      }
      mic.current?.stop();
      try {
        await cap.finish();
      } catch (e) {
        if (!mounted.current || rec.gen !== generation.current) return;
        setError({ kind: e instanceof TokenError ? "token" : navigator.onLine ? "stt" : "offline", side: rec.speaker });
      }
      if (!mounted.current || rec.gen !== generation.current) return;
      await finishRecording(rec, { silentIfEmpty: reason === "auto" });
    },
    [clearTurnTimer, finishRecording, setPhase, showNotice],
  );

  const start = useCallback(
    async (speaker: Lang) => {
      if (phaseRef.current !== "idle") return;
      setError(null);
      showNotice(null);
      cancelStart.current = false;

      if (!navigator.onLine) {
        setError({ kind: "offline", side: speaker });
        return;
      }
      setPhase("starting");
      setActiveSide(speaker);

      try {
        mic.current ??= await openMic();
      } catch (e) {
        if (!mounted.current) return;
        setError({ kind: micErrorKind(e), side: speaker });
        toIdle();
        return;
      }
      if (!mounted.current) return;
      if (cancelStart.current) {
        toIdle();
        return;
      }

      const turnId = nextId.current++;
      commit((prev) => [...prev, { id: turnId, speaker, source: "speech", segments: [], tail: "", live: true }]);
      const tuning = getTuning();
      const rec: Recording = {
        turnId,
        tuning,
        speaker,
        gen: generation.current,
        interim: "",
        inflight: new Set(),
        segmenter: new PhraseSegmenter((text) => onPhrase(rec, text), tuning.segmenter),
      };
      recording.current = rec;

      const cap = new SpeechCapture({
        endpointingMs: tuning.endpointingMs,
        onResult: (r) => {
          if (rec.gen !== generation.current) return;
          rec.interim = r.isFinal ? "" : r.text;
          rec.segmenter.push(r);
          const tail = [rec.segmenter.pending, rec.interim].filter(Boolean).join(" ");
          patchTurn(turnId, (t) => (t.tail === tail ? t : { ...t, tail }));
        },
        onError: (e) => {
          // Socket failed mid-recording: keep what was said, translate it, and report the problem.
          if (phaseRef.current !== "recording" || rec.gen !== generation.current) return;
          clearTurnTimer();
          mic.current?.stop();
          capture.current = null;
          setPhase("processing");
          setError({ kind: e instanceof TokenError ? "token" : navigator.onLine ? "stt" : "offline", side: speaker });
          void finishRecording(rec, { silentIfEmpty: true });
        },
      });
      capture.current = cap;
      mic.current.start((pcm) => cap.push(pcm));
      setSecondsLeft(MAX_TURN_SECONDS);
      setPhase("recording");

      const startedAt = Date.now();
      turnTimer.current = setInterval(() => {
        const left = MAX_TURN_SECONDS - Math.floor((Date.now() - startedAt) / 1000);
        setSecondsLeft(Math.max(0, left));
        if (left <= 0) void stop("auto");
      }, 250);
    },
    [clearTurnTimer, commit, finishRecording, onPhrase, patchTurn, setActiveSide, setPhase, showNotice, stop, toIdle],
  );

  /** A half's talk button. Starts that side, or stops it if it is the active recording side. */
  const toggle = useCallback(
    (speaker: Lang) => {
      const p = phaseRef.current;
      if (p === "idle") void start(speaker);
      else if (p === "recording" && sideRef.current === speaker) void stop("manual");
      else if (p === "starting" && sideRef.current === speaker) cancelStart.current = true;
    },
    [start, stop],
  );

  /** Retry after a mic / connection error: start the same side again. */
  const retry = useCallback(() => {
    const err = error;
    if (!err) return;
    setError(null);
    void start(err.side);
  }, [error, start]);

  /** Retry one failed phrase, in place. */
  const retrySegment = useCallback(
    (turnId: number, segId: number) => {
      if (phaseRef.current === "recording" || phaseRef.current === "starting") return;
      void translateSegment(turnId, segId, generation.current);
    },
    [translateSegment],
  );

  const dismissError = useCallback(() => setError(null), []);

  /** Quick phrase: instant, no STT and no API call. */
  const sayPhrase = useCallback(
    (speaker: Lang, phraseId: string) => {
      if (phaseRef.current !== "idle") return;
      const p = PHRASES.find((x) => x.id === phraseId);
      if (!p) return;
      setError(null);
      const id = nextId.current++;
      commit((prev) => [
        ...prev,
        {
          id,
          speaker,
          source: "phrase",
          segments: [{ id: nextId.current++, source: phraseText(p, speaker), translation: phraseText(p, otherLang(speaker)), status: "done" }],
          tail: "",
          live: false,
        },
      ]);
    },
    [commit],
  );

  const clear = useCallback(() => {
    generation.current += 1;
    for (const c of controllers.current) c.abort();
    controllers.current.clear();
    recording.current?.segmenter.dispose();
    capture.current?.cancel();
    capture.current = null;
    mic.current?.stop();
    commit(() => []);
    setError(null);
    showNotice(null);
    toIdle();
  }, [commit, showNotice, toIdle]);

  // Release the microphone when the page is hidden (idle) or leaves; reopened on the next tap.
  useEffect(() => {
    mounted.current = true;
    const ctrls = controllers.current;
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      if (phaseRef.current === "recording") void stop("manual");
      else if (phaseRef.current === "idle") {
        mic.current?.dispose();
        mic.current = null;
      }
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onHidden);
      clearTurnTimer();
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      for (const c of ctrls) c.abort();
      recording.current?.segmenter.dispose();
      capture.current?.cancel();
      mic.current?.dispose();
      mic.current = null;
    };
  }, [clearTurnTimer, stop]);

  return { phase, side, turns, error, notice, secondsLeft, toggle, retry, retrySegment, dismissError, sayPhrase, clear };
}

export type Conversation = ReturnType<typeof useConversation>;
