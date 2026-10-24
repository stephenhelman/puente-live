import type { Direction } from "../types";

export interface TranslateRequest {
  text: string;
  direction: Direction;
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
