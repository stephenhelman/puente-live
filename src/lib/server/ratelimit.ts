/**
 * In-memory fixed-window limiter. Good enough for one Node process (local, or a single long-lived
 * instance). On Vercel serverless each instance has its own memory, so this only slows an attacker
 * down; swap for a shared store (e.g. Upstash/Vercel KV) before relying on it in production.
 */
const hits = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, max: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const cur = hits.get(key);
  if (!cur || cur.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  cur.count += 1;
  if (cur.count > max) return { ok: false, retryAfterSec: Math.ceil((cur.resetAt - now) / 1000) };
  return { ok: true, retryAfterSec: 0 };
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}
