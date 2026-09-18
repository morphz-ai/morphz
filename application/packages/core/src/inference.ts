import { z } from "zod";

// Runtime's per-activation vocabulary. An omitted value preserves its default.
export const reasoningEffortSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "max",
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export const reasoningLabels: Record<ReasoningEffort, string> = {
  none: "关闭",
  low: "轻量",
  medium: "标准",
  high: "深入",
  max: "最高",
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
    catalog.reasoning?.levels ??
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
