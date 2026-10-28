"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { chromeMajor, displayCaptureSupported, isMac } from "@/features/audio/capture";
import Disclaimer from "@/features/converse/Disclaimer";
import { useAcknowledged, writeAck } from "@/features/converse/ack";
import { useWakeLock } from "@/features/converse/useWakeLock";
import { E, M, MEETING_ENDED, type Bi } from "./strings";
import { downloadFile, stamp, toMarkdown, toText, type CaptionEntry, type SourceId } from "./transcript";
import { useMeeting, type Meeting, type SourceState } from "./useMeeting";
import styles from "./meeting.module.css";

const RENDER_LIMIT = 400; // older captions stay in memory for the transcript but leave the DOM
const NEAR_BOTTOM_PX = 48;

export default function MeetingClient() {
  const { hydrated, acknowledged } = useAcknowledged();
  if (!hydrated) return null;
  if (!acknowledged) return <Disclaimer onAcknowledge={writeAck} />;
  return <MeetingScreen />;
}

function B({ t, className }: { t: Bi; className?: string }) {
  return (
    <span className={className}>
      <span lang="en">{t.en}</span> <span lang="es" className={styles.es}>/ {t.es}</span>
    </span>
  );
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

function MeetingScreen() {
  const m = useMeeting();
  useWakeLock();
  const [presenting, setPresenting] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [debug, setDebug] = useState(false);
  const live = m.phase === "live";
  const busy = m.phase === "starting" || m.phase === "stopping";

  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the URL after hydration
    setDebug(new URLSearchParams(window.location.search).has("debug"));
  }, []);

  useEffect(() => {
    if (!presenting) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && setPresenting(false);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [presenting]);

  const download = useCallback(
    (kind: "txt" | "md") => {
      const name = `puente-meeting-${stamp(m.entries[0]?.at)}`;
      if (kind === "txt") downloadFile(`${name}.txt`, toText(m.entries), "text/plain");
      else downloadFile(`${name}.md`, toMarkdown(m.entries), "text/markdown");
      m.markDownloaded();
    },
    [m],
  );

  const clearTapped = () => {
    if (m.unsaved && !confirmClear) return setConfirmClear(true);
    if (!m.unsaved && m.entries.length > 0 && !confirmClear) return setConfirmClear(true);
    setConfirmClear(false);
    m.clear();
  };
  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 4000);
    return () => clearTimeout(t);
  }, [confirmClear]);

  const warn = live && m.warnAtMs !== undefined && m.elapsedMs >= m.warnAtMs;

  return (
    <main className={`${styles.root} ${presenting ? styles.presenting : ""}`}>
      {!presenting && (
        <header className={styles.top}>
          <div className={styles.row}>
            <h1 className={styles.title}><B t={M.title} /></h1>
            <span className={styles.timer} aria-label="elapsed">{live ? clock(m.elapsedMs) : ""}</span>
          </div>
          <div className={styles.row}>
            {live ? (
              <button type="button" className={`${styles.btn} ${styles.stop}`} onClick={() => void m.stop()}><B t={M.stop} /></button>
            ) : (
              <button type="button" className={`${styles.btn} ${styles.go}`} disabled={busy} onClick={() => void m.start()}>
                <B t={m.phase === "starting" ? M.starting : m.phase === "stopping" ? M.stopping : M.start} />
              </button>
            )}
            <label className={styles.check}>
              <input type="checkbox" checked={m.useMic} disabled={live || busy} onChange={(e) => m.setUseMic(e.target.checked)} />
              <B t={M.useMic} />
            </label>
            <button type="button" className={styles.btn} onClick={() => setPresenting(true)}><B t={M.present} /></button>
          </div>
          <SourceBar sources={m.sources} />
          {m.useMic && <p className={styles.hint}><B t={M.headphones} /></p>}
          {warn && <p className={styles.warn} role="status"><B t={M.warnSoon} /></p>}
          {debug && live && m.debugInfo.throttleEvents > 0 && <p className={styles.warn} role="alert"><B t={M.throttled} /></p>}
          <ErrorBanner m={m} />
        </header>
      )}

      <Feed m={m} presenting={presenting} showSetup={!live && m.entries.length === 0 && !busy} />

      {presenting ? (
        <button type="button" className={styles.exitPresent} onClick={() => setPresenting(false)}><B t={M.exitPresent} /></button>
      ) : (
        <footer className={styles.bottom}>
          <button type="button" className={styles.btn} disabled={m.entries.length === 0} onClick={() => download("txt")}>
            <B t={M.download} /> .txt
          </button>
          <button type="button" className={styles.btn} disabled={m.entries.length === 0} onClick={() => download("md")}>.md</button>
          <button type="button" className={styles.btn} disabled={live || busy || m.entries.length === 0} onClick={clearTapped}>
            <B t={confirmClear ? (m.unsaved ? M.clearConfirm : M.clearSure) : M.clear} />
          </button>
          {m.unsaved && <span className={styles.unsaved}><B t={M.unsaved} /></span>}
          <p className={styles.disclaimer}><B t={M.disclaimer} /></p>
          {debug && <LatencyLine m={m} />}
        </footer>
      )}
    </main>
  );
}

