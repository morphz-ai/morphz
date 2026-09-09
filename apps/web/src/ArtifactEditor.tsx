import { lazy, Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SafeMarkdown } from "./SafeMarkdown.js";
import { ModelPicker } from "./ModelPicker.js";
import {
  Check,
  Pencil,
  X,
  History,
  MessageSquarePlus,
  Link2,
  FileText,
  Image,
  CircleCheck,
  Globe,
  Table2,
  Volume2,
} from "lucide-react";
import {
  contentSchema,
  type Artifact,
  type Content,
  type Workspace,
  type TaskContent,
} from "../../../packages/core/src/model.js";
import {
  actorName,
  scopedStorage,
  draftKey,
  type WorkspaceClient,
} from "./client.js";
const PdfReader = lazy(() => import("./PdfReader.js"));
import { TaskRunPanel } from "./TaskRunPanel.js";
import { TaskSummary } from "./TaskSummary.js";
import { BrowserHost } from "./BrowserHost.js";
import { InteractiveArtifact } from "./InteractiveArtifact.js";
import { interactiveDraftSchema } from "../../../packages/core/src/interactive.js";
import { ReadAloudDialog } from "./SpeechDialog.js";
import { contentText } from "../../../packages/core/src/retrieval.js";

export const kindLabel = {
  document: "文档",
  image: "图片",
  task: "事项",
  pdf: "PDF",
  website: "网站",
  interactive: "表格与报告",
};
export function ObjectIcon({ kind }: { kind: Content["kind"] }) {
  const Icon = {
    document: FileText,
    image: Image,
    task: CircleCheck,
    pdf: FileText,
    website: Globe,
    interactive: Table2,
  }[kind];
  return <Icon size={16} />;
}
type Draft = { title: string; content: Content; baseRevision: number };
export function ArtifactEditor({
  artifact,
  state,
  client,
  onOpen,
  onSelect,
  onNotice,
  initialRevision,
  initialPage,
  toolbarTarget,
  onTaskInput,
  titleInToolbar = false,
  autoOpenWebsite = false,
}: {
  artifact: Artifact;
  state: Workspace;
  client: WorkspaceClient;
  onOpen: (id: string, revision?: number) => void;
  onSelect: (quote: string, revision: number, page?: number) => void;
  onNotice: (text: string) => void;
  initialRevision?: number | null;
  initialPage?: number | null;
  toolbarTarget: HTMLElement | null;
  onTaskInput: (result: boolean) => void;
  titleInToolbar?: boolean;
  autoOpenWebsite?: boolean;
}) {
  const { readLocal, writeLocal } = useState(() => scopedStorage())[0];
  const key = draftKey("edit:" + artifact.id);
  const [draft, setDraft] = useState<Draft | null>(() => {
    const cached = readLocal<Draft | null>(key, null);
    return cached &&
      typeof cached.title === "string" &&
      Number.isInteger(cached.baseRevision) &&
      (contentSchema.safeParse(cached.content).success ||
        interactiveDraftSchema.safeParse(cached.content).success)
      ? cached
      : null;
  });
  const [saving, setSaving] = useState(false),
    [history, setHistory] = useState<number | null>(initialRevision ?? null),
    [error, setError] = useState(""),
    [link, setLink] = useState("");
  const [reading, setReading] = useState<{
    text: string;
    revision: number;
    title: string;
  } | null>(null);
  const old = history
    ? artifact.versions.find((v) => v.revision === history)
    : undefined;
  const shown = old ?? artifact;
  const dirty =
    !!draft &&
    (draft.title !== artifact.title ||
      JSON.stringify(draft.content) !== JSON.stringify(artifact.content));
  const conflict = !!draft && draft.baseRevision !== artifact.revision;
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  function update(value: Draft | null) {
    setDraft(value);
    try {
      writeLocal(key, value);
    } catch {
      onNotice("无法保存本地草稿，请不要刷新页面。");
    }
  }
  function start() {
    setHistory(null);
    update({
      title: artifact.title,
      content: structuredClone(artifact.content),
      baseRevision: artifact.revision,
    });
  }
  function content(value: Content) {
    if (draft) update({ ...draft, content: value });
  }
  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    setError("");
    try {
      await client.execute({
        type: "revise-artifact",
        artifactId: artifact.id,
        expectedRevision: draft.baseRevision,
        title: draft.title,
        content: draft.content,
      });
      update(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  }
  function select() {
    const quote = window.getSelection()?.toString().trim() ?? "";
    if (
      shown.content.kind === "document" &&
      quote &&
      shown.content.markdown.includes(quote)
    )
      onSelect(quote, shown.revision);
    else onNotice("请先选中正文中的一段文字。");
  }
  const related = state.relations
    .filter((r) => r.fromId === artifact.id || r.toId === artifact.id)
    .map((r) => ({
      relation: r,
      object: state.artifacts.find(
        (a) => a.id === (r.fromId === artifact.id ? r.toId : r.fromId),
      )!,
    }));
  const toolbar = (
    <div className="object-toolbar">
      {artifact.content.kind !== "task" && (
        <span>
          {kindLabel[artifact.content.kind]}{" "}
          <span className="muted">
            · v{shown.revision}
            {draft ? " · 编辑中" : ""}
            {old ? " · 历史版本" : ""}
          </span>
        </span>
      )}
      <div className="inline">
        {!draft &&
          shown.content.kind !== "task" &&
          shown.content.kind !== "website" &&
          shown.content.kind !== "image" && (
            <button
              aria-label="朗读对象"
              onClick={() => {
                const full = contentText(shown.content),
                  selected = window.getSelection()?.toString().trim() ?? "";
                setReading({
                  text: selected && full.includes(selected) ? selected : full,
                  revision: shown.revision,
                  title: shown.title,
                });
              }}
            >
              <Volume2 />
              朗读
            </button>
          )}
        <button
          onClick={() => setHistory(history ? null : artifact.revision)}
          aria-label="版本历史"
        >
          <History />
          版本
        </button>
        {!draft &&
          artifact.source?.mode !== "linked" &&
          !(
            artifact.content.kind === "document" &&
            artifact.content.understanding
          ) && (
            <button onClick={start}>
              <Pencil />
              {artifact.content.kind === "task" ? "手动编辑" : "编辑"}
            </button>
          )}
        {artifact.source?.mode === "linked" && (
          <button
            onClick={async () => {
              try {
                const receipt = await client.execute({
                  type: "create-artifact",
                  projectId: artifact.projectId,
                  title: shown.title.slice(0, 174) + "（副本）",
                  content: shown.content,
                });
                onOpen(receipt.entityId);
              } catch (e) {
                onNotice(e instanceof Error ? e.message : "创建副本失败。");
              }
            }}
          >
            创建可编辑副本
          </button>
        )}
      </div>
    </div>
  );
  return (
    <>
      {toolbarTarget && createPortal(toolbar, toolbarTarget)}
      {reading && (
        <ReadAloudDialog
          client={client}
          scope={{
            projectId: artifact.projectId,
            artifactId: artifact.id,
            revision: reading.revision,
          }}
          title={reading.title}
          source={reading.text}
          onClose={() => setReading(null)}
        />
      )}
      {artifact.source && (
        <div className="source-strip">
          <FileText />
          <span>
            {artifact.source.mode === "linked" ? "外部资料 · 只读" : "导入副本"}{" "}
            · {artifact.source.relativePath}
          </span>
          <small>
            {artifact.source.mode === "linked"
              ? `${artifact.source.connection?.status === "paused" ? "同步已暂停" : artifact.source.connection?.status === "unavailable" ? "来源暂不可用，保留上次版本" : "已同步"} · 最近确认 ${artifact.source.connection ? new Date(artifact.source.connection.checkedAt).toLocaleString("zh-CN") : "未知"}`
              : `原始内容保存在 v${artifact.source.importedRevision} · 不自动同步原文件`}
          </small>
        </div>
      )}
      {history !== null && (
        <div className="history-strip">
          <label>
            查看版本
            <select
              aria-label="查看版本"
              value={history}
              onChange={(e) => setHistory(Number(e.target.value))}
            >
              {[...artifact.versions].reverse().map((v) => (
                <option key={v.revision} value={v.revision}>
                  v{v.revision} · {actorName(state, v.author.actantId)}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => setHistory(null)}>回到当前版本</button>
        </div>
      )}
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      {conflict && (
        <div className="conflict-banner" role="alert">
          <p>
            中心已有 v{artifact.revision}。下方保留的是基于 v
            {draft.baseRevision} 的草稿，不会自动覆盖新版本。
          </p>
          <details>
            <summary>对照中心最新内容</summary>
            <pre>
              {artifact.title +
                "\n\n" +
                (artifact.content.kind === "document"
                  ? artifact.content.markdown
                  : JSON.stringify(artifact.content, null, 2))}
            </pre>
          </details>
          <button
            onClick={() => {
              if (
                window.confirm(
                  "已对照最新内容，确定以当前草稿保存为下一个版本？",
                )
              ) {
                update({ ...draft, baseRevision: artifact.revision });
                setError("");
              }
            }}
          >
            已对照，继续使用这份草稿
          </button>
        </div>
      )}
      <article
        className={
          "object-paper " +
          (artifact.content.kind === "image"
            ? "image-paper"
            : artifact.content.kind === "task"
              ? "task-paper"
              : "")
        }
      >
        <div className="eyebrow">
          <ObjectIcon kind={artifact.content.kind} />
          {state.projects.find((p) => p.id === artifact.projectId)?.title}
        </div>
        {draft ? (
          <label className="field">
            标题
            <input
              aria-label="对象标题"
              value={draft.title}
              maxLength={180}
              onChange={(e) => update({ ...draft, title: e.target.value })}
            />
          </label>
        ) : !titleInToolbar || old ? (
          <h1>{shown.title}</h1>
        ) : null}
        {shown.content.kind !== "task" && (
          <div className="byline">
            <span className="avatar">
              {actorName(state, artifact.createdBy.actantId).slice(0, 1)}
            </span>
            {actorName(state, artifact.createdBy.actantId)}
            <span>·</span>
            <time>{new Date(shown.createdAt).toLocaleDateString("zh-CN")}</time>
            <span>· v{shown.revision}</span>
          </div>
        )}
        {draft?.content.kind === "document" ? (
          <label className="field">
            正文 · Markdown
            <textarea
              className="document-editor"
              aria-label="文档正文"
              value={draft.content.markdown}
              onChange={(e) =>
                content({ kind: "document", markdown: e.target.value })
              }
            />
          </label>
        ) : shown.content.kind === "document" ? (
          <>
            <div className="document-body">
              <SafeMarkdown state={state} onOpen={onOpen}>
                {shown.content.markdown || "尚未填写正文。"}
              </SafeMarkdown>
            </div>
            <button className="annotation-action" onClick={select}>
              <MessageSquarePlus />
              围绕选中文本输入
            </button>
          </>
        ) : null}
        {shown.content.kind === "image" && (
          <>
            <img
              className="artifact-image"
              src={"/api/assets/" + shown.content.assetId}
              alt={shown.content.alt || shown.title}
            />
            {draft?.content.kind === "image" && (
              <label className="field">
                图片描述
                <textarea
                  aria-label="图片描述"
                  value={draft.content.alt}
                  onChange={(e) =>
                    content({
                      ...(draft.content as Extract<Content, { kind: "image" }>),
                      alt: e.target.value,
                    })
                  }
                />
              </label>
            )}
          </>
        )}
        {shown.content.kind === "interactive" && (
          <InteractiveArtifact
            key={`${artifact.id}:${shown.revision}:${!!draft}`}
            value={
              draft?.content.kind === "interactive"
                ? draft.content
                : shown.content
            }
            onChange={draft ? content : undefined}
          />
        )}
        {shown.content.kind === "website" &&
          (draft?.content.kind === "website" ? (
            <>
              <label className="field">
                网站地址
                <input
                  aria-label="编辑网站地址"
                  value={draft.content.url}
                  onChange={(e) =>
                    content({
                      ...(draft.content as Extract<
                        Content,
                        { kind: "website" }
                      >),
                      url: e.target.value,
                    })
                  }
                />
              </label>
              <label className="field">
                说明
                <textarea
                  value={draft.content.description}
                  onChange={(e) =>
                    content({
                      ...(draft.content as Extract<
                        Content,
                        { kind: "website" }
                      >),
                      description: e.target.value,
                    })
                  }
                />
              </label>
            </>
          ) : old ? (
            <p>历史网站地址：{shown.content.url}。打开当前版本后可访问网页。</p>
          ) : (
            <BrowserHost
              key={artifact.id}
              artifact={artifact}
              autoOpen={autoOpenWebsite}
            />
          ))}
        {shown.content.kind === "pdf" && (
          <Suspense fallback={<p role="status">正在准备 PDF 阅读器…</p>}>
            <PdfReader
              key={shown.content.assetId}
              content={shown.content}
              initialPage={initialPage}
              onSelect={(quote, page) => onSelect(quote, shown.revision, page)}
            />
          </Suspense>
        )}
        {draft?.content.kind === "task" ? (
          <TaskFields
            value={draft.content}
            editable
            state={state}
            projectId={artifact.projectId}
            onChange={content}
          />
        ) : shown.content.kind === "task" ? (
          <TaskSummary
            value={shown.content}
            artifact={artifact}
            state={state}
            revision={shown.revision}
            onCompose={!old ? () => onTaskInput(false) : undefined}
            onOpen={onOpen}
          />
        ) : null}
        {artifact.content.kind === "task" && !draft && !old && (
          <TaskRunPanel
            artifact={artifact}
            state={state}
            client={client}
            onRespond={() => onTaskInput(true)}
          />
        )}
        {draft && (
          <div className="editor-actions">
            <button
              className="primary"
              disabled={saving || !draft.title.trim() || conflict}
              onClick={() => void save()}
            >
              <Check />
              {saving ? "保存中…" : "保存版本"}
            </button>
            <button
              onClick={() => {
                if (!dirty || window.confirm("放弃这份尚未保存的草稿？")) {
                  update(null);
                  setError("");
                }
              }}
            >
              <X />
              取消编辑
            </button>
          </div>
        )}
      </article>
      {shown.content.kind === "document" && shown.content.understanding && (
        <section className="understanding-sources">
          <p className="muted">
            公开认知帧 v{shown.content.understanding.frameRevision} ·
            如需纠正，请打开顶部“当前理解”。
          </p>
          {shown.content.understanding.sources.map((ref) => (
            <button
              key={ref.artifactId + ref.revision}
              onClick={() => onOpen(ref.artifactId, ref.revision)}
            >
              {state.artifacts.find((a) => a.id === ref.artifactId)?.title} · v
              {ref.revision}
            </button>
          ))}
        </section>
      )}
      {artifact.content.kind === "task" ? (
        related.length > 0 && (
          <section className="relations task-relations" aria-label="关联对象">
            <div className="section-label">
              <Link2 />
              关联对象
            </div>
            <div className="relation-list">
              {related.map(({ relation, object }) => (
                <button key={relation.id} onClick={() => onOpen(object.id)}>
                  <ObjectIcon kind={object.content.kind} />
                  {object.title}
                </button>
              ))}
            </div>
          </section>
        )
      ) : (
        <section className="relations">
          <div className="section-label">
            <Link2 />
            关联对象
          </div>
          <div className="relation-list">
            {related.map(({ relation, object }) => (
              <button key={relation.id} onClick={() => onOpen(object.id)}>
                <ObjectIcon kind={object.content.kind} />
                {object.title}
              </button>
            ))}
          </div>
          <form
            className="relation-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!link) return;
              void client
                .execute({
                  type: "link-artifacts",
                  fromId: artifact.id,
                  toId: link,
                  relation: "references",
                })
                .then(() => {
                  setLink("");
                })
                .catch((e) => setError(e.message));
            }}
          >
            <select
              aria-label="要关联的对象"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            >
              <option value="">选择同项目的对象…</option>
              {state.artifacts
                .filter(
                  (a) =>
                    a.projectId === artifact.projectId && a.id !== artifact.id,
                )
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
            </select>
            <button disabled={!link}>添加关联</button>
          </form>
        </section>
      )}
    </>
  );
}
export function TaskFields({
  value,
  editable,
  state,
  projectId,
  onChange,
}: {
  value: TaskContent;
  editable: boolean;
  state: Workspace;
  projectId: string;
  onChange: (c: TaskContent) => void;
}) {
  const assignee = state.actants.find((a) => a.id === value.assigneeId),
    members = state.projects.find((p) => p.id === projectId)?.members ?? [];
  return (
    <div className="task-fields">
      <label className="field wide">
        工作要求
        <textarea
          aria-label="工作要求"
          value={value.description}
          readOnly={!editable}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
        />
      </label>
      <label className="field">
        负责人
        <select
          aria-label="事项负责人"
          disabled={!editable}
          value={value.assigneeId}
          onChange={(e) =>
            onChange({
              ...value,
              assigneeId: e.target.value,
              model: null,
              assignment: "proposed",
              runRequested: 0,
              everySeconds: null,
            })
          }
        >
          {state.actants
            .filter((a) => members.includes(a.principalId))
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.kind === "human" ? "人" : "Agent"}
              </option>
            ))}
        </select>
      </label>
      {assignee?.kind === "agent" && (
        <ModelPicker
          label="执行模型"
          value={value.model ?? ""}
          disabled={!editable}
          onChange={(model) => onChange({ ...value, model: model || null })}
        />
      )}
      <label className="field">
        优先级
        <select
          aria-label="优先级"
          disabled={!editable}
          value={value.priority}
          onChange={(e) =>
            onChange({
              ...value,
              priority: e.target.value as TaskContent["priority"],
            })
          }
        >
          <option value="low">低</option>
          <option value="normal">普通</option>
          <option value="high">高</option>
        </select>
      </label>
      <label className="field">
        截止日期
        <input
          type="date"
          aria-label="截止日期"
          disabled={!editable}
          value={value.dueDate ?? ""}
          onChange={(e) =>
            onChange({ ...value, dueDate: e.target.value || null })
          }
        />
      </label>
      <label className="field">
        分派状态
        <select
          aria-label="分派状态"
          disabled={!editable}
          value={value.assignment}
          onChange={(e) =>
            onChange({
              ...value,
              assignment: e.target.value as TaskContent["assignment"],
            })
          }
        >
          <option value="proposed">待接受</option>
          <option value="accepted">已接受</option>
          <option value="declined">已拒绝</option>
        </select>
      </label>
      <label className="field">
        执行进度
        <select
          aria-label="执行进度"
          disabled={!editable}
          value={value.execution}
          onChange={(e) =>
            onChange({
              ...value,
              execution: e.target.value as TaskContent["execution"],
            })
          }
        >
          <option value="planned">已计划</option>
          <option value="active">进行中</option>
          <option value="waiting">等待</option>
          <option value="completed">已完成</option>
          <option value="cancelled">已取消</option>
        </select>
      </label>
      {assignee?.kind === "agent" && (
        <>
          <label className="field">
            开始时间
            <input
              type="datetime-local"
              aria-label="开始时间"
              disabled={!editable}
              value={
                value.notBefore
                  ? new Date(
                      new Date(value.notBefore).getTime() -
                        new Date(value.notBefore).getTimezoneOffset() * 60000,
                    )
                      .toISOString()
                      .slice(0, 16)
                  : ""
              }
              onChange={(e) =>
                onChange({
                  ...value,
                  notBefore: e.target.value
                    ? new Date(e.target.value).toISOString()
                    : null,
                })
              }
            />
          </label>
          <label className="field">
            持续关注间隔（分钟）
            <input
              type="number"
              min="1"
              max="525600"
              aria-label="持续关注间隔"
              disabled={!editable}
              placeholder="留空为单次工作"
              value={value.everySeconds === null ? "" : value.everySeconds / 60}
              onChange={(e) =>
                onChange({
                  ...value,
                  everySeconds: e.target.value
                    ? Math.max(60, Math.round(Number(e.target.value) * 60))
                    : null,
                })
              }
            />
          </label>
          <label className="field">
            依赖事项
            <select
              multiple
              aria-label="依赖事项"
              disabled={!editable}
              value={value.dependsOnIds}
              onChange={(e) =>
                onChange({
                  ...value,
                  dependsOnIds: Array.from(
                    e.target.selectedOptions,
                    (x) => x.value,
                  ),
                })
              }
            >
              {state.artifacts
                .filter(
                  (a) => a.projectId === projectId && a.content.kind === "task",
                )
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            关注来源变化
            <select
              multiple
              aria-label="关注来源变化"
              disabled={!editable}
              value={value.watchSourceIds}
              onChange={(e) =>
                onChange({
                  ...value,
                  watchSourceIds: Array.from(
                    e.target.selectedOptions,
                    (x) => x.value,
                  ),
                })
              }
            >
              {state.artifacts
                .filter(
                  (a) => a.projectId === projectId && a.content.kind !== "task",
                )
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
            </select>
          </label>
        </>
      )}
      <p className="muted wide">
        这里保存工作安排与进度记录；下方“实际执行”显示 Runtime
        的确认结果。交付验收不等同于执行状态。
      </p>
    </div>
  );
}
