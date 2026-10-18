import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Target, ChevronDown, ChevronRight, Eye } from "lucide-react";
import type { WorkspaceClient } from "./client.js";
import type { ExecutionReadScope } from "../../../packages/core/src/execution.js";
import {
  objectiveDetailStatus,
  objectiveIsTerminal,
  objectiveStatus,
} from "./subject-sidebar-model.js";
import {
  executionActivityScope,
  executionActivityStatus,
} from "./execution-activity.js";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon.js";
import { PersistentDetails } from "./PersistentDetails.js";
import { Tooltip } from "./ui/Tooltip.js";
import { SubjectObjectiveDialog } from "./SubjectObjectiveDialog.js";

function ObjectiveHeading({
  title,
  open,
  status,
  onToggle,
  onView,
}: {
  title: string;
  open: boolean;
  status: ReactNode;
  onToggle(): void;
  onView(): void;
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
    </div>
  );
}

export function SubjectObjectives({
  client,
  scope,
  onSelect,
}: {
  client: WorkspaceClient;
  scope?: ExecutionReadScope;
  onSelect(scope: ExecutionReadScope): void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
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
    const running = fresh
      ? threads.filter(
          (thread) => executionActivityStatus(thread, true).kind === "running",
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
          status={
            <>
              {fresh
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
              {fresh
                ? objectiveDetailStatus(
                    goal.status,
                    goal.readiness,
                    goal.waitKinds,
                  )
                : "目标状态待核对"}
            </p>
            {threads.map((thread) => {
              const status = executionActivityStatus(thread, !!fresh);
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
                  onClose={() => setViewing(null)}
                />,
                host,
              )
            : null;
        })()}
    </>
  );
}
