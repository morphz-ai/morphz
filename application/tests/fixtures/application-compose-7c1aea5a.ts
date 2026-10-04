import type { BuiltinApplicationOptions } from "../../apps/web/src/host/builtin-application-adapters.js";
import type { ApplicationComposePreparationOptions } from "../../apps/web/src/host/application-compose-preparation.js";
import type { InputDraft } from "../../apps/web/src/host/exchange-drafts.js";
import { composeArtifactDrafts } from "../../apps/web/src/composer-drafts.js";

// Fixed actual Git7c declaration; no candidate algorithm or CI Git read.
export const fixedApplicationComposeSource = {
  git: "7c1aea5a76448108f628ab2fc7853db27f04d4d0",
  declarationBytes: 3341,
  declarationSha256:
    "ddb4bee1f04b928f5787c73de653c08d86e097066f81d411ac9911c3d2c09906",
  declaration:
    '  const applicationCompose: BuiltinApplicationOptions["onCompose"] = (\n    text,\n    artifactId,\n    scriptGeneration,\n  ) => {\n    if (scriptGeneration) {\n      const production = client.getScriptEditor(scriptGeneration.productionId);\n      const target = production?.items.find(\n        (i) => i.id === scriptGeneration.targetId,\n      );\n      if (\n        !production ||\n        production.projectId !== project.id ||\n        !target ||\n        target.revision !== scriptGeneration.baseRevision ||\n        production.revision !== scriptGeneration.contextRevision\n      ) {\n        return {\n          ok: false,\n          error: "剧本引用已有变化，请关闭后重新准备请求；原草稿保留。",\n        };\n      }\n      if (\n        sending ||\n        draft.pendingSupplement ||\n        draft.continuation ||\n        draft.annotation ||\n        draft.taskResult ||\n        draft.body.trim() ||\n        draft.attachments?.length ||\n        draft.textQuotes?.length ||\n        (draft.intent && draft.intent !== "script") ||\n        draft.scriptGeneration\n      ) {\n        return {\n          ok: false,\n          error:\n            "输入框中已有未发送的内容或请求。请先处理原输入，再准备本次请求；这里填写的要求已保留。",\n        };\n      }\n      setDraft(contextKey, {\n        ...draft,\n        intent: undefined,\n        revision: null,\n        selection: "",\n        scriptGeneration: structuredClone(scriptGeneration),\n        body: text,\n      });\n    } else if (artifactId) {\n      const target = state.artifacts.find(\n        (a) => a.id === artifactId && a.projectId === project.id,\n      );\n      const catalogTarget = client.contentCatalog.find(\n        (entry) => entry.id === artifactId && entry.projectId === project.id,\n      );\n      if (!target && !catalogTarget)\n        return { ok: false, error: "引用的内容已不可用。" };\n      const key = conversationId + ":" + artifactId;\n      const observedRevision =\n        target?.revision ?? Number(catalogTarget?.observedVersionRef);\n      const revision =\n        Number.isSafeInteger(observedRevision) && observedRevision > 0\n          ? observedRevision\n          : null;\n      let composed:\n        ReturnType<typeof composeArtifactDrafts<InputDraft>> | undefined;\n      // This iframe event must ACK the actual latest-state\n      // guard, not a render snapshot or an unexecuted updater.\n      flushSync(() =>\n        writeDrafts((previous) => {\n          composed = composeArtifactDrafts(\n            previous,\n            key,\n            emptyDraft,\n            text,\n            revision,\n            conversationId === defaultConversation\n              ? project.id + ":" + artifactId\n              : undefined,\n          );\n          return composed.ok ? composed.drafts : previous;\n        }),\n      );\n      if (!composed || !composed.ok)\n        return {\n          ok: false,\n          error: composed?.error ?? "暂时无法准备输入，原草稿已保留。",\n        };\n      if (key === currentContext.current && composed.bodyChanged)\n        dictationControls.current?.interrupt();\n      prefer({ artifactId });\n    } else\n      setDraft(contextKey, {\n        ...draft,\n        body: [draft.body, text].filter(Boolean).join("\\n"),\n      });\n    showInput();\n    return { ok: true };\n  };\n',
} as const;
export function createFixedApplicationCompose({
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
}: ApplicationComposePreparationOptions) {
  const applicationCompose: BuiltinApplicationOptions["onCompose"] = (
    text,
    artifactId,
    scriptGeneration,
  ) => {
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
  return applicationCompose;
}
