import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { ChevronDown, FolderKey } from "lucide-react";
import { ComposerApprovalIcon } from "./ComposerApprovalIcon.js";
import {
  sessionPermissionsSnapshotSchema,
  type SessionPermissionsSnapshot,
  type SessionPermissionsUpdate,
} from "../../../packages/core/src/session-permissions.js";
import {
  applicationCall,
  applicationIdentity,
} from "./application-transport.js";

type Scope = { projectId: string; conversationId: string };
type PermissionMode = SessionPermissionsUpdate["permissionMode"];
const labels: Record<PermissionMode, string> = {
  request_approval: "询问批准",
  auto_review: "自动审批",
  full_access: "完全访问",
};
const directoryDescription =
  "额外目录仅当前对话与工作空间可读写，持续有效直到撤销。目录授权不含执行命令或删除文件；撤销会阻止进行中工作的后续目录访问。";
const workspaceReasons: Record<string, string> = {
  not_started: "首次发送后可查看默认工作目录。",
  workspace_root_unavailable: "执行节点尚未配置默认工作目录。",
  selected_target_offline: "执行节点离线，默认工作目录暂不可用。",
  selected_target_unavailable: "执行节点不可访问。",
  selected_target_missing: "所选执行节点不可访问。",
  no_targets: "请先配置执行节点。",
  no_ready_targets: "执行节点暂不可用。",
  explicit_selection_required: "请先选择执行节点。",
  target_unavailable: "执行节点不可访问。",
  target_not_selected: "请先选择执行节点。",
  execution_target_required: "请先选择执行节点。",
};
type View = {
  key: string;
  snapshot: SessionPermissionsSnapshot | null;
  loading: boolean;
  saving: boolean;
  error: string;
};

/** Only the Runtime-backed Session policy is writable. A local draft never
 * gains a Session or deferred permission setting by opening this control. */
