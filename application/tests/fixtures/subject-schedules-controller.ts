import {
  platformTaskSchema,
  type PlatformTask,
} from "../../apps/web/src/platform-client.js";
import {
  taskRuntimeSchema,
  type TaskRuntime,
} from "../../packages/core/src/task-runtime.js";
import {
  activitySchema,
  runtimeScheduleSchema,
  type RuntimeSchedule,
} from "../../packages/core/src/conversation.js";

// Independently captured from actual Git57e, never generated from the new hook.
// Complete old renderer is an explicit migration archive, not a normal CI lock.
export const scheduleOriginal = {
  manifest: {
    originalGit: "57e7d4ce97416bf39fc2a1eb2f00951bca6def8d",
    source: "application/apps/web/src/SubjectSchedules.tsx",
    file: "SubjectSchedules-57e7d4ce.tsx",
    sha256: "5c86e53433c3f3a15add00046ca0bcef16847283b836ba5f000e951eae1601e0",
    bytes: 8520,
    preludeSha: [
      "94b85470ea66263f97d7fbc86b16c23d228ccef74d056d3cb5e7fd1edb9a0753",
      "e4854e22e270fd48ef7ca7d7128f61638927cb3e6880382c75468a5d24827215",
      "dc3c018af687de3741a26b505bb5d4d8eb7c6ae9a951a67b6926905684164208",
      "4130a1c82e902ad20bc1f510a8afa1d96849ebfea6b9176e1b214017377bf742",
      "1e78e5cbd67cd4a885d4b39d9a083f147f62fcdd4fda72881ab55a7517ff2f43",
      "71d3b4d1ad9fd3744bc2c3195dd9b9af0ea4d0f3d498cccefc55ed9189372532",
      "4455416a13ca0d45f437e08daa23abb1af9b5ef85f2503177144738855aaf2f8",
      "7d4b7ca8996ef9a1c363387ef3417466c09a0cdcd623764704e1999dbaaea23d",
      "2e2043afa96886a32f6cb8d8a0b2e183ac8cc012ba2af2ed55ba5261ebd06198",
      "8d64186d406c3fd58984b2452b284fde6a949409c81afadb8fc1e72239068a99",
      "a24726f471f24d4b38d64b3603d675c00e02d99c7e0c8b0bc3ccfb57d6de73bf",
    ],
  },
  prelude: [
    "const [rows, setRows] = useState<\n    Array<{ task: PlatformTask; runtime: TaskRuntime }>\n  >([]);",
    'const [error, setError] = useState(""),\n    [loading, setLoading] = useState(true);',
    "const [more, setMore] = useState(false),\n    [attempt, setAttempt] = useState(0);",
    "const refreshedAttempt = useRef(0);",
    "const identity = client.boot!.csrfToken;",
    "const activity = client.boot!.runtime.activity;",
    "const connected = client.online && client.boot!.runtime.connected;",
    "const nativeError =\n    !connected || !activity?.available || !activity.schedulesAvailable;",
    "const covered = new Set(\n    rows.flatMap(({ task, runtime }) => {\n      const run = liveArrangement(runtime, task.headVersion.runRequested);\n      return run?.record?.id ? [run.record.id] : [];\n    }),\n  );",
    "const nativeRows = runtimeArrangements(activity, connected, covered);",
    'useEffect(() => {\n    const controller = new AbortController();\n    const explicitRefresh = attempt !== refreshedAttempt.current;\n    refreshedAttempt.current = attempt;\n    setRows([]);\n    setError("");\n    setLoading(true);\n    setMore(false);\n    if (!client.online || !client.boot!.runtime.connected) {\n      setLoading(false);\n      setError("连接中断，定时任务待核对。");\n      return () => controller.abort();\n    }\n    void (async () => {\n      if (explicitRefresh) {\n        await applicationCall(\n          "runtime.navigation",\n          { refreshActivity: true },\n          {\n            signal: controller.signal,\n            identityGeneration: identity,\n          },\n        );\n        if (controller.signal.aborted) return;\n        await client.refresh();\n        if (controller.signal.aborted) return;\n      }\n      const tasks = z\n        .array(platformTaskSchema)\n        .parse(\n          await applicationCall(\n            "tasks.list",\n            { owner: "agent", limit: 50 },\n            { signal: controller.signal, identityGeneration: identity },\n          ),\n        );\n      if (controller.signal.aborted) return;\n      const candidates = tasks.filter(\n        (task) => task.headVersion.runRequested > 0,\n      );\n      setMore(tasks.length >= 50 || candidates.length > 16);\n      const observations: Array<{ task: PlatformTask; runtime: TaskRuntime }> =\n        [];\n      // Bounded read-only inspection; do not fan out one request for every task.\n      for (\n        let offset = 0;\n        offset < Math.min(candidates.length, 16);\n        offset += 4\n      ) {\n        observations.push(\n          ...(await Promise.all(\n            candidates.slice(offset, offset + 4).map(async (task) => ({\n              task,\n              runtime: taskRuntimeSchema.parse(\n                await applicationCall("task.snapshot", task.id, {\n                  signal: controller.signal,\n                  identityGeneration: identity,\n                }),\n              ),\n            })),\n          )),\n        );\n      }\n      for (const { task, runtime } of observations) {\n        const readError =\n          runtime.error ||\n          runtime.runs.find((run) => run.run === task.headVersion.runRequested)\n            ?.error;\n        if (readError) throw new Error(`定时任务读取失败：${readError}`);\n      }\n      if (!controller.signal.aborted)\n        setRows(\n          observations.filter(({ task, runtime }) =>\n            liveArrangement(runtime, task.headVersion.runRequested),\n          ),\n        );\n    })()\n      .catch((e) => {\n        if (!controller.signal.aborted)\n          setError(e instanceof Error ? e.message : "定时任务暂时无法读取。");\n      })\n      .finally(() => {\n        if (!controller.signal.aborted) setLoading(false);\n      });\n    return () => controller.abort();\n  }, [identity, attempt, client.online, client.boot!.runtime.connected]);',
  ],
} as const;
export const scheduleTime = "2026-10-04T00:00:00Z";
export const scheduleSourceRecipes = {
  exactThread:
    "activity?.threads.find(\n          (thread) =>\n            thread.id === row.threadId &&\n            thread.inputId === row.inputId &&\n            thread.projectId === row.projectId &&\n            thread.conversationId === row.conversationId,\n        )",
  inspect:
    "{\n                projectId: row.projectId,\n                conversationId: row.conversationId,\n                artifactId: null,\n                inputId: row.inputId,\n                threadId: row.threadId,\n              }",
} as const;
export function scheduleTask(id: string, runRequested = 1): PlatformTask {
  return platformTaskSchema.parse({
    id,
    projectId: "project-A",
    title: "TEST " + id,
    description: "TEST task",
    assigneeId: "morphz-agent",
    execution: "planned",
    dueDate: null,
    orderRank: 0,
    revision: 1,
    updatedAt: scheduleTime,
    createdAt: scheduleTime,
    createdByPrincipalId: "human-A",
    createdByActantId: "human-A",
    headVersion: {
      taskId: id,
      revision: 1,
      projectId: "project-A",
      title: "TEST " + id,
      description: "TEST task",
      assigneeId: "morphz-agent",
      modelId: null,
      reasoningEffort: null,
      dueDate: null,
      assignment: "agent",
      execution: "planned",
      delivery: "none",
      runRequested,
      notBefore: null,
      everySeconds: null,
      authorPrincipalId: "human-A",
      authorActantId: "human-A",
      createdAt: scheduleTime,
      resultIds: [],
      dependsOnIds: [],
      watchSourceIds: [],
    },
  });
}
export function scheduleRuntime(
  id: string,
  run: Partial<TaskRuntime["runs"][number]> = {},
  value: Partial<TaskRuntime> = {},
): TaskRuntime {
  return taskRuntimeSchema.parse({
    error: "",
    runs: [
      {
        run: 1,
        artifactRevision: 1,
        record: {
          id: "schedule-" + id,
          revision: 1,
          thread_id: "thread-" + id,
          status: "queued",
          interval_seconds: null,
        },
        error: "",
        paused: false,
        sourceStopped: false,
        controlRevision: 1,
        hasSourceWatch: false,
        controlPending: null,
        stopRequested: false,
        threadState: null,
        ...run,
      },
    ],
    ...value,
  });
}
export function nativeSchedule(
  id: string,
  value: Partial<RuntimeSchedule> = {},
): RuntimeSchedule {
  return runtimeScheduleSchema.parse({
    scheduleId: id,
    threadId: "thread-" + id,
    sessionId: "session-A",
    contextId: "context-A",
    rootId: "root-" + id,
    inputId: "input-" + id,
    sourceTurnId: "source-" + id,
    sourceRootId: "source-" + id,
    projectId: "project-A",
    conversationId: "conversation-A",
    status: "queued",
    revision: 1,
    notBefore: null,
    intervalSeconds: null,
    dependencyThreadIds: [],
    intent: "TEST native " + id,
    updatedAt: scheduleTime,
    ...value,
  });
}
export function scheduleActivity(
  schedules: RuntimeSchedule[] = [],
  exact = true,
  overrides: Record<string, unknown> = {},
) {
  return activitySchema.parse({
    available: true,
    truncated: false,
    schedulesAvailable: true,
    schedulesTruncated: false,
    schedules,
    threads: exact
      ? schedules.map((row) => ({
          id: row.threadId,
          kind: "execution",
          projectId: row.projectId,
          conversationId: row.conversationId,
          inputId: row.inputId,
          rootId: row.rootId,
          sessionId: row.sessionId,
          title: row.intent,
          phase: "waiting",
          lifecycle: "open",
          revision: 1,
          updatedAt: scheduleTime,
        }))
      : [],
    ...overrides,
  });
}
