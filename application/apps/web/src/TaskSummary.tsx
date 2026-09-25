import Markdown from "react-markdown";
import {
  CircleCheck,
  CircleDashed,
  Clock3,
  UserRound,
  Cpu,
  CalendarDays,
  MessageCircle,
} from "lucide-react";
import type {
  Artifact,
  TaskContent,
  Workspace,
} from "../../../packages/core/src/model.js";
import { actorName } from "./client.js";
import type { WorkspaceClient } from "./client.js";
import { TaskArrangement } from "./TaskArrangement.js";
import { reasoningLabels } from "../../../packages/core/src/inference.js";

const executionLabel = {
  planned: "已计划",
  active: "进行中",
  waiting: "等待处理",
  completed: "已完成",
  cancelled: "已取消",
};
const assignmentLabel = {
  proposed: "待接受",
  accepted: "已接受",
  declined: "已拒绝",
};

/** Reading a task is not editing its database fields. */
export function TaskSummary({
  value,
  artifact,
  state,
  revision,
  onCompose,
  onOpen,
  client,
}: {
  value: TaskContent;
  artifact: Artifact;
  state: Workspace;
  revision: number;
  onCompose?: () => void;
  onOpen: (id: string) => void;
  client?: WorkspaceClient;
}) {
  const assignee = state.actants.find((a) => a.id === value.assigneeId);
  const StatusIcon =
    value.execution === "completed"
      ? CircleCheck
      : value.execution === "waiting"
        ? Clock3
        : CircleDashed;
  const results = state.artifacts.filter((a) => value.resultIds.includes(a.id));
  const relatedNames = (ids: string[]) =>
    ids
      .map(
        (id) => state.artifacts.find((a) => a.id === id)?.title ?? "不可用对象",
      )
      .join("、");
  return (
    <div className="task-summary">
      {client && artifact.content.kind === "task" ? (
        <TaskArrangement
          artifact={{ ...artifact, content: artifact.content }}
          state={state}
          client={client}
        />
      ) : (
        <dl className="task-properties" aria-label="事项属性">
          <div className="task-state" data-state={value.execution}>
            <dt className="sr-only">执行进度</dt>
            <dd>
              <StatusIcon size={15} />
              {value.assignment === "declined" &&
              !["completed", "cancelled"].includes(value.execution)
                ? "待重新安排"
                : value.execution === "planned" && assignee?.kind === "human"
                  ? "待处理"
                  : executionLabel[value.execution]}
            </dd>
          </div>
          <div>
            <dt>
              <UserRound size={14} />
              <span className="sr-only">负责人</span>
            </dt>
            <dd>{actorName(state, value.assigneeId)}</dd>
          </div>
          {value.dueDate && (
            <div>
              <dt>
                <CalendarDays size={14} />
                <span className="sr-only">截止日期</span>
              </dt>
              <dd>{value.dueDate}</dd>
            </div>
          )}
          {assignee?.kind === "agent" && (
            <div>
              <dt>
                <Cpu size={14} />
                <span className="sr-only">执行模型</span>
              </dt>
              <dd>
                {value.model || "自动选择模型"}
                {value.reasoningEffort
                  ? ` · 思考深度：${reasoningLabels[value.reasoningEffort]}`
                  : ""}
              </dd>
            </div>
          )}
        </dl>
      )}
      <div className="task-description" aria-label="事项说明">
        {value.description ? (
          <Markdown
            skipHtml
            components={{
              a: ({ children }) => <span>{children}</span>,
              img: ({ alt }) => <span>[图片：{alt}]</span>,
            }}
          >
            {value.description}
          </Markdown>
        ) : (
          <p className="muted">还没有补充说明。</p>
        )}
      </div>
      {onCompose && (
        <button
          className="task-compose-action secondary-action"
          aria-label="补充或调整"
          title="补充或调整这项工作"
          onClick={onCompose}
        >
          <MessageCircle aria-hidden="true" />
          补充
        </button>
      )}
      {results.length > 0 && (
        <section className="task-results" aria-label="事项成果">
          <h2>成果</h2>
          {results.map((a) => (
            <button key={a.id} onClick={() => onOpen(a.id)}>
              {a.title}
            </button>
          ))}
        </section>
      )}
      <details className="task-metadata">
        <summary>安排详情</summary>
        <dl>
          <div>
            <dt>执行进度</dt>
            <dd>{executionLabel[value.execution]}</dd>
          </div>
          <div>
            <dt>分派状态</dt>
            <dd>{assignmentLabel[value.assignment]}</dd>
          </div>
          <div>
            <dt>交付验收</dt>
            <dd>
              {
                { none: "尚未交付", ready: "待验收", accepted: "已验收" }[
                  value.delivery
                ]
              }
            </dd>
          </div>
          {value.notBefore && (
            <div>
              <dt>开始时间</dt>
              <dd>{new Date(value.notBefore).toLocaleString("zh-CN")}</dd>
            </div>
          )}
          {value.everySeconds !== null && (
            <div>
              <dt>重复安排</dt>
              <dd>每 {value.everySeconds / 60} 分钟</dd>
            </div>
          )}
          {value.dependsOnIds.length > 0 && (
            <div>
              <dt>依赖事项</dt>
              <dd>{relatedNames(value.dependsOnIds)}</dd>
            </div>
          )}
          {value.watchSourceIds.length > 0 && (
            <div>
              <dt>关注来源</dt>
              <dd>{relatedNames(value.watchSourceIds)}</dd>
            </div>
          )}
          <div>
            <dt>创建者</dt>
            <dd>{actorName(state, artifact.createdBy.actantId)}</dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{new Date(artifact.createdAt).toLocaleString("zh-CN")}</dd>
          </div>
          <div>
            <dt>当前查看</dt>
            <dd>v{revision}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}
