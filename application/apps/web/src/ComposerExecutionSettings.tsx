import { useState, type ReactNode } from "react";
import { ChevronDown, ShieldCheck, Shield } from "lucide-react";
import type { ReasoningEffort } from "../../../packages/core/src/inference.js";
import { ComposerOptions } from "./ComposerOptions.js";
import { ModelPicker } from "./ModelPicker.js";
import { composerSettingsSummary } from "./composer-settings-summary.js";
import "./composer-compact.css";

export type ComposerExecutionSettingsProps = {
  model?: string;
  current?: string;
  reasoning?: ReasoningEffort;
  onModelChange(value: string): void;
  onReasoningChange(value?: ReasoningEffort): void;
  disabled?: boolean;
  continuation?: boolean;
  /** Only actual authorized directory grants, never an implied sandbox mode. */
  directoryCount?: number;
  directoryReady?: boolean;
  permissionControls?: ReactNode;
};

export function ComposerExecutionSettings({
  model,
  current,
  reasoning,
  onModelChange,
  onReasoningChange,
  disabled = false,
  continuation = false,
  directoryCount = 0,
  directoryReady = true,
  permissionControls,
}: ComposerExecutionSettingsProps) {
  const [summary, setSummary] = useState(() =>
    composerSettingsSummary({ model, current, reasoning }),
  );
  const permissionLabel = !directoryReady
    ? "正在核对目录权限"
    : directoryCount
      ? `${directoryCount} 个目录可读写`
      : "未授权本机目录";
  const description = continuation
    ? "补充沿用原工作模型与权限；此处不改变正在执行的工作"
    : `${summary.model} · ${summary.reasoning} · ${permissionLabel}；模型与推理用于下一次新输入`;
  return (
    <ComposerOptions
      label="执行设置"
      description={description}
      menuLabel="本次输入执行设置"
      triggerClassName="composer-settings-trigger"
      menuClassName="composer-settings-menu"
      triggerIcon={
        <>
          <span className="composer-settings-summary">
            {continuation ? "沿用原工作" : summary.model}
          </span>
          {!continuation && (
            <span className="composer-settings-effort">
              {summary.reasoning}
            </span>
          )}
          <span
            className="composer-permission-summary"
            data-authorized={(!continuation && directoryCount > 0) || undefined}
            aria-label={continuation ? "沿用原工作权限" : permissionLabel}
          >
            {!continuation && directoryCount ? <ShieldCheck /> : <Shield />}
            {!continuation && directoryCount > 0 && (
              <span>读写 {directoryCount}</span>
            )}
          </span>
          <ChevronDown className="composer-settings-chevron" />
        </>
      }
      options={[]}
      persistentContent={
        <>
          <section className="composer-settings-section">
            <h3>{continuation ? "原工作设置" : "下一次新输入"}</h3>
            {continuation ? (
              <p>
                补充沿用原工作的模型、推理与权限。不能通过此处修改在途工作。
              </p>
            ) : (
              <ModelPicker
                value={model}
                current={current}
                disabled={disabled}
                onChange={onModelChange}
                reasoning={{ value: reasoning, onChange: onReasoningChange }}
                onSummaryChange={setSummary}
              />
            )}
          </section>
          <section className="composer-settings-section">
            <h3>文件权限</h3>
            <div hidden={continuation}>
              {permissionControls || <p>未授予本机目录读写权限。</p>}
            </div>
            <p>
              {continuation
                ? "沿用原始输入绑定的授权范围，不将当前场景的目录授权带入原工作。"
                : "目录授权持续有效直到撤销，不包含执行命令或删除文件。"}
            </p>
          </section>
        </>
      }
    />
  );
}
