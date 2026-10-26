import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Target,
  ChevronDown,
  ChevronRight,
  Eye,
  MessageSquarePlus,
  Pause,
  Play,
} from "lucide-react";
import type { WorkspaceClient } from "./client.js";
import type { ExecutionReadScope } from "../../../packages/core/src/execution.js";
import type { InputContinuation } from "../../../packages/core/src/continuation.js";
import {
  objectiveDetailStatus,
  objectiveIsTerminal,
  objectiveStatus,
} from "./subject-sidebar-model.js";
import {
  executionActivityScope,
  executionActivityStatus,
  executionActivityContextAvailable,
  executionActivityThreadAvailable,
  executionActivityApprovals,
} from "./execution-activity.js";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon.js";
import { PersistentDetails } from "./PersistentDetails.js";
import { Tooltip } from "./ui/Tooltip.js";
import { SubjectObjectiveDialog } from "./SubjectObjectiveDialog.js";
import type { ActivityThread } from "./execution-activity.js";
import type { QuestionObjective } from "./UserInputDialogHost.js";
import { observeSupplementAttention } from "./supplement-attention.js";
import { applicationCall } from "./application-transport.js";

function ObjectiveHeading({
  title,
  open,
  status,
  onToggle,
  onView,
  supplement,
  control,
}: {
  title: string;
  open: boolean;
  status: ReactNode;
  onToggle(): void;
  onView(): void;
  supplement?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="subject-objective-row">
      <Tooltip label={title} className="subject-objective-preview">
        <button
          className="subject-objective-heading"
          aria-expanded={open}
          onClick={onToggle}
        >
          <Target aria-hidden="true" />
          <span>
            <strong>{title}</strong>
            <small>{status}</small>
          </span>
          {open ? <ChevronDown /> : <ChevronRight />}
        </button>
      </Tooltip>
      <span className="subject-objective-actions">
        {supplement}
        <Tooltip label="查看目标">
          <button
            className="icon-button subject-objective-view"
            data-size="icon-xs"
            aria-label="查看目标"
            onClick={onView}
          >
            <Eye />
          </button>
        </Tooltip>
        {control}
      </span>
    </div>
  );
}

