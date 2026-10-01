import { useCallback, useState, type ReactNode } from "react";
import { ChevronDown, FolderKey } from "lucide-react";
import type { SessionPermissionsSnapshot } from "../../../packages/core/src/session-permissions.js";
import { approvalLabel, ComposerApprovalIcon } from "./ComposerApprovalIcon.js";
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
  const permissionKey = JSON.stringify([
    sessionIdentity,
    sessionScope?.projectId,
    sessionScope?.conversationId,
  ]);
  const [permissionPreview, setPermissionPreview] = useState<{
    key: string;
    snapshot: SessionPermissionsSnapshot | null;
  } | null>(null);
  const onPermissionSnapshot = useCallback(
    (snapshot: SessionPermissionsSnapshot | null) => {
      setPermissionPreview({ key: permissionKey, snapshot });
    },
    [permissionKey],
  );
  const permission =
    permissionPreview?.key === permissionKey
      ? permissionPreview.snapshot
      : null;
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
    : `${summary.model} · ${summary.reasoning} · ${approvalLabel(permission?.permissionMode)} · ${permissionLabel}；模型与推理用于下一次新输入${permission ? (permission.scope.kind === "global" ? "；审批在当前全局会话持续生效，跨项目" : "；审批仅当前会话持续生效") : ""}`;
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
            aria-label={
              continuation
                ? "沿用原工作权限"
                : approvalLabel(permission?.permissionMode)
            }
          >
            <ComposerApprovalIcon
              mode={continuation ? null : permission?.permissionMode}
            />
          </span>
          {!continuation && directoryCount > 0 && (
            <span
              className="composer-permission-summary"
              data-authorized
              aria-label={permissionLabel}
            >
              <FolderKey /> <span>读写 {directoryCount}</span>
            </span>
          )}
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
            onSnapshotChange={onPermissionSnapshot}
          />
        </>
      }
    />
  );
}
