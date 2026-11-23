import type { Direction, Lang } from "../types";

/** What the model reports the phrase was spoken in. "mixed" = substantial amounts of both languages. */
export type SourceLang = Lang | "mixed";

/** An earlier phrase from the same turn, given to the model so the next phrase reads as a continuation. */
export interface ContextPair {
  /** What the speaker said. */
  source: string;
  /** What the listener has already been shown, if it has arrived yet. */
  translation?: string;
}

export interface TranslateRequest {
  text: string;
  /**
   * Fixed direction (/converse, where the speaker's side says who is talking). Omit it for AUTO mode (meeting,
   * presentation): the model decides the source language from the words and translates into the other one.
   */
  direction?: Direction;
  /** Auto mode only: the speech recognizer's guess at the language. A hint for ties, never the decider. */
  hint?: Lang;
  /**
   * Phrase mode: earlier phrases of the SAME turn, oldest first. The model translates only `text`, continuing
   * naturally from them, and never rewrites them. Per-turn only; callers must not persist it.
   */
  context?: ContextPair[];
}

export interface TranslateResult {
  text: string;
  /** Auto mode: the language the model says the phrase was spoken in (absent in fixed-direction mode). */
  sourceLang?: SourceLang;
  model: string;
  /** Wall-clock time of the vendor call, ms. */
  latencyMs: number;
  /** Streaming only: time from request to the first text delta, ms. */
  firstDeltaMs?: number;
  /** Fragments the leak filter removed from the model's output (meta-commentary, a repeated previous phrase). */
  leaks?: string[];
  /** Why the model stopped. Anything but a normal end means the text was retried or is suspect. */
  stopReason?: string;
  /** True when the first attempt was cut off or incomplete and this text comes from a retry. */
  retried?: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

/** Events from translateStream: zero or more deltas, then exactly one done (errors are thrown). */
export type TranslateStreamEvent =
  | { type: "delta"; text: string }
  /** Auto mode: the model's source_language, sent as soon as it is known (before the first text delta). */
  | { type: "source"; lang: SourceLang }
  | { type: "done"; result: TranslateResult };

export interface Translator {
  translate(req: TranslateRequest): Promise<TranslateResult>;
  /** Same translation, yielded as it is generated. Abort with `signal`. */
  translateStream(req: TranslateRequest, opts?: { signal?: AbortSignal }): AsyncGenerator<TranslateStreamEvent>;
}
