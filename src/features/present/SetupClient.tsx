"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { GLOSSARY_PROFILES, type GlossaryProfile } from "@/engine";
import { listAudioInputs, openInput, type AudioInputInfo } from "@/features/audio/inputDevice";
import { meterPosition, rmsLevel } from "@/features/audio/level";
import CaptionStrip from "./CaptionStrip";
import { buildCaptionView } from "./captionView";
import { buildPresentQuery, COLOR_NAMES, parseColor, parseSceneList, PRESENT_DEFAULTS, PRESENT_RANGES, type Align, type Bg, type CaptionStyle } from "./params";
import styles from "./present.module.css";

const SAMPLE_VIEW = buildCaptionView(
  [{ id: 1, source: "meeting", at: 1, lang: "en", original: "The factor levels were checked this morning", translation: "Los niveles de factor se revisaron esta mañana", status: "done" }],
  "",
);

const MAC_FLAGS = 'open -a OBS --args --enable-media-stream --use-fake-ui-for-media-stream';
const WIN_TARGET = '"C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe" --enable-media-stream --use-fake-ui-for-media-stream';
const WIN_START_IN = "C:\\Program Files\\obs-studio\\bin\\64bit";

/**
 * /present/setup: a normal-browser page that builds the OBS browser-source URL and lists what to set up. It never captions
 * anything. "Test" opens one input for a few seconds and shows its level, to prove the virtual cable carries the meeting.
 */
