import { z } from "zod";
import { assertProjectWritable, projectManager } from "./projects.js";
import { reasoningEffortSchema } from "./inference.js";
import { inputIntentSchema } from "./input-intent.js";
import { continuationSchema } from "./continuation.js";
import {
  localFileReferenceSchema,
  directoryGrantSchema,
} from "./local-files.js";
import {
  documentImportIssue,
  documentTextIssue,
  maxDocumentCharacters,
} from "./sources.js";
import { pdfContentSchema, pdfImportIssue } from "./pdf.js";
import { websiteURL } from "./browser.js";
import { bookmarkSchema, bookmarkOperations } from "./bookmarks.js";
import { interactiveSchema, interactiveText } from "./interactive.js";
import {
  applicationManifestSchema,
  applicationInstanceSchema,
  applicationStateSchema,
  objectsApplication,
  browserApplication,
} from "./applications.js";

export const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const title = z.string().trim().min(1).max(180);
const text = z.string().max(maxDocumentCharacters);
const timestamp = z.iso.datetime();
export const contentSchema = z.discriminatedUnion("kind", [
  pdfContentSchema,
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
  z
    .object({
      kind: z.literal("task"),
      description: text,
      assigneeId: id,
      model: z.string().trim().min(1).max(100).nullable(),
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
    .strict(),
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
const browserReferenceSchema = z
  .object({
    pageId: z.uuid(),
    epoch: z.uuid(),
    url: z.string().max(4000),
    title: z.string().max(500),
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
    artifacts: z.array(artifactSchema),
    bookmarks: z.array(bookmarkSchema).default([]),
    taskOrder: z.array(id).default([]),
    taskOrderRevision: z.number().int().nonnegative().default(0),
    applications: z
      .array(applicationManifestSchema.extend({ installedBy: id }).strict())
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
          projectId: id,
          conversationId: id.optional(),
          artifactId: id.nullable(),
          artifactRevision: z.number().int().positive().nullable(),
          selection: z.string().max(10000),
          body: z.string().trim().max(30000),
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
          application: z
            .object({
              instanceId: id,
              id: z.string(),
              version: z.string(),
              harness: z
                .object({ id: z.string(), version: z.string() })
                .nullable(),
            })
            .strict()
            .optional(),
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
export type Actant = Workspace["actants"][number];
export const operationSchema = z.discriminatedUnion("type", [
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
      type: z.literal("save-workspace-as-project"),
      workspaceId: id,
      title,
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
      artifactId: id.optional(),
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
  z
    .object({
      type: z.literal("sync-linked-document"),
      projectId: id,
      artifactId: z.uuid(),
      sourceId: z.uuid(),
      deviceId: z.uuid(),
      relativePath: z.string().min(1).max(1000),
      text,
    })
    .strict(),
  z
    .object({
      type: z.literal("linked-source-status"),
      projectId: id,
      sourceId: z.uuid(),
      deviceId: z.uuid(),
      artifactId: z.uuid().optional(),
      status: z.enum(["current", "paused", "unavailable"]),
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
      artifactId: id,
      expectedRevision: z.number().int().positive(),
      changes: z
        .object({ title: title.optional(), projectId: id.optional() })
        .strict()
        .refine(
          (value) => Object.keys(value).length > 0,
          "请指定要修改的名称或归属。",
        ),
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
      continuation: continuationSchema.optional(),
      model: z.string().trim().min(1).max(256).optional(),
      reasoningEffort: reasoningEffortSchema.optional(),
      conversationId: id.optional(),
      newConversation: z.object({ title }).strict().optional(),
      intent: inputIntentSchema.optional(),
      applicationInstanceId: id.optional(),
      projectId: id,
      artifactId: id.nullable(),
      artifactRevision: z.number().int().positive().nullable(),
      selection: z.string().max(10000),
      body: z.string().trim().max(30000),
      attachments: z.array(inputAttachmentSchema).max(8).optional(),
      browser: browserReferenceSchema.optional(),
      localFile: localFileReferenceSchema.optional(),
      directories: z.array(directoryGrantSchema).max(8).optional(),
      targetActantId: id,
    })
    .strict()
    .refine(
      (value) => !!value.body.trim() || !!value.attachments?.length,
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
export function initialWorkspace(now = new Date().toISOString()): Workspace {
  const state: Workspace = {
    schemaVersion: 1,
    id: "local-workspace",
    name: "我的工作空间",
    revision: 0,
    principals: [
      { id: "local-owner", name: "我" },
      { id: "morphz-service", name: "Morphz" },
    ],
    actants: [
      {
        id: "local-human",
        kind: "human",
        name: "我",
        principalId: "local-owner",
      },
      {
        id: "morphz-agent",
        kind: "agent",
        name: "Morphz",
        principalId: "morphz-service",
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
        title: "工作台",
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
    applicationInstances: [],
    artifacts: [],
    bookmarks: [],
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
function checkContent(state: Workspace, projectId: string, content: Content) {
  if (content.kind === "document" && content.understanding) {
    for (const ref of content.understanding.sources) {
      const artifact = getArtifact(state, ref.artifactId);
      if (
        artifact.projectId !== projectId ||
        !artifact.versions.some((v) => v.revision === ref.revision)
      )
        throw new DomainError(
          "invalid",
          "当前理解的来源必须是本项目可用的对象版本。",
        );
    }
  }
  if (content.kind !== "task") return;
  const assignee = state.actants.find((a) => a.id === content.assigneeId);
  const project = state.projects.find((p) => p.id === projectId)!;
  if (!assignee || !project.members.includes(assignee.principalId))
    throw new DomainError("invalid", "负责人不在这个项目中。");
  if (assignee.kind === "human" && content.model !== null)
    throw new DomainError("invalid", "人工事项不使用执行模型。");
  if (
    assignee.kind === "human" &&
    (content.runRequested || content.everySeconds)
  )
    throw new DomainError("invalid", "人工事项由负责人回应，不启动模型调度。");
  for (const sourceId of [...content.dependsOnIds, ...content.watchSourceIds]) {
    const source = getArtifact(state, sourceId);
    if (source.projectId !== projectId)
      throw new DomainError("invalid", "依赖和关注来源必须属于当前项目。");
  }
  for (const dependency of content.dependsOnIds)
    if (getArtifact(state, dependency).content.kind !== "task")
      throw new DomainError("invalid", "事项只能依赖另一个事项。");
  if (content.delivery !== "none" && !content.resultIds.length)
    throw new DomainError("invalid", "交付需要关联产物。");
  for (const resultId of content.resultIds) {
    if (getArtifact(state, resultId).projectId !== projectId)
      throw new DomainError("invalid", "交付产物必须属于当前项目。");
  }
}

/** Pure, shared command boundary. Identity comes from a trusted adapter, never the command body. */
export function bookmarkOwner(
  state: Workspace,
  access: AccessContext,
  inputId?: string,
) {
  const actor = state.actants.find(
    (a) => a.id === access.actantId && a.principalId === access.principalId,
  );
  if (!actor) throw new DomainError("forbidden", "参与者与主体不匹配。");
  if (actor.kind === "human") return actor.principalId;
  // Only the persisted initiating input can delegate this person's bookmarks.
  // Neither the model nor a project containing multiple people chooses an owner.
  const input = state.inputs.find(
    (i) => i.id === inputId && i.targetActantId === actor.id,
  );
  const human = state.actants.find(
    (a) =>
      a.id === input?.author.actantId &&
      a.principalId === input.author.principalId &&
      a.kind === "human",
  );
  if (!input || !human)
    throw new DomainError("forbidden", "收藏操作需要发起用户的实际输入。");
  checkProject(state, input.projectId, access);
  checkProject(state, input.projectId, input.author);
  return human.principalId;
}

export function applyCommand(
  current: Workspace,
  command: Command,
  access: AccessContext,
  now = new Date().toISOString(),
  originInputId?: string,
): { state: Workspace; receipt: Receipt } {
  const actor = current.actants.find((a) => a.id === access.actantId);
  if (!actor || actor.principalId !== access.principalId)
    throw new DomainError("forbidden", "参与者与主体不匹配。");
  const state = structuredClone(current),
    op = command.operation;
  ensureDiscussions(state);
  // Reads and historical references remain valid. New work cannot mutate a
  // retired container; lifecycle commands are the explicit recovery path.
  if (op.type !== "update-project") {
    const targets = new Set<string>();
    if ("projectId" in op) targets.add(op.projectId);
    if ("workspaceId" in op) targets.add(op.workspaceId);
    if ("artifactId" in op && op.artifactId) {
      const artifact = state.artifacts.find((a) => a.id === op.artifactId);
      if (artifact) targets.add(artifact.projectId);
    }
    if ("taskId" in op) {
      const task = state.artifacts.find((a) => a.id === op.taskId);
      if (task) targets.add(task.projectId);
    }
    if (op.type === "arrange-task" && op.changes.projectId)
      targets.add(op.changes.projectId);
    if (op.type === "reorder-tasks")
      for (const id of op.taskIds) {
        const task = state.artifacts.find((a) => a.id === id);
        if (task) targets.add(task.projectId);
      }
    if (op.type === "organize-content" && op.changes.projectId)
      targets.add(op.changes.projectId);
    if (op.type === "update-conversation") {
      const conversation = state.conversations.find(
        (c) => c.id === op.conversationId,
      );
      if (conversation) targets.add(conversation.projectId);
    }
    if ("instanceId" in op) {
      const instance = state.applicationInstances.find(
        (i) => i.id === op.instanceId,
      );
      if (
        instance &&
        op.type !== "set-application-state" &&
        op.type !== "close-application"
      )
        targets.add(instance.workspaceId);
    }
    if (op.type === "link-artifacts")
      for (const id of [op.fromId, op.toId]) {
        const artifact = state.artifacts.find((a) => a.id === id);
        if (artifact) targets.add(artifact.projectId);
      }
    for (const id of targets)
      assertProjectWritable(checkProject(state, id, access));
  }
  // An application frame never receives a general-purpose command capability.
  if (command.applicationInstanceId) {
    const instance = state.applicationInstances.find(
      (i) => i.id === command.applicationInstanceId && i.status === "open",
    );
    if (!instance) throw new DomainError("not_found", "应用已关闭或不存在。");
    checkProject(state, instance.workspaceId, access);
    const manifest = applicationFor(
      state,
      instance.applicationId,
      instance.applicationVersion,
    );
    if (
      !manifest.permissions.includes("artifacts.write") ||
      ![
        "create-artifact",
        "revise-artifact",
        "annotate",
        "link-artifacts",
      ].includes(op.type)
    )
      throw new DomainError("forbidden", "应用没有执行此操作的权限。");
    const scopes =
      op.type === "create-artifact"
        ? [op.projectId]
        : op.type === "revise-artifact" || op.type === "annotate"
          ? [getArtifact(state, op.artifactId).projectId]
          : op.type === "link-artifacts"
            ? [
                getArtifact(state, op.fromId).projectId,
                getArtifact(state, op.toId).projectId,
              ]
            : [];
    if (
      !scopes.length ||
      scopes.some((scope) => scope !== instance.workspaceId)
    )
      throw new DomainError("forbidden", "应用不能操作其他工作空间。");
    if (
      (op.type === "create-artifact" || op.type === "revise-artifact") &&
      ((op.content.kind === "task" && op.content.runRequested > 0) ||
        (op.type === "revise-artifact" &&
          (() => {
            const previous = getArtifact(state, op.artifactId).content;
            return previous.kind === "task" && previous.runRequested > 0;
          })()))
    )
      throw new DomainError(
        "forbidden",
        "应用可以准备事项，但不能通过对象写入启动或更改执行安排。请由用户在宿主确认。",
      );
  }
  let entityId = command.commandId;
  if (
    op.type === "bookmark-add" ||
    op.type === "bookmark-update" ||
    op.type === "bookmark-remove" ||
    op.type === "bookmark-restore"
  ) {
    const owner = bookmarkOwner(state, access, originInputId);
    if (op.type === "bookmark-add") {
      const existing = state.bookmarks.find(
        (b) => b.ownerPrincipalId === owner && b.url === op.url && !b.deletedAt,
      );
      if (existing) entityId = existing.id;
      else
        state.bookmarks.push({
          id: entityId,
          ownerPrincipalId: owner,
          title: op.title,
          url: op.url,
          revision: 1,
          createdBy: access,
          updatedBy: access,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
    } else {
      const bookmark = state.bookmarks.find(
        (b) => b.id === op.bookmarkId && b.ownerPrincipalId === owner,
      );
      if (!bookmark)
        throw new DomainError("not_found", "收藏不存在或不可访问。");
      if (bookmark.revision !== op.expectedRevision)
        throw new DomainError("conflict", "收藏已被修改，请重新查看后再操作。");
      if ((op.type === "bookmark-restore") !== !!bookmark.deletedAt)
        throw new DomainError("conflict", "收藏状态已改变，请重新查看。");
      const url = op.type === "bookmark-update" ? op.url : bookmark.url;
      if (
        op.type !== "bookmark-remove" &&
        state.bookmarks.some(
          (b) =>
            b.id !== bookmark.id &&
            b.ownerPrincipalId === owner &&
            !b.deletedAt &&
            b.url === url,
        )
      )
        throw new DomainError("conflict", "这个网址已经收藏，原收藏未改动。");
      if (op.type === "bookmark-update") {
        bookmark.title = op.title;
        bookmark.url = op.url;
      }
      bookmark.deletedAt = op.type === "bookmark-remove" ? now : null;
      bookmark.updatedBy = access;
      bookmark.updatedAt = now;
      bookmark.revision++;
      entityId = bookmark.id;
    }
  }
  if (
    (op.type === "create-artifact" || op.type === "revise-artifact") &&
    op.content.kind === "website" &&
    (op.type === "create-artifact" ||
      getArtifact(state, op.artifactId).content.kind !== "website")
  )
    throw new DomainError(
      "invalid",
      "已停止新建网页收藏内容对象。请使用浏览器收藏操作；已保存的旧网页仍可访问。",
    );
  if (
    op.type === "create-artifact" &&
    op.content.kind === "document" &&
    op.content.understanding &&
    state.artifacts.some(
      (a) =>
        a.projectId === op.projectId &&
        a.content.kind === "document" &&
        a.content.understanding,
    )
  )
    throw new DomainError(
      "conflict",
      "该项目已有当前理解，请读取并修订同一对象。",
    );
  if (
    (op.type === "create-artifact" || op.type === "revise-artifact") &&
    op.content.kind === "document" &&
    op.content.understanding &&
    actor.kind !== "agent"
  )
    throw new DomainError(
      "forbidden",
      "当前理解由 Agent 通过上下文事务维护。请提交纠正，而不是直接改写记录。",
    );
  if (op.type === "revise-artifact") {
    const previous = getArtifact(state, op.artifactId);
    if (
      previous.content.kind === "task" &&
      op.content.kind === "task" &&
      op.content.runRequested > 0 &&
      op.content.runRequested !== previous.content.runRequested &&
      op.content.runRequested <=
        Math.max(
          ...previous.versions.map((v) =>
            v.content.kind === "task" ? v.content.runRequested : 0,
          ),
        )
    )
      throw new DomainError(
        "invalid",
        "新的执行安排不能复用历史编号，请使用开始执行操作或更大的 runRequested。",
      );
    if (
      previous.content.kind === "document" &&
      previous.content.understanding &&
      actor.kind !== "agent"
    )
      throw new DomainError("forbidden", "请向 Agent 提交纠正。");
  }
  if (op.type === "organize-content") {
    const artifact = getArtifact(state, op.artifactId);
    const source = checkProject(state, artifact.projectId, access);
    if (artifact.content.kind === "task")
      throw new DomainError("invalid", "事项请使用事项安排操作。");
    if (artifact.content.kind === "document" && artifact.content.understanding)
      throw new DomainError("forbidden", "工作空间理解不能作为普通内容整理。");
    if (artifact.revision !== op.expectedRevision)
      throw new DomainError("conflict", "内容已变化，请查看当前版本后操作。");
    const target = checkProject(
      state,
      op.changes.projectId ?? source.id,
      access,
    );
    if (target.id !== source.id) {
      if (
        !["project", "desk"].includes(target.kind ?? "project") &&
        target.id !== artifact.originProjectId
      )
        throw new DomainError("invalid", "请选择项目或工作台。");
      if (
        target.members.some((p) => !source.members.includes(p)) ||
        source.members.some((p) => !target.members.includes(p))
      )
        throw new DomainError(
          "forbidden",
          "两个空间的访问成员不同，不能直接移动内容及其历史。",
        );
      if (
        state.relations.some(
          (r) => r.fromId === artifact.id || r.toId === artifact.id,
        ) ||
        state.artifacts.some((a) =>
          a.content.kind === "task"
            ? [
                ...a.content.dependsOnIds,
                ...a.content.watchSourceIds,
                ...a.content.resultIds,
              ].includes(artifact.id)
            : a.content.kind === "document" &&
              a.content.understanding?.sources.some(
                (r) => r.artifactId === artifact.id,
              ),
        )
      )
        throw new DomainError(
          "invalid",
          "此内容有关联事项或对象，暂不能单独移动；原有关联会保留。",
        );
      artifact.originProjectId ??= source.id;
      artifact.projectId = target.id;
    }
    artifact.title = op.changes.title ?? artifact.title;
    artifact.revision++;
    artifact.updatedAt = now;
    artifact.versions.push({
      revision: artifact.revision,
      projectId: artifact.projectId,
      title: artifact.title,
      content: structuredClone(artifact.content),
      author: { ...access },
      createdAt: now,
    });
    entityId = artifact.id;
  } else if (op.type === "reorder-tasks") {
    if (op.expectedOrderRevision !== state.taskOrderRevision)
      throw new DomainError(
        "conflict",
        "事项顺序已变化，请读取最新顺序再调整。",
      );
    const selected = new Set(op.taskIds);
    if (selected.size !== op.taskIds.length)
      throw new DomainError("invalid", "排序不能包含重复事项。");
    for (const id of selected) {
      const task = getArtifact(state, id);
      checkProject(state, task.projectId, access);
      if (task.content.kind !== "task")
        throw new DomainError("invalid", "只能排序事项。");
    }
    if (op.move) {
      if (!selected.has(op.move.taskId))
        throw new DomainError("invalid", "移动的事项必须包含在排序中。");
      // Reuse the exact Human-status permission/version/dependency checks.
      state.artifacts = applyCommand(
        state,
        {
          ...command,
          operation: {
            type: "arrange-task",
            taskId: op.move.taskId,
            expectedRevision: op.move.expectedRevision,
            changes: { execution: op.move.execution },
          },
        },
        access,
        now,
      ).state.artifacts;
    }
    let index = 0;
    // Unlisted tasks retain their slots. Filtered views and project-scoped
    // Agents cannot displace unseen work or overwrite someone else's ordering.
    state.taskOrder = orderedTasks(state).map((a) =>
      selected.has(a.id) ? op.taskIds[index++]! : a.id,
    );
    state.taskOrderRevision++;
    entityId = op.move?.taskId ?? op.taskIds[0]!;
  } else if (op.type === "arrange-task" || op.type === "cancel-task") {
    const artifact = getArtifact(state, op.taskId);
    const source = checkProject(state, artifact.projectId, access);
    if (
      artifact.content.kind !== "task" ||
      artifact.revision !== op.expectedRevision
    )
      throw new DomainError("conflict", "事项已变化，请查看当前版本后操作。");
    const content = structuredClone(artifact.content);
    const changes = op.type === "arrange-task" ? op.changes : {};
    if (op.type === "cancel-task") {
      content.execution = "cancelled";
      content.runRequested = 0;
    }
    const target = checkProject(
      state,
      changes.projectId ?? artifact.projectId,
      access,
    );
    if (target.id !== source.id) {
      if (!["project", "inbox"].includes(target.kind ?? "project"))
        throw new DomainError("invalid", "请选择项目或无项目。");
      if (
        target.members.some((p) => !source.members.includes(p)) ||
        source.members.some((p) => !target.members.includes(p))
      )
        throw new DomainError(
          "forbidden",
          "两个项目的访问成员不同，不能直接移动事项及其历史。",
        );
      const linked =
        content.dependsOnIds.length ||
        content.watchSourceIds.length ||
        content.resultIds.length ||
        state.relations.some(
          (r) => r.fromId === artifact.id || r.toId === artifact.id,
        ) ||
        state.artifacts.some((a) =>
          a.content.kind === "task"
            ? [
                ...a.content.dependsOnIds,
                ...a.content.watchSourceIds,
                ...a.content.resultIds,
              ].includes(artifact.id)
            : a.content.kind === "document" &&
              a.content.understanding?.sources.some(
                (r) => r.artifactId === artifact.id,
              ),
        );
      if (linked)
        throw new DomainError(
          "invalid",
          "此事项已有项目内依赖或成果，请先处理关联再移动；原有关联不会被拆除。",
        );
      artifact.originProjectId ??= source.id;
      artifact.projectId = target.id;
    }
    if (changes.assigneeId && changes.assigneeId !== content.assigneeId) {
      // Assignment alone never submits an execution request, including undo.
      content.assigneeId = changes.assigneeId;
      content.model = null;
      content.runRequested = 0;
      content.notBefore = null;
      content.everySeconds = null;
      content.assignment = "accepted";
      content.execution = "planned";
    }
    if (changes.dueDate !== undefined) content.dueDate = changes.dueDate;
    if (changes.priority !== undefined) content.priority = changes.priority;
    if (
      changes.execution !== undefined &&
      changes.execution !== content.execution
    ) {
      if (actor.kind !== "human" || content.assigneeId !== access.actantId)
        throw new DomainError(
          "forbidden",
          "只能直接移动自己的事项；Morphz 的进度由实际执行更新。",
        );
      if (
        changes.execution === "completed" &&
        state.artifacts.some(
          (a) =>
            a.content.kind === "task" &&
            a.content.dependsOnIds.includes(artifact.id) &&
            !["completed", "cancelled"].includes(a.content.execution),
        )
      )
        throw new DomainError(
          "invalid",
          "此事项关联后续工作，请提交结果并完成。",
        );
      content.execution = changes.execution;
      content.assignment = "accepted";
    }
    checkContent(state, artifact.projectId, content);
    artifact.content = content;
    artifact.revision++;
    artifact.updatedAt = now;
    artifact.versions.push({
      revision: artifact.revision,
      projectId: artifact.projectId,
      title: artifact.title,
      content,
      author: { ...access },
      createdAt: now,
    });
    entityId = artifact.id;
  } else if (
    op.type === "request-task-run" ||
    op.type === "respond-task" ||
    op.type === "set-task-completed"
  ) {
    const artifact = getArtifact(state, op.taskId);
    checkProject(state, artifact.projectId, access);
    if (
      artifact.content.kind !== "task" ||
      artifact.revision !== op.expectedRevision
    )
      throw new DomainError("conflict", "事项已变化，请查看当前版本后操作。");
    const content = structuredClone(artifact.content),
      assignee = state.actants.find((a) => a.id === content.assigneeId)!;
    if (op.type === "request-task-run") {
      if (assignee.kind !== "agent")
        throw new DomainError("invalid", "人工事项请由负责人提交回应。");
      content.runRequested =
        Math.max(
          content.runRequested,
          ...artifact.versions.map((v) =>
            v.content.kind === "task" ? v.content.runRequested : 0,
          ),
        ) + 1;
      content.execution = "planned";
      content.assignment = "accepted";
    } else if (op.type === "set-task-completed") {
      if (
        actor.kind !== "human" ||
        assignee.kind !== "human" ||
        access.actantId !== assignee.id
      )
        throw new DomainError("forbidden", "只有本人可以标记自己的事项完成。");
      if (content.execution === "cancelled")
        throw new DomainError("conflict", "该事项已取消，请先重新安排。");
      if ((content.execution === "completed") === op.completed)
        throw new DomainError(
          "conflict",
          "事项状态已变化，请查看当前版本后操作。",
        );
      if (
        op.completed &&
        state.artifacts.some(
          (a) =>
            a.content.kind === "task" &&
            a.content.dependsOnIds.includes(artifact.id) &&
            !["completed", "cancelled"].includes(a.content.execution),
        )
      )
        throw new DomainError(
          "invalid",
          "此事项关联后续工作，请提交结果并完成。",
        );
      content.execution = op.completed ? "completed" : "planned";
      // This is an explicit Human status change, not a fabricated response or
      // an Agent execution receipt. Historical responses and deliveries stay.
      if (op.completed) content.assignment = "accepted";
    } else {
      if (assignee.kind !== "human" || access.actantId !== assignee.id)
        throw new DomainError("forbidden", "只有当前负责人可以回应这件事项。");
      if (["completed", "cancelled"].includes(content.execution))
        throw new DomainError("conflict", "该事项已结束。");
      content.execution = "completed";
      content.assignment = "accepted";
      state.taskResponses.push({
        id: command.commandId,
        taskId: artifact.id,
        taskRevision: artifact.revision,
        body: op.body,
        author: { ...access },
        createdAt: now,
      });
    }
    artifact.content = content;
    artifact.revision++;
    artifact.updatedAt = now;
    artifact.versions.push({
      revision: artifact.revision,
      title: artifact.title,
      content,
      author: { ...access },
      createdAt: now,
    });
    entityId = artifact.id;
  } else if (op.type === "sync-linked-document") {
    checkProject(state, op.projectId, access);
    const issue =
      documentImportIssue(op.relativePath) ?? documentTextIssue(op.text);
    if (issue) throw new DomainError("invalid", issue);
    const source = {
      mode: "linked" as const,
      name: op.relativePath.split("/").at(-1)!,
      relativePath: op.relativePath,
      importedAt: now,
      importedRevision: 1,
      connection: {
        sourceId: op.sourceId,
        deviceId: op.deviceId,
        status: "current" as const,
        checkedAt: now,
      },
    };
    const artifact = state.artifacts.find((a) => a.id === op.artifactId);
    if (!artifact) {
      const duplicate = state.artifacts.find(
        (a) =>
          a.projectId === op.projectId &&
          a.source?.connection?.sourceId === op.sourceId &&
          a.source?.connection?.deviceId === op.deviceId &&
          a.source.relativePath === op.relativePath,
      );
      if (duplicate)
        throw new DomainError("conflict", "该来源已有对象，请使用原对象标识。");
      const result = applyCommand(
        current,
        {
          commandId: op.artifactId,
          operation: {
            type: "create-artifact",
            projectId: op.projectId,
            title:
              source.name.replace(/\.(md|markdown|txt)$/i, "").slice(0, 180) ||
              "资料",
            content: { kind: "document", markdown: op.text },
          },
        },
        access,
        now,
      );
      getArtifact(result.state, op.artifactId).source = source;
      return {
        state: result.state,
        receipt: {
          commandId: command.commandId,
          workspaceRevision: result.state.revision,
          entityId: op.artifactId,
        },
      };
    }
    if (
      artifact.projectId !== op.projectId ||
      artifact.content.kind !== "document" ||
      artifact.source?.mode !== "linked" ||
      artifact.source.connection?.sourceId !== op.sourceId ||
      artifact.source.connection.deviceId !== op.deviceId ||
      artifact.source.relativePath !== op.relativePath
    )
      throw new DomainError("forbidden", "对象不属于这个资料来源。");
    if (artifact.content.markdown !== op.text) {
      artifact.content = { kind: "document", markdown: op.text };
      artifact.revision++;
      artifact.updatedAt = now;
      artifact.versions.push({
        revision: artifact.revision,
        title: artifact.title,
        content: artifact.content,
        author: { ...access },
        createdAt: now,
      });
    }
    artifact.source.connection = source.connection;
    entityId = artifact.id;
  } else if (op.type === "linked-source-status") {
    checkProject(state, op.projectId, access);
    for (const artifact of state.artifacts) {
      const connection = artifact.source?.connection;
      if (
        artifact.projectId === op.projectId &&
        connection?.sourceId === op.sourceId &&
        connection.deviceId === op.deviceId &&
        (!op.artifactId || artifact.id === op.artifactId)
      ) {
        connection.status = op.status;
        connection.checkedAt = now;
      }
    }
    entityId = op.sourceId;
  } else if (op.type === "save-workspace-as-project") {
    const space = checkProject(state, op.workspaceId, access);
    if (space.kind !== "desk" || space.ownerPrincipalId !== access.principalId)
      throw new DomainError("conflict", "只能将自己的当前工作台保存为项目。");
    space.kind = "project";
    space.title = op.title;
    state.projects.push({
      id: command.commandId,
      kind: "desk",
      ownerPrincipalId: access.principalId,
      title: "工作台",
      members: [...space.members],
      createdAt: now,
    });
    entityId = space.id;
  } else if (
    op.type === "create-conversation" ||
    op.type === "update-conversation"
  ) {
    const conversation =
      op.type === "update-conversation"
        ? state.conversations.find((c) => c.id === op.conversationId)
        : undefined;
    if (op.type === "update-conversation" && !conversation)
      throw new DomainError("not_found", "对话不存在。");
    const project = checkProject(
      state,
      op.type === "create-conversation"
        ? op.projectId
        : conversation!.projectId,
      access,
    );
    if (
      (op.type === "create-conversation" && actor.kind !== "human") ||
      spaceKind(project) !== "project"
    )
      throw new DomainError("forbidden", "只有项目成员可以管理项目内的对话。");
    if (op.type === "update-conversation")
      projectManager(state, access, originInputId, project.id);
    if (op.type === "create-conversation") {
      state.conversations.push({
        id: entityId,
        projectId: project.id,
        title: op.title,
        revision: 1,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      if (conversation!.revision !== op.expectedRevision)
        throw new DomainError("conflict", "对话已发生变化，请同步后重试。");
      if (op.archived && conversation!.id === project.id)
        throw new DomainError("invalid", "默认对话始终保留，无需归档。");
      if (op.title !== undefined) conversation!.title = op.title;
      if (op.archived !== undefined)
        conversation!.archivedAt = op.archived ? now : null;
      conversation!.updatedAt = now;
      conversation!.revision++;
      entityId = conversation!.id;
    }
  } else if (op.type === "install-application") {
    if (
      actor.kind !== "human" ||
      op.manifest.ui.type !== "sandbox" ||
      op.manifest.id.startsWith("morphz.")
    )
      throw new DomainError(
        "forbidden",
        "仅人类可以安装自定义界面，内置应用不可替换。",
      );
    const existing = state.applications.find(
      (a) => a.id === op.manifest.id && a.version === op.manifest.version,
    );
    if (existing)
      throw new DomainError(
        "conflict",
        "此应用版本已安装；修改后请使用新版本号。",
      );
    state.applications.push({
      ...op.manifest,
      installedBy: access.principalId,
    });
    entityId = op.manifest.id;
  } else if (op.type === "launch-application") {
    const space = checkProject(state, op.workspaceId, access);
    if (
      op.artifactId &&
      getArtifact(state, op.artifactId).projectId !== op.workspaceId
    )
      throw new DomainError("forbidden", "对象不属于这个工作空间。");
    const app = applicationFor(state, op.applicationId, op.applicationVersion);
    if (
      "installedBy" in app &&
      typeof app.installedBy === "string" &&
      !space.members.includes(app.installedBy)
    )
      throw new DomainError("forbidden", "应用未由这个工作空间的成员安装。");
    const existing = state.applicationInstances.find(
      (i) =>
        i.workspaceId === op.workspaceId &&
        i.applicationId === op.applicationId &&
        i.applicationVersion === op.applicationVersion,
    );
    if (existing) {
      if (existing.status !== "open") {
        existing.status = "open";
        existing.revision++;
        existing.updatedAt = now;
      }
      if (op.artifactId) {
        existing.state.artifactId = op.artifactId;
        existing.revision++;
        existing.updatedAt = now;
      }
      entityId = existing.id;
    } else
      state.applicationInstances.push({
        id: entityId,
        workspaceId: op.workspaceId,
        applicationId: op.applicationId,
        applicationVersion: op.applicationVersion,
        revision: 1,
        state: op.artifactId ? { artifactId: op.artifactId } : {},
        status: "open",
        createdAt: now,
        updatedAt: now,
      });
  } else if (
    op.type === "set-application-state" ||
    op.type === "close-application"
  ) {
    const instance = state.applicationInstances.find(
      (i) => i.id === op.instanceId,
    );
    if (!instance) throw new DomainError("not_found", "应用实例不存在。");
    checkProject(state, instance.workspaceId, access);
    if (instance.revision !== op.expectedRevision || instance.status !== "open")
      throw new DomainError("conflict", "应用状态已变化，请同步后重试。");
    if (op.type === "close-application") instance.status = "closed";
    else instance.state = op.state;
    instance.revision++;
    instance.updatedAt = now;
    entityId = instance.id;
  } else if (op.type === "update-project") {
    projectManager(state, access, originInputId, op.projectId);
    const project = checkProject(state, op.projectId, access);
    if (spaceKind(project) !== "project")
      throw new DomainError(
        "invalid",
        "只能管理命名项目，不能删除默认工作空间。",
      );
    if ((project.revision ?? 1) !== op.expectedRevision)
      throw new DomainError("conflict", "项目已发生变化，请核对后重试。");
    if (op.title === undefined && op.state === undefined)
      throw new DomainError("invalid", "需要指定项目变更。");
    if (project.deletedAt && op.state !== "active")
      throw new DomainError("conflict", "请先恢复已删除项目。");
    if (op.title !== undefined) project.title = op.title;
    if (op.state === "active") {
      project.archivedAt = null;
      project.deletedAt = null;
    }
    if (op.state === "archived") project.archivedAt = now;
    if (op.state === "deleted") project.deletedAt = now;
    project.revision = (project.revision ?? 1) + 1;
    project.updatedAt = now;
    entityId = project.id;
  } else if (op.type === "create-project") {
    const owner = projectManager(state, access, originInputId);
    state.projects.push({
      id: entityId,
      title: op.title,
      members: [owner.principalId, "morphz-service"],
      ownerPrincipalId: owner.principalId,
      createdAt: now,
      revision: 1,
      updatedAt: now,
    });
  } else if (
    op.type === "create-artifact" ||
    op.type === "import-document" ||
    op.type === "import-pdf"
  ) {
    checkProject(state, op.projectId, access);
    if (op.type === "create-artifact" && op.conversationId)
      checkConversation(state, op.projectId, op.conversationId, access);
    if (op.type === "import-document") {
      const issue =
        documentImportIssue(op.relativePath) ?? documentTextIssue(op.text);
      if (issue) throw new DomainError("invalid", issue);
    }
    if (op.type === "import-pdf") {
      const issue = pdfImportIssue(op.relativePath);
      if (issue) throw new DomainError("invalid", issue);
    }
    const name =
      op.type !== "create-artifact" ? op.relativePath.split("/").at(-1)! : "";
    const content: Content =
      op.type === "import-document"
        ? { kind: "document", markdown: op.text }
        : op.content;
    const importedTitle =
      name.replace(/\.(md|markdown|txt|pdf)$/i, "").slice(0, 180) ||
      "导入的文档";
    const artifactTitle =
      op.type !== "create-artifact" ? importedTitle : op.title;
    checkContent(state, op.projectId, content);
    state.artifacts.push({
      id: entityId,
      projectId: op.projectId,
      ...(op.type === "create-artifact" && op.conversationId
        ? { originConversationId: op.conversationId }
        : {}),
      title: artifactTitle,
      content,
      revision: 1,
      createdBy: { ...access },
      createdAt: now,
      updatedAt: now,
      versions: [
        {
          revision: 1,
          title: artifactTitle,
          content,
          author: { ...access },
          createdAt: now,
        },
      ],
      source:
        op.type !== "create-artifact"
          ? {
              mode: "copy",
              name,
              relativePath: op.relativePath,
              importedAt: now,
              importedRevision: 1,
            }
          : null,
    });
  } else if (op.type === "revise-artifact") {
    const artifact = getArtifact(state, op.artifactId);
    checkProject(state, artifact.projectId, access);
    if (artifact.source?.mode === "linked")
      throw new DomainError(
        "invalid",
        "这是外部资料的只读版本。请创建副本后编辑，原文件不会被改写。",
      );
    if (artifact.revision !== op.expectedRevision)
      throw new DomainError(
        "conflict",
        "对象已有新版本。你的草稿已保留，请对照新版本再保存。",
      );
    if (artifact.content.kind !== op.content.kind)
      throw new DomainError("invalid", "不能在修订中更换对象类型。");
    checkContent(state, artifact.projectId, op.content);
    if (op.content.kind === "task") {
      const pending = [...op.content.dependsOnIds],
        seen = new Set<string>();
      while (pending.length) {
        const dependency = pending.pop()!;
        if (dependency === artifact.id)
          throw new DomainError("invalid", "事项依赖不能形成循环。");
        if (seen.has(dependency)) continue;
        seen.add(dependency);
        const next = getArtifact(state, dependency).content;
        if (next.kind === "task") pending.push(...next.dependsOnIds);
      }
    }
    if (
      op.content.kind === "task" &&
      op.content.resultIds.includes(artifact.id)
    )
      throw new DomainError("invalid", "事项不能交付自身。");
    artifact.title = op.title;
    artifact.content = op.content;
    artifact.revision++;
    artifact.updatedAt = now;
    artifact.versions.push({
      revision: artifact.revision,
      title: artifact.title,
      content: artifact.content,
      author: { ...access },
      createdAt: now,
    });
    entityId = artifact.id;
  } else if (op.type === "link-artifacts") {
    const from = getArtifact(state, op.fromId),
      to = getArtifact(state, op.toId);
    checkProject(state, from.projectId, access);
    checkProject(state, to.projectId, access);
    if (from.id === to.id || from.projectId !== to.projectId)
      throw new DomainError("invalid", "请选择同一项目内的另一个对象。");
    const existing = state.relations.find(
      (r) => r.fromId === from.id && r.toId === to.id && r.type === op.relation,
    );
    if (existing) entityId = existing.id;
    else
      state.relations.push({
        id: entityId,
        fromId: from.id,
        toId: to.id,
        type: op.relation,
        createdBy: { ...access },
        createdAt: now,
      });
  } else if (op.type === "annotate") {
    const artifact = getArtifact(state, op.artifactId);
    checkProject(state, artifact.projectId, access);
    const version = artifact.versions.find(
      (v) => v.revision === op.artifactRevision,
    );
    if (
      !version ||
      !op.quote.trim() ||
      !quotedText(version.content).includes(op.quote) ||
      (op.page !== undefined &&
        (version.content.kind !== "pdf" ||
          !version.content.pages[op.page - 1]?.includes(op.quote)))
    )
      throw new DomainError("invalid", "批注引用的原文或版本无效。");
    state.annotations.push({
      id: entityId,
      artifactId: artifact.id,
      artifactRevision: op.artifactRevision,
      quote: op.quote,
      ...(op.page !== undefined ? { page: op.page } : {}),
      body: op.body,
      author: { ...access },
      createdAt: now,
    });
  } else if (op.type === "record-input") {
    const original = op.continuation
      ? state.inputs.find((i) => i.id === op.continuation!.inputId)
      : undefined;
    if (op.continuation) {
      if (
        !original ||
        original.continuation?.mode === "supplement" ||
        original.projectId !== op.projectId ||
        discussionId(original) !== discussionId(op) ||
        original.author.principalId !== access.principalId ||
        original.author.actantId !== access.actantId ||
        original.targetActantId !== op.targetActantId ||
        actor.kind !== "human"
      )
        throw new DomainError(
          "forbidden",
          "不能补充其他身份或工作范围的执行。",
        );
      if (
        op.newConversation ||
        op.applicationInstanceId ||
        op.directories?.length ||
        op.localFile ||
        op.browser ||
        op.artifactId !== original.artifactId ||
        op.artifactRevision !== original.artifactRevision ||
        op.selection ||
        op.model ||
        op.reasoningEffort
      )
        throw new DomainError(
          "invalid",
          "补充沿用原工作的对象、模型和权限，不改变执行范围。",
        );
    }
    if (
      op.localFile &&
      (op.artifactId || op.applicationInstanceId || op.browser)
    )
      throw new DomainError(
        "invalid",
        "本机文件引用不能与另一对象或应用混用。",
      );
    if (!op.body.trim() && !op.attachments?.length)
      throw new DomainError("invalid", "请输入文字或添加附件。");
    const project = checkProject(state, op.projectId, access);
    const conversationId = discussionId(op);
    if (op.newConversation) {
      if (actor.kind !== "human" || spaceKind(project) !== "project")
        throw new DomainError(
          "forbidden",
          "只有项目成员可以开始项目内的对话。",
        );
      if (
        !op.conversationId ||
        state.projects.some((p) => p.id === conversationId)
      )
        throw new DomainError("invalid", "新对话需要独立的标识。");
      const existing = state.conversations.find((c) => c.id === conversationId);
      if (existing && existing.projectId !== project.id)
        throw new DomainError("forbidden", "对话不属于当前项目。");
      // Created inside the same command transaction as the first real input.
      // Any later validation failure rolls both back. Existing IDs are never
      // renamed or rebound, including retries after a lost response.
      if (!existing)
        state.conversations.push({
          id: conversationId,
          projectId: project.id,
          title: op.newConversation.title,
          revision: 1,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        });
    }
    const conversation = checkConversation(
      state,
      project.id,
      conversationId,
      access,
    );
    if (conversation.archivedAt && actor.kind === "human")
      throw new DomainError(
        "conflict",
        "此对话已归档，请恢复后再发送。草稿不会丢失。",
      );
    const instance = op.applicationInstanceId
      ? state.applicationInstances.find(
          (i) =>
            i.id === op.applicationInstanceId &&
            i.workspaceId === project.id &&
            i.status === "open",
        )
      : undefined;
    if (op.applicationInstanceId && !instance)
      throw new DomainError("conflict", "当前应用已关闭或不属于这个工作空间。");
    const app = instance
      ? applicationFor(
          state,
          instance.applicationId,
          instance.applicationVersion,
        )
      : undefined;
    const target = state.actants.find((a) => a.id === op.targetActantId);
    if (!target || !project.members.includes(target.principalId))
      throw new DomainError("invalid", "接收者不在项目中。");
    if (op.artifactId) {
      const artifact = getArtifact(state, op.artifactId);
      if (artifact.projectId !== project.id)
        throw new DomainError("forbidden", "对象不属于当前项目。");
      const version = artifact.versions.find(
        (v) => v.revision === op.artifactRevision,
      );
      if (!version)
        throw new DomainError("invalid", "输入必须关联有效的对象版本。");
      if (op.selection && !quotedText(version.content).includes(op.selection))
        throw new DomainError("invalid", "选中内容与对象版本不匹配。");
    } else if (op.artifactRevision !== null || (op.selection && !op.localFile))
      throw new DomainError("invalid", "未选择对象时不能附带版本或原文。");
    state.inputs.push({
      id: entityId,
      ...(op.continuation ? { continuation: op.continuation } : {}),
      projectId: op.projectId,
      conversationId,
      artifactId: op.artifactId,
      artifactRevision: op.artifactRevision,
      selection: op.selection,
      body: op.body,
      author: { ...access },
      targetActantId: op.targetActantId,
      ...(op.attachments?.length ? { attachments: op.attachments } : {}),
      ...(op.browser ? { browser: op.browser } : {}),
      ...(op.localFile ? { localFile: op.localFile } : {}),
      ...(op.directories?.length ? { directories: op.directories } : {}),
      status: "recorded",
      ...(op.intent ? { intent: op.intent } : {}),
      ...(op.model ? { model: op.model } : {}),
      ...(op.reasoningEffort ? { reasoningEffort: op.reasoningEffort } : {}),
      ...(app && instance
        ? {
            application: {
              instanceId: instance.id,
              id: app.id,
              version: app.version,
              harness: app.harness,
            },
          }
        : {}),
      ...(original && op.continuation?.mode === "follow-up"
        ? {
            application: original.application,
            directories: original.directories,
            localFile: original.localFile,
            browser: original.browser,
            selection: original.selection,
            model: original.model,
            reasoningEffort: original.reasoningEffort,
          }
        : {}),
      createdAt: now,
    });
  }
  ensureDiscussions(state);
  state.revision++;
  return {
    state,
    receipt: {
      commandId: command.commandId,
      workspaceRevision: state.revision,
      entityId,
    },
  };
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
    applicationId === browserApplication.id &&
    version === browserApplication.version
  )
    return browserApplication;
  if (
    applicationId === objectsApplication.id &&
    version === objectsApplication.version
  )
    return objectsApplication;
  const app = state.applications.find(
    (a) =>
      a.id === applicationId &&
      a.version === version &&
      (!principalId || a.installedBy === principalId),
  );
  if (!app) throw new DomainError("not_found", "应用版本未安装或不可用。");
  return app;
}
export function inboxFor(state: Workspace, principalId: string) {
  const actants = new Set(
    state.actants.filter((a) => a.principalId === principalId).map((a) => a.id),
  );
  return state.artifacts
    .filter(
      (a) =>
        a.content.kind === "task" &&
        actants.has(a.content.assigneeId) &&
        !["completed", "cancelled"].includes(a.content.execution) &&
        state.projects.some(
          (p) =>
            p.id === a.projectId &&
            !p.deletedAt &&
            !p.archivedAt &&
            p.members.includes(principalId),
        ),
    )
    .sort((a, b) => {
      const x = a.content as TaskContent,
        y = b.content as TaskContent,
        priority = { high: 0, normal: 1, low: 2 };
      return (
        priority[x.priority] - priority[y.priority] ||
        (x.dueDate ?? "9999").localeCompare(y.dueDate ?? "9999")
      );
    });
}
