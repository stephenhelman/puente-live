/** A single recognised word. `language` is the per-word language Deepgram reports when language=multi. */
export interface SttWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  /** BCP-47-ish code from the vendor, e.g. "en", "es". Undefined if the vendor does not report it. */
  language?: string;
}

export interface SttResult {
  text: string;
  /** Segment is final (will not change). Interim results have isFinal=false. */
  isFinal: boolean;
  /** Vendor's endpointing decided the speaker paused. */
  speechFinal: boolean;
  /** This result was produced in response to finalize(). */
  fromFinalize: boolean;
  words: SttWord[];
  /** Languages seen in this segment, most frequent first (if reported). */
  languages: string[];
  /** Local timestamp (performance.now()) when the message was received. */
  receivedAt: number;
}

export interface SttStartOptions {
  /**
   * Returns a short-lived credential. Called on connect, and called ONCE more with a fresh
   * credential if the first connection attempt is rejected (expired token).
   */
  getToken: (opts: { forceRefresh: boolean }) => Promise<string>;
  sampleRate: number;
  /**
   * If set, the provider sends the vendor's keep-alive whenever no audio has been sent for this long, so a quiet or
   * paused source does not get its socket closed for inactivity.
   */
  keepAliveMs?: number;
  /** Silence in ms before the vendor emits speechFinal. */
  endpointingMs: number;
  onResult: (r: SttResult) => void;
  onError: (e: Error) => void;
  onClose: (info: { code: number; reason: string }) => void;
}

/** One live recognition stream (one push-to-talk turn). */
export interface SttSession {
  /** How long the connection took to open, ms (includes a token retry if one happened). */
  readonly connectMs: number;
  /** True if the first connection attempt failed and a refreshed token was used. */
  readonly usedTokenRetry: boolean;
  /** Send 16-bit little-endian mono PCM at `sampleRate`. */
  sendAudio(pcm: ArrayBuffer): void;
  /** Ask the vendor to flush buffered audio into final results now (end of push-to-talk). */
  finalize(): void;
  /** Close the stream politely. */
  close(): void;
}

export interface SttProvider {
  start(opts: SttStartOptions): Promise<SttSession>;
}
