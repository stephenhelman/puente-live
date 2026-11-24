import {
  DeepgramSttProvider,
  classifyPhrase,
  directionFor,
  isAlreadyIn,
  PhraseSegmenter,
  startContinuousStt,
  type ContinuousSttSession,
  type CutReason,
  type Lang,
  type SttResult,
  type Timers,
} from "@/engine";
import { getDeepgramToken } from "@/features/audio/token";
import { rmsLevel } from "@/features/audio/level";
import { openPcmTap, STT_SAMPLE_RATE, type PcmTap } from "@/features/audio/streamPcm";
import type { MeetingTuning } from "./tuning";
import type { SourceId } from "./transcript";

const provider = new DeepgramSttProvider();
/** Biases language=multi toward the two languages in use. Bias only: the vendor can still return others (filtered below). */
const LANGUAGE_HINTS = ["en", "es"];

export type SourceStatus = "live" | "reconnecting" | "failed" | "ended";

export interface PhraseEvent {
  source: SourceId;
  text: string;
  lang: Lang;
  /** performance.now() estimate of when the speaker's last word ended; undefined without word timing. */
  endedAtLocal?: number;
  /** Which segmenter rule ended the phrase (debug). */
  cut: CutReason;
  /** performance.now() when the phrase left the segmenter. */
  emittedAtLocal: number;
  /** Wall-clock ms when the phrase began being SPOKEN (vendor first-word start time mapped to the local clock). */
  spokenAt: number;
  /** DEBUG ONLY: the word-list heuristic thinks the phrase is already in the other language. Never changes the output. */
  alreadyHint: boolean;
}

export interface SourceHealth {
  /** Largest gap between two audio chunks from the worklet (nominally ~50 ms), ms. */
  maxChunkGapMs: number;
  /** Largest gap between two messages from the vendor while audio flowed (nominally <= 2 s), ms. */
  maxResultGapMs: number;
  /** Phrases dropped as phantom languages / non-Latin script. */
  filtered: number;
  /** Forced Finalize messages sent to the vendor (0 unless ?fin= is set). */
  finalizes: number;
  /** Words put back after a forced cut (the vendor returned them in an interim, then dropped them from its final). */
  restored: number;
}

export interface CaptionSourceOptions {
  id: SourceId;
  stream: MediaStream;
  tuning: MeetingTuning;
  /** Deepgram `keyterm` list of the active glossary profile (see glossaryKeyterms). */
  keyterms: string[];
  onPhrase: (e: PhraseEvent) => void;
  /** Words heard but not yet a phrase (finalized-but-buffered plus the current interim). */
  onTail: (id: SourceId, text: string) => void;
  onStatus: (id: SourceId, s: SourceStatus, reason?: string) => void;
  /** A phrase was discarded by the phantom-language filter (debug). */
  onFiltered?: (id: SourceId, text: string, reason: string) => void;
  /** Timers that are not throttled in a background window. */
  timers?: Timers;
  /** Input level of every audio chunk (~50 ms), 0-1 RMS. Keeps reporting while paused, so an operator still sees the signal. */
  onLevel?: (rms: number) => void;
}

/**
 * One audio source -> its own long-lived Deepgram socket -> phrase segmenter -> language-tagged phrases.
 * Two of these run side by side for a meeting (never mixed).
 */
export class CaptionSource {
  private tap: PcmTap | null = null;
  private session: ContinuousSttSession | null = null;
  private segmenter: PhraseSegmenter;
  private interim = "";
  private lastLang: Lang | null = null;
  /** performance.now() corresponding to vendor time 0 of the current socket. */
  private origin = 0;
  /** Date.now() at the same instant as `origin`, to turn vendor times into wall-clock times. */
  private originEpoch = 0;
  private stopped = false;
  private lastChunkAt = 0;
  private lastResultAt = 0;
  private filtered = 0;
  private maxChunkGapMs = 0;
  private maxResultGapMs = 0;
  private lastFinalizes = 0;
  private lastRestored = 0;
  private paused = false;
  /** Seconds of audio sent on the current socket = the vendor's clock (its word times count the audio it received). */
  private sentSec = 0;
  /** Words the vendor timed before this are from audio sent before a pause: drop them. 0 = no filter. */
  private dropBeforeSec = 0;

  constructor(private readonly o: CaptionSourceOptions) {
    this.segmenter = new PhraseSegmenter(
      (rawText, info) => {
        const verdict = classifyPhrase(info.words, rawText, this.lastLang);
        if (!verdict.keep) {
          this.filtered++;
          this.o.onFiltered?.(o.id, rawText, verdict.reason);
          return;
        }
        const { lang, text } = verdict;
        this.lastLang = lang;
        this.o.onPhrase({
          source: o.id,
          text,
          lang,
          cut: info.cut,
          endedAtLocal: info.endSec !== undefined ? this.origin + info.endSec * 1000 : undefined,
          emittedAtLocal: performance.now(),
          spokenAt: info.startSec !== undefined ? this.originEpoch + info.startSec * 1000 : Date.now(),
          alreadyHint: isAlreadyIn(directionFor(lang).to, info.words, text),
        });
      },
      o.tuning.segmenter,
      undefined,
      o.timers,
    );
    // Ends the source if its audio ends (the user clicked "Stop sharing", or unplugged the mic).
    o.stream.getAudioTracks().forEach((t) => t.addEventListener("ended", () => void this.end("ended"), { once: true }));
  }

