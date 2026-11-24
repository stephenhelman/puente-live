"use client";

import { useEffect, useState } from "react";

/** The browser-source API OBS injects as window.obsstudio (obs-browser). Only what /present uses. */
interface ObsStudio {
  pluginVersion?: string;
  getControlLevel?: (cb: (level: number) => void) => void;
  getCurrentScene?: (cb: (scene: { name: string }) => void) => void;
}

declare global {
  interface Window {
    obsstudio?: ObsStudio;
  }
}

export interface ObsInfo {
  /** window.obsstudio exists (the page runs inside an OBS browser source). */
  inObs: boolean;
  /** The scene that is on air, when OBS told us (needs "Page permissions" of at least "Read access to user information"). */
  scene: string | null;
  /** The page-permission level OBS granted (0-5), if it said. */
  level: number | null;
}

/**
 * Follows OBS's current scene so one browser-source instance can change layout per scene without restarting. Outside OBS
 * everything stays null/false and the strip layout is used.
 */
export function useObsScene(): ObsInfo {
  const [info, setInfo] = useState<ObsInfo>({ inObs: false, scene: null, level: null });

  useEffect(() => {
    const obs = window.obsstudio;
    if (!obs) return;
    queueMicrotask(() => setInfo((i) => ({ ...i, inObs: true })));
    try {
      obs.getControlLevel?.((level) => setInfo((i) => ({ ...i, level })));
      obs.getCurrentScene?.((s) => setInfo((i) => ({ ...i, scene: s?.name ?? i.scene })));
    } catch {
      /* a lower permission level refuses these: the scene event below may still arrive */
    }
    const onScene = (e: Event) => {
      const name = (e as CustomEvent<{ name?: string }>).detail?.name;
      if (typeof name === "string") setInfo((i) => ({ ...i, scene: name }));
    };
    window.addEventListener("obsSceneChanged", onScene);
    return () => window.removeEventListener("obsSceneChanged", onScene);
  }, []);

  return info;
}
