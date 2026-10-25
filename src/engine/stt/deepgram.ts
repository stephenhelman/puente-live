import type { SttProvider, SttResult, SttSession, SttStartOptions, SttWord } from "./types";

const DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen";

/** Query params for Nova-3 with code-switching. See README "Chosen values". */
export function buildListenUrl(opts: { sampleRate: number; endpointingMs: number }): string {
  const q = new URLSearchParams({
    model: "nova-3",
    language: "multi", // en/es code-switching within one utterance
    encoding: "linear16",
    sample_rate: String(opts.sampleRate),
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    endpointing: String(opts.endpointingMs),
  });
  return `${DEEPGRAM_LISTEN_URL}?${q.toString()}`;
}

interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence: number;
  language?: string;
}

interface DgResults {
  type: "Results";
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  channel?: { alternatives?: { transcript?: string; words?: DgWord[]; languages?: string[] }[] };
}

function parseResults(raw: unknown, receivedAt: number): SttResult | null {
  const m = raw as DgResults;
  if (!m || m.type !== "Results") return null;
  const alt = m.channel?.alternatives?.[0];
  const words: SttWord[] = (alt?.words ?? []).map((w) => ({
    word: w.punctuated_word ?? w.word,
    start: w.start,
    end: w.end,
    confidence: w.confidence,
    language: w.language,
  }));
  return {
    text: alt?.transcript ?? "",
    isFinal: !!m.is_final,
    speechFinal: !!m.speech_final,
    fromFinalize: !!m.from_finalize,
    words,
    languages: alt?.languages ?? [],
    receivedAt,
  };
}

class AuthRejected extends Error {}

/** Opens a socket; resolves when open. Rejects with AuthRejected if closed before opening (the browser hides the 401). */
function openSocket(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // Browsers cannot set an Authorization header on a WebSocket; Deepgram accepts the JWT as the
    // 'bearer' subprotocol pair instead.
    const ws = new WebSocket(url, ["bearer", token]);
    ws.binaryType = "arraybuffer";
    let opened = false;
    ws.onopen = () => {
      opened = true;
      resolve(ws);
    };
    ws.onerror = () => {
      if (!opened) reject(new AuthRejected("WebSocket failed before opening (token rejected or network error)"));
    };
    ws.onclose = (e) => {
      if (!opened) reject(new AuthRejected(`WebSocket closed before opening (code ${e.code})`));
    };
  });
}

export class DeepgramSttProvider implements SttProvider {
  async start(opts: SttStartOptions): Promise<SttSession> {
    const url = buildListenUrl({ sampleRate: opts.sampleRate, endpointingMs: opts.endpointingMs });
    const t0 = performance.now();
    let usedTokenRetry = false;
    let ws: WebSocket;
    try {
      ws = await openSocket(url, await opts.getToken({ forceRefresh: false }));
    } catch (first) {
      // A browser cannot tell an expired token from a network blip, so retry once with a fresh token.
      usedTokenRetry = true;
      try {
        ws = await openSocket(url, await opts.getToken({ forceRefresh: true }));
      } catch {
        throw first instanceof Error ? first : new Error(String(first));
      }
    }
    const connectMs = performance.now() - t0;

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const r = parseResults(JSON.parse(ev.data), performance.now());
        if (r) opts.onResult(r);
      } catch (e) {
        opts.onError(e instanceof Error ? e : new Error(String(e)));
      }
    };
    ws.onerror = () => opts.onError(new Error("Deepgram WebSocket error"));
    ws.onclose = (e) => opts.onClose({ code: e.code, reason: e.reason });

    // Deepgram closes a socket that receives neither audio nor a KeepAlive message for ~10 s.
    let lastSendAt = performance.now();
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    const stopKeepAlive = () => {
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    };
    if (opts.keepAliveMs && opts.keepAliveMs > 0) {
      const every = opts.keepAliveMs;
      keepAliveTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (performance.now() - lastSendAt >= every) {
          ws.send(JSON.stringify({ type: "KeepAlive" }));
          lastSendAt = performance.now();
        }
      }, Math.max(500, Math.floor(every / 2)));
    }
    const onCloseUser = ws.onclose;
    ws.onclose = (e) => {
      stopKeepAlive();
      onCloseUser?.call(ws, e);
    };

    return {
      connectMs,
      usedTokenRetry,
      sendAudio(pcm) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(pcm);
          lastSendAt = performance.now();
        }
      },
      finalize() {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "Finalize" }));
      },
      close() {
        stopKeepAlive();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "CloseStream" }));
          ws.close(1000);
        } else if (ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      },
    };
  }
}

/**
 * SERVER ONLY. Mints a short-lived token with the long-lived API key. Never import the key into client code.
 * POST /v1/auth/grant. The token only needs to be valid at connect time.
 */
export async function mintDeepgramToken(apiKey: string, ttlSeconds = 60): Promise<{ token: string; expiresIn: number }> {
  const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl_seconds: ttlSeconds }),
  });
  if (!res.ok) {
    throw new Error(`Deepgram grant failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  return { token: body.access_token, expiresIn: body.expires_in };
}
