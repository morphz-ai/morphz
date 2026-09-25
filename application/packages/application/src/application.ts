import { z, ZodError } from "zod";
import {
  DomainError,
  commandSchema,
  checkProject,
  checkConversation,
  applicationFor,
  type AccessContext,
  localAccess,
} from "../../../packages/core/src/model.js";
import { unconfiguredConnection } from "../../core/src/connection.js";
import type { LocalRuntimeConnection } from "./runtime-connection.js";
import { readArtifact } from "../../../packages/core/src/retrieval.js";
import { disconnectedRuntime } from "../../../packages/core/src/conversation.js";
import {
  executionScopeSchema,
  executionControlSchema,
} from "../../../packages/core/src/execution.js";
import { pdfImportIssue, maxPdfBytes } from "../../../packages/core/src/pdf.js";
import {
  maxSpeechSegmentBytes,
  maxSpeechSegmentSeconds,
} from "../../../packages/core/src/audio.js";
import type {
  ApplicationMethod,
  ApplicationFailure,
} from "../../../packages/core/src/application-api.js";
import type { ConversationStream } from "../../../packages/core/src/live-conversation.js";
import type { WorkspaceStore } from "./store.js";
import type { RuntimeBridge } from "./runtime.js";
import type { BrowserBroker } from "./browser.js";
import { type SpeechProvider, ttsRequestSchema } from "./speech.js";
import { IdentityCenter, workspaceFor, requiresIdentity } from "./identity.js";
import { Notifications } from "./notifications.js";
import { extractPdf } from "./pdf.js";
import { parsePublication } from "./reader-import.js";
import {
  maxReadingFileBytes,
  readerReadSchema,
} from "../../core/src/reader.js";
import { documentImportIssue } from "../../core/src/sources.js";
import type { LocalFiles } from "./local-files.js";
import {
  speechScopeSchema as speechScope,
  speechStreamCommandSchema,
} from "../../core/src/speech-stream.js";
import { SpeechStreams } from "./speech-stream.js";
import { ContinuationConflict, SupplementUnconfirmed } from "./continuation.js";

export type ApplicationOptions = {
  readerOcr?: import("./reader-ocr.js").ReaderOcr;
  runtime?: RuntimeBridge;
  identity?: IdentityCenter;
  browser?: BrowserBroker;
  speech?: SpeechProvider;
  localFiles?: LocalFiles;
  connectionSetup?: LocalRuntimeConnection;
};
export class ApplicationUnavailable extends Error {
  readonly status = 503;
}
export function applicationFailure(error: unknown): ApplicationFailure {
  if (error instanceof ContinuationConflict)
    return {
      status: 409,
      code: `work_${error.reason}`,
      message: error.message,
    };
  if (error instanceof SupplementUnconfirmed)
    return {
      status: 503,
      code: "supplement_unconfirmed",
      message: error.message,
    };
  if (error instanceof DomainError)
    return {
      status: { not_found: 404, forbidden: 403, conflict: 409, invalid: 400 }[
        error.code
      ],
      code: error.code,
      message: error.message,
    };
  if (error instanceof ApplicationUnavailable)
    return { status: 503, code: "unavailable", message: error.message };
  if (
    error instanceof ZodError ||
    error instanceof SyntaxError ||
    error instanceof URIError
  )
    return { status: 400, code: "invalid", message: "请求格式无效。" };
  return {
    status: 500,
    code: "storage_error",
    message: "保存失败。内容尚未确认写入，请保留草稿后重试。",
  };
}
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
export const conversationScope = z
  .object({ projectId: z.string().min(1), conversationId: z.string().min(1) })
  .strict();
function bytes(value: unknown, limit: number): Buffer {
  if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer))
    throw new DomainError("invalid", "需要二进制文件内容。");
  if (value.byteLength > limit)
    throw new DomainError("invalid", "请求内容超过大小限制。");
  return value instanceof ArrayBuffer
    ? Buffer.from(value)
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Plain application logic. No listener, URL router, Electron or transport state. */
export class Application {
  readonly notifications: Notifications;
  readonly speechStreams: SpeechStreams;
  constructor(
    readonly store: WorkspaceStore,
    readonly options: ApplicationOptions = {},
  ) {
    if (!options.identity && requiresIdentity(store))
      throw new Error("当前应用数据已启用身份认证，不能在缺失身份配置时启动。");
    if (options.identity && options.runtime && !options.runtime.teamIdentity)
      throw new Error(
        "多人工作空间需要 trusted_gateway Runtime 连接，不能使用单用户管理令牌。",
      );
    if (!options.identity && options.runtime?.teamIdentity)
      throw new Error("trusted_gateway 连接必须启用应用身份认证。");
    this.notifications = new Notifications(store);
    this.speechStreams = new SpeechStreams(options.speech);
  }
  session(access: AccessContext, assertActive: () => void = () => {}) {
    return new ApplicationSession(this, access, assertActive);
  }
}

