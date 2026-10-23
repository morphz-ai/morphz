import type { ConversationRuntime } from "../../../packages/core/src/conversation.js";
import type { LiveMessage } from "../../../packages/core/src/live-conversation.js";
import { isRuntimeMessageDiagnostic } from "../../../packages/core/src/runtime-message-failure.js";
export { messageSourceSummary } from "../../../packages/core/src/message-source.js";

/** Only actual input-bound receipts may name a stage. Silence is not proof
 * of model reasoning, retrieval, tool execution, or percentage progress. */
export function responseWaitingPresentation(
  delivery: ConversationRuntime["deliveries"][number],
  messages: readonly LiveMessage[],
  connected: boolean,
  stopPending = false,
  activity?: ConversationRuntime["activity"],
) {
  const waiting = (
    label: string,
    animated = connected,
    showElapsed = true,
  ) => ({
    label,
    connected,
    animated,
    showElapsed,
  });
  if (!connected) return waiting("连接中断，等待恢复", false);
  if (delivery.cancelRequested || stopPending)
    return waiting("已请求停止，等待确认");
  if (delivery.state === "sending") return waiting("正在发送…");
  if (delivery.state === "queued") return waiting("排队等待…");
  const latestRecovery = messages
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
  const recovery =
    latestRecovery?.providerRecovery?.phase === "waiting"
      ? latestRecovery
      : undefined;
  const active = messages
    .filter(
      (m) =>
        m.inputId === delivery.inputId &&
        m.kind === "tool" &&
        ["running", "generating", "pending"].includes(m.tool?.status ?? ""),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const model = messages
    .filter((m) => m.inputId === delivery.inputId && m.modelActivity)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const latest = [active, model]
    .filter((m) => m !== undefined)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const recoveryLabel =
    recovery?.providerRecovery?.reason === "credentials"
      ? "模型认证失败，等待修复"
      : recovery?.providerRecovery?.reason === "configuration"
        ? "模型配置不可用，等待修复"
        : recovery?.providerRecovery?.reason === "capacity"
          ? "模型额度不足，等待处理"
          : recovery?.providerRecovery?.reason === "service"
            ? "模型服务暂时中断，自动重试中…"
            : "模型服务不可用，等待恢复";
  // A credential/configuration/allowance repair is not active retrying.
  // Preserve the actual connection state; suppress only the activity clock
  // and animation, using the Runtime's structured cause rather than prose.
  const recoveryPresentation = () =>
    waiting(
      recoveryLabel,
      recovery?.providerRecovery?.reason === "service",
      recovery?.providerRecovery?.reason === "service",
    );
  if (
    recovery &&
    (!latest || latest.createdAt <= recovery.providerRecovery!.startedAt)
  )
    return recoveryPresentation();
  const modelPresentation = () =>
    waiting(
      {
        queued: "模型请求排队中…",
        streaming: "等待模型输出…",
        reasoning: "正在思考…",
        waiting_final_output: "思考完成，等待输出…",
        streaming_text: "正在生成回复…",
        generating_tool_call: "正在准备工具调用…",
        settling: "正在处理响应…",
      }[model!.modelActivity!],
    );
  if (model && latest === model) return modelPresentation();
  if (active?.tool?.status === "running") {
    const progress = activity?.available
      ? activity.threads
          .find(
            (thread) =>
              thread.id === active.threadId &&
              thread.inputId === delivery.inputId &&
              thread.rootId === active.rootId &&
              thread.lifecycle === "open" &&
              thread.annotationProtocol === "on",
          )
          ?.summary?.trim()
      : undefined;
    return waiting(
      progress
        ? [...progress].slice(0, 96).join("") +
            ([...progress].length > 96 ? "…" : "")
        : "正在执行工具…",
    );
  }
  if (active?.tool?.status === "generating")
    return waiting("正在生成工具调用…");
  if (active?.tool?.status === "pending") return waiting("工具调用等待执行…");
  if (model) return modelPresentation();
  if (recovery) return recoveryPresentation();
  if (activity?.available) {
    const owned = activity.threads.filter(
      (t) => t.inputId === delivery.inputId && t.lifecycle === "open",
    );
    if (owned.some((t) => t.delegation && t.phase === "running"))
      return waiting("正在执行子任务…");
    if (owned.some((t) => t.delegation || t.waitKinds?.includes("delegation")))
      return waiting("等待子任务结果…");
  }
  return waiting("等待回复…");
}

/** Recovery belongs to one accepted input, not another concurrent request.
 * An incomplete pre-failure prefix is readable, but not a finished answer. */
export function responseAnswered(
  messages: readonly LiveMessage[],
  inputId: string,
) {
  const owned = messages.filter((m) => m.inputId === inputId);
  const recoveryAt = owned
    .filter(
      (m) => m.kind === "progress" && m.providerRecovery?.phase === "waiting",
    )
    .map((m) => m.providerRecovery!.startedAt)
    .sort()
    .at(-1);
  return owned.some(
    (m) =>
      !isRuntimeMessageDiagnostic(m) &&
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
