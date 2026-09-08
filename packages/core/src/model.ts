import { z } from "zod";
import {
  documentImportIssue,
  documentTextIssue,
  maxDocumentCharacters,
} from "./sources.js";
import { pdfContentSchema, pdfImportIssue } from "./pdf.js";
import { websiteURL } from "./browser.js";
import { interactiveSchema, interactiveText } from "./interactive.js";
import {
  applicationManifestSchema,
  applicationInstanceSchema,
  applicationStateSchema,
  objectsApplication,
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
      priority: z.enum(["low", "normal", "high"]),
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
const versionSchema = z
  .object({
    revision: z.number().int().positive(),
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
          kind: z.enum(["project", "desk", "inbox"]).optional(),
          ownerPrincipalId: id.optional(),
        })
        .strict(),
    ),
    artifacts: z.array(artifactSchema),
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
          projectId: id,
          artifactId: id.nullable(),
          artifactRevision: z.number().int().positive().nullable(),
          selection: z.string().max(10000),
          body: z.string().trim().min(1).max(30000),
          author: authorSchema,
          targetActantId: id,
          status: z.literal("recorded"),
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
      title,
      content: contentSchema,
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
      applicationInstanceId: id.optional(),
      projectId: id,
      artifactId: id.nullable(),
      artifactRevision: z.number().int().positive().nullable(),
      selection: z.string().max(10000),
      body: z.string().trim().min(1).max(30000),
      targetActantId: id,
    })
    .strict(),
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
  return {
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
    ],
    applications: [],
    applicationInstances: [],
    artifacts: [],
    relations: [],
    annotations: [],
    inputs: [],
    taskResponses: [],
  };
}
export function getArtifact(state: Workspace, artifactId: string): Artifact {
  const artifact = state.artifacts.find((a) => a.id === artifactId);
  if (!artifact) throw new DomainError("not_found", "对象不存在。");
  return artifact;
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
export function applyCommand(
  current: Workspace,
  command: Command,
  access: AccessContext,
  now = new Date().toISOString(),
): { state: Workspace; receipt: Receipt } {
  const actor = current.actants.find((a) => a.id === access.actantId);
  if (!actor || actor.principalId !== access.principalId)
    throw new DomainError("forbidden", "参与者与主体不匹配。");
  const state = structuredClone(current),
    op = command.operation;
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
  if (op.type === "request-task-run" || op.type === "respond-task") {
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
  } else if (op.type === "create-project") {
    state.projects.push({
      id: entityId,
      title: op.title,
      members: [access.principalId, "morphz-service"],
      createdAt: now,
    });
  } else if (
    op.type === "create-artifact" ||
    op.type === "import-document" ||
    op.type === "import-pdf"
  ) {
    checkProject(state, op.projectId, access);
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
    const project = checkProject(state, op.projectId, access);
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
    } else if (op.artifactRevision !== null || op.selection)
      throw new DomainError("invalid", "未选择对象时不能附带版本或原文。");
    state.inputs.push({
      id: entityId,
      projectId: op.projectId,
      artifactId: op.artifactId,
      artifactRevision: op.artifactRevision,
      selection: op.selection,
      body: op.body,
      author: { ...access },
      targetActantId: op.targetActantId,
      status: "recorded",
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
      createdAt: now,
    });
  }
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
          (p) => p.id === a.projectId && p.members.includes(principalId),
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
