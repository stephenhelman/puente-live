import { hardNavigate } from "@/lib/nav";

const SAFETY_MARGIN_MS = 10_000;

/** The server could not hand out a Deepgram token (as opposed to the socket failing). */
export class TokenError extends Error {}

let cached: { token: string; expiresAt: number } | null = null;

/** Fetch (or reuse) a short-lived Deepgram token from our server route. */
export async function getDeepgramToken({ forceRefresh }: { forceRefresh: boolean }): Promise<string> {
  if (!forceRefresh && cached && cached.expiresAt - SAFETY_MARGIN_MS > Date.now()) return cached.token;
  let res: Response;
  try {
    res = await fetch("/api/deepgram/token", { method: "POST" });
  } catch {
    throw new TokenError("Network error while requesting token");
  }
  if (res.status === 401) {
    hardNavigate("/");
    throw new TokenError("Session expired");
  }
  if (!res.ok) throw new TokenError(`Token request failed (${res.status})`);
  const { token, expiresIn } = (await res.json()) as { token: string; expiresIn: number };
  cached = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}
