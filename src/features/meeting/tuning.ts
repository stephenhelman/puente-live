import { DEFAULT_PROFILE, parseProfile, type GlossaryProfile } from "@/engine";
import { getTuning, TUNING, type Tuning } from "@/features/converse/tuning";

export const MAX_SESSION_MINUTES = 180;
/** The "ending soon" warning appears this long before the cap (2:50 for the default 3 h). */
export const WARN_BEFORE_END_MINUTES = 10;

export interface MeetingTuning extends Tuning {
  maxSessionMs: number;
  warnAtMs: number;
}

/**
 * Which glossary profile to use: `?profile=hemophilia` overrides the page's default (testing). An unknown name is
 * ignored rather than trusted.
 */
export function getProfile(fallback: GlossaryProfile = DEFAULT_PROFILE): GlossaryProfile {
  if (typeof window === "undefined") return fallback;
  return parseProfile(new URLSearchParams(window.location.search).get("profile")) ?? fallback;
}

/**
 * Same phrase-boundary values as /converse (see src/engine/README.md, "Meeting mode"). Field overrides: the engine's
 * tuning parameters (ep, pause, max, age, quiet, hold, ctx) and `?mins=60` for the session length in MINUTES (it used to be
 * `?max=`, which now means max words). `defaults` is the page's own phrase-boundary defaults.
 */
export function getMeetingTuning(defaults: Tuning = TUNING): MeetingTuning {
  const base = getTuning(defaults);
  const q = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const raw = q.get("mins");
  const m = Number(raw);
  const minutes = raw !== null && raw.trim() !== "" && Number.isFinite(m) && m >= 1 && m <= 600 ? m : MAX_SESSION_MINUTES;
  const maxSessionMs = minutes * 60_000;
  return { ...base, maxSessionMs, warnAtMs: Math.max(0, maxSessionMs - Math.min(WARN_BEFORE_END_MINUTES, minutes / 2) * 60_000) };
}
