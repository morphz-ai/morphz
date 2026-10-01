import { BookOpen, RefreshCw, MessageSquarePlus } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkspaceClient } from "./client.js";
import type { PlatformProjectUnderstanding } from "./platform-client.js";
import { SafeMarkdown } from "./SafeMarkdown.js";
import { InspectorPanel } from "./InspectorPanel.js";
import type { InspectorLayout } from "./inspector-layout.js";
import type { ComposerOption } from "./ComposerOptions.js";

/** Public, committed understanding; inspecting it never submits an input. */
export function UnderstandingPanel({
  client,
  projectId,
  onOpen,
  onCompose,
  onClose,
  layout,
  onResize,
  viewOptions,
}: {
  client: WorkspaceClient;
  projectId: string;
  onOpen: (id: string, revision?: number) => void;
  onCompose: (body: string) => void;
  onClose: () => void;
  layout: InspectorLayout;
  onResize: (width: number) => void;
  viewOptions?: ComposerOption[];
}) {
  const state = client.boot!.workspace;
  const project = state.projects.find((p) => p.id === projectId);
  const [understanding, setUnderstanding] =
    useState<PlatformProjectUnderstanding | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [retry, setRetry] = useState(0);
  const centerId = client.boot?.centerId;
  const principalId = client.boot?.principalId;
  const identityGeneration = client.boot?.csrfToken;
  const catalogVersion = client.boot?.workspace.revision;
  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setUnderstanding(null);
    void client
      .readProjectUnderstanding(projectId, undefined, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setUnderstanding(value);
        setStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("error");
      });
    return () => controller.abort();
    // The Platform catalog revision advances on publication; a new identity
    // must never retain the previous user's project summary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    projectId,
    centerId,
    principalId,
    identityGeneration,
    catalogVersion,
    retry,
  ]);
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
      viewOptions={viewOptions}
      footer={
        <footer>
          {understanding && (
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
                understanding
                  ? "请根据最新进展更新当前工作空间的公开理解。"
                  : "请梳理当前工作空间的公开理解，包括目标、约束和已确认的事实。",
              )
            }
          >
            <RefreshCw />
            {understanding ? "更新理解" : "梳理理解"}
          </button>
        </footer>
      }
    >
      <div className="understanding-scroll">
        {understanding ? (
          <>
            <div className="understanding-meta">
              更新于{" "}
              {new Date(understanding.publishedAt).toLocaleString("zh-CN")} · v
              {understanding.revision}
            </div>
            <article className="understanding-content">
              <SafeMarkdown
                state={state}
                catalog={client.contentCatalog}
                onOpen={onOpen}
              >
                {understanding.body}
              </SafeMarkdown>
            </article>
            {!!understanding.sources.length && (
              <details className="understanding-sources">
                <summary>参考内容 · {understanding.sources.length}</summary>
                {understanding.sources.map((ref) => {
                  const revision = Number(ref.versionRef);
                  const canOpenExact =
                    ref.appId === "morphz.objects" &&
                    Number.isSafeInteger(revision) &&
                    revision > 0;
                  return (
                    <button
                      key={`${ref.contentId}:${ref.versionRef}`}
                      disabled={!canOpenExact}
                      title={
                        !ref.title
                          ? "内容已不可用"
                          : canOpenExact
                            ? undefined
                            : "此类内容暂不能从这里打开指定版本"
                      }
                      onClick={() => onOpen(ref.contentId, revision)}
                    >
                      <BookOpen size={14} />
                      <span>{ref.title ?? "内容已不可用"}</span>
                      <small>v{ref.versionRef}</small>
                    </button>
                  );
                })}
              </details>
            )}
          </>
        ) : status === "loading" ? (
          <p className="understanding-empty" role="status">
            读取中…
          </p>
        ) : status === "error" ? (
          <p className="understanding-empty" role="status">
            暂时无法读取当前理解。{" "}
            <button onClick={() => setRetry((value) => value + 1)}>重试</button>
          </p>
        ) : (
          <p className="understanding-empty">暂无摘要</p>
        )}
      </div>
    </InspectorPanel>
  );
}
