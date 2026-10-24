import { readdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { hasSession } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAMPLES_DIR = path.join(process.cwd(), "samples");
const EXT = /\.(wav|mp3|m4a|mp4|webm|ogg|opus|flac|aac)$/i;

export async function GET() {
  if (!(await hasSession())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const files = (await readdir(SAMPLES_DIR)).filter((f) => EXT.test(f)).sort();
    return NextResponse.json({ files });
  } catch {
    return NextResponse.json({ files: [] });
  }
}
