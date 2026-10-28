import { z } from "zod";

// Runtime's per-activation vocabulary. An omitted value preserves its default.
export const reasoningEffortSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
/** Immutable physical request facts, not the current composer/default settings. */
export const executionModelSchema = z.object({
  model_attempt_id: z.string().min(1),
  activation_id: z.string().min(1),
  model: z.string().min(1).max(256),
  requested_alias: z.string().min(1).max(256),
  reasoning_effort: reasoningEffortSchema.nullable(),
  observed_at: z.string(),
});
export type ExecutionModel = z.infer<typeof executionModelSchema>;
export const reasoningLabels: Record<ReasoningEffort, string> = {
  none: "none",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};
export const modelOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  physical_models: z.array(z.string()).optional(),
  supported_reasoning_efforts: z
    .array(reasoningEffortSchema)
    .nullable()
    .optional(),
  sources: z.array(z.string()).optional(),
});
export const modelCatalogSchema = z.object({
  current: z.string(),
  options: z.array(modelOptionSchema),
  reasoning: z
    .object({
      current: reasoningEffortSchema.nullable(),
      levels: z.array(reasoningEffortSchema),
    })
    .optional(),
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

export function reasoningLevels(catalog: ModelCatalog, model: string) {
  return (
    catalog.options.find((option) => option.id === (model || catalog.current))
      ?.supported_reasoning_efforts ??
    // Unspecified capabilities must not advertise the newly added level.
    catalog.reasoning?.levels.filter((level) => level !== "xhigh") ??
    []
  );
}

export function modelLabel(option: z.infer<typeof modelOptionSchema>) {
  const physical = option.physical_models?.join(" / ");
  const name =
    physical && physical !== option.label
      ? `${physical} · ${option.label}`
      : option.label;
  return option.sources?.length
    ? `${name} · ${option.sources.join(" / ")}`
    : name;
}
