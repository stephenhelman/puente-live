import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { hasSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAMPLES_DIR = path.join(process.cwd(), "samples");

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  if (!(await hasSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await ctx.params;
  // basename only: no path traversal out of /samples
  if (name !== path.basename(name) || name.startsWith(".")) {
    return NextResponse.json({ error: "Bad name" }, { status: 400 });
  }
  try {
    const buf = await readFile(path.join(SAMPLES_DIR, name));
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
