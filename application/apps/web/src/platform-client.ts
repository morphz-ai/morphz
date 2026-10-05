import { z } from "zod";
import {
  applicationInstanceSchema,
  uiPackageHeaderSchema,
} from "../../../packages/core/src/applications.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApplicationCaller,
  ApplicationMethod,
} from "../../../packages/core/src/application-api.js";
import { navigationRevisionsSchema } from "../../../packages/core/src/application-api.js";
import { applicationCall, RequestError } from "./application-transport.js";
import { storageScope } from "./local-preferences.js";
import {
  morphzAgentAccess,
  browserReferenceSchema,
  inputApplicationSchema,
  inputAttachmentSchema,
  type InputDispatchMode,
} from "../../../packages/core/src/model.js";
import { continuationSchema } from "../../../packages/core/src/continuation.js";
import { cognitiveAppObjectLocatorSchema } from "../../../packages/core/src/cognitive-app-object-locator.js";
import { conversationRuntimeSchema } from "../../../packages/core/src/conversation.js";
import type { ReasoningEffort } from "../../../packages/core/src/inference.js";
import type { LiveScriptDraft } from "../../../packages/script-studio/src/store.js";
import { scriptOutputSchema } from "../../../packages/core/src/script-delivery.js";
import {
  scriptBriefSchema,
  scriptProductionSchema,
  type ScriptProduction,
} from "../../../packages/core/src/script-studio.js";
import {
  textQuotesSchema,
  type TextQuote,
} from "../../../packages/core/src/text-quotes.js";
import {
  directoryGrantSchema,
  localFileReferenceSchema,
} from "../../../packages/core/src/local-files.js";
import { readingInputSchema } from "../../../packages/core/src/reader.js";
import {
  interactiveRowsPageSchema,
  type InteractiveContent,
  type InteractiveRowsQuery,
  type InteractiveRowOperation,
} from "../../../packages/core/src/interactive.js";
import { understandingSourceSchema } from "../../../packages/core/src/understanding.js";

const id = z.string().min(1);
const isoTime = z.string().datetime();
const pageSize = z.number().int().min(1).max(100);
const uiPackageSummarySchema = z.object({
  header: uiPackageHeaderSchema,
  installedAt: isoTime,
});
export type UiPackageSummary = z.infer<typeof uiPackageSummarySchema>;

export const platformBootSchema = z.object({
  centerId: z.uuid(),
  csrfToken: z.string().min(1),
  principalId: id,
  actantId: id,
  displayName: z.string().trim().min(1).max(100),
  capabilities: z.object({
    runtime: z.boolean(),
    teamAuthentication: z.boolean(),
    directedInput: z.boolean(),
    localFiles: z.boolean(),
    browserBookmarks: z.boolean(),
    modelSettings: z.boolean(),
  }),
});
export type PlatformBoot = z.infer<typeof platformBootSchema>;

export const platformProjectSchema = z.object({
  id,
  kind: z.enum(["project", "desk", "inbox", "dialogue"]),
  ownerPrincipalId: id.nullable(),
  memberPrincipalIds: z.array(id),
  title: z.string(),
  revision: z.number().int().positive(),
  createdAt: isoTime,
  updatedAt: isoTime,
  archivedAt: isoTime.nullable(),
  deletedAt: isoTime.nullable(),
});
export type PlatformProject = z.infer<typeof platformProjectSchema>;
export const platformProjectUnderstandingSchema = z.object({
  projectId: id,
  revision: z.number().int().positive(),
  frameId: id,
  frameRevision: z.number().int().positive(),
  mindVersion: z.number().int().positive(),
  body: z.string().min(1).max(30000),
  sources: z.array(
    understandingSourceSchema.extend({
      title: z.string().nullable(),
      appId: id.nullable(),
    }),
  ),
  publishedByPrincipalId: id,
  publishedByActantId: id,
  publishedAt: isoTime,
});
export type PlatformProjectUnderstanding = z.infer<
  typeof platformProjectUnderstandingSchema
>;

export const platformTaskVersionSchema = z.object({
  taskId: id,
  revision: z.number().int().positive(),
  projectId: id.nullable(),
  title: z.string(),
  description: z.string(),
  assigneeId: id,
  modelId: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  dueDate: z.string().nullable(),
  assignment: z.string(),
  execution: z.string(),
  delivery: z.string(),
  runRequested: z.number().int().nonnegative(),
  notBefore: z.string().nullable(),
  everySeconds: z.number().nullable(),
  authorPrincipalId: id,
  authorActantId: id,
  createdAt: isoTime,
  resultIds: z.array(id),
  dependsOnIds: z.array(id),
  watchSourceIds: z.array(id),
});
export type PlatformTaskVersion = z.infer<typeof platformTaskVersionSchema>;

