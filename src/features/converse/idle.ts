/**
 * A turn never has a length limit. It ends when the speaker taps, or after this long WITHOUT ANYONE SPEAKING (no words
 * recognised), so a long answer is never cut off while the person is still talking.
 */
export const DEFAULT_IDLE_SECONDS = 60;
export const MIN_IDLE_SECONDS = 10;
export const MAX_IDLE_SECONDS = 600;

/** `?idle=` in seconds. Out of range numbers are clamped; anything else keeps the default. (No "off": the mic must not stay open for ever.) */
export function parseIdleSeconds(search: string | URLSearchParams): number {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  const raw = q.get("idle");
  if (raw === null || raw.trim() === "") return DEFAULT_IDLE_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_IDLE_SECONDS;
  return Math.min(MAX_IDLE_SECONDS, Math.max(MIN_IDLE_SECONDS, Math.round(n)));
}

/** How long before the stop the warning shows: 10 s, or a third of a short limit. */
export function warnSeconds(idleSec: number): number {
  return Math.min(10, Math.max(3, Math.ceil(idleSec / 3)));
}

export interface SilenceState {
  /** Whole seconds until the auto-stop (never negative). */
  secondsLeft: number;
  /** Inside the warning window: tell the speaker it is about to stop. */
  warn: boolean;
  expired: boolean;
}

/** Where a turn stands, given when someone last spoke (or the turn began, if nobody has yet). */
export function silenceState(now: number, lastVoiceAt: number, idleSec: number): SilenceState {
  const leftMs = idleSec * 1000 - (now - lastVoiceAt);
  const expired = leftMs <= 0;
  const secondsLeft = expired ? 0 : Math.ceil(leftMs / 1000);
  return { secondsLeft, warn: !expired && secondsLeft <= warnSeconds(idleSec), expired };
}
