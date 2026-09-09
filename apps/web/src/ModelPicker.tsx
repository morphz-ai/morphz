import { useEffect, useState } from "react";
import { z } from "zod";
const catalogSchema = z.object({
  current: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string() })),
});

export function ModelPicker({
  value = "",
  onChange,
  disabled = false,
  label = "本次输入模型",
}: {
  value?: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [catalog, setCatalog] = useState<z.infer<typeof catalogSchema> | null>(
    null,
  );
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (disabled) return;
    const controller = new AbortController();
    setError("");
    setCatalog(null);
    void fetch("/api/models", { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "无法读取模型列表");
        if (!controller.signal.aborted) setCatalog(catalogSchema.parse(data));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [attempt, disabled]);
  return (
    <div className="model-picker">
      <label>
        {label}
        <select
          aria-label={label}
          value={value}
          disabled={disabled || !catalog}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">
            自动选择{catalog?.current ? " · " + catalog.current : ""}
          </option>
          {value && !catalog?.options.some((m) => m.id === value) && (
            <option value={value}>{value} · 待确认</option>
          )}
          {catalog?.options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
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
      {!error && !catalog && !disabled && <small>读取可用模型…</small>}
      <small>
        {label === "本次输入模型"
          ? "仅用于下一次发送，不改变其他工作。"
          : "用于这件事项的后续执行，不切换正在运行的模型。"}
      </small>
    </div>
  );
}
