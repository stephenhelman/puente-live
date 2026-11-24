"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { CaptionEntry } from "@/features/meeting/transcript";
import { downloadFile, stamp, toText } from "@/features/meeting/transcript";
import { getTuning } from "@/features/converse/tuning";
import { getProfile } from "@/features/meeting/tuning";
import { hardNavigate } from "@/lib/nav";
import CaptionStrip from "./CaptionStrip";
import { buildCaptionView } from "./captionView";
import type { PresentController, PresentState } from "./controller";
import { useObsScene } from "./obs";
import { layoutForScene, parsePresentParams, PRESENTER_TUNING, type PresentParams } from "./params";
import { statusLight } from "./status";
import { LIGHT, T, type Bi } from "./strings";
import { usePresent } from "./usePresent";
import styles from "./present.module.css";

const noopSubscribe = () => () => {};

/**
 * /present: the caption overlay that runs INSIDE an OBS browser source. It listens to an audio input device (a virtual
 * cable carrying the meeting's audio), starts by itself, and draws only captions. Errors and status live in the operator
 * control bar, which is hidden until the mouse is over the source (OBS "Interact") or a key is pressed.
 */
export default function PresentClient() {
  // The URL is only known in the browser: render nothing (transparent) until then.
  const search = useSyncExternalStore(noopSubscribe, () => window.location.search, () => null);
  if (search === null) return null;
  return <PresentScreen search={search} />;
}

function B({ t }: { t: Bi }) {
  return <>{t.en} / {t.es}</>;
}

function PresentScreen({ search }: { search: string }) {
  const cfg = useMemo(
    () => ({ params: parsePresentParams(search), tuning: getTuning(PRESENTER_TUNING), profile: getProfile("hemophilia") }),
    [search],
  );
  const { ctrl, state } = usePresent(cfg);
  const obs = useObsScene();
  const p = cfg.params;
  const layout = layoutForScene(obs.scene, p.full);
  const view = useMemo(() => buildCaptionView(state.entries, state.tail), [state.entries, state.tail]);

  const full = layout === "full";
  const size = full ? Math.min(220, Math.round(p.size * 1.8)) : p.size;
  const lines = full ? Math.min(8, p.lines + 3) : p.lines;

  return (
    <main
      className={styles.root}
      data-layout={layout}
      data-bg={p.bg}
      data-align={p.align}
      data-style={p.style}
      style={{ "--size": `${size}px`, "--lines": lines, "--color": p.color, "--boxa": p.opacity } as CSSProperties}
    >
      <CaptionStrip view={view} />
      <Controls ctrl={ctrl} state={state} params={p} />
    </main>
  );
}

/** True while the mouse is over the page or a key was pressed in the last few seconds. */
function useBarVisible(ctrl: PresentController): boolean {
  const [on, setOn] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const show = () => {
      setOn(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setOn(false), 4000);
    };
    const hide = () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setOn(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "p") ctrl.togglePause();
      else if (k === "c") ctrl.clear();
      show();
    };
    window.addEventListener("mousemove", show);
    window.addEventListener("keydown", key);
    document.documentElement.addEventListener("mouseleave", hide);
    return () => {
      window.removeEventListener("mousemove", show);
      window.removeEventListener("keydown", key);
      document.documentElement.removeEventListener("mouseleave", hide);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [ctrl]);
  return on;
}

function Controls({ ctrl, state, params }: { ctrl: PresentController; state: PresentState; params: PresentParams }) {
  const hover = useBarVisible(ctrl);
  const light = statusLight({
    authLost: state.authLost,
    deviceMissing: state.deviceMissing,
    offline: state.offline,
    source: state.source,
    paused: state.paused,
    starting: state.starting,
  });
  // The input list is the setup state: shown by itself when no input is chosen (the operator must act), even with controls=0.
  const needsSetup = state.deviceMissing && !state.authLost;
  if (!params.controls && !needsSetup) return null;

  const download = () => {
    const entries: CaptionEntry[] = ctrl.transcript();
    downloadFile(`puente-present-${stamp(entries[0]?.at)}.txt`, toText(entries), "text/plain");
  };

  return (
    <aside className={`${styles.bar} ${hover || needsSetup ? styles.on : ""}`}>
      <div className={styles.row}>
        <span className={styles.dot} data-c={light.color} />
        <span className={styles.light}><B t={LIGHT[light.key]} /></span>
        <Meter ctrl={ctrl} />
        {state.deviceLabel && <span className={styles.device}>{state.deviceLabel}</span>}
      </div>
      <div className={styles.row}>
        <button type="button" className={styles.btn} onClick={() => ctrl.togglePause()}>
          <B t={state.paused ? T.resume : T.pause} />
        </button>
        <button type="button" className={styles.btn} onClick={() => ctrl.clear()}><B t={T.clear} /></button>
        <button type="button" className={styles.btn} disabled={state.transcriptSize === 0} onClick={download}>
          <B t={T.transcript} /> ({state.transcriptSize})
        </button>
        {state.authLost && (
          <button type="button" className={styles.btn} onClick={() => hardNavigate(`/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`)}>
            <B t={T.signIn} />
          </button>
        )}
        <span className={styles.hint}><B t={T.hotkeys} /></span>
      </div>
      {needsSetup && <DevicePicker ctrl={ctrl} state={state} named={params.device} />}
    </aside>
  );
}

/** Reads the level a few times a second; only mounted inside the (usually hidden) control bar. */
function Meter({ ctrl }: { ctrl: PresentController }) {
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const id = setInterval(() => {
      if (bar.current) bar.current.style.width = `${Math.round(ctrl.getLevel() * 100)}%`;
    }, 100);
    return () => clearInterval(id);
  }, [ctrl]);
  return (
    <span className={styles.meter} aria-hidden="true">
      <i ref={bar} />
    </span>
  );
}

function DevicePicker({ ctrl, state, named }: { ctrl: PresentController; state: PresentState; named: string }) {
  return (
    <div className={styles.list}>
      {named && <div className={styles.hint}><B t={T.notFound} /> (“{named}”)</div>}
      <div><B t={T.pickInput} /></div>
      {state.devices.length === 0 && <div className={styles.hint}><B t={T.noInputs} /></div>}
      {state.devices.map((d, i) => (
        <button key={d.deviceId || i} type="button" className={styles.btn} onClick={() => void ctrl.selectDevice(d.deviceId)}>
          {d.label || `${T.unnamed.en} ${i + 1}`}
        </button>
      ))}
    </div>
  );
}
