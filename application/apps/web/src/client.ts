import { useEffect, useRef, useState } from "react";
import { interactiveRowEdits } from "../../../packages/core/src/interactive.js";
import { migrateContentLocalState } from "./content-local-migration.js";
import { z } from "zod";
import {
  scriptOutputSchema,
  type ScriptLocation,
} from "../../../packages/core/src/script-delivery.js";
import {
  speechStreamStateSchema,
  type SpeechStreamCommand,
} from "../../../packages/core/src/speech-stream.js";
import {
  connectionDetailsSchema,
  type ConfigureConnection,
} from "../../../packages/core/src/connection.js";
import { taskRuntimeSchema } from "../../../packages/core/src/task-runtime.js";
import {
  retainTaskRuntimeProjections,
  taskRuntimeResponseStillCurrent,
} from "./task-runtime-projection.js";
import {
  migrateLegacyLocalState,
  migrateApplicationLocalState,
  migrateReadingLocalState,
} from "./legacy-storage.js";
import {
  draftOwner,
  draftKey,
  scopedStorage,
  storageScope,
} from "./local-preferences.js";
export {
  draftKey,
  readLocal,
  scopedStorage,
  storageScope,
  writeLocal,
} from "./local-preferences.js";
import { applicationStoragePrefix } from "../../../packages/core/src/application-names.js";
import {
  readSavedInputs,
  removeSavedInput,
  saveInputLocally,
  withSavedInputs,
  withoutSavedInputs,
  inputSubmissionSchema,
  type LocalSavedInput,
} from "./local-saved-inputs.js";
import { applicationCall, RequestError } from "./application-transport.js";
import {
  PlatformClient,
  scriptLibraryEntrySchema,
  type PlatformContentCount,
  type ScriptOverview,
} from "./platform-client.js";
import type { LiveScriptDraft } from "../../../packages/script-studio/src/store.js";
import {
  scriptProductionSchema,
  type ScriptDraft,
} from "../../../packages/core/src/script-studio.js";
import {
  collectEditorPage,
  parseEditorHead,
  parseEditorVersion,
  parseEditorCandidate,
  type ScriptEditorProduction,
  type ScriptPanel,
} from "./script-editor-reader.js";
import {
  scriptReviewDetailSchema,
  scriptExportDetailSchema,
  scriptVersionTitleSchema,
  type ScriptEditorPageRequest,
} from "../../../packages/core/src/script-editor.js";
import {
  scriptDocxLimits,
  type ScriptDocxManifest,
} from "../../../packages/core/src/script-studio-docx.js";
import {
  mergePlatformHistories,
  readContentArtifact,
  readPlatformWorkspace,
  reusableNavigationCatalog,
  navigationReadStillCurrent,
  readCachedScriptOverview,
  type PlatformNavigationCache,
  contentVersionTitle,
  readTaskArtifact,
  scriptLibraryEntryFromContent,
  type HistoryScope,
} from "./platform-workspace-view.js";
import { contentVisits } from "./recent-content.js";
import { runPendingFileImport } from "./pending-file-import.js";
export { RequestError } from "./application-transport.js";
import {
  readingMarkSchema,
  readingStateSchema,
  readerMarksReadSchema,
  type ReaderCommand,
  type ReadingSection,
  type ReaderMarksRead,
  type ReadingMarksPage,
} from "../../../packages/core/src/reader.js";
import {
  executionSnapshotSchema,
  type ExecutionScope,
  type ExecutionControl,
} from "../../../packages/core/src/execution.js";
import type {
  SearchRequest,
  SearchResult,
} from "../../../packages/core/src/retrieval.js";
import {
  conversationRuntimeSchema,
  artifactOutputSchema,
  disconnectedRuntime,
} from "../../../packages/core/src/conversation.js";
import {
  contentOrganizationChangesSchema,
  operationSchema,
  stateSchema,
  taskContentSchema,
  type Artifact,
  type Operation,
  type Receipt,
  type Workspace,
} from "../../../packages/core/src/model.js";
import {
  bookmarkSchema,
  type BookmarkOperation,
} from "../../../packages/core/src/bookmarks.js";
import { applicationStateSchema } from "../../../packages/core/src/applications.js";
const bootSchema = z.object({
  centerId: z.string().uuid(),
  workspace: stateSchema,
  scriptLibrary: z.array(scriptLibraryEntrySchema).default([]),
  outputs: z.array(artifactOutputSchema).default([]),
  scriptOutputs: z.array(scriptOutputSchema).default([]),
  csrfToken: z.string(),
  principalId: z.string(),
  actantId: z.string(),
  capabilities: z.object({
    runtime: z.boolean(),
    teamAuthentication: z.boolean(),
    conversationOnFirstInput: z.boolean().default(false),
    directedInput: z.boolean().default(false),
    localFiles: z.boolean().default(false),
    agentDirectories: z.boolean().default(false),
    modelSettings: z.boolean().default(false),
    taskCompletion: z.boolean().default(false),
    browserBookmarks: z.boolean().default(false),
  }),
  runtime: conversationRuntimeSchema.default(disconnectedRuntime),
  activityByProject: z.record(z.string(), z.string().datetime()).default({}),
  taskRuns: z.record(z.string(), taskRuntimeSchema).default({}),
  localSavedInputIds: z.array(z.string()).default([]),
  localInputSubmissions: z
    .record(z.string(), inputSubmissionSchema)
    .default({}),
});
export type Boot = z.infer<typeof bootSchema>;
const savedInputScope = (identity: {
  centerId: string;
  principalId: string;
  actantId: string;
}) => `${identity.centerId}:${identity.principalId}:${identity.actantId}`;
export type SpeechScope = {
  projectId: string;
  artifactId?: string;
  revision?: number;
};

class UnsentOperationError extends Error {}

async function scriptDraftForDomain(
  source: PlatformClient,
  draft: ScriptDraft,
): Promise<LiveScriptDraft> {
  const sources: LiveScriptDraft["sources"] = [];
  for (const ref of draft.sources) {
    const entry = await source.getContent(ref.artifactId);
    if (entry.appId !== "morphz.objects" || entry.availability !== "available")
      throw new Error("引用内容不是可读取的原件，请重新选择来源。");
    sources.push({
      appId: entry.appId,
      instanceId: entry.instanceId,
      objectId: entry.appObjectId,
      versionRef: String(ref.revision),
      quote: ref.quote,
    });
  }
  return { ...draft, sources };
}

