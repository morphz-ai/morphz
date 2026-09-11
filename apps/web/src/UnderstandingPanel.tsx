import { BookOpen, RefreshCw, MessageSquarePlus } from "lucide-react";
import type { WorkspaceClient } from "./client.js";
import { SafeMarkdown } from "./SafeMarkdown.js";
import { InspectorPanel } from "./InspectorPanel.js";
import type { InspectorLayout } from "./inspector-layout.js";

/** Public, committed understanding; inspecting it never submits an input. */
export function UnderstandingPanel({
  client,
  projectId,
  onOpen,
  onCompose,
  onClose,
  layout,
  onResize,
}: {
  client: WorkspaceClient;
  projectId: string;
  onOpen: (id: string, revision?: number) => void;
  onCompose: (body: string) => void;
  onClose: () => void;
  layout: InspectorLayout;
  onResize: (width: number) => void;
}) {
  const state = client.boot!.workspace;
  const project = state.projects.find((p) => p.id === projectId);
  const artifact = state.artifacts.find(
    (a) =>
      a.projectId === projectId &&
      a.content.kind === "document" &&
      a.content.understanding,
  );
  const content =
    artifact?.content.kind === "document" ? artifact.content : null;
  return (
    <InspectorPanel
      className="understanding-panel"
      label="当前理解"
      title="当前理解"
      context={project?.title}
      resizeLabel="调整当前理解宽度"
      layout={layout}
      onResize={onResize}
      onClose={onClose}
      footer={
        <footer>
          {artifact && (
            <button
              onClick={() =>
                onCompose(
                  "请更新当前工作空间的公开理解。需要纠正或补充的内容：",
                )
              }
            >
              <MessageSquarePlus />
              纠正或补充
            </button>
          )}
          <button
            onClick={() =>
              onCompose(
                artifact
                  ? "请根据最新进展更新当前工作空间的公开理解。"
                  : "请梳理当前工作空间的公开理解，包括目标、约束和已确认的事实。",
              )
            }
          >
            <RefreshCw />
            {artifact ? "更新理解" : "梳理理解"}
          </button>
          <small>在输入框中确认后发送</small>
        </footer>
      }
    >
      <div className="understanding-scroll">
        {content?.understanding && artifact ? (
          <>
            <div className="understanding-meta">
              更新于 {new Date(artifact.updatedAt).toLocaleString("zh-CN")} · v
              {artifact.revision}
            </div>
            <article className="understanding-content">
              <SafeMarkdown state={state} onOpen={onOpen}>
                {content.markdown}
              </SafeMarkdown>
            </article>
            {!!content.understanding.sources.length && (
              <details className="understanding-sources">
                <summary>
                  参考内容 · {content.understanding.sources.length}
                </summary>
                {content.understanding.sources.map((ref) => {
                  const source = state.artifacts.find(
                    (a) => a.id === ref.artifactId,
                  );
                  return (
                    <button
                      key={ref.artifactId + ref.revision}
                      disabled={!source}
                      onClick={() => onOpen(ref.artifactId, ref.revision)}
                    >
                      <BookOpen size={14} />
                      <span>{source?.title ?? "内容已不可用"}</span>
                      <small>v{ref.revision}</small>
                    </button>
                  );
                })}
              </details>
            )}
          </>
        ) : (
          <p className="understanding-empty">
            还没有公开摘要。可以让 Morphz 梳理目标、约束和已经确认的事实。
          </p>
        )}
        <p className="understanding-note">
          这里展示可共同核对的公开摘要，不是内部推理。更新后会保留版本。
        </p>
      </div>
    </InspectorPanel>
  );
}
