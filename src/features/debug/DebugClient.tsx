"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EN_TO_ES, ES_TO_EN, type Direction } from "@/engine";
import { openMic, type MicCapture } from "@/features/audio/mic";
import { decodeToPcm16k, streamAtRealtime } from "@/features/audio/replay";
import { percentile } from "./stats";
import { TurnRunner } from "./turn";
import type { DebugSettings, Turn } from "./types";

const DEFAULT_ENDPOINTING_MS = 100;

const dirLabel = (d: Direction) => `${d.from.toUpperCase()} → ${d.to.toUpperCase()}`;

function fmt(n: number | null | undefined): string {
  return n == null ? "–" : `${n} ms`;
}

function Stat({ label, values }: { label: string; values: number[] }) {
  return (
    <tr>
      <td>{label}</td>
      <td>{values.length}</td>
      <td>{fmt(percentile(values, 50))}</td>
      <td>{fmt(percentile(values, 95))}</td>
    </tr>
  );
}

export default function DebugClient() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [settings, setSettings] = useState<DebugSettings>({ endpointingMs: DEFAULT_ENDPOINTING_MS });
  const [micReady, setMicReady] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [holding, setHolding] = useState<Direction | null>(null);
  const [samples, setSamples] = useState<string[]>([]);
  const [sample, setSample] = useState("");
  const [sampleDir, setSampleDir] = useState<"en-es" | "es-en">("es-en");
  const [replaying, setReplaying] = useState(false);

  const mic = useRef<MicCapture | null>(null);
  const runner = useRef<TurnRunner | null>(null);
  const abort = useRef<AbortController | null>(null);

  const upsert = useCallback((t: Turn) => {
    setTurns((prev) => {
      const i = prev.findIndex((x) => x.id === t.id);
      if (i === -1) return [t, ...prev];
      const next = prev.slice();
      next[i] = t;
      return next;
    });
  }, []);

  const loadSamples = useCallback(() => {
    void fetch("/api/samples")
      .then((res) => (res.ok ? (res.json() as Promise<{ files: string[] }>) : null))
      .then((body) => {
        if (!body) return;
        setSamples(body.files);
        setSample((cur) => (cur && body.files.includes(cur) ? cur : (body.files[0] ?? "")));
      });
  }, []);

  useEffect(() => {
    loadSamples();
    return () => {
      abort.current?.abort();
      runner.current?.cancel();
      mic.current?.dispose();
    };
  }, [loadSamples]);

  async function enableMic() {
    setMicError(null);
    try {
      mic.current = await openMic();
      setMicReady(true);
    } catch (e) {
      setMicError(e instanceof Error ? e.message : String(e));
    }
  }

  function press(direction: Direction) {
    if (!mic.current || runner.current || replaying) return;
    const r = new TurnRunner(direction, "mic", settings.endpointingMs, upsert);
    runner.current = r;
    setHolding(direction);
    mic.current.start((pcm) => r.push(pcm));
    void r.done.then(() => {
      if (runner.current === r) runner.current = null;
    });
  }

  function release() {
    const r = runner.current;
    if (!r) return;
    mic.current?.stop();
    setHolding(null);
    r.end(); // the runner clears itself from `runner` when done
  }

  async function replay() {
    if (!sample || replaying || runner.current) return;
    setReplaying(true);
    abort.current = new AbortController();
    const direction = sampleDir === "en-es" ? EN_TO_ES : ES_TO_EN;
    try {
      const res = await fetch(`/api/samples/${encodeURIComponent(sample)}`);
      if (!res.ok) throw new Error(`Could not load ${sample} (${res.status})`);
      const pcm = await decodeToPcm16k(await res.arrayBuffer());
      const r = new TurnRunner(direction, `file:${sample}`, settings.endpointingMs, upsert);
      runner.current = r;
      await streamAtRealtime(pcm, (c) => r.push(c), abort.current.signal);
      r.end(); // "end of speech" = last audio chunk sent; include trailing silence in the file when measuring
      await r.done;
      runner.current = null;
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setReplaying(false);
    }
  }

  function exportResults() {
    const payload = {
      exportedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      settings,
      note: "words[].language is Deepgram's per-word language (language=multi). Please review translation accuracy.",
      turns: [...turns].reverse(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `puente-debug-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const stats = useMemo(() => {
    const pick = (f: (t: Turn) => number | undefined) =>
      turns.map(f).filter((v): v is number => typeof v === "number");
    return {
      connect: pick((t) => t.metrics.connectMs && Math.round(t.metrics.connectMs)),
      stt: pick((t) => t.metrics.endOfSpeechToTranscriptMs),
      trRt: pick((t) => t.metrics.translateRoundTripMs),
      trSrv: pick((t) => t.metrics.translateServerMs),
      total: turns
        .filter((t) => t.metrics.endOfSpeechToTranscriptMs != null && t.metrics.translateRoundTripMs != null)
        .map((t) => t.metrics.endOfSpeechToTranscriptMs! + t.metrics.translateRoundTripMs!),
    };
  }, [turns]);

  const ptt = (direction: Direction, label: string) => (
    <button
      className={`ptt${holding === direction ? " held" : ""}`}
      disabled={!micReady || replaying || (holding !== null && holding !== direction)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        press(direction);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );

  return (
    <main className="debug">
      <h1>Debug: STT + translation</h1>
      <p className="muted">
        Not the product UI. Hold a button, speak, release. Direction = the button you hold. Results below; export to JSON
        for review.
      </p>

      <section className="panel">
        {!micReady ? (
          <button onClick={enableMic}>Enable microphone</button>
        ) : (
          <span className="ok">Mic armed</span>
        )}
        {micError && <span className="err"> {micError}</span>}
        <div className="row">
          {ptt(EN_TO_ES, "Speak English -> Spanish")}
          {ptt(ES_TO_EN, "Speak Spanish -> English")}
        </div>
        <label>
          Endpointing (ms){" "}
          <input
            type="number"
            min={10}
            max={2000}
            step={10}
            value={settings.endpointingMs}
            onChange={(e) => setSettings({ endpointingMs: Number(e.target.value) || DEFAULT_ENDPOINTING_MS })}
          />
        </label>
      </section>

      <section className="panel">
        <strong>Replay from /samples</strong>{" "}
        <button onClick={loadSamples} disabled={replaying}>
          Refresh
        </button>
        <div className="row">
          <select value={sample} onChange={(e) => setSample(e.target.value)} disabled={replaying || samples.length === 0}>
            {samples.length === 0 && <option>(no files in /samples)</option>}
            {samples.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          <select value={sampleDir} onChange={(e) => setSampleDir(e.target.value as "en-es" | "es-en")} disabled={replaying}>
            <option value="es-en">Speaker is Spanish → English</option>
            <option value="en-es">Speaker is English → Spanish</option>
          </select>
          <button onClick={replay} disabled={!sample || replaying}>
            {replaying ? "Streaming…" : "Replay at real-time"}
          </button>
          {replaying && <button onClick={() => abort.current?.abort()}>Stop</button>}
        </div>
      </section>

      <section className="panel">
        <div className="row spread">
          <strong>Latency ({turns.length} turns)</strong>
          <span>
            <button onClick={exportResults} disabled={turns.length === 0}>
              Export results (JSON)
            </button>{" "}
            <button onClick={() => setTurns([])} disabled={turns.length === 0}>
              Clear
            </button>
          </span>
        </div>
        <table className="stats">
          <thead>
            <tr>
              <th>Metric</th>
              <th>n</th>
              <th>p50</th>
              <th>p95</th>
            </tr>
          </thead>
          <tbody>
            <Stat label="Socket connect" values={stats.connect} />
            <Stat label="End of speech → final transcript" values={stats.stt} />
            <Stat label="Translate (browser round trip)" values={stats.trRt} />
            <Stat label="Translate (server → Anthropic)" values={stats.trSrv} />
            <Stat label="End of speech → translation (sum)" values={stats.total} />
          </tbody>
        </table>
      </section>

      {turns.map((t) => (
        <article key={t.id} className={`turn ${t.status}`}>
          <header>
            <strong>
              #{t.id} {dirLabel(t.direction)}
            </strong>{" "}
            <span className="muted">
              {t.source} · {t.status}
              {t.metrics.audioMs != null ? ` · ${t.metrics.audioMs} ms audio` : ""}
            </span>
          </header>
          <p className="label">Transcript (Deepgram final)</p>
          <p>{t.transcript || (t.interim ? <em>{t.interim}</em> : <span className="muted">(none)</span>)}</p>
          {t.words.length > 0 && (
            <p className="words">
              {t.words.map((w, i) => (
                <span key={i} className={`w lang-${w.language ?? "unk"}`} title={`${w.language ?? "?"} · conf ${w.confidence.toFixed(2)}`}>
                  {w.word}
                  <sub>{w.language ?? "?"}</sub>
                </span>
              ))}
            </p>
          )}
          <p className="label">Translation</p>
          <p className="big">{t.translation ?? <span className="muted">…</span>}</p>
          {t.error && <p className="err">Error: {t.error}</p>}
          <p className="metrics">
            connect {fmt(t.metrics.connectMs != null ? Math.round(t.metrics.connectMs) : null)}
            {t.metrics.tokenRetry ? " (token retry)" : ""} · speech→transcript {fmt(t.metrics.endOfSpeechToTranscriptMs)}
            {t.metrics.finalizeTimedOut ? " (finalize timed out)" : ""} · translate {fmt(t.metrics.translateRoundTripMs)} (server{" "}
            {fmt(t.metrics.translateServerMs)})
            {t.translateUsage
              ? ` · tokens in ${t.translateUsage.inputTokens} / out ${t.translateUsage.outputTokens} / cache read ${t.translateUsage.cacheReadTokens} / cache write ${t.translateUsage.cacheWriteTokens}`
              : ""}
          </p>
        </article>
      ))}
    </main>
  );
}
