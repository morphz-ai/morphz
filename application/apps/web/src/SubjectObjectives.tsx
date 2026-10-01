import { useState } from "react";
import { Target, ChevronDown, ChevronRight } from "lucide-react";
import type { WorkspaceClient } from "./client.js";
import type { ExecutionScope } from "../../../packages/core/src/execution.js";
import { inConversation } from "../../../packages/core/src/model.js";
import { objectiveStatus } from "./subject-sidebar-model.js";

export function SubjectObjectives({
  client,
  scope,
  allWork,
  onSelect,
}: {
  client: WorkspaceClient;
  scope: ExecutionScope;
  allWork: boolean;
  onSelect(scope: ExecutionScope): void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const runtime = client.boot!.runtime,
    state = client.boot!.workspace;
  const goals =
    runtime.activity?.objectives?.filter(
      (goal) =>
        allWork ||
        inConversation(
          state,
          scope.conversationId ?? scope.projectId,
          goal,
          !client.boot!.capabilities.teamAuthentication,
        ),
    ) ?? [];
  if (!goals.length) return null;
  const fresh =
    client.online && runtime.connected && runtime.activity?.available;
  return (
    <section className="subject-objectives" aria-label="目标">
      <h3>目标</h3>
      {goals.map((goal) => {
        const threads =
          runtime.activity?.threads.filter(
            (thread) =>
              thread.kind === "execution" && goal.threadIds.includes(thread.id),
          ) ?? [];
        const open = expanded === goal.id;
        return (
          <div
            key={goal.id}
            className="subject-objective"
            data-objective-id={goal.id}
          >
            <button
              className="subject-objective-heading"
              aria-expanded={open}
              onClick={() => setExpanded(open ? null : goal.id)}
            >
              <Target aria-hidden="true" />
              <span>
                <strong>{goal.title}</strong>
                <small>
                  {fresh ? objectiveStatus(goal.status) : "状态待核对"} ·{" "}
                  {threads.length} 个关联执行
                </small>
              </span>
              {open ? <ChevronDown /> : <ChevronRight />}
            </button>
            {open && (
              <div className="subject-objective-detail">
                {goal.statusReason && <p>{goal.statusReason}</p>}
                {!fresh && <p role="status">目标状态待核对。</p>}
                {threads.map((thread) => (
                  <button
                    key={thread.id}
                    onClick={() =>
                      onSelect({
                        projectId: thread.projectId,
                        conversationId: thread.conversationId,
                        artifactId: null,
                        ...(thread.inputId ? { inputId: thread.inputId } : {}),
                        threadId: thread.id,
                      })
                    }
                  >
                    {thread.title}
                    <ChevronRight />
                  </button>
                ))}
                {!threads.length && (
                  <p className="muted">当前概览中没有关联执行</p>
                )}
              </div>
            )}
          </div>
        );
      })}
      {runtime.activity?.objectivesTruncated && (
        <small className="muted">目标概览尚不完整</small>
      )}
    </section>
  );
}
