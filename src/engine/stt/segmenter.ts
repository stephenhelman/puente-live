import { GLOBAL_TIMERS, type Timers } from "./timers";
import type { SttResult, SttWord } from "./types";

export interface SegmenterOptions {
  /** Emit even without a pause once this many words are buffered (bounds latency for non-stop talkers). */
  maxWords: number;
  /** Emit even without a pause once the buffer has been waiting this long, ms. */
  maxAgeMs: number;
  /** A held fragment (too short / filler only) is emitted anyway after this much quiet, ms. */
  holdMs: number;
  /**
   * A silence this long between two words (from the vendor's word timestamps) ends a phrase. The vendor's own
   * speech_final proved unreliable (it fired 2-5 times on turns with 7+ real pauses), so we do not depend on it.
   */
  pauseMs: number;
  /**
   * Safety net, wall clock: if nothing new has been heard for this long and everything heard is final, emit the
   * buffer. (Promoting un-finalized interim words was tried and rejected: Deepgram's interims can pause over a
   * second mid-sentence, which cut phrases like "I want us" | "start with" and raised word errors from ~4% to 11%.)
   */
  quietMs: number;
}

export const DEFAULT_SEGMENTER_OPTIONS: SegmenterOptions = {
  maxWords: 28,
  maxAgeMs: 8000,
  holdMs: 2500,
  pauseMs: 450,
  quietMs: 900,
};

const FILLERS = new Set(["um", "umm", "uh", "uhh", "er", "erm", "ah", "eh", "hmm", "mm", "mmm", "hm", "este", "pues", "eh,", "o sea"]);
const TERMINAL = /[.?!…]["')»\]]*$/;

/** What the segmenter knows about an emitted phrase beyond its text. */
export interface PhraseInfo {
  /** The vendor's words for this phrase (empty if the text arrived without word detail). */
  words: SttWord[];
  /** Vendor clock (seconds since its stream began) at the start of the first word: when the phrase began being SPOKEN. */
  startSec?: number;
  /** Vendor clock (seconds since its stream began) at the end of the last word; undefined without word detail. */
  endSec?: number;
}

const wordsOf = (t: string) => t.trim().split(/\s+/).filter(Boolean);
const bare = (w: string) => w.toLowerCase().replace(/[.,;:!?¡¿…"'()]/g, "");

/** A fragment we should not translate alone: only filler words, or at most two words with no sentence ending. */
export function isHoldable(text: string): boolean {
  const w = wordsOf(text);
  if (w.length === 0) return false;
  if (w.every((x) => FILLERS.has(bare(x)))) return true;
  return w.length <= 2 && !TERMINAL.test(text.trim());
}

/**
 * Turns a stream of STT results into translatable phrases.
 * Final text is buffered; a phrase is emitted when the vendor signals a natural pause (speech_final),
 * when the buffer gets long, or on flush(). Fragments that are too short are merged into the next phrase.
 */
export class PhraseSegmenter {
  private buf = "";
  private bufWords: SttWord[] = [];
  private firstAt = 0;
  private holdTimer: number | null = null;
  private quietTimer: number | null = null;
  /** Wall time the hold / the last heard text began; lets push() enforce both even if a timer was throttled. */
  private holdAt = 0;
  private heardAt = 0;
  private lastTextWasFinal = true;

  /** End time (seconds, vendor clock) of the last word in the buffer. */
  private lastEnd = -1;
  private disposed = false;

  constructor(
    private readonly onPhrase: (text: string, info: PhraseInfo) => void,
    private readonly opts: SegmenterOptions = DEFAULT_SEGMENTER_OPTIONS,
    private readonly now: () => number = () => Date.now(),
    private readonly timers: Timers = GLOBAL_TIMERS,
  ) {}

  /** Text that has been finalized but not yet emitted as a phrase. */
  get pending(): string {
    return this.buf;
  }

  push(r: SttResult) {
    if (this.disposed) return;
    this.tick();
    if (r.text.trim()) {
      this.heardAt = this.now();
      this.lastTextWasFinal = r.isFinal;
      this.armQuiet();
    }
    if (r.isFinal && r.text.trim()) {
      if (r.words.length > 0) this.appendWords(r.words);
      else this.append(r.text);
    }
    if (!r.isFinal) return;
    // speech_final can arrive on an empty final after the text already came in earlier finals.
    if (!this.buf) return;
    const tooLong = wordsOf(this.buf).length >= this.opts.maxWords || this.now() - this.firstAt >= this.opts.maxAgeMs;
    if (r.speechFinal || tooLong) this.tryEmit();
  }

  /**
   * Enforces the hold and quiet deadlines from the clock. Called for every vendor result (they keep arriving, empty,
   * through silence), so a phrase is never stuck behind a timer the browser delayed in a background window.
   */
  private tick() {
    const t = this.now();
    if (this.holdTimer !== null && t - this.holdAt >= this.opts.holdMs) this.emit();
    else if (this.buf && this.lastTextWasFinal && this.holdTimer === null && t - this.heardAt >= this.opts.quietMs) this.tryEmit();
  }

  /** Word by word, ending the current phrase wherever the timestamps show a real pause. */
  private appendWords(words: SttWord[]) {
    for (const w of words) {
      if (this.buf && this.lastEnd >= 0 && (w.start - this.lastEnd) * 1000 >= this.opts.pauseMs) this.tryEmit();
      this.append(w.word);
      this.bufWords.push(w);
      this.lastEnd = w.end;
    }
  }

  /** Add text that is already final (used when the vendor never finalized the last words). */
  addFinalText(text: string) {
    if (!this.disposed && text.trim()) this.append(text);
  }

  /** End of turn: emit whatever is left, held or not. */
  flush() {
    this.clearHold();
    this.clearQuiet();
    this.emit();
  }

  dispose() {
    this.disposed = true;
    this.clearHold();
    this.clearQuiet();
    this.buf = "";
    this.bufWords = [];
  }

  private append(text: string) {
    if (!this.buf) this.firstAt = this.now();
    this.buf = this.buf ? `${this.buf} ${text.trim()}` : text.trim();
    this.clearHold();
  }

  private tryEmit() {
    if (isHoldable(this.buf)) {
      this.clearHold();
      this.holdAt = this.now();
      this.holdTimer = this.timers.setTimeout(() => this.emit(), this.opts.holdMs);
      return;
    }
    this.emit();
  }

  private emit() {
    this.clearHold();
    const text = this.buf.trim();
    const words = this.bufWords;
    const endSec = this.lastEnd >= 0 ? this.lastEnd : undefined;
    const startSec = words[0]?.start;
    this.buf = "";
    this.bufWords = [];
    this.lastEnd = -1; // also what makes a vendor-clock restart (reconnect) safe: flush() first, then new words
    if (text && !this.disposed) this.onPhrase(text, { words, startSec, endSec });
  }

  private armQuiet() {
    this.clearQuiet();
    this.quietTimer = this.timers.setTimeout(() => {
      this.quietTimer = null;
      // Only when the last thing we heard was final: otherwise words are still waiting to be finalized.
      if (this.buf && this.lastTextWasFinal) this.tryEmit();
    }, this.opts.quietMs);
  }

  private clearQuiet() {
    if (this.quietTimer !== null) this.timers.clearTimeout(this.quietTimer);
    this.quietTimer = null;
  }

  private clearHold() {
    if (this.holdTimer !== null) this.timers.clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }
}
