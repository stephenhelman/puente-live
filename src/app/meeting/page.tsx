import { redirect } from "next/navigation";
import MeetingClient from "@/features/meeting/MeetingClient";
import { hasSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export default async function MeetingPage() {
  if (!(await hasSession())) redirect("/");
  return <MeetingClient />;
}
