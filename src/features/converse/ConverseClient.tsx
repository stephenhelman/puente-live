"use client";

import { useEffect, useSyncExternalStore } from "react";
import Disclaimer from "./Disclaimer";
import Half from "./Half";
import { useConversation } from "./useConversation";
import { useWakeLock } from "./useWakeLock";
import styles from "./converse.module.css";

const ACK_KEY = "puente_ack_v1";
const ACK_EVENT = "puente-ack";

function subscribeAck(cb: () => void) {
  window.addEventListener(ACK_EVENT, cb);
  return () => window.removeEventListener(ACK_EVENT, cb);
}
function readAck(): boolean {
  try {
    return sessionStorage.getItem(ACK_KEY) === "1";
  } catch {
    return false; // storage blocked: ask every load, which is the safe direction
  }
}
function writeAck() {
  try {
    sessionStorage.setItem(ACK_KEY, "1");
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(ACK_EVENT));
}
const subscribeNone = () => () => {};

export default function ConverseClient() {
  const hydrated = useSyncExternalStore(subscribeNone, () => true, () => false);
  const acknowledged = useSyncExternalStore(subscribeAck, readAck, () => false);
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
