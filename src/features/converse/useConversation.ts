"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EN_TO_ES, ES_TO_EN, otherLang, type Direction, type Lang } from "@/engine";
import { openMic, type MicCapture } from "@/features/audio/mic";
import { SpeechCapture } from "@/features/audio/speechCapture";
import { TokenError } from "@/features/audio/token";
import type { ErrorKind } from "./strings";
import { NetworkError, streamTranslate } from "./streamTranslate";
import { PHRASES, phraseText } from "./phrases";

export const MAX_TURN_SECONDS = 60;
export const COUNTDOWN_FROM_SECONDS = 10;
/** Keep capturing briefly after the stop tap: the last syllable is still in the audio pipeline when people tap right after speaking. */
const STOP_TAIL_MS = 300;
const HISTORY_LIMIT = 40; // kept in memory; each half only renders the last few

export type Phase = "idle" | "starting" | "recording" | "processing";

export interface ConvTurn {
  id: number;
  speaker: Lang;
  source: "speech" | "phrase";
  /** What the speaker said (STT transcript, or the tapped phrase). */
  transcript: string;
  /** Translation into the other language (streams in). */
  translation: string;
  status: "translating" | "done" | "error";
}

export interface ConvError {
  kind: ErrorKind;
  side: Lang;
  retry: "start" | "translate";
  turnId?: number;
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

/**
 * All conversation state lives here, in memory only. One turn at a time:
 * idle -> starting -> recording -> processing (transcribe + stream translation) -> idle.
 */
export function useConversation() {
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [side, setSide] = useState<Lang | null>(null);
  const [turns, setTurns] = useState<ConvTurn[]>([]);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<ConvError | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [secondsLeft, setSecondsLeft] = useState(MAX_TURN_SECONDS);

  // Refs mirror state for use inside callbacks/timers that must see the latest value.
  const phaseRef = useRef<Phase>("idle");
  const sideRef = useRef<Lang | null>(null);
  const mic = useRef<MicCapture | null>(null);
  const capture = useRef<SpeechCapture | null>(null);
  const abort = useRef<AbortController | null>(null);
  const turnTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelStart = useRef(false);
  const nextId = useRef(1);
  const mounted = useRef(true);
  /** Bumped by clear(); in-flight stop() calls from an earlier generation drop their results. */
  const generation = useRef(0);

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

  const updateTurn = useCallback((id: number, patch: Partial<ConvTurn>) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const toIdle = useCallback(() => {
    clearTurnTimer();
    setInterim("");
    setActiveSide(null);
    setPhase("idle");
  }, [clearTurnTimer, setActiveSide, setPhase]);

  const failTurn = useCallback(
    (kind: ErrorKind, speaker: Lang, retry: ConvError["retry"], turnId?: number) => {
      setError({ kind, side: speaker, retry, turnId });
      toIdle();
    },
    [toIdle],
  );

  const translateTurn = useCallback(
    async (turnId: number, text: string, speaker: Lang) => {
      updateTurn(turnId, { status: "translating", translation: "" });
      abort.current = new AbortController();
      try {
        const final = await streamTranslate(
          text,
          directionFrom(speaker),
          (soFar) => updateTurn(turnId, { translation: soFar }),
          abort.current.signal,
        );
        updateTurn(turnId, { translation: final, status: "done" });
        toIdle();
      } catch (e) {
        if (abort.current?.signal.aborted || !mounted.current) return;
        updateTurn(turnId, { status: "error" });
        failTurn(e instanceof NetworkError ? "offline" : "translate", speaker, "translate", turnId);
      }
    },
    [failTurn, toIdle, updateTurn],
  );

  const stop = useCallback(
    async (reason: "manual" | "auto") => {
      const speaker = sideRef.current;
      const cap = capture.current;
      if (phaseRef.current !== "recording" || !speaker || !cap) return;
      const gen = generation.current;
      clearTurnTimer();
      capture.current = null;
      setPhase("processing"); // immediately: blocks double taps while the tail is captured
      if (reason === "auto") showNotice("auto-stop");
      await new Promise((r) => setTimeout(r, STOP_TAIL_MS));
      if (gen !== generation.current) {
        cap.cancel();
        return;
      }
      mic.current?.stop();

      let transcript: string;
      try {
        transcript = await cap.finish();
      } catch (e) {
        if (!mounted.current || gen !== generation.current) return;
        failTurn(e instanceof TokenError ? "token" : navigator.onLine ? "stt" : "offline", speaker, "start");
        return;
      }
      if (!mounted.current || gen !== generation.current) return;
      if (!transcript) {
        if (reason !== "auto") showNotice("no-speech");
        toIdle();
        return;
      }
      const id = nextId.current++;
      setTurns((prev) =>
        [...prev, { id, speaker, source: "speech" as const, transcript, translation: "", status: "translating" as const }].slice(
          -HISTORY_LIMIT,
        ),
      );
      setInterim("");
      await translateTurn(id, transcript, speaker);
    },
    [clearTurnTimer, failTurn, setPhase, showNotice, toIdle, translateTurn],
  );

  const start = useCallback(
    async (speaker: Lang) => {
      if (phaseRef.current !== "idle") return;
      setError(null);
      showNotice(null);
      cancelStart.current = false;

      if (!navigator.onLine) {
        setError({ kind: "offline", side: speaker, retry: "start" });
        return;
      }
      setPhase("starting");
      setActiveSide(speaker);

      try {
        mic.current ??= await openMic();
      } catch (e) {
        if (!mounted.current) return;
        failTurn(micErrorKind(e), speaker, "start");
        return;
      }
      if (!mounted.current) return;
      if (cancelStart.current) {
        toIdle();
        return;
      }

      const cap = new SpeechCapture({
        onInterim: setInterim,
        onError: (e) => {
          if (phaseRef.current === "idle") return;
          mic.current?.stop();
          capture.current = null;
          failTurn(e instanceof TokenError ? "token" : navigator.onLine ? "stt" : "offline", speaker, "start");
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
    [failTurn, setActiveSide, setPhase, showNotice, stop, toIdle],
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

  const retry = useCallback(() => {
    const err = error;
    if (!err) return;
    setError(null);
    if (err.retry === "translate" && err.turnId != null) {
      const turn = turns.find((t) => t.id === err.turnId);
      if (turn && phaseRef.current === "idle") {
        setPhase("processing");
        setActiveSide(turn.speaker);
        void translateTurn(turn.id, turn.transcript, turn.speaker);
      }
    } else {
      void start(err.side);
    }
  }, [error, setActiveSide, setPhase, start, translateTurn, turns]);

  const dismissError = useCallback(() => setError(null), []);

  /** Quick phrase: instant, no STT and no API call. */
  const sayPhrase = useCallback((speaker: Lang, phraseId: string) => {
    if (phaseRef.current !== "idle") return;
    const p = PHRASES.find((x) => x.id === phraseId);
    if (!p) return;
    setError(null);
    const id = nextId.current++;
    setTurns((prev) =>
      [
        ...prev,
        {
          id,
          speaker,
          source: "phrase" as const,
          transcript: phraseText(p, speaker),
          translation: phraseText(p, otherLang(speaker)),
          status: "done" as const,
        },
      ].slice(-HISTORY_LIMIT),
    );
  }, []);

  const clear = useCallback(() => {
    generation.current += 1;
    abort.current?.abort();
    capture.current?.cancel();
    capture.current = null;
    mic.current?.stop();
    setTurns([]);
    setError(null);
    showNotice(null);
    toIdle();
  }, [showNotice, toIdle]);

  // Release the microphone when the page is hidden (idle) or leaves; reopened on the next tap.
  useEffect(() => {
    mounted.current = true;
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
      abort.current?.abort();
      capture.current?.cancel();
      mic.current?.dispose();
      mic.current = null;
    };
  }, [clearTurnTimer, stop]);

  return { phase, side, turns, interim, error, notice, secondsLeft, toggle, retry, dismissError, sayPhrase, clear };
}

export type Conversation = ReturnType<typeof useConversation>;
