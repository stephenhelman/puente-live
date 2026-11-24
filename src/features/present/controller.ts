import type { GlossaryProfile, Tuning } from "@/engine";
import { glossaryKeyterms, loadGlossary } from "@/engine";
import { listAudioInputs, matchDevice, openInput, SAVED_DEVICE_KEY, type AudioInputInfo } from "@/features/audio/inputDevice";
import { meterPosition } from "@/features/audio/level";
import { createWorkerTimers, type DisposableTimers } from "@/features/audio/workerTimers";
import { streamTranslate } from "@/features/converse/streamTranslate";
import { CaptionSource, type CaptionSourceOptions, type PhraseEvent, type SourceStatus } from "@/features/meeting/captionSource";
import { CaptionPipeline, type TranslateFn } from "@/features/meeting/pipeline";
import type { CaptionEntry } from "@/features/meeting/transcript";
import { setAuthLostHandler } from "@/lib/nav";
import { isCaptionLive } from "./captionView";
import type { PresentParams } from "./params";

export interface PresentConfig {
  params: PresentParams;
  tuning: Tuning;
  profile: GlossaryProfile;
}

/** The part of CaptionSource the controller drives (so tests can supply a fake). */
export interface SourceLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  setPaused(paused: boolean): void;
  discard(): void;
}

export interface PresentDeps {
  listInputs(): Promise<AudioInputInfo[]>;
  openInput(deviceId: string): Promise<MediaStream>;
  createSource(o: CaptionSourceOptions): SourceLike;
  createTimers(): DisposableTimers;
  translate: TranslateFn;
  loadSaved(): string | null;
  saveDevice(id: string): void;
  now(): number;
}

export interface PresentState {
  /** The captions currently on screen (cleared after silence; the transcript keeps everything). */
  entries: CaptionEntry[];
  /** What is being said right now: finalized-but-unemitted words plus the interim. */
  tail: string;
  source: SourceStatus | "off";
  starting: boolean;
  paused: boolean;
  authLost: boolean;
  /** No input matched ?device= (or none was chosen): the operator must pick one. */
  deviceMissing: boolean;
  offline: boolean;
  devices: AudioInputInfo[];
  /** The label of the input actually in use. */
  deviceLabel: string;
  /** How many captions the transcript holds. */
  transcriptSize: number;
}

const INITIAL: PresentState = {
  entries: [], tail: "", source: "off", starting: true, paused: false, authLost: false, deviceMissing: false, offline: false,
  devices: [], deviceLabel: "", transcriptSize: 0,
};

export const RETRY_AFTER_FAILURE_MS = 5000;
export const RETRY_AFTER_END_MS = 3000;
const TICK_MS = 500;

function realDeps(): PresentDeps {
  return {
    listInputs: listAudioInputs,
    openInput,
    createSource: (o) => new CaptionSource(o),
    createTimers: createWorkerTimers,
    translate: (c) => streamTranslate(c.text, { auto: true, hint: c.hint, profile: c.profile }, c.onText, c.signal, c.context, c.onResult, c.onSource),
    loadSaved: () => {
      try {
        return window.localStorage.getItem(SAVED_DEVICE_KEY);
      } catch {
        return null;
      }
    },
    saveDevice: (id) => {
      try {
        window.localStorage.setItem(SAVED_DEVICE_KEY, id);
      } catch {
        /* storage unavailable: the choice lasts until the page reloads */
      }
    },
    now: () => Date.now(),
  };
}

/**
 * Everything /present does, with no React in it: picks the input device, starts listening on its own, restarts after a drop,
 * pauses, clears, keeps the transcript, and blanks the captions after silence. The page only draws `getSnapshot()`.
 *
 * Nothing here can reach the caption area except captions and the live interim: status, errors and the device list are
 * separate fields the operator controls read.
 */
export class PresentController {
  private state: PresentState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly deps: PresentDeps;
  private timers: DisposableTimers | null = null;
  private pipeline: CaptionPipeline | null = null;
  private src: SourceLike | null = null;
  /** Identifies the current source, so a late callback from a replaced one is ignored. */
  private gen = 0;
  private attempting = false;
  private running = false;
  private retryTimer: number | null = null;
  private tickTimer: number | null = null;
  private chosenId: string | null = null;
  private lastActivity = 0;
  private level = 0;
  private readonly archive = new Map<number, CaptionEntry>();
  private restoreAuth: (() => void) | null = null;
  private detach: (() => void) | null = null;

