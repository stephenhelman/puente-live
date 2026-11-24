import { redirect } from "next/navigation";
import PresentClient from "@/features/present/PresentClient";
import { hasSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/**
 * The OBS browser source. Signed out, it goes to the login page and comes BACK here afterwards (`next`), keeping every URL
 * parameter: an OBS browser source has no address bar to navigate with.
 */
export default async function PresentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!(await hasSession())) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(await searchParams)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, one);
    const qs = q.toString();
    redirect(`/?next=${encodeURIComponent(`/present${qs ? `?${qs}` : ""}`)}`);
  }
  return <PresentClient />;
}
