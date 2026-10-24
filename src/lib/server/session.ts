import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { requireEnv } from "./env";

export const SESSION_COOKIE = "puente_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h

const b64u = (b: Buffer) => b.toString("base64url");

function sign(payload: string): string {
  return b64u(createHmac("sha256", requireEnv("SESSION_SECRET")).update(payload).digest());
}

export function createSessionValue(): { value: string; maxAge: number } {
  const payload = b64u(Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })));
  return { value: `${payload}.${sign(payload)}`, maxAge: SESSION_TTL_SECONDS };
}

export function verifySessionValue(value: string | undefined): boolean {
  if (!value) return false;
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return false;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp: number };
    return typeof exp === "number" && exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

export async function hasSession(): Promise<boolean> {
  return verifySessionValue((await cookies()).get(SESSION_COOKIE)?.value);
}

/** Verifies against CHAPTER_PASSCODE_HASH ("scrypt:saltHex:hashHex"). Constant-time. */
export function verifyPasscode(input: string): boolean {
  const stored = requireEnv("CHAPTER_PASSCODE_HASH").split(":");
  if (stored.length !== 3 || stored[0] !== "scrypt") throw new Error("CHAPTER_PASSCODE_HASH has the wrong format");
  const salt = Buffer.from(stored[1]!, "hex");
  const want = Buffer.from(stored[2]!, "hex");
  const got = scryptSync(input.normalize("NFKC"), salt, want.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(got, want);
}
