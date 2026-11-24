"use client";

import { useEffect, useMemo, useState } from "react";
import type { GlossaryProfile } from "@/engine";
import { useAcknowledged, writeAck } from "./ack";
import Disclaimer from "./Disclaimer";
import { paneRole } from "./focus";
import Half, { type ProfileSetting } from "./Half";
import { parseIdleSeconds } from "./idle";
import { readSavedProfile, resolveProfile, saveProfile } from "./profile";
import { useConversation } from "./useConversation";
import { useWakeLock } from "./useWakeLock";
import styles from "./converse.module.css";

export default function ConverseClient() {
  const { hydrated, acknowledged } = useAcknowledged();
  if (!hydrated) return null; // avoids flashing the disclaimer for someone who already acknowledged
  if (!acknowledged) return <Disclaimer onAcknowledge={writeAck} />;
  return <Conversation />;
}

function Conversation() {
  // The address is read once (this component only renders in the browser, after hydration).
  const [boot] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    return { idleSec: parseIdleSeconds(q), urlProfile: q.get("profile") };
  });
  const [saved, setSaved] = useState<GlossaryProfile | null>(() => readSavedProfile());
  const { profile, fromUrl } = resolveProfile(boot.urlProfile, saved);
  const config = useMemo(() => ({ profile, idleSec: boot.idleSec }), [profile, boot.idleSec]);
  const conv = useConversation(config);
  const wake = useWakeLock();
  const setting: ProfileSetting = {
    value: profile,
    locked: fromUrl,
    onChange: (p) => {
      saveProfile(p);
      setSaved(p);
    },
  };

  // Minimal service worker: installability only. It has no cache and never touches API routes.
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  // While someone speaks their half shrinks to a quarter and the other half takes three quarters (see converse.module.css).
  return (
    <main className={styles.root}>
      {/* Top half = Spanish speaker, rotated 180° so the person across reads it upright. */}
      <div className={`${styles.pane} ${styles.rotated}`} data-role={paneRole(conv.side, "es")}>
        <Half lang="es" conv={conv} wake={wake} profile={setting} />
      </div>
      <div className={styles.pane} data-role={paneRole(conv.side, "en")}>
        <Half lang="en" conv={conv} wake={wake} profile={setting} />
      </div>
    </main>
  );
}
