"use client";

import { useState } from "react";
import { describeTuning, TUNING_PARAMS } from "@/engine";
import type { Meeting } from "./useMeeting";
import { computeStats, formatCache, formatCuts, formatReport, formatStatsTable, TIMING_WINDOW, type PhraseTiming } from "./timing";
import { getMeetingTuning } from "./tuning";
import styles from "./meeting.module.css";

const f = (v: number | null) => (v === null ? "-" : `${(v / 1000).toFixed(2)}s`);

/** Copies text; falls back to a temporary textarea where the async clipboard API is unavailable (plain http, old browsers). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** ?debug=1: the values in force, rolling percentiles measured in the browser, the last phrases, and a copy button. */
export default function DebugPanel({ m }: { m: Meeting }) {
  const [urlTuning] = useState(() => getMeetingTuning());
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const tuning = m.tuning ?? urlTuning;
  const stats = computeStats(m.timings);
  const d = m.debugInfo;
  const last = m.timings.slice(-8).reverse();

  const extra = [
    `page throttled ${d.throttleEvents}x (worst tick gap ${f(d.maxTickGapMs)}, hidden ${f(d.hiddenMs)}) · audio gap max ${d.maxChunkGapMs.toFixed(0)}ms · vendor gap max ${f(d.maxResultGapMs)}`,
    `forced Finalize sent ${d.finalizes}${tuning.finalizeMs ? ` (fin=${tuning.finalizeMs} ms), words restored after cuts ${d.restored}` : " (off; set ?fin=3000)"}`,
    `leaks stripped ${d.leaks} · retries ${d.retries} · already-hint ${d.alreadyInTarget} · unchanged ${d.unchanged} · untranslated ${d.untranslated} · phantom dropped ${d.filtered}`,
  ];

  const copy = async () => {
    const text = formatReport({ tuning, profile: m.profile, stats, extra, query: window.location.search.replace(/^\?/, "") });
    setCopied((await copyText(text)) ? "ok" : "fail");
    setTimeout(() => setCopied(null), 2500);
  };

  return (
    <section className={styles.debugPanel} aria-label="Debug">
      <div className={styles.debugHead}>
        <strong>debug</strong>
        <button type="button" className={styles.btn} onClick={() => void copy()}>
          {copied === "ok" ? "copied" : copied === "fail" ? "copy failed" : "copy stats"}
        </button>
      </div>
      <p className={styles.debug}>
        tuning: {describeTuning(tuning)} · profile {m.profile}
        <br />
        {TUNING_PARAMS.map((p) => `${p.param}: ${p.label} ${p.min}-${p.max} ${p.unit}`).join(" · ")}
      </p>
      <pre className={styles.debugPre}>{formatStatsTable(stats)}</pre>
      <p className={styles.debug}>
        {stats.n} phrases (last {TIMING_WINDOW} at most) · cut by: {formatCuts(stats)}
        <br />
        prompt cache: {formatCache(stats)}
        {extra.map((l) => (
          <span key={l}>
            <br />
            {l}
          </span>
        ))}
      </p>
      <PhraseTable rows={last} />
      {d.log.length > 0 && (
        <p className={styles.debug}>
          {d.log.slice(-6).map((l, i) => (
            <span key={i}>
              {l}
              <br />
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

function PhraseTable({ rows }: { rows: PhraseTiming[] }) {
  if (rows.length === 0) return null;
  return (
    <table className={styles.debugTable}>
      <thead>
        <tr>
          <th>#</th><th>words</th><th>cut</th><th>speech→emit</th><th>emit→first</th><th>emit→done</th><th>cache read</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{r.id}</td><td>{r.words}</td><td>{r.cut}</td><td>{f(r.speechToEmit)}</td><td>{f(r.emitToFirst)}</td>
            <td>{f(r.emitToDone)}</td><td>{r.cacheRead === null ? "-" : r.cacheRead}{r.retried ? " (retried)" : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
