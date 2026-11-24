import { GLOBAL_TIMERS, type Timers } from "./timers";
import type { SttResult } from "./types";

export interface ForcedFinalizerOptions {
  /** The longest interim text may go without a final before Finalize is sent, ms. 0 (or less) = off. */
  limitMs: number;
  /** Extra wait for the last word to settle when it has not, ms. Default 500. */
  graceMs?: number;
  /**
   * After the interim text SHRANK (the recognizer threw words away: it is reconsidering, typically at a language switch),
   * how long it must then stay without another shrink before we finalize, ms. Default 1500.
   */
  settleMs?: number;
  /**
   * Only finalize while the interim is "live": it changed within this long, ms. Default 2000. An interim that has sat
   * unchanged for seconds while audio flows means the recognizer is stuck (typically deciding on a new language), not
   * that it has settled, and a Finalize then commits audio it has not decoded (measured: ~10 Spanish words lost).
   */
  liveMs?: number;
  /** The most we will ever wait past the limit for a regressing interim to settle, ms. Default 3500. */
  maxHoldMs?: number;
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
 *  - At the limit: if the newest interim has the same length and last word as the previous one (it stopped changing),
 *    finalize at once; otherwise wait up to `graceMs` more for that (finalizing as soon as it happens), then finalize anyway.
 *  - An interim that SHRANK (words disappeared) is not "stable", it is the opposite: the recognizer is reconsidering,
 *    e.g. at an English-to-Spanish switch it drops the Spanish words it had half-heard. Finalizing then commits the
 *    undecoded audio and the words are lost for good (measured: ~10 words each time). So after a shrink we wait until
 *    `settleMs` pass without another one, and never more than `maxHoldMs` past the limit.
 *  - An interim that has NOT changed for `liveMs` is stale (the recognizer is stuck, not settled): we do not finalize it. We
 *    wait for it to change again, then apply the rules above.
 *  - After Finalize, a new interim starts a new interval: at most one Finalize per `limitMs`.
 *  - Deadlines are also enforced from the clock on every vendor result, like the segmenter's, so a throttled timer cannot
 *    delay them for long.
 */
export class ForcedFinalizer {
  private phase: "idle" | "armed" | "grace" | "stale" = "idle";
  /** When the interim text last differed from the one before it. */
  private changedAt = 0;
  private armedAt = 0;
  private prev: string[] | null = null;
  private cur: string[] | null = null;
  /** When the interim last lost words (0 = never in this interval). */
  private shrankAt = 0;
  /** The clock time past which the grace period is over and we finalize regardless. */
  private graceUntil = 0;
  private limitTimer: number | null = null;
  private graceTimer: number | null = null;
  private disposed = false;
  private sent = 0;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly settleMs: number;
  private readonly maxHoldMs: number;
  private readonly liveMs: number;

  constructor(private readonly o: ForcedFinalizerOptions) {
    this.timers = o.timers ?? GLOBAL_TIMERS;
    this.now = o.now ?? (() => Date.now());
    this.graceMs = o.graceMs ?? 500;
    this.settleMs = o.settleMs ?? 1500;
    this.maxHoldMs = o.maxHoldMs ?? 3500;
    this.liveMs = o.liveMs ?? 2000;
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
    if (!this.prev || this.prev.length !== words.length || this.prev.some((w, i) => w !== words[i])) {
      this.changedAt = this.now();
      if (this.phase === "stale") this.enterGrace(); // it moved again: apply the normal rules from here
    }
    if (this.prev && words.length < this.prev.length) {
      this.shrankAt = this.now();
      if (this.phase === "grace") this.extendGrace();
    }
    if (this.phase === "idle") this.arm();
    else if (this.phase === "grace" && this.ready()) this.fire();
  }

  /** Forget the current interval (a final arrived, or the socket dropped and its clock restarts). */
  reset() {
    this.clearTimers();
    this.phase = "idle";
    this.prev = this.cur = null;
    this.shrankAt = 0;
    this.changedAt = 0;
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
    if (!this.live()) {
      this.phase = "stale";
      return;
    }
    if (this.ready()) return this.fire();
    this.enterGrace();
  }

  private enterGrace() {
    if (this.graceTimer !== null) this.timers.clearTimeout(this.graceTimer);
    this.phase = "grace";
    this.graceUntil = this.now() + this.graceMs;
    this.extendGrace(); // a shrink that happened just before the limit holds us longer
    this.armGraceTimer();
  }

  /** The interim changed recently: the recognizer is working, not stuck. */
  private live(): boolean {
    return this.now() - this.changedAt <= this.liveMs;
  }

  /** The recognizer is not stuck, nothing was thrown away lately, and the newest interim is the previous one again. */
  private ready(): boolean {
    if (!this.live()) return false;
    if (this.shrankAt && this.now() - this.shrankAt < this.settleMs) return false;
    return this.stable();
  }

  /** Grace is over: finalize if the recognizer is alive, otherwise wait for it to move. */
  private graceOver() {
    if (this.live()) this.fire();
    else {
      this.clearTimers();
      this.phase = "stale";
    }
  }

  /** The newest interim is the same length as the previous one and ends on the same word: it has stopped changing. */
  private stable(): boolean {
    const { prev, cur } = this;
    if (!prev || !cur || prev.length !== cur.length) return false;
    return prev[cur.length - 1] === cur[cur.length - 1];
  }

  /** After a shrink: wait `settleMs` more, but never beyond `maxHoldMs` past the limit. */
  private extendGrace() {
    const cap = this.armedAt + this.o.limitMs + this.maxHoldMs;
    if (this.shrankAt && this.now() - this.shrankAt < this.settleMs) {
      this.graceUntil = Math.min(cap, Math.max(this.graceUntil, this.shrankAt + this.settleMs));
    }
    if (this.phase === "grace" && this.graceTimer !== null) {
      this.timers.clearTimeout(this.graceTimer);
      this.armGraceTimer();
    }
  }

  private armGraceTimer() {
    this.graceTimer = this.timers.setTimeout(() => {
      this.graceTimer = null;
      if (this.now() >= this.graceUntil) this.graceOver();
      else this.armGraceTimer();
    }, Math.max(0, this.graceUntil - this.now()));
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
    if (this.phase === "grace" && t >= this.graceUntil) this.graceOver();
  }

  private clearTimers() {
    if (this.limitTimer !== null) this.timers.clearTimeout(this.limitTimer);
    if (this.graceTimer !== null) this.timers.clearTimeout(this.graceTimer);
    this.limitTimer = this.graceTimer = null;
  }
}
