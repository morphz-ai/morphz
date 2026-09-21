import { z } from "zod";

export const liveMessageSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  conversationId: z.string(),
  artifactId: z.string().nullable(),
  inputId: z.string().nullable(),
  rootId: z.string().nullable(),
  createdAt: z.string(),
  text: z.string(),
  kind: z.enum(["reply", "progress", "error", "tool"]),
  streaming: z.boolean().optional(),
  publicationKey: z.string().optional(),
  sequence: z.number().int().nonnegative().optional(),
  threadId: z.string().optional(),
  tool: z
    .object({
      name: z.string(),
      arguments: z.string(),
      status: z.string(),
      result: z.string().optional(),
      truncated: z.boolean().optional(),
    })
    .optional(),
});
export type LiveMessage = z.infer<typeof liveMessageSchema>;
export const conversationStreamSchema = z.object({
  connected: z.boolean(),
  messages: z.array(liveMessageSchema),
});
export type ConversationStream = z.infer<typeof conversationStreamSchema>;
export const conversationFrameSchema = conversationStreamSchema.extend({
  reset: z.boolean().default(true),
  removed: z.array(z.string()).default([]),
});
export type StreamEvent = {
  id: string;
  timestamp: string;
  topic: string;
  type?: string;
  sequence?: number;
  payload: Record<string, unknown>;
};
type Attempt = {
  message: LiveMessage;
  activation: string;
  continuation: boolean;
  tools: Map<number, LiveMessage>;
};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const preview = (v: string) => v.slice(0, 12000);

/** Transient model deltas and durable outcomes are separate, as in Dashboard.
 * No hidden reasoning or complete model request snapshots are exposed. */
