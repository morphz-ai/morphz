import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { pdfContentSchema } from "../../../packages/core/src/pdf.js";
import { SearchIndex } from "./search-index.js";
import {
  taskRunBusy,
  taskRuntimeSchema,
} from "../../../packages/core/src/task-runtime.js";
import { z } from "zod";
import { projectManager } from "../../core/src/projects.js";
import type { SearchRequest } from "../../../packages/core/src/retrieval.js";
import type { ArtifactOutput } from "../../../packages/core/src/conversation.js";
import {
  applyCommand,
  commandSchema,
  DomainError,
  initialWorkspace,
  ensureDiscussions,
  stateSchema,
  localAccess,
  id,
  type AccessContext,
  type Receipt,
  type Workspace,
} from "../../../packages/core/src/model.js";

export class WorkspaceStore {
  private db: DatabaseSync;
  private index: SearchIndex;
  constructor(filename: string) {
    if (filename !== ":memory:")
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;",
    );
    const version = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version.user_version > 12) {
      this.db.close();
      throw new Error("数据库版本高于当前应用支持范围，请使用更新的 Morphz。");
    }
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_outputs (command_id TEXT PRIMARY KEY REFERENCES commands(id), input_id TEXT NOT NULL, project_id TEXT NOT NULL, artifact_id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS asset_owners (asset_id TEXT NOT NULL REFERENCES assets(id), principal_id TEXT NOT NULL, PRIMARY KEY(asset_id,principal_id));
      CREATE TABLE IF NOT EXISTS pdf_metadata (asset_id TEXT PRIMARY KEY REFERENCES assets(id), pages TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS center_metadata (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS service_state (name TEXT PRIMARY KEY, body TEXT NOT NULL);`);
    if (version.user_version < 10)
      this.db
        .prepare("INSERT OR IGNORE INTO asset_owners SELECT id,? FROM assets")
        .run(localAccess.principalId);
    this.db.exec("COMMIT");
    this.db
      .prepare("INSERT OR IGNORE INTO center_metadata(id,identity) VALUES(1,?)")
      .run(randomUUID());
    this.db
      .prepare("INSERT OR IGNORE INTO workspace(id,body) VALUES(1,?)")
      .run(JSON.stringify(initialWorkspace()));
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const migrated = this.snapshot();
      this.ensurePersonalSpaces(migrated);
      this.db
        .prepare("UPDATE workspace SET body=? WHERE id=1")
        .run(JSON.stringify(migrated));
      this.index = new SearchIndex(this.db);
      this.index.sync(this.snapshot());
      this.db.exec("PRAGMA user_version=12");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  snapshot(): Workspace {
    const row = this.db
      .prepare("SELECT body FROM workspace WHERE id=1")
      .get() as { body: string };
    return stateSchema.parse(JSON.parse(row.body));
  }
  private ensurePersonalSpaces(state: Workspace) {
    for (const principal of state.principals) {
      if (
        !state.actants.some(
          (a) => a.principalId === principal.id && a.kind === "human",
        )
      )
        continue;
      for (const kind of ["desk", "inbox", "dialogue"] as const) {
        if (
          state.projects.some(
            (p) => p.kind === kind && p.ownerPrincipalId === principal.id,
          )
        )
          continue;
        state.projects.push({
          id: randomUUID(),
          kind,
          ownerPrincipalId: principal.id,
          title: { desk: "工作台", inbox: "事项", dialogue: "对话" }[kind],
          members: [principal.id, "morphz-service"],
          createdAt: new Date().toISOString(),
        });
        state.revision++;
      }
    }
    ensureDiscussions(state);
  }
  identity(): string {
    return (
      this.db
        .prepare("SELECT identity FROM center_metadata WHERE id=1")
        .get() as { identity: string }
    ).identity;
  }
  /** Local control-plane provisioning, not a browser mutation or an Agent tool. */
  provisionMembers(
    members: {
      principalId: string;
      actantId: string;
      name: string;
      projectIds: string[];
      enabled: boolean;
    }[],
  ) {
    if (members.length > 200) throw new Error("成员数量超过上限。");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.snapshot();
      for (const member of members) {
        id.parse(member.principalId);
        id.parse(member.actantId);
        if (!member.name.trim() || member.name.length > 180)
          throw new Error("成员名称无效。");
        const actor = state.actants.find((a) => a.id === member.actantId);
        if (
          actor &&
          (actor.kind !== "human" || actor.principalId !== member.principalId)
        )
          throw new Error("不能重绑定既有参与者身份。");
        if (
          state.actants.some(
            (a) => a.principalId === member.principalId && a.kind !== "human",
          )
        )
          throw new Error("不能将 Agent 身份配置为 Human。");
        for (const projectId of member.projectIds)
          if (!state.projects.some((p) => p.id === projectId))
            throw new Error("成员配置引用了不存在的项目。");
        const principal = state.principals.find(
          (p) => p.id === member.principalId,
        );
        if (principal) principal.name = member.name;
        else
          state.principals.push({ id: member.principalId, name: member.name });
        if (actor) actor.name = member.name;
        else
          state.actants.push({
            id: member.actantId,
            principalId: member.principalId,
            name: member.name,
            kind: "human",
          });
        for (const project of state.projects) {
          project.members = project.members.filter(
            (p) => p !== member.principalId,
          );
          if (
            member.enabled &&
            (member.projectIds.includes(project.id) ||
              ((project.kind === "desk" ||
                project.kind === "inbox" ||
                project.kind === "dialogue") &&
                project.ownerPrincipalId === member.principalId))
          )
            project.members.push(member.principalId);
        }
      }
      this.ensurePersonalSpaces(state);
      const checked = stateSchema.parse(state);
      if (JSON.stringify(checked) !== JSON.stringify(this.snapshot())) {
        checked.revision++;
        this.index.sync(checked);
        this.db
          .prepare("UPDATE workspace SET body=? WHERE id=1")
          .run(JSON.stringify(checked));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  runtimeState(): unknown {
    const row = this.db
      .prepare("SELECT body FROM runtime_state WHERE id=1")
      .get() as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  serviceState(name: string): unknown {
    const row = this.db
      .prepare("SELECT body FROM service_state WHERE name=?")
      .get(name) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  saveServiceState(name: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO service_state(name,body) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET body=excluded.body WHERE body<>excluded.body",
      )
      .run(name, JSON.stringify(value));
  }
  saveRuntimeState(value: unknown) {
    const body = JSON.stringify(value);
    const previous = this.db
      .prepare("SELECT body FROM runtime_state WHERE id=1")
      .get() as { body: string } | undefined;
    if (previous?.body === body) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO runtime_state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
        )
        .run(body);
      const state = this.snapshot();
      state.revision++;
      this.db
        .prepare("UPDATE workspace SET body=? WHERE id=1")
        .run(JSON.stringify(state));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  artifactOutputs(access: AccessContext): ArtifactOutput[] {
    const state = this.snapshot();
    const projects = new Set(
      state.projects
        .filter((p) => p.members.includes(access.principalId))
        .map((p) => p.id),
    );
    return (
      this.db
        .prepare(
          "SELECT command_id AS commandId,input_id AS inputId,project_id AS projectId,artifact_id AS artifactId,revision,created_at AS createdAt FROM artifact_outputs ORDER BY created_at,command_id",
        )
        .all() as ArtifactOutput[]
    ).filter(
      (o) =>
        projects.has(o.projectId) &&
        state.inputs.some(
          (i) => i.id === o.inputId && i.projectId === o.projectId,
        ) &&
        state.artifacts.some(
          (a) => a.id === o.artifactId && projects.has(a.projectId),
        ),
    );
  }
  projectBlockers(projectId: string, ownInputId?: string): string[] {
    const state = this.snapshot();
    const runtime = z
      .object({
        deliveries: z
          .array(z.object({ inputId: z.string(), state: z.string() }))
          .default([]),
      })
      .parse(this.runtimeState() ?? {});
    const blockers = runtime.deliveries
      .filter(
        (d) =>
          d.inputId !== ownInputId &&
          ["queued", "sending", "running"].includes(d.state) &&
          state.inputs.some(
            (i) => i.id === d.inputId && i.projectId === projectId,
          ),
      )
      .map(() => "有对话正在执行或等待投递");
    const saved = z
      .object({
        runs: z
          .array(
            z
              .object({
                taskId: z.string(),
                watchSourceIds: z.array(z.string()).default([]),
              })
              .passthrough(),
          )
          .default([]),
      })
      .parse(this.serviceState("collaboration") ?? {});
    for (const task of state.artifacts.filter(
      (a) => a.projectId === projectId && a.content.kind === "task",
    )) {
      if (task.content.kind !== "task") continue;
      const content = task.content;
      const taskState = taskRuntimeSchema.parse({
        runs: saved.runs
          .filter((r) => r.taskId === task.id)
          .map((r) => ({ ...r, hasSourceWatch: r.watchSourceIds.length > 0 })),
      });
      if (
        taskRunBusy(content, taskState) ||
        taskState.runs.some((r) =>
          taskRunBusy(
            { ...content, runRequested: r.run },
            { ...taskState, runs: [r] },
          ),
        )
      )
        blockers.push(`「${task.title}」仍有执行或待执行安排`);
    }
    return [...new Set(blockers)];
  }
  execute(
    raw: unknown,
    access: AccessContext,
    originInputId?: string,
    validateNew?: () => void,
  ): Receipt {
    const command = commandSchema.parse(raw);
    const management = [
      "create-project",
      "update-project",
      "update-conversation",
    ].includes(command.operation.type);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          command,
          access,
          ...(management && originInputId
            ? { originInputId: originInputId ?? null }
            : {}),
        }),
      )
      .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (management) {
        const state = this.snapshot(),
          op = command.operation;
        projectManager(
          state,
          access,
          originInputId,
          op.type === "update-project"
            ? op.projectId
            : op.type === "update-conversation"
              ? state.conversations.find((c) => c.id === op.conversationId)
                  ?.projectId
              : undefined,
        );
      }
      const previous = this.db
        .prepare("SELECT fingerprint,receipt FROM commands WHERE id=?")
        .get(command.commandId) as
        { fingerprint: string; receipt: string } | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new DomainError("conflict", "这个操作标识已经用于另一项请求。");
        const output = this.db
          .prepare("SELECT input_id FROM artifact_outputs WHERE command_id=?")
          .get(command.commandId) as { input_id: string } | undefined;
        if (output && originInputId && output.input_id !== originInputId)
          throw new DomainError("conflict", "交付回执不能改绑到另一条输入。");
        this.db.exec("COMMIT");
        return JSON.parse(previous.receipt) as Receipt;
      }
      const op = command.operation;
      validateNew?.();
      // Enforce the execution boundary inside the same transaction as the edit.
      // A stale UI (or a generic revise command) cannot silently retarget work.
      const taskId =
        op.type === "arrange-task" ||
        op.type === "request-task-run" ||
        op.type === "cancel-task"
          ? op.taskId
          : op.type === "revise-artifact"
            ? op.artifactId
            : null;
      const currentState = this.snapshot();
      if (op.type === "update-project" && op.state && op.state !== "active") {
        const blockers = this.projectBlockers(op.projectId, originInputId);
        if (blockers.length)
          throw new DomainError(
            "conflict",
            `${blockers.join("；")}。请先停止并确认结束，再${op.state === "deleted" ? "删除" : "归档"}项目。`,
          );
      }
      const task = currentState.artifacts.find((a) => a.id === taskId);
      if (task?.content.kind === "task") {
        const currentTask = task.content;
        const reassign =
          op.type === "arrange-task"
            ? (op.changes.projectId !== undefined &&
                op.changes.projectId !== task.projectId) ||
              (op.changes.assigneeId !== undefined &&
                op.changes.assigneeId !== task.content.assigneeId)
            : op.type === "revise-artifact" &&
              op.content.kind === "task" &&
              op.content.assigneeId !== task.content.assigneeId &&
              currentState.actants.find((a) => a.id === access.actantId)
                ?.kind === "human";
        if (
          reassign ||
          op.type === "request-task-run" ||
          op.type === "cancel-task"
        ) {
          const saved = z
            .object({
              runs: z
                .array(
                  z
                    .object({
                      taskId: z.string(),
                      watchSourceIds: z.array(z.string()).default([]),
                    })
                    .passthrough(),
                )
                .default([]),
            })
            .parse(this.serviceState("collaboration") ?? {});
          const runtime = taskRuntimeSchema.parse({
            runs: saved.runs
              .filter((r) => r.taskId === task.id)
              .map((r) => ({
                ...r,
                hasSourceWatch: r.watchSourceIds.length > 0,
              })),
          });
          const deliveries = z
            .object({
              deliveries: z
                .array(z.object({ inputId: z.string(), state: z.string() }))
                .default([]),
            })
            .parse(this.runtimeState() ?? {}).deliveries;
          const directActive = deliveries.some(
            (d) =>
              ["queued", "sending", "running"].includes(d.state) &&
              currentState.inputs.some(
                (i) => i.id === d.inputId && i.artifactId === task.id,
              ),
          );
          const withdrawnBeforeAdmission =
            op.type === "cancel-task" &&
            !runtime.runs.some((r) => r.run === currentTask.runRequested);
          if (
            runtime.runs.some(
              (r) =>
                r.run !== currentTask.runRequested &&
                taskRunBusy(
                  { ...currentTask, runRequested: r.run },
                  { runs: [r], error: "" },
                ),
            ) ||
            (!withdrawnBeforeAdmission && taskRunBusy(task.content, runtime)) ||
            directActive
          )
            throw new DomainError(
              "conflict",
              reassign
                ? "此事项仍有执行或待执行安排，请先停止再更改项目或负责人。"
                : "此事项已有执行或待执行安排，请先停止；不会重复启动。",
            );
        }
      }
      if (op.type === "record-input")
        for (const attachment of op.attachments ?? []) {
          const asset = this.attachmentAsset(attachment.assetId, access);
          if (!asset)
            throw new DomainError(
              "forbidden",
              "无权使用这份附件，请通过当前身份上传。",
            );
          if (attachment.mime && attachment.mime !== asset.mime)
            throw new DomainError("invalid", "附件类型与上传文件不一致。");
        }
      if (
        (op.type === "create-artifact" ||
          op.type === "revise-artifact" ||
          op.type === "import-pdf") &&
        (op.content.kind === "image" || op.content.kind === "pdf") &&
        !this.db
          .prepare(
            "SELECT 1 FROM asset_owners WHERE asset_id=? AND principal_id=?",
          )
          .get(op.content.assetId, access.principalId) &&
        !this.index.assetVisible(op.content.assetId, access)
      )
        throw new DomainError(
          "forbidden",
          "无权使用这份原始文件，请先通过当前身份上传。",
        );
      if (
        (op.type === "create-artifact" ||
          op.type === "revise-artifact" ||
          op.type === "import-pdf") &&
        op.content.kind === "pdf"
      ) {
        const saved = this.db
          .prepare("SELECT pages FROM pdf_metadata WHERE asset_id=?")
          .get(op.content.assetId) as { pages: string } | undefined;
        if (!saved || saved.pages !== JSON.stringify(op.content.pages))
          throw new DomainError("invalid", "PDF 内容与已解析的原文件不匹配。");
      }
      if (
        (op.type === "create-artifact" || op.type === "revise-artifact") &&
        op.content.kind === "image" &&
        !this.asset(op.content.assetId)?.mime.startsWith("image/")
      )
        throw new DomainError("invalid", "图片尚未上传或已经不可用。");
      const { state, receipt } = applyCommand(
        this.snapshot(),
        command,
        access,
        undefined,
        originInputId,
      );
      const output =
        originInputId &&
        (op.type === "create-artifact" || op.type === "revise-artifact")
          ? state.artifacts.find((a) => a.id === receipt.entityId)
          : undefined;
      if (
        output &&
        !state.inputs.some(
          (i) => i.id === originInputId && i.projectId === output.projectId,
        )
      )
        throw new DomainError("forbidden", "交付对象不属于原始输入的项目。");
      this.index.sync(state);
      this.db
        .prepare("UPDATE workspace SET body=? WHERE id=1")
        .run(JSON.stringify(state));
      this.db
        .prepare("INSERT INTO commands(id,fingerprint,receipt) VALUES(?,?,?)")
        .run(command.commandId, fingerprint, JSON.stringify(receipt));
      if (output)
        this.db
          .prepare("INSERT INTO artifact_outputs VALUES(?,?,?,?,?,?)")
          .run(
            command.commandId,
            originInputId!,
            output.projectId,
            output.id,
            output.revision,
            output.updatedAt,
          );
      this.db.exec("COMMIT");
      return receipt;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  addAsset(
    bytes: Buffer,
    access: AccessContext = localAccess,
  ): { assetId: string; mime: string } {
    if (!bytes.length || bytes.length > 6 * 1024 * 1024)
      throw new DomainError("invalid", "图片大小应在 0～6 MB 之间。");
    let mime: string;
    if (
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      mime = "image/png";
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
      mime = "image/jpeg";
    else if (
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP"
    )
      mime = "image/webp";
    else throw new DomainError("invalid", "目前支持 PNG、JPEG 和 WebP 图片。");
    const assetId = createHash("sha256").update(bytes).digest("hex");
    this.db
      .prepare("INSERT OR IGNORE INTO assets(id,mime,bytes) VALUES(?,?,?)")
      .run(assetId, mime, bytes);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO asset_owners(asset_id,principal_id) VALUES(?,?)",
      )
      .run(assetId, access.principalId);
    return { assetId, mime };
  }
  asset(id: string): { mime: string; bytes: Uint8Array } | undefined {
    return this.db
      .prepare("SELECT mime,bytes FROM assets WHERE id=?")
      .get(id) as { mime: string; bytes: Uint8Array } | undefined;
  }
  addAttachment(bytes: Buffer, name: string, access: AccessContext) {
    if (/\.(png|jpe?g|webp)$/i.test(name)) return this.addAsset(bytes, access);
    let mime: string;
    if (/\.pdf$/i.test(name) && bytes.subarray(0, 5).toString() === "%PDF-") {
      if (bytes.length > 20 * 1024 * 1024)
        throw new DomainError("invalid", "PDF 不能超过 20 MB。");
      mime = "application/pdf";
    } else if (/\.(txt|md|markdown)$/i.test(name)) {
      if (bytes.length > 8 * 1024 * 1024)
        throw new DomainError("invalid", "文本文件不能超过 8 MB。");
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new DomainError("invalid", "请使用 UTF-8 文本文件。");
      }
      if (bytes.includes(0))
        throw new DomainError("invalid", "这不是文本文件。");
      mime = /\.txt$/i.test(name) ? "text/plain" : "text/markdown";
    } else
      throw new DomainError("invalid", "支持图片、PDF、TXT 和 Markdown 附件。");
    if (!bytes.length) throw new DomainError("invalid", "不能添加空文件。");
    const assetId = createHash("sha256").update(bytes).digest("hex");
    this.db
      .prepare("INSERT OR IGNORE INTO assets(id,mime,bytes) VALUES(?,?,?)")
      .run(assetId, mime, bytes);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO asset_owners(asset_id,principal_id) VALUES(?,?)",
      )
      .run(assetId, access.principalId);
    return { assetId, mime: this.asset(assetId)!.mime };
  }
  search(request: SearchRequest, access: AccessContext) {
    return this.index.search(request, access);
  }
  visibleAsset(id: string, access: AccessContext) {
    if (!this.index.assetVisible(id, access)) return undefined;
    return this.asset(id);
  }
  attachmentAsset(id: string, access: AccessContext) {
    if (
      !this.index.assetVisible(id, access) &&
      !this.db
        .prepare(
          "SELECT 1 FROM asset_owners WHERE asset_id=? AND principal_id=?",
        )
        .get(id, access.principalId) &&
      !this.snapshot().inputs.some(
        (input) =>
          input.attachments?.some((a) => a.assetId === id) &&
          this.snapshot().projects.some(
            (p) =>
              p.id === input.projectId &&
              p.members.includes(access.principalId),
          ),
      )
    )
      return undefined;
    return this.asset(id);
  }
  addPdf(bytes: Buffer, pages: string[], access: AccessContext = localAccess) {
    const assetId = createHash("sha256").update(bytes).digest("hex");
    const content = pdfContentSchema.parse({ kind: "pdf", assetId, pages });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO assets(id,mime,bytes) VALUES(?,?,?)")
        .run(assetId, "application/pdf", bytes);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO asset_owners(asset_id,principal_id) VALUES(?,?)",
        )
        .run(assetId, access.principalId);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO pdf_metadata(asset_id,pages) VALUES(?,?)",
        )
        .run(assetId, JSON.stringify(pages));
      this.db.exec("COMMIT");
      return content;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
