import type { ConversationRuntime } from "../../../../../packages/core/src/conversation.js";
import type { LiveMessage } from "../../../../../packages/core/src/live-conversation.js";
import type {
  RecordedInput,
  Workspace,
} from "../../../../../packages/core/src/model.js";
import {
  isPendingResponse,
  responseAnswered,
  responseWaitingPresentation,
} from "../../conversation-presentation.js";
import {
  executionActivityIsDeferred,
  executionActivityStatus,
} from "../../execution-activity.js";
import { liveToolPresentation } from "../../execution-presentation.js";

export type CollapsedComposerState = {
  kind:
    | "idle"
    | "unread"
    | "running"
    | "processing"
    | "queued"
    | "waiting"
    | "approval"
    | "paused"
    | "error"
    | "offline"
    | "unknown";
  label: string;
  detail: string;
  animated: boolean;
  count: number;
};

/** A bounded excerpt of public prose, not a generated summary or tool payload. */
function excerpt(value: string, tail = false) {
  const bounded = tail ? value.slice(-1024) : value.slice(0, 1024);
  const lines = bounded
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const line = ((tail ? lines.at(-1) : lines[0]) ?? "")
    .replace(/^\s{0,3}(?:#{1,6}|>)\s+/, "")
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(line);
  return chars.length <= 96
    ? line
    : tail
      ? "…" + chars.slice(-96).join("")
      : chars.slice(0, 96).join("") + "…";
}

/** Presentation of the already-authorized current conversation. No reads,
 * clocks, receipts, navigation or execution are owned by the collapsed entry. */
export function collapsedComposerState({
  runtime,
  online,
  inputs,
  messages,
  streamConnected,
  outputInputIds,
  unseenReply,
  workspace,
}: {
  runtime: ConversationRuntime;
  online: boolean;
  inputs: readonly RecordedInput[];
  messages: readonly LiveMessage[];
  streamConnected: boolean;
  outputInputIds: readonly string[];
  unseenReply: boolean;
  workspace: Workspace;
}): CollapsedComposerState {
  const result = (
    kind: CollapsedComposerState["kind"],
    label: string,
    detail = "",
    animated = false,
    count = 0,
  ): CollapsedComposerState => ({ kind, label, detail, animated, count });
  if (!runtime.configured)
    return result(
      unseenReply ? "unread" : "idle",
      unseenReply ? "有新回复" : "",
    );
  if (!online || !runtime.connected)
    return result("offline", "连接中断", "等待连接恢复；原任务不会重新发送");
  const inputMap = new Map(inputs.map((input) => [input.id, input]));
  const latestInput = inputs.reduce<RecordedInput | undefined>(
    (latest, input) =>
      !latest || input.createdAt > latest.createdAt ? input : latest,
    undefined,
  );
  const byInput = new Map<string, LiveMessage[]>();
  for (const message of messages) {
    if (!message.inputId || !inputMap.has(message.inputId)) continue;
    const group = byInput.get(message.inputId) ?? [];
    group.push(message);
    byInput.set(message.inputId, group);
  }
  const threads = (
    runtime.activity?.available ? runtime.activity.threads : []
  ).filter(
    (thread) =>
      thread.inputId &&
      inputMap.has(thread.inputId) &&
      ["execution", "dialogue_turn"].includes(thread.kind ?? ""),
  );
  const threadMap = new Map(threads.map((thread) => [thread.id, thread]));
  const open = threads.filter(
    (thread) =>
      thread.lifecycle === "open" &&
      !executionActivityIsDeferred(thread, runtime),
  );
  const openInputIds = new Set(open.map((thread) => thread.inputId!));
  const endedInputIds = new Set(
    threads
      .filter((thread) => thread.lifecycle !== "open")
      .map((thread) => thread.inputId!),
  );
  const deliveries = new Map(
    runtime.deliveries
      .filter((delivery) => inputMap.has(delivery.inputId))
      .map((delivery) => [delivery.inputId, delivery]),
  );
  const answeredOutputs = new Set(outputInputIds);
  const approvals = runtime.attention?.available
    ? runtime.attention.approvals.filter(
        (approval) =>
          approval.scope.inputId && inputMap.has(approval.scope.inputId),
      )
    : [];
  const candidates = new Map<
    string,
    { state: CollapsedComposerState; rank: number; time: string }
  >();
  const offer = (
    id: string,
    state: CollapsedComposerState,
    rank: number,
    time: string,
  ) => {
    const old = candidates.get(id);
    if (!old || rank > old.rank || (rank === old.rank && time > old.time))
      candidates.set(id, { state, rank, time });
  };
  const detail = (id: string, fallback = "") => {
    const latest = byInput
      .get(id)
      ?.filter(
        (message) =>
          ["progress", "reply"].includes(message.kind) &&
          !message.providerRecovery &&
          message.text.trim(),
      )
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          (b.sequence ?? 0) - (a.sequence ?? 0),
      )[0];
    return latest
      ? excerpt(latest.text, latest.streaming === true)
      : excerpt(fallback);
  };
  for (const thread of open) {
    const status = executionActivityStatus(thread, true);
    const kind =
      status.kind === "running"
        ? "running"
        : status.kind === "paused"
          ? "paused"
          : status.kind === "waiting"
            ? "waiting"
            : "unknown";
    offer(
      thread.inputId!,
      result(
        kind,
        status.label,
        detail(thread.inputId!, thread.summary || thread.title),
        kind === "running",
        1,
      ),
      // An observed scheduler wait/pause outranks delivery acceptance.
      kind === "running" ? 70 : 60,
      thread.updatedAt,
    );
  }
  for (const [id, group] of byInput) {
    const delivery = deliveries.get(id);
    for (const message of group) {
      const terminal = message.threadId
        ? threadMap.get(message.threadId)
        : undefined;
      if (
        !streamConnected ||
        !message.streaming ||
        (terminal &&
          terminal.lifecycle !== "open" &&
          message.createdAt <= terminal.updatedAt) ||
        (["completed", "failed", "cancelled", "merged"].includes(
          delivery?.state ?? "",
        ) &&
          !openInputIds.has(id) &&
          !message.threadId)
      )
        continue;
      if (message.kind === "reply" && message.text.trim())
        offer(
          id,
          result("running", "正在回复", excerpt(message.text, true), true, 1),
          75,
          message.createdAt,
        );
      if (
        message.kind === "tool" &&
        message.tool &&
        ["generating", "pending", "running"].includes(message.tool.status)
      ) {
        const stage =
          message.tool.status === "running"
            ? "执行中"
            : message.tool.status === "generating"
              ? "正在准备工具调用"
              : "等待工具执行";
        offer(
          id,
          result(
            "running",
            stage,
            detail(id, liveToolPresentation(message.tool, workspace).title),
            message.tool.status !== "pending",
            1,
          ),
          80,
          message.createdAt,
        );
      }
    }
  }
  for (const [id, delivery] of deliveries) {
    const group = byInput.get(id) ?? [];
    if (
      !(
        delivery.state === "running" &&
        endedInputIds.has(id) &&
        !openInputIds.has(id)
      ) &&
      isPendingResponse({
        configured: runtime.configured,
        delivery,
        answered: responseAnswered(group, id) || answeredOutputs.has(id),
        approvalPending: approvals.some(
          (approval) => approval.scope.inputId === id,
        ),
      })
    ) {
      const waiting = responseWaitingPresentation(delivery, group, true);
      const recovery = group
        .filter((message) => message.providerRecovery)
        .sort((a, b) =>
          b.providerRecovery!.startedAt.localeCompare(
            a.providerRecovery!.startedAt,
          ),
        )[0]?.providerRecovery;
      const newerTool = group.some(
        (message) =>
          message.kind === "tool" &&
          ["generating", "pending", "running"].includes(
            message.tool?.status ?? "",
          ) &&
          recovery &&
          message.createdAt > recovery.startedAt,
      );
      const recovering = recovery?.phase === "waiting" && !newerTool;
      const kind = delivery.cancelRequested
        ? "waiting"
        : delivery.state === "queued" || delivery.state === "sending"
          ? "queued"
          : recovering
            ? "waiting"
            : "processing";
      offer(
        id,
        result(
          kind,
          waiting.label === "等待回复…"
            ? "正在处理"
            : waiting.label.replace(/…$/, ""),
          detail(id, inputMap.get(id)?.body),
          !delivery.cancelRequested && kind !== "queued" && waiting.animated,
          1,
        ),
        delivery.cancelRequested ? 100 : recovering ? 90 : 50,
        inputMap.get(id)!.createdAt,
      );
    }
    if (
      latestInput?.id === id &&
      !delivery.supplement &&
      (delivery.error || delivery.state === "failed")
    )
      offer(
        id,
        result("error", "请求未完成", "展开交流查看错误与重试入口"),
        110,
        latestInput.createdAt,
      );
  }
  for (const approval of approvals)
    offer(
      approval.scope.inputId!,
      result(
        "approval",
        "等待你批准",
        detail(approval.scope.inputId!, "有操作需要你确认，任务尚未继续"),
        false,
        1,
      ),
      120,
      approval.approval.requested_at,
    );
  const selected = [...candidates].sort(
    ([, a], [, b]) => b.rank - a.rank || b.time.localeCompare(a.time),
  )[0];
  if (selected) {
    const [inputId, current] = selected;
    const active = [...candidates.values()].filter((candidate) =>
      ["running", "processing", "queued"].includes(candidate.state.kind),
    );
    const parallel = open.filter(
      (thread) => thread.inputId === inputId && thread.phase === "running",
    ).length;
    return {
      ...current.state,
      count: active.length || current.state.count,
      label:
        current.state.kind === "running" && parallel > 1
          ? `${current.state.label} · ${parallel} 路并行`
          : current.state.label,
    };
  }
  return unseenReply
    ? result("unread", "有新回复", detail(latestInput?.id ?? ""))
    : result("idle", "");
}