function SourceBar({ sources }: { sources: Record<SourceId, SourceState> }) {
  const label = (s: SourceState): Bi | null =>
    s === "reconnecting" ? M.reconnecting : s === "failed" ? M.failed : null;
  return (
    <div className={styles.sources}>
      {(["meeting", "you"] as const).map((id) => {
        const s = sources[id];
        if (s === "off") return null;
        const extra = label(s);
        return (
          <span key={id} className={`${styles.chip} ${styles[id]} ${s === "live" ? "" : styles.chipWarn}`}>
            <B t={M[id]} />{extra && <> · <B t={extra} /></>}
          </span>
        );
      })}
    </div>
  );
}

function ErrorBanner({ m }: { m: Meeting }) {
  const { error } = m;
  if (!error) return null;
  const meetingEnded = m.phase === "live" && error.kind === "no-audio" && error.source === "meeting";
  const text = meetingEnded ? MEETING_ENDED : E[error.kind];
  // Only a re-pick of the meeting audio is retryable in place; everything else is Stop / Start.
  const canRetry = error.source === "meeting" && m.phase === "idle" && error.kind !== "unsupported";
  return (
    <div className={styles.error} role="alert">
      <p><B t={text} /></p>
      <div className={styles.row}>
        {meetingEnded && <button type="button" className={styles.btn} onClick={() => void m.reshareMeeting()}><B t={M.reshare} /></button>}
        {canRetry && <button type="button" className={styles.btn} onClick={() => void m.start()}><B t={M.retry} /></button>}
        <button type="button" className={styles.btn} onClick={m.dismissError}><B t={M.dismiss} /></button>
      </div>
    </div>
  );
}

function Setup() {
  const [info] = useState(() => (typeof window === "undefined" ? null : { ok: displayCaptureSupported(), old: isMac() && (chromeMajor() ?? 0) < 141 }));
  return (
    <section className={styles.setup}>
      <p className={styles.emptyHint}><B t={M.empty} /></p>
      <h2><B t={M.howTitle} /></h2>
      {info && !info.ok && <p className={styles.errInline}><B t={M.unsupportedBrowser} /></p>}
      <ul>
        <li><B t={M.howTab} /></li>
        <li><B t={M.howScreen} /></li>
      </ul>
      {info?.old && <p className={styles.errInline}><B t={M.howMacOld} /></p>}
      <p className={styles.hint}><B t={M.privacy} /></p>
    </section>
  );
}

