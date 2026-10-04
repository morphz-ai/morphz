import { interactiveRowEdits } from "../../packages/core/src/interactive.js";
import { applicationStateSchema } from "../../packages/core/src/applications.js";
import {
  contentOrganizationChangesSchema,
  taskContentSchema,
  type Operation,
  type Receipt,
} from "../../packages/core/src/model.js";
import type { ScriptDraft } from "../../packages/core/src/script-studio.js";
import type { LiveScriptDraft } from "../../packages/script-studio/src/store.js";
import type { Boot } from "../../apps/web/src/client.js";
import type { PlatformClient } from "../../apps/web/src/platform-client.js";
import { scriptLibraryEntryFromContent } from "../../apps/web/src/platform-workspace-view.js";
import type { OperationDeliveryPorts } from "../../apps/web/src/data/operation-delivery.js";
import {
  scopedStorage,
  draftKey,
} from "../../apps/web/src/local-preferences.js";
import {
  applicationCall,
  RequestError,
} from "../../apps/web/src/application-transport.js";
import {
  annotateObjectOperation,
  linkWorkOperation,
} from "../../apps/web/src/data/object-interactions.js";

// Independently captured actual committed Git618. Complete six algorithms occur
// once as executable source; metadata archives exact raw spans, not current Client.
// Only exports/dispatcher name and necessary import relocation are adapters.
export const fixedOperationDelivery = {
  baseline: "618fc8b96f56cc6447f1b2471f46c1d24fabbc57",
  sourcePath: "application/apps/web/src/client.ts",
  sourceSha256:
    "9ebae7905eb452603733f7412bfb6c18403a5a295749e43e6180623e08c7c8e8",
  spans: {
    scriptDraftForDomain: {
      sha256:
        "ce8c4ab2fe3a3e8c846d34271d36522cf0038784b3d5d01ce01ea3f6f2298143",
      bytes: 656,
      start: 5004,
      end: 5618,
      line: 143,
    },
    executePlatformOperation: {
      sha256:
        "16b9f02e7d60fd22ae4cbdcd101155fdff7e0f691aa3abe13b4eadd001e0f8eb",
      bytes: 19060,
      start: 5620,
      end: 24238,
      line: 163,
    },
    operationMayCommitBeforeError: {
      sha256:
        "dbcf9934302bf32c23ad044ba2c62f30be7550f7bb685bbb9f34d1142d9be92c",
      bytes: 793,
      start: 24510,
      end: 25303,
      line: 752,
    },
    execute: {
      sha256:
        "b88b48a857f2d2ab81d1dbc2344c0588c2e65fc855a79d51f31b5e13f3f1b6ed",
      bytes: 2538,
      start: 48818,
      end: 51282,
      line: 1414,
    },
    refreshAfterMutation: {
      sha256:
        "928bedc568e51edc0b126de20bf16654321006fef148bbbe11287a9fdc7c84d3",
      bytes: 279,
      start: 43023,
      end: 43302,
      line: 1260,
    },
    UnsentOperationError: {
      sha256:
        "1a5c141470ceb0ef72df401810bcb30c23881c7c0109205b64a62d429d8a9316",
      bytes: 43,
      start: 4959,
      end: 5002,
      line: 141,
    },
  },
} as const;

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

export async function fixedExecutePlatformOperation(
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
  if (op.type === "annotate")
    return annotateObjectOperation(
      source,
      op,
      commandId,
      done,
      UnsentOperationError,
    );
  if (op.type === "link-artifacts")
    return linkWorkOperation(source, op, commandId, done);
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

export { UnsentOperationError as FixedUnsentOperationError };

export function createFixedOperationDelivery(options: OperationDeliveryPorts) {
  const {
    current,
    platform,
    localInputDelivery,
    executePlatformOperation,
    refreshAfterMutation,
  } = options;
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
  return { execute };
}

export function createFixedRefreshAfterMutation({
  refreshing,
  refresh,
}: {
  refreshing: { readonly current: Promise<boolean> | null };
  refresh: () => Promise<boolean>;
}) {
  async function refreshAfterMutation() {
    // A read started before a mutation or navigation can finish with an older
    // view. Let it settle, then read the latest state and local selection once.
    if (refreshing.current) await refreshing.current;
    return refresh();
  }
  return refreshAfterMutation;
}
