import type { Direction } from "../types";

/** An earlier phrase from the same turn, given to the model so the next phrase reads as a continuation. */
export interface ContextPair {
  /** What the speaker said. */
  source: string;
  /** What the listener has already been shown, if it has arrived yet. */
  translation?: string;
}

export interface TranslateRequest {
  text: string;
  direction: Direction;
  /**
   * Phrase mode: earlier phrases of the SAME turn, oldest first. The model translates only `text`, continuing
   * naturally from them, and never rewrites them. Per-turn only; callers must not persist it.
   */
  context?: ContextPair[];
}

export interface TranslateResult {
  text: string;
  model: string;
  /** Wall-clock time of the vendor call, ms. */
  latencyMs: number;
  /** Streaming only: time from request to the first text delta, ms. */
  firstDeltaMs?: number;
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
  | { type: "done"; result: TranslateResult };

export interface Translator {
  translate(req: TranslateRequest): Promise<TranslateResult>;
  /** Same translation, yielded as it is generated. Abort with `signal`. */
  translateStream(req: TranslateRequest, opts?: { signal?: AbortSignal }): AsyncGenerator<TranslateStreamEvent>;
}
