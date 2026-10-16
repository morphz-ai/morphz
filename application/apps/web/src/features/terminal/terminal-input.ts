import type {
  TerminalCommand,
  TerminalReceipt,
} from "../../../../../packages/core/src/terminal.js";

/** One bounded keyboard queue, no local echo, model request or automatic retry.
 * Every batch freezes its revision/identity before its first physical attempt. */
export class TerminalInput {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending = false;
  private disposed = false;
  private failure = false;
  private enabled = true;
  private dimensions: { rows: number; cols: number } | undefined;
  private appliedSize: { rows: number; cols: number } | undefined;
  private sendingSize: { rows: number; cols: number } | undefined;
  private revision: number;
  constructor(
    revision: number,
    private send: (command: TerminalCommand) => Promise<TerminalReceipt>,
    private changed: () => void,
    private failed: (message: string) => void,
  ) {
    this.revision = revision;
  }
  observe(revision: number, rows?: number, cols?: number) {
    if (!this.sending && !this.buffer && revision >= this.revision) {
      this.revision = Math.max(this.revision, revision);
      if (rows !== undefined && cols !== undefined)
        this.appliedSize = { rows, cols };
    }
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.dimensions = undefined;
      if (this.buffer && !this.sending)
        this.stop(
          "已离开终端，未确认输入仍保留；请先核对并复制，不会在后台继续发送。",
        );
    }
  }
  input(data: string) {
    if (this.disposed || this.failure || !this.enabled || !data) return;
    if (
      data.includes("\0") ||
      new TextEncoder().encode(this.buffer + data).length > 16384
    ) {
      this.stop("输入过长或含无效字符，已停止发送；不会截断执行。");
      return;
    }
    this.buffer += data;
    if (!this.sending && !this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.drain();
      }, 20);
  }
  resize(rows: number, cols: number) {
    if (this.disposed || this.failure || !this.enabled) return;
    const known = this.sendingSize ?? this.appliedSize;
    if (known?.rows === rows && known.cols === cols) {
      this.dimensions = undefined;
      return;
    }
    this.dimensions = { rows, cols };
    if (!this.sending && !this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.drain();
      }, 80);
  }
  private stop(message: string) {
    this.failure = true;
    this.failed(message);
  }
  private async drain() {
    if (
      this.disposed ||
      !this.enabled ||
      this.sending ||
      this.failure ||
      (!this.buffer && !this.dimensions)
    )
      return;
    let data = "",
      length = 0;
    for (const char of this.buffer) {
      const bytes = new TextEncoder().encode(char).length;
      if (length + bytes > 4096) break;
      data += char;
      length += bytes;
    }
    const dimensions = this.dimensions;
    const command: TerminalCommand = {
      command_id: crypto.randomUUID(),
      expected_revision: this.revision,
      action: data
        ? { type: "input", data }
        : { type: "resize", ...dimensions! },
    };
    if (!data) {
      this.dimensions = undefined;
      this.sendingSize = dimensions;
    }
    this.sending = true;
    try {
      const receipt = await this.send(command);
      if (
        receipt.command_id !== command.command_id ||
        receipt.input_status !== "submitted"
      )
        throw Error("uncertain");
      this.revision = receipt.revision;
      if (!data) this.appliedSize = dimensions;
      this.buffer = this.buffer.slice(data.length);
      if (!this.disposed) {
        this.changed();
        if (!this.enabled && this.buffer)
          this.stop(
            "已离开终端，未确认输入仍保留；请先核对并复制，不会在后台继续发送。",
          );
      }
    } catch {
      if (!this.disposed)
        this.stop(
          "输入回执未确认，已停止后续输入。请核对终端；不会自动重发，待确认文字仍保留在本页。",
        );
    } finally {
      this.sending = false;
      this.sendingSize = undefined;
    }
    if (!this.disposed && !this.failure) void this.drain();
  }
  pending() {
    return this.buffer;
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}
