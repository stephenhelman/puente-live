import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/server/ratelimit";
import { SESSION_COOKIE, createSessionValue, verifyPasscode } from "@/lib/server/session";

export const runtime = "nodejs";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

export async function POST(req: Request) {
  const rl = rateLimit(`passcode:${clientIp(req)}`, MAX_ATTEMPTS, WINDOW_MS);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many attempts / Demasiados intentos", retryAfterSec: rl.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }
  const body = (await req.json().catch(() => null)) as { passcode?: unknown } | null;
  if (typeof body?.passcode !== "string" || body.passcode.length === 0 || body.passcode.length > 200) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (!verifyPasscode(body.passcode)) {
    return NextResponse.json({ error: "Wrong passcode / Código incorrecto" }, { status: 401 });
  }
  const { value, maxAge } = createSessionValue();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  });
  return res;
}
