import type { ConversationRuntime } from "../../../packages/core/src/conversation.js";
import type { LiveMessage } from "../../../packages/core/src/live-conversation.js";
import type { RecordedInput } from "../../../packages/core/src/model.js";

export function messageSourceSummary(input: RecordedInput | undefined): string {
  if (!input) return "原消息";
  const text =
    input.body.trim() ||
    input.textQuotes
      ?.map((q) => q.comment.trim())
      .filter(Boolean)
      .join("；") ||
    input.textQuotes?.map((q) => q.text.trim()).join("；") ||
    input.attachments?.map((a) => a.name).join("、") ||
    "原消息";
  const compact = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(compact);
  return chars.length > 50 ? chars.slice(0, 50).join("") + "…" : compact;
}

/** Only actual input-bound receipts may name a stage. Silence is not proof
 * of model reasoning, retrieval, tool execution, or percentage progress. */
export function responseWaitingLabel(
  delivery: ConversationRuntime["deliveries"][number],
  messages: readonly LiveMessage[],
  connected: boolean,
  stopPending = false,
): string {
  if (!connected) return "连接中断，等待恢复";
  if (delivery.cancelRequested || stopPending) return "已请求停止，等待确认";
  if (delivery.state === "sending") return "正在发送…";
  if (delivery.state === "queued") return "排队等待…";
  const recovery = messages
    .filter(
      (m) =>
        m.inputId === delivery.inputId &&
        m.kind === "progress" &&
        m.providerRecovery,
    )
    .sort((a, b) =>
      b.providerRecovery!.startedAt.localeCompare(
        a.providerRecovery!.startedAt,
      ),
    )[0];
  const active = messages
    .filter(
      (m) =>
        m.inputId === delivery.inputId &&
        m.kind === "tool" &&
        ["running", "generating", "pending"].includes(m.tool?.status ?? ""),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (
    recovery &&
    (!active || active.createdAt <= recovery.providerRecovery!.startedAt)
  )
    return "模型服务暂时中断，自动重试中…";
  if (active?.tool?.status === "running") return "正在执行工具…";
  if (active?.tool?.status === "generating") return "正在生成工具调用…";
  if (active?.tool?.status === "pending") return "工具调用等待执行…";
  if (recovery) return "模型服务暂时中断，自动重试中…";
  return "等待回复…";
}

/** Recovery belongs to one accepted input, not another concurrent request.
 * An incomplete pre-failure prefix is readable, but not a finished answer. */
export function responseAnswered(
  messages: readonly LiveMessage[],
  inputId: string,
) {
  const owned = messages.filter((m) => m.inputId === inputId);
  const recoveryAt = owned
    .filter((m) => m.kind === "progress" && m.providerRecovery)
    .map((m) => m.providerRecovery!.startedAt)
    .sort()
    .at(-1);
  return owned.some(
    (m) =>
      (m.kind === "reply" || m.kind === "error") &&
      m.text.trim() &&
      (!recoveryAt ||
        m.kind === "error" ||
        (!m.incomplete && m.createdAt > recoveryAt)),
  );
}

export function responseElapsed(createdAt: string, now: number): string | null {
  const start = Date.parse(createdAt);
  if (!Number.isFinite(start) || start > now) return null;
  const seconds = Math.floor((now - start) / 1000);
  return seconds < 60
    ? `${seconds} 秒`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒`
      : `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}

type ResponseDelivery = Readonly<
  Pick<
    ConversationRuntime["deliveries"][number],
    "state" | "error" | "supplement"
  >
>;

/** Observable waiting only: callers retain exact input/stream ownership and
 * their cancellation policy. This is neither a reply nor execution evidence. */
export function isPendingResponse({
  configured,
  delivery,
  answered,
  approvalPending,
}: Readonly<{
  configured: boolean;
  delivery: ResponseDelivery | undefined;
  answered: boolean;
  approvalPending: boolean;
}>): boolean {
  return (
    configured &&
    !!delivery &&
    !delivery.supplement &&
    !delivery.error &&
    ["queued", "sending", "running"].includes(delivery.state) &&
    !answered &&
    !approvalPending
  );
}

const dateLabel = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
});

/** Calendar boundaries follow the reader's local time, like message timestamps. */
export function conversationDate(createdAt: string) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  const key = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return {
    key,
    label: dateLabel.format(date),
  };
}
