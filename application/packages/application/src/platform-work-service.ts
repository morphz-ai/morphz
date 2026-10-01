import { z } from "zod";
import { reasoningEffortSchema } from "../../core/src/inference.js";
import { applicationStateSchema } from "../../core/src/applications.js";
import {
  PlatformStore,
  PlatformStorageError,
  type ContentDeliveryRow,
  type ContentRow,
  type ConversationRow,
  type PlatformActor,
  type ProjectRow,
  type TaskListRow,
  type TaskResponseRow,
  type TaskVersionRow,
  type PriorRuntimeObservation,
  type TaskWatchSourceReader,
} from "../../platform/src/store.js";
import type { RuntimeBridge } from "./runtime.js";
import { morphzAgentAccess } from "../../core/src/model.js";
import {
  searchSchema,
  type SearchHit,
  type SearchResult,
} from "../../core/src/retrieval.js";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const pageSize = z.number().int().min(1).max(100);
const timestamp = z.string().datetime({ offset: false });

const projectPage = z
  .object({
    status: z.enum(["active", "archived", "deleted", "all"]).optional(),
    query: z.string().max(200).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
    limit: pageSize.optional(),
    after: z
      .object({ updatedAt: timestamp, projectId: id })
      .strict()
      .optional(),
  })
  .strict();
const projectCreate = z
  .object({ commandId: id, projectId: id, title: z.string() })
  .strict();
const projectRename = z
  .object({
    commandId: id,
    projectId: id,
    expectedRevision: z.number().int().positive(),
    title: z.string(),
  })
  .strict();
const projectState = z
  .object({
    commandId: id,
    projectId: id,
    expectedRevision: z.number().int().positive(),
    state: z.enum(["active", "archived", "deleted"]),
  })
  .strict();
const projectLookup = z.object({ projectId: id }).strict();
const projectUnderstandingLookup = z
  .object({
    projectId: id,
    revision: z.number().int().positive().optional(),
  })
  .strict();
const appViewLaunch = z
  .object({
    commandId: id,
    projectId: id,
    appId: z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/),
    packageVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    state: applicationStateSchema,
  })
  .strict();
