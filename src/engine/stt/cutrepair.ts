import type { SttResult, SttWord } from "./types";

const bare = (w: string) => w.toLowerCase().replace(/[.,;:!?¡¿…"'()]/g, "");

/**
 * Repairs two kinds of loss a forced Finalize causes that Deepgram's own text can undo.
 *
 * 1. THE VENDOR ANSWERS FINALIZE WITH AN EMPTY FINAL. Measured: in a third of forced runs it threw away a whole pending
 *    segment (16 words: "infusions at home can prevent most joint bleeds before they ever start") that its own interim,
 *    a moment earlier, had shown in full. When the final that answers our Finalize (`from_finalize`) is empty and the last
 *    interim since the previous final had text, that interim is promoted to be the final. Natural empty finals (silence)
 *    are never touched: only ones flagged `from_finalize`, and only when no final with text arrived in between.
 *
 * 2. THE FIRST WORDS OF THE NEXT SEGMENT.
 * Measured (96 forced cuts, synthetic speech): about one word in six cuts is lost where we cut. Half of those words were
 * never returned by the vendor at all (the cut fell inside a short word: both halves failed), and nothing can recover them.
 * The other half WERE returned, in the first interim after the cut ("treatment center"), and then dropped from the final
 * that followed ("center becomes your ..."): the vendor clipped the first word of the new segment when it finalized.
 *
 * So after a forced cut we remember the first interim of the next segment. When that segment's final arrives and starts one
 * or two words LATER than the interim did, those leading words are put back, with the interim's own timestamps. Guards, all
 * required: the previous final was one we forced; the final's first word is exactly the interim's word at that offset (so the
 * two texts are known to describe the same audio); no restored word repeats the final's first word; and the restored words begin
 * after the previous final ended (they are new words, not an echo of it). Only words the vendor returned are ever added.
 */
export class CutRepair {
  private afterForced = false;
  private firstInterim: SttResult | null = null;
  /** The newest interim with text since the last final that had text. */
  private lastInterim: SttResult | null = null;
  private lastEnd = 0;
  private restoredCount = 0;
  private promotedCount = 0;

  /** How many words were put back (leading words of a segment, plus whole interims promoted after an empty forced final). */
  get restored(): number {
    return this.restoredCount + this.promotedCount;
  }

  /** Of those, the words of interims promoted because the vendor answered Finalize with an empty final. */
  get promoted(): number {
    return this.promotedCount;
  }

  /** Forget the pending segment (the socket dropped: its clock restarts). */
  reset() {
    this.afterForced = false;
    this.firstInterim = null;
    this.lastInterim = null;
    this.lastEnd = 0;
  }

  /** Feed every vendor result in order; returns the result to hand on (the same object unless it was repaired). */
  process(r: SttResult): SttResult {
    if (!r.isFinal) {
      if (r.text.trim() && r.words.length > 0) {
        this.lastInterim = r;
        if (this.afterForced && !this.firstInterim) this.firstInterim = r;
      }
      return r;
    }
    if (!r.text.trim() || r.words.length === 0) {
      // Our Finalize came back empty while the vendor's own last interim had words: it discarded them. Promote them.
      const lost = this.lastInterim;
      if (r.fromFinalize && lost) return this.promote(r, lost);
      return r; // a natural empty final (silence) does not end the segment
    }
    this.lastInterim = null;
    const out = this.afterForced && this.firstInterim ? this.repair(r, this.firstInterim) : r;
    this.afterForced = r.fromFinalize; // a final we forced opens the next segment
    this.firstInterim = null;
    this.lastEnd = r.words[r.words.length - 1]!.end;
    return out;
  }

  private promote(empty: SttResult, interim: SttResult): SttResult {
    this.promotedCount += interim.words.length;
    this.afterForced = true; // this is a forced final: the next segment's first interim is watched as usual
    this.firstInterim = null;
    this.lastInterim = null;
    this.lastEnd = interim.words[interim.words.length - 1]!.end;
    return { ...empty, text: interim.text, words: interim.words, languages: interim.languages };
  }

  private repair(final: SttResult, interim: SttResult): SttResult {
    const first = bare(final.words[0]!.word);
    const iw = interim.words;
    for (let j = 1; j <= 2 && j < iw.length; j++) {
      if (bare(iw[j]!.word) !== first) continue;
      const lead: SttWord[] = iw.slice(0, j);
      if (lead.some((w) => bare(w.word) === first)) return final; // a repeated word: ambiguous, leave it
      if (lead[0]!.start < this.lastEnd - 0.05) return final; // it overlaps what the previous final already said
      this.restoredCount += lead.length;
      return { ...final, text: `${lead.map((w) => w.word).join(" ")} ${final.text}`, words: [...lead, ...final.words] };
    }
    return final;
  }
}