  constructor(
    private readonly cfg: PresentConfig,
    deps: Partial<PresentDeps> = {},
  ) {
    this.deps = { ...realDeps(), ...deps };
  }

  // --- React binding -------------------------------------------------------------------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = () => this.state;
  /** 0-1 meter position of the newest audio chunk (read by the control bar a few times a second). */
  getLevel = () => this.level;
  /** The transcript: every finished caption since the page loaded, in the order spoken. Never cleared by Clear or by silence. */
  transcript(): CaptionEntry[] {
    return [...this.archive.values()].sort((a, b) => a.at - b.at || a.id - b.id);
  }

  private set(patch: Partial<PresentState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // --- lifecycle -----------------------------------------------------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this.timers = this.deps.createTimers();
    this.pipeline = new CaptionPipeline(
      { contextPhrases: this.cfg.tuning.contextPhrases, translate: this.deps.translate },
      { onChange: (list) => this.onEntries(list) },
    );
    this.lastActivity = this.deps.now();
    this.tickTimer = this.timers.setInterval(() => this.tick(), TICK_MS);
    // A 401 must not navigate to the login page: that would be drawn on air. Record it; the operator sees the red light.
    this.restoreAuth = setAuthLostHandler(() => this.onAuthLost());
    this.detach = this.listenToEnvironment();
    void this.attempt();
  }

  async dispose() {
    this.running = false;
    this.detach?.();
    this.detach = null;
    this.restoreAuth?.();
    this.restoreAuth = null;
    if (this.retryTimer !== null) this.timers?.clearTimeout(this.retryTimer);
    if (this.tickTimer !== null) this.timers?.clearInterval(this.tickTimer);
    this.retryTimer = this.tickTimer = null;
    this.pipeline?.abortAll();
    await this.teardownSource();
    this.timers?.dispose();
    this.timers = null;
    this.pipeline = null;
  }

