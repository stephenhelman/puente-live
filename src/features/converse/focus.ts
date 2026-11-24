import type { Lang } from "@/engine";

/**
 * What a half of the screen is doing. While someone speaks, their half shrinks to a quarter (their button and live words)
 * and the other half, the listener, takes three quarters for the translation. Idle: an even split.
 */
export type PaneRole = "idle" | "speaker" | "listener";

export function paneRole(activeSide: Lang | null, lang: Lang): PaneRole {
  if (activeSide === null) return "idle";
  return activeSide === lang ? "speaker" : "listener";
}

/** Relative heights (flex-grow): 3 : 1 while a turn is on, 1 : 1 otherwise. Mirrored in converse.module.css. */
export const FOCUS_GROW = { idle: 1, speaker: 1, listener: 3 } as const;
