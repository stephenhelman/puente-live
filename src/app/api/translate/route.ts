import { NextResponse } from "next/server";
import { ClaudeTranslator, type Direction } from "@/engine";
import { requireEnv } from "@/lib/server/env";
import { hasSession } from "@/lib/server/session";

export const runtime = "nodejs";

const MAX_CHARS = 4000;

let translator: ClaudeTranslator | null = null;
function getTranslator(): ClaudeTranslator {
  translator ??= new ClaudeTranslator({
    apiKey: requireEnv("ANTHROPIC_API_KEY"),
    model: process.env.TRANSLATE_MODEL || undefined,
  });
  return translator;
}

function parseDirection(v: unknown): Direction | null {
  const d = v as Partial<Direction> | null;
  const ok = (l: unknown) => l === "en" || l === "es";
  if (!d || !ok(d.from) || !ok(d.to) || d.from === d.to) return null;
  return { from: d.from as Direction["from"], to: d.to as Direction["to"] };
}

export async function POST(req: Request) {
  if (!(await hasSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { text?: unknown; direction?: unknown } | null;
  const direction = parseDirection(body?.direction);
  if (typeof body?.text !== "string" || !direction || body.text.length > MAX_CHARS) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  try {
    const result = await getTranslator().translate({ text: body.text, direction });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "translate failed" }, { status: 502 });
  }
}
