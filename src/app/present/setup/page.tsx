import { redirect } from "next/navigation";
import SetupClient from "@/features/present/SetupClient";
import { hasSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export default async function PresentSetupPage() {
  if (!(await hasSession())) redirect(`/?next=${encodeURIComponent("/present/setup")}`);
  return <SetupClient />;
}
