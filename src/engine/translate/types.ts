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
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

export interface Translator {
  translate(req: TranslateRequest): Promise<TranslateResult>;
}
