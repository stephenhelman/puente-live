import { useEffect, useState } from "react";

export type WakeLockStatus = "pending" | "active" | "unsupported" | "failed";

/** Holds a screen wake lock while mounted; re-acquires after the tab returns to the foreground. */
export function useWakeLock(): WakeLockStatus {
  const [status, setStatus] = useState<WakeLockStatus>("pending");

  useEffect(() => {
    if (!("wakeLock" in navigator)) {
      queueMicrotask(() => setStatus("unsupported"));
      return;
    }
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = () => {
      navigator.wakeLock
        .request("screen")
        .then((s) => {
          if (cancelled) {
            void s.release();
            return;
          }
          sentinel = s;
          s.addEventListener("release", () => setStatus((cur) => (cur === "active" ? "pending" : cur)));
          setStatus("active");
        })
        .catch(() => setStatus("failed"));
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && (!sentinel || sentinel.released)) acquire();
    };

    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release().catch(() => {});
    };
  }, []);

  return status;
}
