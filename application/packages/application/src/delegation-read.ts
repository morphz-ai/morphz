import { z } from "zod";
import type { DelegationLink } from "../../core/src/execution.js";
import { DomainError } from "../../core/src/model.js";

export const delegationRecordSchema = z.object({
  id: z.string().min(1),
  parent_context_id: z.string().min(1),
  parent_session_id: z.string().min(1),
  child_context_id: z.string().min(1),
  child_session_id: z.string().min(1),
  initiating_principal_id: z.string().nullable(),
  task: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  created_at: z.string(),
  updated_at: z.string(),
});
export type DelegationRecord = z.infer<typeof delegationRecordSchema>;

type RequestEvent = {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
};

/** Runtime's durable request, not a title, ID prefix or shared Session,
 * proves the cross-Context edge and the initiating parent Thread/root. */
export function delegationRequestLink(
  record: DelegationRecord,
  event: RequestEvent,
): (DelegationLink & { rootId: string }) | null {
  const p = event.payload;
  if (
    event.topic !== "chat/delegate" ||
    p.delegation_id !== record.id ||
    p.context_id !== record.parent_context_id ||
    p.session_id !== record.parent_session_id ||
    p.parent_context_id !== record.parent_context_id ||
    p.parent_session_id !== record.parent_session_id ||
    p.child_context_id !== record.child_context_id ||
    p.child_session_id !== record.child_session_id ||
    !record.initiating_principal_id ||
    p.principal_id !== record.initiating_principal_id ||
    typeof p.root_turn_id !== "string" ||
    !p.root_turn_id ||
    typeof p.thread_id !== "string" ||
    !p.thread_id
  )
    return null;
  return {
    id: record.id,
    requestEventId: event.id,
    parentSessionId: record.parent_session_id,
    parentContextId: record.parent_context_id,
    parentThreadId: p.thread_id,
    rootId: p.root_turn_id,
  };
}

export function requireDelegationLink(
  record: DelegationRecord,
  event: RequestEvent,
  reference: DelegationLink,
) {
  const link = delegationRequestLink(record, event);
  if (
    !link ||
    Object.entries(reference).some(
      ([key, value]) => link[key as keyof typeof link] !== value,
    )
  )
    throw new DomainError("forbidden", "无法核验子任务的原始委派关系。");
  return link;
}
