import { useId, useRef, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Brain, RotateCcw } from "lucide-react";
import {
  reasoningEffortSchema,
  reasoningLabels,
  type ReasoningEffort,
} from "../../../packages/core/src/inference.js";
import "./composer-reasoning.css";

/** An ordinal control over existing Runtime values, not a new effort protocol.
 * Inherited and incompatible values deliberately have no selected rail point. */
export function ComposerReasoningControl({
  value,
  levels,
  model,
  modelControl,
  label = "本次输入推理强度",
  title,
  disabled = false,
  automatic = false,
  invalid = false,
  onChange,
}: {
  value?: ReasoningEffort;
  levels: ReasoningEffort[];
  model: string;
  modelControl?: ReactNode;
  label?: string;
  title: string;
  disabled?: boolean;
  automatic?: boolean;
  invalid?: boolean;
  onChange(value?: ReasoningEffort): void;
}) {
  const id = useId();
  const control = useRef<HTMLDivElement>(null);
  const range = useRef<HTMLInputElement>(null);
  const stops = reasoningEffortSchema.options.filter((level) =>
    levels.includes(level),
  );
  const index = value ? stops.indexOf(value) : -1;
  const state = invalid ? "unsupported" : value ? "explicit" : "default";
  const caption = invalid
    ? `${reasoningLabels[value!]} · 不支持`
    : value
      ? reasoningLabels[value]
      : automatic && !stops.length
        ? "模型自动"
        : "默认";
  const choose = (next: number) => {
    if (!disabled && stops.length)
      onChange(stops[Math.max(0, Math.min(stops.length - 1, next))]);
  };
  return (
    <div
      ref={control}
      tabIndex={-1}
      className="composer-reasoning composer-setting-row composer-reasoning-control"
      data-state={state}
      title={title}
    >
      <div className="composer-reasoning-heading">
        <Brain aria-hidden="true" />
        <span className="visually-hidden">推理强度 · {model}</span>
        <output className="composer-reasoning-value" id={`${id}-value`}>
          {caption}
        </output>
        <button
          type="button"
          className="composer-reasoning-reset"
          aria-label="恢复默认推理强度"
          title="恢复默认 · 沿用模型设置"
          disabled={disabled || !value}
          onClick={(event) => {
            const ownedFocus = document.activeElement === event.currentTarget;
            flushSync(() => onChange(undefined));
            // Reset disables its own button; keep keyboard navigation on the
            // still-valid rail, without stealing focus from another surface.
            if (ownedFocus)
              (!disabled && stops.length
                ? range.current
                : control.current
              )?.focus({
                preventScroll: true,
              });
          }}
        >
          <RotateCcw aria-hidden="true" />
        </button>
      </div>
      {modelControl}
      <div
        className="composer-reasoning-rail"
        data-empty={!stops.length || undefined}
        data-selected={index >= 0 || undefined}
        style={
          {
            "--reasoning-position": `${stops.length > 1 && index >= 0 ? (index / (stops.length - 1)) * 100 : 0}%`,
          } as CSSProperties
        }
      >
        <input
          ref={range}
          type="range"
          aria-label={label}
          aria-valuetext={caption}
          aria-description={stops
            .map((level) => reasoningLabels[level])
            .join("、")}
          aria-describedby={invalid ? `${id}-invalid` : undefined}
          title={`${model} · ${title}`}
          min={0}
          max={Math.max(0, stops.length - 1)}
          step={1}
          value={Math.max(0, index)}
          data-efforts={stops.join(",")}
          disabled={disabled || !stops.length}
          onChange={(event) => choose(Number(event.target.value))}
          onPointerDown={(event) => {
            if (disabled || !stops.length || event.button !== 0) return;
            // The inherited range DOM value is min, so choosing that first
            // point might not emit a native change. Resolve pointer admission
            // as well, including real CSS zoom, then let native drag continue.
            const element = event.currentTarget;
            const rect = element.getBoundingClientRect();
            const scale = rect.width / element.offsetWidth;
            const inset = 12 * scale;
            const fraction =
              (event.clientX - rect.left - inset) /
              Math.max(1, rect.width - 2 * inset);
            choose(Math.round(fraction * (stops.length - 1)));
          }}
          onKeyDown={(event) => {
            if (disabled || !stops.length) return;
            const direction = ["ArrowLeft", "ArrowDown"].includes(event.key)
              ? -1
              : ["ArrowRight", "ArrowUp"].includes(event.key)
                ? 1
                : 0;
            if (direction || event.key === "Home" || event.key === "End") {
              event.preventDefault();
              choose(
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? stops.length - 1
                    : index < 0
                      ? 0
                      : index + direction,
              );
            }
          }}
        />
        <div className="composer-reasoning-stops" aria-hidden="true">
          {stops.map((level, point) => (
            <span
              key={level}
              data-selected={level === value || undefined}
              style={{
                left: `${stops.length > 1 ? (point / (stops.length - 1)) * 100 : 0}%`,
              }}
            >
              <i />
            </span>
          ))}
        </div>
      </div>
      {invalid && (
        <small role="alert" id={`${id}-invalid`}>
          请重新选择推理强度
        </small>
      )}
    </div>
  );
}
