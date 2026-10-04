import { useEffect, useRef, useState } from "react";
import { interactiveRowEdits } from "../../../packages/core/src/interactive.js";
import { migrateContentLocalState } from "./content-local-migration.js";
import { z } from "zod";
import { scriptOutputSchema } from "../../../packages/core/src/script-delivery.js";
import {
  speechStreamStateSchema,
  type SpeechStreamCommand,
} from "../../../packages/core/src/speech-stream.js";
import {
  connectionDetailsSchema,
  type ConfigureConnection,
} from "../../../packages/core/src/connection.js";
import { taskRuntimeSchema } from "../../../packages/core/src/task-runtime.js";
import { retainTaskRuntimeProjections } from "./task-runtime-projection.js";
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
  withoutSavedInputs,
  inputSubmissionSchema,
} from "./local-saved-inputs.js";
import {
  applicationCall,
  RequestError,
  subscribeWorkspaceChanges,
} from "./application-transport.js";
import { createRefreshDrain } from "./refresh-drain.js";
import {
  PlatformClient,
  scriptLibraryEntrySchema,
  type PlatformContentCount,
  type ScriptOverview,
} from "./platform-client.js";
import type { LiveScriptDraft } from "../../../packages/script-studio/src/store.js";
import type { ScriptDraft } from "../../../packages/core/src/script-studio.js";
import type { ScriptEditorProduction } from "./script-editor-reader.js";
import { createScriptEditorReads } from "./data/script-editor-reads.js";
import { createContentReads } from "./data/content-reads.js";
import { createReaderReads } from "./data/reader-reads.js";
import { createTaskInteractions } from "./data/task-interactions.js";
import { createLocalInputDelivery } from "./data/local-input-delivery.js";
import { createExecutionInteractions } from "./data/execution-interactions.js";
import {
  readPlatformWorkspace,
  reusableNavigationCatalog,
  navigationReadStillCurrent,
  readCachedScriptOverview,
  type PlatformNavigationCache,
  contentVersionTitle,
  scriptLibraryEntryFromContent,
} from "./platform-workspace-view.js";
import {
  createConversationHistory,
  type ConversationHistory,
} from "./data/conversation-history.js";
import { contentVisits } from "./recent-content.js";
import { runPendingFileImport } from "./pending-file-import.js";
export { RequestError } from "./application-transport.js";
import type { ReaderCommand } from "../../../packages/core/src/reader.js";
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
  stateSchema,
  taskContentSchema,
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
    [workspaceChangeRevision, setWorkspaceChangeRevision] = useState(0),
    [workspaceConnection, setWorkspaceConnection] = useState<
      "connecting" | "connected" | "reconnecting"
    >("connecting"),
    [online, setOnline] = useState(false),
    [error, setError] = useState(""),
    [authenticationRequired, setAuthenticationRequired] = useState(false);
  const current = useRef<Boot | null>(null),
    inputSends = useRef(new Map<string, Promise<Receipt>>()),
    platform = useRef<PlatformClient | null>(null),
    history = useRef<ConversationHistory | null>(null),
    catalogCache = useRef<PlatformNavigationCache | null>(null),
    scriptOverviews = useRef(new Map<string, ScriptOverview>()),
    pendingScriptOverviews = useRef(new Map<string, Promise<ScriptOverview>>()),
    protectedReadGeneration = useRef(0),
    navigationCacheKey = useRef(""),
    epoch = useRef(0),
    snapshotText = useRef(""),
    refreshing = useRef<Promise<boolean> | null>(null),
    refreshDrain = useRef<ReturnType<typeof createRefreshDrain> | null>(null);
  history.current ??= createConversationHistory({
    connection: () => {
      const source = platform.current;
      return source
        ? {
            identityGeneration: source.boot.csrfToken,
            readPage: (scope, before, signal) =>
              source.history(
                scope.projectId,
                scope.conversationId,
                before,
                signal,
              ),
          }
        : undefined;
    },
    currentIdentity: () => current.current?.csrfToken,
    pendingRefresh: () => refreshing.current,
    refreshProjection: refresh,
    invalidateProjectionReuse: () => {
      navigationCacheKey.current = "";
    },
  });
  const conversationHistory = history.current;
  const contentReads = createContentReads({
    platform,
    current,
    protectedReadGeneration,
    catalogCache,
    publishCatalog: setContentCatalog,
    publishScriptLibrary: (entries) => {
      const latest = current.current;
      if (!latest) return;
      if (
        latest.scriptLibrary.length === entries.length &&
        latest.scriptLibrary.every((existing, index) => {
          const entry = entries[index]!;
          return (
            existing.id === entry.id &&
            existing.contentId === entry.contentId &&
            existing.projectId === entry.projectId &&
            existing.title === entry.title &&
            existing.updatedAt === entry.updatedAt &&
            existing.catalogRevision === entry.catalogRevision &&
            existing.activityRevision === entry.activityRevision
          );
        })
      )
        return;
      const updated = { ...latest, scriptLibrary: entries };
      current.current = updated;
      setBoot(updated);
    },
    publishArtifact: (updated) => {
      current.current = updated;
      setBoot(updated);
    },
    refresh,
  });
  const rememberContent = contentReads.rememberContent;
  const scriptEditorReads = createScriptEditorReads({
    session: scriptReadSession,
    call: applicationCall,
    models: scriptEditorModels,
    titles: scriptVersionTitles,
    currentIdentity: () => current.current?.csrfToken,
    currentEntry: (productionId) =>
      current.current?.scriptLibrary.find((value) => value.id === productionId),
    rememberContent,
  });
  const readerReads = createReaderReads({
    current,
    protectedReadGeneration,
    call: applicationCall,
  });
  const taskInteractions = createTaskInteractions({
    current,
    platform,
    taskRuntimeReads,
    taskRuntimeReadGeneration,
    call: applicationCall,
    publishBoot: setBoot,
  });
  const localInputDelivery = createLocalInputDelivery({
    inputSends,
    current,
    platform,
    snapshotText,
    storage: () => localStorage,
    savedInputScope,
    executePlatformOperation,
    setBoot,
    refreshAfterMutation,
    call: applicationCall,
  });
  const executionInteractions = createExecutionInteractions({
    current,
    approvalSubmissions,
    updateApprovalSubmissions,
    call: applicationCall,
    refreshAfterMutation,
  });
  function clearProtectedProjection() {
    protectedReadGeneration.current++;
    current.current = null;
    platform.current = null;
    conversationHistory.clear();
    catalogCache.current = null;
    scriptOverviews.current.clear();
    pendingScriptOverviews.current.clear();
    scriptEditorReads.clear();
    navigationCacheKey.current = "";
    snapshotText.current = "";
    setBoot(null);
    setContentCatalog([]);
    setContentCounts([]);
    setTaskCounts([]);
    setContentCatalogVersion(0);
  }
  function refresh() {
    refreshDrain.current ??= createRefreshDrain(refreshOnce);
    const pending = refreshDrain.current.request();
    refreshing.current = pending;
    const settled = () => {
      if (refreshing.current === pending) refreshing.current = null;
    };
    void pending.then(settled, settled);
    return pending;
  }
  async function refreshOnce() {
    const version = epoch.current;
    return (async () => {
      try {
        const signal = AbortSignal.timeout(15000);
        const source = await PlatformClient.connect(
          { call: applicationCall },
          signal,
        );
        if (version !== epoch.current) return false;
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
        const savedInputs = localInputDelivery.readSaved(source.boot);
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
        let requestedScope = conversationHistory.captureSelection();
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
        const readCatalogCache = catalogCache.current;
        const readCatalogValue = readCatalogCache?.value;
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
            confirmedScriptContentIds: [
              ...new Set(
                (readCatalogValue?.contents ?? [])
                  .filter(
                    (entry) =>
                      entry.appId === "morphz.script-studio" &&
                      entry.kind === "script" &&
                      entry.availability === "available" &&
                      !readCatalogValue?.headContents.some(
                        (head) => head.id === entry.id,
                      ),
                  )
                  .map((entry) => entry.id),
              ),
            ].slice(0, 150),
          },
          conversationHistory.cachedForCatalog(navigation.catalogVersion),
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
        if (
          version !== epoch.current ||
          !conversationHistory.isSelectionCurrent(requestedScope)
        )
          return false;
        if (
          readCatalogCache &&
          catalogCache.current === readCatalogCache &&
          readCatalogCache.value !== readCatalogValue
        ) {
          // An explicit content read published a newer authorized projection.
          // Re-read through the existing drain before any snapshot writes.
          void refresh();
          return false;
        }
        // Read at publication time: a refresh may have started before the user
        // clicked Send. Only an authoritative same-ID input removes its overlay.
        const savedProjection = localInputDelivery.confirmAndProject(
          workspace,
          source,
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
        conversationHistory.commitProjection(
          resolvedScope,
          history,
          navigation.historyVersion,
          navigation.catalogVersion,
        );
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
      }
    })();
  }
  async function refreshAfterMutation() {
    // A read started before a mutation or navigation can finish with an older
    // view. Let it settle, then read the latest state and local selection once.
    if (refreshing.current) await refreshing.current;
    return refresh();
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
    scriptEditorReads.clear();
    current.current = null;
    platform.current = null;
    conversationHistory.clear();
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
    scriptEditorReads.clear();
    current.current = null;
    platform.current = null;
    conversationHistory.clear();
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
    // Startup and foregrounding reconcile authoritative state after sleep or
    // best-effort filesystem hints. Healthy idle windows do no periodic reads.
    const wake = () => {
      if (document.visibilityState === "visible") {
        // Independent domains (Profile, reading marks, bookmarks, annotations)
        // also reconcile after best-effort SQLite hints were lost during sleep.
        setWorkspaceChangeRevision((value) => value + 1);
        void refresh();
      }
    };
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);
  useEffect(() => {
    const expected = boot?.csrfToken;
    if (!expected || authenticationRequired) return;
    setWorkspaceConnection("connecting");
    return subscribeWorkspaceChanges(
      (change) => {
        if (current.current?.csrfToken !== expected) return;
        if (change.accessChanged) {
          // Invalidate in-flight publication as well as mounted private data.
          // Drafts and unsent input are deliberately not part of this clear.
          epoch.current++;
          clearProtectedProjection();
        }
        // This is only a local invalidation token, never a database revision
        // or authority. Profile/Reader projections have their own read APIs.
        setWorkspaceChangeRevision((value) => value + 1);
        void refresh();
      },
      {
        onConnected: () => {
          if (current.current?.csrfToken !== expected) return;
          setWorkspaceConnection("connected");
        },
        onClosed: () => {
          if (current.current?.csrfToken !== expected) return;
          // Losing change hints does not mean the authoritative RPC channel
          // is unavailable. Keep drafts and usable commands available while
          // the transport reconnects and requests its resync snapshot.
          setWorkspaceConnection("reconnecting");
        },
      },
    );
  }, [
    boot?.centerId,
    boot?.principalId,
    boot?.csrfToken,
    authenticationRequired,
  ]);
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
    if (operation.type === "record-input")
      return localInputDelivery.recordInput(
        identity,
        operation,
        dispatch,
        externalCommandId,
        onInputStaged,
      );
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
  async function readingOcr(
    request: import("../../../packages/core/src/reader-ocr.js").ReaderOcrRequest,
    signal?: AbortSignal,
    identityGeneration?: string,
  ): Promise<
    import("../../../packages/core/src/reader-ocr.js").ReaderOcrStatus
  > {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    if (identityGeneration && identityGeneration !== identity.csrfToken)
      throw new Error("阅读权限已变化，请重新读取。");
    const result = (await applicationCall("reader.ocr", request, {
      identityGeneration: identity.csrfToken,
      signal,
    })) as import("../../../packages/core/src/reader-ocr.js").ReaderOcrStatus;
    if (signal?.aborted || current.current?.csrfToken !== identity.csrfToken)
      throw new Error("阅读权限已变化，请重新读取。");
    return result;
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
    taskRuntime: taskInteractions.taskRuntime,
    taskResponses: taskInteractions.taskResponses,
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
    listContentPage: contentReads.listContentPage,
    readProjectUnderstanding: contentReads.readProjectUnderstanding,
    countContent: contentReads.countContent,
    // Read the refreshed identity-bound snapshot after an awaited command.
    // React's captured boot value may still refer to the previous render.
    getSnapshot: () => current.current,
    online,
    error,
    workspaceConnection,
    workspaceChangeRevision,
    refresh,
    refreshView: refreshAfterMutation,
    selectHistoryScope: conversationHistory.selectScope,
    loadEarlierHistory: conversationHistory.loadEarlier,
    loadHistoryUntil: conversationHistory.loadUntil,
    olderHistoryCursor: conversationHistory.olderCursor,
    resolveArtifact: contentReads.resolveArtifact,
    resolveScriptLocation: scriptEditorReads.resolveScriptLocation,
    readScriptEditor: scriptEditorReads.readScriptEditor,
    getScriptEditor: scriptEditorReads.getScriptEditor,
    readScriptEditorPage: scriptEditorReads.readScriptEditorPage,
    readScriptVersion: scriptEditorReads.readScriptVersion,
    readScriptVersionTitle: scriptEditorReads.readScriptVersionTitle,
    readScriptCandidate: scriptEditorReads.readScriptCandidate,
    readScriptReview: scriptEditorReads.readScriptReview,
    readScriptExport: scriptEditorReads.readScriptExport,
    readScriptContext: scriptEditorReads.readScriptContext,
    readScriptExportManifest: scriptEditorReads.readScriptExportManifest,
    scriptVersionTitle: scriptEditorReads.scriptVersionTitle,
    resolveCatalogContent: contentReads.resolveCatalogContent,
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
    readReading: readerReads.readReading,
    readingContents: readerReads.readingContents,
    readingState: readerReads.readingState,
    readingMarks: readerReads.readingMarks,
    readerCommand,
    readingOcr,
    dispatchInput: localInputDelivery.dispatchInput,
    verifyArtifact: taskInteractions.verifyArtifact,
    cancelInput: executionInteractions.cancelInput,
    search,
    executionSnapshot: executionInteractions.executionSnapshot,
    executionResult: executionInteractions.executionResult,
    controlExecution: executionInteractions.controlExecution,
    approvalSubmitted: executionInteractions.approvalSubmitted,
  };
}
export type WorkspaceClient = ReturnType<typeof useWorkspace>;
export function actorName(state: Workspace, id: string) {
  return state.actants.find((a) => a.id === id)?.name ?? "未知参与者";
}
