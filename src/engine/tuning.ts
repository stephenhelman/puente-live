import { DEFAULT_SEGMENTER_OPTIONS, type SegmenterOptions } from "./stt/segmenter";

/** Everything that decides how fast captions appear, and how good the phrase boundaries are. One place. */
export interface Tuning {
  /** Deepgram endpointing: silence before it finalizes text and flags speech_final, ms. */
  endpointingMs: number;
  segmenter: SegmenterOptions;
  /** How many earlier phrases are sent as translation context. */
  contextPhrases: number;
  /**
   * Send the vendor's Finalize when interim text has gone this long without a final, ms (see ForcedFinalizer). 0 = off.
   * Off by default everywhere: the vendor can hold its finals ~13 s in continuous speech, which only matters to long-run
   * speakers (presenters).
   */
  finalizeMs: number;
  /** Keep capturing this long after the stop tap: the last syllable is still in the audio pipeline, ms. */
  stopTailMs: number;
}

/** Rationale and measurements: src/engine/README.md, "Phrase boundaries". Pages pass their own defaults to `applyTuningParams`. */
export const DEFAULT_TUNING: Tuning = {
  endpointingMs: 400,
  segmenter: DEFAULT_SEGMENTER_OPTIONS satisfies SegmenterOptions,
  contextPhrases: 6,
  finalizeMs: 0,
  stopTailMs: 300,
};

/**
 * Phrase boundaries for people who speak in long runs (a presenter, someone giving a long answer): short phrases that
 * translate while the speaker keeps talking. The values measured in the tuning work (src/engine/README.md). Forced Finalize
 * stays off. Used by /present and /converse; the URL parameters still override every one.
 */
export const PRESENTER_TUNING: Tuning = {
  ...DEFAULT_TUNING,
  endpointingMs: 300,
  segmenter: { ...DEFAULT_TUNING.segmenter, maxWords: 14, maxAgeMs: 4000, pauseMs: 350, quietMs: 600, holdMs: 1000 },
  contextPhrases: 3,
  finalizeMs: 0,
};

export interface TuningParam {
  /** The URL query parameter. */
  param: string;
  /** What it controls, for the debug panel. */
  label: string;
  unit: "ms" | "words" | "phrases";
  min: number;
  max: number;
  /** 0 (or less) means "off" and is kept as 0 instead of being clamped up to `min`. */
  zeroIsOff?: boolean;
  get(t: Tuning): number;
  set(t: Tuning, v: number): Tuning;
}

const seg = (t: Tuning, patch: Partial<SegmenterOptions>): Tuning => ({ ...t, segmenter: { ...t.segmenter, ...patch } });

/** The URL parameters that tune a session. Values are clamped to [min, max]; non-numeric values are ignored. */
export const TUNING_PARAMS: readonly TuningParam[] = [
  { param: "ep", label: "endpointing", unit: "ms", min: 100, max: 1500, get: (t) => t.endpointingMs, set: (t, v) => ({ ...t, endpointingMs: v }) },
  { param: "pause", label: "word-gap pause", unit: "ms", min: 150, max: 1500, get: (t) => t.segmenter.pauseMs, set: (t, v) => seg(t, { pauseMs: v }) },
  { param: "max", label: "max words", unit: "words", min: 4, max: 80, get: (t) => t.segmenter.maxWords, set: (t, v) => seg(t, { maxWords: v }) },
  { param: "age", label: "max phrase age", unit: "ms", min: 1000, max: 30_000, get: (t) => t.segmenter.maxAgeMs, set: (t, v) => seg(t, { maxAgeMs: v }) },
  { param: "quiet", label: "quiet timeout", unit: "ms", min: 200, max: 3000, get: (t) => t.segmenter.quietMs, set: (t, v) => seg(t, { quietMs: v }) },
  { param: "hold", label: "hold (short fragments)", unit: "ms", min: 200, max: 5000, get: (t) => t.segmenter.holdMs, set: (t, v) => seg(t, { holdMs: v }) },
  { param: "fin", label: "forced Finalize after", unit: "ms", min: 1000, max: 15_000, zeroIsOff: true, get: (t) => t.finalizeMs, set: (t, v) => ({ ...t, finalizeMs: v }) },
  { param: "ctx", label: "translation context", unit: "phrases", min: 0, max: 6, get: (t) => t.contextPhrases, set: (t, v) => ({ ...t, contextPhrases: v }) },
];

/**
 * Applies the URL parameters above to `base` (a page's own defaults). Returns a new object; `base` is untouched. A missing,
 * empty or non-numeric value leaves the default; a number outside the range is clamped; every value is a whole number.
 * `fin` is the one parameter where 0 (or below) is meaningful: it switches the feature off.
 */
export function applyTuningParams(base: Tuning, query: URLSearchParams | string): Tuning {
  const q = typeof query === "string" ? new URLSearchParams(query) : query;
  let t = base;
  for (const p of TUNING_PARAMS) {
    const raw = q.get(p.param);
    if (raw === null || raw.trim() === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    const whole = Math.round(n);
    t = p.set(t, p.zeroIsOff && whole <= 0 ? 0 : Math.min(p.max, Math.max(p.min, whole)));
  }
  return t;
}

/** "ep 400 ms · pause 450 ms · ..." for logs and the copy-stats text. Always lists every parameter. */
export function describeTuning(t: Tuning): string {
  return TUNING_PARAMS.map((p) => `${p.param}=${p.get(t)}`).join(" ");
}
