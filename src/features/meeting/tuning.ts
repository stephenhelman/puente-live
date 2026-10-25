import { getTuning, type Tuning } from "@/features/converse/tuning";

export const MAX_SESSION_MINUTES = 180;
/** The "ending soon" warning appears this long before the cap (2:50 for the default 3 h). */
export const WARN_BEFORE_END_MINUTES = 10;

export interface MeetingTuning extends Tuning {
  maxSessionMs: number;
  warnAtMs: number;
}

/**
 * Same phrase-boundary values as /converse (see src/engine/README.md, "Meeting mode"). Field overrides:
 * /meeting?ep=300&pause=450&max=60 (max = session minutes).
 */
export function getMeetingTuning(): MeetingTuning {
  const base = getTuning();
  const q = new URLSearchParams(window.location.search);
  const m = Number(q.get("max"));
  const minutes = Number.isFinite(m) && m >= 1 && m <= 600 && q.get("max") !== null ? m : MAX_SESSION_MINUTES;
  const maxSessionMs = minutes * 60_000;
  return { ...base, maxSessionMs, warnAtMs: Math.max(0, maxSessionMs - Math.min(WARN_BEFORE_END_MINUTES, minutes / 2) * 60_000) };
}