const appViewChange = z
  .object({
    commandId: id,
    viewId: id,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const appViewSave = appViewChange
  .extend({ state: applicationStateSchema })
  .strict();
const conversationPage = z
  .object({
    projectId: id,
    archived: z.boolean().optional(),
    limit: pageSize.optional(),
    after: z
      .object({ updatedAt: timestamp, conversationId: id })
      .strict()
      .optional(),
  })
  .strict();
const conversationNavigationPage = z
  .object({
    limit: pageSize.optional(),
    after: z
      .object({ updatedAt: timestamp, conversationId: id })
      .strict()
      .optional(),
  })
  .strict();
const conversationStart = z
  .object({
    commandId: id,
    conversationId: id,
    projectId: id,
    title: z.string(),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const conversationUpdate = z
  .object({
    commandId: id,
    conversationId: id,
    expectedRevision: z.number().int().positive(),
    title: z.string().optional(),
    archived: z.boolean().optional(),
  })
  .strict();
const taskPage = z
  .object({
    projectId: id.optional(),
    owner: z.enum(["mine", "human", "agent", "all"]).optional(),
    query: z.string().max(200).optional(),
    limit: pageSize.optional(),
    after: z
      .object({ orderRank: z.number().int(), taskId: id })
      .strict()
      .optional(),
  })
  .strict();
const taskCreate = z
  .object({
    commandId: id,
    taskId: id,
    projectId: id,
    title: z.string(),
    description: z.string().optional(),
    assigneeId: id,
    modelId: z.string().trim().min(1).max(100).nullable().optional(),
    reasoningEffort: reasoningEffortSchema.nullable().optional(),
    notBefore: z.iso.datetime().nullable().optional(),
    everySeconds: z.number().int().min(60).max(31536000).nullable().optional(),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    resultIds: z.array(id).max(100).optional(),
    dependsOnIds: z.array(id).max(100).optional(),
    watchSourceIds: z.array(id).max(100).optional(),
  })
  .strict();
const taskVersionLookup = z
  .object({ taskId: id, revision: z.number().int().positive().optional() })
  .strict();
const taskVersionPage = z
  .object({
    taskId: id,
    limit: pageSize.optional(),
    beforeRevision: z.number().int().positive().optional(),
  })
  .strict();
const taskRevise = z
  .object({
    commandId: id,
    taskId: id,
    expectedRevision: z.number().int().positive(),
    title: z.string().optional(),
    description: z.string().optional(),
    projectId: id.optional(),
    assigneeId: id.optional(),
    assignment: z.enum(["proposed", "accepted", "declined"]).optional(),
    modelId: z.string().trim().min(1).max(100).nullable().optional(),
    reasoningEffort: reasoningEffortSchema.nullable().optional(),
    notBefore: z.iso.datetime().nullable().optional(),
    everySeconds: z.number().int().min(60).max(31536000).nullable().optional(),
    execution: z
      .enum(["planned", "active", "waiting", "completed", "cancelled"])
      .optional(),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    resultIds: z.array(id).max(100).optional(),
    dependsOnIds: z.array(id).max(100).optional(),
    watchSourceIds: z.array(id).max(100).optional(),
  })
  .strict();
const taskRespond = z
  .object({
    commandId: id,
    taskId: id,
    expectedRevision: z.number().int().positive(),
    body: z.string(),
  })
  .strict();
const taskResponsePage = z
  .object({
    taskId: id,
    responseId: id.optional(),
    limit: pageSize.optional(),
    after: z
      .object({ createdAt: timestamp, responseId: id })
      .strict()
      .optional(),
  })
  .strict();
const taskComplete = z
  .object({
    commandId: id,
    taskId: id,
    expectedRevision: z.number().int().positive(),
    completed: z.boolean(),
  })
  .strict();
const taskRunRequest = z
  .object({
    commandId: id,
    taskId: id,
    expectedRevision: z.number().int().positive(),
    sessionId: id,
    intent: z.string().trim().min(1).max(30000),
    modelAlias: z.string().trim().min(1).max(100).nullable().optional(),
    reasoningEffort: reasoningEffortSchema.nullable().optional(),
    notBefore: z.iso.datetime(),
    intervalSeconds: z
      .number()
      .int()
      .min(60)
      .max(31536000)
      .nullable()
      .optional(),
  })
  .strict();
const taskRunControl = z
  .object({
    taskId: id,
    runNumber: z.number().int().positive(),
    controlRevision: z.number().int().positive(),
    action: z.enum(["stop", "pause", "resume"]),
  })
  .strict();
const taskRunPage = z
  .object({
    taskId: id,
    limit: z.number().int().min(1).max(50).optional(),
    beforeRun: z.number().int().positive().optional(),
  })
  .strict();
const taskRunLookup = z
  .object({ taskId: id, runNumber: z.number().int().positive() })
  .strict();
const taskOrderLookup = z.object({ projectId: id.optional() }).strict();
const taskReorder = z
  .object({
    commandId: id,
    projectId: id.optional(),
    taskId: id,
    beforeTaskId: id.nullable(),
    expectedOrderRevision: z.number().int().nonnegative(),
  })
  .strict();
const taskSelectionReorder = z
  .object({
    commandId: id,
    taskIds: z.array(id).min(1).max(500),
    expectedOrderRevision: z.number().int().nonnegative(),
    move: z
      .object({
        taskId: id,
        expectedRevision: z.number().int().positive(),
        execution: z.enum([
          "planned",
          "active",
          "waiting",
          "completed",
          "cancelled",
        ]),
      })
      .strict()
      .optional(),
  })
  .strict();
const contentPage = z
  .object({
    projectId: id.optional(),
    contentIds: z
      .array(id)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    appObjectIds: z
      .array(id)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    appId: z
      .string()
      .regex(/^[a-z][a-z0-9.-]{2,80}$/)
      .optional(),
    appIds: z
      .array(z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/))
      .min(1)
      .max(16)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    kind: z.string().min(1).max(80).optional(),
    kinds: z
      .array(z.string().min(1).max(80))
      .min(1)
      .max(16)
      .refine((kinds) => new Set(kinds).size === kinds.length)
      .optional(),
    availability: z.string().min(1).max(80).optional(),
    query: z.string().max(200).optional(),
    sort: z.enum(["updated", "created", "title"]).optional(),
    limit: pageSize.optional(),
    before: z
      .object({ key: z.string().min(1).max(180), contentId: id })
      .strict()
      .optional(),
  })
  .strict();
const contentCountFilter = contentPage.omit({
  sort: true,
  limit: true,
  before: true,
});
const contentDeliveryPage = z
  .object({
    inputIds: z
      .array(id)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length),
    limit: pageSize.optional(),
    after: z
      .object({ committedAt: timestamp, commandId: id })
      .strict()
      .optional(),
  })
  .strict();
const contentByAppObject = z
  .object({
    appId: z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/),
    appObjectId: id,
    instanceId: id.optional(),
  })
  .strict();
const contentMove = z
  .object({
    commandId: id,
    contentId: id,
    targetProjectId: id,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const contentMoveToNewProject = z
  .object({
    commandId: id,
    projectId: id,
    title: z.string(),
    contentId: id,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const workLink = z
  .object({
    commandId: id,
    fromId: id,
    toId: id,
    kind: z.enum(["references", "uses", "produces"]),
    expectedProjectId: id.optional(),
  })
  .strict();
const workRelationsPage = z
  .object({
    objectId: id,
    limit: pageSize.optional(),
    after: id.optional(),
    expectedProjectId: id.optional(),
  })
  .strict();

function projectView(row: ProjectRow) {
  return {
    id: row.project_id,
    kind: row.kind,
    ownerPrincipalId: row.owner_principal_id,
    memberPrincipalIds: row.member_principal_ids,
    title: row.title,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
  };
}

function conversationView(row: ConversationRow) {
  return {
    id: row.conversation_id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function taskView(row: TaskListRow) {
  return {
    id: row.task_id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    assigneeId: row.assignee_id,
    execution: row.execution,
    dueDate: row.due_date,
    orderRank: row.order_rank,
    revision: row.revision,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    createdByPrincipalId: row.created_by_principal_id,
    createdByActantId: row.created_by_actant_id,
    headVersion: taskVersionView(row.head_version),
  };
}

function taskVersionView(row: TaskVersionRow) {
  return {
    taskId: row.task_id,
    revision: row.revision,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    assigneeId: row.assignee_id,
    modelId: row.model_id,
    reasoningEffort: reasoningEffortSchema
      .nullable()
      .parse(row.reasoning_effort),
    dueDate: row.due_date,
    assignment: row.assignment,
    execution: row.execution,
    delivery: row.delivery,
    runRequested: row.run_requested,
    notBefore: row.not_before,
    everySeconds: row.every_seconds,
    authorPrincipalId: row.author_principal_id,
    authorActantId: row.author_actant_id,
    createdAt: row.created_at,
    resultIds: row.result_ids,
    dependsOnIds: row.depends_on_ids,
    watchSourceIds: row.watch_source_ids,
  };
}

function taskResponseView(row: TaskResponseRow) {
  return {
    id: row.response_id,
    taskId: row.task_id,
    taskRevision: row.task_revision,
    body: row.body,
    authorPrincipalId: row.author_principal_id,
    authorActantId: row.author_actant_id,
    createdAt: row.created_at,
  };
}

function contentView(row: ContentRow) {
  return {
    id: row.content_id,
    appId: row.app_id,
    instanceId: row.instance_id,
    providerRevision: row.provider_revision,
    appObjectId: row.app_object_id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    observedVersionRef: row.observed_version_ref,
    availability: row.availability,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function contentDeliveryView(row: ContentDeliveryRow) {
  return {
    commandId: row.command_id,
    operation: row.operation,
    inputId: row.runtime_input_id,
    sourceProjectId: row.source_project_id,
    contentId: row.content_id,
    projectId: row.project_id,
    appId: row.app_id,
    appObjectId: row.app_object_id,
    kind: row.kind,
    title: row.title,
    versionRef: row.version_ref,
    committedAt: row.committed_at,
  };
}

/** Domain operations shared by Human and Agent Host routes. No workspace
 * snapshot, database credential or renderer-selected identity crosses here.
 */
export class PlatformWorkService {
  private retirementRuntime: RuntimeBridge | undefined;
  constructor(
    private readonly platform: PlatformStore,
    private readonly retirementInputCoverage:
      "single-host" | "cross-host-unverified",
    readonly readWatchSource?: TaskWatchSourceReader,
  ) {}

  bindRetirementRuntime(runtime?: RuntimeBridge) {
    this.retirementRuntime = runtime;
  }

  /** Explicit Human onboarding. Listing never mutates a tenant. */
  ensurePersonalSpaces(actor: PlatformActor) {
    return this.platform.ensurePersonalSpaces(actor);
  }

  async listProjects(actor: PlatformActor, raw: unknown = {}) {
    return (
      await this.platform.listProjects(actor, projectPage.parse(raw))
    ).map(projectView);
  }

  async getProject(actor: PlatformActor, raw: unknown) {
    const { projectId } = projectLookup.parse(raw);
    return projectView(await this.platform.getProject(actor, projectId));
  }

  getProjectUnderstanding(actor: PlatformActor, raw: unknown) {
    const { projectId, revision } = projectUnderstandingLookup.parse(raw);
    return this.platform.getProjectUnderstanding(actor, projectId, revision);
  }

  listAppViews(actor: PlatformActor) {
    return this.platform.listAppViews(actor);
  }

  launchAppView(actor: PlatformActor, raw: unknown) {
    return this.platform.launchAppView(actor, appViewLaunch.parse(raw));
  }

  saveAppView(actor: PlatformActor, raw: unknown) {
    return this.platform.changeAppView(actor, appViewSave.parse(raw));
  }

  closeAppView(actor: PlatformActor, raw: unknown) {
    return this.platform.changeAppView(actor, {
      ...appViewChange.parse(raw),
      close: true,
    });
  }

  async authorizeLocalFileProject(actor: PlatformActor, projectId: string) {
    const project = await this.platform.getProject(actor, projectId);
    if (project.deleted_at)
      throw new PlatformStorageError(
        "forbidden",
        "项目已删除，不能访问本机文件授权。",
      );
  }

  async authorizeLocalDirectory(
    actor: PlatformActor,
    projectId: string,
    conversationId: string,
    write: boolean,
  ) {
    if (write)
      await this.platform.authorizeMessageRoute(actor, {
        projectId,
        conversationId,
        targetActantId: morphzAgentAccess.actantId,
      });
    else
      await this.platform.authorizeConversationRead(actor, {
        projectId,
        conversationId,
      });
  }

  projectAudiencesEqual(actor: PlatformActor, projectIds: string[]) {
    return this.platform.projectAudiencesEqual(actor, projectIds);
  }

  createProject(actor: PlatformActor, raw: unknown) {
    return this.platform.createProject(actor, projectCreate.parse(raw));
  }

  renameProject(actor: PlatformActor, raw: unknown) {
    return this.platform.renameProject(actor, projectRename.parse(raw));
  }

  async changeProjectState(actor: PlatformActor, raw: unknown) {
    const request = projectState.parse(raw);
    if (request.state === "active")
      return this.platform.changeProjectState(actor, request);
    // A Host-local delivery list cannot prove that another Host has no
    // admitted-but-unsent input for this project. Do not start a retirement
    // fence until a deployment can make that global claim.
    if (this.retirementInputCoverage === "cross-host-unverified")
      throw new PlatformStorageError(
        "conflict",
        "跨 Host 的在途消息尚无法核验，项目没有归档或删除。",
      );
    const retirement = { ...request, state: request.state };
    const runtime = this.retirementRuntime;
    if (!runtime)
      throw new PlatformStorageError(
        "conflict",
        "Runtime 暂不可用，项目没有归档或删除。",
      );
    const fence = await this.platform.beginProjectRetirement(actor, retirement);
    if (fence === "completed") return request.projectId;
    try {
      await runtime.assertProjectInputsSettled(request.projectId);
      let afterSequence = 0;
      for (;;) {
        const runs = await this.platform.projectRetirementRuns(
          actor,
          request.projectId,
          request.commandId,
          afterSequence,
        );
        for (const run of runs) {
          const status = await runtime
            .taskRunStatusReader()
            .inspect(run.runtime, run.access);
          if (
            status.thread.lifecycle === "open" ||
            !["completed", "cancelled"].includes(status.schedule.status) ||
            (status.schedule.status !== "cancelled" &&
              status.schedule.intervalSeconds !== null)
          )
            throw new PlatformStorageError(
              "conflict",
              "项目仍有进行中或周期性的事项执行。",
            );
        }
        if (runs.length < 50) break;
        afterSequence = runs.at(-1)!.sequence;
      }
      await runtime.assertProjectInputsSettled(request.projectId);
      return await this.platform.completeProjectRetirement(actor, retirement);
    } catch (error) {
      try {
        await this.platform.abortProjectRetirement(actor, retirement);
      } catch {
        throw new PlatformStorageError(
          "conflict",
          "项目核验未完成，准入栅栏仍在；请用同一次操作重试。",
        );
      }
      throw error;
    }
  }

  async listConversations(actor: PlatformActor, raw: unknown) {
    const { projectId, ...page } = conversationPage.parse(raw);
    return (await this.platform.listConversations(actor, projectId, page)).map(
      conversationView,
    );
  }

  async listAccessibleConversations(actor: PlatformActor, raw: unknown = {}) {
    return (
      await this.platform.listAccessibleConversations(
        actor,
        conversationNavigationPage.parse(raw),
      )
    ).map(conversationView);
  }

  conversationNavigation(actor: PlatformActor) {
    return this.platform.conversationNavigation(actor);
  }

  startConversation(actor: PlatformActor, raw: unknown) {
    return this.platform.startConversation(actor, conversationStart.parse(raw));
  }

  updateConversation(actor: PlatformActor, raw: unknown) {
    return this.platform.updateConversation(
      actor,
      conversationUpdate.parse(raw),
    );
  }

  async listTasks(actor: PlatformActor, raw: unknown = {}) {
    const request = taskPage.parse(raw);
    const { projectId, ...page } = request;
    return (
      projectId
        ? await this.platform.listTasks(actor, projectId, page)
        : await this.platform.listAccessibleTasks(actor, page)
    ).map(taskView);
  }

  taskCounts(actor: PlatformActor) {
    return this.platform.taskCounts(actor);
  }

  async taskHead(actor: PlatformActor, raw: unknown) {
    const { taskId } = taskVersionLookup.pick({ taskId: true }).parse(raw);
    return taskView(await this.platform.taskHead(actor, taskId));
  }

  createTask(actor: PlatformActor, raw: unknown) {
    return this.platform.createTask(actor, taskCreate.parse(raw));
  }

  async taskVersion(actor: PlatformActor, raw: unknown) {
    const { taskId, revision } = taskVersionLookup.parse(raw);
    return taskVersionView(
      await this.platform.taskVersion(actor, taskId, revision),
    );
  }

  async listTaskVersions(actor: PlatformActor, raw: unknown) {
    const { taskId, ...options } = taskVersionPage.parse(raw);
    return (await this.platform.listTaskVersions(actor, taskId, options)).map(
      taskVersionView,
    );
  }

  reviseTask(
    actor: PlatformActor,
    raw: unknown,
    inspectRuntime?: Parameters<PlatformStore["reviseTask"]>[2],
  ) {
    return this.platform.reviseTask(
      actor,
      taskRevise.parse(raw),
      inspectRuntime,
    );
  }

  respondTask(actor: PlatformActor, raw: unknown) {
    return this.platform.respondTask(actor, taskRespond.parse(raw));
  }

  async listTaskResponses(actor: PlatformActor, raw: unknown) {
    const { taskId, ...page } = taskResponsePage.parse(raw);
    return (await this.platform.listTaskResponses(actor, taskId, page)).map(
      taskResponseView,
    );
  }

  completeTask(actor: PlatformActor, raw: unknown) {
    return this.platform.setTaskCompleted(actor, taskComplete.parse(raw));
  }

  requestTaskRun(
    actor: PlatformActor,
    raw: unknown,
    priorRuntime?: PriorRuntimeObservation,
  ) {
    return this.platform.requestTaskRun(
      actor,
      taskRunRequest.parse(raw),
      priorRuntime,
      this.readWatchSource,
    );
  }

  controlTaskRun(actor: PlatformActor, raw: unknown) {
    const request = taskRunControl.parse(raw);
    return this.platform.requestTaskRunControl(
      actor,
      request.taskId,
      request.runNumber,
      request.controlRevision,
      request.action,
    );
  }

  async taskRunWasWithdrawn(
    actor: PlatformActor,
    taskId: string,
    runNumber: number,
  ) {
    return (await this.platform.taskRunPrerequisites(actor, taskId, runNumber))
      .withdrawn;
  }

  listTaskRuns(actor: PlatformActor, raw: unknown) {
    const { taskId, ...page } = taskRunPage.parse(raw);
    return this.platform.listTaskRunLinks(actor, taskId, page);
  }

  taskRunRuntimeRef(actor: PlatformActor, raw: unknown) {
    const { taskId, runNumber } = taskRunLookup.parse(raw);
    return this.platform.taskRunRuntimeRef(actor, taskId, runNumber);
  }

  async taskOrder(actor: PlatformActor, raw: unknown = {}) {
    const { projectId } = taskOrderLookup.parse(raw);
    return {
      ...(projectId === undefined ? {} : { projectId }),
      revision: await this.platform.taskOrderRevision(actor, projectId),
    };
  }

  reorderTask(actor: PlatformActor, raw: unknown) {
    return this.platform.reorderTask(actor, taskReorder.parse(raw));
  }

  reorderTaskSelection(actor: PlatformActor, raw: unknown) {
    return this.platform.reorderTaskSelection(
      actor,
      taskSelectionReorder.parse(raw),
    );
  }

  async listContent(actor: PlatformActor, raw: unknown = {}) {
    return (await this.platform.listContent(actor, contentPage.parse(raw))).map(
      contentView,
    );
  }

  async contentDeliveries(actor: PlatformActor, raw: unknown) {
    return (
      await this.platform.contentDeliveries(
        actor,
        contentDeliveryPage.parse(raw),
      )
    ).map(contentDeliveryView);
  }

  /** Platform-owned title lookup; app-owned original text is searched
   * separately and only joined after checking current catalog authority.
   */
  async searchContentTitles(
    actor: PlatformActor,
    raw: unknown,
  ): Promise<SearchResult> {
    const request = searchSchema.parse(raw);
    const searchableApps = ["morphz.objects", "morphz.reader"];
    const requestedApps = request.appIds?.filter((appId) =>
      searchableApps.includes(appId),
    );
    const noApps = requestedApps?.length === 0;
    const result = await this.platform.searchContentTitles(actor, {
      ...request,
      // Even an excluded app filter still checks the requested project scope
      // and reads the authorized catalog head; no title or count escapes it.
      appIds: noApps ? searchableApps : (requestedApps ?? searchableApps),
      ...(request.kind
        ? { kind: request.kind }
        : {
            kinds: request.kinds ?? [
              "document",
              "image",
              "pdf",
              "publication",
              "website",
              "interactive",
            ],
          }),
      availability: "available",
    });
    const hits: SearchHit[] = (noApps ? [] : result.rows).map((row) => {
      const revision = Number(row.observed_version_ref);
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new PlatformStorageError(
          "invalid",
          "目录引用缺少可打开的原件版本。",
        );
      return {
        artifactId: row.content_id,
        projectId: row.project_id,
        projectTitle: row.project_title,
        title: row.title,
        kind: row.kind as SearchHit["kind"],
        revision,
        excerpt: "",
        matchedIn: "title",
        quote: "",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        source: null,
      };
    });
    return {
      hits,
      total: noApps ? 0 : result.total,
      hasMore: !noApps && request.offset + hits.length < result.total,
      workspaceRevision: result.catalogVersion,
    };
  }

  contentCounts(actor: PlatformActor, raw: unknown = {}) {
    return this.platform.contentCounts(actor, contentCountFilter.parse(raw));
  }

  async content(actor: PlatformActor, contentId: string) {
    return contentView(await this.platform.content(actor, contentId));
  }

  async resolveContent(actor: PlatformActor, raw: unknown) {
    return contentView(
      await this.platform.contentByAppObject(
        actor,
        contentByAppObject.parse(raw),
      ),
    );
  }

  moveContent(actor: PlatformActor, raw: unknown) {
    return this.platform.moveContent(actor, contentMove.parse(raw));
  }

  createProjectForContent(actor: PlatformActor, raw: unknown) {
    return this.platform.createProjectForContent(
      actor,
      contentMoveToNewProject.parse(raw),
    );
  }

  linkWork(actor: PlatformActor, raw: unknown) {
    return this.platform.linkWork(actor, workLink.parse(raw));
  }

  listWorkRelations(actor: PlatformActor, raw: unknown) {
    const { objectId, ...page } = workRelationsPage.parse(raw);
    return this.platform.listWorkRelations(actor, objectId, page);
  }
}
