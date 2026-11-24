import type { SourceStatus } from "@/features/meeting/captionSource";

export type LightKey = "listening" | "paused" | "starting" | "reconnecting" | "no-device" | "signed-out" | "failed" | "offline";
export interface Light {
  key: LightKey;
  /** green = working, amber = working on it / paused on purpose, red = needs a person. */
  color: "green" | "amber" | "red";
}

/** The operator's status light. Worst condition wins. Never drawn in the caption area. */
export function statusLight(s: {
  authLost: boolean;
  deviceMissing: boolean;
  offline: boolean;
  source: SourceStatus | "off";
  paused: boolean;
  starting: boolean;
}): Light {
  if (s.authLost) return { key: "signed-out", color: "red" };
  if (s.deviceMissing) return { key: "no-device", color: "red" };
  if (s.source === "failed") return { key: "failed", color: "red" };
  if (s.offline) return { key: "offline", color: "red" };
  if (s.source === "reconnecting") return { key: "reconnecting", color: "amber" };
  if (s.starting || s.source === "off" || s.source === "ended") return { key: "starting", color: "amber" };
  if (s.paused) return { key: "paused", color: "amber" };
  return { key: "listening", color: "green" };
}
