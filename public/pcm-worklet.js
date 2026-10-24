// AudioWorklet: downsample mic audio to 16 kHz mono and post Int16 PCM chunks (~50 ms) to the main thread.
// Box-filter decimation with a fractional phase accumulator, so non-integer ratios (e.g. 44.1 kHz) stay at the right pitch.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.phase = 0;
    this.acc = 0;
    this.n = 0;
    this.out = [];
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.n++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.n));
        this.out.push(v < 0 ? v * 0x8000 : v * 0x7fff);
        this.acc = 0;
        this.n = 0;
      }
    }
    if (this.out.length >= 800) {
      const pcm = new Int16Array(this.out);
      this.out = [];
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
