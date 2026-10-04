import { useEffect, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import type {
  Artifact,
  Workspace,
} from "../../../../../packages/core/src/model.js";
import type { WorkspaceClient } from "../../client.js";
import type { ComposerOption } from "../../ComposerOptions.js";
import { InspectorPanel } from "../../InspectorPanel.js";
import type { InspectorLayout } from "../../inspector-layout.js";

export type ObjectAnnotationResult = {
  artifactId: string;
  items: Workspace["annotations"];
  error: string;
  loading: boolean;
};

// Registered unconditionally at the original host seam; hiding the panel
// does not retire its state or change the original read/cleanup contract.
export function useObjectAnnotations({
  artifact,
  collaborationVisible,
  client,
}: {
  artifact: Pick<Artifact, "id"> | undefined;
  collaborationVisible: boolean;
  client: Pick<
    WorkspaceClient,
    "boot" | "workspaceChangeRevision" | "listObjectAnnotations"
  >;
}) {
  const [annotationRefresh, setAnnotationRefresh] = useState(0);
  const [annotationResult, setAnnotationResult] = useState<{
    artifactId: string;
    items: Workspace["annotations"];
    error: string;
    loading: boolean;
  } | null>(null);
  useEffect(() => {
    if (!collaborationVisible || !artifact) return;
    const controller = new AbortController();
    const artifactId = artifact.id;
    setAnnotationResult({ artifactId, items: [], error: "", loading: true });
    void client
      .listObjectAnnotations(artifactId, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted)
          setAnnotationResult({ artifactId, items, error: "", loading: false });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setAnnotationResult({
            artifactId,
            items: [],
            error:
              error instanceof Error ? error.message : "批注暂时无法读取。",
            loading: false,
          });
      });
    return () => controller.abort();
  }, [
    artifact?.id,
    collaborationVisible,
    annotationRefresh,
    client.boot?.csrfToken,
    client.workspaceChangeRevision,
  ]);
  return { annotationResult, setAnnotationRefresh };
}

export function objectAnnotationItems(
  artifact: Pick<Artifact, "id"> | undefined,
  annotationResult: ObjectAnnotationResult | null,
) {
  const annotations =
    artifact && annotationResult?.artifactId === artifact.id
      ? annotationResult.items
      : [];
  return annotations;
}

export function ObjectAnnotationsPanel({
  artifact,
  annotationResult,
  annotations,
  authorName,
  viewOptions: inspectorViewOptions,
  context: contextTitle,
  focusOnMount,
  layout: rightInspector,
  onResize: resizeInspector,
  onClose: closeInspector,
}: {
  artifact: Pick<Artifact, "id">;
  annotationResult: ObjectAnnotationResult | null;
  annotations: Workspace["annotations"];
  authorName: (actantId: string) => string;
  viewOptions: ComposerOption[];
  context: string;
  focusOnMount: boolean;
  layout: InspectorLayout;
  onResize: (width: number) => void;
  onClose: () => void;
}) {
  return (
    <InspectorPanel
      className="collaboration"
      label="对象批注"
      title="批注"
      viewOptions={inspectorViewOptions}
      context={contextTitle}
      resizeLabel="调整批注栏宽度"
      // Showing a saved annotation must not steal focus from continued input.
      focusOnMount={focusOnMount}
      layout={rightInspector}
      onResize={resizeInspector}
      onClose={closeInspector}
    >
      <div className="collaboration-scroll">
        {annotationResult?.artifactId === artifact?.id &&
        annotationResult.error ? (
          <p role="alert">批注读取失败：{annotationResult.error}</p>
        ) : annotationResult?.artifactId !== artifact?.id ||
          annotationResult.loading ? (
          <p>正在读取批注…</p>
        ) : !annotations.length ? (
          <div className="discussion-empty">
            <MessageSquarePlus />
            <p>暂无批注</p>
          </div>
        ) : (
          <>
            {annotations.map((a) => (
              <section className="message annotation" key={a.id}>
                <div className="message-author">
                  <MessageSquarePlus />
                  {authorName(a.author.actantId)}
                  <small>
                    批注 · v{a.artifactRevision}
                    {a.page ? ` · 第 ${a.page} 页` : ""}
                  </small>
                </div>
                <blockquote>{a.quote}</blockquote>
                <p>{a.body}</p>
              </section>
            ))}
          </>
        )}
      </div>
    </InspectorPanel>
  );
}