/** The trusted host supplies identity; caller data can never choose Principal. */
export class ApplicationSession {
  constructor(
    private application: Application,
    private access: AccessContext,
    private assertActive: () => void,
  ) {}
  private get store() {
    return this.application.store;
  }
  private get options() {
    return this.application.options;
  }
  private active() {
    this.assertActive();
    if (this.options.identity && !this.options.identity.allows(this.access))
      throw new DomainError("forbidden", "身份已失效，操作未执行。");
  }
  private runtime() {
    this.active();
    if (!this.options.runtime)
      throw new ApplicationUnavailable("尚未连接 Morphz Runtime。");
    return this.options.runtime;
  }
  private project(id: string) {
    this.active();
    return checkProject(this.store.snapshot(), id, this.access);
  }
  workspace(identityGeneration: string) {
    this.active();
    const snapshot = this.store.snapshot();
    const workspace = workspaceFor(snapshot, this.access);
    return {
      workspace,
      outputs: this.store.artifactOutputs(this.access, snapshot),
      scriptOutputs: this.store.scriptOutputs(this.access, snapshot),
      centerId: this.store.identity(),
      csrfToken: identityGeneration,
      principalId: this.access.principalId,
      actantId: this.access.actantId,
      capabilities: {
        runtime: this.options.runtime?.snapshot().connected ?? false,
        teamAuthentication: !!this.options.identity,
        conversationOnFirstInput: true,
        directedInput: this.options.runtime?.supportsDirectedInput ?? false,
        localFiles: !!this.options.localFiles,
        agentDirectories: !!this.options.localFiles,
        modelSettings:
          !!this.options.runtime &&
          !!this.options.connectionSetup &&
          !this.options.identity &&
          this.access.principalId === localAccess.principalId &&
          this.access.actantId === localAccess.actantId,
        taskCompletion: true,
      },
      runtime:
        this.options.runtime?.snapshot(this.access) ?? disconnectedRuntime,
      taskRuns: Object.fromEntries(
        workspace.artifacts
          .filter((a) => a.content.kind === "task")
          .map((a) => [
            a.id,
            this.options.runtime?.collaboration.snapshot(a.id, this.access) ?? {
              runs: [],
            },
          ]),
      ),
    };
  }
  async connectionDetails(signal: AbortSignal) {
    this.active();
    const details = this.options.runtime
      ? await this.options.runtime.inspectConnection(signal)
      : { ...unconfiguredConnection };
    this.active();
    const owner =
      !this.options.identity &&
      this.access.principalId === localAccess.principalId &&
      this.access.actantId === localAccess.actantId;
    return {
      ...details,
      ...(owner ? this.options.connectionSetup?.details() : {}),
    };
  }
  async configureConnection(raw: unknown, signal: AbortSignal) {
    this.active();
    if (
      this.options.identity ||
      this.access.principalId !== localAccess.principalId ||
      this.access.actantId !== localAccess.actantId ||
      !this.options.connectionSetup
    )
      throw new DomainError(
        "forbidden",
        "只有本机工作区的本人可以设置连接；远端或多人工作空间请联系管理员。",
      );
    return this.options.connectionSetup.configure(
      raw,
      () => this.active(),
      signal,
    );
  }
  async modelSettings(raw: unknown, signal: AbortSignal, write = false) {
    this.active();
    if (
      this.options.identity ||
      !this.options.connectionSetup ||
      this.access.principalId !== localAccess.principalId ||
      this.access.actantId !== localAccess.actantId
    )
      throw new DomainError(
        "forbidden",
        "请在本机 Morphz 中管理模型；远端或多人工作空间请联系管理员。",
      );
    const settings = this.runtime().modelSettings;
    return write
      ? settings.apply(raw, signal, () => this.active())
      : settings.read(signal, () => this.active());
  }
  async command(raw: unknown) {
    this.active();
    const command = commandSchema.parse(raw),
      op = command.operation;
    if (
      op.type === "record-input" &&
      op.continuation &&
      !this.store.hasCommand(command.commandId)
    )
      await this.runtime().as(this.access, () =>
        this.runtime().validateContinuation(op.continuation!),
      );
    const chosen =
      op.type === "record-input"
        ? op.model
        : (op.type === "create-artifact" || op.type === "revise-artifact") &&
            op.content.kind === "task"
          ? op.content.model
          : null;
    const previous =
      op.type === "revise-artifact"
        ? this.store.snapshot().artifacts.find((a) => a.id === op.artifactId)
            ?.content
        : null;
    const effort =
      op.type === "record-input"
        ? op.reasoningEffort
        : (op.type === "create-artifact" || op.type === "revise-artifact") &&
            op.content.kind === "task"
          ? (op.content.reasoningEffort ?? undefined)
          : undefined;
    if (
      (chosen || effort) &&
      !(
        previous?.kind === "task" &&
        previous.model === chosen &&
        (previous.reasoningEffort ?? undefined) === effort
      )
    ) {
      if (!this.options.runtime)
        throw new DomainError("invalid", "Agent 尚未连接，无法确认所选模型。");
      await this.options.runtime.as(this.access, () =>
        this.options.runtime!.validateInference(chosen ?? undefined, effort),
      );
    }
    this.active();
    return this.store.execute(command, this.access, undefined, () =>
      this.validateLocalInput(op),
    );
  }
  async message(raw: unknown) {
    const runtime = this.runtime(),
      command = commandSchema.parse(raw);
    if (command.operation.type !== "record-input")
      throw new DomainError("invalid", "消息入口只接受输入。");
    const receipt = await this.command(command);
    runtime.as(this.access, () => runtime.enqueue(receipt.entityId));
    if (command.operation.continuation?.mode === "supplement")
      await runtime.as(this.access, () =>
        runtime.confirmSupplement(receipt.entityId),
      );
    return receipt;
  }
  async sendInput(inputId: unknown) {
    const runtime = this.runtime(),
      id = identifier.parse(inputId);
    runtime.as(this.access, () => runtime.enqueue(id));
    await runtime.as(this.access, () => runtime.confirmSupplement(id));
    return { accepted: true };
  }
  private validateLocalInput(
    operation: import("../../core/src/model.js").Operation,
  ) {
    if (operation.type !== "record-input") return;
    if (operation.directories?.length) {
      if (!this.options.localFiles)
        throw new DomainError("invalid", "当前应用不支持本机目录授权。");
      for (const directory of operation.directories)
        this.options.localFiles.validateDirectory(
          directory,
          operation.projectId,
          operation.conversationId ?? operation.projectId,
          this.access,
        );
    }
    if (!operation.localFile) return;
    if (!this.options.localFiles)
      throw new DomainError(
        "invalid",
        "当前应用不支持本机文件引用；未上传文件。",
      );
    this.options.localFiles.validate(
      operation.localFile,
      operation.projectId,
      this.access,
      operation.selection,
    );
  }
  cancelInput(inputId: unknown) {
    const runtime = this.runtime(),
      id = identifier.parse(inputId);
    runtime.as(this.access, () => runtime.cancelInput(id));
    return { accepted: true };
  }
  search(raw: unknown) {
    this.active();
    const request = z
      .object({
        query: z.string(),
        projectId: z.string().optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      })
      .strict()
      .parse(raw);
    return this.store.search(request, this.access);
  }
  directories(raw: unknown, revoke = false) {
    this.active();
    const request = z
      .object({
        projectId: identifier,
        conversationId: identifier,
        grantId: z.uuid().optional(),
      })
      .strict()
      .parse(raw);
    const files = this.options.localFiles;
    if (!files)
      throw new DomainError("invalid", "目录授权仅在本机桌面应用可用。");
    if (revoke) {
      if (
        !request.grantId ||
        !files
          .directories(request.projectId, request.conversationId, this.access)
          .some((g) => g.grantId === request.grantId)
      )
        throw new DomainError("forbidden", "目录不属于此对话。");
      files.revoke(request.grantId, request.projectId, this.access);
    }
    return files.directories(
      request.projectId,
      request.conversationId,
      this.access,
    );
  }
  localFiles(raw: unknown, revoke = false) {
    this.active();
    const request = z
      .object({
        projectId: identifier,
        grantId: z.uuid(),
        path: z.string().max(4096).default(""),
      })
      .strict()
      .parse(raw);
    if (!this.options.localFiles)
      throw new DomainError("invalid", "本机文件访问仅在本机桌面应用可用。");
    try {
      return revoke
        ? this.options.localFiles.revoke(
            request.grantId,
            request.projectId,
            this.access,
          )
        : this.options.localFiles.read(
            request.grantId,
            request.path,
            request.projectId,
            this.access,
          );
    } catch (e) {
      if (e instanceof DomainError) throw e;
      throw new DomainError(
        "invalid",
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? "原文件已移动或删除，请重新打开。"
          : e instanceof Error
            ? e.message
            : "读取原文件失败。",
      );
    }
  }
  artifact(raw: unknown) {
    this.active();
    const { id, revision } = z
      .object({
        id: identifier,
        revision: z.number().int().positive().optional(),
      })
      .strict()
      .parse(raw);
    return readArtifact(this.store.snapshot(), id, this.access, revision);
  }
  applicationView(raw: unknown) {
    this.active();
    const id = identifier.parse(raw),
      state = this.store.snapshot();
    const instance = state.applicationInstances.find(
      (i) => i.id === id && i.status === "open",
    );
    if (!instance) throw new DomainError("not_found", "应用已关闭。");
    this.project(instance.workspaceId);
    const manifest = applicationFor(
      state,
      instance.applicationId,
      instance.applicationVersion,
    );
    if (manifest.ui.type !== "sandbox")
      throw new DomainError("invalid", "不是独立应用界面。");
    return manifest.ui.html;
  }
  async models() {
    this.active();
    if (!this.options.runtime)
      throw new DomainError(
        "invalid",
        "Agent 尚未连接，暂时无法读取可用模型。",
      );
    const result = await this.options.runtime.as(this.access, () =>
      this.options.runtime!.models(),
    );
    this.active();
    return result;
  }
  asset(raw: unknown, attachment = false) {
    this.active();
    const id = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(raw);
    const asset = attachment
      ? this.store.attachmentAsset(id, this.access)
      : this.store.visibleAsset(id, this.access);
    if (!asset)
      throw new DomainError(
        "not_found",
        attachment ? "附件不存在或无权访问。" : "文件不存在。",
      );
    return asset;
  }
  addAsset(raw: unknown) {
    this.active();
    return this.store.addAsset(bytes(raw, 6 * 1024 * 1024), this.access);
  }
  addAttachment(raw: unknown) {
    this.active();
    const { name, data } = z
      .object({ name: z.string().max(1200), data: z.unknown() })
      .strict()
      .parse(raw);
    return this.store.addAttachment(
      bytes(data, 20 * 1024 * 1024),
      name,
      this.access,
    );
  }
  async importPdf(raw: unknown) {
    const { commandId, projectId, relativePath, data } = z
      .object({
        commandId: z.uuid(),
        projectId: z.string().min(1).max(100),
        relativePath: z.string().min(1).max(4000),
        data: z.unknown(),
      })
      .strict()
      .parse(raw);
    this.project(projectId);
    const issue = pdfImportIssue(relativePath);
    if (issue) throw new DomainError("invalid", issue);
    const source = bytes(data, maxPdfBytes),
      pages = await extractPdf(source);
    this.project(projectId);
    const content = this.store.addPdf(source, pages, this.access);
    return this.store.execute(
      {
        commandId,
        operation: { type: "import-pdf", projectId, relativePath, content },
      },
      this.access,
    );
  }
  async importReading(raw: unknown) {
    const { commandId, projectId, relativePath, data } = z
      .object({
        commandId: z.uuid(),
        projectId: z.string().min(1).max(100),
        relativePath: z.string().min(1).max(4000),
        data: z.unknown(),
      })
      .strict()
      .parse(raw);
    this.project(projectId);
    if (/\.pdf$/i.test(relativePath)) return this.importPdf(raw);
    const issue = documentImportIssue(
      relativePath.replace(/\.[^.\/]+$/, ".txt"),
    );
    if (issue) throw new DomainError("invalid", issue);
    const source = bytes(data, maxReadingFileBytes),
      parsed = await parsePublication(relativePath.split("/").at(-1)!, source);
    this.project(projectId);
    const content = this.store.addPublication(source, parsed, this.access);
    return this.store.execute(
      {
        commandId,
        operation: {
          type: "import-publication",
          projectId,
          relativePath,
          title: parsed.title,
          content,
        },
      },
      this.access,
    );
  }
  readReading(raw: unknown, contents = false) {
    if (contents) {
      const p = readerReadSchema.omit({ sectionId: true }).parse(raw);
      return this.store.readerContents(p.artifactId, p.revision, this.access);
    }
    const p = readerReadSchema.parse(raw);
    return this.store.readerSection(
      p.artifactId,
      p.revision,
      p.sectionId,
      this.access,
    );
  }
  async readingOcr(raw: unknown) {
    this.active();
    if (!this.options.readerOcr)
      throw new DomainError(
        "invalid",
        "当前连接未提供本地 OCR，请在本机 Morphz Desktop 中使用。",
      );
    const result = await this.options.readerOcr.call(raw, this.access);
    this.active();
    return result;
  }
  async executionSnapshot(raw: unknown) {
    const runtime = this.runtime(),
      scope = executionScopeSchema.parse(raw);
    this.project(scope.projectId);
    const result = await runtime.as(this.access, () =>
      runtime.executions.snapshot(scope),
    );
    this.active();
    return result;
  }
  async executionResult(raw: unknown) {
    const runtime = this.runtime();
    const { scope, jobId } = z
      .object({ scope: executionScopeSchema, jobId: identifier })
      .strict()
      .parse(raw);
    this.project(scope.projectId);
    const result = await runtime.as(this.access, () =>
      runtime.executions.result(scope, jobId),
    );
    this.active();
    return result;
  }
  async executionControl(raw: unknown) {
    const runtime = this.runtime(),
      control = executionControlSchema.parse(raw);
    this.project(control.scope.projectId);
    const result = await runtime.as(this.access, () =>
      runtime.executions.control(control),
    );
    this.active();
    return result;
  }
  taskSnapshot(raw: unknown) {
    this.active();
    const id = identifier.parse(raw);
    readArtifact(this.store.snapshot(), id, this.access);
    return (
      this.options.runtime?.collaboration.snapshot(id, this.access) ?? {
        runs: [],
      }
    );
  }
  async taskControl(raw: unknown) {
    const runtime = this.runtime();
    const { id, run, revision, action } = z
      .object({
        id: identifier,
        run: z.number().int().positive(),
        revision: z.number().int().positive(),
        action: z.enum(["pause", "resume", "cancel", "stop"]),
      })
      .strict()
      .parse(raw);
    readArtifact(this.store.snapshot(), id, this.access);
    const result = await runtime.as(this.access, () =>
      runtime.collaboration.control(id, run, revision, action),
    );
    this.active();
    return result;
  }
  speechStatus() {
    this.active();
    return {
      configured: this.options.speech?.configured() ?? false,
      provider: this.options.speech?.provider.id ?? null,
      providerLabel: this.options.speech?.provider.label ?? null,
      segmentSeconds: maxSpeechSegmentSeconds,
      streaming: !!this.options.speech?.openStream,
    };
  }
  private checkSpeech(raw: unknown) {
    const scope = speechScope.parse(raw);
    this.project(scope.projectId);
    if (scope.artifactId) {
      const revision = z.number().int().positive().parse(scope.revision);
      const artifact = readArtifact(
        this.store.snapshot(),
        scope.artifactId,
        this.access,
        revision,
      );
      if (artifact.projectId !== scope.projectId)
        throw new DomainError("forbidden", "对象不属于当前项目。");
    }
    return scope;
  }
  speechStream(raw: unknown, signal: AbortSignal) {
    const command = speechStreamCommandSchema.parse(raw);
    return this.application.speechStreams.call(
      command,
      this.access.principalId,
      () => {
        this.checkSpeech(command.scope);
      },
      signal,
    );
  }
  async transcribe(raw: unknown, signal: AbortSignal) {
    const { scope, data } = z
      .object({ scope: speechScope, data: z.unknown() })
      .strict()
      .parse(raw);
    this.checkSpeech(scope);
    if (!this.options.speech)
      throw new DomainError("invalid", "语音服务尚未配置。");
    const result = await this.options.speech.transcribe(
      this.access.principalId,
      bytes(data, maxSpeechSegmentBytes),
      signal,
    );
    this.checkSpeech(scope);
    signal.throwIfAborted();
    return { text: result };
  }
  async synthesize(raw: unknown, signal: AbortSignal) {
    const { scope, text } = z
      .object({ scope: speechScope, text: ttsRequestSchema.shape.text })
      .strict()
      .parse(raw);
    this.checkSpeech(scope);
    if (!this.options.speech)
      throw new DomainError("invalid", "语音服务尚未配置。");
    const result = await this.options.speech.synthesize(
      this.access.principalId,
      text,
      signal,
    );
    this.checkSpeech(scope);
    signal.throwIfAborted();
    return result;
  }
  notifications() {
    this.active();
    return this.application.notifications.snapshot(this.access);
  }
  controlNotifications(raw: unknown) {
    this.active();
    return this.application.notifications.control(this.access, raw);
  }
  browserRegister(raw: unknown, exchange = false) {
    this.active();
    if (!this.options.browser)
      throw new DomainError("invalid", "浏览器通道尚未启用。");
    const { key, data } = z
      .object({ key: z.string().regex(/^[a-f0-9]{64}$/), data: z.unknown() })
      .strict()
      .parse(raw);
    return exchange
      ? this.options.browser.exchange(data, key, this.access)
      : this.options.browser.register(data, key, this.access);
  }
  observeConversation(
    raw: unknown,
    emit: (value: ConversationStream) => void,
    onClose: () => void,
  ) {
    const scope = conversationScope.parse(raw);
    const check = () => {
      this.project(scope.projectId);
      try {
        checkConversation(
          this.store.snapshot(),
          scope.projectId,
          scope.conversationId,
          this.access,
        );
      } catch {
        throw new DomainError("not_found", "对话不存在。");
      }
    };
    check();
    let closed = false,
      dispose: (() => void) | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      dispose?.();
      onClose();
    };
    const timer = setInterval(() => {
      try {
        check();
      } catch {
        close();
      }
    }, 1000);
    try {
      dispose = this.options.runtime?.observeConversation(
        scope,
        this.access,
        (value) => {
          if (closed) return;
          try {
            check();
            emit(value);
          } catch {
            close();
          }
        },
        close,
      );
      if (closed) dispose?.();
      if (!this.options.runtime) emit({ connected: false, messages: [] });
      return close;
    } catch (error) {
      close();
      throw error;
    }
  }
}