function Feed({ m, presenting, showSetup }: { m: Meeting; presenting: boolean; showSetup: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    pinnedRef.current = near;
    setPinned(near);
  };
  const toBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setPinned(true);
  }, []);

  // Follow the newest text unless the reader scrolled up.
  useLayoutEffect(() => {
    if (pinnedRef.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [m.entries, m.tails, presenting]);

  const hidden = Math.max(0, m.entries.length - RENDER_LIMIT);
  const shown = hidden ? m.entries.slice(hidden) : m.entries;

  return (
    <div className={styles.feedWrap}>
      <div ref={ref} className={styles.feed} onScroll={onScroll} aria-live="off">
        {showSetup && <Setup />}
        {hidden > 0 && <p className={styles.hint}><B t={M.earlier} /></p>}
        {shown.map((e) => (
          <Entry key={e.id} e={e} presenting={presenting} onRetry={() => m.retryEntry(e.id)} />
        ))}
        {(["meeting", "you"] as const).map(
          (id) =>
            m.tails[id] && (
              <article key={`tail-${id}`} className={`${styles.entry} ${styles[id]} ${styles.interim}`}>
                {!presenting && <Label id={id} />}
                <p className={styles.orig}>{m.tails[id]}</p>
              </article>
            ),
        )}
        {m.phase === "live" && !m.tails.meeting && !m.tails.you && m.entries.length === 0 && (
          <p className={styles.emptyHint}><B t={M.listening} /></p>
        )}
      </div>
      {!pinned && (
        <button type="button" className={styles.jump} onClick={toBottom}><B t={M.jump} /></button>
      )}
    </div>
  );
}

function Label({ id }: { id: SourceId }) {
  return <span className={`${styles.label} ${styles[id]}`}><B t={M[id]} /></span>;
}

function Entry({ e, presenting, onRetry }: { e: CaptionEntry; presenting: boolean; onRetry: () => void }) {
  return (
    <article className={`${styles.entry} ${styles[e.source]}`}>
      <Label id={e.source} />
      {!presenting && <p className={styles.orig} lang={e.lang}>{e.original}</p>}
      {e.status === "error" ? (
        <p className={styles.trans}>
          <span className={styles.errInline}><B t={M.phraseFailed} /></span>{" "}
          <button type="button" className={styles.btn} onClick={onRetry}><B t={M.retry} /></button>
        </p>
      ) : (
        <p className={`${styles.trans} ${e.status === "translating" ? styles.interim : ""}`} lang={e.lang === "en" ? "es" : "en"}>
          {e.translation || "…"}
          {e.note && (
            <>
              {" "}
              <span className={styles.note}>
                <B t={e.note === "untranslated" ? M.untranslated : e.lang === "en" ? M.alreadyEs : M.alreadyEn} />
              </span>
              {e.note === "untranslated" && !presenting && (
                <>
                  {" "}
                  <button type="button" className={styles.btn} onClick={onRetry}><B t={M.retry} /></button>
                </>
              )}
            </>
          )}
        </p>
      )}
    </article>
  );
}

function LatencyLine({ m }: { m: Meeting }) {
  const f = (v: number | null) => (v === null ? "-" : `${(v / 1000).toFixed(2)}s`);
  const s = m.stats;
  const d = m.debugInfo;
  return (
    <p className={styles.debug}>
      n={s.n} · phrase p50/p95/max {f(s.phraseP50)}/{f(s.phraseP95)}/{f(s.phraseMax)} · first text {f(s.firstP50)}/{f(s.firstP95)}/{f(s.firstMax)} · done {f(s.doneP50)}/{f(s.doneP95)}/{f(s.doneMax)}
      <br />
      max delay speech end → caption {f(s.firstMax)} (phrase {f(s.phraseMax)}) · throttled {d.throttleEvents}× (worst tick gap {f(d.maxTickGapMs)}, hidden {f(d.hiddenMs)}) · audio gap max {d.maxChunkGapMs.toFixed(0)}ms · vendor gap max {f(d.maxResultGapMs)}
      <br />
      leaks stripped {d.leaks} · retries {d.retries} · already-in-target {d.alreadyInTarget} · untranslated {d.untranslated} · phantom dropped {d.filtered}
      {d.log.length > 0 && (
        <>
          <br />
          {d.log.slice(-6).map((l, i) => (
            <span key={i}>{l}<br /></span>
          ))}
        </>
      )}
    </p>
  );
}
