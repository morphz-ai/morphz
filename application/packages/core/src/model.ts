import { z } from "zod";
import { contentRefSchema } from "./content.js";
import { scriptLocationSchema } from "./script-delivery.js";
import {
  scriptGenerationSchema,
  scriptPreparationSchema,
  scriptOperationSchema,
  scriptProductionSchema,
} from "./script-studio.js";
import { reasoningEffortSchema } from "./inference.js";
import { inputIntentSchema } from "./input-intent.js";
import { continuationSchema } from "./continuation.js";
import { textQuotesSchema } from "./text-quotes.js";
import {
  localFileReferenceSchema,
  directoryGrantSchema,
} from "./local-files.js";
import { maxDocumentCharacters } from "./sources.js";
import { pdfContentSchema } from "./pdf.js";
import {
  publicationSchema,
  readingMarkSchema,
  readingStateSchema,
  readerCommandSchema,
  readingInputSchema,
} from "./reader.js";
import { websiteURL } from "./browser.js";
import { bookmarkSchema, bookmarkOperations } from "./bookmarks.js";
import { interactiveSchema, interactiveText } from "./interactive.js";
import {
  applicationManifestSchema,
  uiPackageHeaderSchema,
  applicationInstanceSchema,
  applicationStateSchema,
  objectsApplication,
  browserApplication,
  scriptStudioApplication,
  readerApplication,
} from "./applications.js";

export const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const title = z.string().trim().min(1).max(180);
const text = z.string().max(maxDocumentCharacters);
const timestamp = z.iso.datetime();
export const contentOrganizationChangesSchema = z
  .object({
    title: title.optional(),
    projectId: id.optional(),
    newProjectTitle: title.optional(),
  })
  .strict()
  .refine(
    (value) =>
      [value.title, value.projectId, value.newProjectTitle].filter(
        (item) => item !== undefined,
      ).length === 1,
    "一次只能修改名称或所属项目；如需两项，请分别操作。",
  );
export const taskContentSchema = z
  .object({
    kind: z.literal("task"),
    description: text,
    assigneeId: id,
    model: z.string().trim().min(1).max(100).nullable(),
    reasoningEffort: reasoningEffortSchema.nullable().optional(),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
    dueDate: z.iso.date().nullable(),
    assignment: z.enum(["proposed", "accepted", "declined"]),
    execution: z.enum([
      "planned",
      "active",
      "waiting",
      "completed",
      "cancelled",
    ]),
    delivery: z.enum(["none", "ready", "accepted"]),
    resultIds: z.array(id).max(100),
    runRequested: z.number().int().nonnegative().default(0),
    notBefore: timestamp.nullable().default(null),
    everySeconds: z
      .number()
      .int()
      .min(60)
      .max(31536000)
      .nullable()
      .default(null),
    dependsOnIds: z.array(id).max(100).default([]),
    watchSourceIds: z.array(id).max(100).default([]),
  })
  .strict();