  private listenToEnvironment(): () => void {
    if (typeof window === "undefined") return () => {};
    const kick = () => void this.attempt();
    const online = () => {
      this.set({ offline: false });
      kick();
    };
    const offline = () => this.set({ offline: true });
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    // The virtual cable can appear after the page loaded (BlackHole started later, a USB interface plugged in).
    md?.addEventListener?.("devicechange", kick);
    this.set({ offline: typeof navigator !== "undefined" && navigator.onLine === false });
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      md?.removeEventListener?.("devicechange", kick);
    };
  }

  // --- starting and restarting ---------------------------------------------------------------------------------------

  private schedule(ms: number) {
    if (!this.running || !this.timers || this.state.authLost) return;
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.attempt();
    }, ms);
  }

  private resolveDevice(list: AudioInputInfo[]): { id: string; label: string } | null {
    if (this.chosenId) {
      const m = list.find((d) => d.deviceId === this.chosenId);
      if (m) return { id: m.deviceId, label: m.label };
    }
    const want = this.cfg.params.device;
    if (want) {
      const m = matchDevice(list, want);
      return m ? { id: m.deviceId, label: m.label } : null;
    }
    const saved = this.deps.loadSaved();
    const m = saved ? list.find((d) => d.deviceId === saved) : undefined;
    return m ? { id: m.deviceId, label: m.label } : null;
  }

  /** One try at getting from nothing to listening. Safe to call any time; it does nothing while a try or a session is on. */
  async attempt(): Promise<void> {
    if (!this.running || this.attempting || this.src || this.state.authLost) return;
    this.attempting = true;
    this.set({ starting: true });
    try {
      const list = await this.deps.listInputs();
      if (!this.running) return;
      this.set({ devices: list });
      const pick = this.resolveDevice(list);
      if (!pick) {
        this.set({ deviceMissing: true, starting: false, source: "off" });
        this.schedule(RETRY_AFTER_FAILURE_MS); // also woken by "devicechange"
        return;
      }
      const stream = await this.deps.openInput(pick.id);
      if (!this.running) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const token = ++this.gen;
      const src = this.deps.createSource({
        id: "meeting",
        stream,
        tuning: { ...this.cfg.tuning, maxSessionMs: 0, warnAtMs: 0 },
        keyterms: glossaryKeyterms(loadGlossary(this.cfg.profile)),
        timers: this.timers ?? undefined,
        onPhrase: (e) => this.onPhrase(token, e),
        onTail: (_id, text) => this.onTail(token, text),
        onStatus: (_id, s) => this.onSourceStatus(token, s),
        onLevel: (rms) => {
          if (token === this.gen) this.level = meterPosition(rms);
        },
      });
      this.src = src;
      if (this.state.paused) src.setPaused(true); // a restart must not un-pause
      this.set({ deviceMissing: false, deviceLabel: stream.getAudioTracks()[0]?.label || pick.label || "(unnamed input)" });
      await src.start();
      if (token === this.gen && this.running) this.set({ source: "live", starting: false });
    } catch {
      await this.teardownSource();
      if (this.running) {
        this.set({ starting: false, source: "failed" });
        this.schedule(RETRY_AFTER_FAILURE_MS);
      }
    } finally {
      this.attempting = false;
    }
  }

  private onSourceStatus(token: number, s: SourceStatus) {
    if (token !== this.gen || !this.running) return;
    this.set({ source: s });
    if (s === "failed" || s === "ended") {
      // The socket gave up after two minutes, or the input vanished (cable removed). Start over.
      void this.teardownSource().then(() => this.schedule(s === "ended" ? RETRY_AFTER_END_MS : RETRY_AFTER_FAILURE_MS));
    }
  }

  private async teardownSource() {
    const src = this.src;
    this.src = null;
    this.gen++; // late callbacks from the old source are ignored
    this.level = 0;
    if (src) await src.stop().catch(() => {});
  }

  private onAuthLost() {
    if (this.state.authLost) return;
    this.set({ authLost: true });
    // Stop spending on a session the server rejects; the operator signs in again.
    if (this.retryTimer !== null) this.timers?.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.teardownSource();
  }

  // --- what the source reports ---------------------------------------------------------------------------------------

  private onPhrase(token: number, e: PhraseEvent) {
    if (token !== this.gen || this.state.paused || !this.pipeline) return;
    this.lastActivity = this.deps.now();
    this.pipeline.add({ source: "meeting", lang: e.lang, text: e.text, spokenAt: e.spokenAt, alreadyHint: e.alreadyHint, profile: this.cfg.profile });
  }

  private onTail(token: number, text: string) {
    if (token !== this.gen || this.state.paused) return;
    if (text.trim()) this.lastActivity = this.deps.now();
    if (text !== this.state.tail) this.set({ tail: text });
  }

  private onEntries(list: CaptionEntry[]) {
    for (const e of list) if (e.status === "done" && e.note !== "untranslated") this.archive.set(e.id, e);
    if (list.length > 0) this.lastActivity = this.deps.now();
    this.set({ entries: list, transcriptSize: this.archive.size });
  }

  /** Blank the screen after `clearSec` of silence. The transcript is untouched. */
  private tick() {
    if (!this.pipeline) return;
    const { entries, tail } = this.state;
    if ((entries.length > 0 || tail) && !isCaptionLive(this.deps.now(), this.lastActivity, this.cfg.params.clearSec)) {
      this.pipeline.clear();
      this.set({ tail: "" });
    }
  }

  // --- operator controls ---------------------------------------------------------------------------------------------

  /**
   * Pause: stop sending audio (the socket's keep-alive keeps it open), discard the words buffered so far, abort every
   * translation in flight and remove the phrases it was still translating. Nothing said while paused is captioned or kept.
   */
  pause() {
    if (this.state.paused) return;
    this.set({ paused: true, tail: "" });
    this.src?.setPaused(true);
    this.pipeline?.discardInFlight();
  }

  resume() {
    if (!this.state.paused) return;
    this.src?.setPaused(false);
    this.lastActivity = this.deps.now();
    this.set({ paused: false });
  }

  togglePause() {
    if (this.state.paused) this.resume();
    else this.pause();
  }

  /** Wipe the screen now (and the words still buffered). The transcript keeps what was already captioned. */
  clear() {
    this.pipeline?.clear();
    this.src?.discard();
    this.set({ tail: "" });
  }

  /** The operator picked an input from the list: remember it (this browser profile) and restart on it. */
  async selectDevice(deviceId: string) {
    this.chosenId = deviceId;
    this.deps.saveDevice(deviceId);
    await this.teardownSource();
    this.set({ source: "off", deviceMissing: false });
    // A try may be in progress (it would ignore this call): the timer retries shortly after it ends.
    this.schedule(this.attempting ? 300 : 0);
  }
}
