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
  return {
    model: modelName,
    // Inheritance is a choice, not an explicit copy of the Runtime default.
    // Keep the trigger consistent with the rail even after catalog readback.
    reasoning: reasoning ? reasoningLabels[reasoning] : "默认",
    explicit: !!model || !!reasoning,
  };
}
