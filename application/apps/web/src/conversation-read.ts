import type {
  ArtifactOutput,
  ConversationRuntime,
} from "../../../packages/core/src/conversation.js";
import type { LiveMessage } from "../../../packages/core/src/live-conversation.js";
import type { ScriptOutput } from "../../../packages/core/src/script-delivery.js";
import {
  inConversation,
  type Workspace,
} from "../../../packages/core/src/model.js";

export type ConversationFocus = { artifactId?: string; applicationId?: string };
export type ReplyReceipt = { keys: string[]; version: string };
export type ReadReplies = Record<string, string>;

/** The badge and the opened history must describe the same scope. */
export function focusedInputs(
  inputs: Workspace["inputs"],
  outputs: ArtifactOutput[],
  focus: ConversationFocus,
) {
  if (focus.artifactId)
    return inputs.filter(
      (i) =>
        i.artifactId === focus.artifactId ||
        outputs.some(
          (o) => o.inputId === i.id && o.artifactId === focus.artifactId,
        ),
    );
  if (focus.applicationId)
    return inputs.filter(
      (i) => i.application?.instanceId === focus.applicationId,
    );
  return inputs;
}

export function conversationMessages(
  state: Workspace,
  conversationId: string,
  runtime: ConversationRuntime,
  live: LiveMessage[],
  sharedDefault: boolean,
) {
  const messages = new Map<string, LiveMessage>();
  for (const m of [...runtime.messages, ...live])
    if (inConversation(state, conversationId, m, sharedDefault)) {
      // A child infer result is execution output, not a reply to a user input.
      // Keep it in the execution inspector; never flash it on the main timeline.
      // Unattributed durable history remains readable. The host can reconcile a
      // newly accepted root's captured identity when its POST receipt arrives.
      if ("streaming" in m && m.streaming !== undefined && !m.inputId) continue;
      const previous = messages.get(m.id);
      // On reconnect the feed replays older phases of the same publication.
      // The snapshot already contains its terminal event; never roll it back.
      if (
        previous?.sequence !== undefined &&
        ((m.sequence !== undefined && previous.sequence > m.sequence) ||
          ("streaming" in m &&
            m.streaming !== undefined &&
            previous.streaming === undefined &&
            (previous.kind === "reply" || previous.kind === "error")))
      )
        continue;
      messages.set(m.id, {
        ...m,
        conversationId: m.conversationId ?? m.projectId,
        inputId: m.inputId ?? null,
        rootId: m.rootId ?? null,
      });
    }
  return [...messages.values()];
}

// A local change fingerprint, not a security hash. Do not copy reply bodies into
// preferences, or mistake array order, progress and stream status for new prose.
function textVersion(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}

export function replyReceipts(
  messages: Array<Pick<LiveMessage, "id" | "kind" | "text" | "publicationKey">>,
  outputs: ArtifactOutput[],
  scriptOutputs: ScriptOutput[] = [],
): ReplyReceipt[] {
  return [
    ...messages
      .filter(
        (m) => (m.kind === "reply" || m.kind === "error") && m.text.trim(),
      )
      .map((m) => ({
        keys: [
          `reply:${m.id}`,
          ...(m.publicationKey ? [`publication:${m.publicationKey}`] : []),
        ],
        version: `${m.kind}:${textVersion(m.text)}`,
      })),
    ...outputs.map((o) => ({
      keys: [`output:${o.commandId}`],
      version: `${o.artifactId}:${o.revision}`,
    })),
    ...scriptOutputs.map((o) => ({
      keys: [`output:${o.commandId}`],
      version: `${o.productionId}:${o.itemId ?? ""}:${o.candidateId ?? o.reviewId ?? ""}:${o.revision ?? ""}`,
    })),
  ];
}

export function hasUnreadReplies(seen: ReadReplies, receipts: ReplyReceipt[]) {
  return receipts.some((r) => !r.keys.some((key) => seen[key] === r.version));
}

export function acknowledgeReplies(
  seen: ReadReplies,
  receipts: ReplyReceipt[],
) {
  let next = seen;
  for (const receipt of receipts)
    for (const key of receipt.keys)
      if (next[key] !== receipt.version) {
        if (next === seen) next = { ...seen };
        next[key] = receipt.version;
      }
  return next;
}

/** A durable reply can replace an already read stream without becoming unread. */
export function reconcileReplyReceipts(
  seen: ReadReplies,
  receipts: ReplyReceipt[],
) {
  return acknowledgeReplies(
    seen,
    receipts.filter((r) => r.keys.some((key) => seen[key] === r.version)),
  );
}

export function readReplyReceipts(value: unknown): ReadReplies | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    !Object.entries(value).every(
      ([key, version]) =>
        /^(reply|publication|output):/.test(key) && typeof version === "string",
    )
  )
    return null;
  return value as ReadReplies;
}
