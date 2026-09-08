import { useModal } from "./useModal.js";
import { useRef, useState } from "react";
import { X, BookOpen, RefreshCw } from "lucide-react";
import Markdown from "react-markdown";
import type { WorkspaceClient } from "./client.js";
export function UnderstandingDialog({
  client,
  projectId,
  onOpen,
  onClose,
}: {
  client: WorkspaceClient;
  projectId: string;
  onOpen: (id: string, revision?: number) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [body, setBody] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  useModal(dialog);
  const state = client.boot!.workspace,
    project = state.projects.find((p) => p.id === projectId)!;
  const artifact = state.artifacts.find(
    (a) =>
      a.projectId === projectId &&
      a.content.kind === "document" &&
      a.content.understanding,
  );
  const content =
    artifact?.content.kind === "document" ? artifact.content : null;
  async function request() {
    setBusy(true);
    setNotice("");
    try {
      await client.execute(
        {
          type: "record-input",
          projectId,
          artifactId: artifact?.id ?? null,
          artifactRevision: artifact?.revision ?? null,
          selection: "",
          targetActantId: "morphz-agent",
          body: `请${artifact ? "更新" : "整理"}这个项目的公开“当前理解”，只包括工作目标、约束、关键事实和可公开来源，不包括内部推理过程。使用 context_tx 自主维护 mw-public-${projectId} 认知帧，正文为 (public-summary "面向用户的 Markdown 摘要")，再用 host_morphz_work 的 publish-understanding 发布实际提交版本${artifact ? `，修订对象 ${artifact.id} 的当前版本` : ""}。\n${body.trim() ? `我的纠正或补充：${body.trim()}` : "请结合本项目现有内容和最新进度整理。"}`,
        },
        !!client.boot?.runtime.configured,
      );
      setBody("");
      setNotice(
        client.boot?.runtime.configured
          ? "请求已保存并排队发送；Agent 提交上下文事务并发布后，这里会更新。"
          : "请求已保存。连接 Runtime 后才能发送和更新。",
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "请求失败，内容仍保留。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="create-dialog library-dialog understanding-dialog"
      aria-label="项目当前理解"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <h2>当前理解</h2>
          <small>{project.title}</small>
        </div>
        <button aria-label="关闭当前理解" onClick={onClose}>
          <X />
        </button>
      </header>
      {content?.understanding ? (
        <>
          <div className="understanding-meta">
            上次发布：{new Date(artifact!.updatedAt).toLocaleString("zh-CN")} ·
            认知帧 v{content.understanding.frameRevision}
          </div>
          <article className="document-content">
            <Markdown
              skipHtml
              components={{
                a: ({ children }) => <span>{children}</span>,
                img: ({ alt }) => <span>{alt}</span>,
              }}
            >
              {content.markdown}
            </Markdown>
          </article>
          <div className="understanding-sources">
            {content.understanding.sources.map((ref) => (
              <button
                key={ref.artifactId + ref.revision}
                onClick={() => {
                  onOpen(ref.artifactId, ref.revision);
                  onClose();
                }}
              >
                <BookOpen size={14} />
                {state.artifacts.find((a) => a.id === ref.artifactId)?.title} ·
                v{ref.revision}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="understanding-empty">
          Agent
          尚未发布这个项目的当前理解。你可以让它先整理工作目标、约束和已经明确的事实。
        </p>
      )}
      <p className="muted">
        这是可共同核对的公开摘要，不是完整的内部上下文。纠正由 Agent
        通过上下文事务处理。
      </p>
      <label className="field">
        纠正或补充
        <textarea
          aria-label="纠正当前理解"
          placeholder="哪里需要修正，或有哪些新约束？"
          value={body}
          maxLength={20000}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <p role="status">{notice}</p>
      <footer>
        <button onClick={onClose}>关闭</button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void request()}
        >
          <RefreshCw size={14} />
          {busy
            ? "正在保存…"
            : body.trim()
              ? "提交纠正"
              : artifact
                ? "请 Agent 更新"
                : "请 Agent 梳理"}
        </button>
      </footer>
    </dialog>
  );
}
