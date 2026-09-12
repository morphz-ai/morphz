import { lazy, Suspense, useEffect, useState, useRef } from "react";
import { SelectionActions } from "./SelectionActions.js";
import { ObjectRelations } from "./ObjectRelations.js";
import { createPortal } from "react-dom";
import { SafeMarkdown } from "./SafeMarkdown.js";
import { ModelPicker } from "./ModelPicker.js";
import {
  Check,
  Pencil,
  X,
  History,
  MessageSquarePlus,
  FileText,
  Image,
  CircleCheck,
  Globe,
  Table2,
  Volume2,
  Copy,
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
  onSelect: (
    quote: string,
    revision: number,
    page?: number,
    annotation?: boolean,
  ) => void;
  onNotice: (text: string) => void;
  initialRevision?: number | null;
  initialPage?: number | null;
  toolbarTarget: HTMLElement | null;
  onTaskInput: (result: boolean) => void;
  titleInToolbar?: boolean;
  autoOpenWebsite?: boolean;
}) {
  const { readLocal, writeLocal } = useState(() => scopedStorage())[0];
  const selectionRoot = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLElement>(null);
  const [pdfToolbarTarget, setPdfToolbarTarget] =
    useState<HTMLDivElement | null>(null);
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
    [error, setError] = useState("");
  const [reading, setReading] = useState<{
    text: string;
    revision: number;
    title: string;
  } | null>(null);
  const old =
    history && history < artifact.revision
      ? artifact.versions.find((v) => v.revision === history)
      : undefined;
  const shown = old ?? artifact;
  const isPdf = shown.content.kind === "pdf";
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
  useEffect(() => {
    if (!draft) return;
    const shortcut = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "s" &&
        !event.altKey &&
        !event.isComposing
      ) {
        // Do not intercept a dialog's own task or save a different editing surface.
        if (
          event.defaultPrevented ||
          !paper.current?.checkVisibility() ||
          document.querySelector("dialog[open]")
        )
          return;
        event.preventDefault();
        if (dirty && !saving && !conflict && draft.title.trim()) void save();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [draft, dirty, saving, conflict]);
  const editActions = draft && (
    <div className="editor-actions">
      <button
        disabled={saving}
        aria-label="取消编辑"
        title="取消编辑"
        onClick={() => {
          if (!dirty || window.confirm("放弃这份尚未保存的草稿？")) {
            update(null);
            setError("");
          }
        }}
      >
        <X />
        <span className="toolbar-action-label">取消编辑</span>
      </button>
      <button
        className="primary"
        aria-label={saving ? "保存中…" : "保存版本"}
        disabled={saving || !dirty || !draft.title.trim() || conflict}
        onClick={() => void save()}
        title="保存版本 · ⌘S / Ctrl+S"
      >
        <Check />
        <span className="toolbar-action-label">
          {saving ? "保存中…" : "保存版本"}
        </span>
      </button>
    </div>
  );
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
  const toolbar = (
    <div className="object-toolbar">
      {isPdf && <div className="pdf-toolbar-slot" ref={setPdfToolbarTarget} />}
      {artifact.content.kind !== "task" && !isPdf && (
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
              className="secondary-action"
              aria-label="朗读对象"
              title="朗读"
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
              <span className="toolbar-action-label">朗读</span>
            </button>
          )}
        {!draft && history === null && (
          <button
            className="secondary-action"
            onClick={() => setHistory(history ? null : artifact.revision)}
            aria-label="版本历史"
            title="版本历史"
            aria-expanded={history !== null}
          >
            <History />
            <span className="toolbar-action-label">版本</span>
          </button>
        )}
        {!draft && history !== null && (
          <div className="version-controls">
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
            <button
              className="icon-button"
              aria-label="回到当前版本"
              title="结束版本查看，回到当前版本"
              onClick={() => setHistory(null)}
            >
              <X />
            </button>
          </div>
        )}
        {editActions}
        {!draft &&
          artifact.source?.mode !== "linked" &&
          !(
            artifact.content.kind === "document" &&
            artifact.content.understanding
          ) && (
            <button
              className="secondary-action"
              onClick={start}
              aria-label={
                old
                  ? "编辑当前版本"
                  : artifact.content.kind === "task"
                    ? "手动编辑"
                    : "编辑"
              }
              title={
                old
                  ? "编辑当前版本"
                  : artifact.content.kind === "task"
                    ? "手动编辑"
                    : "编辑"
              }
            >
              <Pencil />
              <span className="toolbar-action-label">
                {old
                  ? "编辑当前版本"
                  : artifact.content.kind === "task"
                    ? "手动编辑"
                    : "编辑"}
              </span>
            </button>
          )}
        {artifact.source?.mode === "linked" && (
          <button
            className="secondary-action"
            aria-label="创建可编辑副本"
            title="创建可编辑副本"
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
            <Copy aria-hidden="true" />
            创建副本
          </button>
        )}
      </div>
    </div>
  );
  return (
    <>
      {toolbarTarget && createPortal(toolbar, toolbarTarget)}
      {!toolbarTarget && toolbar}
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
        ref={paper}
        className={
          "object-paper " +
          (artifact.content.kind === "image"
            ? "image-paper"
            : artifact.content.kind === "task"
              ? "task-paper"
              : artifact.content.kind === "interactive"
                ? "interactive-paper"
                : isPdf
                  ? "pdf-paper"
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
        ) : !titleInToolbar || (old && !isPdf) ? (
          <h1>{shown.title}</h1>
        ) : null}
        {shown.content.kind !== "task" && !isPdf && (
          <div className="byline">
            {actorName(state, artifact.createdBy.actantId)}
            <span>·</span>
            <time>{new Date(shown.createdAt).toLocaleDateString("zh-CN")}</time>
          </div>
        )}
        {artifact.source && !isPdf && (
          <details className="source-strip">
            <summary>
              {artifact.source.mode === "linked"
                ? "外部资料 · 只读"
                : "导入副本"}
              {" · "}
              {artifact.source.relativePath}
              {artifact.source.connection?.status === "paused" &&
                " · 同步已暂停"}
              {artifact.source.connection?.status === "unavailable" &&
                " · 来源暂不可用，保留上次版本"}
            </summary>
            <small>
              {artifact.source.mode === "linked"
                ? `最近确认 ${artifact.source.connection ? new Date(artifact.source.connection.checkedAt).toLocaleString("zh-CN") : "未知"}；原文件只读。`
                : `原始内容保存在 v${artifact.source.importedRevision} · 不自动同步原文件`}
            </small>
          </details>
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
            <div className="document-body" ref={selectionRoot}>
              <SafeMarkdown
                state={state}
                onOpen={onOpen}
                documentTitle={shown.title}
              >
                {shown.content.markdown || "尚未填写正文。"}
              </SafeMarkdown>
            </div>
            <SelectionActions
              root={selectionRoot}
              onAction={(action, text) => {
                if (action === "read")
                  setReading({
                    text,
                    revision: shown.revision,
                    title: shown.title,
                  });
                else
                  onSelect(
                    text,
                    shown.revision,
                    undefined,
                    action === "annotate",
                  );
              }}
            />
            <button
              className="annotation-action secondary-action"
              aria-label="围绕选中文本输入"
              title="引用选区"
              onClick={select}
            >
              <MessageSquarePlus />
              选区提问
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
              toolbarTarget={pdfToolbarTarget}
              initialPage={initialPage}
              onSelect={(quote, page, annotation) =>
                onSelect(quote, shown.revision, page, annotation)
              }
              onRead={(text) =>
                setReading({
                  text,
                  title: shown.title,
                  revision: shown.revision,
                })
              }
            />
          </Suspense>
        )}
        {isPdf && (
          <details className="pdf-file-info">
            <summary>
              文件信息{old ? ` · 正在查看历史版本 v${shown.revision}` : ""}
            </summary>
            <p>
              {shown.title} · v{shown.revision}
            </p>
            <p>
              {actorName(state, artifact.createdBy.actantId)} ·{" "}
              {new Date(shown.createdAt).toLocaleDateString("zh-CN")}
            </p>
            {artifact.source && (
              <p>
                {artifact.source.mode === "linked"
                  ? "外部资料 · 原文件只读"
                  : "导入副本"}
                {" · "}
                {artifact.source.relativePath}
                {artifact.source.connection?.status === "paused" &&
                  " · 同步已暂停"}
                {artifact.source.connection?.status === "unavailable" &&
                  " · 来源暂不可用，保留上次版本"}
                {artifact.source.mode === "linked"
                  ? ` · 最近确认 ${artifact.source.connection ? new Date(artifact.source.connection.checkedAt).toLocaleString("zh-CN") : "未知"}`
                  : ` · 原始内容保存在 v${artifact.source.importedRevision}，不自动同步原文件`}
              </p>
            )}
          </details>
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
      </article>
      {shown.content.kind === "document" && shown.content.understanding && (
        <section className="understanding-sources">
          <p className="muted">
            摘要版本 v{shown.content.understanding.frameRevision}
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
      <ObjectRelations
        artifact={artifact}
        state={state}
        client={client}
        onOpen={onOpen}
      />
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
    </div>
  );
}
