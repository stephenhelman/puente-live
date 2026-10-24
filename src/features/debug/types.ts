import type { Direction, SttWord, TranslateResult } from "@/engine";

export interface TurnMetrics {
  /** Time to open the Deepgram socket, ms (includes token fetch + any retry). */
  connectMs?: number;
  tokenRetry?: boolean;
  /** Release of the button (or last file chunk sent) -> final transcript received. */
  endOfSpeechToTranscriptMs?: number;
  /** True if Deepgram never sent from_finalize and we fell back to the timeout. */
  finalizeTimedOut?: boolean;
  /** Browser-side round trip of /api/translate. */
  translateRoundTripMs?: number;
  /** Server-measured Anthropic call time. */
  translateServerMs?: number;
  /** Length of audio streamed, ms. */
  audioMs?: number;
}

export interface Turn {
  id: number;
  startedAt: string;
  direction: Direction;
  source: string;
  status: "listening" | "transcribing" | "translating" | "done" | "error";
  interim: string;
  transcript: string;
  words: SttWord[];
  translation?: string;
  translateUsage?: TranslateResult["usage"];
  model?: string;
  error?: string;
  metrics: TurnMetrics;
}

export interface DebugSettings {
  endpointingMs: number;
}
