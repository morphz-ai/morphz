import { z, ZodError } from "zod";
import {
  DomainError,
  commandSchema,
  checkProject,
  checkConversation,
  applicationFor,
  type AccessContext,
} from "../../../packages/core/src/model.js";
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

export type ApplicationOptions = {
  runtime?: RuntimeBridge;
  identity?: IdentityCenter;
  browser?: BrowserBroker;
  speech?: SpeechProvider;
};
export class ApplicationUnavailable extends Error {
  readonly status = 503;
}
export function applicationFailure(error: unknown): ApplicationFailure {
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
const speechScope = z
  .object({
    projectId: z.string().min(1).max(100),
    artifactId: z.string().min(1).optional(),
    revision: z.number().int().positive().optional(),
  })
  .strict();
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
  constructor(
    readonly store: WorkspaceStore,
    readonly options: ApplicationOptions = {},
  ) {
    if (!options.identity && requiresIdentity(store))
      throw new Error("此中心已启用身份认证，不能在缺失身份配置时启动。");
    if (options.identity && options.runtime && !options.runtime.teamIdentity)
      throw new Error(
        "多人中心需要 trusted_gateway Runtime 连接，不能使用单用户管理令牌。",
      );
    if (!options.identity && options.runtime?.teamIdentity)
      throw new Error("trusted_gateway 连接必须启用中心身份认证。");
    this.notifications = new Notifications(store);
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
    return {
      workspace: workspaceFor(this.store.snapshot(), this.access),
      outputs: this.store.artifactOutputs(this.access),
      centerId: this.store.identity(),
      csrfToken: identityGeneration,
      principalId: this.access.principalId,
      actantId: this.access.actantId,
      capabilities: {
        runtime: this.options.runtime?.snapshot().connected ?? false,
        teamAuthentication: !!this.options.identity,
        conversationOnFirstInput: true,
      },
      runtime:
        this.options.runtime?.snapshot(this.access) ?? disconnectedRuntime,
    };
  }
  async command(raw: unknown) {
    this.active();
    const command = commandSchema.parse(raw),
      op = command.operation;
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
    if (
      (chosen || (op.type === "record-input" && op.reasoningEffort)) &&
      !(previous?.kind === "task" && previous.model === chosen)
    ) {
      if (!this.options.runtime)
        throw new DomainError("invalid", "Agent 尚未连接，无法确认所选模型。");
      await this.options.runtime.as(this.access, () =>
        this.options.runtime!.validateInference(
          chosen ?? undefined,
          op.type === "record-input" ? op.reasoningEffort : undefined,
        ),
      );
    }
    this.active();
    return this.store.execute(command, this.access);
  }
  async message(raw: unknown) {
    const runtime = this.runtime(),
      command = commandSchema.parse(raw);
    if (command.operation.type !== "record-input")
      throw new DomainError("invalid", "消息入口只接受输入。");
    const { model, reasoningEffort } = command.operation;
    if (model || reasoningEffort)
      await runtime.as(this.access, () =>
        runtime.validateInference(model, reasoningEffort),
      );
    this.active();
    const receipt = this.store.execute(command, this.access);
    runtime.as(this.access, () => runtime.enqueue(receipt.entityId));
    return receipt;
  }
  sendInput(inputId: unknown) {
    const runtime = this.runtime(),
      id = identifier.parse(inputId);
    runtime.as(this.access, () => runtime.enqueue(id));
    return { accepted: true };
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
    return this.options.runtime?.collaboration.snapshot(id) ?? { runs: [] };
  }
  async taskControl(raw: unknown) {
    const runtime = this.runtime();
    const { id, run, revision, action } = z
      .object({
        id: identifier,
        run: z.number().int().positive(),
        revision: z.number().int().positive(),
        action: z.enum(["pause", "resume", "cancel"]),
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
    case "models":
      return session.models();
    case "asset.add":
      return session.addAsset(params);
    case "attachment.add":
      return session.addAttachment(params);
    case "pdf.import":
      return session.importPdf(params);
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