export default function SetupClient() {
  const [device, setDevice] = useState("");
  const [size, setSize] = useState(PRESENT_DEFAULTS.size);
  const [lines, setLines] = useState(PRESENT_DEFAULTS.lines);
  const [align, setAlign] = useState<Align>(PRESENT_DEFAULTS.align);
  const [bg, setBg] = useState<Bg>(PRESENT_DEFAULTS.bg);
  const [style, setStyle] = useState<CaptionStyle>(PRESENT_DEFAULTS.style);
  const [color, setColor] = useState(PRESENT_DEFAULTS.color);
  const [opacity, setOpacity] = useState(PRESENT_DEFAULTS.opacity);
  const [full, setFull] = useState("");
  const [clearSec, setClearSec] = useState(PRESENT_DEFAULTS.clearSec);
  const [profile, setProfile] = useState<GlossaryProfile>("hemophilia");
  const [extra, setExtra] = useState("");
  const [devices, setDevices] = useState<AudioInputInfo[] | null>(null);
  const [detectError, setDetectError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    queueMicrotask(() => setOrigin(window.location.origin));
  }, []);

  const url = useMemo(() => {
    const extras: Record<string, string> = {};
    if (profile !== "hemophilia") extras.profile = profile;
    // Anything typed in "extra" (fin=3000&ep=250): added as is, but only parameters (name=value pairs), never markup.
    for (const [k, v] of new URLSearchParams(extra.replace(/^\?/, ""))) if (/^[a-z]{1,12}$/i.test(k)) extras[k] = v;
    return `${origin}/present${buildPresentQuery({ device, size, lines, align, bg, full: parseSceneList(full), clearSec, style, color, opacity }, extras)}`;
  }, [origin, device, size, lines, align, bg, full, clearSec, style, color, opacity, profile, extra]);

  async function detect() {
    setDetectError(false);
    try {
      setDevices(await listAudioInputs());
    } catch {
      setDetectError(true);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* select the field and copy by hand */
    }
  }

  return (
    <main className="debug">
      <h1>Presentation captions / Subtítulos de presentación</h1>
      <p className="muted">
        Builds the address for an OBS <strong>Browser Source</strong>. The page runs inside OBS, listens to a virtual audio cable that carries the
        meeting, and shows captions with a transparent background. AI translation: not for clinical, legal, or consent situations.
      </p>

      <section className="panel">
        <h2>1. Audio input</h2>
        <div className="row">
          <button type="button" onClick={() => void detect()}>Detect inputs</button>
          {detectError && <span className="err">Could not list inputs (allow the microphone for this site).</span>}
        </div>
        {devices && devices.length === 0 && <p className="muted">No audio inputs. Install the virtual cable first (step 3).</p>}
        {devices?.map((d, i) => (
          <InputRow key={d.deviceId || i} d={d} n={i + 1} onUse={(label) => setDevice(label)} />
        ))}
        <label>
          Part of the input&apos;s name (matched in OBS):{" "}
          <input value={device} onChange={(e) => setDevice(e.target.value)} placeholder="BlackHole  or  CABLE Output" size={28} />
        </label>
        <p className="muted">
          If OBS does not show input names, leave this empty: the first time, /present shows a list inside OBS (Interact) and remembers your choice.
        </p>
      </section>

      <section className="panel">
        <h2>2. Look</h2>
        <div className="row">
          <label>Text size (px) <input type="number" min={PRESENT_RANGES.size.min} max={PRESENT_RANGES.size.max} value={size} onChange={(e) => setSize(Number(e.target.value) || PRESENT_DEFAULTS.size)} /></label>
          <label>Lines <input type="number" min={PRESENT_RANGES.lines.min} max={PRESENT_RANGES.lines.max} value={lines} onChange={(e) => setLines(Number(e.target.value) || PRESENT_DEFAULTS.lines)} /></label>
          <label>Position <select value={align} onChange={(e) => setAlign(e.target.value as Align)}><option value="bottom">bottom</option><option value="top">top</option><option value="center">center</option></select></label>
          <label>Background <select value={bg} onChange={(e) => setBg(e.target.value as Bg)}><option value="transparent">transparent</option><option value="dark">dark strip</option></select></label>
          <label>Clear after (s) <input type="number" min={0} max={PRESENT_RANGES.clearSec.max} value={clearSec} onChange={(e) => setClearSec(Number(e.target.value))} /></label>
        </div>
        <div className="row">
          <label>Caption style <select value={style} onChange={(e) => setStyle(e.target.value as CaptionStyle)}><option value="box">box (dark box behind the words)</option><option value="outline">outline</option><option value="none">none</option></select></label>
          <label>Text color <input list="present-colors" value={color.replace(/^#/, "")} onChange={(e) => setColor(parseColor(e.target.value))} placeholder="white or ffd400" size={12} /></label>
          <datalist id="present-colors">{COLOR_NAMES.map((c) => <option key={c} value={c} />)}</datalist>
          <label>Box opacity <input type="number" step={0.05} min={PRESENT_RANGES.opacity.min} max={PRESENT_RANGES.opacity.max} value={opacity} disabled={style !== "box"} onChange={(e) => setOpacity(Number(e.target.value) || PRESENT_DEFAULTS.opacity)} /></label>
        </div>
        <div className="row">
          {(["#e9edf2", "#1b2430"] as const).map((back) => (
            <Preview key={back} back={back} size={size} lines={lines} align={align} bg={bg} style={style} color={color} opacity={opacity} />
          ))}
        </div>
        <label>
          Full-screen caption scenes (OBS scene names, separated by |):{" "}
          <input value={full} onChange={(e) => setFull(e.target.value)} placeholder="Captions Only | Q&A" size={32} />
        </label>
        <div className="row">
          <label>Glossary <select value={profile} onChange={(e) => setProfile(e.target.value as GlossaryProfile)}>{GLOSSARY_PROFILES.map((g) => <option key={g} value={g}>{g}</option>)}</select></label>
          <label>Extra parameters <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="fin=3000&ep=250" size={24} /></label>
        </div>
      </section>

      <section className="panel">
        <h2>OBS address</h2>
        <div className="row">
          <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, minWidth: 280 }} />
          <button type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
        </div>
      </section>

      <section className="panel">
        <h2>3. Checklist</h2>
        <ol>
          <li>
            <strong>Virtual audio cable.</strong> macOS: install BlackHole 2ch (and in Audio MIDI Setup make a Multi-Output Device of your speakers +
            BlackHole so you can still hear the meeting). Windows: install VB-Audio Virtual Cable (and set &quot;Listen to this device&quot; on <em>CABLE Output</em>
            to hear it).
          </li>
          <li>
            <strong>Route the meeting to the cable.</strong> In Google Meet: Settings, Audio, Speakers: BlackHole 2ch (macOS) / CABLE Input (Windows)
            (or the Multi-Output Device). Use Chrome&apos;s own setting so only the meeting goes there. Use <em>Test</em> above while someone talks: the bar must move.
          </li>
          <li>
            <strong>Start OBS with the media flag</strong> (quit OBS completely first).
            <br />macOS Terminal: <code>{MAC_FLAGS}</code>
            <br />Windows: shortcut Target <code>{WIN_TARGET}</code> and Start in <code>{WIN_START_IN}</code>
          </li>
          <li>
            <strong>Add ONE Browser Source</strong> with the address above: Width 1920, Height 1080 (your canvas size). Page permissions:
            <em> Read access to user information</em>. Leave <em>Shutdown source when not visible</em> OFF, <em>Refresh browser when scene becomes active</em> OFF,
            <em> Control audio via OBS</em> OFF. Do not change the Custom CSS (the default keeps the background transparent).
          </li>
          <li>
            <strong>Use that same source in every scene</strong> (Sources, + , <em>Add Existing</em>). Never create a second one: two would listen twice and double the cost.
          </li>
          <li>
            <strong>Sign in once:</strong> right-click the source, <em>Interact</em>, enter the passcode. You come back to the captions by themselves. The login lasts 12 hours.
          </li>
          <li>
            <strong>Operate:</strong> in Interact, move the mouse over the source for the control bar (status light, level, Pause, Clear, Transcript) or press <kbd>P</kbd> to pause,
            <kbd>C</kbd> to clear. While you interact, the bar is also visible on the program output.
          </li>
        </ol>
      </section>
    </main>
  );
}

