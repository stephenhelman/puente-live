import { redirect } from "next/navigation";
import DebugClient from "@/features/debug/DebugClient";
import { hasSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export default async function DebugPage() {
  if (!(await hasSession())) redirect("/");
  return <DebugClient />;
}
