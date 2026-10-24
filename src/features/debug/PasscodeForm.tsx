"use client";

import { useState } from "react";
import { hardNavigate } from "@/lib/nav";

export default function PasscodeForm() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/passcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode }),
    });
    if (res.ok) {
      hardNavigate("/debug");
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setError(body.error ?? `Error ${res.status}`);
    setBusy(false);
  }

  return (
    <main className="gate">
      <form onSubmit={submit}>
        <h1>Puente Live</h1>
        <label>
          Passcode / Código
          <input type="password" autoFocus value={passcode} onChange={(e) => setPasscode(e.target.value)} />
        </label>
        <button disabled={busy || !passcode}>Enter / Entrar</button>
        {error && <p className="err">{error}</p>}
      </form>
    </main>
  );
}
