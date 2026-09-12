import {
  speechCaptureSegmentSeconds,
  speechSampleRate,
  wavFromPCM,
} from "../../../packages/core/src/audio.js";

export class SpeechCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private cancelled = false;
  private finishing: Promise<void> | null = null;
  private finishAck: (() => void) | null = null;
  private meterFrame: number | null = null;
  constructor(
    private onSegment: (wav: Blob) => void,
    private onError: (message: string) => void,
    private onLevel?: (level: number) => void,
  ) {}
  async start() {
    try {
      this.context = new AudioContext({ sampleRate: speechSampleRate });
      await this.context.resume();
      if (this.cancelled) return;
      if (
        window.morphzDesktop &&
        !(await window.morphzDesktop.voice.requestMicrophone())
      )
        throw new Error("麦克风未授权，请在系统设置中允许后再试。");
      if (this.cancelled) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      if (this.cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      const context = this.context!;
      if (context.sampleRate !== speechSampleRate)
        throw new Error("当前音频设备无法建立语音采样通道。");
      await context.audioWorklet.addModule(
        new URL("./speech-capture.worklet.js", import.meta.url),
      );
      if (this.cancelled) return;
      const node = new AudioWorkletNode(context, "morphz-speech-capture", {
        processorOptions: { segmentSeconds: speechCaptureSegmentSeconds },
      });
      this.node = node;
      node.port.onmessage = (
        event: MessageEvent<{ pcm?: ArrayBuffer; finished?: boolean }>,
      ) => {
        if (this.cancelled) return;
        if (event.data.pcm)
          this.onSegment(
            new Blob(
              [new Uint8Array(wavFromPCM(new Uint8Array(event.data.pcm)))],
              { type: "audio/wav" },
            ),
          );
        if (event.data.finished) this.finishAck?.();
      };
      node.onprocessorerror = () =>
        this.onError("语音采集中断，已识别文字保留，请重新开始。");
      stream.getTracks().forEach((track) =>
        track.addEventListener("ended", () => {
          if (!this.cancelled && !this.finishing)
            this.onError("麦克风已断开，已识别文字保留。");
        }),
      );
      const source = context.createMediaStreamSource(stream);
      source.connect(node);
      if (this.onLevel) {
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        let previous = 0;
        const measure = (now: number) => {
          if (this.cancelled) return;
          if (now - previous >= 100) {
            previous = now;
            analyser.getFloatTimeDomainData(samples);
            const rms = Math.sqrt(
              samples.reduce((sum, value) => sum + value * value, 0) /
                samples.length,
            );
            this.onLevel!(Math.min(1, rms * 5));
          }
          this.meterFrame = requestAnimationFrame(measure);
        };
        this.meterFrame = requestAnimationFrame(measure);
      }
      node.connect(context.destination);
    } catch (error) {
      this.cancel();
      throw error;
    }
  }
  finish(): Promise<void> {
    if (this.finishing) return this.finishing;
    this.finishing = (async () => {
      // Stop the device immediately, then flush already captured samples.
      this.stream?.getTracks().forEach((t) => t.stop());
      if (this.node && !this.cancelled) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("语音尾段处理超时，已识别文字保留。")),
            3000,
          );
          this.finishAck = () => {
            clearTimeout(timer);
            resolve();
          };
          this.node!.port.postMessage("finish");
        });
      }
    })().finally(() => this.cancel());
    return this.finishing;
  }
  cancel() {
    this.cancelled = true;
    if (this.meterFrame !== null) cancelAnimationFrame(this.meterFrame);
    this.meterFrame = null;
    this.onLevel?.(0);
    this.finishAck?.();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.node?.disconnect();
    this.node?.port.close();
    this.node = null;
    void this.context?.close().catch(() => {});
    this.context = null;
    void window.morphzDesktop?.voice.cancelMicrophone().catch(() => {});
  }
}