export const platformTaskSchema = z.object({
  id,
  projectId: id,
  title: z.string(),
  description: z.string(),
  assigneeId: id,
  execution: z.enum(["planned", "active", "waiting", "completed", "cancelled"]),
  dueDate: z.string().nullable(),
  orderRank: z.number().int(),
  revision: z.number().int().positive(),
  updatedAt: isoTime,
  createdAt: isoTime,
  createdByPrincipalId: id,
  createdByActantId: id,
  headVersion: platformTaskVersionSchema,
});
export type PlatformTask = z.infer<typeof platformTaskSchema>;

const taskCountSchema = z.object({
  projectId: id,
  total: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  mineOpen: z.number().int().nonnegative(),
  latestActivityAt: z.string().datetime(),
});
export type PlatformTaskCount = z.infer<typeof taskCountSchema>;

export const platformTaskResponseSchema = z.object({
  id,
  taskId: id,
  taskRevision: z.number().int().positive(),
  body: z.string(),
  authorPrincipalId: id,
  authorActantId: id,
  createdAt: isoTime,
});
export type PlatformTaskResponse = z.infer<typeof platformTaskResponseSchema>;

export const platformContentSchema = z.object({
  id,
  appId: id,
  instanceId: id,
  providerRevision: z.number().int().positive(),
  appObjectId: id,
  projectId: id,
  kind: z.string(),
  title: z.string(),
  observedVersionRef: z.string().nullable(),
  availability: z.string(),
  revision: z.number().int().positive(),
  createdAt: isoTime,
  updatedAt: isoTime,
});
export type PlatformContent = z.infer<typeof platformContentSchema>;
export const platformContentDeliverySchema = z.object({
  commandId: id,
  operation: z.enum(["record-content", "refresh-content"]),
  inputId: id,
  sourceProjectId: id,
  contentId: id,
  projectId: id,
  appId: id,
  appObjectId: id,
  kind: z.string(),
  title: z.string(),
  versionRef: z.string().min(1),
  committedAt: isoTime,
});
export type PlatformContentDelivery = z.infer<
  typeof platformContentDeliverySchema
>;

const scriptOverviewSchema = z.object({
  contentId: id,
  productionId: id,
  projectId: id,
  title: z.string(),
  metadataRevision: z.number().int().positive(),
  activityRevision: z.number().int().positive(),
  updatedAt: isoTime,
  brief: scriptBriefSchema,
  progress: z.object({
    episodes: z.number().int().nonnegative(),
    scenes: z.number().int().nonnegative(),
    pendingCandidates: z.number().int().nonnegative(),
  }),
});
export type ScriptOverview = z.infer<typeof scriptOverviewSchema>;
export const scriptLibraryEntrySchema = z.object({
  id,
  contentId: id,
  projectId: id,
  title: z.string(),
  updatedAt: isoTime,
  catalogRevision: z.number().int().positive(),
  activityRevision: z.number().int().positive(),
});
export type ScriptLibraryEntry = z.infer<typeof scriptLibraryEntrySchema>;

export const platformConversationSchema = z.object({
  id,
  projectId: id,
  kind: z.enum(["default", "named"]),
  title: z.string(),
  revision: z.number().int().positive(),
  createdAt: isoTime,
  updatedAt: isoTime,
  archivedAt: isoTime.nullable(),
});
export type PlatformConversation = z.infer<typeof platformConversationSchema>;

export const platformHistorySchema = z.object({
  inputs: z.array(
    z.object({
      id,
      projectId: id,
      conversationId: id,
      author: z.object({ principalId: id, actantId: id }),
      targetActantId: id,
      body: z.string(),
      artifactId: id.optional(),
      artifactRevision: z.number().int().positive().optional(),
      selection: z.string().optional(),
      reading: readingInputSchema.optional(),
      continuation: continuationSchema.optional(),
      cognitiveObject: cognitiveAppObjectLocatorSchema.optional(),
      application: inputApplicationSchema.optional(),
      browser: browserReferenceSchema.optional(),
      textQuotes: textQuotesSchema.optional(),
      attachments: z.array(inputAttachmentSchema).optional(),
      localFile: localFileReferenceSchema.optional(),
      directories: z.array(directoryGrantSchema).max(8).optional(),
      createdAt: isoTime,
    }),
  ),
  runtime: conversationRuntimeSchema,
  scriptOutputs: z.array(scriptOutputSchema).default([]),
  nextCursor: z.object({ createdAt: isoTime, id }).nullable(),
});
export type PlatformHistory = z.infer<typeof platformHistorySchema>;
export type HistoryCursor = NonNullable<PlatformHistory["nextCursor"]>;

export type Page<T, C> = { items: T[]; nextCursor: C | null };
export type ProjectCursor = { updatedAt: string; projectId: string };
export type TaskCursor = { orderRank: number; taskId: string };
type TaskResponseCursor = { createdAt: string; responseId: string };
export type ContentCursor = { key: string; contentId: string };
type ContentDeliveryCursor = { committedAt: string; commandId: string };
export type ContentSort = "updated" | "created" | "title";
export const platformContentCountSchema = z.object({
  projectId: id,
  count: z.number().int().nonnegative(),
  latestActivityAt: z.string().datetime(),
});
export type PlatformContentCount = z.infer<typeof platformContentCountSchema>;
export const platformWorkRelationSchema = z.object({
  id,
  fromId: id,
  toId: id,
  type: z.enum(["references", "uses", "produces"]),
});
export type PlatformWorkRelation = z.infer<typeof platformWorkRelationSchema>;
export type ConversationCursor = { updatedAt: string; conversationId: string };

