// Runs on the audio thread. One uninterrupted stream; no recorder restart gaps.
class SpeechCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frames = Math.round(
      sampleRate * options.processorOptions.segmentSeconds,
    );
    this.buffer = new Int16Array(this.frames);
    this.used = 0;
    this.finished = false;
    this.port.onmessage = (event) => {
      if (event.data === "finish") {
        this.finished = true;
        this.flush();
        this.port.postMessage({ finished: true });
      }
    };
  }
  flush() {
    if (!this.used) return;
    const pcm = this.buffer.slice(0, this.used);
    this.port.postMessage({ pcm: pcm.buffer }, [pcm.buffer]);
    this.used = 0;
  }
  process(inputs) {
    if (this.finished) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] || 0;
      value = Math.max(-1, Math.min(1, value / channels.length));
      this.buffer[this.used++] = Math.round(
        value * (value < 0 ? 32768 : 32767),
      );
      if (this.used === this.frames) this.flush();
    }
    // Outputs remain zero: microphone sound is never played through speakers.
    return true;
  }
}
registerProcessor("morphz-speech-capture", SpeechCaptureProcessor);
