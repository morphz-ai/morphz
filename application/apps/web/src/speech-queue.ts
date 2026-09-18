/** Serial ASR with backpressure. Failed audio waits for explicit retry or cancel. */
export class SpeechQueue {
  private pending: Blob[] = [];
  private request: AbortController | null = null;
  private disposed = false;
  private failed = false;
  constructor(
    private options: {
      transcribe(wav: Blob, signal: AbortSignal): Promise<string>;
      text(value: string): void;
      changed(pending: number, error: string): void;
      pressure(): void;
    },
  ) {}
  get length() {
    return this.pending.length;
  }
  enqueue(wav: Blob) {
    if (this.disposed) return;
    this.pending.push(wav);
    this.options.changed(this.pending.length, "");
    if (this.pending.length >= 3) this.options.pressure();
    void this.drain();
  }
  private async drain() {
    if (this.request || this.failed || this.disposed || !this.pending.length)
      return;
    const request = new AbortController();
    this.request = request;
    try {
      let text = "";
      try {
        text = await this.options.transcribe(this.pending[0]!, request.signal);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("没有识别到语音")
        )
          throw error;
      }
      if (this.disposed || request.signal.aborted) return;
      this.pending.shift();
      if (text.trim()) this.options.text(text);
      this.options.changed(this.pending.length, "");
    } catch (error) {
      if (this.disposed || request.signal.aborted) return;
      this.failed = true;
      this.options.changed(
        this.pending.length,
        error instanceof Error
          ? error.message
          : "语音识别失败，待处理语音仍保留，可重试。",
      );
      this.options.pressure();
    } finally {
      this.request = null;
      if (!this.failed && !this.disposed) void this.drain();
    }
  }
  retry() {
    this.failed = false;
    void this.drain();
  }
  cancel() {
    this.disposed = true;
    this.request?.abort();
    this.pending = [];
  }
}