export const contentSchema = z.discriminatedUnion("kind", [
  pdfContentSchema,
  publicationSchema,
  z
    .object({
      kind: z.literal("document"),
      markdown: text,
      understanding: z
        .object({
          frameId: id,
          frameRevision: z.number().int().positive(),
          mindVersion: z.number().int().nonnegative(),
          sources: z
            .array(
              z
                .object({
                  artifactId: id,
                  revision: z.number().int().positive(),
                })
                .strict(),
            )
            .max(100),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("image"),
      assetId: z.string().regex(/^[a-f0-9]{64}$/),
      alt: z.string().max(2000),
    })
    .strict(),
  taskContentSchema,
  z
    .object({ kind: z.literal("website"), url: websiteURL, description: text })
    .strict(),
  interactiveSchema,
]);
export type Content = z.infer<typeof contentSchema>;
/** Presentation boundaries do not delete or rewrite retained objects. */
export function isPublicUnderstanding(artifact: { content: Content }) {
  return (
    artifact.content.kind === "document" && !!artifact.content.understanding
  );
}
export function isContentArtifact(artifact: { content: Content }) {
  return artifact.content.kind !== "task" && !isPublicUnderstanding(artifact);
}
export type TaskContent = Extract<Content, { kind: "task" }>;
export function quotedText(content: Content): string {
  return content.kind === "document"
    ? content.markdown
    : content.kind === "pdf"
      ? content.pages.join("\n\n")
      : content.kind === "interactive"
        ? interactiveText(content)
        : "";
}
const authorSchema = z.object({ principalId: id, actantId: id }).strict();
export type AccessContext = z.infer<typeof authorSchema>;
export const inputAttachmentSchema = z
  .object({
    assetId: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1).max(180),
    mime: z
      .enum([
        "image/png",
        "image/jpeg",
        "image/webp",
        "text/plain",
        "text/markdown",
        "application/pdf",
      ])
      .optional(),
  })
  .strict();
export type InputAttachment = z.infer<typeof inputAttachmentSchema>;
export const browserReferenceSchema = z
  .object({
    pageId: z.uuid(),
    epoch: z.uuid(),
    url: z.string().max(4000),
    title: z.string().max(500),
  })
  .strict();
export const inputApplicationSchema = z
  .object({
    instanceId: id,
    id: z.string(),
    version: z.string(),
    harness: z.object({ id: z.string(), version: z.string() }).nullable(),
  })
  .strict();
const versionSchema = z
  .object({
    revision: z.number().int().positive(),
    projectId: id.optional(),
    title,
    content: contentSchema,
    author: authorSchema,
    createdAt: timestamp,
  })
  .strict();
export const artifactSchema = z
  .object({
    id,
    projectId: id,
    originConversationId: id.optional(),
    originProjectId: id.optional(),
    title,
    content: contentSchema,
    revision: z.number().int().positive(),
    // Platform directory CAS, distinct from the owning app's content version.
    catalogRevision: z.number().int().positive().optional(),
    // Client projection only. A provider route change invalidates a cached
    // original even when the app's version and catalog row are unchanged.
    providerRevision: z.number().int().positive().optional(),
    createdBy: authorSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
    versions: z.array(versionSchema).min(1),
    source: z
      .object({
        mode: z.enum(["copy", "linked"]),
        name: z.string(),
        relativePath: z.string(),
        importedAt: timestamp,
        importedRevision: z.number().int().positive(),
        connection: z
          .object({
            sourceId: z.uuid(),
            deviceId: z.uuid(),
            status: z.enum(["current", "paused", "unavailable"]),
            checkedAt: timestamp,
          })
          .strict()
          .optional(),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type Artifact = z.infer<typeof artifactSchema>;
export const discussionSchema = z
  .object({
    id,
    projectId: id,
    title,
    revision: z.number().int().positive(),
    archivedAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type Discussion = z.infer<typeof discussionSchema>;
// The default discussion uses the workspace ID in its own namespace. This
// preserves legacy routes and avoids rewriting old inputs or command receipts.
export function discussionId(value: {
  projectId: string;
  conversationId?: string;
}) {
  return value.conversationId ?? value.projectId;
}
/** A conversation organizes exchanges; the work project still owns every input and artifact. */
export function checkConversation(
  state: Workspace,
  projectId: string,
  conversationId: string,
  access: AccessContext,
) {
  const project = checkProject(state, projectId, access);
  const conversation = state.conversations.find((c) => c.id === conversationId);
  if (!conversation) throw new DomainError("not_found", "对话不存在。");
  const owner = checkProject(state, conversation.projectId, access);
  if (
    owner.id !== project.id &&
    !(
      owner.kind === "dialogue" &&
      conversation.id === owner.id &&
      owner.ownerPrincipalId &&
      project.members.includes(owner.ownerPrincipalId) &&
      (owner.ownerPrincipalId === access.principalId ||
        access.principalId === "morphz-service")
    )
  )
    throw new DomainError("forbidden", "对话不属于当前项目或当前身份。");
  return conversation;
}

/** Legacy default histories stay readable without rewriting persisted inputs or deliveries. */
export function inConversation(
  state: Workspace,
  conversationId: string,
  value: { projectId: string; conversationId?: string },
  sharedDefault = false,
) {
  if (discussionId(value) === conversationId) return true;
  if (!sharedDefault || discussionId(value) !== value.projectId) return false;
  const owner = state.projects.find(
    (p) => p.id === conversationId && p.kind === "dialogue",
  );
  return (
    !!owner?.ownerPrincipalId &&
    !!state.projects.find(
      (p) =>
        p.id === value.projectId && p.members.includes(owner.ownerPrincipalId!),
    )
  );
}
export function ensureDiscussions(state: Workspace) {
  for (const project of state.projects) {
    if (!state.conversations.some((c) => c.id === project.id))
      state.conversations.push({
        id: project.id,
        projectId: project.id,
        title: "默认对话",
        revision: 1,
        archivedAt: null,
        createdAt: project.createdAt,
        updatedAt: project.createdAt,
      });
  }
}
export const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    name: title,
    revision: z.number().int().nonnegative(),
    principals: z.array(z.object({ id, name: title }).strict()),
    actants: z.array(
      z
        .object({
          id,
          kind: z.enum(["human", "agent"]),
          name: title,
          principalId: id,
        })
        .strict(),
    ),
    projects: z.array(
      z
        .object({
          id,
          title,
          members: z.array(id).min(1),
          createdAt: timestamp,
          kind: z.enum(["project", "desk", "inbox", "dialogue"]).optional(),
          ownerPrincipalId: id.optional(),
          revision: z.number().int().positive().optional(),
          updatedAt: timestamp.optional(),
          archivedAt: timestamp.nullable().optional(),
          deletedAt: timestamp.nullable().optional(),
        })
        .strict(),
    ),
    conversations: z.array(discussionSchema).default([]),
    scriptProductions: z.array(scriptProductionSchema).default([]),
    scriptPreparations: z.array(scriptPreparationSchema).default([]),
    artifacts: z.array(artifactSchema),
    bookmarks: z.array(bookmarkSchema).default([]),
    readingMarks: z.array(readingMarkSchema).default([]),
    readingStates: z.array(readingStateSchema).default([]),
    taskOrder: z.array(id).default([]),
    taskOrderRevision: z.number().int().nonnegative().default(0),
    applications: z
      .array(
        z.union([
          applicationManifestSchema.extend({ installedBy: id }).strict(),
          uiPackageHeaderSchema.extend({ installedBy: id }).strict(),
        ]),
      )
      .default([]),
    applicationInstances: z.array(applicationInstanceSchema).default([]),
    relations: z.array(
      z
        .object({
          id,
          fromId: id,
          toId: id,
          type: z.enum(["references", "uses", "produces"]),
          createdBy: authorSchema,
          createdAt: timestamp,
        })
        .strict(),
    ),
    annotations: z.array(
      z
        .object({
          id,
          artifactId: id,
          artifactRevision: z.number().int().positive(),
          quote: z.string().max(10000),
          page: z.number().int().positive().optional(),
          body: z.string().trim().min(1).max(10000),
          author: authorSchema,
          createdAt: timestamp,
        })
        .strict(),
    ),
    inputs: z.array(
      z
        .object({
          id,
          continuation: continuationSchema.optional(),
          scriptGeneration: scriptGenerationSchema.optional(),
          reading: readingInputSchema.optional(),
          scriptTarget: scriptLocationSchema.optional(),
          projectId: id,
          conversationId: id.optional(),
          artifactId: id.nullable(),
          artifactRevision: z.number().int().positive().nullable(),
          selection: z.string().max(10000),
          body: z.string().trim().max(30000),
          textQuotes: textQuotesSchema.optional(),
          attachments: z.array(inputAttachmentSchema).max(8).optional(),
          browser: browserReferenceSchema.optional(),
          localFile: localFileReferenceSchema.optional(),
          directories: z.array(directoryGrantSchema).max(8).optional(),
          author: authorSchema,
          targetActantId: id,
          status: z.literal("recorded"),
          intent: inputIntentSchema.optional(),
          model: z.string().trim().min(1).max(256).optional(),
          reasoningEffort: reasoningEffortSchema.optional(),
          application: inputApplicationSchema.optional(),
          createdAt: timestamp,
        })
        .strict(),
    ),
    taskResponses: z
      .array(
        z
          .object({
            id,
            taskId: id,
            taskRevision: z.number().int().positive(),
            body: z.string().trim().min(1).max(30000),
            author: authorSchema,
            createdAt: timestamp,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type Workspace = z.infer<typeof stateSchema>;
export type RecordedInput = Workspace["inputs"][number];
export type Actant = Workspace["actants"][number];
export const operationSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("reader-command"), command: readerCommandSchema })
    .strict(),
  z
    .object({
      type: z.literal("import-publication"),
      projectId: id,
      relativePath: z.string().min(1).max(4000),
      title,
      content: publicationSchema,
    })
    .strict(),
  scriptOperationSchema,
  z
    .object({
      type: z.literal("prepare-script"),
      generation: scriptGenerationSchema,
    })
    .strict(),
  ...bookmarkOperations,
  z
    .object({
      type: z.literal("reorder-tasks"),
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
    .strict(),
  z
    .object({ type: z.literal("create-conversation"), projectId: id, title })
    .strict(),
  z
    .object({
      type: z.literal("update-conversation"),
      conversationId: id,
      expectedRevision: z.number().int().positive(),
      title: title.optional(),
      archived: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("install-application"),
      manifest: applicationManifestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("launch-application"),
      workspaceId: id,
      applicationId: z.string(),
      applicationVersion: z.string(),
      // Omitted restores the current view; null explicitly opens the collection.
      artifactId: id.nullable().optional(),
      scriptTarget: scriptLocationSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("set-application-state"),
      instanceId: id,
      expectedRevision: z.number().int().positive(),
      state: applicationStateSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("close-application"),
      instanceId: id,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("request-task-run"),
      taskId: id,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("set-task-completed"),
      taskId: id,
      expectedRevision: z.number().int().positive(),
      completed: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("arrange-task"),
      taskId: id,
      expectedRevision: z.number().int().positive(),
      changes: z
        .object({
          projectId: id.optional(),
          assigneeId: id.optional(),
          dueDate: z.iso.date().nullable().optional(),
          priority: z.enum(["low", "normal", "high"]).optional(),
          execution: z
            .enum(["planned", "active", "waiting", "completed", "cancelled"])
            .optional(),
        })
        .strict()
        .refine((v) => Object.keys(v).length > 0, "请选择要修改的安排。"),
    })
    .strict(),
  z
    .object({
      type: z.literal("cancel-task"),
      taskId: id,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("respond-task"),
      taskId: id,
      expectedRevision: z.number().int().positive(),
      body: z.string().trim().min(1).max(30000),
    })
    .strict(),
  z.object({ type: z.literal("create-project"), title }).strict(),
  z
    .object({
      type: z.literal("update-project"),
      projectId: id,
      expectedRevision: z.number().int().positive(),
      title: title.optional(),
      state: z.enum(["active", "archived", "deleted"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("import-document"),
      projectId: id,
      relativePath: z.string().min(1).max(1000),
      text,
    })
    .strict(),
  z
    .object({
      type: z.literal("import-pdf"),
      projectId: id,
      relativePath: z.string().min(1).max(1000),
      content: pdfContentSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("create-artifact"),
      projectId: id,
      conversationId: id.optional(),
      title,
      content: contentSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("organize-content"),
      target: contentRefSchema,
      expectedRevision: z.number().int().positive(),
      changes: contentOrganizationChangesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("revise-artifact"),
      artifactId: id,
      expectedRevision: z.number().int().positive(),
      title,
      content: contentSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("link-artifacts"),
      fromId: id,
      toId: id,
      relation: z.enum(["references", "uses", "produces"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("annotate"),
      artifactId: id,
      artifactRevision: z.number().int().positive(),
      quote: z.string().max(10000),
      page: z.number().int().positive().optional(),
      body: z.string().trim().min(1).max(10000),
    })
    .strict(),
  z
    .object({
      type: z.literal("record-input"),
      reading: readingInputSchema.optional(),
      continuation: continuationSchema.optional(),
      scriptGeneration: scriptGenerationSchema.optional(),
      model: z.string().trim().min(1).max(256).optional(),
      reasoningEffort: reasoningEffortSchema.optional(),
      conversationId: id.optional(),
      newConversation: z.object({ title }).strict().optional(),
      intent: inputIntentSchema.optional(),
      applicationInstanceId: id.optional(),
      application: z
        .object({
          id: z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/),
          version: z.string().regex(/^\d+\.\d+\.\d+$/),
        })
        .strict()
        .optional(),
      projectId: id,
      artifactId: id.nullable(),
      artifactRevision: z.number().int().positive().nullable(),
      selection: z.string().max(10000),
      body: z.string().trim().max(30000),
      textQuotes: textQuotesSchema.optional(),
      attachments: z.array(inputAttachmentSchema).max(8).optional(),
      browser: browserReferenceSchema.optional(),
      localFile: localFileReferenceSchema.optional(),
      directories: z.array(directoryGrantSchema).max(8).optional(),
      targetActantId: id,
    })
    .strict()
    .refine(
      (value) =>
        !!value.body.trim() ||
        !!value.attachments?.length ||
        !!value.textQuotes?.length,
      "请输入文字或添加附件。",
    ),
]);
export type Operation = z.infer<typeof operationSchema>;
export const commandSchema = z
  .object({
    commandId: z.uuid(),
    operation: operationSchema,
    applicationInstanceId: id.optional(),
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;
export type Receipt = {
  commandId: string;
  workspaceRevision: number;
  entityId: string;
};

export class DomainError extends Error {
  constructor(
    public code: "not_found" | "forbidden" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
  }
}
export const localAccess: AccessContext = {
  principalId: "local-owner",
  actantId: "local-human",
};
export const morphzAgentAccess: AccessContext = {
  principalId: "morphz-service",
  actantId: "morphz-agent",
};
export function initialWorkspace(now = new Date().toISOString()): Workspace {
  const state: Workspace = {
    schemaVersion: 1,
    id: "local-workspace",
    name: "我的工作空间",
    revision: 0,
    principals: [
      { id: "local-owner", name: "我" },
      { id: morphzAgentAccess.principalId, name: "Morphz" },
    ],
    actants: [
      {
        id: "local-human",
        kind: "human",
        name: "我",
        principalId: "local-owner",
      },
      {
        id: morphzAgentAccess.actantId,
        kind: "agent",
        name: "Morphz",
        principalId: morphzAgentAccess.principalId,
      },
    ],
    projects: [
      {
        id: "first-project",
        title: "我的项目",
        members: ["local-owner", "morphz-service"],
        createdAt: now,
      },
      {
        id: "local-worktable",
        kind: "desk",
        ownerPrincipalId: "local-owner",
        title: "未归项目",
        members: ["local-owner", "morphz-service"],
        createdAt: now,
      },
      {
        id: "local-inbox",
        kind: "inbox",
        ownerPrincipalId: "local-owner",
        title: "事项",
        members: ["local-owner", "morphz-service"],
        createdAt: now,
      },
      {
        id: "local-dialogue",
        kind: "dialogue",
        ownerPrincipalId: "local-owner",
        title: "对话",
        members: ["local-owner", "morphz-service"],
        createdAt: now,
      },
    ],
    applications: [],
    conversations: [],
    scriptProductions: [],
    scriptPreparations: [],
    applicationInstances: [],
    artifacts: [],
    bookmarks: [],
    readingMarks: [],
    readingStates: [],
    taskOrder: [],
    taskOrderRevision: 0,
    relations: [],
    annotations: [],
    inputs: [],
    taskResponses: [],
  };
  ensureDiscussions(state);
  return state;
}
export function getArtifact(state: Workspace, artifactId: string): Artifact {
  const artifact = state.artifacts.find((a) => a.id === artifactId);
  if (!artifact) throw new DomainError("not_found", "对象不存在。");
  return artifact;
}
/** Stable semantic order, shared by Human views, Agent tools and admission. */
export function orderedTasks(state: Workspace) {
  const tasks = state.artifacts.filter(
    (a): a is Artifact & { content: TaskContent } => a.content.kind === "task",
  );
  const positions = new Map(state.taskOrder.map((id, index) => [id, index]));
  return tasks.sort(
    (a, b) =>
      (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}
export function currentTaskResponse(state: Workspace, task: Artifact) {
  if (task.content.kind !== "task" || task.content.execution !== "completed")
    return undefined;
  const content = task.content;
  return state.taskResponses
    .filter(
      (r) => r.taskId === task.id && r.author.actantId === content.assigneeId,
    )
    .findLast((r) => {
      const source = task.versions.find(
        (v) => v.revision === r.taskRevision,
      )?.content;
      return (
        source?.kind === "task" &&
        source.description === content.description &&
        task.versions
          .filter((v) => v.revision > r.taskRevision)
          .every(
            (v) =>
              v.content.kind === "task" &&
              v.content.execution === "completed" &&
              v.content.assigneeId === content.assigneeId &&
              v.content.description === source.description,
          )
      );
    });
}
export function checkProject(
  state: Workspace,
  projectId: string,
  access: AccessContext,
) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) throw new DomainError("not_found", "项目不存在。");
  if (!project.members.includes(access.principalId))
    throw new DomainError("forbidden", "没有访问这个项目的权限。");
  return project;
}
export function spaceKind(space: Workspace["projects"][number]) {
  return space.kind ?? "project";
}
export function applicationFor(
  state: Workspace,
  applicationId: string,
  version: string,
  principalId?: string,
) {
  if (
    applicationId === readerApplication.id &&
    version === readerApplication.version
  )
    return readerApplication;
  if (
    applicationId === browserApplication.id &&
    version === browserApplication.version
  )
    return browserApplication;
  if (
    applicationId === objectsApplication.id &&
    version === objectsApplication.version
  )
    return objectsApplication;
  if (
    applicationId === scriptStudioApplication.id &&
    version === scriptStudioApplication.version
  )
    return scriptStudioApplication;
  const app = state.applications.find(
    (a) =>
      a.id === applicationId &&
      a.version === version &&
      (!principalId || a.installedBy === principalId),
  );
  if (!app) throw new DomainError("not_found", "应用版本未安装或不可用。");
  return app;
}