function InputRow({ d, n, onUse }: { d: AudioInputInfo; n: number; onUse: (label: string) => void }) {
  const [level, setLevel] = useState<number | null>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  async function test() {
    stop.current?.();
    setLevel(0);
    try {
      const stream = await openInput(d.deviceId);
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      const id = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        const pcm = new Int16Array(buf.length);
        for (let i = 0; i < buf.length; i++) pcm[i] = Math.max(-1, Math.min(1, buf[i]!)) * 32767;
        setLevel((prev) => Math.max(meterPosition(rmsLevel(pcm.buffer)), (prev ?? 0) * 0.85));
      }, 80);
      const end = () => {
        clearInterval(id);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
        setLevel(null);
        stop.current = null;
      };
      stop.current = end;
      setTimeout(end, 8000);
    } catch {
      setLevel(null);
    }
  }

  return (
    <div className="row">
      <span style={{ minWidth: 260 }}>{d.label || `Audio input ${n}`}</span>
      <button type="button" onClick={() => void test()}>Test</button>
      {d.label && <button type="button" onClick={() => onUse(d.label.replace(/^(default|communications) - /i, ""))}>Use this name</button>}
      {level !== null && (
        <span style={{ display: "inline-block", width: 160, height: 10, background: "#21262d", borderRadius: 5, overflow: "hidden" }}>
          <i style={{ display: "block", height: "100%", width: `${Math.round(level * 100)}%`, background: "#3fb950" }} />
        </span>
      )}
    </div>
  );
}

/** The real caption markup and CSS, scaled down, over a sample slide color (the preview of ?style / ?color / ?opacity). */
function Preview(p: { back: string; size: number; lines: number; align: Align; bg: Bg; style: CaptionStyle; color: string; opacity: number }) {
  const px = Math.max(10, Math.round(p.size * 0.3));
  const height = Math.round(px * (p.lines * 1.2 + 1.2) + px * 1.2);
  return (
    // transform makes the fixed-position caption root fill this box instead of the window
    <div style={{ position: "relative", transform: "translateZ(0)", overflow: "hidden", width: 380, height, borderRadius: 8, background: p.back }}>
      <div
        className={styles.root}
        data-layout="strip"
        data-bg={p.bg}
        data-align={p.align}
        data-style={p.style}
        style={{ "--size": `${px}px`, "--lines": p.lines, "--color": p.color, "--boxa": p.opacity } as React.CSSProperties}
      >
        <CaptionStrip view={SAMPLE_VIEW} />
      </div>
    </div>
  );
}
