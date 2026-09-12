import { useEffect, useState } from "react";
import { Brain } from "lucide-react";
import { applicationCall } from "./application-transport.js";
import {
  modelCatalogSchema,
  modelLabel,
  reasoningLabels,
  reasoningLevels,
  type ModelCatalog,
  type ReasoningEffort,
} from "../../../packages/core/src/inference.js";

export function ModelPicker({
  value = "",
  onChange,
  disabled = false,
  label = "本次输入模型",
  compact = false,
  current,
  reasoning,
}: {
  value?: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  label?: string;
  compact?: boolean;
  current?: string;
  reasoning?: {
    value?: ReasoningEffort;
    onChange(value?: ReasoningEffort): void;
  };
}) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (disabled) return;
    const controller = new AbortController();
    setError("");
    setCatalog(null);
    void applicationCall("models", undefined, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setCatalog(modelCatalogSchema.parse(data));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [attempt, disabled]);
  const selected = catalog?.options.find(
    (m) => m.id === (value || catalog.current),
  );
  const levels = catalog ? reasoningLevels(catalog, value) : [];
  const invalidEffort =
    !!reasoning?.value && !!catalog && !levels.includes(reasoning.value);
  const defaultName = catalog?.options.find((m) => m.id === catalog.current);
  const defaultLabel = defaultName
    ? modelLabel(defaultName)
    : catalog?.current || current || "默认模型";
  return (
    <>
      <div className={`model-picker${compact ? " model-picker-compact" : ""}`}>
        <label>
          {!compact && label}
          <select
            aria-label={label}
            title={
              compact
                ? `${selected ? modelLabel(selected) : value || defaultLabel} · ${value ? "本次指定" : "跟随默认"}，仅用于下一次发送`
                : undefined
            }
            value={value}
            disabled={disabled || !catalog}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">
              {compact
                ? `默认 · ${defaultLabel}`
                : `自动选择${catalog?.current ? " · " + catalog.current : ""}`}
            </option>
            {value && !catalog?.options.some((m) => m.id === value) && (
              <option value={value}>{value} · 待确认</option>
            )}
            {catalog?.options.map((m) => (
              <option key={m.id} value={m.id}>
                {modelLabel(m)}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <small role="alert">
            模型列表暂不可用。
            <button onClick={() => retry(attempt + 1)} title={error}>
              重试
            </button>
          </small>
        )}
        {!compact && !error && !catalog && !disabled && (
          <small>读取可用模型…</small>
        )}
        {!compact && (
          <small>
            {label === "本次输入模型"
              ? "仅用于下一次发送，不改变其他工作。"
              : "用于这件事项的后续执行，不切换正在运行的模型。"}
          </small>
        )}
      </div>
      {reasoning && (
        <label
          className="composer-reasoning"
          title={
            catalog?.reasoning
              ? "仅用于下一次发送；默认沿用 Runtime 设置。实际支持以所选模型为准。"
              : "工作中心尚未接通推理设置，请更新中心后重试。"
          }
        >
          <Brain aria-hidden="true" />
          <select
            aria-label="本次输入推理强度"
            value={reasoning.value ?? ""}
            disabled={
              disabled ||
              !catalog?.reasoning ||
              (levels.length === 0 && !reasoning.value)
            }
            onChange={(event) =>
              reasoning.onChange(
                (event.target.value || undefined) as
                  ReasoningEffort | undefined,
              )
            }
          >
            <option value="">
              {levels.length === 0 && catalog?.reasoning ? "模型自动" : "默认"}
            </option>
            {invalidEffort && (
              <option value={reasoning.value}>
                {reasoningLabels[reasoning.value!]} · 不支持
              </option>
            )}
            {levels.map((level) => (
              <option key={level} value={level}>
                {reasoningLabels[level]}
              </option>
            ))}
          </select>
          {invalidEffort && <small role="alert">请重新选择推理强度</small>}
        </label>
      )}
    </>
  );
}