/** Narrow adapter dispatch. Business methods remain callable directly by hosts. */
export function invokeApplication(
  session: ApplicationSession,
  method: ApplicationMethod,
  params: unknown,
  identityGeneration: string,
  signal: AbortSignal,
) {
  switch (method) {
    case "workspace":
      return session.workspace(identityGeneration);
    case "connection.check":
      return session.connectionDetails(signal);
    case "connection.configure":
      return session.configureConnection(params, signal);
    case "command":
      return session.command(params);
    case "message":
      return session.message(params);
    case "input.send":
      return session.sendInput(params);
    case "input.cancel":
      return session.cancelInput(params);
    case "search":
      return session.search(params);
    case "artifact.read":
      return session.artifact(params);
    case "local-files.read":
      return session.localFiles(params);
    case "directories.list":
      return session.directories(params);
    case "directories.revoke":
      return session.directories(params, true);
    case "local-files.revoke":
      return session.localFiles(params, true);
    case "models":
      return session.models();
    case "model-settings.read":
      return session.modelSettings(undefined, signal);
    case "model-settings.update":
      return session.modelSettings(params, signal, true);
    case "asset.add":
      return session.addAsset(params);
    case "attachment.add":
      return session.addAttachment(params);
    case "pdf.import":
      return session.importPdf(params);
    case "reader.import":
      return session.importReading(params);
    case "reader.read":
      return session.readReading(params);
    case "reader.contents":
      return session.readReading(params, true);
    case "reader.ocr":
      return session.readingOcr(params);
    case "execution.snapshot":
      return session.executionSnapshot(params);
    case "execution.result":
      return session.executionResult(params);
    case "execution.control":
      return session.executionControl(params);
    case "task.snapshot":
      return session.taskSnapshot(params);
    case "task.control":
      return session.taskControl(params);
    case "speech.status":
      return session.speechStatus();
    case "speech.transcribe":
      return session.transcribe(params, signal);
    case "speech.stream":
      return session.speechStream(params, signal);
    case "speech.synthesize":
      return session.synthesize(params, signal);
    case "notifications.read":
      return session.notifications();
    case "notifications.control":
      return session.controlNotifications(params);
    case "browser.register":
      return session.browserRegister(params);
    case "browser.exchange":
      return session.browserRegister(params, true);
    default:
      throw new DomainError("invalid", "不支持这个应用操作。");
  }
}
