import type { Direction } from "@/engine";
import { hardNavigate } from "@/lib/nav";

export class NetworkError extends Error {}
export class TranslateFailed extends Error {}

/**
 * Calls /api/translate with stream:true and reports growing text. Resolves with the final text.
 * Throws NetworkError (offline / dropped) or TranslateFailed (server or vendor error).
 */
export async function streamTranslate(
  text: string,
  direction: Direction,
  onText: (soFar: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, direction, stream: true }),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new NetworkError("Network error");
  }
  if (res.status === 401) {
    hardNavigate("/");
    throw new TranslateFailed("Session expired");
  }
  if (!res.ok || !res.body) throw new TranslateFailed(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let acc = "";
  let final: string | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line) as
          | { t: "delta"; text: string }
          | { t: "done"; result: { text: string } }
          | { t: "error"; message: string };
        if (ev.t === "delta") {
          acc += ev.text;
          onText(acc.trimStart());
        } else if (ev.t === "done") {
          final = ev.result.text;
        } else {
          throw new TranslateFailed(ev.message);
        }
      }
    }
  } catch (e) {
    if (signal?.aborted || e instanceof TranslateFailed) throw e;
    throw new NetworkError("Stream interrupted");
  }
  // A stream that ends without "done" was cut off (dropped connection): do not show half a translation as final.
  if (final === null) throw new NetworkError("Stream ended early");
  return final;
}
