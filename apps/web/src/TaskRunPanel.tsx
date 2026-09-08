import { useEffect, useState } from "react";
import { z } from "zod";
import type { Artifact, Workspace } from "../../../packages/core/src/model.js";
import type { WorkspaceClient } from "./client.js";
const schema = z.object({
  error: z.string().default(""),
  runs: z.array(
    z.object({
      run: z.number(),
      artifactRevision: z.number(),
      record: z
        .object({
          revision: z.number(),
          status: z.enum([
            "queued",
            "paused",
            "dispatched",
            "completed",
            "cancelled",
          ]),
          interval_seconds: z.number().nullable(),
        })
        .nullable(),
      error: z.string(),
      paused: z.boolean(),
      sourceStopped: z.boolean().default(false),
      controlRevision: z.number().int().positive(),
      hasSourceWatch: z.boolean(),
      controlPending: z.string().nullable().default(null),
      threadState: z
        .enum(["open", "completed", "failed", "cancelled"])
        .nullable(),
    }),
  ),
});
export function TaskRunPanel({
  artifact,
  state,
  client,
}: {
  artifact: Artifact;
  state: Workspace;
  client: WorkspaceClient;
}) {
  const [view, setView] = useState<z.infer<typeof schema>>({
      error: "",
      runs: [],
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [response, setResponse] = useState("");
  const task = artifact.content;
  useEffect(() => {
    let mounted = true;
    const refresh = () =>
      client
        .taskRuntime(artifact.id)
        .then((v) => {
          if (mounted) setView(schema.parse(v));
        })
        .catch(() => {
          if (mounted) setError("暂时无法核对执行状态。");
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [artifact.id, client.taskRuntime]);
  if (task.kind !== "task") return null;
  const human =
      state.actants.find((a) => a.id === task.assigneeId)?.kind === "human",
    run = view.runs.at(-1),
    record = run?.record;
  const active =
    record &&
    !["completed", "cancelled"].includes(record.status) &&
    (record.interval_seconds !== null ||
      run.threadState === "open" ||
      (run.hasSourceWatch && !run.sourceStopped));
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setView(schema.parse(await client.taskRuntime(artifact.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作未确认。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="task-run-panel" aria-label="实际执行与回应">
      <div className="section-heading">
        <h2>{human ? "回应这件事项" : "实际执行"}</h2>
        <small>
          {human ? "由当前负责人提交" : "安排由 Morphz Runtime 执行"}
        </small>
      </div>
      {human ? (
        <>
          {state.taskResponses
            .filter((r) => r.taskId === artifact.id)
            .map((r) => (
              <blockquote key={r.id}>
                <p>{r.body}</p>
                <small>
                  {state.actants.find((a) => a.id === r.author.actantId)?.name}{" "}
                  · 回应 v{r.taskRevision}
                </small>
              </blockquote>
            ))}
          {client.boot?.actantId === task.assigneeId &&
            !["completed", "cancelled"].includes(task.execution) && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void perform(async () => {
                    await client.execute({
                      type: "respond-task",
                      taskId: artifact.id,
                      expectedRevision: artifact.revision,
                      body: response,
                    });
                    setResponse("");
                  });
                }}
              >
                <textarea
                  aria-label="事项回应"
                  placeholder="补充结果、判断或需要 Agent 接续的信息…"
                  value={response}
                  onChange={(e) => setResponse(e.target.value)}
                  maxLength={30000}
                />
                <button className="primary" disabled={busy || !response.trim()}>
                  提交回应并继续协作
                </button>
              </form>
            )}
        </>
      ) : (
        <>
          <p role="status">
            {record
              ? `第 ${run.run} 次安排 · ${run.controlPending ? "控制请求等待确认" : run.sourceStopped ? "后续触发已停止" : run.paused ? "后续触发已暂停" : record.status === "queued" ? "等待 Runtime 调度" : record.status === "paused" ? "后续触发已暂停" : record.status === "cancelled" ? "后续触发已停止" : run.threadState === "failed" ? "执行失败" : run.threadState === "completed" ? "本次处理已结束" : run.threadState === "cancelled" ? "本次处理已停止" : "正在处理"} · 使用安排版本 v${run.artifactRevision}`
              : task.runRequested
                ? "安排已保存，等待 Runtime 确认"
                : "尚未提交执行安排"}
          </p>
          <div className="task-run-actions">
            <button
              className="primary"
              disabled={busy || !!active}
              onClick={() =>
                void perform(() =>
                  client.execute({
                    type: "request-task-run",
                    taskId: artifact.id,
                    expectedRevision: artifact.revision,
                  }),
                )
              }
            >
              {run ? "按当前安排重新执行" : "开始执行"}
            </button>
            {record &&
              !run.sourceStopped &&
              (["queued", "paused"].includes(record.status) ||
                run.hasSourceWatch) && (
                <>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(() =>
                        client.taskRuntime(artifact.id, {
                          run: run.run,
                          revision: run.controlRevision,
                          action: run.paused ? "resume" : "pause",
                        }),
                      )
                    }
                  >
                    {run.paused ? "恢复后续触发" : "暂停后续触发"}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(() =>
                        client.taskRuntime(artifact.id, {
                          run: run.run,
                          revision: run.controlRevision,
                          action: "cancel",
                        }),
                      )
                    }
                  >
                    停止后续触发
                  </button>
                </>
              )}
          </div>
          <p className="muted">
            修改负责人、模型或时间会保存为新安排版本；已提交的执行仍使用原版本。暂停和停止触发不会撤销已经发生的操作。
          </p>
        </>
      )}
      {(error || view.error || run?.error) && (
        <p className="delivery-error" role="alert">
          {error || view.error || run?.error}
        </p>
      )}
    </section>
  );
}
