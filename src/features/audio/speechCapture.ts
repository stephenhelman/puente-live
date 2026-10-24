import { DeepgramSttProvider, type SttResult, type SttSession } from "@/engine";
import { STT_SAMPLE_RATE } from "./mic";
import { getDeepgramToken } from "./token";

/** Deepgram may skip from_finalize when little audio is buffered; do not wait forever. */
const FINALIZE_TIMEOUT_MS = 1500;
const CONNECT_TIMEOUT_MS = 10_000;

const provider = new DeepgramSttProvider();

export interface SpeechCaptureOptions {
  /** How long a pause must last before Deepgram marks speech_final (phrase boundary). */
  endpointingMs: number;
  /** Every interim and final result, in order, while recording and during the final flush. */
  onResult: (r: SttResult) => void;
  /** Connection failed or dropped BEFORE finish() was called. After finish(), failures reject finish(). */
  onError: (e: Error) => void;
}

/**
 * One tap-to-talk turn: one Deepgram socket. Audio pushed before the socket is open is queued.
 * Results stream out through onResult as they arrive; call finish() when the user stops to flush the vendor.
 */
export class SpeechCapture {
  private session: SttSession | null = null;
  private queue: ArrayBuffer[] = [];
  private ended = false;
  private closed = false;
  private failure: Error | null = null;
  private settle: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: SpeechCaptureOptions) {
    void this.connect();
  }

  private async connect() {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.fail(new Error("Timed out connecting to speech recognition"));
    }, CONNECT_TIMEOUT_MS);
    try {
      const session = await provider.start({
        getToken: getDeepgramToken,
        sampleRate: STT_SAMPLE_RATE,
        endpointingMs: this.opts.endpointingMs,
        onResult: (r) => this.onResult(r),
        onError: (e) => this.fail(e),
        onClose: () => {
          // Socket closed while we were waiting on the flush: stop waiting and use what we have.
          if (this.ended) this.resolveWaiter();
          else if (!this.closed) this.fail(new Error("Speech recognition connection closed"));
        },
      });
      clearTimeout(timer);
      if (timedOut || this.closed) {
        session.close();
        return;
      }
      this.session = session;
      for (const c of this.queue.splice(0)) session.sendAudio(c);
      if (this.ended) this.sendFinalize();
    } catch (e) {
      clearTimeout(timer);
      if (!timedOut) this.fail(e instanceof Error ? e : new Error(String(e)));
    }
  }

  push(pcm: ArrayBuffer) {
    if (this.ended || this.closed) return;
    if (this.session) this.session.sendAudio(pcm);
    else this.queue.push(pcm);
  }

  /** Stop streaming and flush the vendor. Resolves once the last results have been delivered to onResult. */
  async finish(): Promise<void> {
    this.ended = true;
    if (this.failure) throw this.failure;
    await new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
      if (this.session) this.sendFinalize();
    });
    this.dispose();
  }

  /** Abort without a result. */
  cancel() {
    this.dispose();
  }

  private sendFinalize() {
    this.session?.finalize();
    this.finalizeTimer = setTimeout(() => this.resolveWaiter(), FINALIZE_TIMEOUT_MS);
  }

  private onResult(r: SttResult) {
    if (this.closed) return;
    this.opts.onResult(r);
    if (this.ended && r.fromFinalize) this.resolveWaiter();
  }

  private resolveWaiter() {
    const s = this.settle;
    this.settle = null;
    s?.resolve();
  }

  private fail(e: Error) {
    if (this.closed) return;
    this.failure = e;
    if (this.settle) {
      const s = this.settle;
      this.settle = null;
      this.dispose();
      s.reject(e);
    } else if (!this.ended) {
      this.dispose();
      this.opts.onError(e);
    }
  }

  private dispose() {
    this.closed = true;
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    this.session?.close();
    this.session = null;
    this.queue = [];
  }
}
