import Link from "next/link";
import PasscodeForm from "@/features/debug/PasscodeForm";
import { hasSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await hasSession())) return <PasscodeForm />;
  return (
    <main className="gate">
      <div className="landing">
        <h1>Puente Live</h1>
        <Link className="mode" href="/converse">
          <strong>Conversation / Conversación</strong>
          <span>Face to face, two people, one device. / Cara a cara, dos personas, un dispositivo.</span>
        </Link>
        <Link className="mode" href="/meeting">
          <strong>Meeting / Reunión</strong>
          <span>Captions and translation for Zoom and other video calls (Chrome on a laptop). / Subtítulos y traducción para Zoom y otras videollamadas (Chrome en computadora).</span>
        </Link>
        <p className="muted">AI translation. Not for clinical, legal, or consent situations. / Traducción con IA. No para situaciones clínicas, legales o de consentimiento.</p>
      </div>
    </main>
  );
}