export function SubjectObjectives({
  client,
  scope,
  onSelect,
  onSupplement,
  onReply,
  onReplyObjective,
}: {
  client: WorkspaceClient;
  scope?: ExecutionReadScope;
  onSelect(scope: ExecutionReadScope): void;
  onSupplement?: (target: InputContinuation) => void;
  onReply?: (thread: ActivityThread) => void;
  onReplyObjective?: (
    goal: QuestionObjective,
    threads: ActivityThread[],
  ) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [controlling, setControlling] = useState(""),
    [controlError, setControlError] = useState("");
  const pendingControl = useRef(false),
    identity = useRef(client.boot!.csrfToken);
  identity.current = client.boot!.csrfToken;
  const supplement = useRef(onSupplement);
  supplement.current = onSupplement;
  const supplementRequest = useRef(0);
  const currentView = useRef(viewing);
  currentView.current = viewing;
  useEffect(
    () => () => {
      supplementRequest.current++;
    },
    [],
  );
  const runtime = client.boot!.runtime,
    state = client.boot!.workspace;
  const goals =
    runtime.activity?.objectives?.filter((goal) => {
      // The overview uses only the Host's already authorized, loaded goals.
      // Work-surface navigation is not another authority or filtering scope.
      if (!scope) return true;
      if (
        goal.projectId !== scope.projectId ||
        goal.conversationId !== (scope.conversationId ?? scope.projectId)
      )
        return false;
      if (scope.threadId) {
        const thread = runtime.activity?.threads.find(
          (t) => t.id === scope.threadId,
        );
        return (
          !!thread &&
          thread.sessionId === goal.sessionId &&
          thread.projectId === goal.projectId &&
          thread.conversationId === goal.conversationId &&
          goal.threadIds.includes(thread.id)
        );
      }
      return (
        !!scope.inputId &&
        (goal.inputId === scope.inputId ||
          runtime.activity?.threads.some(
            (t) =>
              t.inputId === scope.inputId &&
              t.sessionId === goal.sessionId &&
              t.projectId === goal.projectId &&
              t.conversationId === goal.conversationId &&
              goal.threadIds.includes(t.id),
          ))
      );
    }) ?? [];
  async function quickControl(goal: (typeof goals)[number]) {
    if (
      pendingControl.current ||
      !client.online ||
      !runtime.connected ||
      !goal.controlAllowed ||
      !goal.revision ||
      !executionActivityContextAvailable(goal.contextId, runtime)
    )
      return;
    const origin = client.boot!.csrfToken;
    pendingControl.current = true;
    setControlling(goal.id);
    setControlError("");
    try {
      await applicationCall(
        "objective.control",
        {
          objectiveId: goal.id,
          projectId: goal.projectId,
          conversationId: goal.conversationId,
          revision: goal.revision,
          action: ["paused", "blocked"].includes(goal.status)
            ? "resume"
            : "pause",
        },
        { identityGeneration: origin, signal: AbortSignal.timeout(12000) },
      );
      await client.refreshView();
    } catch (cause) {
      if (identity.current === origin)
        setControlError(
          cause instanceof Error
            ? cause.message
            : "目标操作未确认，请核对状态。",
        );
    } finally {
      pendingControl.current = false;
      if (identity.current === origin) setControlling("");
    }
  }
  if (!goals.length && (scope || !runtime.activity?.objectivesTruncated))
    return null;
  const fresh =
    client.online && runtime.connected && runtime.activity?.available;
  const label = scope ? "关联目标" : "目标";
  // Match Dashboard's current activity semantics, not a second authority
  // filter. Terminal goals stay in readable history and exact inspectors.
  const current = scope
    ? goals
    : goals.filter((goal) => !objectiveIsTerminal(goal.status));
  const history = scope
    ? []
    : goals.filter((goal) => objectiveIsTerminal(goal.status));
  const renderGoal = (goal: (typeof goals)[number]) => {
    const goalFresh =
      client.online &&
      executionActivityContextAvailable(goal.contextId, runtime);
    const threads =
      runtime.activity?.threads.filter(
        (thread) =>
          thread.kind === "execution" &&
          thread.sessionId === goal.sessionId &&
          thread.projectId === goal.projectId &&
          thread.conversationId === goal.conversationId &&
          goal.threadIds.includes(thread.id),
      ) ?? [];
    const open = expanded === goal.id;
    const needsApproval =
      goalFresh &&
      threads.some(
        (thread) =>
          executionActivityApprovals(
            thread,
            runtime.activity?.threads ?? [],
            runtime.attention,
          ).length,
      );
    const running = goalFresh
      ? threads.filter(
          (thread) =>
            executionActivityStatus(
              thread,
              executionActivityThreadAvailable(thread, runtime),
            ).kind === "running",
        ).length
      : 0;
    return (
      <div
        key={goal.id}
        className="subject-objective"
        data-objective-id={goal.id}
      >
        <ObjectiveHeading
          title={goal.title}
          open={open}
          onToggle={() => setExpanded(open ? null : goal.id)}
          onView={() => setViewing(goal.id)}
          control={
            goal.controlAllowed &&
            ["active", "blocked", "paused"].includes(goal.status) ? (
              <Tooltip
                label={
                  ["paused", "blocked"].includes(goal.status)
                    ? "继续目标"
                    : "暂停目标"
                }
              >
                <button
                  className="icon-button"
                  data-size="icon-xs"
                  aria-label={
                    ["paused", "blocked"].includes(goal.status)
                      ? "继续目标"
                      : "暂停目标"
                  }
                  disabled={!goalFresh || !!controlling}
                  aria-busy={controlling === goal.id}
                  onClick={() => void quickControl(goal)}
                >
                  {["paused", "blocked"].includes(goal.status) ? (
                    <Play />
                  ) : (
                    <Pause />
                  )}
                </button>
              </Tooltip>
            ) : undefined
          }
          supplement={
            goal.pendingUserInput && onReplyObjective ? (
              <Tooltip label="补充 · 有待答问题">
                <button
                  type="button"
                  className="icon-button needs-input"
                  ref={observeSupplementAttention}
                  data-size="icon-xs"
                  aria-label="补充目标"
                  disabled={!goalFresh || goal.status !== "active"}
                  onClick={() => onReplyObjective(goal, threads)}
                >
                  <MessageSquarePlus />
                </button>
              </Tooltip>
            ) : undefined
          }
          status={
            <>
              {needsApproval
                ? "等待你的批准"
                : goalFresh
                  ? goal.readiness === "waiting"
                    ? objectiveDetailStatus(
                        goal.status,
                        goal.readiness,
                        goal.waitKinds,
                      )
                    : objectiveStatus(goal.status)
                  : "状态待核对"}{" "}
              · {threads.length} 个关联执行
              {running > 0 && ` · ${running} 条执行中`}
            </>
          }
        />
        {open && (
          <div className="subject-objective-detail">
            <p role="status">
              {needsApproval
                ? "等待你的批准"
                : goalFresh
                  ? objectiveDetailStatus(
                      goal.status,
                      goal.readiness,
                      goal.waitKinds,
                    )
                  : "目标状态待核对"}
            </p>
            {threads.map((thread) => {
              const status = executionActivityStatus(
                thread,
                client.online &&
                  executionActivityThreadAvailable(thread, runtime),
              );
              return (
                <Tooltip
                  key={thread.id}
                  label={thread.title}
                  className="subject-objective-preview"
                >
                  <button
                    className="subject-objective-execution"
                    data-thread-id={thread.id}
                    aria-label={`${thread.title} · ${status.label}`}
                    onClick={() =>
                      onSelect(executionActivityScope(thread, state))
                    }
                  >
                    <span
                      className="execution-thread-state"
                      data-status={status.kind}
                      title={status.label}
                    >
                      <ExecutionStatusIcon kind={status.kind} size={18} />
                    </span>
                    <span className="subject-objective-execution-copy">
                      <span>{thread.title}</span>
                      <small>{status.label}</small>
                    </span>
                    <ChevronRight />
                  </button>
                </Tooltip>
              );
            })}
            {!threads.length && <p className="muted">当前概览中没有关联执行</p>}
            {goal.statusReason && (
              <details className="subject-objective-diagnostics">
                <summary>技术详情</summary>
                <p>{goal.statusReason}</p>
              </details>
            )}
          </div>
        )}
      </div>
    );
  };
  return (
    <>
      {(current.length > 0 || runtime.activity?.objectivesTruncated) && (
        <section className="subject-objectives" aria-label={label}>
          <h3>{label}</h3>
          {current.map(renderGoal)}
          {controlError && (
            <p role="alert" className="delivery-error">
              {controlError}
            </p>
          )}
          {runtime.activity?.objectivesTruncated && (
            <small className="muted">目标概览尚不完整</small>
          )}
        </section>
      )}
      {history.length > 0 && (
        <PersistentDetails
          className="subject-objective-history subject-objectives"
          storageScope={`${client.boot!.centerId}:${client.boot!.principalId}`}
          preferenceKey="subject:ended-objectives"
          revealKey={
            history.some((goal) => goal.id === expanded)
              ? (expanded ?? undefined)
              : undefined
          }
          onOpenChange={(open) => {
            if (!open && history.some((goal) => goal.id === expanded))
              setExpanded(null);
          }}
        >
          <summary>
            <span>已结束目标</span>
            <small>{history.length}</small>
            <ChevronRight aria-hidden="true" />
          </summary>
          <section aria-label="已结束目标">{history.map(renderGoal)}</section>
        </PersistentDetails>
      )}
      {viewing &&
        (() => {
          const goal = goals.find((goal) => goal.id === viewing);
          const host =
            document.querySelector(".primary-panel") ??
            document.querySelector(".workspace");
          return goal && host
            ? createPortal(
                <SubjectObjectiveDialog
                  key={`${client.boot!.centerId}:${client.boot!.principalId}:${goal.id}`}
                  goal={goal}
                  client={client}
                  fresh={!!fresh}
                  statusFresh={
                    client.online &&
                    executionActivityContextAvailable(goal.contextId, runtime)
                  }
                  threads={runtime.activity!.threads.filter(
                    (thread) =>
                      thread.kind === "execution" &&
                      thread.sessionId === goal.sessionId &&
                      thread.projectId === goal.projectId &&
                      thread.conversationId === goal.conversationId &&
                      goal.threadIds.includes(thread.id),
                  )}
                  onSelect={onSelect}
                  onReply={onReply}
                  onReplyObjective={onReplyObjective}
                  onSupplement={
                    onSupplement
                      ? async (target) => {
                          const request = ++supplementRequest.current;
                          const identity = `${client.boot!.centerId}:${client.boot!.principalId}:${client.boot!.actantId}`;
                          await client.loadHistoryUntil(target.inputId);
                          // History hydration publishes a new render. Invoke its current
                          // draft command, never a captured pre-hydration draft snapshot.
                          await new Promise<void>((resolve) =>
                            requestAnimationFrame(() => resolve()),
                          );
                          const boot = client.getSnapshot();
                          const original = boot?.workspace.inputs.find(
                            (input) => input.id === target.inputId,
                          );
                          if (
                            request !== supplementRequest.current ||
                            currentView.current !== goal.id ||
                            !boot ||
                            `${boot.centerId}:${boot.principalId}:${boot.actantId}` !==
                              identity ||
                            !original ||
                            original.author.principalId !== boot.principalId ||
                            original.author.actantId !== boot.actantId ||
                            !supplement.current
                          )
                            throw new Error(
                              "此目标的原消息暂时无法读取，未改变输入框或发送消息。",
                            );
                          setViewing(null);
                          // Let native-modal focus restoration finish before the shared
                          // composer takes focus. The command only associates; never sends.
                          requestAnimationFrame(() => {
                            const boot = client.getSnapshot();
                            if (
                              request === supplementRequest.current &&
                              boot &&
                              `${boot.centerId}:${boot.principalId}:${boot.actantId}` ===
                                identity
                            )
                              supplement.current?.(target);
                          });
                        }
                      : undefined
                  }
                  onClose={() => {
                    supplementRequest.current++;
                    setViewing(null);
                  }}
                />,
                host,
              )
            : null;
        })()}
    </>
  );
}
