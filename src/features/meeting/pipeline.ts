import type { ContextPair, GlossaryProfile, Lang, SourceLang } from "@/engine";
import type { StreamResult } from "@/features/converse/streamTranslate";
import type { CaptionEntry, SourceId } from "./transcript";

export interface PhraseInput {
  source: SourceId;
  lang: Lang;
  text: string;
  /** Wall-clock ms when the phrase was spoken. */
  spokenAt: number;
  /** Glossary profile for this phrase's translation (kept for its retries). Default: "chapter". */
  profile?: GlossaryProfile;
  /** DEBUG ONLY: a word-list heuristic thinks the phrase is already in the other language. Never changes what is shown. */
  alreadyHint?: boolean;
}

export interface TranslateCall {
  text: string;
  /** The recognizer's guess at the language: a hint for the model, which decides the direction itself. */
  hint: Lang;
  profile?: GlossaryProfile;
  context: ContextPair[];
  /** Growing text while it streams. */
  onText: (soFar: string) => void;
  onResult: (r: StreamResult) => void;
  /** What language the model says the phrase was spoken in (may be called twice; the last call wins). */
  onSource: (lang: SourceLang) => void;
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
  /** Debug: the isAlreadyIn word-list heuristic fired. It changes nothing on screen. */
  | { kind: "already-hint"; id: number }
  /** Debug: the model returned the phrase unchanged (expected only for names and acronyms). */
  | { kind: "unchanged"; id: number }
  | { kind: "untranslated"; id: number }
  | { kind: "first"; id: number }
  | { kind: "done"; id: number };

export interface PipelineOptions {
  translate: TranslateFn;
  /** Earlier phrases of the same source and direction sent as reference context (0-6; see setContextPhrases). */
  contextPhrases?: number;
  /** A translation request with no progress for this long is abandoned and retried. */
  stallMs?: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const sameText = (a: string, b: string) => norm(a) === norm(b);

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
  private readonly profiles = new Map<number, GlossaryProfile>();
  private generation = 0;
  private contextPhrases: number;

  constructor(
    private readonly opts: PipelineOptions,
    private readonly hooks: PipelineHooks,
  ) {
    this.contextPhrases = opts.contextPhrases ?? 6;
  }

  /** How many earlier phrases the next requests carry as context. 0 = none. Takes effect for requests started after the call. */
  setContextPhrases(n: number) {
    this.contextPhrases = Math.max(0, Math.floor(n));
  }

  get entries(): CaptionEntry[] {
    return this.list;
  }

  /** Adds the phrase's slot and starts translating it. Returns the slot id. */
  add(p: PhraseInput, firstText?: () => void, finished?: (r?: StreamResult) => void): number {
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
    if (p.profile) this.profiles.set(id, p.profile);
    this.list = [...this.list, entry];
    this.hooks.onChange(this.list);
    if (p.alreadyHint) this.hooks.onEvent?.({ kind: "already-hint", id });
    const run = this.run(id, firstText, finished).finally(() => this.inflight.delete(run));
    this.inflight.add(run);
    return id;
  }

  retry(id: number) {
    const e = this.list.find((x) => x.id === id);
    if (!e) return;
    const run = this.run(id).finally(() => this.inflight.delete(run));
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
    this.profiles.clear();
    this.hooks.onChange(this.list);
  }

  private patch(id: number, p: Partial<CaptionEntry>) {
    this.list = this.list.map((e) => (e.id === id ? { ...e, ...p } : e));
    this.hooks.onChange(this.list);
  }

  private contextFor(id: number): ContextPair[] {
    const idx = this.list.findIndex((e) => e.id === id);
    const entry = this.list[idx]!;
    if (this.contextPhrases <= 0) return []; // slice(-0) would return everything
    return this.list
      .slice(0, idx)
      .filter((e) => e.source === entry.source && e.lang === entry.lang)
      .slice(-this.contextPhrases)
      .map((e) => ({ source: e.original, translation: e.status === "done" && !e.note && e.translation ? e.translation : undefined }));
  }

  private async run(id: number, firstText?: () => void, finished?: (r?: StreamResult) => void) {
    const gen = this.generation;
    const entry = this.list.find((e) => e.id === id);
    if (!entry) return;
    this.patch(id, { status: "translating", translation: "", note: undefined });
    // The model decides the direction. The recognizer's tag (`entry.lang` until the model answers) is only a hint.
    const hint = entry.lang;
    let sawFirst = false;
    let result: StreamResult | undefined; // the server's final details for the attempt that succeeded (token usage, retried)
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
          hint,
          profile: this.profiles.get(id),
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
            result = r;
          },
          onSource: (lang) => {
            if (gen !== this.generation) return;
            // The model's language replaces the recognizer's. "mixed" keeps the recognizer's majority as the tag.
            this.patch(id, lang === "mixed" ? { mixed: true } : { lang, mixed: false });
          },
        });
        if (gen !== this.generation) return;
        if (text.trim()) {
          if (sameText(text, entry.original)) this.hooks.onEvent?.({ kind: "unchanged", id });
          this.patch(id, { translation: text, status: "done" });
          this.hooks.onEvent?.({ kind: "done", id });
          finished?.(result);
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
