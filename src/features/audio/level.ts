/** Root-mean-square level of 16-bit PCM, 0 (silence) to 1 (full scale). */
export function rmsLevel(pcm: ArrayBuffer): number {
  const s = new Int16Array(pcm, 0, Math.floor(pcm.byteLength / 2));
  if (s.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const v = s[i]! / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / s.length);
}

/** Maps an RMS level to a 0-1 meter position on a decibel scale: -60 dB (or less) is empty, 0 dB is full. */
export function meterPosition(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}
