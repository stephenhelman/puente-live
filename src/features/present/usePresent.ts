"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { PresentController, type PresentConfig, type PresentState } from "./controller";

/** Starts /present's controller on mount (listening begins on its own) and mirrors its state into React. */
export function usePresent(cfg: PresentConfig): { ctrl: PresentController; state: PresentState } {
  const [ctrl] = useState(() => new PresentController(cfg));
  useEffect(() => {
    ctrl.start();
    return () => void ctrl.dispose();
  }, [ctrl]);
  const state = useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot, ctrl.getSnapshot);
  return { ctrl, state };
}