/** Drain a bounded directory query without silently hiding a later page.
 * The view may still choose a smaller per-page window; this helper is for
 * navigation data that must be complete before it is presented as complete.
 */
async function collectPages<T, C>(
  read: (after?: C) => Promise<Page<T, C>>,
  identity: (item: T) => string,
  maximum: number,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let after: C | undefined;
  for (;;) {
    const page = await read(after);
    for (const item of page.items) {
      const key = identity(item);
      if (seen.has(key)) throw new Error("目录分页重复返回同一对象，请重试。");
      seen.add(key);
      items.push(item);
    }
    if (!page.nextCursor) return items;
    if (!page.items.length || items.length > maximum)
      throw new Error("目录超出当前界面的加载范围，请使用筛选或分页入口。");
    after = page.nextCursor;
  }
}

function page<T, C>(
  items: T[],
  limit: number,
  cursor: (last: T) => C,
): Page<T, C> {
  return {
    items,
    nextCursor:
      items.length === limit ? cursor(items[items.length - 1]!) : null,
  };
}

/** A Client reads each owner through a bounded domain request. No central
 * Workspace JSON or renderer-owned database credential is involved.
 */
export class PlatformClient {
  private constructor(
    private readonly caller: ApplicationCaller,
    readonly boot: PlatformBoot,
  ) {}

  static async connect(caller: ApplicationCaller, signal?: AbortSignal) {
    const boot = platformBootSchema.parse(
      await caller
        .call("platform.bootstrap", undefined, { signal })
        .catch((error: unknown) => {
          if (error instanceof RequestError) throw error;
          throw new Error(
            `platform.bootstrap: ${error instanceof Error ? error.message : "请求失败"}`,
            { cause: error },
          );
        }),
    );
    return new PlatformClient(caller, boot);
  }

  private call(
    method: ApplicationMethod,
    params?: unknown,
    signal?: AbortSignal,
  ) {
    return this.caller
      .call(method, params, {
        identityGeneration: this.boot.csrfToken,
        signal,
      })
      .catch((error: unknown) => {
        if (error instanceof RequestError) throw error;
        throw new Error(
          `${method}: ${error instanceof Error ? error.message : "请求失败"}`,
          { cause: error },
        );
      });
  }

  async ensurePersonalSpaces(signal?: AbortSignal) {
    return z
      .object({ deskId: id, inboxId: id, dialogueId: id })
      .parse(await this.call("spaces.ensure", undefined, signal));
  }

  async uiPackages(signal?: AbortSignal): Promise<UiPackageSummary[]> {
    return z
      .array(uiPackageSummarySchema)
      .max(100)
      .parse(await this.call("apps.list", undefined, signal));
  }

  async installUiPackage(commandId: string, manifest: unknown) {
    return id.parse(await this.call("apps.install", { commandId, manifest }));
  }

  async appViews(signal?: AbortSignal) {
    return z
      .array(applicationInstanceSchema)
      .max(100)
      .parse(await this.call("app-views.list", undefined, signal));
  }

  async launchAppView(request: {
    commandId: string;
    projectId: string;
    appId: string;
    packageVersion: string;
    state: Record<string, unknown>;
  }) {
    return applicationInstanceSchema.parse(
      await this.call("app-views.launch", request),
    );
  }

  async saveAppView(request: {
    commandId: string;
    viewId: string;
    expectedRevision: number;
    state: Record<string, unknown>;
  }) {
    return applicationInstanceSchema.parse(
      await this.call("app-views.save", request),
    );
  }

  async closeAppView(request: {
    commandId: string;
    viewId: string;
    expectedRevision: number;
  }) {
    return applicationInstanceSchema.parse(
      await this.call("app-views.close", request),
    );
  }

  async runtimeSnapshot(signal?: AbortSignal) {
    return conversationRuntimeSchema.parse(
      await this.call("runtime.snapshot", undefined, signal),
    );
  }

