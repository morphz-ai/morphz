import type { Workspace } from "../../../../packages/core/src/model.js";
import type { Project } from "../../../../packages/core/src/projects.js";
import type { ScriptGeneration } from "../../../../packages/core/src/script-studio.js";
import type { WorkspaceClient } from "../client.js";
import type {
  createExchangeDraftCommands,
  InputDraft,
} from "./exchange-drafts.js";
import { composeArtifactDrafts } from "../composer-drafts.js";

type PreparedInputResult = { ok: true } | { ok: false; error: string };

export type ApplicationComposePreparationOptions = Readonly<{
  render: Readonly<{
    state: Pick<Workspace, "artifacts">;
    project: Pick<Project, "id">;
    draft: InputDraft;
    contextKey: string;
    conversationId: string;
    defaultConversation: string | undefined;
    sending: boolean;
    emptyDraft: InputDraft;
  }>;
  client: Pick<WorkspaceClient, "getScriptEditor" | "contentCatalog">;
  setDraft: (key: string, value: InputDraft) => void;
  writeDrafts: ReturnType<typeof createExchangeDraftCommands>["writeInputs"];
  flushSync: (run: () => void) => void;
  currentContext: { readonly current: string };
  dictationControls: {
    readonly current: { interrupt(): void } | null;
  };
  prefer: (change: { artifactId: string }) => void;
  showInput: () => void;
}>;

/** Render-captured input preparation and its synchronous acknowledgement.
 * Borrows the original writers and live refs; not a sandbox permission port. */
export function createApplicationComposePreparation({
  render: {
    state,
    project,
    draft,
    contextKey,
    conversationId,
    defaultConversation,
    sending,
    emptyDraft,
  },
  client,
  setDraft,
  writeDrafts,
  flushSync,
  currentContext,
  dictationControls,
  prefer,
  showInput,
}: ApplicationComposePreparationOptions): (
  text: string,
  artifactId?: string,
  scriptGeneration?: ScriptGeneration,
) => PreparedInputResult {
  return (text, artifactId, scriptGeneration) => {
    if (scriptGeneration) {
      const production = client.getScriptEditor(scriptGeneration.productionId);
      const target = production?.items.find(
        (i) => i.id === scriptGeneration.targetId,
      );
      if (
        !production ||
        production.projectId !== project.id ||
        !target ||
        target.revision !== scriptGeneration.baseRevision ||
        production.revision !== scriptGeneration.contextRevision
      ) {
        return {
          ok: false,
          error: "剧本引用已有变化，请关闭后重新准备请求；原草稿保留。",
        };
      }
      if (
        sending ||
        draft.pendingSupplement ||
        draft.continuation ||
        draft.annotation ||
        draft.taskResult ||
        draft.body.trim() ||
        draft.attachments?.length ||
        draft.textQuotes?.length ||
        (draft.intent && draft.intent !== "script") ||
        draft.scriptGeneration
      ) {
        return {
          ok: false,
          error:
            "输入框中已有未发送的内容或请求。请先处理原输入，再准备本次请求；这里填写的要求已保留。",
        };
      }
      setDraft(contextKey, {
        ...draft,
        intent: undefined,
        revision: null,
        selection: "",
        scriptGeneration: structuredClone(scriptGeneration),
        body: text,
      });
    } else if (artifactId) {
      const target = state.artifacts.find(
        (a) => a.id === artifactId && a.projectId === project.id,
      );
      const catalogTarget = client.contentCatalog.find(
        (entry) => entry.id === artifactId && entry.projectId === project.id,
      );
      if (!target && !catalogTarget)
        return { ok: false, error: "引用的内容已不可用。" };
      const key = conversationId + ":" + artifactId;
      const observedRevision =
        target?.revision ?? Number(catalogTarget?.observedVersionRef);
      const revision =
        Number.isSafeInteger(observedRevision) && observedRevision > 0
          ? observedRevision
          : null;
      let composed:
        ReturnType<typeof composeArtifactDrafts<InputDraft>> | undefined;
      // This iframe event must ACK the actual latest-state
      // guard, not a render snapshot or an unexecuted updater.
      flushSync(() =>
        writeDrafts((previous) => {
          composed = composeArtifactDrafts(
            previous,
            key,
            emptyDraft,
            text,
            revision,
            conversationId === defaultConversation
              ? project.id + ":" + artifactId
              : undefined,
          );
          return composed.ok ? composed.drafts : previous;
        }),
      );
      if (!composed || !composed.ok)
        return {
          ok: false,
          error: composed?.error ?? "暂时无法准备输入，原草稿已保留。",
        };
      if (key === currentContext.current && composed.bodyChanged)
        dictationControls.current?.interrupt();
      prefer({ artifactId });
    } else
      setDraft(contextKey, {
        ...draft,
        body: [draft.body, text].filter(Boolean).join("\n"),
      });
    showInput();
    return { ok: true };
  };
}
