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
  constructor(
    private onSegment: (wav: Blob) => void,
    private onError: (message: string) => void,
  ) {}
  async start() {
    try {
      this.context = new AudioContext({ sampleRate: speechSampleRate });
      await this.context.resume();
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
      context.createMediaStreamSource(stream).connect(node);
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
