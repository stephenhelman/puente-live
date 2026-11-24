import { GLOBAL_TIMERS, type Timers } from "./timers";
import type { SttResult } from "./types";

export interface ForcedFinalizerOptions {
  /** The longest interim text may go without a final before Finalize is sent, ms. 0 (or less) = off. */
  limitMs: number;
  /** Extra wait for the last word to settle when it has not, ms. Default 500. */
  graceMs?: number;
  /** Sends the vendor's Finalize message. */
  finalize: () => void;
  /** Timers that are not throttled in a background window (a Worker-backed set). Defaults to the globals. */
  timers?: Timers;
  now?: () => number;
}

const bare = (w: string) => w.toLowerCase().replace(/[.,;:!?¡¿…"'()]/g, "");
const wordsOf = (t: string) => t.trim().split(/\s+/).map(bare).filter(Boolean);

/**
 * The vendor can withhold its finals for ~13 s of continuous speech (it only finalizes at pauses or on its own schedule),
 * and the phrase segmenter only cuts on finals, so its max-words / max-age rules cannot act in the meantime. This watches
 * the result stream and, when interim text has been pending longer than `limitMs` without a final, sends Finalize so a
 * final arrives at a moment we choose.
 *
 *  - The clock starts at the first interim text after a final and resets on EVERY final.
 *  - At the limit: if the newest interim's last word is the same word the previous interim had in that position (it stopped
 *    changing), finalize at once; otherwise wait up to `graceMs` more for it to settle (finalizing as soon as it does),
 *    then finalize anyway, so a word is less likely to be cut in half.
 *  - After Finalize, a new interim starts a new interval: at most one Finalize per `limitMs`.
 *  - Deadlines are also enforced from the clock on every vendor result, like the segmenter's, so a throttled timer cannot
 *    delay them for long.
 */
export class ForcedFinalizer {
  private phase: "idle" | "armed" | "grace" = "idle";
  private armedAt = 0;
  private prev: string[] | null = null;
  private cur: string[] | null = null;
  private limitTimer: number | null = null;
  private graceTimer: number | null = null;
  private disposed = false;
  private sent = 0;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly graceMs: number;

  constructor(private readonly o: ForcedFinalizerOptions) {
    this.timers = o.timers ?? GLOBAL_TIMERS;
    this.now = o.now ?? (() => Date.now());
    this.graceMs = o.graceMs ?? 500;
  }

  /** How many Finalize messages were sent. */
  get finalizesSent(): number {
    return this.sent;
  }

  get enabled(): boolean {
    return this.o.limitMs > 0;
  }

  push(r: SttResult) {
    if (!this.enabled || this.disposed) return;
    this.tick();
    if (r.isFinal) {
      this.reset(); // every final, forced or natural, restarts the interval
      return;
    }
    const words = wordsOf(r.text);
    if (words.length === 0) return; // silence: nothing pending
    this.prev = this.cur;
    this.cur = words;
    if (this.phase === "idle") this.arm();
    else if (this.phase === "grace" && this.stable()) this.fire();
  }

  /** Forget the current interval (a final arrived, or the socket dropped and its clock restarts). */
  reset() {
    this.clearTimers();
    this.phase = "idle";
    this.prev = this.cur = null;
  }

  dispose() {
    this.disposed = true;
    this.reset();
  }

  private arm() {
    this.phase = "armed";
    this.armedAt = this.now();
    this.limitTimer = this.timers.setTimeout(() => this.onLimit(), this.o.limitMs);
  }

  private onLimit() {
    this.limitTimer = null;
    if (this.phase !== "armed" || this.disposed) return;
    if (this.stable()) return this.fire();
    this.phase = "grace";
    this.graceTimer = this.timers.setTimeout(() => this.fire(), this.graceMs);
  }

  /** The newest interim's last word is the word the previous interim had in that position. */
  private stable(): boolean {
    const { prev, cur } = this;
    if (!prev || !cur) return false;
    return prev.length >= cur.length && prev[cur.length - 1] === cur[cur.length - 1];
  }

  private fire() {
    if (this.disposed) return;
    this.reset();
    this.sent++;
    this.o.finalize();
  }

  /** Enforces both deadlines from the clock (a throttled timer may not have run). */
  private tick() {
    const t = this.now();
    if (this.phase === "armed" && t - this.armedAt >= this.o.limitMs) {
      this.clearTimers();
      this.onLimit();
    }
    if (this.phase === "grace" && t - this.armedAt >= this.o.limitMs + this.graceMs) this.fire();
  }

  private clearTimers() {
    if (this.limitTimer !== null) this.timers.clearTimeout(this.limitTimer);
    if (this.graceTimer !== null) this.timers.clearTimeout(this.graceTimer);
    this.limitTimer = this.graceTimer = null;
  }
}