  async navigationRuntime(
    signal?: AbortSignal,
    scope?: { projectId: string; conversationId: string } | null,
  ) {
    return z
      .object({
        runtime: conversationRuntimeSchema,
        activityByProject: z.record(id, isoTime),
        catalogVersion: z.number().int().nonnegative(),
        revisions: navigationRevisionsSchema,
        historyVersion: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .parse(await this.call("runtime.navigation", scope ?? undefined, signal));
  }

  async projects(
    options: {
      status?: "active" | "archived" | "deleted" | "all";
      limit?: number;
      after?: ProjectCursor;
    } = {},
    signal?: AbortSignal,
  ): Promise<Page<PlatformProject, ProjectCursor>> {
    const limit = pageSize.parse(options.limit ?? 50);
    const items = z
      .array(platformProjectSchema)
      .max(limit)
      .parse(await this.call("projects.list", { ...options, limit }, signal));
    return page(items, limit, ({ updatedAt, id: projectId }) => ({
      updatedAt,
      projectId,
    }));
  }

  /** The existing navigation presents every authorized project in one tree.
   * Read real Platform pages instead of reviving the Workspace JSON row.
   */
  allProjects(signal?: AbortSignal) {
    return collectPages<PlatformProject, ProjectCursor>(
      (after) => this.projects({ status: "all", limit: 100, after }, signal),
      (project) => project.id,
      10_000,
    );
  }

  async project(projectId: string, signal?: AbortSignal) {
    return platformProjectSchema.parse(
      await this.call("projects.get", { projectId }, signal),
    );
  }

  async projectUnderstanding(
    projectId: string,
    revision?: number,
    signal?: AbortSignal,
  ): Promise<PlatformProjectUnderstanding | null> {
    return platformProjectUnderstandingSchema
      .nullable()
      .parse(
        await this.call(
          "projects.understanding",
          { projectId, revision },
          signal,
        ),
      );
  }

  async createProject(title: string, commandId: string, projectId: string) {
    return id.parse(
      await this.call("projects.create", { title, commandId, projectId }),
    );
  }

  async renameProject(
    projectId: string,
    title: string,
    expectedRevision: number,
    commandId: string,
  ) {
    return this.call("projects.rename", {
      projectId,
      title,
      expectedRevision,
      commandId,
    });
  }

  async changeProjectState(
    projectId: string,
    state: "active" | "archived" | "deleted",
    expectedRevision: number,
    commandId: string,
  ) {
    return this.call("projects.state", {
      projectId,
      state,
      expectedRevision,
      commandId,
    });
  }

  async conversations(
    projectId: string,
    options: {
      archived?: boolean;
      limit?: number;
      after?: ConversationCursor;
    } = {},
    signal?: AbortSignal,
  ): Promise<Page<PlatformConversation, ConversationCursor>> {
    const limit = pageSize.parse(options.limit ?? 50);
    const items = z
      .array(platformConversationSchema)
      .max(limit)
      .parse(
        await this.call(
          "conversations.list",
          { projectId, ...options, limit },
          signal,
        ),
      );
    return page(items, limit, ({ updatedAt, id: conversationId }) => ({
      updatedAt,
      conversationId,
    }));
  }

  allConversations(projectId: string, signal?: AbortSignal) {
    return collectPages<PlatformConversation, ConversationCursor>(
      (after) => this.conversations(projectId, { limit: 100, after }, signal),
      (conversation) => conversation.id,
      10_000,
    );
  }

  async navigationConversations(
    options: { limit?: number; after?: ConversationCursor } = {},
    signal?: AbortSignal,
  ): Promise<Page<PlatformConversation, ConversationCursor>> {
    const limit = pageSize.parse(options.limit ?? 50);
    const items = z
      .array(platformConversationSchema)
      .max(limit)
      .parse(
        await this.call(
          "conversations.navigation",
          { ...options, limit },
          signal,
        ),
      );
    return page(items, limit, ({ updatedAt, id: conversationId }) => ({
      updatedAt,
      conversationId,
    }));
  }

  allNavigationConversations(signal?: AbortSignal) {
    return collectPages<PlatformConversation, ConversationCursor>(
      (after) => this.navigationConversations({ limit: 100, after }, signal),
      (conversation) => conversation.id,
      10_000,
    );
  }

  updateConversation(input: {
    commandId: string;
    conversationId: string;
    expectedRevision: number;
    title?: string;
    archived?: boolean;
  }) {
    return this.call("conversations.update", input);
  }

  async history(
    projectId: string,
    conversationId: string,
    before?: HistoryCursor,
    signal?: AbortSignal,
  ) {
    return platformHistorySchema.parse(
      await this.call(
        "conversations.history",
        { projectId, conversationId, ...(before ? { before } : {}) },
        signal,
      ),
    );
  }

  /**
   * Fresh input defaults to interrupt. The command ID and selected mode must
   * survive retries; pre-upgrade saved inputs use their frozen operation instead.
   */
  async sendMessage(input: {
    commandId: string;
    projectId: string;
    conversationId?: string;
    newConversation?: { title: string };
    body: string;
    textQuotes?: TextQuote[];
    model?: string;
    reasoningEffort?: ReasoningEffort;
    dispatchMode?: InputDispatchMode;
  }) {
    const { commandId, ...scope } = input;
    return z.object({ commandId: id, entityId: id }).parse(
      await this.call("platform.message", {
        commandId,
        operation: {
          type: "record-input",
          ...scope,
          dispatchMode: input.dispatchMode ?? "interrupt",
          artifactId: null,
          artifactRevision: null,
          selection: "",
          targetActantId: morphzAgentAccess.actantId,
        },
      }),
    );
  }

  async tasks(
    options: {
      projectId?: string;
      owner?: "mine" | "human" | "agent" | "all";
      query?: string;
      limit?: number;
      after?: TaskCursor;
    } = {},
    signal?: AbortSignal,
  ): Promise<Page<PlatformTask, TaskCursor>> {
    const limit = pageSize.parse(options.limit ?? 50);
    const items = z
      .array(platformTaskSchema)
      .max(limit)
      .parse(await this.call("tasks.list", { ...options, limit }, signal));
    return page(items, limit, ({ orderRank, id: taskId }) => ({
      orderRank,
      taskId,
    }));
  }

  allTasks(
    options: {
      projectId?: string;
      owner?: "mine" | "human" | "agent" | "all";
    } = {},
    signal?: AbortSignal,
  ) {
    return collectPages<PlatformTask, TaskCursor>(
      (after) => this.tasks({ ...options, limit: 100, after }, signal),
      (task) => task.id,
      10_000,
    );
  }

  async taskCounts(signal?: AbortSignal): Promise<PlatformTaskCount[]> {
    return z
      .array(taskCountSchema)
      .parse(await this.call("tasks.counts", undefined, signal));
  }

  async taskHead(taskId: string, signal?: AbortSignal): Promise<PlatformTask> {
    return platformTaskSchema.parse(
      await this.call("tasks.get", { taskId }, signal),
    );
  }

  async createTask(input: {
    commandId: string;
    taskId: string;
    projectId: string;
    title: string;
    description?: string;
    assigneeId: string;
    modelId?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    notBefore?: string | null;
    everySeconds?: number | null;
    dueDate?: string;
    resultIds?: string[];
    dependsOnIds?: string[];
    watchSourceIds?: string[];
  }) {
    return this.call("tasks.create", input);
  }

  async taskVersion(taskId: string, revision?: number, signal?: AbortSignal) {
    return platformTaskVersionSchema.parse(
      await this.call("tasks.version", { taskId, revision }, signal),
    );
  }

  async taskVersions(
    taskId: string,
    options: { limit?: number; beforeRevision?: number } = {},
    signal?: AbortSignal,
  ): Promise<Page<PlatformTaskVersion, number>> {
    const limit = pageSize.parse(options.limit ?? 50);
    const items = z
      .array(platformTaskVersionSchema)
      .max(limit)
      .parse(
        await this.call(
          "tasks.versions",
          { taskId, ...options, limit },
          signal,
        ),
      );
    return page(items, limit, (last) => last.revision);
  }

  allTaskVersions(taskId: string, signal?: AbortSignal) {
    return collectPages<PlatformTaskVersion, number>(
      (beforeRevision) =>
        this.taskVersions(taskId, { limit: 100, beforeRevision }, signal),
      (version) => String(version.revision),
      10_000,
    );
  }

  reviseTask(input: {
    commandId: string;
    taskId: string;
    expectedRevision: number;
    title?: string;
    description?: string;
    projectId?: string;
    assigneeId?: string;
    assignment?: "proposed" | "accepted" | "declined";
    modelId?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    notBefore?: string | null;
    everySeconds?: number | null;
    execution?: "planned" | "active" | "waiting" | "completed" | "cancelled";
    dueDate?: string | null;
    resultIds?: string[];
    dependsOnIds?: string[];
    watchSourceIds?: string[];
  }) {
    return this.call("tasks.revise", input);
  }

  requestTaskRun(input: {
    commandId: string;
    taskId: string;
    expectedRevision: number;
  }) {
    return this.call("tasks.run-request", input);
  }

  respondTask(input: {
    commandId: string;
    taskId: string;
    expectedRevision: number;
    body: string;
  }) {
    return this.call("tasks.respond", input);
  }

  async taskResponses(
    taskId: string,
    options: { limit?: number; after?: TaskResponseCursor } = {},
    signal?: AbortSignal,
  ): Promise<Page<PlatformTaskResponse, TaskResponseCursor>> {
    const limit = pageSize.parse(options.limit ?? 50);
    const items = z
      .array(platformTaskResponseSchema)
      .max(limit)
      .parse(
        await this.call(
          "tasks.responses",
          { taskId, ...options, limit },
          signal,
        ),
      );
    return page(items, limit, ({ createdAt, id: responseId }) => ({
      createdAt,
      responseId,
    }));
  }

  allTaskResponses(taskId: string, signal?: AbortSignal) {
    return collectPages<PlatformTaskResponse, TaskResponseCursor>(
      (after) => this.taskResponses(taskId, { limit: 100, after }, signal),
      (response) => response.id,
      10_000,
    );
  }

  async taskOrder(projectId?: string, signal?: AbortSignal) {
    return z
      .object({
        projectId: id.optional(),
        revision: z.number().int().nonnegative(),
      })
      .parse(await this.call("tasks.order", { projectId }, signal));
  }

  reorderTask(input: {
    commandId: string;
    projectId?: string;
    taskId: string;
    beforeTaskId: string | null;
    expectedOrderRevision: number;
  }) {
    return this.call("tasks.reorder", input);
  }
  reorderTaskSelection(input: {
    commandId: string;
    taskIds: string[];
    expectedOrderRevision: number;
    move?: {
      taskId: string;
      expectedRevision: number;
      execution: "planned" | "active" | "waiting" | "completed" | "cancelled";
    };
  }) {
    return this.call("tasks.reorder-selection", input);
  }

  async completeTask(input: {
    commandId: string;
    taskId: string;
    expectedRevision: number;
    completed: boolean;
  }) {
    return this.call("tasks.complete", input);
  }

  async content(
    options: {
      projectId?: string;
      contentIds?: string[];
      appObjectIds?: string[];
      appId?: string;
      appIds?: string[];
      kind?: string;
      kinds?: string[];
      availability?: string;
      query?: string;
      sort?: ContentSort;
      limit?: number;
      before?: ContentCursor;
    } = {},
    signal?: AbortSignal,
  ): Promise<Page<PlatformContent, ContentCursor>> {
    const limit = pageSize.parse(options.limit ?? 50);
    const items = z
      .array(platformContentSchema)
      .max(limit)
      .parse(await this.call("content.list", { ...options, limit }, signal));
    return page(items, limit, (entry) => ({
      key:
        options.sort === "title"
          ? entry.title
          : options.sort === "created"
            ? entry.createdAt
            : entry.updatedAt,
      contentId: entry.id,
    }));
  }

  /** Hydrate explicit references without scanning an unrelated directory.
   * The SQL filter retains the same live membership and tenant checks as
   * content.list. Unknown or revoked IDs are simply absent. */
  async contentByIds(contentIds: readonly string[], signal?: AbortSignal) {
    const unique = [...new Set(contentIds)];
    if (unique.length > 200)
      throw new Error("单次读取的内容引用过多，请缩小范围。");
    const found = new Map<string, PlatformContent>();
    for (let offset = 0; offset < unique.length; offset += 50) {
      const ids = unique.slice(offset, offset + 50);
      const page = await this.content(
        { contentIds: ids, limit: ids.length },
        signal,
      );
      for (const entry of page.items) found.set(entry.id, entry);
    }
    return unique.flatMap((id) => {
      const entry = found.get(id);
      return entry ? [entry] : [];
    });
  }

  /** Only the visible Runtime history supplies input IDs; Platform still
   * rechecks the source and current content projects for each delivery. */
  async contentDeliveries(inputIds: readonly string[], signal?: AbortSignal) {
    const unique = [...new Set(inputIds)];
    const delivered: PlatformContentDelivery[] = [];
    for (let offset = 0; offset < unique.length; offset += 50) {
      const ids = unique.slice(offset, offset + 50);
      delivered.push(
        ...(await collectPages<PlatformContentDelivery, ContentDeliveryCursor>(
          async (after) => {
            const limit = 100;
            const items = z
              .array(platformContentDeliverySchema)
              .max(limit)
              .parse(
                await this.call(
                  "content.deliveries",
                  { inputIds: ids, limit, after },
                  signal,
                ),
              );
            return page(items, limit, ({ committedAt, commandId }) => ({
              committedAt,
              commandId,
            }));
          },
          (item) => item.commandId,
          10_000,
        )),
      );
    }
    return delivered.sort(
      (a, b) =>
        a.committedAt.localeCompare(b.committedAt) ||
        a.commandId.localeCompare(b.commandId),
    );
  }

  /** Resolve app-local object IDs in bounded pages. A repeated app-local ID
   * across instances is ambiguous without an instance locator, so never
   * silently choose one of the originals. */
  async contentByAppObjectIds(
    appId: string,
    appObjectIds: readonly string[],
    signal?: AbortSignal,
  ) {
    const unique = [...new Set(appObjectIds)];
    const found = new Map<string, PlatformContent>();
    for (let offset = 0; offset < unique.length; offset += 50) {
      const ids = unique.slice(offset, offset + 50);
      let before: ContentCursor | undefined;
      let read = 0;
      do {
        const page = await this.content(
          { appId, appObjectIds: ids, limit: 100, before },
          signal,
        );
        for (const entry of page.items) {
          const prior = found.get(entry.appObjectId);
          if (prior && prior.id !== entry.id)
            throw new Error("同名应用对象来自多个实例，无法确定原件。");
          found.set(entry.appObjectId, entry);
        }
        read += page.items.length;
        if (read > 500) throw new Error("应用对象引用过多，请缩小读取范围。");
        before = page.nextCursor ?? undefined;
      } while (before);
    }
    return found;
  }

  async getContent(contentId: string, signal?: AbortSignal) {
    return platformContentSchema.parse(
      await this.call("content.get", { contentId }, signal),
    );
  }

  async contentCounts(
    options: {
      projectId?: string;
      contentIds?: string[];
      appObjectIds?: string[];
      appId?: string;
      appIds?: string[];
      kind?: string;
      kinds?: string[];
      availability?: string;
      query?: string;
    } = {},
    signal?: AbortSignal,
  ): Promise<PlatformContentCount[]> {
    return z
      .array(platformContentCountSchema)
      .parse(await this.call("content.counts", options, signal));
  }

  async resolveContent(
    request: { appId: string; appObjectId: string; instanceId?: string },
    signal?: AbortSignal,
  ) {
    return platformContentSchema.parse(
      await this.call("content.resolve", request, signal),
    );
  }

  moveContent(input: {
    commandId: string;
    contentId: string;
    targetProjectId: string;
    expectedRevision: number;
  }) {
    return this.call("content.move", input);
  }

  createProjectForContent(input: {
    commandId: string;
    projectId: string;
    title: string;
    contentId: string;
    expectedRevision: number;
  }) {
    return this.call("content.move-new-project", input);
  }

  async linkWork(input: {
    commandId: string;
    fromId: string;
    toId: string;
    kind: "references" | "uses" | "produces";
  }) {
    return id.parse(await this.call("work.link", input));
  }

  async workRelations(
    objectId: string,
    options: { limit?: number; after?: string } = {},
    signal?: AbortSignal,
  ): Promise<Page<PlatformWorkRelation, string>> {
    const limit = pageSize.parse(options.limit ?? 50);
    const items = z
      .array(platformWorkRelationSchema)
      .max(limit)
      .parse(
        await this.call(
          "work.relations",
          { objectId, ...options, limit },
          signal,
        ),
      );
    return page(items, limit, (relation) => relation.id);
  }

  allWorkRelations(objectId: string, signal?: AbortSignal) {
    return collectPages<PlatformWorkRelation, string>(
      (after) => this.workRelations(objectId, { limit: 100, after }, signal),
      (relation) => relation.id,
      10_000,
    );
  }

  readDocument(contentId: string, revision?: number, signal?: AbortSignal) {
    return this.call("documents.read", { contentId, revision }, signal);
  }

  readReaderBook(contentId: string, revision: number, signal?: AbortSignal) {
    return this.call(
      "reader.book",
      { artifactId: contentId, revision },
      signal,
    );
  }

  /** Open one authorized Objects original at one exact version, regardless of
   * whether its payload is Markdown, image, PDF, publication or a table. */
  readObject(contentId: string, revision?: number, signal?: AbortSignal) {
    return this.call("objects.read", { contentId, revision }, signal);
  }

  renameObject(input: {
    commandId: string;
    contentId: string;
    expectedCatalogRevision: number;
    title: string;
  }) {
    return this.call("objects.rename", input);
  }

  renameScript(input: {
    commandId: string;
    contentId: string;
    expectedCatalogRevision: number;
    title: string;
  }) {
    return this.call("scripts.rename", input);
  }

  listObjectAnnotations(
    contentId: string,
    options: { limit?: number; afterOrdinal?: number } = {},
    signal?: AbortSignal,
  ) {
    return this.call("objects.annotations", { contentId, ...options }, signal);
  }

  annotateObject(input: {
    commandId: string;
    contentId: string;
    revision: number;
    quote: string;
    page?: number;
    body: string;
  }) {
    return this.call("objects.annotate", input);
  }

  objectVersions(
    contentId: string,
    options: { limit?: number; beforeRevision?: number } = {},
    signal?: AbortSignal,
  ) {
    return this.call("objects.versions", { contentId, ...options }, signal);
  }

  createDocument(input: {
    commandId: string;
    objectId: string;
    projectId: string;
    title: string;
    markdown: string;
  }) {
    return this.call("documents.create", input);
  }

  importDocument(input: {
    commandId: string;
    objectId: string;
    projectId: string;
    relativePath: string;
    text: string;
  }) {
    return this.call("documents.import", input);
  }

  reviseDocument(input: {
    commandId: string;
    contentId: string;
    expectedRevision: number;
    title: string;
    markdown: string;
  }) {
    return this.call("documents.revise", input);
  }

  createImage(input: {
    commandId: string;
    objectId: string;
    projectId: string;
    title: string;
    assetId: string;
    alt: string;
  }) {
    return this.call("images.create", input);
  }

  reviseImage(input: {
    commandId: string;
    contentId: string;
    expectedRevision: number;
    title: string;
    assetId: string;
    alt: string;
  }) {
    return this.call("images.revise", input);
  }

  createInteractive(input: {
    commandId: string;
    objectId: string;
    projectId: string;
    title: string;
    content: InteractiveContent;
  }) {
    return this.call("interactive.create", input);
  }

  reviseInteractive(input: {
    commandId: string;
    contentId: string;
    expectedRevision: number;
    title: string;
    content: InteractiveContent;
  }) {
    return this.call("interactive.revise", input);
  }

  async queryInteractiveRows(
    contentId: string,
    query: InteractiveRowsQuery = {},
    signal?: AbortSignal,
  ) {
    return interactiveRowsPageSchema.parse(
      await this.call("interactive.rows", { ...query, contentId }, signal),
    );
  }

  patchInteractiveRows(input: {
    commandId: string;
    contentId: string;
    expectedRevision: number;
    operations: InteractiveRowOperation[];
  }) {
    return this.call("interactive.patch", input);
  }

  async readScript(contentId: string, signal?: AbortSignal) {
    return scriptOverviewSchema.parse(
      await this.call("scripts.read", { contentId }, signal),
    );
  }

  async readScriptSnapshot(contentId: string, signal?: AbortSignal) {
    return scriptProductionSchema.parse(
      await this.call("scripts.snapshot", { contentId }, signal),
    );
  }

  readScriptItem(
    contentId: string,
    itemId: string,
    revision?: number,
    signal?: AbortSignal,
  ) {
    return this.call("scripts.item", { contentId, itemId, revision }, signal);
  }

  createScript(input: {
    commandId: string;
    productionId: string;
    projectId: string;
    title: string;
  }) {
    return this.call("scripts.create", input);
  }

  updateScript(input: {
    commandId: string;
    contentId: string;
    expectedRevision: number;
    title: string;
    brief: ScriptProduction["brief"];
    reviewerPrincipalIds: string[];
    template: ScriptProduction["template"];
  }) {
    return this.call("scripts.update", input);
  }

  createScriptItem(input: {
    commandId: string;
    contentId: string;
    itemId: string;
    expectedActivityRevision: number;
    kind: "source" | "setting" | "character" | "outline" | "episode" | "scene";
    draft: LiveScriptDraft;
  }) {
    return this.call("scripts.item.create", input);
  }

  reviseScriptItem(input: {
    commandId: string;
    contentId: string;
    itemId: string;
    expectedRevision: number;
    draft: LiveScriptDraft;
  }) {
    return this.call("scripts.item.revise", input);
  }

  restoreScriptItem(input: {
    commandId: string;
    contentId: string;
    itemId: string;
    expectedRevision: number;
    restoreRevision: number;
  }) {
    return this.call("scripts.item.restore", input);
  }

  transitionScriptWorkflow(input: {
    commandId: string;
    contentId: string;
    itemId: string;
    expectedRevision: number;
    expectedWorkflowRevision: number;
    action: "submit-review" | "review-decision" | "lock-item" | "unlock-item";
    decision?: "approve" | "request-changes";
    note?: string;
  }) {
    return this.call("scripts.item.workflow", input);
  }

  changeScriptReview(input: {
    commandId: string;
    contentId: string;
    action: "add-review" | "resolve-review";
    itemId?: string;
    itemRevision?: number;
    quote?: string;
    body?: string;
    severity?: "note" | "warning" | "blocking";
    reviewId?: string;
    expectedRevision?: number;
    resolution?: string;
  }) {
    return this.call("scripts.review.change", input);
  }

  decideScriptCandidate(input: {
    commandId: string;
    contentId: string;
    candidateId: string;
    expectedRevision: number;
    decision: "accept" | "reject";
  }) {
    return this.call("scripts.candidate.decide", input);
  }

  recordScriptExport(input: {
    commandId: string;
    contentId: string;
    expectedRevision: number;
    items: Array<{ itemId: string; revision: number }>;
    template: ScriptProduction["template"];
    workingCopy?: true;
  }) {
    return this.call("scripts.export.record", input);
  }

  readScriptItems(
    contentId: string,
    parentId: string | null,
    options: {
      kind?:
        "source" | "setting" | "character" | "outline" | "episode" | "scene";
      limit?: number;
      after?: { ordinal: number; itemId: string };
      expectedActivityRevision?: number;
    } = {},
    signal?: AbortSignal,
  ) {
    return this.call(
      "scripts.items",
      { contentId, parentId, ...options },
      signal,
    );
  }
}

/** Authentication and domain pages are separate. Refreshing the connection
 * never downloads project, app, Runtime or message history into one snapshot.
 */
export function usePlatformConnection() {
  const [client, setClient] = useState<PlatformClient | null>(null);
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await PlatformClient.connect(
        { call: applicationCall },
        AbortSignal.timeout(8000),
      );
      if (request !== generation.current) return;
      storageScope(next.boot.centerId, next.boot.principalId);
      setClient(next);
      setAuthenticationRequired(false);
      setError("");
    } catch (cause) {
      if (request !== generation.current) return;
      if (cause instanceof RequestError && cause.status === 401) {
        storageScope("disconnected", "anonymous");
        setClient(null);
        setAuthenticationRequired(true);
      }
      setError(
        cause instanceof Error ? cause.message : "暂时无法连接，请重试。",
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
    const wake = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      generation.current++;
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [refresh]);

  const login = useCallback(
    async (token: string) => {
      generation.current++;
      await applicationCall(
        "login",
        { token },
        { signal: AbortSignal.timeout(8000) },
      );
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    const current = client;
    if (!current) return;
    generation.current++;
    await applicationCall("logout", undefined, {
      identityGeneration: current.boot.csrfToken,
      signal: AbortSignal.timeout(8000),
    });
    storageScope("disconnected", "anonymous");
    setClient(null);
    setAuthenticationRequired(true);
  }, [client]);

  return { client, authenticationRequired, error, refresh, login, logout };
}
