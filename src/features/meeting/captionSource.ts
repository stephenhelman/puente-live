import {
  DeepgramSttProvider,
  classifyPhrase,
  directionFor,
  glossaryKeyterms,
  isAlreadyIn,
  loadDefaultGlossary,
  PhraseSegmenter,
  startContinuousStt,
  type ContinuousSttSession,
  type Lang,
  type SttResult,
  type Timers,
} from "@/engine";
import { getDeepgramToken } from "@/features/audio/token";
import { openPcmTap, STT_SAMPLE_RATE, type PcmTap } from "@/features/audio/streamPcm";
import type { MeetingTuning } from "./tuning";
import type { SourceId } from "./transcript";

const provider = new DeepgramSttProvider();
/** Biases language=multi toward the two languages in use. Bias only: the vendor can still return others (filtered below). */
const LANGUAGE_HINTS = ["en", "es"];
const KEYTERMS = glossaryKeyterms(loadDefaultGlossary());

export type SourceStatus = "live" | "reconnecting" | "failed" | "ended";

export interface PhraseEvent {
  source: SourceId;
  text: string;
  lang: Lang;
  /** performance.now() estimate of when the speaker's last word ended; undefined without word timing. */
  endedAtLocal?: number;
  /** performance.now() when the phrase left the segmenter. */
  emittedAtLocal: number;
  /** Wall-clock ms when the phrase began being SPOKEN (vendor first-word start time mapped to the local clock). */
  spokenAt: number;
  /** Already in the language it would be translated into: show as is, no API call. */
  alreadyInTarget: boolean;
}

export interface SourceHealth {
  /** Largest gap between two audio chunks from the worklet (nominally ~50 ms), ms. */
  maxChunkGapMs: number;
  /** Largest gap between two messages from the vendor while audio flowed (nominally <= 2 s), ms. */
  maxResultGapMs: number;
  /** Phrases dropped as phantom languages / non-Latin script. */
  filtered: number;
}

export interface CaptionSourceOptions {
  id: SourceId;
  stream: MediaStream;
  tuning: MeetingTuning;
  onPhrase: (e: PhraseEvent) => void;
  /** Words heard but not yet a phrase (finalized-but-buffered plus the current interim). */
  onTail: (id: SourceId, text: string) => void;
  onStatus: (id: SourceId, s: SourceStatus, reason?: string) => void;
  /** A phrase was discarded by the phantom-language filter (debug). */
  onFiltered?: (id: SourceId, text: string, reason: string) => void;
  /** Timers that are not throttled in a background window. */
  timers?: Timers;
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
          endedAtLocal: info.endSec !== undefined ? this.origin + info.endSec * 1000 : undefined,
          emittedAtLocal: performance.now(),
          spokenAt: info.startSec !== undefined ? this.originEpoch + info.startSec * 1000 : Date.now(),
          alreadyInTarget: isAlreadyIn(directionFor(lang).to, info.words, text),
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
      keyterms: KEYTERMS,
      timers: this.o.timers,
      onResult: (r) => this.onResult(r),
      onDrop: () => {
        this.flushAll();
        this.origin = performance.now();
        this.originEpoch = Date.now();
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
      this.session?.sendAudio(pcm);
    };
    this.o.onStatus(this.o.id, "live");
  }

  health(): SourceHealth {
    return { maxChunkGapMs: this.maxChunkGapMs, maxResultGapMs: this.maxResultGapMs, filtered: this.filtered };
  }

  private onResult(r: SttResult) {
    this.maxResultGapMs = Math.max(this.maxResultGapMs, r.receivedAt - this.lastResultAt);
    this.lastResultAt = r.receivedAt;
    this.interim = r.isFinal ? "" : r.text;
    this.segmenter.push(r);
    this.o.onTail(this.o.id, [this.segmenter.pending, this.interim].filter(Boolean).join(" "));
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
    this.session?.close();
    this.tap?.dispose();
    this.o.stream.getTracks().forEach((t) => t.stop());
    this.o.onStatus(this.o.id, status);
  }

  stop() {
    return this.end("ended");
  }
}
