import { DeepgramSttProvider, type Direction, type SttResult, type SttSession, type SttWord, type TranslateResult } from "@/engine";
import { STT_SAMPLE_RATE } from "@/features/audio/mic";
import { hardNavigate } from "@/lib/nav";
import { getDeepgramToken } from "./token";
import type { Turn } from "./types";

/** If Deepgram never answers a Finalize with from_finalize=true (it may skip it when little audio is buffered). */
const FINALIZE_TIMEOUT_MS = 1500;

let nextId = 1;
const provider = new DeepgramSttProvider();

/**
 * One push-to-talk turn: stream audio to Deepgram, flush on end(), then translate the whole turn once.
 * Audio pushed before the socket is open is queued, so the user can start talking at the press.
 */
export class TurnRunner {
  readonly turn: Turn;
  private session: SttSession | null = null;
  private queue: ArrayBuffer[] = [];
  private audioBytes = 0;
  private endRequested = false;
  private tEnd = 0;
  private finals: SttResult[] = [];
  private lastInterim = "";
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;
  private resolveDone!: () => void;
  readonly done = new Promise<void>((r) => (this.resolveDone = r));

  constructor(
    direction: Direction,
    source: string,
    private readonly endpointingMs: number,
    private readonly onUpdate: (t: Turn) => void,
  ) {
    this.turn = {
      id: nextId++,
      startedAt: new Date().toISOString(),
      direction,
      source,
      status: "listening",
      interim: "",
      transcript: "",
      words: [],
      metrics: {},
    };
    void this.connect();
  }

  private emit() {
    this.onUpdate({ ...this.turn, metrics: { ...this.turn.metrics } });
  }

  private async connect() {
    try {
      this.session = await provider.start({
        getToken: getDeepgramToken,
        sampleRate: STT_SAMPLE_RATE,
        endpointingMs: this.endpointingMs,
        onResult: (r) => this.onResult(r),
        onError: (e) => this.fail(e.message),
        onClose: () => {
          // An unexpected close while we were still waiting counts as the end of the stream.
          if (!this.settled && this.endRequested) void this.finishTranscription(false);
        },
      });
      this.turn.metrics.connectMs = this.session.connectMs;
      this.turn.metrics.tokenRetry = this.session.usedTokenRetry;
      for (const c of this.queue.splice(0)) this.session.sendAudio(c);
      if (this.endRequested) this.sendFinalize();
      this.emit();
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  push(pcm: ArrayBuffer) {
    if (this.settled || this.endRequested) return;
    this.audioBytes += pcm.byteLength;
    if (this.session) this.session.sendAudio(pcm);
    else this.queue.push(pcm);
  }

  /** Call when the speaker releases the button (or the replay file has been fully sent). */
  end() {
    if (this.endRequested || this.settled) return;
    this.endRequested = true;
    this.tEnd = performance.now();
    this.turn.metrics.audioMs = Math.round((this.audioBytes / 2 / STT_SAMPLE_RATE) * 1000);
    this.turn.status = "transcribing";
    this.emit();
    if (this.session) this.sendFinalize();
  }

  private sendFinalize() {
    this.session?.finalize();
    this.finalizeTimer = setTimeout(() => void this.finishTranscription(true), FINALIZE_TIMEOUT_MS);
  }

  private onResult(r: SttResult) {
    if (this.settled) return;
    if (r.isFinal) {
      if (r.text) this.finals.push(r);
      this.lastInterim = "";
    } else {
      this.lastInterim = r.text;
    }
    this.turn.interim = this.lastInterim;
    this.turn.transcript = this.finals.map((f) => f.text).join(" ").trim();
    this.turn.words = this.finals.flatMap((f) => f.words) as SttWord[];
    if (this.endRequested && r.fromFinalize) {
      this.turn.metrics.endOfSpeechToTranscriptMs = Math.round(r.receivedAt - this.tEnd);
      void this.finishTranscription(false);
      return;
    }
    this.emit();
  }

  private async finishTranscription(timedOut: boolean) {
    if (this.settled) return;
    this.settled = true;
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    if (timedOut) {
      this.turn.metrics.finalizeTimedOut = true;
      // Use the last interim text if no final arrived, so nothing the user said is lost.
      if (!this.turn.transcript && this.lastInterim) this.turn.transcript = this.lastInterim;
      this.turn.metrics.endOfSpeechToTranscriptMs = Math.round(performance.now() - this.tEnd);
    }
    this.session?.close();
    this.turn.interim = "";
    if (!this.turn.transcript) {
      this.turn.status = "done";
      this.turn.translation = "";
      this.emit();
      this.resolveDone();
      return;
    }
    this.turn.status = "translating";
    this.emit();
    await this.translate();
    this.resolveDone();
  }

  private async translate() {
    const t0 = performance.now();
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: this.turn.transcript, direction: this.turn.direction }),
      });
      this.turn.metrics.translateRoundTripMs = Math.round(performance.now() - t0);
      if (res.status === 401) {
        hardNavigate("/");
        return;
      }
      const body = (await res.json()) as TranslateResult & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      this.turn.translation = body.text;
      this.turn.model = body.model;
      this.turn.translateUsage = body.usage;
      this.turn.metrics.translateServerMs = Math.round(body.latencyMs);
      this.turn.status = "done";
    } catch (e) {
      this.turn.status = "error";
      this.turn.error = e instanceof Error ? e.message : String(e);
    }
    this.emit();
  }

  private fail(message: string) {
    if (this.settled) return;
    this.settled = true;
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    this.session?.close();
    this.turn.status = "error";
    this.turn.error = message;
    this.emit();
    this.resolveDone();
  }

  /** Abort without translating (e.g. page unmount). */
  cancel() {
    this.fail("cancelled");
  }
}