export function ComposerSessionPermissions({
  scope,
  identityGeneration,
  open,
  disabled = false,
  continuation = false,
  directoryCount = 0,
  directoryReady = true,
  directoryControls,
  onSnapshotChange,
}: {
  scope?: Scope;
  identityGeneration?: string;
  open: boolean;
  disabled?: boolean;
  continuation?: boolean;
  directoryCount?: number;
  directoryReady?: boolean;
  directoryControls?: ReactNode;
  onSnapshotChange?(snapshot: SessionPermissionsSnapshot | null): void;
}) {
  const identity = applicationIdentity();
  const key = JSON.stringify([
    identity,
    identityGeneration,
    scope?.projectId,
    scope?.conversationId,
  ]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [view, setView] = useState<View>({
    key,
    snapshot: null,
    loading: false,
    saving: false,
    error: "",
  });
  const [refresh, setRefresh] = useState(0);
  const [confirmFull, setConfirmFull] = useState(false);
  const select = useRef<HTMLSelectElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const mutation = useRef(false);
  const readSequence = useRef(0);
  const mounted = useRef(false);
  const current = view.key === key ? view : null;
  const snapshot = current?.snapshot;
  useEffect(() => {
    onSnapshotChange?.(current?.error ? null : (snapshot ?? null));
  }, [key, snapshot, current?.error, onSnapshotChange]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setConfirmFull(false);
  }, [key, open, continuation]);
  useLayoutEffect(() => {
    if (confirmFull) cancel.current?.focus({ preventScroll: true });
  }, [confirmFull]);

  useEffect(() => {
    // The controller stays mounted, but never polls or prepares a write while
    // hidden. Continuations retain their original work's authority unchanged.
    if (
      !open ||
      !scope ||
      !identityGeneration ||
      disabled ||
      continuation ||
      mutation.current
    )
      return;
    const sequence = ++readSequence.current;
    const controller = new AbortController();
    setView((old) => ({
      key,
      snapshot: old.key === key ? old.snapshot : null,
      loading: true,
      saving: false,
      error: "",
    }));
    void applicationCall("session-permissions.read", scope, {
      signal: controller.signal,
      identityGeneration,
    })
      .then((value) => {
        const next = sessionPermissionsSnapshotSchema.parse(value);
        if (
          controller.signal.aborted ||
          sequence !== readSequence.current ||
          currentKey.current !== key
        )
          return;
        setView({
          key,
          snapshot: next,
          loading: false,
          saving: false,
          error: "",
        });
      })
      .catch((error) => {
        if (
          controller.signal.aborted ||
          sequence !== readSequence.current ||
          currentKey.current !== key
        )
          return;
        setView((old) => ({
          key,
          snapshot: old.key === key ? old.snapshot : null,
          loading: false,
          saving: false,
          error:
            error instanceof Error ? error.message : "暂无法读取会话审批方式。",
        }));
      });
    return () => controller.abort();
  }, [open, key, disabled, continuation, refresh]);

  async function update(permissionMode: PermissionMode, confirmation = false) {
    if (
      !scope ||
      !identityGeneration ||
      continuation ||
      disabled ||
      mutation.current ||
      !snapshot?.canUpdate ||
      !snapshot.permissionMode ||
      !snapshot.fingerprint ||
      current?.loading ||
      current?.error
    )
      return;
    const originatingKey = key;
    const confirmationGroup = cancel.current?.closest(
      ".composer-permission-confirm",
    );
    // A native control loses focus when saving disables it. Capture the
    // originating focus before that render, rather than after the response.
    const ownedFocus =
      document.activeElement === select.current ||
      confirmationGroup?.contains(document.activeElement);
    const request: SessionPermissionsUpdate = {
      ...scope,
      permissionMode,
      expectedFingerprint: snapshot.fingerprint,
      ...(confirmation ? { confirmation: true } : {}),
    };
    mutation.current = true;
    setView((old) => ({ ...old, saving: true, error: "" }));
    try {
      const next = sessionPermissionsSnapshotSchema.parse(
        await applicationCall("session-permissions.update", request, {
          identityGeneration,
        }),
      );
      if (mounted.current && currentKey.current === originatingKey)
        setView({
          key: originatingKey,
          snapshot: next,
          loading: false,
          saving: false,
          error: "",
        });
    } catch (error) {
      if (mounted.current && currentKey.current === originatingKey)
        setView((old) => ({
          ...old,
          loading: false,
          saving: false,
          error: `${error instanceof Error ? error.message : "审批方式未确认。"} 请重新读取，不要重复提交。`,
        }));
    } finally {
      mutation.current = false;
      if (mounted.current) {
        if (currentKey.current === originatingKey) {
          const restore =
            ownedFocus &&
            (document.activeElement === document.body ||
              document.activeElement === select.current ||
              confirmationGroup?.contains(document.activeElement));
          // Closing the confirmation removes its focused button. Return to
          // this still-open control, not body; never steal newer navigation.
          flushSync(() => setConfirmFull(false));
          const panel = select.current?.closest<HTMLElement>("[popover]");
          if (restore && panel?.matches(":popover-open")) {
            if (select.current && !select.current.disabled)
              select.current.focus({ preventScroll: true });
            else panel.focus({ preventScroll: true });
          }
        }
        // A new scope's read was deliberately deferred while this write was
        // in flight. Reconcile it now; never apply the old scope's response.
        else setRefresh((value) => value + 1);
      }
    }
  }

  const unavailable =
    !scope ||
    !identityGeneration ||
    disabled ||
    continuation ||
    !snapshot?.canUpdate ||
    !snapshot.permissionMode ||
    current?.loading ||
    current?.saving ||
    !!current?.error;
  const note =
    !scope || snapshot?.readOnlyReason === "not_started"
      ? "首次发送后可调整"
      : snapshot?.readOnlyReason === "team_managed"
        ? "此会话由团队管理"
        : snapshot?.readOnlyReason === "local_only"
          ? "请在本机 Morphz 调整"
          : current?.loading
            ? "正在读取审批方式…"
            : current?.saving
              ? "正在确认审批方式…"
              : "";
  const workspace = snapshot?.workspace;
  const directoryLabel = !directoryReady
    ? "待核对"
    : directoryCount
      ? `额外 ${directoryCount} 个`
      : workspace?.ready && workspace.workspaceRoot
        ? "默认目录"
        : "待核对";
  const scopeNote = !snapshot
    ? ""
    : snapshot.scope.kind === "global"
      ? "当前全局会话持续生效，跨项目；影响后续工具操作（含进行中工作后续步骤）。"
      : "仅当前会话持续生效；影响后续工具操作（含进行中工作后续步骤）。";

  function cancelFullAccess() {
    setConfirmFull(false);
    select.current?.focus({ preventScroll: true });
  }

  return (
    <section
      className="composer-session-permissions"
      hidden={continuation}
      aria-busy={current?.loading || current?.saving || undefined}
    >
      <label className="composer-setting-row composer-approval-choice">
        <ComposerApprovalIcon mode={snapshot?.permissionMode} />
        <span className="visually-hidden">审批</span>
        <select
          ref={select}
          aria-label="当前会话审批方式"
          value={snapshot?.permissionMode ?? ""}
          disabled={unavailable}
          title={note || scopeNote}
          aria-description={[
            scopeNote,
            snapshot?.permissionMode === "auto_review"
              ? "自动安全评审，可能拒绝或交由你批准"
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onChange={(event) => {
            const mode = event.target.value as PermissionMode;
            if (mode === "full_access") setConfirmFull(true);
            else void update(mode);
          }}
        >
          {!snapshot?.permissionMode && (
            <option value="" disabled>
              {current?.loading ? "读取中…" : "审批方式待核对"}
            </option>
          )}
          {snapshot?.permissionMode === "custom" && (
            <option value="custom" disabled>
              自定义策略
            </option>
          )}
          {Object.entries(labels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
        {/* Read/save feedback must not add a grid row and move the anchored
            popover. The disabled control and its title retain visible context;
            announce the operation without changing the canvas geometry. */}
        <small className="visually-hidden" role="status">
          {note}
        </small>
      </label>
      {current?.error && (
        <div className="composer-permission-error" role="alert">
          <span>{current.error}</span>
          <button
            disabled={!scope || disabled || current.saving}
            onClick={() => setRefresh((value) => value + 1)}
          >
            重新读取
          </button>
        </div>
      )}
      {confirmFull && (
        <div
          className="composer-permission-confirm"
          role="group"
          aria-label="确认完全访问"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !current?.saving) {
              event.preventDefault();
              event.stopPropagation();
              cancelFullAccess();
            }
          }}
        >
          <p>
            工具不再询问批准，执行沙盒切为完全访问。
            {snapshot?.scope.kind === "global"
              ? "此全局会话跨项目生效。"
              : "仅此会话生效。"}{" "}
            包括进行中工作的后续操作；不改变系统或项目权限。
          </p>
          <div className="composer-permission-actions">
            <button
              ref={cancel}
              disabled={current?.saving}
              onClick={cancelFullAccess}
            >
              取消
            </button>
            <button
              disabled={unavailable}
              onClick={() => void update("full_access", true)}
            >
              确认完全访问
            </button>
          </div>
        </div>
      )}
      <details className="composer-directory-settings">
        <summary>
          <FolderKey aria-hidden="true" />
          <span className="visually-hidden">工作目录</span>
          <span className="composer-directory-value">
            <span>{directoryLabel}</span>
            <ChevronDown aria-hidden="true" />
          </span>
        </summary>
        <div
          className="composer-directory-details"
          title={directoryDescription}
          aria-description={directoryDescription}
        >
          {workspace?.ready && workspace.workspaceRoot ? (
            <div className="composer-default-workspace">
              <code
                title={workspace.workspaceRoot}
                aria-description={
                  workspace.targetName
                    ? `执行节点：${workspace.targetName}`
                    : undefined
                }
              >
                {workspace.workspaceRoot}
              </code>
            </div>
          ) : (
            <p role="status" title={workspace?.reason || undefined}>
              {workspace?.reason
                ? workspaceReasons[workspace.reason] || "默认工作目录暂不可用。"
                : "默认工作目录待核对。"}
            </p>
          )}
          {directoryControls || <p>当前环境不提供额外本机目录授权。</p>}
        </div>
      </details>
    </section>
  );
}
