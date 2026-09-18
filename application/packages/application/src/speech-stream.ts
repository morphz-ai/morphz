import { DomainError } from "../../core/src/model.js";
import {
  type SpeechStreamCommand,
  type SpeechStreamState,
} from "../../core/src/speech-stream.js";
import type { SpeechDuplex, SpeechProvider } from "./speech.js";

type Entry = {
  owner: string;
  scope: string;
  check: () => void;
  state: SpeechStreamState;
  duplex: SpeechDuplex;
  ready: Promise<void>;
  sequence: number;
  lastFrame?: Uint8Array;
  lastAudio: number;
  wake: Set<() => void>;
  timer?: ReturnType<typeof setInterval>;
  expiry?: ReturnType<typeof setTimeout>;
};
const terminal = (entry: Entry) =>
  !["listening", "finishing"].includes(entry.state.status);
const scopeKey = (command: SpeechStreamCommand) =>
  JSON.stringify([
    command.scope.projectId,
    command.scope.artifactId ?? null,
    command.scope.revision ?? null,
  ]);

/** Host-independent, ephemeral streams. Never persist raw audio or credentials. */
export class SpeechStreams {
  private entries = new Map<string, Entry>();
  constructor(private provider?: SpeechProvider) {}

  private update(entry: Entry, changes: Partial<SpeechStreamState>) {
    entry.state = {
      ...entry.state,
      ...changes,
      revision: entry.state.revision + 1,
    };
    if (terminal(entry)) {
      entry.lastFrame = undefined;
      entry.duplex.close();
      clearInterval(entry.timer);
      if (!entry.expiry) {
        entry.expiry = setTimeout(
          () => this.entries.delete(entry.state.id),
          30000,
        );
        entry.expiry.unref();
      }
    }
    for (const wake of entry.wake) wake();
  }
  private cancel(entry: Entry) {
    if (!terminal(entry)) this.update(entry, { status: "cancelled" });
  }
  async call(
    command: SpeechStreamCommand,
    principal: string,
    check: () => void,
    signal: AbortSignal,
  ): Promise<SpeechStreamState> {
    signal.throwIfAborted();
    check();
    let entry = this.entries.get(command.id);
    if (entry) {
      if (entry.owner !== principal || entry.scope !== scopeKey(command))
        throw new DomainError("forbidden", "不能操作其他身份或输入区的听写。");
      try {
        entry.check();
      } catch (error) {
        this.cancel(entry);
        throw error;
      }
    }
    if (command.action === "open" && !entry) {
      if (!this.provider?.openStream || !this.provider.configured())
        throw new DomainError(
          "invalid",
          "当前语音服务不支持实时听写，请检查服务配置。",
        );
      if (this.entries.size >= 128)
        throw new DomainError("invalid", "语音服务繁忙，请稍后重试。");
      const current = {
        owner: principal,
        scope: scopeKey(command),
        check,
        state: { id: command.id, revision: 0, text: "", status: "listening" },
        sequence: 0,
        lastAudio: Date.now(),
        wake: new Set(),
      } as Entry;
      current.duplex = this.provider.openStream(
        principal,
        (text, final) => {
          if (terminal(current)) return;
          try {
            current.check();
          } catch {
            this.cancel(current);
            return;
          }
          if (text !== current.state.text || final)
            this.update(current, {
              text,
              ...(final ? { status: "complete" as const } : {}),
            });
        },
        (error) => {
          if (!terminal(current))
            this.update(current, { status: "error", error });
        },
      );
      current.ready = current.duplex.ready;
      current.timer = setInterval(() => {
        if (terminal(current)) return;
        try {
          current.check();
        } catch {
          this.cancel(current);
          return;
        }
        if (Date.now() - current.lastAudio > 15000)
          this.update(current, {
            status: "error",
            error: "语音采集中断，已识别文字保留；请重新开始。",
          });
      }, 1000);
      current.timer.unref();
      this.entries.set(command.id, current);
      entry = current;
    }
    if (!entry) {
      // A cancellation can race with an aborted opening request.
      if (command.action === "cancel")
        return { id: command.id, revision: 0, text: "", status: "cancelled" };
      throw new DomainError("not_found", "听写已结束，请重新开始。");
    }
    const current = entry;
    const abort = () => this.cancel(current);
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (command.action === "open") {
        await current.ready;
      } else if (command.action === "cancel") {
        this.cancel(current);
      } else if (command.action === "push") {
        if (current.state.status !== "listening")
          throw new DomainError("conflict", "听写已停止，不能继续发送语音。");
        if (
          command.sequence === current.sequence &&
          current.lastFrame &&
          Buffer.from(command.data).equals(current.lastFrame)
        )
          return { ...current.state };
        if (command.sequence !== current.sequence + 1)
          throw new DomainError(
            "conflict",
            "语音帧顺序不一致，请重新开始听写。",
          );
        current.duplex.write(command.data);
        current.sequence = command.sequence;
        current.lastFrame = command.data.slice();
        current.lastAudio = Date.now();
      } else if (
        command.action === "finish" &&
        current.state.status === "listening"
      ) {
        this.update(current, { status: "finishing" });
        current.lastAudio = Date.now();
        current.duplex.finish();
      } else if (
        command.action === "read" &&
        command.after >= current.state.revision &&
        !terminal(current)
      ) {
        if (current.wake.size)
          throw new DomainError("conflict", "听写结果已有订阅。");
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timeout);
            current.wake.delete(done);
            resolve();
          };
          const timeout = setTimeout(done, 5000);
          current.wake.add(done);
        });
      }
      signal.throwIfAborted();
      current.check();
      check();
      return { ...current.state };
    } catch (error) {
      this.cancel(current);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  close() {
    for (const entry of this.entries.values()) {
      this.cancel(entry);
      clearInterval(entry.timer);
      clearTimeout(entry.expiry);
    }
    this.entries.clear();
  }
}
