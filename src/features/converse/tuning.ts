import { DEFAULT_SEGMENTER_OPTIONS, type SegmenterOptions } from "@/engine";

/**
 * Live-translation tuning. Rationale and measurements: src/engine/README.md, "Phrase boundaries".
 */
export const TUNING = {
  /** Deepgram endpointing: silence before it finalizes text and flags speech_final. */
  endpointingMs: 400,
  segmenter: DEFAULT_SEGMENTER_OPTIONS satisfies SegmenterOptions,
  /** How many earlier phrases of the same turn are sent as translation context. */
  contextPhrases: 6,
  /** Keep capturing this long after the stop tap: the last syllable is still in the audio pipeline. */
  stopTailMs: 300,
};

export type Tuning = typeof TUNING;

function num(v: string | null, min: number, max: number): number | undefined {
  const n = Number(v);
  return v !== null && Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/**
 * Field-tuning without a redeploy: /converse?ep=300&pause=450 overrides endpointing and the word-gap pause (ms).
 * Out-of-range values are ignored.
 */
export function getTuning(): Tuning {
  if (typeof window === "undefined") return TUNING;
  const q = new URLSearchParams(window.location.search);
  const ep = num(q.get("ep"), 100, 1500);
  const pause = num(q.get("pause"), 150, 1500);
  return {
    ...TUNING,
    endpointingMs: ep ?? TUNING.endpointingMs,
    segmenter: { ...TUNING.segmenter, pauseMs: pause ?? TUNING.segmenter.pauseMs },
  };
}
