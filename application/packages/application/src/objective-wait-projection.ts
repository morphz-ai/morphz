import type { z } from "zod";
import type { dependencyHeadSchema } from "./thread-wait-projection.js";
/** Use the current scheduler dependency edges, not diagnostic prose or the
 * legacy wait-condition mirror. A partial/mismatched generation is unknown. */
export function objectiveWaitKinds(value: {
  readiness: { state: string; dependency_ids?: string[] };
  objective: { id: string; generation?: number; revision?: number };
  wait_head?: z.infer<typeof dependencyHeadSchema>;
  dependencies?: {
    id: string;
    owner_kind: string;
    owner_id: string;
    owner_generation: number;
    dependency_kind: string;
    dependency_id?: string;
    metadata?: Record<string, unknown>;
    required: boolean;
    status: string;
  }[];
}): string[] | undefined {
  if (value.readiness.state !== "waiting") return;
  const head = value.wait_head;
  if (
    head &&
    head.owner_kind === "objective" &&
    head.owner_id === value.objective.id &&
    head.generation === value.objective.generation &&
    head.revision === value.objective.revision
  )
    return head.kinds;
  const ids = new Set(value.readiness.dependency_ids ?? []);
  if (!ids.size || !value.objective.generation) return [];
  const current = (value.dependencies ?? []).filter(
    (edge) =>
      ids.has(edge.id) &&
      edge.owner_kind === "objective" &&
      edge.owner_id === value.objective.id &&
      edge.owner_generation === value.objective.generation &&
      edge.required &&
      edge.status === "pending",
  );
  if (new Set(current.map((edge) => edge.id)).size !== ids.size) return [];
  return [
    ...new Set(
      current.map((edge) =>
        edge.dependency_kind === "user_input" &&
        edge.metadata?.source === "request_user_input" &&
        edge.metadata.request_event_id === edge.dependency_id &&
        typeof edge.metadata.accepted_answer_event_id === "string" &&
        !!edge.metadata.accepted_answer_event_id
          ? "user_input_delivery"
          : edge.dependency_kind,
      ),
    ),
  ];
}

/** Resource identities use the same complete, current dependency proof. */
export function objectiveWaitResources(
  value: Parameters<typeof objectiveWaitKinds>[0],
): string[] | undefined {
  if (!objectiveWaitKinds(value)?.includes("resource")) return;
  const head = value.wait_head;
  if (
    head &&
    head.owner_kind === "objective" &&
    head.owner_id === value.objective.id &&
    head.generation === value.objective.generation &&
    head.revision === value.objective.revision
  )
    return head.resources.length ? head.resources : undefined;
  const ids = new Set(value.readiness.dependency_ids ?? []);
  const resources = (value.dependencies ?? [])
    .filter(
      (edge) =>
        ids.has(edge.id) &&
        edge.owner_kind === "objective" &&
        edge.owner_id === value.objective.id &&
        edge.owner_generation === value.objective.generation &&
        edge.required &&
        edge.status === "pending" &&
        edge.dependency_kind === "resource" &&
        edge.dependency_id,
    )
    .map((edge) => edge.dependency_id!);
  return resources.length ? [...new Set(resources)] : undefined;
}
