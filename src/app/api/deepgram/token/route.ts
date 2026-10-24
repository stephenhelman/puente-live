import { NextResponse } from "next/server";
import { mintDeepgramToken } from "@/engine";
import { requireEnv } from "@/lib/server/env";
import { hasSession } from "@/lib/server/session";

export const runtime = "nodejs";

export async function POST() {
  if (!(await hasSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ttl = Number(process.env.DEEPGRAM_TOKEN_TTL_SECONDS) || 60;
  try {
    const { token, expiresIn } = await mintDeepgramToken(requireEnv("DEEPGRAM_API_KEY"), ttl);
    return NextResponse.json({ token, expiresIn }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "token mint failed" }, { status: 502 });
  }
}
