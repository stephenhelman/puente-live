import { DeepgramSttProvider, detectLang, PhraseSegmenter, startContinuousStt, type ContinuousSttSession, type Lang, type SttResult } from "@/engine";
import { getDeepgramToken } from "@/features/audio/token";
import { openPcmTap, STT_SAMPLE_RATE, type PcmTap } from "@/features/audio/streamPcm";
import type { MeetingTuning } from "./tuning";
import type { SourceId } from "./transcript";

const provider = new DeepgramSttProvider();

export type SourceStatus = "live" | "reconnecting" | "failed" | "ended";

export interface PhraseEvent {
  source: SourceId;
  text: string;
  lang: Lang;
  /** performance.now() estimate of when the speaker's last word ended; undefined without word timing. */
  endedAtLocal?: number;
  /** performance.now() when the phrase left the segmenter. */
  emittedAtLocal: number;
}

export interface CaptionSourceOptions {
  id: SourceId;
  stream: MediaStream;
  tuning: MeetingTuning;
  onPhrase: (e: PhraseEvent) => void;
  /** Words heard but not yet a phrase (finalized-but-buffered plus the current interim). */
  onTail: (id: SourceId, text: string) => void;
  onStatus: (id: SourceId, s: SourceStatus, reason?: string) => void;
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
  private stopped = false;

  constructor(private readonly o: CaptionSourceOptions) {
    this.segmenter = new PhraseSegmenter((text, info) => {
      const { lang } = detectLang(info.words, text, this.lastLang);
      this.lastLang = lang;
      this.o.onPhrase({
        source: o.id,
        text,
        lang,
        endedAtLocal: info.endSec !== undefined ? this.origin + info.endSec * 1000 : undefined,
        emittedAtLocal: performance.now(),
      });
    }, o.tuning.segmenter);
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
      onResult: (r) => this.onResult(r),
      onDrop: () => {
        this.flushAll();
        this.origin = performance.now();
      },
      onStatus: (s, info) => {
        if (!this.stopped) this.o.onStatus(this.o.id, s, info?.reason);
      },
    });
    this.origin = performance.now();
    this.tap.onChunk = (pcm) => this.session?.sendAudio(pcm);
    this.o.onStatus(this.o.id, "live");
  }

  private onResult(r: SttResult) {
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
