import {
  artifactSchema,
  taskContentSchema,
  stateSchema,
  type Artifact,
  type TaskContent,
} from "../../packages/core/src/model.js";
import {
  taskRuntimeSchema,
  type TaskRuntime,
} from "../../packages/core/src/task-runtime.js";
import {
  executionSnapshotSchema,
  jobSchema,
} from "../../packages/core/src/execution.js";

// Independent actual Git capture metadata. Complete old TSX lives only in the
// explicitly supplied migration archive, never in ordinary current CI.
export const taskPanelOriginalGit = "d93326c0114bc6e77b2f50b0f6a19a86dd9cd774";
export const taskPanelOriginalSha =
  "b833401c4e2a5e65adbdc31b2ff2222c80fc8d372c5fc1340365f35d27a08a05";
export const panelTime = "2026-10-04T00:00:00.000Z";

export function panelTask(
  content: Partial<TaskContent> = {},
  value: Partial<Artifact> = {},
) {
  const task = taskContentSchema.parse({
    kind: "task",
    description: "受控事项，保留已产生的结果。",
    assigneeId: "morphz-agent",
    model: null,
    dueDate: null,
    assignment: "accepted",
    execution: "planned",
    delivery: "none",
    resultIds: [],
    runRequested: 0,
    ...content,
  });
  return artifactSchema.parse({
    id: "task-A",
    projectId: "first-project",
    title: "TEST 完整事项面板",
    revision: 3,
    content: task,
    createdBy: { principalId: "local-owner", actantId: "local-human" },
    createdAt: panelTime,
    updatedAt: panelTime,
    versions: [
      {
        revision: 3,
        projectId: "first-project",
        title: "TEST 完整事项面板",
        content: task,
        author: { principalId: "local-owner", actantId: "local-human" },
        createdAt: panelTime,
      },
    ],
    source: null,
    ...value,
  });
}

export function panelRuntime(
  run: Partial<TaskRuntime["runs"][number]> | null = {},
  value: Partial<TaskRuntime> = {},
) {
  return taskRuntimeSchema.parse({
    runs:
      run === null
        ? []
        : [
            {
              run: 1,
              artifactRevision: 2,
              controlRevision: 7,
              threadState: "open",
              record: {
                id: "record-A",
                revision: 4,
                thread_id: "thread-A",
                status: "dispatched",
                interval_seconds: null,
              },
              ...run,
            },
          ],
    ...value,
  });
}

export function panelResponses(taskId = "task-A", taskRevision = 3) {
  return stateSchema.shape.taskResponses.parse([
    {
      id: "response-A",
      taskId,
      taskRevision,
      body: "原事项的真实处理结果",
      author: { principalId: "local-owner", actantId: "local-human" },
      createdAt: panelTime,
    },
  ]);
}

export function panelSnapshot() {
  return executionSnapshotSchema.parse({
    jobs: [
      jobSchema.parse({
        id: "job-A",
        revision: 2,
        session_id: "session-A",
        context_id: "context-A",
        thread_id: "thread-A",
        tool_name: "create-artifact",
        target_id: "local",
        request: { title: "原成果" },
        status: "succeeded",
        result_event_id: "receipt-A",
        created_at: panelTime,
        updated_at: panelTime,
      }),
    ],
    approvals: [],
    limit: 100,
  });
}