export async function executePlatformOperation(
  source: PlatformClient,
  identity: Boot,
  command: {
    commandId: string;
    operation: Operation;
    applicationInstanceId?: string;
  },
  dispatch: boolean,
): Promise<Receipt> {
  const { commandId, operation: op } = command;
  const done = (entityId: string): Receipt => ({
    commandId,
    entityId,
    workspaceRevision: identity.workspace.revision + 1,
  });
  if (op.type === "record-input") {
    if (!dispatch) throw new Error("消息必须通过统一 Session 发送。");
    const result = (await applicationCall("platform.message", command, {
      identityGeneration: identity.csrfToken,
      signal: AbortSignal.timeout(op.continuation ? 25000 : 12000),
    })) as { entityId: string };
    return done(result.entityId);
  }
  if (op.type === "install-application") {
    await source.installUiPackage(commandId, op.manifest);
    return done(`${op.manifest.id}@${op.manifest.version}`);
  }
  if (op.type === "create-project") {
    // The command identity is also the new object identity. A lost response
    // must never create a second object when the saved command is retried.
    const projectId = commandId;
    await source.createProject(op.title, commandId, projectId);
    return done(projectId);
  }
  if (op.type === "organize-content") {
    const changes = contentOrganizationChangesSchema.safeParse(op.changes);
    if (!changes.success)
      throw new UnsentOperationError(
        changes.error.issues[0]?.message ?? "内容整理参数无效，未修改内容。",
      );
    const entry =
      op.target.kind === "script"
        ? await source.resolveContent({
            appId: "morphz.script-studio",
            appObjectId: op.target.id,
          })
        : await source.getContent(op.target.id);
    if (
      entry.availability !== "available" ||
      (op.target.kind === "script"
        ? entry.appId !== "morphz.script-studio" ||
          entry.appObjectId !== op.target.id
        : entry.appId === "morphz.script-studio")
    )
      throw new UnsentOperationError("所选内容当前不可整理，未修改目录。");
    const contentId = entry.id;
    if (op.changes.title !== undefined) {
      const input = {
        commandId,
        contentId,
        expectedCatalogRevision: op.expectedRevision,
        title: op.changes.title,
      };
      if (op.target.kind === "script") await source.renameScript(input);
      else await source.renameObject(input);
      return done(op.target.id);
    }
    if (op.changes.newProjectTitle !== undefined) {
      await source.createProjectForContent({
        commandId,
        projectId: commandId,
        title: op.changes.newProjectTitle,
        contentId,
        expectedRevision: op.expectedRevision,
      });
    } else {
      if (!op.changes.projectId)
        throw new UnsentOperationError("请选择目标项目。");
      await source.moveContent({
        commandId,
        contentId,
        targetProjectId: op.changes.projectId,
        expectedRevision: op.expectedRevision,
      });
    }
    return done(op.target.id);
  }
  if (op.type === "annotate") {
    const entry = await source.getContent(op.artifactId);
    if (entry.appId !== "morphz.objects" || entry.availability !== "available")
      throw new UnsentOperationError("所选内容不是可批注的原件，未保存批注。");
    await source.annotateObject({
      commandId,
      contentId: entry.id,
      revision: op.artifactRevision,
      quote: op.quote,
      ...(op.page === undefined ? {} : { page: op.page }),
      body: op.body,
    });
    return done(commandId);
  }
  if (op.type === "link-artifacts") {
    const relationId = await source.linkWork({
      commandId,
      fromId: op.fromId,
      toId: op.toId,
      kind: op.relation,
    });
    return done(relationId);
  }
  if (op.type === "update-project" && op.title && !op.state) {
    await source.renameProject(
      op.projectId,
      op.title,
      op.expectedRevision,
      commandId,
    );
    return done(op.projectId);
  }
  if (op.type === "update-project" && op.state && !op.title) {
    await source.changeProjectState(
      op.projectId,
      op.state,
      op.expectedRevision,
      commandId,
    );
    return done(op.projectId);
  }
  if (op.type === "update-conversation") {
    await source.updateConversation({
      commandId,
      conversationId: op.conversationId,
      expectedRevision: op.expectedRevision,
      ...(op.title !== undefined ? { title: op.title } : {}),
      ...(op.archived !== undefined ? { archived: op.archived } : {}),
    });
    return done(op.conversationId);
  }
  if (op.type === "create-artifact" && op.content.kind === "document") {
    const result = (await source.createDocument({
      commandId,
      objectId: commandId,
      projectId: op.projectId,
      title: op.title,
      markdown: op.content.markdown,
    })) as { contentId: string };
    return done(result.contentId);
  }
  if (op.type === "import-document") {
    const result = (await source.importDocument({
      commandId,
      objectId: commandId,
      projectId: op.projectId,
      relativePath: op.relativePath,
      text: op.text,
    })) as { contentId: string };
    return done(result.contentId);
  }
  if (op.type === "create-artifact" && op.content.kind === "image") {
    const result = (await source.createImage({
      commandId,
      objectId: commandId,
      projectId: op.projectId,
      title: op.title,
      assetId: op.content.assetId,
      alt: op.content.alt,
    })) as { contentId: string };
    return done(result.contentId);
  }
  if (op.type === "create-artifact" && op.content.kind === "interactive") {
    const result = (await source.createInteractive({
      commandId,
      objectId: commandId,
      projectId: op.projectId,
      title: op.title,
      content: op.content,
    })) as { contentId: string };
    return done(result.contentId);
  }
  if (op.type === "create-artifact" && op.content.kind === "task") {
    if (
      op.content.priority !== "normal" ||
      op.content.assignment !== "proposed" ||
      op.content.execution !== "planned" ||
      op.content.delivery !== "none" ||
      op.content.runRequested !== 0
    )
      throw new UnsentOperationError(
        "此事项包含尚未接通的初始状态或关联；未创建事项。",
      );
    const taskId = commandId;
    await source.createTask({
      commandId,
      taskId,
      projectId: op.projectId,
      title: op.title,
      description: op.content.description,
      assigneeId: op.content.assigneeId,
      modelId: op.content.model,
      reasoningEffort: op.content.reasoningEffort ?? null,
      notBefore: op.content.notBefore,
      everySeconds: op.content.everySeconds,
      resultIds: op.content.resultIds,
      dependsOnIds: op.content.dependsOnIds,
      watchSourceIds: op.content.watchSourceIds,
      ...(op.content.dueDate ? { dueDate: op.content.dueDate } : {}),
    });
    return done(taskId);
  }
  if (op.type === "revise-artifact" && op.content.kind === "document") {
    await source.reviseDocument({
      commandId,
      contentId: op.artifactId,
      expectedRevision: op.expectedRevision,
      title: op.title,
      markdown: op.content.markdown,
    });
    return done(op.artifactId);
  }
  if (op.type === "revise-artifact" && op.content.kind === "image") {
    await source.reviseImage({
      commandId,
      contentId: op.artifactId,
      expectedRevision: op.expectedRevision,
      title: op.title,
      assetId: op.content.assetId,
      alt: op.content.alt,
    });
    return done(op.artifactId);
  }
  if (op.type === "revise-artifact" && op.content.kind === "interactive") {
    const previous = identity.workspace.artifacts?.find(
      (artifact) => artifact.id === op.artifactId,
    );
    const baseline =
      previous?.revision === op.expectedRevision
        ? previous
        : previous?.versions.find(
            (version) => version.revision === op.expectedRevision,
          );
    const rowEdits =
      baseline?.content.kind === "interactive" && baseline.title === op.title
        ? interactiveRowEdits(baseline.content, op.content)
        : null;
    if (rowEdits?.length) {
      await source.patchInteractiveRows({
        commandId,
        contentId: op.artifactId,
        expectedRevision: op.expectedRevision,
        operations: rowEdits,
      });
      return done(op.artifactId);
    }
    await source.reviseInteractive({
      commandId,
      contentId: op.artifactId,
      expectedRevision: op.expectedRevision,
      title: op.title,
      content: op.content,
    });
    return done(op.artifactId);
  }
  if (op.type === "revise-artifact" && op.content.kind === "task") {
    const previous = await source.taskVersion(op.artifactId);
    if (previous.revision !== op.expectedRevision)
      throw new Error("事项版本已变化，请刷新后重试。");
    const previousContent = taskContentSchema.parse({
      kind: "task",
      description: previous.description,
      assigneeId: previous.assigneeId,
      model: previous.modelId,
      ...(previous.reasoningEffort
        ? { reasoningEffort: previous.reasoningEffort }
        : {}),
      priority: "normal",
      dueDate: previous.dueDate,
      assignment: previous.assignment,
      execution: previous.execution,
      delivery: previous.delivery,
      resultIds: previous.resultIds,
      runRequested: previous.runRequested,
      notBefore: previous.notBefore,
      everySeconds: previous.everySeconds,
      dependsOnIds: previous.dependsOnIds,
      watchSourceIds: previous.watchSourceIds,
    });
    const arrangement = (content: typeof op.content) =>
      Object.fromEntries(
        Object.entries(content).filter(
          ([key]) =>
            ![
              "description",
              "dueDate",
              "assigneeId",
              "assignment",
              "execution",
              "model",
              "reasoningEffort",
              "notBefore",
              "everySeconds",
              "resultIds",
              "dependsOnIds",
              "watchSourceIds",
              "runRequested",
            ].includes(key),
        ),
      );
    const {
      description,
      dueDate,
      assigneeId,
      execution,
      model,
      reasoningEffort,
      notBefore,
      everySeconds,
    } = op.content;
    const assigneeChanged = assigneeId !== previousContent.assigneeId;
    if (
      op.content.runRequested !==
      (assigneeChanged ? 0 : previousContent.runRequested)
    )
      throw new Error("请使用事项执行操作调整执行轮次；事项未保存。");
    if (
      JSON.stringify(arrangement(op.content)) !==
      JSON.stringify(arrangement(previousContent))
    )
      throw new Error("此次修改涉及尚未接通的事项安排；事项未保存。");
    await source.reviseTask({
      commandId,
      taskId: op.artifactId,
      expectedRevision: op.expectedRevision,
      title: op.title,
      description,
      dueDate,
      assigneeId,
      ...(assigneeChanged ||
      op.content.assignment !== previousContent.assignment
        ? { assignment: op.content.assignment }
        : {}),
      modelId: model,
      reasoningEffort: reasoningEffort ?? null,
      notBefore,
      everySeconds,
      execution,
      ...(JSON.stringify(op.content.resultIds) !==
      JSON.stringify(previousContent.resultIds)
        ? { resultIds: op.content.resultIds }
        : {}),
      ...(JSON.stringify(op.content.dependsOnIds) !==
      JSON.stringify(previousContent.dependsOnIds)
        ? { dependsOnIds: op.content.dependsOnIds }
        : {}),
      ...(JSON.stringify(op.content.watchSourceIds) !==
      JSON.stringify(previousContent.watchSourceIds)
        ? { watchSourceIds: op.content.watchSourceIds }
        : {}),
    });
    return done(op.artifactId);
  }
  if (op.type === "arrange-task") {
    if (op.changes.priority !== undefined)
      throw new UnsentOperationError("事项优先级由列表顺序决定，请调整顺序。");
    await source.reviseTask({
      commandId,
      taskId: op.taskId,
      expectedRevision: op.expectedRevision,
      ...op.changes,
    });
    return done(op.taskId);
  }
  if (op.type === "request-task-run") {
    await source.requestTaskRun({
      commandId,
      taskId: op.taskId,
      expectedRevision: op.expectedRevision,
    });
    return done(op.taskId);
  }
  if (op.type === "cancel-task") {
    await source.reviseTask({
      commandId,
      taskId: op.taskId,
      expectedRevision: op.expectedRevision,
      execution: "cancelled",
    });
    return done(op.taskId);
  }
  if (op.type === "set-task-completed") {
    await source.completeTask({
      commandId,
      taskId: op.taskId,
      expectedRevision: op.expectedRevision,
      completed: op.completed,
    });
    return done(op.taskId);
  }
  if (op.type === "respond-task") {
    await source.respondTask({
      commandId,
      taskId: op.taskId,
      expectedRevision: op.expectedRevision,
      body: op.body,
    });
    return done(op.taskId);
  }
  if (op.type === "reorder-tasks") {
    await source.reorderTaskSelection({
      commandId,
      taskIds: op.taskIds,
      expectedOrderRevision: op.expectedOrderRevision,
      ...(op.move ? { move: op.move } : {}),
    });
    return done(op.move?.taskId ?? op.taskIds[0]!);
  }
  if (op.type === "script-command") {
    const script = op.command;
    if (script.action === "create-production") {
      await source.createScript({
        commandId,
        productionId: commandId,
        projectId: script.projectId,
        title: script.title,
      });
      return done(commandId);
    }
    if (script.action === "submit-candidate")
      throw new UnsentOperationError(
        "候选须由绑定真实生成输入的 Agent 提交；未执行客户端直接提交命令。",
      );
    const production = scriptLibraryEntryFromContent(
      await source.resolveContent({
        appId: "morphz.script-studio",
        appObjectId: script.productionId,
      }),
    );
    if (production.id !== script.productionId)
      throw new UnsentOperationError("剧本目录与所选剧本不一致，未执行操作。");
    if (script.action === "update-production") {
      await source.updateScript({
        commandId,
        contentId: production.contentId,
        expectedRevision: script.expectedRevision,
        title: script.title,
        brief: script.brief,
        reviewerPrincipalIds: script.reviewerPrincipalIds,
        template: script.template,
      });
      return done(script.productionId);
    }
    if (script.action === "create-item") {
      await source.createScriptItem({
        commandId,
        contentId: production.contentId,
        itemId: commandId,
        expectedActivityRevision: production.activityRevision,
        kind: script.kind,
        draft: await scriptDraftForDomain(source, script.draft),
      });
      return done(commandId);
    }
    if (script.action === "revise-item") {
      await source.reviseScriptItem({
        commandId,
        contentId: production.contentId,
        itemId: script.itemId,
        expectedRevision: script.expectedRevision,
        draft: await scriptDraftForDomain(source, script.draft),
      });
      return done(script.itemId);
    }
    if (script.action === "restore-item") {
      await source.restoreScriptItem({
        commandId,
        contentId: production.contentId,
        itemId: script.itemId,
        expectedRevision: script.expectedRevision,
        restoreRevision: script.restoreRevision,
      });
      return done(script.itemId);
    }
    if (
      script.action === "submit-review" ||
      script.action === "review-decision" ||
      script.action === "lock-item" ||
      script.action === "unlock-item"
    ) {
      await source.transitionScriptWorkflow({
        commandId,
        contentId: production.contentId,
        itemId: script.itemId,
        expectedRevision: script.expectedRevision,
        expectedWorkflowRevision: script.expectedWorkflowRevision,
        action: script.action,
        ...(script.action === "review-decision"
          ? { decision: script.decision, note: script.note }
          : script.action === "unlock-item"
            ? { note: script.reason }
            : {}),
      });
      return done(script.itemId);
    }
    if (script.action === "add-review" || script.action === "resolve-review") {
      await source.changeScriptReview({
        commandId,
        contentId: production.contentId,
        action: script.action,
        ...(script.action === "add-review"
          ? {
              itemId: script.itemId,
              itemRevision: script.itemRevision,
              quote: script.quote,
              body: script.body,
              severity: script.severity,
            }
          : {
              reviewId: script.reviewId,
              expectedRevision: script.expectedRevision,
              resolution: script.resolution,
            }),
      });
      return done(script.action === "add-review" ? commandId : script.reviewId);
    }
    if (script.action === "decide-candidate") {
      await source.decideScriptCandidate({
        commandId,
        contentId: production.contentId,
        candidateId: script.candidateId,
        expectedRevision: script.expectedRevision,
        decision: script.decision,
      });
      return done(script.candidateId);
    }
    if (script.action === "record-export") {
      await source.recordScriptExport({
        commandId,
        contentId: production.contentId,
        expectedRevision: script.expectedRevision,
        items: script.items,
        template: script.template,
        ...(script.workingCopy ? { workingCopy: true as const } : {}),
      });
      return done(commandId);
    }
  }
  if (
    op.type === "launch-application" ||
    op.type === "set-application-state" ||
    op.type === "close-application"
  ) {
    if (op.type === "launch-application") {
      const scriptState =
        op.scriptTarget === undefined
          ? {}
          : op.scriptTarget === null
            ? { view: "library", scriptTarget: null, navigationId: commandId }
            : {
                view: "editor",
                productionId: op.scriptTarget.productionId,
                itemId: op.scriptTarget.itemId ?? "",
                scriptTarget: op.scriptTarget,
                navigationId: commandId,
              };
      const nextState = applicationStateSchema.parse({
        ...(op.artifactId !== undefined ? { artifactId: op.artifactId } : {}),
        ...scriptState,
      });
      const instance = await source.launchAppView({
        commandId,
        projectId: op.workspaceId,
        appId: op.applicationId,
        packageVersion: op.applicationVersion,
        state: nextState,
      });
      return done(instance.id);
    }
    const instance =
      op.type === "close-application"
        ? await source.closeAppView({
            commandId,
            viewId: op.instanceId,
            expectedRevision: op.expectedRevision,
          })
        : await source.saveAppView({
            commandId,
            viewId: op.instanceId,
            expectedRevision: op.expectedRevision,
            state: op.state,
          });
    return done(instance.id);
  }
  throw new UnsentOperationError(
    `「${op.type}」尚未接通新数据模型；操作未写入旧库。`,
  );
}

