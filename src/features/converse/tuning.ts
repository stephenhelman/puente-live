import { applyTuningParams, DEFAULT_TUNING, PRESENTER_TUNING, type Tuning } from "@/engine";

/**
 * Live-translation tuning. The values, their ranges and the URL parameters live in the engine (src/engine/tuning.ts);
 * rationale and measurements: src/engine/README.md, "Phrase boundaries".
 */
export const TUNING: Tuning = DEFAULT_TUNING;
/**
 * /converse's own defaults: the presenter values (short phrases that translate while the person keeps talking), so a long
 * turn is read phrase by phrase instead of in one 28-word block. Forced Finalize stays off. URL parameters still override.
 */
export const CONVERSE_TUNING: Tuning = PRESENTER_TUNING;
export type { Tuning };

/**
 * Field-tuning without a redeploy: /converse?ep=300&pause=450&max=14&age=4000&quiet=600&hold=1000&ctx=3. `base` is the
 * page's own defaults (a later page can pass different ones). Out-of-range numbers are clamped, junk is ignored.
 */
export function getTuning(base: Tuning = TUNING): Tuning {
  if (typeof window === "undefined") return base;
  return applyTuningParams(base, new URLSearchParams(window.location.search));
}
