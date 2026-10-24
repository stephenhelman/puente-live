import { redirect } from "next/navigation";
import PasscodeForm from "@/features/debug/PasscodeForm";
import { hasSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (await hasSession()) redirect("/converse");
  return <PasscodeForm />;
}
