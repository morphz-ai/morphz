import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { pdfContentSchema } from "../../../packages/core/src/pdf.js";
import {
  publicationSchema,
  readingReference,
  readingPosition,
  readingSourceId,
  type ParsedPublication,
  type ReaderSection,
  type ReadingSection,
} from "../../core/src/reader.js";
import { assertReaderAccess } from "../../core/src/reader-commands.js";
import { ocrResultSchema, type ReadingOcr } from "../../core/src/reader-ocr.js";
import { readArtifact } from "../../core/src/retrieval.js";
import { markdownSections, safeReadingSection } from "./reader-import.js";
import { SearchIndex } from "./search-index.js";
import { migrateContentOwnership } from "./content-migration.js";
import { removeReadingPolicyFields } from "../../core/src/reading-policy-migration.js";
import { contentEntry } from "../../core/src/content.js";
import {
  taskRunBusy,
  taskRuntimeSchema,
} from "../../../packages/core/src/task-runtime.js";
import { z } from "zod";
import { projectManager } from "../../core/src/projects.js";
import { assertScriptAccess } from "../../core/src/script-studio-commands.js";
import type { SearchRequest } from "../../../packages/core/src/retrieval.js";
import type { ArtifactOutput } from "../../../packages/core/src/conversation.js";
import {
  scriptDelivery,
  scriptOutputSchema,
  resolveScriptLocation,
  type ScriptOutput,
} from "../../core/src/script-delivery.js";
import {
  applyCommand,
  commandSchema,
  bookmarkOwner,
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
    if (version.user_version > 16) {
      this.db.close();
      throw new Error("数据库版本高于当前应用支持范围，请使用更新的 Morphz。");
    }
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_outputs (command_id TEXT PRIMARY KEY REFERENCES commands(id), input_id TEXT NOT NULL, project_id TEXT NOT NULL, artifact_id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS script_outputs (command_id TEXT PRIMARY KEY REFERENCES commands(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS asset_owners (asset_id TEXT NOT NULL REFERENCES assets(id), principal_id TEXT NOT NULL, PRIMARY KEY(asset_id,principal_id));
      CREATE TABLE IF NOT EXISTS pdf_metadata (asset_id TEXT PRIMARY KEY REFERENCES assets(id), pages TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publication_metadata (asset_id TEXT PRIMARY KEY REFERENCES assets(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publication_sections (asset_id TEXT NOT NULL REFERENCES assets(id), section_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(asset_id,section_id));
      CREATE TABLE IF NOT EXISTS reading_ocr (asset_id TEXT NOT NULL REFERENCES assets(id), section_id TEXT NOT NULL, page INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(asset_id,section_id));
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
      if (version.user_version < 16) {
        const row = this.db
          .prepare("SELECT body FROM workspace WHERE id=1")
          .get() as { body: string };
        const raw = JSON.parse(row.body);
        for (const reading of raw.readingStates ?? [])
          removeReadingPolicyFields(reading.preferences);
        for (const input of raw.inputs ?? [])
          removeReadingPolicyFields(input.reading);
        // Delivery envelopes, receipts, identities, source text and locations
        // remain untouched. Only the removed application policy fields go away.
        this.db
          .prepare("UPDATE workspace SET body=? WHERE id=1")
          .run(JSON.stringify(raw));
      }
      const migrated = this.snapshot();
      this.ensurePersonalSpaces(migrated);
      if (version.user_version < 14) {
        for (const p of migrated.projects.filter(
          (p) => p.kind === "dialogue" || p.kind === "inbox",
        )) {
          if (
            (migrated.artifacts.some((a) => a.projectId === p.id) ||
              migrated.scriptProductions.some((s) => s.projectId === p.id)) &&
            this.projectBlockers(p.id).length
          )
            throw new DomainError(
              "conflict",
              "个人内容仍有执行中的工作，请在执行结束后升级；原数据未改动。",
            );
        }
        migrateContentOwnership(migrated);
      }
      this.db
        .prepare("UPDATE workspace SET body=? WHERE id=1")
        .run(JSON.stringify(migrated));
      this.index = new SearchIndex(this.db);
      this.index.sync(this.snapshot());
      this.db.exec("PRAGMA user_version=16");
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
          title: { desk: "未归项目", inbox: "事项", dialogue: "对话" }[kind],
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
  artifactOutputs(
    access: AccessContext,
    state = this.snapshot(),
  ): ArtifactOutput[] {
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
  scriptOutputs(
    access: AccessContext,
    state = this.snapshot(),
  ): ScriptOutput[] {
    const projects = new Set(
      state.projects
        .filter((p) => p.members.includes(access.principalId))
        .map((p) => p.id),
    );
    return this.db
      .prepare("SELECT body FROM script_outputs ORDER BY command_id")
      .all()
      .map((row) => scriptOutputSchema.parse(JSON.parse(row.body as string)))
      .filter((output) => {
        const resolved = resolveScriptLocation(state, output);
        return (
          resolved &&
          projects.has(resolved.production.projectId) &&
          projects.has(output.projectId) &&
          state.inputs.some(
            (i) => i.id === output.inputId && projects.has(i.projectId),
          )
        );
      })
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.commandId.localeCompare(b.commandId),
      );
  }
  private saveScriptOutput(output: ScriptOutput | null) {
    return output
      ? this.db
          .prepare(
            "INSERT OR IGNORE INTO script_outputs(command_id,body) VALUES(?,?)",
          )
          .run(output.commandId, JSON.stringify(output)).changes !== 0
      : false;
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
            (i) =>
              i.id === d.inputId &&
              (i.projectId === projectId ||
                state.scriptPreparations.some(
                  (p) => p.inputId === i.id && p.projectId === projectId,
                )),
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
  hasCommand(commandId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM commands WHERE id=?")
      .get(commandId);
  }
  execute(
    raw: unknown,
    access: AccessContext,
    originInputId?: string,
    validateNew?: () => void,
  ): Receipt {
    const command = commandSchema.parse(raw);
    const isBookmark = command.operation.type.startsWith("bookmark-");
    const isReader = command.operation.type === "reader-command";
    const management = [
      "create-project",
      "update-project",
      "update-conversation",
      "organize-content",
    ].includes(command.operation.type);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          command,
          access,
          ...(isBookmark ||
          isReader ||
          command.operation.type === "script-command" ||
          command.operation.type === "prepare-script" ||
          (management && originInputId)
            ? { originInputId: originInputId ?? null }
            : {}),
        }),
      )
      .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (isBookmark) bookmarkOwner(this.snapshot(), access, originInputId);
      if (command.operation.type === "reader-command")
        assertReaderAccess(
          this.snapshot(),
          command.operation.command,
          access,
          originInputId,
        );
      if (management) {
        const state = this.snapshot(),
          op = command.operation;
        projectManager(
          state,
          access,
          originInputId,
          op.type === "update-project"
            ? op.projectId
            : op.type === "organize-content"
              ? contentEntry(state, op.target).value.projectId
              : op.type === "update-conversation"
                ? state.conversations.find((c) => c.id === op.conversationId)
                    ?.projectId
                : undefined,
        );
      }
      if (
        command.operation.type === "script-command" ||
        command.operation.type === "prepare-script"
      )
        assertScriptAccess(
          this.snapshot(),
          command.operation.type === "script-command"
            ? command.operation.command
            : {
                action: "prepare",
                productionId: command.operation.generation.productionId,
              },
          access,
          originInputId,
        );
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
      if (
        (op.type === "script-command" || op.type === "prepare-script") &&
        this.snapshot().actants.some(
          (a) => a.id === access.actantId && a.kind === "agent",
        )
      ) {
        const runtime = this.runtimeState() as {
          deliveries?: {
            inputId: string;
            state: string;
            cancelRequested?: boolean;
          }[];
        } | null;
        const delivery = runtime?.deliveries?.find(
          (d) => d.inputId === originInputId,
        );
        if (
          !delivery ||
          !["sending", "running"].includes(delivery.state) ||
          delivery.cancelRequested
        )
          throw new DomainError(
            "forbidden",
            "剧本执行已停止、结束或尚未获准执行；迟到结果不能写入。",
          );
      }
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
      if (
        op.type === "organize-content" &&
        (op.changes.projectId || op.changes.newProjectTitle)
      ) {
        const object = contentEntry(currentState, op.target).value;
        const blockers = this.projectBlockers(object.projectId, originInputId);
        if (blockers.length)
          throw new DomainError(
            "conflict",
            "相关工作仍在执行，请结束后再调整内容归属。原内容与草稿未改动。",
          );
      }
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
          op.type === "import-pdf" ||
          op.type === "import-publication") &&
        (op.content.kind === "image" ||
          op.content.kind === "pdf" ||
          op.content.kind === "publication") &&
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
          op.type === "import-publication") &&
        op.content.kind === "publication"
      ) {
        const saved = this.db
          .prepare("SELECT body FROM publication_metadata WHERE asset_id=?")
          .get(op.content.assetId) as { body: string } | undefined;
        if (!saved || saved.body !== JSON.stringify(op.content))
          throw new DomainError("invalid", "读物目录与已解析的原文件不匹配。");
      }
      if (op.type === "record-input" && op.reading) {
        if (!op.artifactId || !op.artifactRevision)
          throw new DomainError("invalid", "阅读引用缺少原文版本。");
        const section = this.readerSection(
          op.artifactId,
          op.artifactRevision,
          op.reading.location.sectionId,
          access,
        );
        const expected = (
          "quote" in op.reading ? readingReference : readingPosition
        )(section, op.reading.location);
        if ("quote" in expected && "quote" in op.reading) {
          // Context may be shorter than the maximum, but must be exact adjacent
          // source text. A saved selection need not grow when defaults change.
          Object.assign(expected, {
            before: section.text.slice(
              Math.max(0, op.reading.location.start - op.reading.before.length),
              op.reading.location.start,
            ),
            after: section.text.slice(
              op.reading.location.end,
              op.reading.location.end + op.reading.after.length,
            ),
          });
        }
        if (
          section.sourceId !== op.reading.location.sourceId ||
          JSON.stringify(expected) !== JSON.stringify(op.reading)
        )
          throw new DomainError(
            "invalid",
            "阅读引用与已保存的原文不匹配，请重新选择。",
          );
      }
      if (op.type === "reader-command" && "location" in op.command) {
        const c = op.command,
          section = this.readerSection(
            c.artifactId,
            c.artifactRevision,
            c.location.sectionId,
            access,
          );
        const expected = readingReference(section, c.location);
        if (
          section.sourceId !== c.location.sourceId ||
          ("quote" in c && c.quote !== expected.quote)
        )
          throw new DomainError("invalid", "标注位置与原文不匹配。");
      }
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
      if (originInputId && op.type === "script-command")
        this.saveScriptOutput(
          scriptDelivery(state, op.command, command.commandId, originInputId),
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
  addPublication(
    bytes: Buffer,
    parsed: ParsedPublication,
    access: AccessContext,
  ) {
    const assetId = createHash("sha256").update(bytes).digest("hex"),
      content = publicationSchema.parse(parsed.content);
    if (
      content.assetId !== assetId ||
      content.sections.length !== parsed.sections.length ||
      content.sections.some(
        (s, index) =>
          s.id !== parsed.sections[index]?.id ||
          s.characters !== parsed.sections[index]?.text.length,
      )
    )
      throw new DomainError("invalid", "读物解析结果与源文件不一致。");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO assets(id,mime,bytes) VALUES(?,?,?)")
        .run(assetId, "application/octet-stream", bytes);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO asset_owners(asset_id,principal_id) VALUES(?,?)",
        )
        .run(assetId, access.principalId);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO publication_metadata(asset_id,body) VALUES(?,?)",
        )
        .run(assetId, JSON.stringify(content));
      const save = this.db.prepare(
        "INSERT OR IGNORE INTO publication_sections(asset_id,section_id,body) VALUES(?,?,?)",
      );
      for (const section of parsed.sections)
        save.run(assetId, section.id, JSON.stringify(section));
      this.db.exec("COMMIT");
      return content;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  readerSection(
    artifactId: string,
    revision: number,
    sectionId: string,
    access: AccessContext,
  ): ReadingSection {
    const version = readArtifact(this.snapshot(), artifactId, access, revision),
      content = version.content;
    let section: ReaderSection | undefined, ocr: ReadingOcr | undefined;
    if (content.kind === "publication") {
      if (!content.sections.some((s) => s.id === sectionId))
        throw new DomainError("not_found", "章节不存在。");
      const saved = this.db
        .prepare(
          "SELECT body FROM publication_sections WHERE asset_id=? AND section_id=?",
        )
        .get(content.assetId, sectionId) as { body: string } | undefined;
      if (saved) section = JSON.parse(saved.body) as ReaderSection;
    } else if (content.kind === "document" && !content.understanding)
      section = markdownSections(content.markdown).find(
        (s) => s.id === sectionId,
      );
    else if (content.kind === "pdf") {
      const match = /^page-([1-9]\d*)(?:-ocr-[a-f0-9]{64})?$/.exec(sectionId),
        page = match ? Number(match[1]) : 0;
      let text = content.pages[page - 1];
      if (text !== undefined && sectionId.includes("-ocr-")) {
        const row = this.db
          .prepare(
            "SELECT body FROM reading_ocr WHERE asset_id=? AND section_id=?",
          )
          .get(content.assetId, sectionId) as { body: string } | undefined;
        if (!row)
          throw new DomainError(
            "not_found",
            "这份识别文本不存在；原 PDF 未被改动。",
          );
        ocr = JSON.parse(row.body) as ReadingOcr;
        text = ocr.items.map((i) => i.correction ?? i.text).join("\n");
      }
      if (text !== undefined)
        section = {
          ...safeReadingSection(
            sectionId,
            `第 ${page} 页${ocr ? " · OCR 识别文本（需核对）" : ""}`,
            `<pre>${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre>`,
          ),
          text,
        };
    }
    if (!section)
      throw new DomainError("not_found", "无法读取这份内容的指定章节。");
    return {
      ...section,
      sourceId: readingSourceId(artifactId, revision, content),
      ...(ocr ? { ocr } : {}),
      book: {
        title: version.title,
        author: content.kind === "publication" ? content.author : "",
        edition: content.kind === "publication" ? content.edition : "",
        format:
          content.kind === "publication"
            ? content.format
            : content.kind === "pdf"
              ? ocr
                ? "pdf-ocr"
                : "pdf"
              : "markdown",
      },
    };
  }
  saveReadingOcr(
    artifactId: string,
    revision: number,
    page: number,
    result: ReadingOcr,
    access: AccessContext,
  ) {
    const content = readArtifact(
      this.snapshot(),
      artifactId,
      access,
      revision,
    ).content;
    if (content.kind !== "pdf" || content.pages[page - 1] === undefined)
      throw new DomainError("invalid", "PDF 页面不存在。");
    ocrResultSchema.parse({ image: result.image, items: result.items });
    const body = JSON.stringify(result),
      digest = createHash("sha256").update(body).digest("hex"),
      sectionId = `page-${page}-ocr-${digest}`;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO reading_ocr(asset_id,section_id,page,body) VALUES(?,?,?,?)",
      )
      .run(content.assetId, sectionId, page, body);
    return sectionId;
  }
  latestReadingOcr(
    artifactId: string,
    revision: number,
    page: number,
    access: AccessContext,
  ) {
    const content = readArtifact(
      this.snapshot(),
      artifactId,
      access,
      revision,
    ).content;
    if (content.kind !== "pdf" || content.pages[page - 1] === undefined)
      throw new DomainError("invalid", "PDF 页面不存在。");
    const row = this.db
      .prepare(
        "SELECT section_id FROM reading_ocr WHERE asset_id=? AND page=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(content.assetId, page) as { section_id: string } | undefined;
    return row?.section_id;
  }
  readerContents(artifactId: string, revision: number, access: AccessContext) {
    const version = readArtifact(this.snapshot(), artifactId, access, revision),
      content = version.content;
    if (content.kind === "publication") return content.sections;
    if (content.kind === "pdf")
      return content.pages.map((text, index) => ({
        id: `page-${index + 1}`,
        title: `第 ${index + 1} 页`,
        characters: text.length,
      }));
    if (content.kind === "document" && !content.understanding)
      return markdownSections(content.markdown).map((s) => ({
        id: s.id,
        title: s.title,
        characters: s.text.length,
      }));
    throw new DomainError("invalid", "此内容不支持阅读。");
  }
  close() {
    this.db.close();
  }
}
