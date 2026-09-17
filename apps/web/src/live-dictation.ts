import type { WorkspaceClient } from "./client.js";
import type { SpeechStreamState } from "../../../packages/core/src/speech-stream.js";

/** One duplex session: audio writes and result reads run independently. */
export class LiveDictation {
  private controller = new AbortController();
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private sequence = 0;
  private revision = -1;
  private text = "";
  private started = false;
  private connected = false;
  private ending = false;
  private complete = false;
  private opening?: Promise<void>;
  private pumping?: Promise<void>;
  private reading?: Promise<void>;
  constructor(
    private call: ReturnType<WorkspaceClient["createSpeechStream"]>,
    private changed: (text: string, previous: string) => void,
    private failed: (message: string) => void,
    private ended: () => void,
  ) {}
  get active() {
    return this.started && !this.complete && !this.controller.signal.aborted;
  }
  private signal() {
    return AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(10000),
    ]);
  }
  private accept(state: SpeechStreamState) {
    if (
      this.controller.signal.aborted ||
      this.complete ||
      state.revision <= this.revision
    )
      return;
    this.revision = state.revision;
    if (state.text !== this.text) {
      this.changed(state.text, this.text);
      this.text = state.text;
    }
    if (state.status === "error")
      throw new Error(state.error || "语音识别中断，已识别文字保留。");
    if (state.status === "cancelled")
      throw new Error("听写已取消，已识别文字保留。");
    if (state.status === "complete") {
      this.complete = true;
      this.queue = [];
      this.queuedBytes = 0;
      this.ended();
    }
  }
  private fail(error: unknown) {
    if (this.controller.signal.aborted) return;
    this.cancel();
    this.failed(
      error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name)
        ? "语音连接超时，已识别文字保留；请检查网络后重新开始。"
        : error instanceof Error
          ? error.message
          : "语音连接中断，已识别文字保留。",
    );
  }
  start() {
    if (this.opening) return this.opening;
    this.started = true;
    this.opening = (async () => {
      try {
        this.accept(await this.call({ action: "open" }, this.signal()));
        if (this.controller.signal.aborted || this.complete) return;
        this.connected = true;
        this.pump();
        this.reading = this.read();
      } catch (error) {
        this.fail(error);
      }
    })();
    return this.opening;
  }
  enqueue(pcm: Uint8Array) {
    if (this.controller.signal.aborted || this.ending || this.complete) return;
    if (this.queuedBytes + pcm.byteLength > 160000) {
      this.fail(new Error("语音网络传输跟不上，已停止听写；已识别文字保留。"));
      return;
    }
    this.queue.push(pcm);
    this.queuedBytes += pcm.byteLength;
    this.pump();
  }
  private pump() {
    if (
      !this.connected ||
      this.pumping ||
      this.complete ||
      this.controller.signal.aborted
    )
      return;
    this.pumping = (async () => {
      try {
        while (
          this.queue.length &&
          !this.controller.signal.aborted &&
          !this.complete
        ) {
          const data = this.queue.shift()!;
          this.accept(
            await this.call(
              {
                action: "push",
                sequence: ++this.sequence,
                data: new Uint8Array(data),
              },
              this.signal(),
            ),
          );
          this.queuedBytes = Math.max(0, this.queuedBytes - data.byteLength);
        }
      } catch (error) {
        this.fail(error);
      }
    })().finally(() => {
      this.pumping = undefined;
      if (this.queue.length) this.pump();
    });
  }
  private async read() {
    try {
      while (!this.controller.signal.aborted && !this.complete)
        this.accept(
          await this.call(
            { action: "read", after: this.revision },
            this.signal(),
          ),
        );
    } catch (error) {
      this.fail(error);
    }
  }
  async finish() {
    this.ending = true;
    await this.opening;
    this.pump();
    await this.pumping;
    if (this.controller.signal.aborted || this.complete) return;
    try {
      this.accept(await this.call({ action: "finish" }, this.signal()));
      await this.reading;
    } catch (error) {
      this.fail(error);
    }
  }
  cancel() {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.queue = [];
    this.queuedBytes = 0;
    if (this.started && !this.complete)
      void this.call({ action: "cancel" }, AbortSignal.timeout(3000)).catch(
        () => {},
      );
  }
}

/** Replace only this session's recognized tail; never replace an edited draft. */
export function replaceDictationTail(
  body: string,
  text: string,
  previous: string,
) {
  if (previous && !body.endsWith(previous)) return body;
  const next = previous
    ? body.slice(0, -previous.length) + text
    : [body, text].filter(Boolean).join("\n");
  return next.length <= 30000 ? next : body;
}