  /** Throws if the first connection fails. */
  async start() {
    this.tap = await openPcmTap(this.o.stream);
    this.session = await startContinuousStt(provider, {
      getToken: getDeepgramToken,
      sampleRate: STT_SAMPLE_RATE,
      endpointingMs: this.o.tuning.endpointingMs,
      languageHints: LANGUAGE_HINTS,
      keyterms: this.o.keyterms,
      forceFinalizeMs: this.o.tuning.finalizeMs,
      timers: this.o.timers,
      onResult: (r) => this.onResult(r),
      onDrop: () => {
        this.flushAll();
        this.origin = performance.now();
        this.originEpoch = Date.now();
        // The replacement socket's clock restarts at zero: a pause point on the old clock means nothing there.
        this.sentSec = 0;
        this.dropBeforeSec = 0;
      },
      onStatus: (s, info) => {
        if (!this.stopped) this.o.onStatus(this.o.id, s, info?.reason);
      },
    });
    this.origin = performance.now();
    this.originEpoch = Date.now();
    this.lastChunkAt = this.lastResultAt = this.origin;
    this.tap.onChunk = (pcm) => {
      const now = performance.now();
      this.maxChunkGapMs = Math.max(this.maxChunkGapMs, now - this.lastChunkAt);
      this.lastChunkAt = now;
      this.o.onLevel?.(rmsLevel(pcm));
      if (this.paused) return; // nothing is sent while paused; the provider's keep-alive holds the socket open
      this.sentSec += pcm.byteLength / 2 / STT_SAMPLE_RATE;
      this.session?.sendAudio(pcm);
    };
    this.o.onStatus(this.o.id, "live");
  }

  health(): SourceHealth {
    return {
      maxChunkGapMs: this.maxChunkGapMs,
      maxResultGapMs: this.maxResultGapMs,
      filtered: this.filtered,
      finalizes: this.session?.finalizesSent ?? this.lastFinalizes,
      restored: this.session?.wordsRestored ?? this.lastRestored,
    };
  }

  /**
   * Pause: stop sending audio, throw away what is buffered (finalized-but-unemitted words and the interim), and ignore
   * everything the vendor still returns for audio sent before the pause. Nothing said while paused can reach the captions.
   */
  setPaused(paused: boolean) {
    if (this.stopped || paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.discard();
      this.dropBeforeSec = this.sentSec; // on resume, words timed before this are stale
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Forget the words heard so far without emitting them (an operator cleared the screen, or paused). */
  discard() {
    this.segmenter.discard();
    this.interim = "";
    this.o.onTail(this.o.id, "");
  }

  private onResult(raw: SttResult) {
    this.maxResultGapMs = Math.max(this.maxResultGapMs, raw.receivedAt - this.lastResultAt);
    this.lastResultAt = raw.receivedAt;
    if (this.paused) return; // late results for audio sent before the pause
    const r = this.dropStale(raw);
    this.interim = r.isFinal ? "" : r.text;
    this.segmenter.push(r);
    this.o.onTail(this.o.id, [this.segmenter.pending, this.interim].filter(Boolean).join(" "));
  }

  /**
   * After a resume, results can still carry words from the audio sent before the pause. Their vendor time is before
   * `dropBeforeSec`, so they are removed (the result keeps its flags, so the segmenter's deadlines still advance).
   */
  private dropStale(r: SttResult): SttResult {
    if (this.dropBeforeSec <= 0 || r.words.length === 0) return r;
    const keep = r.words.filter((w) => w.start >= this.dropBeforeSec - 0.02);
    if (keep.length === r.words.length) return r;
    return { ...r, words: keep, text: keep.map((w) => w.word).join(" ") };
  }

  /** Words Deepgram never finalized still count; then everything becomes phrases. */
  private flushAll() {
    if (this.interim.trim()) this.segmenter.addFinalText(this.interim);
    this.interim = "";
    this.segmenter.flush();
    this.o.onTail(this.o.id, "");
  }

  private async end(status: SourceStatus) {
    if (this.stopped) return;
    this.stopped = true;
    this.flushAll();
    this.segmenter.dispose();
    this.lastFinalizes = this.session?.finalizesSent ?? this.lastFinalizes;
    this.lastRestored = this.session?.wordsRestored ?? this.lastRestored;
    this.session?.close();
    this.tap?.dispose();
    this.o.stream.getTracks().forEach((t) => t.stop());
    this.o.onStatus(this.o.id, status);
  }

  stop() {
    return this.end("ended");
  }
}
