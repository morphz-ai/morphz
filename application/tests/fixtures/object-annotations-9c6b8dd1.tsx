// Fixed actual Git 9c6b8dd143d7220ede11a25a5996eef6da047762, frozen before the candidate.
// Original blocks are retained verbatim; normal CI requires neither Git nor shell.
import { useEffect, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import type { Artifact, Workspace } from "../../packages/core/src/model.js";
import type { WorkspaceClient } from "../../apps/web/src/client.js";
import { actorName } from "../../apps/web/src/client.js";
import { InspectorPanel } from "../../apps/web/src/InspectorPanel.js";
import type { InspectorLayout } from "../../apps/web/src/inspector-layout.js";
import type { ComposerOption } from "../../apps/web/src/ComposerOptions.js";

export const fixedObjectAnnotationBaseline = {
  revision: "9c6b8dd143d7220ede11a25a5996eef6da047762",
  originalFiles: {
    "App.tsx": {
      bytes: 115483,
      sha256:
        "d516aa14d079d4adddc06545e0616a3c45399dc6c2d62056753f95d99e78af30",
      actualGitFullByteEqual: true,
    },
    "client.ts": {
      bytes: 68796,
      sha256:
        "e46367774b907c3625bf5609f31de8ab3cba00dbffada96e3cf3b8bf0ab222e0",
      actualGitFullByteEqual: true,
    },
    "InspectorPanel.tsx": {
      bytes: 4407,
      sha256:
        "3ed33cf262476fd28e556083af201708753319a45ef6854e64b548cd3adba86f",
      actualGitFullByteEqual: true,
    },
    "inspector-layout.ts": {
      bytes: 835,
      sha256:
        "3fbeb93ffeebde845d71b4da18c2bb42fbb2641b01be4e708986b28b23db8554",
      actualGitFullByteEqual: true,
    },
    "host/exchange-submission-commands.ts": {
      bytes: 10186,
      sha256:
        "eceaf1eb5f30b2d40cd869d812e19d91fd38d7cc162e4957fb79f3dd4dc0bec3",
      actualGitFullByteEqual: true,
    },
    "platform-client.ts": {
      bytes: 41553,
      sha256:
        "704979ff87a73031ba3d3d6a9c98d980762614251d3f7a65107ee10349eb99d5",
      actualGitFullByteEqual: true,
    },
  },
  spans: {
    AnnotationRefreshState: {
      bytes: 62,
      sha256:
        "7250ae22eea9c792bdbdfcd77c901645edb3d920862a5e96aaa84bcbaf47e181",
      raw: "const [annotationRefresh, setAnnotationRefresh] = useState(0);",
    },
    AnnotationResultState: {
      bytes: 179,
      sha256:
        "98f53565747fefa27823ea350fab707b450824503ccf5d10c5aec1a902a5d8cf",
      raw: 'const [annotationResult, setAnnotationResult] = useState<{\n    artifactId: string;\n    items: Workspace["annotations"];\n    error: string;\n    loading: boolean;\n  } | null>(null);',
    },
    AnnotationReadEffect: {
      bytes: 952,
      sha256:
        "b7f841ba27a1d4b2ae149501c2bb35ef815289bab29917103aa4eb549b5f7830",
      raw: 'useEffect(() => {\n    if (!collaborationVisible || !artifact) return;\n    const controller = new AbortController();\n    const artifactId = artifact.id;\n    setAnnotationResult({ artifactId, items: [], error: "", loading: true });\n    void client\n      .listObjectAnnotations(artifactId, controller.signal)\n      .then((items) => {\n        if (!controller.signal.aborted)\n          setAnnotationResult({ artifactId, items, error: "", loading: false });\n      })\n      .catch((error: unknown) => {\n        if (!controller.signal.aborted)\n          setAnnotationResult({\n            artifactId,\n            items: [],\n            error:\n              error instanceof Error ? error.message : "批注暂时无法读取。",\n            loading: false,\n          });\n      });\n    return () => controller.abort();\n  }, [\n    artifact?.id,\n    collaborationVisible,\n    annotationRefresh,\n    client.boot?.csrfToken,\n    client.workspaceChangeRevision,\n  ]);',
    },
    AnnotationItemsProjection: {
      bytes: 123,
      sha256:
        "d2d5b414a0afdf92df6a21ca5c7c744db15e1e54a05558983381bb240a97dbf4",
      raw: "const annotations =\n    artifact && annotationResult?.artifactId === artifact.id\n      ? annotationResult.items\n      : [];",
    },
    AnnotationPanel: {
      bytes: 1859,
      sha256:
        "9fee22f8e8eb8c58757e95cc8bc73a68a753e1d28b0318248583b6c00c600e57",
      raw: '<InspectorPanel\n            className="collaboration"\n            label="对象批注"\n            title="批注"\n            viewOptions={inspectorViewOptions}\n            context={contextTitle}\n            resizeLabel="调整批注栏宽度"\n            // Showing a saved annotation must not steal focus from continued input.\n            focusOnMount={!sentInputFocusPending}\n            layout={rightInspector}\n            onResize={resizeInspector}\n            onClose={closeInspector}\n          >\n            <div className="collaboration-scroll">\n              {annotationResult?.artifactId === artifact?.id &&\n              annotationResult.error ? (\n                <p role="alert">批注读取失败：{annotationResult.error}</p>\n              ) : annotationResult?.artifactId !== artifact?.id ||\n                annotationResult.loading ? (\n                <p>正在读取批注…</p>\n              ) : !annotations.length ? (\n                <div className="discussion-empty">\n                  <MessageSquarePlus />\n                  <p>暂无批注</p>\n                </div>\n              ) : (\n                <>\n                  {annotations.map((a) => (\n                    <section className="message annotation" key={a.id}>\n                      <div className="message-author">\n                        <MessageSquarePlus />\n                        {actorName(state, a.author.actantId)}\n                        <small>\n                          批注 · v{a.artifactRevision}\n                          {a.page ? ` · 第 ${a.page} 页` : ""}\n                        </small>\n                      </div>\n                      <blockquote>{a.quote}</blockquote>\n                      <p>{a.body}</p>\n                    </section>\n                  ))}\n                </>\n              )}\n            </div>\n          </InspectorPanel>',
    },
    AnnotationPanelGuard: {
      bytes: 1907,
      sha256:
        "d8e87574a48bd7578ccb2cbbf6122d839cf187884e534ff8e5064e252d99cd18",
      raw: '{collaborationVisible && (\n          <InspectorPanel\n            className="collaboration"\n            label="对象批注"\n            title="批注"\n            viewOptions={inspectorViewOptions}\n            context={contextTitle}\n            resizeLabel="调整批注栏宽度"\n            // Showing a saved annotation must not steal focus from continued input.\n            focusOnMount={!sentInputFocusPending}\n            layout={rightInspector}\n            onResize={resizeInspector}\n            onClose={closeInspector}\n          >\n            <div className="collaboration-scroll">\n              {annotationResult?.artifactId === artifact?.id &&\n              annotationResult.error ? (\n                <p role="alert">批注读取失败：{annotationResult.error}</p>\n              ) : annotationResult?.artifactId !== artifact?.id ||\n                annotationResult.loading ? (\n                <p>正在读取批注…</p>\n              ) : !annotations.length ? (\n                <div className="discussion-empty">\n                  <MessageSquarePlus />\n                  <p>暂无批注</p>\n                </div>\n              ) : (\n                <>\n                  {annotations.map((a) => (\n                    <section className="message annotation" key={a.id}>\n                      <div className="message-author">\n                        <MessageSquarePlus />\n                        {actorName(state, a.author.actantId)}\n                        <small>\n                          批注 · v{a.artifactRevision}\n                          {a.page ? ` · 第 ${a.page} 页` : ""}\n                        </small>\n                      </div>\n                      <blockquote>{a.quote}</blockquote>\n                      <p>{a.body}</p>\n                    </section>\n                  ))}\n                </>\n              )}\n            </div>\n          </InspectorPanel>\n        )}',
    },
    AnnotationReceipt: {
      bytes: 957,
      sha256:
        "68f9b895560c3f060e7134b11ae67025108585b1f442ae3d36d06e326f045e27",
      raw: 'onResolved: (result) => {\n          if (result.kind === "supplement")\n            setRevealedInputs((old) => ({\n              ...old,\n              [conversationId]: result.receipt.entityId,\n            }));\n          else if (result.kind === "annotation")\n            setAnnotationRefresh((value) => value + 1);\n          // The acknowledged input consumed this conversation\'s references.\n          if (!staged)\n            updateDraft(key, (current) =>\n              consumeComposerDraft(current, emptyDraft),\n            );\n          if (!staged && currentContext.current === key) {\n            if (asAnnotation) {\n              openCollaboration();\n              requestSentInputFocus(key);\n            } else if (captured.continuation || !captured.taskResult) {\n              setMobileCollaboration(false);\n              // Focus only after React removes the sending-disabled state.\n              showSentInput(key);\n            }\n          }\n        }',
    },
    ClientQuery: {
      bytes: 1279,
      sha256:
        "3f5c2f3c730e74d7399e04df637781574109769cea6b5aa7514a1b5fab1dc65b",
      raw: 'async function listObjectAnnotations(\n    contentId: string,\n    signal?: AbortSignal,\n  ) {\n    const identity = current.current;\n    const source = platform.current;\n    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)\n      throw new Error("身份已变化，批注未读取。");\n    const annotations: Workspace["annotations"] = [];\n    let afterOrdinal: number | undefined;\n    for (let page = 0; page < 100; page++) {\n      const rows = z\n        .array(\n          z.object({\n            ordinal: z.number().int().nonnegative(),\n            annotation: stateSchema.shape.annotations.element,\n          }),\n        )\n        .parse(\n          await source.listObjectAnnotations(\n            contentId,\n            {\n              limit: 100,\n              ...(afterOrdinal === undefined ? {} : { afterOrdinal }),\n            },\n            signal,\n          ),\n        );\n      annotations.push(...rows.map((row) => row.annotation));\n      if (rows.length < 100) return annotations;\n      const last = rows.at(-1)!.ordinal;\n      if (afterOrdinal !== undefined && last <= afterOrdinal)\n        throw new Error("批注分页游标未推进。");\n      afterOrdinal = last;\n    }\n    throw new Error("批注数量超过当前可读取范围。");\n  }',
    },
    ClientPublicAlias: {
      bytes: 21,
      sha256:
        "855598ad9ce1ff842aecb59674dab67b43ee4f7fbe2ff4a8bf9977c8a4107abb",
      raw: "listObjectAnnotations",
    },
    ActorName: {
      bytes: 135,
      sha256:
        "8913d56b6677f6e72eb07037812053ed2160aaf76e80da9df558558fe2a1d4e2",
      raw: 'export function actorName(state: Workspace, id: string) {\n  return state.actants.find((a) => a.id === id)?.name ?? "未知参与者";\n}',
    },
    PlatformQuery: {
      bytes: 222,
      sha256:
        "e637bd37bb6a1f50d4f469b115365727f53e8cee9cc51c56b1c46810cebe0ec3",
      raw: 'listObjectAnnotations(\n    contentId: string,\n    options: { limit?: number; afterOrdinal?: number } = {},\n    signal?: AbortSignal,\n  ) {\n    return this.call("objects.annotations", { contentId, ...options }, signal);\n  }',
    },
  },
} as const;

export type FixedObjectAnnotationResult = {
  artifactId: string;
  items: Workspace["annotations"];
  error: string;
  loading: boolean;
};
export type FixedObjectAnnotationRead = {
  artifact: Pick<Artifact, "id"> | undefined;
  collaborationVisible: boolean;
  client: Pick<
    WorkspaceClient,
    "boot" | "workspaceChangeRevision" | "listObjectAnnotations"
  >;
};

// The two declarations and complete effect have the original raw indentation.
// prettier-ignore
export function useFixedObjectAnnotations({artifact,collaborationVisible,client}: FixedObjectAnnotationRead) {
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

// prettier-ignore
export function fixedObjectAnnotationItems(artifact: Pick<Artifact,"id">|undefined, annotationResult:FixedObjectAnnotationResult|null) {
  const annotations =
    artifact && annotationResult?.artifactId === artifact.id
      ? annotationResult.items
      : [];
  return annotations;
}

export type FixedObjectAnnotationsPanelOptions = {
  artifact: Pick<Artifact, "id">;
  annotationResult: FixedObjectAnnotationResult | null;
  annotations: Workspace["annotations"];
  state: Workspace;
  inspectorViewOptions: ComposerOption[];
  contextTitle: string;
  sentInputFocusPending: boolean;
  rightInspector: InspectorLayout;
  resizeInspector: (width: number) => void;
  closeInspector: () => void;
};

// Preserve the complete original JSX, including source-qualified names.
// Carrier props only expose the original render locals; no candidate baseline.
// prettier-ignore
export function FixedObjectAnnotationsPanel({artifact,annotationResult,annotations,state,inspectorViewOptions,contextTitle,sentInputFocusPending,rightInspector,resizeInspector,closeInspector}:FixedObjectAnnotationsPanelOptions) {
  return (
    <InspectorPanel
            className="collaboration"
            label="对象批注"
            title="批注"
            viewOptions={inspectorViewOptions}
            context={contextTitle}
            resizeLabel="调整批注栏宽度"
            // Showing a saved annotation must not steal focus from continued input.
            focusOnMount={!sentInputFocusPending}
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
                        {actorName(state, a.author.actantId)}
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
