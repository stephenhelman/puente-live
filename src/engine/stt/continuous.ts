import { GLOBAL_TIMERS, type Timers } from "./timers";
import type { SttProvider, SttResult, SttSession } from "./types";

export type ContinuousStatus = "live" | "reconnecting" | "failed";

export interface ContinuousSttOptions {
  getToken: (opts: { forceRefresh: boolean }) => Promise<string>;
  sampleRate: number;
  endpointingMs: number;
  languageHints?: string[];
  keyterms?: string[];
  /**
   * Timer functions. Browsers throttle setTimeout/setInterval in a hidden or occluded window (down to once a minute);
   * a Worker-backed implementation is not throttled. Defaults to the globals.
   */
  timers?: Timers;
  /** Vendor keep-alive cadence while no audio is flowing. Default 4000. */
  keepAliveMs?: number;
  /** Audio kept while the socket is down and replayed once it is back, ms. Default 20000. */
  bufferMs?: number;
  /** Treat the socket as dead if it sends no result for this long while we send audio, ms. Default 15000. */
  stallMs?: number;
  /** Give up (status "failed") if the socket stays down this long, ms. Default 120000. */
  giveUpAfterMs?: number;
  onResult: (r: SttResult) => void;
  onStatus: (status: ContinuousStatus, info?: { attempt?: number; reason?: string }) => void;
  /**
   * The socket dropped. Called BEFORE any result from the replacement socket, whose clock starts again at zero:
   * flush open phrases here so the segmenter never compares timestamps across two streams.
   */
  onDrop: () => void;
}

/** One long-lived recognition stream that survives socket drops. */
export interface ContinuousSttSession {
  readonly status: ContinuousStatus;
  readonly reconnects: number;
  /** 16-bit LE mono PCM. Buffered (bounded) while reconnecting. */
  sendAudio(pcm: ArrayBuffer): void;
  close(): void;
}

const BACKOFF_MS = [300, 1000, 2000, 4000, 8000];

/**
 * Wraps an SttProvider into a stream for hours-long sessions. If the socket closes or errors, it reconnects with
 * backoff (a fresh token is requested by the provider's own retry, and by `getToken` once the cached one has aged out),
 * keeps the last `bufferMs` of audio meanwhile and replays it, so captions already produced are untouched and speech
 * during a short outage is still transcribed. The first connection failing is thrown to the caller; only later drops
 * are handled silently.
 */
export async function startContinuousStt(provider: SttProvider, opts: ContinuousSttOptions): Promise<ContinuousSttSession> {
  const maxBufferBytes = Math.floor(((opts.bufferMs ?? 20_000) / 1000) * opts.sampleRate * 2);
  const giveUpAfterMs = opts.giveUpAfterMs ?? 120_000;

  let session: SttSession | null = null;
  let status: ContinuousStatus = "live";
  let closed = false;
  let reconnects = 0;
  let generation = 0; // identifies the current socket, so a late close from an old one is ignored
  let pending: ArrayBuffer[] = [];
  let pendingBytes = 0;
  let wake: (() => void) | null = null;
  let lastResultAt = Date.now();
  let lastAudioAt = 0;

  const setStatus = (s: ContinuousStatus, info?: { attempt?: number; reason?: string }) => {
    status = s;
    opts.onStatus(s, info);
  };

  const open = async (): Promise<SttSession> => {
    const gen = ++generation;
    return provider.start({
      getToken: opts.getToken,
      sampleRate: opts.sampleRate,
      endpointingMs: opts.endpointingMs,
      languageHints: opts.languageHints,
      keyterms: opts.keyterms,
      keepAliveMs: opts.keepAliveMs ?? 4000,
      onResult: (r) => {
        if (gen !== generation || closed) return;
        lastResultAt = Date.now();
        opts.onResult(r);
      },
      onError: () => {
        /* a failing socket is always followed by onClose, which drives the reconnect */
      },
      onClose: (info) => {
        if (gen !== generation || closed) return;
        void reconnect(`closed ${info.code}${info.reason ? ` ${info.reason}` : ""}`);
      },
    });
  };

  const timers = opts.timers ?? GLOBAL_TIMERS;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = timers.setTimeout(resolve, ms);
      wake = () => {
        timers.clearTimeout(t);
        resolve();
      };
    });

  let reconnecting = false;
  const reconnect = async (reason: string) => {
    if (reconnecting || closed) return;
    reconnecting = true;
    session = null;
    setStatus("reconnecting", { attempt: 0, reason });
    opts.onDrop();
    const downSince = Date.now();
    for (let attempt = 1; !closed; attempt++) {
      if (Date.now() - downSince > giveUpAfterMs) {
        pending = [];
        pendingBytes = 0;
        reconnecting = false;
        setStatus("failed", { attempt, reason: "gave up reconnecting" });
        return;
      }
      await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]!);
      if (closed) break;
      try {
        const s = await open();
        if (closed) {
          s.close();
          break;
        }
        session = s;
        lastResultAt = Date.now();
        reconnects++;
        for (const c of pending.splice(0)) s.sendAudio(c);
        pendingBytes = 0;
        reconnecting = false;
        setStatus("live");
        return;
      } catch (e) {
        setStatus("reconnecting", { attempt, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    reconnecting = false;
  };

  session = await open();

  // Deepgram sends (empty) results even through silence (measured: gaps <= 2 s), so a long gap while audio flows means
  // a half-open socket that never reported a close.
  const stallMs = opts.stallMs ?? 15_000;
  const watchdog = timers.setInterval(() => {
    if (closed || reconnecting || !session) return;
    const now = Date.now();
    if (now - lastResultAt > stallMs && now - lastAudioAt < 2000) {
      const dead = session;
      generation++; // ignore the dead socket's late events
      dead.close();
      void reconnect("stalled: no results");
    }
  }, 5000);

  return {
    get status() {
      return status;
    },
    get reconnects() {
      return reconnects;
    },
    sendAudio(pcm) {
      if (closed) return;
      lastAudioAt = Date.now();
      if (session) {
        session.sendAudio(pcm);
        return;
      }
      pending.push(pcm);
      pendingBytes += pcm.byteLength;
      while (pendingBytes > maxBufferBytes && pending.length > 1) pendingBytes -= pending.shift()!.byteLength;
    },
    close() {
      if (closed) return;
      closed = true;
      timers.clearInterval(watchdog);
      generation++;
      wake?.();
      session?.close();
      session = null;
      pending = [];
    },
  };
}
