import { NextResponse } from "next/server";
import { ClaudeTranslator, type ContextPair, type Direction } from "@/engine";
import { requireEnv } from "@/lib/server/env";
import { hasSession } from "@/lib/server/session";

export const runtime = "nodejs";

const MAX_CHARS = 4000;
const MAX_CONTEXT_ITEMS = 8;
const MAX_CONTEXT_CHARS = 1500;

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

/**
 * POST { text, direction, stream?, context? }   context = earlier phrases of the same turn (never stored)
 * - stream falsy: JSON TranslateResult (used by /debug).
 * - stream true: application/x-ndjson, one JSON object per line:
 *     {"t":"delta","text":"..."} ... then {"t":"done","result":{...}} or {"t":"error","message":"..."}
 */
function parseContext(v: unknown): ContextPair[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_CONTEXT_ITEMS) return null;
  const out: ContextPair[] = [];
  for (const raw of v) {
    const c = raw as Partial<ContextPair> | null;
    if (!c || typeof c.source !== "string" || c.source.length > MAX_CONTEXT_CHARS) return null;
    if (c.translation !== undefined && (typeof c.translation !== "string" || c.translation.length > MAX_CONTEXT_CHARS)) return null;
    out.push({ source: c.source, translation: c.translation || undefined });
  }
  return out;
}

export async function POST(req: Request) {
  if (!(await hasSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as {
    text?: unknown;
    direction?: unknown;
    stream?: unknown;
    context?: unknown;
  } | null;
  const direction = parseDirection(body?.direction);
  const context = parseContext(body?.context);
  if (typeof body?.text !== "string" || !direction || !context || body.text.length > MAX_CHARS) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const request = { text: body.text, direction, context };

  if (body.stream === true) {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
        try {
          for await (const ev of getTranslator().translateStream(request, { signal: req.signal })) {
            send(ev.type === "delta" ? { t: "delta", text: ev.text } : { t: "done", result: ev.result });
          }
        } catch (e) {
          if (!req.signal.aborted) send({ t: "error", message: e instanceof Error ? e.message : "translate failed" });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
    });
  }

  try {
    const result = await getTranslator().translate(request);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "translate failed" }, { status: 502 });
  }
}
