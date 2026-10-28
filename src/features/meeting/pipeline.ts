import type { ContextPair, Direction, Lang } from "@/engine";
import { directionFor } from "@/engine";
import type { CaptionEntry, SourceId } from "./transcript";

export interface PhraseInput {
  source: SourceId;
  lang: Lang;
  text: string;
  /** Wall-clock ms when the phrase was spoken. */
  spokenAt: number;
  /** The phrase is already in the target language: show it as is, make no API call. */
  alreadyInTarget: boolean;
}

export interface TranslateCall {
  text: string;
  direction: Direction;
  context: ContextPair[];
  /** Growing text while it streams. */
  onText: (soFar: string) => void;
  onResult: (r: { leaks?: string[]; retried?: boolean; stopReason?: string }) => void;
  signal: AbortSignal;
}

export type TranslateFn = (call: TranslateCall) => Promise<string>;

export interface PipelineHooks {
  onChange: (entries: CaptionEntry[]) => void;
  /** Debug counters / logs. */
  onEvent?: (e: PipelineEvent) => void;
}

export type PipelineEvent =
  | { kind: "leak"; id: number; leaks: string[] }
  | { kind: "retry"; id: number; why: "empty" | "error" | "stalled" }
  | { kind: "passthrough"; id: number }
  | { kind: "untranslated"; id: number }
  | { kind: "first"; id: number }
  | { kind: "done"; id: number };

export interface PipelineOptions {
  translate: TranslateFn;
  /** Earlier phrases of the same source and direction sent as reference context. */
  contextPhrases?: number;
  /** A translation request with no progress for this long is abandoned and retried. */
  stallMs?: number;
}

/**
 * One slot per phrase, created in the order phrases are spoken and never reordered. Every phrase translates
 * concurrently and fills ONLY its own slot, so a slow or failing request delays nobody else; no phrase ever aborts
 * another's request (the only aborts are `abortAll`, on Clear / leaving the page).
 */
export class CaptionPipeline {
  private list: CaptionEntry[] = [];
  private nextId = 1;
  private readonly controllers = new Set<AbortController>();
  private readonly inflight = new Set<Promise<void>>();
  private generation = 0;

  constructor(
    private readonly opts: PipelineOptions,
    private readonly hooks: PipelineHooks,
  ) {}

  get entries(): CaptionEntry[] {
    return this.list;
  }

  /** Adds the phrase's slot and starts translating it. Returns the slot id. */
  add(p: PhraseInput, firstText?: () => void, finished?: () => void): number {
    const id = this.nextId++;
    const entry: CaptionEntry = {
      id,
      source: p.source,
      at: p.spokenAt,
      lang: p.lang,
      original: p.text,
      translation: "",
      status: "translating",
    };
    this.list = [...this.list, entry];
    this.hooks.onChange(this.list);
    const run = this.run(id, p.alreadyInTarget, firstText, finished).finally(() => this.inflight.delete(run));
    this.inflight.add(run);
    return id;
  }

  retry(id: number) {
    const e = this.list.find((x) => x.id === id);
    if (!e) return;
    const run = this.run(id, false).finally(() => this.inflight.delete(run));
    this.inflight.add(run);
  }

  /** Resolves when every request started so far has settled. */
  idle(): Promise<void> {
    return Promise.allSettled([...this.inflight]).then(() => undefined);
  }

  abortAll() {
    this.generation++;
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
  }

  clear() {
    this.abortAll();
    this.list = [];
    this.hooks.onChange(this.list);
  }

  private patch(id: number, p: Partial<CaptionEntry>) {
    this.list = this.list.map((e) => (e.id === id ? { ...e, ...p } : e));
    this.hooks.onChange(this.list);
  }

  private contextFor(id: number): ContextPair[] {
    const idx = this.list.findIndex((e) => e.id === id);
    const entry = this.list[idx]!;
    return this.list
      .slice(0, idx)
      .filter((e) => e.source === entry.source && e.lang === entry.lang)
      .slice(-(this.opts.contextPhrases ?? 6))
      .map((e) => ({ source: e.original, translation: e.status === "done" && !e.note && e.translation ? e.translation : undefined }));
  }

  private async run(id: number, passthrough: boolean, firstText?: () => void, finished?: () => void) {
    const gen = this.generation;
    const entry = this.list.find((e) => e.id === id);
    if (!entry) return;
    if (passthrough) {
      this.patch(id, { translation: entry.original, status: "done", note: "already" });
      this.hooks.onEvent?.({ kind: "passthrough", id });
      finished?.();
      return;
    }
    this.patch(id, { status: "translating", translation: "", note: undefined });
    const direction = directionFor(entry.lang);
    let sawFirst = false;
    // Attempt 0, then ONE retry: for an error, a stall, or an empty answer alike.
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      this.controllers.add(ctrl);
      let stalled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          stalled = true;
          ctrl.abort();
        }, this.opts.stallMs ?? 20_000);
      };
      arm();
      try {
        const text = await this.opts.translate({
          text: entry.original,
          direction,
          context: this.contextFor(id),
          signal: ctrl.signal,
          onText: (soFar) => {
            arm();
            if (gen !== this.generation) return;
            if (!sawFirst) {
              sawFirst = true;
              this.hooks.onEvent?.({ kind: "first", id });
              firstText?.();
            }
            this.patch(id, { translation: soFar });
          },
          onResult: (r) => {
            if (r.leaks?.length) this.hooks.onEvent?.({ kind: "leak", id, leaks: r.leaks });
          },
        });
        if (gen !== this.generation) return;
        if (text.trim()) {
          this.patch(id, { translation: text, status: "done" });
          this.hooks.onEvent?.({ kind: "done", id });
          finished?.();
          return;
        }
        if (attempt === 0) {
          this.hooks.onEvent?.({ kind: "retry", id, why: "empty" });
          continue;
        }
        // Empty twice: show the original, flagged. A phrase never renders blank.
        this.patch(id, { translation: entry.original, status: "done", note: "untranslated" });
        this.hooks.onEvent?.({ kind: "untranslated", id });
        finished?.();
        return;
      } catch {
        if (gen !== this.generation || (ctrl.signal.aborted && !stalled)) return;
        if (attempt === 0) {
          this.hooks.onEvent?.({ kind: "retry", id, why: stalled ? "stalled" : "error" });
          continue;
        }
        this.patch(id, { status: "error" });
        finished?.();
        return;
      } finally {
        clearTimeout(timer);
        this.controllers.delete(ctrl);
      }
    }
  }
}
