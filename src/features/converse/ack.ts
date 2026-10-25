import { useSyncExternalStore } from "react";

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
export function writeAck() {
  try {
    sessionStorage.setItem(ACK_KEY, "1");
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(ACK_EVENT));
}
const subscribeNone = () => () => {};

/** "hydrated" is false on the server render, so callers can avoid flashing the disclaimer. */
export function useAcknowledged(): { hydrated: boolean; acknowledged: boolean } {
  const hydrated = useSyncExternalStore(subscribeNone, () => true, () => false);
  const acknowledged = useSyncExternalStore(subscribeAck, readAck, () => false);
  return { hydrated, acknowledged };
}
