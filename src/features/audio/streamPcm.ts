import { STT_SAMPLE_RATE } from "./mic";

export { STT_SAMPLE_RATE };

export interface PcmTap {
  /** Continuous 16 kHz mono Int16 chunks (~50 ms) for as long as the tap is open. */
  onChunk: ((pcm: ArrayBuffer) => void) | null;
  dispose(): void;
}

/** Streams a MediaStream's audio as 16 kHz PCM (same worklet as the mic path). Does not play the audio locally. */
export async function openPcmTap(stream: MediaStream): Promise<PcmTap> {
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("/pcm-worklet.js");
  if (ctx.state === "suspended") await ctx.resume();
  // Chrome can suspend an AudioContext it considers idle or interrupted; captions would silently stall. Always resume.
  ctx.onstatechange = () => {
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  };
  const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  const node = new AudioWorkletNode(ctx, "pcm-capture");
  const mute = ctx.createGain(); // keeps the graph pulled without making a sound
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);
  const tap: PcmTap = {
    onChunk: null,
    dispose() {
      tap.onChunk = null;
      ctx.onstatechange = null;
      node.port.onmessage = null;
      src.disconnect();
      node.disconnect();
      mute.disconnect();
      void ctx.close();
    },
  };
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => tap.onChunk?.(e.data);
  return tap;
}
