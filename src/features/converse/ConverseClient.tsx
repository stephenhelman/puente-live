"use client";

import { useEffect } from "react";
import { useAcknowledged, writeAck } from "./ack";
import Disclaimer from "./Disclaimer";
import Half from "./Half";
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
  const conv = useConversation();
  const wake = useWakeLock();

  // Minimal service worker: installability only. It has no cache and never touches API routes.
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  return (
    <main className={styles.root}>
      {/* Top half = Spanish speaker, rotated 180° so the person across reads it upright. */}
      <div className={styles.rotated}>
        <Half lang="es" conv={conv} wake={wake} />
      </div>
      <Half lang="en" conv={conv} wake={wake} />
    </main>
  );
}
