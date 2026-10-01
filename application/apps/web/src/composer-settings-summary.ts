import {
  reasoningLabels,
  type ModelCatalog,
  type ReasoningEffort,
} from "../../../packages/core/src/inference.js";

/** A display projection only: never invent capabilities or change routing. */
export function composerSettingsSummary({
  model,
  current,
  reasoning,
  catalog,
}: {
  model?: string;
  current?: string;
  reasoning?: ReasoningEffort;
  catalog?: ModelCatalog | null;
}) {
  const id = model || catalog?.current || current;
  const option = catalog?.options.find((entry) => entry.id === id);
  const modelName =
    option?.physical_models?.join(" / ") || option?.label || id || "默认模型";
  const effort = reasoning ?? (catalog?.reasoning?.current || undefined);
  return {
    model: modelName,
    reasoning: effort ? reasoningLabels[effort] : "默认",
    explicit: !!model || !!reasoning,
  };
}
