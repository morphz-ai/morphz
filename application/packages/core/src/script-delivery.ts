import { z } from "zod";
import type { Workspace } from "./model.js";
import type { ScriptCommand } from "./script-studio.js";

export const scriptLocationSchema = z
  .object({
    productionId: z.string().min(1),
    itemId: z.string().min(1).optional(),
    revision: z.number().int().positive().optional(),
    candidateId: z.string().min(1).optional(),
    reviewId: z.string().min(1).optional(),
  })
  .strict();
export type ScriptLocation = z.infer<typeof scriptLocationSchema>;
export const scriptOutputSchema = scriptLocationSchema.extend({
  commandId: z.string(),
  inputId: z.string(),
  projectId: z.string(),
  kind: z.enum(["production", "item", "candidate", "review"]),
  title: z.string(),
  createdAt: z.string(),
});
export type ScriptOutput = z.infer<typeof scriptOutputSchema>;

/** Run inside the command transaction. The command plus saved domain record
 * identifies the exact delivery, including when replaying its durable receipt. */
export function scriptDelivery(
  state: Workspace,
  command: ScriptCommand,
  commandId: string,
  inputId: string,
): ScriptOutput | null {
  const productionId =
    command.action === "create-production" ? commandId : command.productionId;
  const production = state.scriptProductions.find((p) => p.id === productionId);
  const input = state.inputs.find((i) => i.id === inputId);
  if (
    !production ||
    !input ||
    (production.projectId !== input.projectId &&
      !state.scriptPreparations.some(
        (p) =>
          p.inputId === input.id &&
          p.projectId === production.projectId &&
          p.generation.productionId === production.id,
      ))
  )
    return null;
  const base = {
    commandId,
    inputId,
    projectId: production.projectId,
    productionId,
  };
  if (command.action === "create-production" && production.id === commandId)
    return {
      ...base,
      kind: "production",
      title: command.title,
      revision: 1,
      createdAt: production.createdAt,
    };
  if (command.action === "create-item") {
    const item = production.items.find((i) => i.id === commandId),
      version = item?.versions.find((v) => v.revision === 1);
    if (item && version)
      return {
        ...base,
        kind: "item",
        itemId: item.id,
        title: version.draft.title,
        revision: 1,
        createdAt: version.createdAt,
      };
  }
  if (command.action === "submit-candidate") {
    const candidate = production.candidates.find(
      (c) => c.id === commandId && c.inputId === inputId,
    );
    if (candidate)
      return {
        ...base,
        kind: "candidate",
        itemId: candidate.targetId,
        candidateId: candidate.id,
        title: candidate.draft.title,
        revision: candidate.baseRevision,
        createdAt: candidate.createdAt,
      };
  }
  if (command.action === "add-review") {
    const review = production.reviews.find(
      (r) => r.id === commandId && r.inputId === inputId,
    );
    const item = production.items.find((i) => i.id === review?.itemId),
      version = item?.versions.find((v) => v.revision === review?.itemRevision);
    if (review && version)
      return {
        ...base,
        kind: "review",
        itemId: review.itemId,
        reviewId: review.id,
        title: version.draft.title,
        revision: review.itemRevision,
        createdAt: review.createdAt,
      };
  }
  return null;
}

export function resolveScriptLocation(
  state: Workspace,
  target: ScriptLocation,
) {
  const production = state.scriptProductions.find(
    (p) => p.id === target.productionId,
  );
  if (!production) return null;
  const item = production.items.find((i) => i.id === target.itemId);
  if (
    target.itemId &&
    (!item ||
      (target.revision &&
        !item.versions.some((v) => v.revision === target.revision)))
  )
    return null;
  if (
    target.candidateId &&
    !production.candidates.some(
      (c) =>
        c.id === target.candidateId &&
        c.targetId === item?.id &&
        c.baseRevision === target.revision,
    )
  )
    return null;
  if (
    target.reviewId &&
    !production.reviews.some(
      (r) =>
        r.id === target.reviewId &&
        r.itemId === item?.id &&
        r.itemRevision === target.revision,
    )
  )
    return null;
  return { production, item };
}

export function scriptOutputLocation(output: ScriptOutput): ScriptLocation {
  return scriptLocationSchema.parse({
    productionId: output.productionId,
    ...(output.itemId
      ? { itemId: output.itemId, revision: output.revision }
      : {}),
    ...(output.candidateId ? { candidateId: output.candidateId } : {}),
    ...(output.reviewId ? { reviewId: output.reviewId } : {}),
  });
}
