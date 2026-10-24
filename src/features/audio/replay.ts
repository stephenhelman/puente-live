import { STT_SAMPLE_RATE } from "./mic";

const CHUNK_MS = 50;
const CHUNK_SAMPLES = (STT_SAMPLE_RATE * CHUNK_MS) / 1000;

/** Decode any browser-supported audio file to 16 kHz mono Int16 PCM. */
export async function decodeToPcm16k(file: ArrayBuffer): Promise<Int16Array> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(file.slice(0));
    const frames = Math.ceil(decoded.duration * STT_SAMPLE_RATE);
    const off = new OfflineAudioContext(1, frames, STT_SAMPLE_RATE);
    const s = off.createBufferSource();
    s.buffer = decoded; // multi-channel input is down-mixed to mono by the offline context
    s.connect(off.destination);
    s.start();
    const rendered = await off.startRendering();
    const f32 = rendered.getChannelData(0);
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const v = Math.max(-1, Math.min(1, f32[i] ?? 0));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  } finally {
    void ctx.close();
  }
}

/**
 * Streams PCM to `onChunk` at real-time speed (50 ms chunks on a drift-corrected clock).
 * Resolves after the last chunk has been sent. `signal` aborts early.
 */
export async function streamAtRealtime(
  pcm: Int16Array,
  onChunk: (pcm: ArrayBuffer) => void,
  signal?: AbortSignal,
): Promise<void> {
  const start = performance.now();
  let i = 0;
  while (i < pcm.length) {
    if (signal?.aborted) return;
    const chunk = pcm.slice(i, i + CHUNK_SAMPLES);
    onChunk(chunk.buffer as ArrayBuffer);
    i += CHUNK_SAMPLES;
    const due = start + ((i / CHUNK_SAMPLES) * CHUNK_MS);
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}
