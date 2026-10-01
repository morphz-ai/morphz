import { useState, type ReactNode } from "react";
import { ChevronDown, FolderKey, ShieldCheck, Shield } from "lucide-react";
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
      initialFocus="panel"
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
          {/* Keep the permission controller mounted even inside a closed
              disclosure: it supplies the grants and ready guard for send. */}
          <details
            className="composer-directory-settings"
            hidden={continuation}
          >
            <summary>
              <FolderKey aria-hidden="true" />
              <span>目录权限</span>
              <span className="composer-directory-value">
                <span>
                  {!directoryReady
                    ? "待核对"
                    : directoryCount
                      ? `可读写 ${directoryCount}`
                      : "未授权"}
                </span>
                <ChevronDown aria-hidden="true" />
              </span>
            </summary>
            <div className="composer-directory-details">
              <p>仅当前对话与工作空间，持续有效直到撤销。</p>
              <p>
                不含执行命令或删除文件；撤销会阻止进行中工作的后续目录访问。
              </p>
              {permissionControls || <p>当前环境不提供本机目录授权。</p>}
            </div>
          </details>
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
