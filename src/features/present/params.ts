/** /present's phrase-boundary defaults: the presenter values, defined once in the engine (shared with /converse). */
export { PRESENTER_TUNING } from "@/engine";

export type Align = "bottom" | "top" | "center";
export type Bg = "transparent" | "dark";
export type CaptionStyle = "box" | "outline" | "none";

/** Named colors accepted by ?color= (anything else must be a 3- or 6-digit hex, written without "#"). */
export const COLOR_NAMES = [
  "white", "yellow", "black", "red", "orange", "gold", "lime", "green", "cyan", "aqua", "blue", "skyblue", "lightblue",
  "magenta", "pink", "purple", "violet", "silver", "gray", "grey", "lightgray", "lightgrey", "ivory", "beige",
] as const;

export interface PresentParams {
  /** Part of the input device's label ("BlackHole", "CABLE Output"). Empty = use the device saved from the list. */
  device: string;
  /** Translation text size in px (at the browser source's own width/height). */
  size: number;
  /** How many lines of translation the fixed-height strip holds. */
  lines: number;
  align: Align;
  bg: Bg;
  /** OBS scene names that get the large full-screen layout. */
  full: string[];
  /** Seconds of silence after which the captions clear (0 = never). */
  clearSec: number;
  /** The operator control bar (hover / key press). `controls=0` removes it; the hotkeys still work. */
  controls: boolean;
  /** Readability treatment: a dark box behind the words, a dark outline, or nothing. */
  style: CaptionStyle;
  /** Translation text color: a CSS color name from COLOR_NAMES, or "#rrggbb"/"#rgb". */
  color: string;
  /** Opacity of the box behind the text (style=box). */
  opacity: number;
}

export const PRESENT_DEFAULTS: PresentParams = {
  device: "",
  size: 56,
  lines: 2,
  align: "bottom",
  bg: "transparent",
  full: [],
  clearSec: 6,
  controls: true,
  style: "box",
  color: "white",
  opacity: 0.75,
};

export const PRESENT_RANGES = {
  size: { min: 16, max: 220 },
  lines: { min: 1, max: 6 },
  clearSec: { min: 0, max: 120 },
  opacity: { min: 0.3, max: 1 },
} as const;

function clampInt(raw: string | null, min: number, max: number, fallback: number, zeroOk = false): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const w = Math.round(n);
  if (zeroOk && w <= 0) return 0;
  return Math.min(max, Math.max(min, w));
}

/** A valid ?color= value as a CSS color ("#" added to hex), or the default. */
export function parseColor(raw: string | null): string {
  const v = (raw ?? "").trim().toLowerCase();
  if ((COLOR_NAMES as readonly string[]).includes(v)) return v;
  if (/^([0-9a-f]{3}|[0-9a-f]{6})$/.test(v)) return `#${v}`;
  return PRESENT_DEFAULTS.color;
}

function parseOpacity(raw: string | null): number {
  if (raw === null || raw.trim() === "") return PRESENT_DEFAULTS.opacity;
  const n = Number(raw);
  if (!Number.isFinite(n)) return PRESENT_DEFAULTS.opacity;
  return Math.round(Math.min(PRESENT_RANGES.opacity.max, Math.max(PRESENT_RANGES.opacity.min, n)) * 100) / 100;
}

/** Scene names separated by "|" or ",", trimmed, empty ones dropped. */
export function parseSceneList(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(/[|,]/).map((s) => s.trim()).filter(Boolean);
}

/** Reads /present's URL parameters. Anything missing or invalid keeps its default; numbers are clamped. */
export function parsePresentParams(search: string | URLSearchParams): PresentParams {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  const d = PRESENT_DEFAULTS;
  const align = q.get("align");
  const bg = q.get("bg");
  const style = q.get("style");
  return {
    device: (q.get("device") ?? "").trim().slice(0, 120),
    size: clampInt(q.get("size"), PRESENT_RANGES.size.min, PRESENT_RANGES.size.max, d.size),
    lines: clampInt(q.get("lines"), PRESENT_RANGES.lines.min, PRESENT_RANGES.lines.max, d.lines),
    align: align === "top" || align === "center" || align === "bottom" ? align : d.align,
    bg: bg === "dark" ? "dark" : "transparent",
    full: parseSceneList(q.get("full")),
    clearSec: clampInt(q.get("clear"), 1, PRESENT_RANGES.clearSec.max, d.clearSec, true),
    controls: q.get("controls") !== "0",
    style: style === "outline" || style === "none" || style === "box" ? style : d.style,
    color: parseColor(q.get("color")),
    opacity: parseOpacity(q.get("opacity")),
  };
}

/**
 * The query string that reproduces `p` (only what differs from the defaults) plus any extra parameters (profile, fin, ep...).
 * Used by the setup page to build the OBS URL.
 */
export function buildPresentQuery(p: Partial<PresentParams>, extra: Record<string, string> = {}): string {
  const d = PRESENT_DEFAULTS;
  const q = new URLSearchParams();
  if (p.device?.trim()) q.set("device", p.device.trim());
  if (p.size !== undefined && p.size !== d.size) q.set("size", String(p.size));
  if (p.lines !== undefined && p.lines !== d.lines) q.set("lines", String(p.lines));
  if (p.align && p.align !== d.align) q.set("align", p.align);
  if (p.bg && p.bg !== d.bg) q.set("bg", p.bg);
  if (p.full?.length) q.set("full", p.full.join("|"));
  if (p.clearSec !== undefined && p.clearSec !== d.clearSec) q.set("clear", String(p.clearSec));
  if (p.controls === false) q.set("controls", "0");
  if (p.style && p.style !== d.style) q.set("style", p.style);
  if (p.color && parseColor(p.color.replace(/^#/, "")) !== d.color) q.set("color", parseColor(p.color.replace(/^#/, "")).replace(/^#/, ""));
  if (p.opacity !== undefined && parseOpacity(String(p.opacity)) !== d.opacity) q.set("opacity", String(parseOpacity(String(p.opacity))));
  for (const [k, v] of Object.entries(extra)) if (v.trim()) q.set(k, v.trim());
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** "strip" (the fixed caption strip) or "full" (large, full screen) for the OBS scene that is on air. */
export function layoutForScene(scene: string | null, full: string[]): "strip" | "full" {
  if (!scene) return "strip";
  const s = scene.trim().toLowerCase();
  return full.some((f) => f.trim().toLowerCase() === s) ? "full" : "strip";
}
