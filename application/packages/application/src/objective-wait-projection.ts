/** Use the current scheduler dependency edges, not diagnostic prose or the
 * legacy wait-condition mirror. A partial/mismatched generation is unknown. */
export function objectiveWaitKinds(value: {
  readiness: { state: string; dependency_ids?: string[] };
  objective: { id: string; generation?: number };
  dependencies?: {
    id: string;
    owner_kind: string;
    owner_id: string;
    owner_generation: number;
    dependency_kind: string;
    required: boolean;
    status: string;
  }[];
}): string[] | undefined {
  if (value.readiness.state !== "waiting") return;
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
  return [...new Set(current.map((edge) => edge.dependency_kind))];
}