/** A script or document command may commit its app-owned original before the
 * Platform directory projection fails. HTTP 4xx alone cannot prove that the
 * app transaction did not commit, so the next identical attempt must retain
 * the original command identity.
 */
export function operationMayCommitBeforeError(operation: Operation): boolean {
  return (
    operation.type === "install-application" ||
    operation.type === "launch-application" ||
    operation.type === "set-application-state" ||
    operation.type === "close-application" ||
    (operation.type === "update-project" && operation.state !== undefined) ||
    (operation.type === "organize-content" &&
      operation.changes.title !== undefined) ||
    operation.type === "script-command" ||
    operation.type === "import-document" ||
    (operation.type === "create-artifact" &&
      ["document", "image", "interactive"].includes(operation.content.kind)) ||
    (operation.type === "revise-artifact" &&
      ["document", "image", "interactive"].includes(operation.content.kind))
  );
}
export function useWorkspace() {
  const scriptEditorModels = useRef(
    new Map<string, { identity: string; value: ScriptEditorProduction }>(),
  );
  const scriptVersionTitles = useRef(new Map<string, string>());
  const approvalSubmissions = useRef(new Set<string>());
  const taskRuntimeReads = useRef(new Map<string, number>());
  const taskRuntimeReadGeneration = useRef(0);
  const [, updateApprovalSubmissions] = useState(0);
  const [boot, setBoot] = useState<Boot | null>(null),
    [contentCatalog, setContentCatalog] = useState<
      import("./platform-client.js").PlatformContent[]
    >([]),
    [contentCounts, setContentCounts] = useState<PlatformContentCount[]>([]),
    [taskCounts, setTaskCounts] = useState<
      import("./platform-client.js").PlatformTaskCount[]
    >([]),
    [contentCatalogVersion, setContentCatalogVersion] = useState(0),
    [online, setOnline] = useState(false),
    [error, setError] = useState(""),
    [authenticationRequired, setAuthenticationRequired] = useState(false);
  const current = useRef<Boot | null>(null),
    inputSends = useRef(new Map<string, Promise<Receipt>>()),
    platform = useRef<PlatformClient | null>(null),
    historyScope = useRef<HistoryScope | null>(null),
    historyCache = useRef<{
      version: string;
      catalogVersion: number;
      scope: HistoryScope;
      value: import("./platform-client.js").PlatformHistory;
    } | null>(null),
    catalogCache = useRef<PlatformNavigationCache | null>(null),
    scriptOverviews = useRef(new Map<string, ScriptOverview>()),
    pendingScriptOverviews = useRef(new Map<string, Promise<ScriptOverview>>()),
    protectedReadGeneration = useRef(0),
    navigationCacheKey = useRef(""),
    epoch = useRef(0),
    snapshotText = useRef(""),
    refreshing = useRef<Promise<boolean> | null>(null),
    loadingEarlier = useRef<Promise<void> | null>(null);
  function sendingInputIds(
    identity: Pick<Boot, "centerId" | "principalId" | "actantId">,
  ) {
    const scope = savedInputScope(identity) + ":";
    return new Set(
      [...inputSends.current.keys()]
        .filter((key) => key.startsWith(scope))
        .map((key) => key.slice(scope.length)),
    );
  }
  function publishSavedInputs(identity: Boot) {
    const latest = current.current;
    if (!latest || latest.csrfToken !== identity.csrfToken) return;
    const projection = withSavedInputs(
      withoutSavedInputs(latest.workspace, latest.localSavedInputIds),
      readSavedInputs(localStorage, savedInputScope(identity)),
      identity,
      sendingInputIds(identity),
    );
    const value = {
      ...latest,
      workspace: projection.workspace,
      localSavedInputIds: projection.localInputIds,
      localInputSubmissions: projection.submissions,
    };
    current.current = value;
    // A poll must not consider its pre-submit display snapshot current.
    snapshotText.current = "";
    setBoot(value);
  }
  function clearProtectedProjection() {
    protectedReadGeneration.current++;
    current.current = null;
    platform.current = null;
    historyScope.current = null;
    historyCache.current = null;
    catalogCache.current = null;
    scriptOverviews.current.clear();
    pendingScriptOverviews.current.clear();
    scriptEditorModels.current.clear();
    scriptVersionTitles.current.clear();
    navigationCacheKey.current = "";
    snapshotText.current = "";
    setBoot(null);
    setContentCatalog([]);
    setContentCounts([]);
    setTaskCounts([]);
    setContentCatalogVersion(0);
  }
  async function refresh() {
    if (refreshing.current) return refreshing.current;
    const version = epoch.current;
    refreshing.current = (async () => {
      try {
        const signal = AbortSignal.timeout(15000);
        const source = await PlatformClient.connect(
          { call: applicationCall },
          signal,
        );
        if (
          current.current &&
          (current.current.centerId !== source.boot.centerId ||
            current.current.principalId !== source.boot.principalId ||
            current.current.csrfToken !== source.boot.csrfToken)
        ) {
          clearProtectedProjection();
        }
        storageScope(source.boot.centerId, source.boot.principalId);
        const scope = `${source.boot.centerId}:${source.boot.principalId}`;
        const local = scopedStorage(scope);
        const instances = await source.appViews(signal);
        const savedInputs = readSavedInputs(
          localStorage,
          savedInputScope(source.boot),
        );
        const preferences = local.readLocal<{
          view?: string;
          projectId?: string;
          projectOpen?: boolean;
          artifactId?: string | null;
          artifactRevision?: number | null;
          selectedConversations?: Record<string, string>;
          scriptLocation?: { productionId: string } | null;
        }>("preferences", {});
        const contentScope = local.readLocal<{ scope?: string }>(
          "library-view:all-content",
          {},
        ).scope;
        const recentContentIds = contentVisits(
          local.readLocal<unknown>("recent-content", []),
        ).map((visit) => visit.artifactId);
        let requestedScope = historyScope.current;
        const preparedPersonal = !catalogCache.current
          ? await source.ensurePersonalSpaces(signal)
          : undefined;
        const navigation = await source.navigationRuntime(
          signal,
          requestedScope,
        );
        if (
          catalogCache.current &&
          catalogCache.current.revisions.access !== navigation.revisions.access
        ) {
          // Permission loss must clear displayed projections even when a
          // later page request fails. Unsubmitted local drafts are untouched.
          clearProtectedProjection();
          requestedScope = null;
        }
        const navigationKey = JSON.stringify({
          boot: source.boot,
          navigation,
          instances,
          preferences,
          contentScope,
          recentContentIds,
          requestedScope,
          savedInputIds: savedInputs.map((input) => input.commandId),
        });
        if (
          current.current &&
          catalogCache.current?.version === navigation.catalogVersion &&
          navigationCacheKey.current === navigationKey
        ) {
          platform.current = source;
          setOnline(true);
          setError("");
          return true;
        }
        const {
          workspace,
          runtime,
          historyScope: resolvedScope,
          history,
          catalog,
          contentDeliveries,
          scriptOutputs,
        } = await readPlatformWorkspace(
          source,
          instances,
          (current.current?.workspace.revision ?? 0) + 1,
          navigation.runtime,
          signal,
          current.current?.centerId === source.boot.centerId &&
            current.current.principalId === source.boot.principalId &&
            current.current.csrfToken === source.boot.csrfToken
            ? withoutSavedInputs(
                current.current.workspace,
                current.current.localSavedInputIds,
              )
            : undefined,
          {
            scope: requestedScope,
            preferences: { ...preferences, contentScope },
            recentContentIds,
          },
          historyCache.current?.catalogVersion === navigation.catalogVersion
            ? historyCache.current
            : undefined,
          reusableNavigationCatalog(
            catalogCache.current,
            navigation.catalogVersion,
            navigation.revisions,
          ),
          preparedPersonal,
          navigation.historyVersion,
        );
        const finalNavigation = await source.navigationRuntime(
          signal,
          requestedScope,
        );
        if (finalNavigation.revisions.access !== navigation.revisions.access)
          clearProtectedProjection();
        if (!navigationReadStillCurrent(navigation, finalNavigation))
          throw new RequestError(
            409,
            "目录在读取期间已更新，请重试。",
            "navigation_changed",
          );
        // Read at publication time: a poll may have started before the user
        // clicked Send. Only an authoritative same-ID input removes its overlay.
        const latestSaved = readSavedInputs(
          localStorage,
          savedInputScope(source.boot),
        );
        const knownInputs = new Map(
          workspace.inputs.map((input) => [input.id, input]),
        );
        const unconfirmed = latestSaved.filter((entry) => {
          const input = knownInputs.get(entry.commandId);
          if (
            !input ||
            input.author.principalId !== source.boot.principalId ||
            input.author.actantId !== source.boot.actantId
          )
            return true;
          removeSavedInput(
            localStorage,
            savedInputScope(source.boot),
            entry.commandId,
          );
          return false;
        });
        const savedProjection = withSavedInputs(
          workspace,
          unconfirmed,
          source.boot,
          sendingInputIds(source.boot),
        );
        const snapshot = {
          ...source.boot,
          workspace: savedProjection.workspace,
          scriptLibrary: catalog.scriptLibrary,
          runtime,
          localSavedInputIds: savedProjection.localInputIds,
          localInputSubmissions: savedProjection.submissions,
          activityByProject: navigation.activityByProject,
          outputs: contentDeliveries.flatMap((delivery) => {
            if (
              delivery.appId !== "morphz.objects" &&
              delivery.appId !== "morphz.reader"
            )
              return [];
            const revision = Number(delivery.versionRef);
            if (!Number.isSafeInteger(revision) || revision < 1) return [];
            return [
              {
                commandId: delivery.commandId,
                inputId: delivery.inputId,
                projectId: delivery.projectId,
                artifactId: delivery.contentId,
                revision,
                createdAt: delivery.committedAt,
              },
            ];
          }),
          scriptOutputs: [
            ...contentDeliveries.flatMap((delivery) => {
              if (
                delivery.appId !== "morphz.script-studio" ||
                delivery.operation !== "record-content"
              )
                return [];
              const revision = Number(delivery.versionRef);
              if (!Number.isSafeInteger(revision) || revision < 1) return [];
              return [
                {
                  commandId: delivery.commandId,
                  inputId: delivery.inputId,
                  projectId: delivery.projectId,
                  productionId: delivery.appObjectId,
                  kind: "production" as const,
                  title: delivery.title,
                  productionTitle: delivery.title,
                  revision,
                  createdAt: delivery.committedAt,
                },
              ];
            }),
            ...scriptOutputs,
          ],
          taskRuns: retainTaskRuntimeProjections(current.current, {
            ...source.boot,
            workspace,
          }),
          capabilities: {
            ...source.boot.capabilities,
            conversationOnFirstInput: true,
            agentDirectories: source.boot.capabilities.localFiles,
            taskCompletion: true,
          },
        };
        if (
          version !== epoch.current ||
          historyScope.current !== requestedScope
        )
          return false;
        historyScope.current = resolvedScope;
        historyCache.current =
          history && resolvedScope && navigation.historyVersion
            ? {
                version: navigation.historyVersion,
                catalogVersion: navigation.catalogVersion,
                scope: resolvedScope,
                value: history,
              }
            : null;
        catalogCache.current = {
          version: navigation.catalogVersion,
          revisions: navigation.revisions,
          value: catalog,
        };
        setContentCatalog(catalog.contents);
        setContentCounts(catalog.contentCounts);
        setTaskCounts(catalog.taskCounts);
        setContentCatalogVersion(navigation.catalogVersion);
        const serialized = JSON.stringify({
          ...snapshot,
          workspace: { ...snapshot.workspace, revision: 0 },
        });
        if (serialized !== snapshotText.current) {
          const value = bootSchema.parse(snapshot);
          if (version !== epoch.current) return false;
          // A slow snapshot must not replace newer state already rendered.
          if (
            !current.current ||
            value.centerId !== current.current.centerId ||
            value.principalId !== current.current.principalId ||
            value.workspace.revision >= current.current.workspace.revision
          ) {
            current.current = value;
            platform.current = source;
            snapshotText.current = serialized;
            navigationCacheKey.current = navigationKey;
            migrateLegacyLocalState(
              localStorage,
              value.centerId,
              value.principalId,
              value.capabilities.teamAuthentication,
              location.origin,
            );
            migrateApplicationLocalState(
              localStorage,
              value.centerId,
              value.principalId,
            );
            migrateContentLocalState(
              localStorage,
              value.centerId,
              value.principalId,
            );
            migrateReadingLocalState(
              localStorage,
              value.centerId,
              value.principalId,
            );
            // Main-process origin migration restores this window's exact draft owner.
            // Draft and pending-command keys are copied intact, never recreated/replayed.
            if (window.morphzDesktop)
              localStorage.setItem(
                `${applicationStoragePrefix}${value.centerId}:${value.principalId}:desktop:last-window`,
                draftOwner,
              );
            setBoot(value);
          }
        } else navigationCacheKey.current = navigationKey;
        setOnline(true);
        setError("");
        return true;
      } catch (e) {
        if (version !== epoch.current) return false;
        if (
          e instanceof RequestError &&
          (e.status === 401 || e.status === 403)
        ) {
          clearProtectedProjection();
        }
        if (e instanceof RequestError && e.status === 401) {
          storageScope("disconnected", "anonymous");
          setAuthenticationRequired(true);
        }
        setOnline(false);
        setError(
          e instanceof Error ? e.message : "暂时无法读取应用数据，请重试。",
        );
        return false;
      } finally {
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }
  async function listContentPage(
    options: Parameters<PlatformClient["content"]>[0],
    signal?: AbortSignal,
  ) {
    const source = platform.current;
    if (!source) throw new Error("内容目录暂不可用，请稍后重试。");
    return source.content(options, signal);
  }
  async function readProjectUnderstanding(
    projectId: string,
    revision?: number,
    signal?: AbortSignal,
  ) {
    const source = platform.current;
    if (!source) throw new Error("当前理解暂不可用，请稍后重试。");
    return source.projectUnderstanding(projectId, revision, signal);
  }
  async function countContent(
    options: Parameters<PlatformClient["contentCounts"]>[0],
    signal?: AbortSignal,
  ) {
    const source = platform.current;
    if (!source) throw new Error("内容目录暂不可用，请稍后重试。");
    return source.contentCounts(options, signal);
  }
  async function refreshAfterMutation() {
    // A poll started before a mutation or navigation can finish with an older
    // view. Let it settle, then read the latest state and local selection once.
    if (refreshing.current) await refreshing.current;
    return refresh();
  }
  async function selectHistoryScope(scope: HistoryScope) {
    if (
      historyScope.current?.projectId === scope.projectId &&
      historyScope.current.conversationId === scope.conversationId
    )
      return;
    historyScope.current = scope;
    if (refreshing.current) await refreshing.current;
    await refresh();
  }
  async function loadEarlierHistory() {
    if (loadingEarlier.current) return loadingEarlier.current;
    loadingEarlier.current = (async () => {
      if (refreshing.current) await refreshing.current;
      const cache = historyCache.current;
      const source = platform.current;
      let before = cache?.value.nextCursor;
      if (!cache || !source || !before) return;
      let history = cache.value;
      const signal = AbortSignal.timeout(15000);
      // A server window may contain only entries this reader cannot see.
      // Continue over a few empty windows so one click still reveals older
      // visible messages, while bounding both requests and total wait.
      for (let window = 0; window < 4 && before; window++) {
        const older = await source.history(
          cache.scope.projectId,
          cache.scope.conversationId,
          before,
          signal,
        );
        if (
          older.nextCursor &&
          (older.nextCursor.createdAt > before.createdAt ||
            (older.nextCursor.createdAt === before.createdAt &&
              older.nextCursor.id >= before.id))
        )
          throw new Error("历史分页位置没有前进，请重试。");
        if (
          historyCache.current !== cache ||
          current.current?.csrfToken !== source.boot.csrfToken ||
          historyScope.current?.projectId !== cache.scope.projectId ||
          historyScope.current?.conversationId !== cache.scope.conversationId
        )
          return;
        history = mergePlatformHistories(history, older, older.nextCursor);
        before = older.nextCursor;
        if (older.inputs.length || older.runtime.messages.length) break;
      }
      historyCache.current = {
        ...cache,
        value: history,
      };
      navigationCacheKey.current = "";
      await refresh();
    })().finally(() => {
      loadingEarlier.current = null;
    });
    return loadingEarlier.current;
  }
  async function loadHistoryUntil(messageId: string): Promise<boolean> {
    if (loadingEarlier.current) await loadingEarlier.current;
    const cache = historyCache.current;
    const source = platform.current;
    if (!cache || !source) return false;
    const contains = (
      history: import("./platform-client.js").PlatformHistory,
    ) =>
      history.inputs.some((input) => input.id === messageId) ||
      history.runtime.messages.some((message) => message.id === messageId);
    if (contains(cache.value)) return true;
    let found = false;
    loadingEarlier.current = (async () => {
      let history = cache.value;
      // A source jump is explicit. Read older authorized pages only on that
      // action, not during routine refresh or while the user scrolls.
      for (let page = 0; history.nextCursor && page < 200; page++) {
        const before = history.nextCursor;
        const older = await source.history(
          cache.scope.projectId,
          cache.scope.conversationId,
          before,
          AbortSignal.timeout(15000),
        );
        if (
          older.nextCursor &&
          (older.nextCursor.createdAt > before.createdAt ||
            (older.nextCursor.createdAt === before.createdAt &&
              older.nextCursor.id >= before.id))
        )
          throw new Error("历史分页位置没有前进，请重试。");
        if (
          historyCache.current !== cache ||
          current.current?.csrfToken !== source.boot.csrfToken ||
          historyScope.current?.projectId !== cache.scope.projectId ||
          historyScope.current?.conversationId !== cache.scope.conversationId
        )
          throw new Error("对话已切换或更新，请重新打开引用。");
        history = mergePlatformHistories(history, older, older.nextCursor);
        found = contains(history);
        if (found) break;
      }
      historyCache.current = { ...cache, value: history };
      navigationCacheKey.current = "";
      await refresh();
      if (!found && history.nextCursor)
        throw new Error(
          "引用仍在更早的记录中；已加载旧消息，请再点一次查看原文。",
        );
    })().finally(() => {
      loadingEarlier.current = null;
    });
    await loadingEarlier.current;
    return found;
  }
  function rememberContent(
    entry: import("./platform-client.js").PlatformContent,
    generation: string,
  ) {
    if (current.current?.csrfToken !== generation) return;
    const cache = catalogCache.current;
    if (!cache) return;
    const existing = cache.value.contents.find((item) => item.id === entry.id);
    if (
      existing?.revision === entry.revision &&
      existing.projectId === entry.projectId &&
      existing.title === entry.title &&
      existing.observedVersionRef === entry.observedVersionRef
    )
      return;
    const headContents = cache.value.headContents.map((item) =>
      item.id === entry.id ? entry : item,
    );
    const headIds = new Set(headContents.map((item) => item.id));
    const references = cache.value.contents
      .filter((item) => !headIds.has(item.id) && item.id !== entry.id)
      .slice(-149);
    if (!headIds.has(entry.id)) references.push(entry);
    const contents = [...headContents, ...references];
    cache.value = {
      ...cache.value,
      headContents,
      contents,
      scriptLibrary: contents
        .filter(
          (item) =>
            item.appId === "morphz.script-studio" &&
            item.kind === "script" &&
            item.availability === "available",
        )
        .map(scriptLibraryEntryFromContent),
    };
    setContentCatalog(contents);
  }
  async function resolveArtifact(id: string, revision?: number) {
    const readGeneration = protectedReadGeneration.current;
    const readIdentity = current.current?.csrfToken;
    const checkRead = () => {
      if (
        protectedReadGeneration.current !== readGeneration ||
        current.current?.csrfToken !== readIdentity
      )
        throw new Error("身份或访问范围已变化，内容未读取。");
    };
    const task = catalogCache.current?.value.tasks.find(
      (item) => item.id === id,
    );
    const existing = current.current?.workspace.artifacts.find(
      (artifact) => artifact.id === id,
    );
    if (
      task &&
      existing?.content.kind === "task" &&
      existing.revision === task.revision &&
      existing.versions.length < task.revision
    ) {
      const identity = current.current;
      const source = platform.current;
      if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
        throw new Error("身份已变化，事项未读取。");
      const full = await readTaskArtifact(
        source,
        task,
        true,
        AbortSignal.timeout(15000),
      );
      checkRead();
      const latest = current.current;
      if (!latest || latest.csrfToken !== identity.csrfToken)
        throw new Error("身份已变化，事项未读取。");
      const currentTask = latest.workspace.artifacts.find(
        (artifact) => artifact.id === id,
      );
      if (
        currentTask?.revision !== full.revision ||
        currentTask.projectId !== full.projectId ||
        currentTask.updatedAt !== task.updatedAt
      ) {
        await refresh();
        checkRead();
        return current.current?.workspace.artifacts.find(
          (artifact) => artifact.id === id,
        );
      }
      const updated = {
        ...latest,
        workspace: {
          ...latest.workspace,
          revision: latest.workspace.revision + 1,
          artifacts: latest.workspace.artifacts.map((artifact) =>
            artifact.id === id ? full : artifact,
          ),
        },
      };
      current.current = updated;
      setBoot(updated);
      return full;
    }
    if (task && existing) {
      checkRead();
      return existing;
    }
    const identity = current.current;
    const source = platform.current;
    if (identity && source && source.boot.csrfToken === identity.csrfToken) {
      // Explicit opens must consult the current authorized directory, even
      // when a previously opened object is cached in the presentation model.
      let entry;
      try {
        entry = await source.getContent(id);
        checkRead();
      } catch (error) {
        checkRead();
        if (!(error instanceof RequestError) || error.status !== 404)
          throw error;
        // Tasks are Platform objects, not entries in the content catalog.
        // A message link can open one without loading the entire task list.
        const head = await source.taskHead(id);
        checkRead();
        const full = await readTaskArtifact(
          source,
          head,
          true,
          AbortSignal.timeout(15000),
        );
        checkRead();
        if (revision && revision > full.revision)
          throw new Error("指定版本尚未进入事项目录，请稍后重试。");
        const latest = current.current;
        if (!latest || latest.csrfToken !== identity.csrfToken)
          throw new Error("身份已变化，事项未读取。");
        const cache = catalogCache.current;
        if (cache)
          cache.value = {
            ...cache.value,
            tasks: [
              ...cache.value.tasks.filter((task) => task.id !== id),
              head,
            ],
          };
        const updated = {
          ...latest,
          workspace: {
            ...latest.workspace,
            revision: latest.workspace.revision + 1,
            artifacts: [
              ...latest.workspace.artifacts.filter(
                (artifact) => artifact.id !== id,
              ),
              full,
            ],
          },
        };
        current.current = updated;
        setBoot(updated);
        return full;
      }
      checkRead();
      rememberContent(entry, identity.csrfToken);
      if (entry && entry.availability !== "available")
        throw new Error("内容原件当前不可用，请稍后重试。");
      if (entry && ["morphz.objects", "morphz.reader"].includes(entry.appId)) {
        const sameOriginal =
          existing?.content.kind !== "task" &&
          existing?.revision.toString() === entry.observedVersionRef;
        const currentArtifact = sameOriginal
          ? {
              ...existing,
              projectId: entry.projectId,
              catalogRevision: entry.revision,
              title: entry.title,
              updatedAt: entry.updatedAt,
            }
          : await readContentArtifact(
              source,
              entry,
              AbortSignal.timeout(15000),
            );
        checkRead();
        if (!currentArtifact)
          throw new Error("内容原件暂时不可用，请稍后重试。");
        if (revision && revision > currentArtifact.revision)
          throw new Error("指定版本尚未进入内容目录，请稍后重试。");
        const hasRequestedVersion =
          !revision ||
          revision === currentArtifact.revision ||
          currentArtifact.versions.some(
            (version) => version.revision === revision,
          );
        if (
          sameOriginal &&
          existing?.catalogRevision === entry.revision &&
          existing.projectId === entry.projectId &&
          existing.title === entry.title &&
          existing.updatedAt === entry.updatedAt &&
          hasRequestedVersion
        )
          return currentArtifact;
        const historical =
          revision && !hasRequestedVersion
            ? await readContentArtifact(
                source,
                entry,
                AbortSignal.timeout(15000),
                revision,
              )
            : null;
        checkRead();
        if (revision && !hasRequestedVersion && !historical)
          throw new Error("指定版本暂时不可用，请稍后重试。");
        const latest = current.current;
        if (!latest || latest.csrfToken !== identity.csrfToken)
          throw new Error("身份已变化，内容未读取。");
        const latestEntry = catalogCache.current?.value.contents.find(
          (item) => item.id === id,
        );
        if (
          latestEntry &&
          (latestEntry.revision > entry.revision ||
            (latestEntry.revision === entry.revision &&
              (latestEntry.projectId !== entry.projectId ||
                latestEntry.observedVersionRef !== entry.observedVersionRef)))
        )
          throw new Error("内容目录已变化，请重试打开。");
        const latestArtifact = latest.workspace.artifacts.find(
          (artifact) => artifact.id === id,
        );
        if (
          latestArtifact &&
          existing &&
          (latestArtifact.revision !== existing.revision ||
            latestArtifact.projectId !== existing.projectId)
        )
          throw new Error("内容已变化，请重试打开。");
        const versions = new Map(
          [
            ...(latestArtifact?.versions ?? []),
            ...currentArtifact.versions,
            ...(historical?.versions ?? []),
          ].map((version) => [version.revision, version]),
        );
        const resolved: Artifact = {
          ...currentArtifact,
          versions: [...versions.values()].sort(
            (a, b) => a.revision - b.revision,
          ),
        };
        const updated = {
          ...latest,
          workspace: {
            ...latest.workspace,
            revision: latest.workspace.revision + 1,
            artifacts: [
              ...latest.workspace.artifacts.filter(
                (artifact) => artifact.id !== id,
              ),
              resolved,
            ],
          },
        };
        current.current = updated;
        setBoot(updated);
        return resolved;
      }
    }
    if (!current.current?.workspace.artifacts.some((a) => a.id === id)) {
      await refresh();
      checkRead();
      // An in-flight poll may predate the object returned by search.
      if (!current.current?.workspace.artifacts.some((a) => a.id === id)) {
        await refresh();
        checkRead();
      }
    }
    checkRead();
    return current.current?.workspace.artifacts.find((a) => a.id === id);
  }
  function scriptReadSession() {
    const identity = current.current,
      source = platform.current;
    const generation = protectedReadGeneration.current;
    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，剧本未读取。");
    const check = () => {
      if (
        current.current?.csrfToken !== identity.csrfToken ||
        protectedReadGeneration.current !== generation
      )
        throw new Error("身份或访问范围已变化，剧本未读取。");
    };
    return { identity, source, check };
  }
  async function readScriptEditorPage<
    K extends ScriptEditorPageRequest["panel"],
  >(
    production: ScriptEditorProduction,
    panel: K,
    itemId?: string,
  ): Promise<ScriptPanel<K>> {
    const { identity, check } = scriptReadSession();
    const result = await collectEditorPage(
      async (request) => {
        const value = await applicationCall("scripts.editor.page", request, {
          identityGeneration: identity.csrfToken,
        });
        check();
        return value;
      },
      production,
      panel,
      itemId,
    );
    check();
    return result;
  }
  async function readScriptEditor(
    productionId: string,
  ): Promise<ScriptEditorProduction> {
    const { identity, source, check } = scriptReadSession();
    const catalog = await source.resolveContent({
      appId: "morphz.script-studio",
      appObjectId: productionId,
    });
    check();
    const head = parseEditorHead(
      catalog,
      await applicationCall(
        "scripts.editor.head",
        { contentId: catalog.id },
        { identityGeneration: identity.csrfToken },
      ),
    );
    check();
    const cached = scriptEditorModels.current.get(productionId);
    if (
      cached?.identity === identity.csrfToken &&
      cached.value.activityRevision === head.activityRevision &&
      cached.value.catalogRevision === head.catalogRevision &&
      cached.value.providerRevision === head.providerRevision
    ) {
      rememberContent(catalog, identity.csrfToken);
      return cached.value;
    }
    const directory = await collectEditorPage(
      async (request) => {
        const value = await applicationCall("scripts.editor.page", request, {
          identityGeneration: identity.csrfToken,
        });
        check();
        return value;
      },
      head,
      "directory",
    );
    const confirmed = await source.getContent(catalog.id);
    check();
    if (
      confirmed.revision !== catalog.revision ||
      confirmed.providerRevision !== catalog.providerRevision ||
      confirmed.observedVersionRef !== catalog.observedVersionRef
    )
      throw new Error("剧本目录已变化，请重试打开。");
    const model: ScriptEditorProduction = { ...head, items: directory.items };
    scriptEditorModels.current.set(productionId, {
      identity: identity.csrfToken,
      value: model,
    });
    if (scriptEditorModels.current.size > 64)
      scriptEditorModels.current.delete(
        scriptEditorModels.current.keys().next().value!,
      );
    rememberContent(confirmed, identity.csrfToken);
    return model;
  }
  function getScriptEditor(productionId: string) {
    const cached = scriptEditorModels.current.get(productionId);
    const entry = current.current?.scriptLibrary.find(
      (value) => value.id === productionId,
    );
    if (
      !cached ||
      !entry ||
      cached.identity !== current.current?.csrfToken ||
      entry.catalogRevision !== cached.value.catalogRevision ||
      entry.activityRevision !== cached.value.activityRevision
    )
      return undefined;
    return cached.value;
  }
  async function readScriptVersion(
    production: ScriptEditorProduction,
    itemId: string,
    revision?: number,
  ) {
    const { identity, source, check } = scriptReadSession();
    const version = await parseEditorVersion(
      source,
      await source.readScriptItem(production.contentId, itemId, revision),
    );
    check();
    if (
      version.productionId !== production.id ||
      version.itemId !== itemId ||
      (revision !== undefined && version.revision !== revision)
    )
      throw new Error("剧本条目版本不一致，请重试。");
    scriptVersionTitles.current.set(
      `${identity.csrfToken}:${production.id}:${itemId}:${version.revision}`,
      version.draft.title,
    );
    if (scriptVersionTitles.current.size > 512)
      scriptVersionTitles.current.delete(
        scriptVersionTitles.current.keys().next().value!,
      );
    return version;
  }
  async function readScriptCandidate(
    production: ScriptEditorProduction,
    candidateId: string,
  ) {
    const { identity, source, check } = scriptReadSession();
    const value = await applicationCall(
      "scripts.editor.detail",
      {
        contentId: production.contentId,
        kind: "candidate",
        objectId: candidateId,
      },
      { identityGeneration: identity.csrfToken },
    );
    const candidate = await parseEditorCandidate(source, value);
    check();
    if (candidate.id !== candidateId)
      throw new Error("候选稿身份不一致，请重试。");
    return candidate;
  }
  async function readScriptVersionTitle(
    production: ScriptEditorProduction,
    itemId: string,
    revision: number,
  ) {
    const { identity, check } = scriptReadSession();
    const key = `${identity.csrfToken}:${production.id}:${itemId}:${revision}`;
    const cached = scriptVersionTitles.current.get(key);
    if (cached !== undefined) return cached;
    const value = scriptVersionTitleSchema.parse(
      await applicationCall(
        "scripts.editor.detail",
        {
          contentId: production.contentId,
          kind: "item-version-title",
          objectId: itemId,
          revision,
        },
        { identityGeneration: identity.csrfToken },
      ),
    );
    check();
    if (
      value.productionId !== production.id ||
      value.itemId !== itemId ||
      value.revision !== revision
    )
      throw new Error("剧本条目版本不一致，请重试。");
    scriptVersionTitles.current.set(key, value.title);
    if (scriptVersionTitles.current.size > 512)
      scriptVersionTitles.current.delete(
        scriptVersionTitles.current.keys().next().value!,
      );
    return value.title;
  }
  async function readScriptReview(
    production: ScriptEditorProduction,
    reviewId: string,
  ) {
    const { identity, check } = scriptReadSession();
    const value = scriptReviewDetailSchema.parse(
      await applicationCall(
        "scripts.editor.detail",
        {
          contentId: production.contentId,
          kind: "review",
          objectId: reviewId,
        },
        { identityGeneration: identity.csrfToken },
      ),
    );
    check();
    if (value.id !== reviewId) throw new Error("审阅意见身份不一致，请重试。");
    return value;
  }
  async function readScriptExport(
    production: ScriptEditorProduction,
    exportId: string,
  ) {
    const { identity, check } = scriptReadSession();
    const value = scriptExportDetailSchema.parse(
      await applicationCall(
        "scripts.editor.detail",
        {
          contentId: production.contentId,
          kind: "export",
          objectId: exportId,
        },
        { identityGeneration: identity.csrfToken },
      ),
    );
    check();
    if (value.id !== exportId) throw new Error("导出记录身份不一致，请重试。");
    return value;
  }
  async function readScriptContext(
    production: ScriptEditorProduction,
    revision: number,
  ) {
    const { identity, check } = scriptReadSession();
    const value = scriptProductionSchema.shape.metadataHistory.element.parse(
      await applicationCall(
        "scripts.editor.detail",
        {
          contentId: production.contentId,
          kind: "context",
          revision,
        },
        { identityGeneration: identity.csrfToken },
      ),
    );
    check();
    if (value.revision !== revision)
      throw new Error("剧本规范版本不一致，请重试。");
    return value;
  }
  async function readScriptExportManifest(
    production: ScriptEditorProduction,
    exportId: string,
  ): Promise<ScriptDocxManifest> {
    const { check } = scriptReadSession();
    const record = await readScriptExport(production, exportId);
    const metadata = await readScriptContext(
      production,
      record.contextRevision,
    );
    const versions: ScriptDocxManifest["versions"] = [];
    const loaded = new Set<string>();
    let sourceCharacters = 2;
    const read = async (itemId: string, revision: number) => {
      const key = `${itemId}:${revision}`;
      if (loaded.has(key)) return;
      const value = await readScriptVersion(production, itemId, revision);
      check();
      const version = {
        id: itemId,
        kind: value.kind,
        revision: value.revision,
        draft: value.draft,
      };
      sourceCharacters +=
        JSON.stringify(version).length + (versions.length ? 1 : 0);
      if (sourceCharacters > scriptDocxLimits.sourceCharacters)
        throw new Error("原文过大，请拆分为较少集数导出。");
      versions.push(version);
      loaded.add(key);
    };
    if (record.items.length > scriptDocxLimits.items)
      throw new Error("导出条目数量过多。");
    for (const ref of record.items) await read(ref.itemId, ref.revision);
    const selected = [...versions];
    for (const version of selected)
      for (const ref of version.draft.dependencies)
        await read(ref.itemId, ref.revision);
    check();
    return { productionId: production.id, record, metadata, versions };
  }
  async function resolveScriptLocation(target: ScriptLocation) {
    const { check } = scriptReadSession();
    const production = await readScriptEditor(target.productionId);
    const item = production.items.find((value) => value.id === target.itemId);
    if (target.itemId && !item) return null;
    if (target.revision && item)
      await readScriptVersion(production, item.id, target.revision);
    if (target.candidateId) {
      const candidate = await readScriptCandidate(
        production,
        target.candidateId,
      );
      if (
        candidate.targetId !== item?.id ||
        candidate.baseRevision !== target.revision
      )
        return null;
    }
    if (target.reviewId) {
      const review = await readScriptReview(production, target.reviewId);
      if (review.itemId !== item?.id || review.itemRevision !== target.revision)
        return null;
    }
    check();
    return { production, item };
  }
  async function resolveCatalogContent(contentId: string) {
    const readGeneration = protectedReadGeneration.current;
    const identity = current.current;
    const source = platform.current;
    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，内容未读取。");
    try {
      const entry = await source.getContent(contentId);
      if (
        current.current?.csrfToken !== identity.csrfToken ||
        protectedReadGeneration.current !== readGeneration
      )
        throw new Error("身份已变化，内容未读取。");
      rememberContent(entry, identity.csrfToken);
      return entry;
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) return null;
      throw error;
    }
  }
  async function readScriptOverview(
    entry: import("./platform-client.js").ScriptLibraryEntry,
  ): Promise<ScriptOverview> {
    const identity = current.current;
    const source = platform.current;
    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，剧本未读取。");
    const key = `${identity.csrfToken}:${entry.contentId}:${entry.catalogRevision}:${entry.activityRevision}`;
    // The visible card came from an authorized scoped page. The owning app
    // rechecks current access when it reads the original; a global startup
    // snapshot is neither necessary nor an authority for this operation.
    return readCachedScriptOverview(
      key,
      scriptOverviews.current,
      pendingScriptOverviews.current,
      protectedReadGeneration,
      () => source.readScript(entry.contentId),
      (overview) => {
        const latest = current.current;
        if (
          !latest ||
          latest.csrfToken !== identity.csrfToken ||
          overview.contentId !== entry.contentId ||
          overview.productionId !== entry.id ||
          overview.projectId !== entry.projectId ||
          overview.title !== entry.title ||
          overview.activityRevision !== entry.activityRevision
        )
          throw new Error("剧本目录与应用原件不一致，请刷新后重试。");
      },
    );
  }
  async function login(token: string) {
    epoch.current++;
    await applicationCall(
      "login",
      { token },
      { signal: AbortSignal.timeout(8000) },
    );
    if (refreshing.current) await refreshing.current;
    protectedReadGeneration.current++;
    scriptEditorModels.current.clear();
    scriptVersionTitles.current.clear();
    current.current = null;
    platform.current = null;
    historyScope.current = null;
    historyCache.current = null;
    catalogCache.current = null;
    scriptOverviews.current.clear();
    pendingScriptOverviews.current.clear();
    navigationCacheKey.current = "";
    snapshotText.current = "";
    setBoot(null);
    setAuthenticationRequired(false);
    await refresh();
  }
  async function logout() {
    if (!current.current) return;
    await applicationCall("logout", undefined, {
      identityGeneration: current.current.csrfToken,
      signal: AbortSignal.timeout(8000),
    });
    // Drop the mounted workspace and all in-memory object state immediately.
    epoch.current++;
    protectedReadGeneration.current++;
    scriptEditorModels.current.clear();
    scriptVersionTitles.current.clear();
    current.current = null;
    platform.current = null;
    historyScope.current = null;
    historyCache.current = null;
    catalogCache.current = null;
    scriptOverviews.current.clear();
    pendingScriptOverviews.current.clear();
    navigationCacheKey.current = "";
    snapshotText.current = "";
    setBoot(null);
    setAuthenticationRequired(true);
    storageScope("disconnected", "anonymous");
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5000);
    const wake = () => void refresh();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);
  async function submitSavedInput(
    identity: Boot,
    entry: LocalSavedInput,
    onStaged?: (inputId: string) => void,
  ): Promise<Receipt> {
    const scope = savedInputScope(identity);
    const key = scope + ":" + entry.commandId;
    const pending = inputSends.current.get(key);
    if (pending) return pending;
    const source = platform.current;
    if (!source || current.current?.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，消息未发送。");
    const staged = { ...entry, submission: { state: "sending" as const } };
    // Persist the frozen payload before transport; retries never use the editor.
    saveInputLocally(localStorage, scope, staged);
    const request = Promise.resolve().then(() =>
      executePlatformOperation(
        source,
        identity,
        { commandId: entry.commandId, operation: entry.operation },
        true,
      ),
    );
    inputSends.current.set(key, request);
    publishSavedInputs(identity);
    onStaged?.(entry.commandId);
    try {
      const receipt = await request;
      // A concurrent history refresh may already have confirmed this input.
      if (
        readSavedInputs(localStorage, scope).some(
          (input) => input.commandId === entry.commandId,
        )
      )
        saveInputLocally(localStorage, scope, {
          ...entry,
          submission: { state: "accepted" },
        });
      return receipt;
    } catch (error) {
      if (
        readSavedInputs(localStorage, scope).some(
          (input) => input.commandId === entry.commandId,
        )
      )
        saveInputLocally(localStorage, scope, {
          ...entry,
          submission: {
            state: "failed",
            error:
              error instanceof Error ? error.message : "发送失败，点击重试。",
          },
        });
      throw error;
    } finally {
      inputSends.current.delete(key);
      publishSavedInputs(identity);
      // Submission success does not depend on an expensive catalog refresh.
      // Keep the same bubble until history supplies its authoritative same-ID row.
      if (current.current?.csrfToken === identity.csrfToken)
        void refreshAfterMutation();
    }
  }
  async function execute(
    operation: Operation,
    dispatch = false,
    applicationInstanceId?: string,
    externalCommandId?: string,
    onInputStaged?: (inputId: string) => void,
  ): Promise<Receipt> {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    const identity = current.current,
      scope = `${identity.centerId}:${identity.principalId}`,
      { readLocal, writeLocal } = scopedStorage(scope);
    if (
      operation.type === "record-input" &&
      operation.conversationId &&
      !operation.newConversation &&
      readSavedInputs(localStorage, savedInputScope(identity)).some(
        (input) =>
          input.operation.conversationId === operation.conversationId &&
          input.operation.newConversation,
      )
    )
      throw new Error("请先发送这段对话中已保存的第一条消息。");
    if (operation.type === "record-input") {
      const commandId = externalCommandId ?? crypto.randomUUID();
      const existing = readSavedInputs(
        localStorage,
        savedInputScope(identity),
      ).find((input) => input.commandId === commandId);
      const parsed = operationSchema.parse(operation);
      if (
        existing &&
        JSON.stringify(existing.operation) !== JSON.stringify(parsed)
      )
        throw new Error("这条消息已保存，请从原消息重试；新草稿未发送。");
      const entry: LocalSavedInput = existing ?? {
        commandId,
        createdAt: new Date().toISOString(),
        operation: parsed as LocalSavedInput["operation"],
      };
      if (dispatch) return submitSavedInput(identity, entry, onInputStaged);
      saveInputLocally(localStorage, savedInputScope(identity), entry);
      publishSavedInputs(identity);
      onInputStaged?.(commandId);
      return {
        commandId,
        entityId: commandId,
        workspaceRevision: identity.workspace.revision,
      };
    }
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify({
          operation,
          dispatch,
          applicationInstanceId,
          externalCommandId,
        }),
      ),
    );
    const key = draftKey(
      "pending:" +
        Array.from(new Uint8Array(hash), (v) =>
          v.toString(16).padStart(2, "0"),
        ).join(""),
    );
    if (current.current?.csrfToken !== identity.csrfToken)
      throw new Error("身份已切换，操作未发送。");
    const command = readLocal<{
      commandId: string;
      operation: Operation;
      applicationInstanceId?: string;
    } | null>(key, null) ?? {
      commandId: externalCommandId ?? crypto.randomUUID(),
      operation,
      ...(applicationInstanceId ? { applicationInstanceId } : {}),
    };
    // Save retry identity before sending. A lost reply must not duplicate a mutation after reload.
    writeLocal(key, command);
    try {
      const source = platform.current;
      if (!source || source.boot.csrfToken !== identity.csrfToken)
        throw new Error("身份已变化，操作未发送。");
      const receipt = await executePlatformOperation(
        source,
        identity,
        command,
        dispatch,
      );
      writeLocal(key, null);
      await refreshAfterMutation();
      return receipt;
    } catch (e) {
      if (e instanceof UnsentOperationError) writeLocal(key, null);
      if (e instanceof RequestError) {
        // A server error can occur after commit. Keep its identity until a
        // successful receipt or a definitive client-side rejection is known.
        if (
          e.status < 500 &&
          e.status !== 408 &&
          !operationMayCommitBeforeError(operation)
        )
          writeLocal(key, null);
        await refreshAfterMutation();
      }
      throw e;
    }
  }
  async function listObjectAnnotations(
    contentId: string,
    signal?: AbortSignal,
  ) {
    const identity = current.current;
    const source = platform.current;
    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，批注未读取。");
    const annotations: Workspace["annotations"] = [];
    let afterOrdinal: number | undefined;
    for (let page = 0; page < 100; page++) {
      const rows = z
        .array(
          z.object({
            ordinal: z.number().int().nonnegative(),
            annotation: stateSchema.shape.annotations.element,
          }),
        )
        .parse(
          await source.listObjectAnnotations(
            contentId,
            {
              limit: 100,
              ...(afterOrdinal === undefined ? {} : { afterOrdinal }),
            },
            signal,
          ),
        );
      annotations.push(...rows.map((row) => row.annotation));
      if (rows.length < 100) return annotations;
      const last = rows.at(-1)!.ordinal;
      if (afterOrdinal !== undefined && last <= afterOrdinal)
        throw new Error("批注分页游标未推进。");
      afterOrdinal = last;
    }
    throw new Error("批注数量超过当前可读取范围。");
  }
  async function workRelationsFor(objectId: string, signal?: AbortSignal) {
    const identity = current.current;
    const source = platform.current;
    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，关联未读取。");
    return source.allWorkRelations(objectId, signal);
  }
  async function bookmarkList(
    request: {
      query?: string;
      url?: string;
      deleted?: boolean;
      offset?: number;
      limit?: number;
    } = {},
  ) {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    if (!identity.capabilities.browserBookmarks)
      throw new Error("浏览器收藏尚未接通新数据模型。");
    return z.array(bookmarkSchema).parse(
      await applicationCall("bookmarks.list", request, {
        identityGeneration: identity.csrfToken,
        signal: AbortSignal.timeout(8000),
      }),
    );
  }
  async function bookmarkCommand(operation: BookmarkOperation) {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    if (!identity.capabilities.browserBookmarks)
      throw new Error("浏览器收藏尚未接通新数据模型。");
    const scope = savedInputScope(identity);
    const { readLocal, writeLocal } = scopedStorage(scope);
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(operation)),
    );
    const key = draftKey(
      "pending:bookmark:" +
        Array.from(new Uint8Array(hash), (value) =>
          value.toString(16).padStart(2, "0"),
        ).join(""),
    );
    if (current.current?.csrfToken !== identity.csrfToken)
      throw new Error("身份已切换，操作未发送。");
    const command = readLocal<{
      commandId: string;
      operation: BookmarkOperation;
    } | null>(key, null) ?? {
      commandId: crypto.randomUUID(),
      operation,
    };
    writeLocal(key, command);
    try {
      const receipt = await applicationCall("bookmarks.command", command, {
        identityGeneration: identity.csrfToken,
        signal: AbortSignal.timeout(8000),
      });
      writeLocal(key, null);
      return receipt;
    } catch (error) {
      if (
        error instanceof RequestError &&
        error.status < 500 &&
        error.status !== 408
      )
        writeLocal(key, null);
      throw error;
    }
  }
  async function upload(
    file: File,
  ): Promise<{ assetId: string; mime: string }> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    return applicationCall(
      "asset.add",
      new Uint8Array(await file.arrayBuffer()),
      { identityGeneration: identity.csrfToken },
    ) as Promise<{
      assetId: string;
      mime: string;
    }>;
  }
  async function uploadAttachment(file: File): Promise<{
    assetId: string;
    mime: import("../../../packages/core/src/model.js").InputAttachment["mime"];
  }> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    return applicationCall(
      "attachment.add",
      {
        name: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
      },
      { identityGeneration: identity.csrfToken },
    ) as Promise<{
      assetId: string;
      mime: import("../../../packages/core/src/model.js").InputAttachment["mime"];
    }>;
  }
  async function importPdf(
    file: File,
    projectId: string,
    relativePath: string,
  ): Promise<{ entityId: string }> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    const data = new Uint8Array(await file.arrayBuffer());
    return runPendingFileImport(
      { method: "pdf.import", projectId, relativePath, bytes: data },
      scopedStorage(`${identity.centerId}:${identity.principalId}`),
      (commandId) => {
        if (current.current?.csrfToken !== identity.csrfToken)
          throw new Error("身份已切换，文件未发送。");
        return applicationCall(
          "pdf.import",
          { commandId, projectId, relativePath, data },
          {
            identityGeneration: identity.csrfToken,
            signal: AbortSignal.timeout(30000),
          },
        ) as Promise<{ entityId: string }>;
      },
      async () => {
        if (!(await refreshAfterMutation()))
          throw new Error("导入已提交，但内容目录尚未刷新；请重试同一文件。");
        if (current.current?.csrfToken !== identity.csrfToken)
          throw new Error("身份已切换，导入结果尚未确认。");
      },
    );
  }
  async function dispatchInput(inputId: string) {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    const scope = savedInputScope(identity);
    const saved = readSavedInputs(localStorage, scope);
    const local = saved.find((item) => item.commandId === inputId);
    if (local) {
      if (!identity.runtime.configured)
        throw new Error("连接 Agent 后才能发送这条本机保存的消息。");
      if (
        local.operation.conversationId &&
        saved.some(
          (item) =>
            item.commandId !== inputId &&
            item.operation.conversationId === local.operation.conversationId &&
            item.operation.newConversation,
        )
      )
        throw new Error("请先发送这段对话中已保存的第一条消息。");
      await submitSavedInput(identity, local);
    } else
      await applicationCall("input.send", inputId, {
        identityGeneration: identity.csrfToken,
      });
    if (!local) await refreshAfterMutation();
  }
  async function importReading(
    file: File,
    projectId: string,
  ): Promise<{ entityId: string }> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    const data = new Uint8Array(await file.arrayBuffer());
    return runPendingFileImport(
      {
        method: "reader.import",
        projectId,
        relativePath: file.name,
        bytes: data,
      },
      scopedStorage(`${identity.centerId}:${identity.principalId}`),
      (commandId) => {
        if (current.current?.csrfToken !== identity.csrfToken)
          throw new Error("身份已切换，文件未发送。");
        return applicationCall(
          "reader.import",
          {
            commandId,
            projectId,
            relativePath: file.name,
            data,
          },
          {
            identityGeneration: identity.csrfToken,
            signal: AbortSignal.timeout(35000),
          },
        ) as Promise<{ entityId: string }>;
      },
      async () => {
        if (!(await refreshAfterMutation()))
          throw new Error("导入已提交，但内容目录尚未刷新；请重试同一文件。");
        if (current.current?.csrfToken !== identity.csrfToken)
          throw new Error("身份已切换，导入结果尚未确认。");
      },
    );
  }
  async function readReading(
    artifactId: string,
    revision: number,
    sectionId: string,
    signal?: AbortSignal,
  ): Promise<ReadingSection> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    const generation = protectedReadGeneration.current;
    const result = (await applicationCall(
      "reader.read",
      { artifactId, revision, sectionId },
      {
        identityGeneration: identity.csrfToken,
        signal,
      },
    )) as ReadingSection;
    if (
      signal?.aborted ||
      current.current?.csrfToken !== identity.csrfToken ||
      protectedReadGeneration.current !== generation
    )
      throw new Error("阅读权限已变化，请重新读取。");
    return result;
  }
  async function readingOcr(
    request: import("../../../packages/core/src/reader-ocr.js").ReaderOcrRequest,
    signal?: AbortSignal,
  ): Promise<
    import("../../../packages/core/src/reader-ocr.js").ReaderOcrStatus
  > {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    return applicationCall("reader.ocr", request, {
      identityGeneration: identity.csrfToken,
      signal,
    }) as Promise<
      import("../../../packages/core/src/reader-ocr.js").ReaderOcrStatus
    >;
  }
  async function readingContents(
    artifactId: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<Array<{ id: string; title: string; characters: number }>> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    return (await applicationCall(
      "reader.contents",
      { artifactId, revision },
      {
        identityGeneration: identity.csrfToken,
        signal,
      },
    )) as Array<{ id: string; title: string; characters: number }>;
  }
  async function readingState(
    artifactId: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<{
    position: z.infer<typeof readingStateSchema> | null;
  }> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    const generation = protectedReadGeneration.current;
    const raw = (await applicationCall(
      "reader.state",
      { artifactId, revision },
      {
        identityGeneration: identity.csrfToken,
        signal,
      },
    )) as {
      position: null | {
        location: unknown;
        preferences: unknown;
        revision: number;
        updatedAt: string;
      };
    };
    if (
      signal?.aborted ||
      current.current?.csrfToken !== identity.csrfToken ||
      protectedReadGeneration.current !== generation
    )
      throw new Error("阅读权限已变化，请重新读取。");
    return {
      position: raw.position
        ? readingStateSchema.parse({
            location: raw.position.location,
            preferences: raw.position.preferences,
            revision: raw.position.revision,
            updatedAt: raw.position.updatedAt,
            artifactId,
            artifactRevision: revision,
            ownerPrincipalId: identity.principalId,
          })
        : null,
    };
  }
  async function readingMarks(
    request: ReaderMarksRead,
    signal?: AbortSignal,
  ): Promise<ReadingMarksPage> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    const query = readerMarksReadSchema.parse(request);
    const generation = protectedReadGeneration.current;
    const raw = (await applicationCall("reader.marks", query, {
      identityGeneration: identity.csrfToken,
      signal,
    })) as {
      marks: Array<Record<string, unknown>>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    if (
      signal?.aborted ||
      current.current?.csrfToken !== identity.csrfToken ||
      protectedReadGeneration.current !== generation
    )
      throw new Error("阅读权限已变化，请重新读取。");
    if (
      raw.marks.length > 50 ||
      typeof raw.hasMore !== "boolean" ||
      !(raw.nextCursor === null || typeof raw.nextCursor === "string")
    )
      throw new Error("标注分页结果无效。");
    return {
      nextCursor: raw.nextCursor,
      hasMore: raw.hasMore,
      marks: raw.marks.map((mark) =>
        readingMarkSchema.parse({
          id: mark.id,
          location: mark.location,
          quote: mark.quote,
          kind: mark.kind,
          color: mark.color,
          note: mark.note,
          revision: mark.revision,
          createdAt: mark.createdAt,
          updatedAt: mark.updatedAt,
          deletedAt: mark.deletedAt,
          artifactId: query.artifactId,
          artifactRevision: query.revision,
          ownerPrincipalId: identity.principalId,
        }),
      ),
    };
  }
  async function readerCommand(
    artifactId: string,
    revision: number,
    command: ReaderCommand,
  ): Promise<{ id: string; revision: number }> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    const scope = `${identity.centerId}:${identity.principalId}`;
    const { readLocal, writeLocal } = scopedStorage(scope);
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify({ artifactId, revision, command }),
      ),
    );
    const key = draftKey(
      "pending:reader:" +
        Array.from(new Uint8Array(hash), (value) =>
          value.toString(16).padStart(2, "0"),
        ).join(""),
    );
    const pending = readLocal<{ commandId: string } | null>(key, null) ?? {
      commandId: crypto.randomUUID(),
    };
    writeLocal(key, pending);
    try {
      if (current.current?.csrfToken !== identity.csrfToken)
        throw new Error("身份已切换，阅读操作未发送。");
      const receipt = (await applicationCall(
        "reader.command",
        {
          commandId: pending.commandId,
          artifactId,
          revision,
          command,
        },
        {
          identityGeneration: identity.csrfToken,
          signal: AbortSignal.timeout(12000),
        },
      )) as { id: string; revision: number };
      writeLocal(key, null);
      return receipt;
    } catch (error) {
      if (
        error instanceof RequestError &&
        error.status < 500 &&
        error.status !== 408
      )
        writeLocal(key, null);
      throw error;
    }
  }
  async function verifyArtifact(id: string) {
    const identity = current.current;
    const source = platform.current;
    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，事项未读取。");
    // A notification can point to an authorized task outside the current
    // page. The presentation cache is not an authorization decision.
    await source.taskHead(id, AbortSignal.timeout(8000));
    if (current.current?.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，事项未读取。");
  }
  async function cancelInput(inputId: string) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    await applicationCall("input.cancel", inputId, {
      identityGeneration: current.current.csrfToken,
      signal: AbortSignal.timeout(8000),
    });
    await refreshAfterMutation();
  }
  async function search(
    request: SearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    return applicationCall("search", request, {
      identityGeneration: current.current.csrfToken,
      signal: signal ?? AbortSignal.timeout(8000),
    }) as Promise<SearchResult>;
  }
  async function executionSnapshot(scope: ExecutionScope) {
    return executionSnapshotSchema.parse(
      await applicationCall("execution.snapshot", scope, {
        signal: AbortSignal.timeout(12000),
      }),
    );
  }
  async function taskRuntime(
    taskId: string,
    control?: {
      run: number;
      revision: number;
      action: "pause" | "resume" | "cancel" | "stop";
    },
  ) {
    const origin = current.current;
    if (!origin) throw new Error("应用尚未就绪，请稍后重试。");
    const generation = ++taskRuntimeReadGeneration.current;
    taskRuntimeReads.current.set(taskId, generation);
    try {
      const view = taskRuntimeSchema.parse(
        await applicationCall(
          control ? "task.control" : "task.snapshot",
          control ? { id: taskId, ...control } : taskId,
          {
            identityGeneration: origin.csrfToken,
            signal: AbortSignal.timeout(12000),
          },
        ),
      );
      // List and detail reads supply the same board/filter projection. These
      // observations never authorize operations or introduce a storage authority.
      if (
        taskRuntimeReads.current.get(taskId) === generation &&
        taskRuntimeResponseStillCurrent(origin, current.current, taskId) &&
        JSON.stringify(current.current!.taskRuns[taskId]) !==
          JSON.stringify(view)
      ) {
        const updated = {
          ...current.current!,
          taskRuns: { ...current.current!.taskRuns, [taskId]: view },
        };
        current.current = updated;
        setBoot(updated);
      }
      return view;
    } finally {
      if (taskRuntimeReads.current.get(taskId) === generation)
        taskRuntimeReads.current.delete(taskId);
    }
  }
  async function taskResponses(taskId: string) {
    const identity = current.current;
    const source = platform.current;
    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，无法读取事项回应。");
    return (
      await source.allTaskResponses(taskId, AbortSignal.timeout(12000))
    ).map((response) => ({
      id: response.id,
      taskId: response.taskId,
      taskRevision: response.taskRevision,
      body: response.body,
      author: {
        principalId: response.authorPrincipalId,
        actantId: response.authorActantId,
      },
      createdAt: response.createdAt,
    }));
  }
  async function executionResult(scope: ExecutionScope, jobId: string) {
    return z
      .object({
        text: z.string(),
        truncated: z.boolean(),
        available: z.boolean(),
      })
      .parse(
        await applicationCall(
          "execution.result",
          { scope, jobId },
          { signal: AbortSignal.timeout(12000) },
        ),
      );
  }
  async function controlExecution(command: ExecutionControl) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    if (
      command.action.type === "allow-once" ||
      command.action.type === "deny"
    ) {
      const key = JSON.stringify([
        current.current.csrfToken,
        command.action.approvalId,
        command.action.fingerprint,
      ]);
      if (approvalSubmissions.current.has(key))
        throw new Error("本次审批已提交，请核对最新执行状态，不要重复批准。");
      approvalSubmissions.current.add(key);
      updateApprovalSubmissions((version) => version + 1);
    }
    return applicationCall("execution.control", command, {
      identityGeneration: current.current.csrfToken,
      signal: AbortSignal.timeout(12000),
    });
  }
  function approvalSubmitted(approvalId: string, fingerprint: string) {
    return approvalSubmissions.current.has(
      JSON.stringify([current.current?.csrfToken, approvalId, fingerprint]),
    );
  }
  async function speechStatus(signal?: AbortSignal) {
    return z
      .object({
        configured: z.boolean(),
        provider: z.string().min(1).nullable(),
        providerLabel: z.string().min(1).nullable().optional(),
        segmentSeconds: z.number().optional(),
        streaming: z.boolean().optional(),
      })
      .parse(await applicationCall("speech.status", undefined, { signal }));
  }
  function createSpeechStream(scope: SpeechScope) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    const identityGeneration = current.current.csrfToken,
      id = crypto.randomUUID();
    type Action = SpeechStreamCommand extends infer T
      ? T extends SpeechStreamCommand
        ? Omit<T, "scope" | "id">
        : never
      : never;
    return async (command: Action, signal: AbortSignal) =>
      speechStreamStateSchema.parse(
        await applicationCall(
          "speech.stream",
          { ...command, id, scope },
          { identityGeneration, signal },
        ),
      );
  }
  async function transcribe(
    scope: SpeechScope,
    wav: Blob,
    signal: AbortSignal,
  ) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    const identityGeneration = current.current.csrfToken;
    return z
      .object({ text: z.string().max(30000) })
      .parse(
        await applicationCall(
          "speech.transcribe",
          { scope, data: await wav.arrayBuffer() },
          { identityGeneration, signal },
        ),
      ).text;
  }
  async function synthesize(
    scope: SpeechScope,
    text: string,
    signal: AbortSignal,
  ) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    const data = await applicationCall(
      "speech.synthesize",
      { scope, text },
      { identityGeneration: current.current.csrfToken, signal },
    );
    if (!(data instanceof Uint8Array)) throw new Error("语音响应格式无效。");
    return new Blob([new Uint8Array(data)], { type: "audio/wav" });
  }
  return {
    notifications: async (
      command?:
        | {
            action: "settings";
            mode: "all" | "off";
            commandId: string;
            expectedRevision: number;
          }
        | {
            action: "read";
            ids: string[];
            commandId: string;
            expectedRevision: number;
          },
    ) => {
      if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
      return applicationCall(
        command ? "notifications.control" : "notifications.read",
        command,
        {
          identityGeneration: current.current.csrfToken,
          signal: AbortSignal.timeout(6000),
        },
      );
    },
    checkConnection: async (signal: AbortSignal) =>
      connectionDetailsSchema.parse(
        await applicationCall("connection.check", undefined, { signal }),
      ),
    configureConnection: async (
      params: ConfigureConnection,
      signal: AbortSignal,
    ) =>
      connectionDetailsSchema.parse(
        await applicationCall("connection.configure", params, { signal }),
      ),
    authenticationRequired,
    login,
    logout,
    speechStatus,
    createSpeechStream,
    transcribe,
    synthesize,
    taskRuntime,
    taskResponses,
    boot,
    contentCatalog,
    contentCounts,
    taskCounts,
    contentCatalogVersion,
    contentVersionTitle: (contentId: string, revision?: number) =>
      contentVersionTitle(
        contentId,
        revision,
        current.current?.workspace.artifacts ?? [],
        catalogCache.current?.value.contents ?? [],
        catalogCache.current?.value.versionTitles,
      ),
    listContentPage,
    readProjectUnderstanding,
    countContent,
    // Read the refreshed identity-bound snapshot after an awaited command.
    // React's captured boot value may still refer to the previous render.
    getSnapshot: () => current.current,
    online,
    error,
    refresh,
    refreshView: refreshAfterMutation,
    selectHistoryScope,
    loadEarlierHistory,
    loadHistoryUntil,
    olderHistoryCursor: historyCache.current?.value.nextCursor ?? null,
    resolveArtifact,
    resolveScriptLocation,
    readScriptEditor,
    getScriptEditor,
    readScriptEditorPage,
    readScriptVersion,
    readScriptVersionTitle,
    readScriptCandidate,
    readScriptReview,
    readScriptExport,
    readScriptContext,
    readScriptExportManifest,
    scriptVersionTitle: (
      productionId: string,
      itemId: string,
      revision: number,
    ) =>
      scriptVersionTitles.current.get(
        `${current.current?.csrfToken}:${productionId}:${itemId}:${revision}`,
      ),
    resolveCatalogContent,
    readScriptOverview,
    listObjectAnnotations,
    workRelationsFor,
    execute,
    bookmarkList,
    bookmarkCommand,
    upload,
    uploadAttachment,
    importPdf,
    importReading,
    readReading,
    readingContents,
    readingState,
    readingMarks,
    readerCommand,
    readingOcr,
    dispatchInput,
    verifyArtifact,
    cancelInput,
    search,
    executionSnapshot,
    executionResult,
    controlExecution,
    approvalSubmitted,
  };
}
export type WorkspaceClient = ReturnType<typeof useWorkspace>;
export function actorName(state: Workspace, id: string) {
  return state.actants.find((a) => a.id === id)?.name ?? "未知参与者";
}
