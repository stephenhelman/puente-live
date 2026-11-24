import { describeTuning, type CutReason, type Tuning } from "@/engine";
import { percentile } from "@/features/debug/stats";

/** Rolling window the stats are computed over (the newest phrases). */
export const TIMING_WINDOW = 200;

/**
 * What one phrase cost, measured in the BROWSER (so it includes the browser -> server -> Anthropic round trip). Times in ms;
 * null = not measured (yet). Never holds the phrase's text, so a report can be pasted anywhere.
 */
export interface PhraseTiming {
  id: number;
  cut: CutReason;
  words: number;
  /** Speaker's last word -> the phrase left the segmenter (null without vendor word timing). */
  speechToEmit: number | null;
  /** Phrase left the segmenter -> first translated text on screen. */
  emitToFirst: number | null;
  /** Phrase left the segmenter -> translation finished. */
  emitToDone: number | null;
  /** Tokens served from the prompt cache for this request (null until the result arrives). */
  cacheRead: number | null;
  inputTokens: number | null;
  retried: boolean;
}

export interface Series {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface TimingStats {
  /** Phrases in the window. */
  n: number;
  speechToEmit: Series;
  emitToFirst: Series;
  emitToDone: Series;
  /** Speaker's last word -> first translated text / finished translation (the sum of the stages above, per phrase). */
  speechToFirst: Series;
  speechToDone: Series;
  cuts: Record<CutReason, number>;
  cache: { requests: number; hits: number; lastRead: number | null; readP50: number | null };
}

export const CUT_REASONS: readonly CutReason[] = ["final", "pause", "quiet", "maxWords", "maxAge", "hold", "flush"];

const series = (values: (number | null)[]): Series => {
  const v = values.filter((x): x is number => x !== null);
  return { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95), max: v.length ? Math.max(...v) : null };
};
const plus = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);

export function computeStats(all: PhraseTiming[]): TimingStats {
  const recs = all.slice(-TIMING_WINDOW);
  const cuts = Object.fromEntries(CUT_REASONS.map((c) => [c, 0])) as Record<CutReason, number>;
  for (const r of recs) cuts[r.cut]++;
  const reads = recs.map((r) => r.cacheRead).filter((x): x is number => x !== null);
  return {
    n: recs.length,
    speechToEmit: series(recs.map((r) => r.speechToEmit)),
    emitToFirst: series(recs.map((r) => r.emitToFirst)),
    emitToDone: series(recs.map((r) => r.emitToDone)),
    speechToFirst: series(recs.map((r) => plus(r.speechToEmit, r.emitToFirst))),
    speechToDone: series(recs.map((r) => plus(r.speechToEmit, r.emitToDone))),
    cuts,
    cache: {
      requests: reads.length,
      hits: reads.filter((x) => x > 0).length,
      lastRead: reads.length ? reads[reads.length - 1]! : null,
      readP50: percentile(reads, 50),
    },
  };
}

const sec = (v: number | null) => (v === null ? "-" : `${(v / 1000).toFixed(2)}s`);
const row = (label: string, s: Series) => `${label.padEnd(26)} ${sec(s.p50).padStart(7)} ${sec(s.p95).padStart(7)} ${sec(s.max).padStart(7)}   n=${s.n}`;

/** The stats table (also the body of the copied text). */
export function formatStatsTable(s: TimingStats): string {
  return [
    `${"".padEnd(26)} ${"p50".padStart(7)} ${"p95".padStart(7)} ${"max".padStart(7)}`,
    row("speech end -> emitted", s.speechToEmit),
    row("emitted -> first text", s.emitToFirst),
    row("emitted -> done", s.emitToDone),
    row("speech end -> first text", s.speechToFirst),
    row("speech end -> done", s.speechToDone),
  ].join("\n");
}

export const formatCuts = (s: TimingStats) => CUT_REASONS.map((c) => `${c} ${s.cuts[c]}`).join(" · ");
export const formatCache = (s: TimingStats) =>
  s.cache.requests === 0
    ? "no results yet"
    : `${s.cache.hits}/${s.cache.requests} requests read from cache · last ${s.cache.lastRead} tokens · median ${s.cache.readP50} tokens`;

/** Plain text for the "copy stats" button. No transcript text. */
export function formatReport(o: {
  tuning: Tuning;
  profile: string;
  stats: TimingStats;
  extra?: string[];
  query?: string;
  now?: Date;
}): string {
  return [
    `Puente Live latency stats - ${(o.now ?? new Date()).toISOString()}`,
    `url params: ${o.query || "(none)"}`,
    `tuning: ${describeTuning(o.tuning)}`,
    `glossary profile: ${o.profile}`,
    `phrases: ${o.stats.n} (last ${TIMING_WINDOW} at most), measured in the browser`,
    "",
    formatStatsTable(o.stats),
    "",
    `cut by: ${formatCuts(o.stats)}`,
    `prompt cache: ${formatCache(o.stats)}`,
    ...(o.extra ?? []),
  ].join("\n");
}
