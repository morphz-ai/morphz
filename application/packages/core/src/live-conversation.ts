import { z } from "zod";
import {
  runtimeMessageFailureSchema,
  runtimeMessageFailureFromEvent,
} from "./runtime-message-failure.js";
import { internalModelOutput } from "./model-publication.js";
import { modelActivitySchema } from "./model-activity.js";
import {
  evaluationResultSchema,
  evaluationSourceSchema,
  evaluationMessageId,
} from "./evaluation-result.js";
import {
  providerRecoverySchema,
  providerRecoveryFromEvent,
} from "./provider-recovery.js";

export const liveMessageSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  conversationId: z.string(),
  artifactId: z.string().nullable(),
  inputId: z.string().nullable(),
  /** Host-verified excerpt of this input; independent of timeline pagination.
   * Disposable presentation only, never identity, authority or model output. */
  inputPreview: z.string().min(1).max(101).optional(),
  rootId: z.string().nullable(),
  createdAt: z.string(),
  text: z.string(),
  kind: z.enum(["reply", "progress", "error", "tool", "evaluation"]),
  evaluation: evaluationResultSchema.optional(),
  resultSource: evaluationSourceSchema
    .extend({ path: z.array(z.string()).optional() })
    .optional(),
  streaming: z.boolean().optional(),
  incomplete: z.boolean().optional(),
  truncated: z.boolean().optional(),
  publicationKey: z.string().optional(),
  /** The physical stream explicitly named by Runtime's semantic outcome. */
  modelAttemptId: z.string().optional(),
  sequence: z.number().int().nonnegative().optional(),
  threadId: z.string().optional(),
  /** A durable Runtime provider_wait, not a failed physical HTTP stream. */
  providerRecovery: providerRecoverySchema.optional(),
  /** An observed Runtime phase, never private reasoning or an inferred timer. */
  modelActivity: modelActivitySchema.optional(),
  failure: runtimeMessageFailureSchema.optional(),
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
  actor?: string;
  sequence?: number;
  payload: Record<string, unknown>;
};
/** Actual Runtime IO provenance, not model arguments or a reconstructed start event. */
export const sessionIoDraftSchema = z.object({
  type: z.enum(["output.started", "output.delta", "output.aborted"]),
  output_id: z.string().min(1).max(256),
  session_id: z.string().min(1),
  root_turn_id: z.string().min(1),
  thread_id: z.string().min(1),
  activation_id: z.string().min(1),
  model_attempt_id: z.string().min(1),
  publication_key: z.string().min(1).max(256).nullish(),
  result_source: evaluationSourceSchema
    .extend({ path: z.array(z.string()).optional() })
    .nullish(),
  model_output_visibility: z.enum(["public", "internal", "evaluation"]),
  inference_source: evaluationSourceSchema.nullish(),
  timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  delta_seq: z.number().int().nonnegative().safe(),
  text: z.string(),
  snapshot: z.boolean().optional(),
});
export type SessionIoDraft = z.infer<typeof sessionIoDraftSchema>;
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
  private replaced = new Set<string>();
  private cancelledRoots = new Set<string>();
  private background = new Map<string, string>();
  private evaluationAttempts = new Map<
    string,
    { id: string; continuation: boolean; closed: boolean }
  >();
  private settledEvaluations = new Set<string>();
  private modelStates = new Map<
    string,
    {
      event: Pick<StreamEvent, "timestamp" | "sequence">;
      message?: LiveMessage;
    }
  >();
  constructor(
    private route: (
      e: StreamEvent,
    ) => Omit<LiveMessage, "id" | "text" | "kind" | "createdAt">,
  ) {}
  /** Complete prefix from the existing IO snapshot/sequence reducer. WebSocket
   * start timing cannot authorize a suffix or erase an already admitted value. */
  consumeIoDraft(draft: SessionIoDraft, text: string) {
    const activation = draft.activation_id,
      attempt = draft.publication_key || draft.model_attempt_id;
    if (
      this.cancelledRoots.has(draft.root_turn_id) ||
      this.cancelled.has(activation)
    )
      return;
    const event: StreamEvent = {
      id: draft.output_id,
      topic: "session/io_stream",
      timestamp: draft.timestamp,
      payload: { ...draft },
    };
    const incomplete = draft.type === "output.aborted";
    if (draft.model_output_visibility !== "public") {
      if (this.settledEvaluations.has(activation)) return;
      const id = evaluationMessageId(
        activation,
        draft.inference_source,
        draft.root_turn_id,
      );
      const previous = this.messages.get(id);
      if (
        previous?.evaluation?.validation &&
        previous.evaluation.validation !== "pending"
      )
        return;
      if (
        previous?.modelAttemptId &&
        previous.modelAttemptId !== attempt &&
        Date.parse(previous.createdAt) > Date.parse(draft.timestamp)
      )
        return;
      this.evaluationAttempts.set(activation, {
        id: attempt,
        continuation: incomplete,
        closed: incomplete,
      });
      this.messages.set(id, {
        ...this.base(event),
        id,
        kind: "evaluation",
        text,
        publicationKey: attempt,
        streaming: !incomplete,
        incomplete,
        evaluation: {
          activationId: activation,
          validation: "pending",
          ...(draft.inference_source ? { source: draft.inference_source } : {}),
        },
      });
      return;
    }
    if (this.resolved.has(attempt)) return;
    const previous = this.attempts.get(attempt);
    if (
      previous?.message.modelAttemptId &&
      previous.message.modelAttemptId !== draft.model_attempt_id &&
      Date.parse(previous.message.createdAt) > Date.parse(draft.timestamp)
    )
      return;
    this.attempts.set(attempt, {
      activation,
      continuation: incomplete,
      tools: previous?.tools ?? new Map(),
      message: {
        ...this.base(event),
        id: `stream:${attempt}`,
        text,
        publicationKey: attempt,
        streaming: !incomplete,
        incomplete,
      },
    });
  }
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
    this.modelStates.clear();
    for (const [id, message] of this.messages) {
      if (message.kind === "evaluation" && message.streaming)
        this.messages.set(id, {
          ...message,
          streaming: false,
          incomplete: true,
        });
    }
    for (const attempt of this.evaluationAttempts.values())
      attempt.closed = true;
  }
  private base(e: StreamEvent): LiveMessage {
    const failure = runtimeMessageFailureFromEvent(e);
    return {
      ...this.route(e),
      id: e.id,
      createdAt: e.timestamp,
      // Transient stream counters are not durable event sequence numbers.
      ...(e.topic !== "runtime/model_stream" && e.sequence !== undefined
        ? { sequence: e.sequence }
        : {}),
      // A recoverable protocol rejection is diagnostic, not the attempt's
      // final publication. It must not replace already-public streamed words.
      ...(e.topic !== "runtime/response_protocol_error" &&
      typeof (e.payload.publication_key ?? e.payload.attempt_id) === "string"
        ? {
            publicationKey: (e.payload.publication_key ??
              e.payload.attempt_id) as string,
          }
        : {}),
      ...(typeof e.payload.thread_id === "string"
        ? { threadId: e.payload.thread_id }
        : {}),
      ...(typeof e.payload.model_attempt_id === "string"
        ? { modelAttemptId: e.payload.model_attempt_id }
        : {}),
      ...(evaluationSourceSchema.safeParse(e.payload.result_source).success
        ? {
            resultSource: e.payload.result_source as z.infer<
              typeof evaluationSourceSchema
            > & { path?: string[] },
          }
        : {}),
      ...(providerRecoveryFromEvent(e)
        ? { providerRecovery: providerRecoveryFromEvent(e) }
        : {}),
      text: "",
      kind: "reply",
      ...(failure ? { failure } : {}),
    };
  }
  consume(e: StreamEvent) {
    if (
      internalModelOutput(e) ||
      [
        "runtime/model_evaluation_output",
        "runtime/inference_value",
        "plan/infer_result",
      ].includes(e.topic)
    ) {
      this.consumeEvaluation(e);
      return;
    }
    const p = e.payload,
      // Semantic outcomes can name the exact physical request. A protocol
      // retry is not inferred from an Activation or an identifier suffix.
      attemptId =
        str(p.publication_key) ||
        ([
          "runtime/thread_waiting",
          "chat/reply",
          "chat/outbound_message",
          "chat/progress",
          "chat/runtime_error",
          "session/io_state",
          "runtime/response_protocol_fused",
        ].includes(e.topic) &&
          str(p.model_attempt_id)) ||
        str(p.attempt_id),
      activation = str(p.activation_id) || attemptId;
    if (
      [
        "chat/reply",
        "chat/no_reply",
        "chat/cancelled",
        "chat/runtime_error",
        "session/io_state",
        "runtime/thread_result",
      ].includes(e.topic)
    ) {
      for (const [key, state] of this.modelStates) {
        if (
          state.message?.rootId === str(p.root_turn_id) &&
          (!str(p.thread_id) || state.message.threadId === str(p.thread_id)) &&
          (state.event.sequence !== undefined && e.sequence !== undefined
            ? e.sequence >= state.event.sequence
            : e.timestamp >= state.event.timestamp)
        )
          this.modelStates.set(key, {
            event: { timestamp: e.timestamp, sequence: e.sequence },
          });
      }
    }
    if (e.topic === "runtime/thread_cancelled") {
      const root = str(p.root_turn_id);
      if (root) this.cancelledRoots.add(root);
      for (const [id, state] of this.modelStates)
        if (root && state.message?.rootId === root) this.modelStates.delete(id);
      for (const [id, a] of this.attempts)
        if (root && a.message.rootId === root) {
          this.cancelled.add(a.activation);
          this.retainAttempt(a);
          this.attempts.delete(id);
        }
      for (const message of this.messages.values())
        if (message.kind === "evaluation" && root && message.rootId === root) {
          const evaluationId = message.evaluation?.activationId;
          if (evaluationId) {
            this.cancelled.add(evaluationId);
            const attempt = this.evaluationAttempts.get(evaluationId);
            if (attempt) attempt.closed = true;
          }
        }
      return;
    }
    if (e.topic === "runtime/model_public_output") {
      // A physical stream snapshot restores already-public words, not an
      // execution outcome. Durable replies win regardless of replay order.
      if (!attemptId || !str(p.text) || this.replaced.has(attemptId)) return;
      if (this.seen.has(e.id)) return;
      this.seen.add(e.id);
      const a = this.attempts.get(attemptId);
      if (a) this.retainAttempt(a);
      this.attempts.delete(attemptId);
      this.resolved.add(attemptId);
      const id = `stream:${attemptId}`;
      const old = this.messages.get(id);
      const firstVisible = str(p.first_visible_at);
      this.messages.set(id, {
        ...this.base(e),
        id,
        createdAt: Number.isFinite(Date.parse(firstVisible))
          ? firstVisible
          : (old?.createdAt ?? e.timestamp),
        text:
          p.truncated === true && old?.text.startsWith(str(p.text))
            ? old.text
            : str(p.text),
        streaming: false,
        incomplete: p.complete !== true || this.cancelled.has(activation),
        truncated: p.truncated === true,
      });
      return;
    }
    const semantic = [
      "chat/reply",
      "chat/outbound_message",
      "chat/progress",
      "runtime/provider_wait",
      "chat/no_reply",
      "chat/cancelled",
      "chat/runtime_error",
      "session/io_state",
      "runtime/thread_result",
      "runtime/thread_waiting",
      "runtime/response_protocol_fused",
      "runtime/response_protocol_error",
      "runtime/tool_calls_selected",
      "runtime/reasoning_continuation",
      "chat/assistant_call",
    ].includes(e.topic);
    if (semantic) {
      const replacesText =
        ([
          "chat/reply",
          "chat/outbound_message",
          "chat/runtime_error",
          "session/io_state",
          "runtime/response_protocol_fused",
        ].includes(e.topic) &&
          !!str(p.text ?? p.error ?? p.message)) ||
        (e.topic === "chat/progress" &&
          p.disposition !== "provider_wait" &&
          !!str(p.root_turn_id) &&
          !!str(p.text));
      if (attemptId) this.resolved.add(attemptId);
      if (replacesText && attemptId) this.replaced.add(attemptId);
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
        this.cancelledRoots.has(str(p.root_turn_id)) ||
        this.cancelled.has(activation)
      )
        return;
      const s = obj(p.stream),
        kind = str(s.kind);
      if (kind === "started") {
        if (this.attempts.has(attemptId)) return;
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
      // no_reply is a response disposition (wait/silent), never a physical
      // tool with an execution receipt. The Thread snapshot owns wait state;
      // rejected dispositions remain visible via response_protocol_error.
      if (kind === "tool_call_started" && str(s.name) !== "no_reply")
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
        // This physical stream may enter durable Provider recovery. Only a
        // semantic Runtime outcome can fail the user's task. Keep public words
        // incomplete, but never manufacture a reply from diagnostic JSON.
        if (a.message.text) a.message.incomplete = true;
        a.message.streaming = false;
      }
      return;
    }
    if (e.topic === "runtime/model_attempt_state") {
      const base = this.base(e);
      const key = `${base.rootId ?? ""}:${base.threadId ?? activation}`;
      const previous = this.modelStates.get(key);
      const fresh =
        !previous ||
        (previous.event.sequence !== undefined && e.sequence !== undefined
          ? e.sequence > previous.event.sequence
          : e.timestamp > previous.event.timestamp);
      if (
        fresh &&
        base.inputId &&
        base.rootId &&
        !this.cancelledRoots.has(base.rootId)
      ) {
        const phase = modelActivitySchema.safeParse(p.state);
        this.modelStates.delete(key);
        this.modelStates.set(key, {
          event: { timestamp: e.timestamp, sequence: e.sequence },
          ...(p.terminal === false && phase.success && phase.data !== undefined
            ? {
                message: {
                  ...base,
                  id: `model-state:${key}`,
                  kind: "progress",
                  text: "",
                  modelActivity: phase.data,
                },
              }
            : {}),
        });
        if (this.modelStates.size > 256)
          this.modelStates.delete(this.modelStates.keys().next().value!);
      }
      const a = this.attempts.get(attemptId);
      if (a && p.terminal === true) {
        a.message.streaming = false;
        a.continuation = p.continuation_pending === true;
        if (["cancelled", "interrupted"].includes(str(p.state))) {
          a.message.incomplete = true;
          this.cancelled.add(activation);
          this.retainAttempt(a);
          this.attempts.delete(attemptId);
        }
        if (str(p.state) === "failed") {
          if (a.message.text) a.message.incomplete = true;
        }
      }
      return;
    }
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    if (providerRecoveryFromEvent(e)?.phase === "resumed") {
      // A Runtime wake is status evidence, not a fabricated reply/tool card.
      this.messages.set(e.id, { ...this.base(e), kind: "progress", text: "" });
      return;
    }
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
      if (!id || str(call.name ?? fn.name) === "no_reply") continue;
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
      : ["chat/progress", "runtime/provider_wait"].includes(e.topic)
        ? "progress"
        : [
              "chat/runtime_error",
              "session/io_state",
              "runtime/response_protocol_fused",
              "runtime/response_protocol_error",
            ].includes(e.topic)
          ? "error"
          : null;
    const text = str(
      p.text ??
        p.error ??
        p.message ??
        (e.topic === "runtime/response_protocol_error" ? p.reason : undefined),
    );
    if (kind && (text || p.disposition === "provider_wait"))
      this.messages.set(e.id, { ...this.base(e), kind, text });
  }
  private consumeEvaluation(e: StreamEvent) {
    const p = e.payload;
    const activationId = str(p.activation_id);
    if (!activationId) return;
    const id = evaluationMessageId(
      activationId,
      p.inference_source,
      str(p.root_turn_id),
    );
    const previous = this.messages.get(id);
    const attemptId = str(p.model_attempt_id) || str(p.attempt_id);
    const attempt = this.evaluationAttempts.get(activationId);
    const source = evaluationSourceSchema.safeParse(p.inference_source);
    const base: LiveMessage = {
      ...this.base(e),
      ...previous,
      id,
      kind: "evaluation",
      evaluation: {
        activationId,
        validation: previous?.evaluation?.validation ?? "pending",
        ...(source.success
          ? { source: source.data }
          : previous?.evaluation?.source
            ? { source: previous.evaluation.source }
            : {}),
      },
    };
    if (e.topic === "runtime/model_stream") {
      if (
        this.seen.has(e.id) ||
        this.settledEvaluations.has(activationId) ||
        this.cancelled.has(activationId) ||
        this.cancelledRoots.has(str(p.root_turn_id)) ||
        base.evaluation?.validation !== "pending"
      )
        return;
      this.seen.add(e.id);
      const stream = obj(p.stream),
        kind = str(stream.kind);
      if (kind === "started") {
        if (!attemptId || attempt?.id === attemptId) return;
        this.evaluationAttempts.set(activationId, {
          id: attemptId,
          continuation: false,
          closed: false,
        });
        this.messages.set(id, {
          ...base,
          text: attempt?.continuation ? base.text : "",
          modelAttemptId: attemptId,
          streaming: true,
          incomplete: false,
        });
      } else if (!attempt || attempt.closed || attempt.id !== attemptId) return;
      else if (kind === "text_delta" && previous?.streaming) {
        this.messages.set(id, {
          ...base,
          text: previous.text + str(stream.text),
          createdAt: previous.text ? previous.createdAt : e.timestamp,
        });
      } else if (
        ["completed", "incomplete", "failed"].includes(kind) &&
        previous
      ) {
        attempt.closed = true;
        attempt.continuation = kind === "incomplete";
        this.messages.set(id, {
          ...base,
          streaming: false,
          incomplete: kind !== "completed",
        });
      }
    } else if (
      [
        "runtime/model_evaluation_output",
        "plan/infer_result",
        "runtime/inference_value",
        "runtime/model_public_output",
      ].includes(e.topic)
    ) {
      if (
        previous?.evaluation &&
        previous.evaluation.validation !== "pending" &&
        e.topic !== "runtime/inference_value"
      )
        return;
      if (
        [
          "runtime/model_evaluation_output",
          "runtime/model_public_output",
        ].includes(e.topic) &&
        attempt &&
        attemptId !== attempt.id
      )
        return;
      if (
        previous?.sequence !== undefined &&
        e.sequence !== undefined &&
        previous.sequence > e.sequence
      )
        return;
      const text = str(p.text);
      if (!text) return;
      if (
        e.topic === "plan/infer_result" ||
        e.topic === "runtime/inference_value"
      )
        this.settledEvaluations.add(activationId);
      this.messages.set(id, {
        ...base,
        text,
        streaming: false,
        createdAt:
          previous?.createdAt ?? (str(p.first_visible_at) || e.timestamp),
        ...(e.sequence === undefined ? {} : { sequence: e.sequence }),
        incomplete: p.complete === false,
        truncated: p.truncated === true,
        evaluation: {
          ...base.evaluation!,
          validation:
            p.validation === "accepted"
              ? "accepted"
              : p.validation === "rejected"
                ? "rejected"
                : "pending",
        },
      });
    } else if (
      e.topic === "runtime/model_attempt_state" &&
      p.terminal === true &&
      previous &&
      (!attempt || attempt.id === attemptId) &&
      base.evaluation?.validation === "pending"
    ) {
      if (attempt) attempt.closed = true;
      this.messages.set(id, {
        ...base,
        streaming: false,
        incomplete: ["failed", "cancelled", "interrupted"].includes(
          str(p.state),
        ),
      });
    }
  }
  snapshot(): LiveMessage[] {
    const result = new Map(this.messages);
    for (const state of this.modelStates.values())
      if (state.message) result.set(state.message.id, state.message);
    for (const a of this.attempts.values()) {
      if (a.message.text) result.set(a.message.id, a.message);
      for (const tool of a.tools.values())
        if (!result.has(tool.id)) result.set(tool.id, tool);
    }
    return [...result.values()]
      .map((message) =>
        message.streaming !== undefined &&
        message.rootId &&
        this.cancelledRoots.has(message.rootId)
          ? { ...message, streaming: false, incomplete: true }
          : message,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
