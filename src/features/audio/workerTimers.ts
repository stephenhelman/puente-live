import { GLOBAL_TIMERS, type Timers } from "@/engine";

export interface DisposableTimers extends Timers {
  dispose(): void;
}

const WORKER_SOURCE = `
const live = new Map();
onmessage = (e) => {
  const m = e.data;
  if (m.op === "clear") {
    const h = live.get(m.id);
    if (h) { (h.repeat ? clearInterval : clearTimeout)(h.handle); live.delete(m.id); }
    return;
  }
  const fire = () => { postMessage(m.id); if (!m.repeat) live.delete(m.id); };
  live.set(m.id, { repeat: m.repeat, handle: (m.repeat ? setInterval : setTimeout)(fire, m.ms) });
};
`;

/**
 * Timers that run in a dedicated Worker. A hidden or occluded tab (the Puente window behind Zoom) has its setTimeout /
 * setInterval throttled to once a second, then once a minute; Worker timers are not, and their callbacks still run on
 * the main thread as ordinary message events. Falls back to the plain globals if a Worker cannot be created.
 */
export function createWorkerTimers(): DisposableTimers {
  let worker: Worker;
  let url: string;
  try {
    url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    worker = new Worker(url);
  } catch {
    return { ...GLOBAL_TIMERS, dispose() {} };
  }
  const callbacks = new Map<number, { fn: () => void; repeat: boolean }>();
  let next = 1;
  worker.onmessage = (e: MessageEvent<number>) => {
    const cb = callbacks.get(e.data);
    if (!cb) return;
    if (!cb.repeat) callbacks.delete(e.data);
    cb.fn();
  };
  const set = (repeat: boolean) => (fn: () => void, ms: number) => {
    const id = next++;
    callbacks.set(id, { fn, repeat });
    worker.postMessage({ op: "set", id, ms, repeat });
    return id;
  };
  const clear = (id: number) => {
    if (callbacks.delete(id)) worker.postMessage({ op: "clear", id });
  };
  return {
    setTimeout: set(false),
    setInterval: set(true),
    clearTimeout: clear,
    clearInterval: clear,
    dispose() {
      callbacks.clear();
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}
