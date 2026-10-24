import { redirect } from "next/navigation";
import ConverseClient from "@/features/converse/ConverseClient";
import { hasSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export default async function ConversePage() {
  if (!(await hasSession())) redirect("/");
  return <ConverseClient />;
}