export class LiveConversationProjection {
  private attempts = new Map<string, Attempt>();
  private messages = new Map<string, LiveMessage>();
  private seen = new Set<string>();
  private cancelled = new Set<string>();
  private resolved = new Set<string>();
  private background = new Map<string, string>();
  constructor(
    private route: (
      e: StreamEvent,
    ) => Omit<LiveMessage, "id" | "text" | "kind" | "createdAt">,
  ) {}
  private retainAttempt(attempt: Attempt) {
    if (attempt.message.text)
      this.messages.set(attempt.message.id, {
        ...attempt.message,
        streaming: false,
      });
    for (const tool of attempt.tools.values())
      if (!this.messages.has(tool.id))
        this.messages.set(tool.id, { ...tool, streaming: false });
  }
  reconnect() {
    // Stop animation, not reading. A disconnected suffix cannot extend this
    // prefix; only a new complete stream or its durable outcome may replace it.
    for (const attempt of this.attempts.values()) this.retainAttempt(attempt);
    this.attempts.clear();
  }
  private base(e: StreamEvent): LiveMessage {
    return {
      ...this.route(e),
      id: e.id,
      createdAt: e.timestamp,
      // Transient stream counters are not durable event sequence numbers.
      ...(e.topic !== "runtime/model_stream" && e.sequence !== undefined
        ? { sequence: e.sequence }
        : {}),
      ...(typeof e.payload.attempt_id === "string"
        ? { publicationKey: e.payload.attempt_id }
        : {}),
      ...(typeof e.payload.thread_id === "string"
        ? { threadId: e.payload.thread_id }
        : {}),
      text: "",
      kind: "reply",
    };
  }
  consume(e: StreamEvent) {
    const p = e.payload,
      attemptId = str(p.attempt_id),
      activation = str(p.activation_id) || attemptId;
    const semantic = [
      "chat/reply",
      "chat/outbound_message",
      "chat/progress",
      "chat/no_reply",
      "chat/cancelled",
      "chat/runtime_error",
      "session/io_state",
      "runtime/thread_result",
      "runtime/response_protocol_fused",
      "runtime/response_protocol_error",
      "runtime/tool_calls_selected",
      "runtime/reasoning_continuation",
      "chat/assistant_call",
    ].includes(e.topic);
    if (semantic) {
      const replacesText =
        [
          "chat/reply",
          "chat/outbound_message",
          "chat/runtime_error",
          "session/io_state",
          "runtime/response_protocol_fused",
        ].includes(e.topic) && !!str(p.text ?? p.error ?? p.message);
      if (attemptId) this.resolved.add(attemptId);
      if (e.topic === "chat/cancelled" && activation)
        this.cancelled.add(activation);
      for (const [id, a] of this.attempts)
        if (id === attemptId || (!attemptId && activation === a.activation)) {
          // Tool selection / assistant_call is a handoff, not permission to
          // remove words already shown. Final text replaces them atomically.
          if (!replacesText) this.retainAttempt(a);
          this.attempts.delete(id);
        }
      if (replacesText && attemptId)
        for (const [id, message] of this.messages)
          if (
            message.kind !== "tool" &&
            message.streaming !== undefined &&
            message.publicationKey === attemptId
          )
            this.messages.delete(id);
    }
    if (e.topic === "runtime/model_stream") {
      if (
        !attemptId ||
        this.resolved.has(attemptId) ||
        this.cancelled.has(activation)
      )
        return;
      const s = obj(p.stream),
        kind = str(s.kind);
      if (kind === "started") {
        const previous = [...this.attempts.entries()].filter(
          ([, a]) => a.activation === activation && a.continuation,
        );
        const text = previous.map(([, a]) => a.message.text).join("");
        for (const [id] of previous) this.attempts.delete(id);
        this.attempts.set(attemptId, {
          activation,
          continuation: false,
          tools: new Map(),
          message: {
            ...this.base(e),
            id: `stream:${attemptId}`,
            text,
            streaming: true,
          },
        });
      }
      const a = this.attempts.get(attemptId);
      if (!a) return; // Reconnect suffixes must never masquerade as complete prefixes.
      if (kind === "text_delta") {
        if (!a.message.text) a.message.createdAt = e.timestamp;
        a.message.text += str(s.text);
      }
      const index = typeof s.index === "number" ? s.index : -1;
      if (kind === "tool_call_started")
        a.tools.set(index, {
          ...this.base(e),
          id: `tool:${str(s.id) || attemptId + ":" + index}`,
          kind: "tool",
          text: "",
          streaming: true,
          tool: { name: str(s.name), arguments: "", status: "generating" },
        });
      const tool = a.tools.get(index)?.tool;
      if (kind === "tool_arguments_delta" && tool) {
        const value = tool.arguments + str(s.delta);
        tool.arguments = preview(value);
        tool.truncated ||= value.length > 12000;
      }
      if (kind === "tool_call_completed" && tool) tool.status = "pending";
      if (kind === "completed") a.message.streaming = false; // Not execution success.
      if (kind === "incomplete") {
        a.continuation = true;
        a.message.streaming = false;
      }
      if (kind === "failed") {
        a.message.kind = "error";
        a.message.text ||= str(s.message) || "生成中断";
        a.message.streaming = false;
      }
      return;
    }
    if (e.topic === "runtime/model_attempt_state") {
      const a = this.attempts.get(attemptId);
      if (a && p.terminal === true) {
        a.message.streaming = false;
        a.continuation = p.continuation_pending === true;
        if (["cancelled", "interrupted"].includes(str(p.state))) {
          this.cancelled.add(activation);
          this.retainAttempt(a);
          this.attempts.delete(attemptId);
        }
        if (str(p.state) === "failed") {
          a.message.kind = "error";
          a.message.text ||= str(p.detail) || "生成失败";
        }
      }
      return;
    }
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    const calls =
      e.topic === "chat/assistant_call"
        ? [
            ...(Array.isArray(p.tool_calls) ? p.tool_calls : []),
            ...(Array.isArray(p.continuation_tool_calls)
              ? p.continuation_tool_calls
              : []),
          ]
        : e.topic === "runtime/tool_calls_selected" && Array.isArray(p.calls)
          ? p.calls
          : [];
    for (const raw of calls) {
      const call = obj(raw),
        fn = obj(call.function),
        id = str(call.id);
      if (!id) continue;
      const old = this.messages.get(`tool:${id}`),
        args = str(call.arguments ?? fn.arguments);
      const richer =
        old?.tool &&
        !old.tool.truncated &&
        old.tool.arguments !== "{}" &&
        old.tool.arguments.length > 0;
      this.messages.set(`tool:${id}`, {
        ...this.base(e),
        ...old,
        id: `tool:${id}`,
        kind: "tool",
        text: "",
        tool: {
          ...old?.tool,
          name: str(call.name ?? fn.name) || "工具",
          arguments: richer ? old!.tool!.arguments : preview(args),
          status: ["generating", "pending"].includes(old?.tool?.status ?? "")
            ? "running"
            : (old?.tool?.status ?? "running"),
          truncated: richer
            ? false
            : call.truncated === true || args.length > 12000,
        },
      });
    }
    if (e.type === "tool_output" || e.topic === "chat/tool_output") {
      const callId = str(p.tool_call_id),
        taskId = str(p.task_id);
      if (!callId) return;
      const completion =
        p.tool_name === "exec/background" || callId.endsWith(":background");
      const id =
        completion && taskId
          ? (this.background.get(taskId) ?? `tool:${callId}`)
          : `tool:${callId}`;
      const old = this.messages.get(id);
      if (p.execution === "background" && taskId)
        this.background.set(taskId, id);
      const result = str(p.text);
      this.messages.set(id, {
        ...this.base(e),
        ...old,
        id,
        kind: "tool",
        text: "",
        tool: {
          name: old?.tool?.name || str(p.tool_name) || "工具",
          arguments: old?.tool?.arguments ?? "",
          status: str(p.task_status) || str(p.tool_status) || "success",
          result: preview(result),
          truncated: old?.tool?.truncated || result.length > 12000,
        },
      });
    }
    const kind = ["chat/reply", "chat/outbound_message"].includes(e.topic)
      ? "reply"
      : e.topic === "chat/progress"
        ? "progress"
        : [
              "chat/runtime_error",
              "session/io_state",
              "runtime/response_protocol_fused",
            ].includes(e.topic)
          ? "error"
          : null;
    const text = str(p.text ?? p.error ?? p.message);
    if (kind && text) this.messages.set(e.id, { ...this.base(e), kind, text });
  }
  snapshot(): LiveMessage[] {
    const result = new Map(this.messages);
    for (const a of this.attempts.values()) {
      if (a.message.text) result.set(a.message.id, a.message);
      for (const tool of a.tools.values())
        if (!result.has(tool.id)) result.set(tool.id, tool);
    }
    return [...result.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }
}
