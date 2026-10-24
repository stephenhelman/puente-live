export const STT_SAMPLE_RATE = 16000;
const PREROLL_CHUNKS = 4; // ~200 ms of audio kept before the button press so the first syllable is not clipped

export interface MicCapture {
  /** Begin delivering chunks (pre-roll first) to `onChunk`. */
  start(onChunk: (pcm: ArrayBuffer) => void): void;
  stop(): void;
  dispose(): void;
}

/** Opens the mic once (permission prompt on first use) and keeps it armed; start/stop gate delivery. */
export async function openMic(): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("/pcm-worklet.js");
  if (ctx.state === "suspended") await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-capture");
  src.connect(node);

  let sink: ((pcm: ArrayBuffer) => void) | null = null;
  const preroll: ArrayBuffer[] = [];
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    if (sink) sink(e.data);
    else {
      preroll.push(e.data);
      if (preroll.length > PREROLL_CHUNKS) preroll.shift();
    }
  };

  return {
    start(onChunk) {
      for (const c of preroll.splice(0)) onChunk(c);
      sink = onChunk;
    },
    stop() {
      sink = null;
    },
    dispose() {
      sink = null;
      node.disconnect();
      src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
