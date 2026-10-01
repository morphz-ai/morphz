import { useState, type ReactNode } from "react";
import { ChevronDown, ShieldCheck, Shield } from "lucide-react";
import type { ReasoningEffort } from "../../../packages/core/src/inference.js";
import { ComposerOptions } from "./ComposerOptions.js";
import { ModelPicker } from "./ModelPicker.js";
import { composerSettingsSummary } from "./composer-settings-summary.js";
import { ComposerSessionPermissions } from "./ComposerSessionPermissions.js";
import "./composer-compact.css";

export type ComposerExecutionSettingsProps = {
  model?: string;
  current?: string;
  reasoning?: ReasoningEffort;
  onModelChange(value: string): void;
  onReasoningChange(value?: ReasoningEffort): void;
  disabled?: boolean;
  continuation?: boolean;
  /** Existing input scope only; an unsent named draft passes no scope. */
  sessionScope?: { projectId: string; conversationId: string };
  sessionIdentity?: string;
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
  sessionScope,
  sessionIdentity,
  directoryCount = 0,
  directoryReady = true,
  permissionControls,
}: ComposerExecutionSettingsProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [summary, setSummary] = useState(() =>
    composerSettingsSummary({ model, current, reasoning }),
  );
  const permissionLabel = !directoryReady
    ? "正在核对额外目录"
    : directoryCount
      ? `${directoryCount} 个额外目录可读写`
      : "未添加额外目录";
  const description = continuation
    ? "补充沿用原工作模型与权限；此处不改变正在执行的工作"
    : `${summary.model} · ${summary.reasoning} · ${permissionLabel}；模型与推理用于下一次新输入`;
  return (
    <ComposerOptions
      label="执行设置"
      description={description}
      menuLabel="执行设置"
      triggerClassName="composer-settings-trigger"
      menuClassName="composer-settings-menu"
      initialFocus="panel"
      onOpenChange={setSettingsOpen}
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
            {continuation ? (
              <p className="composer-continuation-settings">
                补充沿用原工作的模型、推理与授权，不改变在途工作。
              </p>
            ) : (
              <ModelPicker
                menu
                value={model}
                current={current}
                disabled={disabled}
                onChange={onModelChange}
                reasoning={{ value: reasoning, onChange: onReasoningChange }}
                onSummaryChange={setSummary}
              />
            )}
          </section>
          {/* The controller and grants stay mounted; Session policy reads only
              occur while open, never creating or preparing an empty Session. */}
          <ComposerSessionPermissions
            scope={sessionScope}
            identityGeneration={sessionIdentity}
            open={settingsOpen}
            disabled={disabled}
            continuation={continuation}
            directoryCount={directoryCount}
            directoryReady={directoryReady}
            directoryControls={permissionControls}
          />
          {!continuation && (
            <p className="composer-settings-scope">
              模型与推理仅用于下一次发送
            </p>
          )}
        </>
      }
    />
  );
}
