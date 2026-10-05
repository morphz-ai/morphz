import { z, ZodError } from "zod";
import { createHash } from "node:crypto";
import {
  browserApplication,
  objectsApplication,
  readerApplication,
  scriptStudioApplication,
} from "../../../packages/core/src/applications.js";
import {
  DomainError,
  commandSchema,
  type AccessContext,
  type RecordedInput,
  localAccess,
  quotedText,
} from "../../../packages/core/src/model.js";
import { unconfiguredConnection } from "../../core/src/connection.js";
import {
  sessionPermissionsReadSchema,
  sessionPermissionsUpdateSchema,
} from "../../core/src/session-permissions.js";
import { maxMessageAttachmentBytes } from "../../core/src/message-attachment-policy.js";
import type { LocalRuntimeConnection } from "./runtime-connection.js";
import { disconnectedRuntime } from "../../../packages/core/src/conversation.js";
import {
  executionScopeSchema,
  executionControlSchema,
} from "../../../packages/core/src/execution.js";
import { pdfImportIssue, maxPdfBytes } from "../../../packages/core/src/pdf.js";
import {
  documentImportIssue,
  documentTextIssue,
  maxDocumentCharacters,
} from "../../../packages/core/src/sources.js";
import {
  maxSpeechSegmentBytes,
  maxSpeechSegmentSeconds,
} from "../../../packages/core/src/audio.js";
import {
  runtimeNavigationRequestSchema,
  cognitiveAppApplicationRoute,
  type ApplicationMethod,
  type ApplicationFailure,
} from "../../../packages/core/src/application-api.js";
import type { ConversationStream } from "../../../packages/core/src/live-conversation.js";
import type { WorkspaceStore } from "./store.js";
import type { RuntimeBridge } from "./runtime.js";
import type { BrowserBroker } from "./browser.js";
import { type SpeechProvider, ttsRequestSchema } from "./speech.js";
import { IdentityCenter, requiresIdentity } from "./identity.js";
import { Notifications } from "./notifications.js";
import {
  maxReadingFileBytes,
  readerReadSchema,
} from "../../core/src/reader.js";
import type { LocalFiles } from "./local-files.js";
import {
  speechScopeSchema as speechScope,
  speechStreamCommandSchema,
} from "../../core/src/speech-stream.js";
import { SpeechStreams } from "./speech-stream.js";
import { ContinuationConflict, SupplementUnconfirmed } from "./continuation.js";
import { PlatformStorageError } from "../../platform/src/store.js";
import type { BrowserBookmarkService } from "./browser-bookmark-service.js";
import type { HumanPlatformAuthority } from "./human-platform-authority.js";
import type { PlatformWorkService } from "./platform-work-service.js";
import { BrowserStorageError } from "../../browser/src/store.js";
import type {
  ApplicationProviderRoute,
  PlatformActor,
  PlatformStore,
} from "../../platform/src/store.js";
import type { SearchResult } from "../../core/src/retrieval.js";
import { searchContent } from "./content-search-service.js";
import {
  ObjectsConflictError,
  type ObjectsStore,
} from "../../objects/src/store.js";
import {
  createDocument,
  createImage,
  createInteractive,
  listObjectVersions,
  patchInteractiveRows,
  readDocument,
  renameObject,
  reviseDocument,
  reviseImage,
  reviseInteractive,
} from "./document-service.js";
import {
  interactiveSchema,
  interactiveRowsQuerySchema,
  interactiveRowOperationSchema,
} from "../../core/src/interactive.js";
import type { ImageService } from "./image-service.js";
import {
  changeScriptReview,
  createScriptItem,
  createScriptProduction,
  decideScriptCandidate,
  recordScriptExport,
  renameScriptProduction,
  restoreScriptItem,
  reviseScriptItem,
  transitionScriptWorkflow,
  updateScriptProduction,
} from "./script-production-service.js";
import {
  scriptBriefSchema,
  scriptExportTemplateSchema,
  type ScriptDraft,
} from "../../core/src/script-studio.js";
import {
  scriptEditorPageRequestSchema,
  scriptEditorDetailRequestSchema,
} from "../../core/src/script-editor.js";
import {
  liveScriptDraftSchema,
  type ScriptStudioStore,
} from "../../script-studio/src/store.js";
import {
  RuntimeTaskRunStatusError,
  type RuntimeTaskRunStatusReader,
} from "./runtime-task-run-status.js";
import { taskRuntimeSchema } from "../../core/src/task-runtime.js";
import { sourceContainsSelection } from "./platform-message-source.js";
import { sameIsoTimeMicros } from "./iso-time.js";
import type { ReaderService } from "./reader-service.js";
import {
  readerCommandSchema,
  readerMarksReadSchema,
} from "../../core/src/reader.js";
import { ReaderStorageError } from "../../reader/src/store.js";
import type { MessageAttachmentService } from "./message-attachment-service.js";
import type { UiPackageService } from "./ui-package-service.js";
import type { ProfileService } from "./profile-service.js";
import { profileAvatarCommandSchema } from "../../core/src/profile.js";
import {
  observeSqlChanges,
  type SqlChangeSource,
} from "../../storage/src/commit-notifications.js";
import type { WorkspaceChange } from "../../core/src/workspace-changes.js";
import {
  parseCognitiveAppRequest,
  type CognitiveAppMethod,
} from "../../core/src/cognitive-app-api.js";
import {
  CognitiveAppServiceError,
  type CognitiveAppService,
} from "./cognitive-app-service.js";
import {
  parseCognitiveAppViewRequest,
  parseCognitiveAppViewResponse,
  type CognitiveAppViewMethod,
} from "../../core/src/cognitive-app-view-api.js";
import { cognitiveAppViewApplicationRoute } from "../../core/src/cognitive-app-view-methods.js";
import {
  authorizeCognitiveAppInputObject,
  authorizeCognitiveAppInputTarget,
} from "./cognitive-app-input-source.js";
import { guardCognitiveAppInputCommand } from "../../core/src/cognitive-app-object-locator.js";
import { guardCognitiveAppApplicationCommand } from "../../core/src/cognitive-app-application-target.js";
import type { CognitiveAppViewService } from "./cognitive-app-view-service.js";
import {
  cognitiveAppDocumentResourceMime,
  parseCognitiveAppDocumentResourceRequest,
  parseCognitiveAppDocumentHtmlBytes,
  type CognitiveAppDocumentResource,
} from "../../core/src/cognitive-app-document-resource.js";

export type ApplicationOptions = {
  cognitiveApps?: {
    authority: HumanPlatformAuthority;
    service: CognitiveAppService;
    views?: CognitiveAppViewService;
  };
  /** Trusted Host capabilities, never accepted from a Client/Agent request. */
  workspaceChanges?: {
    sources: readonly SqlChangeSource[];
    readVersion: (
      access: AccessContext,
      assertActive: () => void,
    ) => Promise<{
      version: string;
      accessVersion: string;
      projectIds: string[];
    }>;
  };
  profiles?: { authority: HumanPlatformAuthority; service: ProfileService };
  readerOcr?: import("./reader-ocr.js").ReaderOcr;
  runtime?: RuntimeBridge;
  identity?: IdentityCenter;
  browser?: BrowserBroker;
  speech?: SpeechProvider;
  localFiles?: LocalFiles;
  connectionSetup?: LocalRuntimeConnection;
  bookmarkDomain?: {
    authority: HumanPlatformAuthority;
    service: BrowserBookmarkService;
  };
  platformWork?: {
    authority: HumanPlatformAuthority;
    service: PlatformWorkService;
  };
  platformDocuments?: {
    authority: HumanPlatformAuthority;
    platform: PlatformStore;
    objects: ObjectsStore;
    images: ImageService;
    provider: () => ApplicationProviderRoute;
    instanceIds: {
      objects: string;
      browser: string;
      reader: string;
      scriptStudio: string;
    };
  };
  platformScripts?: {
    authority: HumanPlatformAuthority;
    platform: PlatformStore;
    studio: ScriptStudioStore;
    instanceIds: { scriptStudio: string };
  };
  platformReader?: {
    authority: HumanPlatformAuthority;
    service: ReaderService;
  };
  messageAttachments?: {
    authority: HumanPlatformAuthority;
    service: MessageAttachmentService;
  };
  images?: {
    authority: HumanPlatformAuthority;
    service: ImageService;
  };
  uiPackages?: {
    authority: HumanPlatformAuthority;
    service: UiPackageService;
  };
  notifications?: Notifications;
  platformTaskRuns?: {
    authority: HumanPlatformAuthority;
    store: PlatformStore;
    runtimeStatus?: RuntimeTaskRunStatusReader;
  };
};
export class ApplicationUnavailable extends Error {
  readonly status = 503;
}
export function applicationFailure(error: unknown): ApplicationFailure {
  if (error instanceof CognitiveAppServiceError)
    return {
      status: {
        invalid: 400,
        forbidden: 403,
        not_found: 404,
        conflict: 409,
        busy: 429,
        unavailable: 503,
        contract: 502,
      }[error.reason],
      code: error.reason,
      message: error.message,
      ...(error.commandId === undefined ? {} : { commandId: error.commandId }),
    };
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
  if (error instanceof ObjectsConflictError)
    return { status: 409, code: "conflict", message: error.message };
  if (
    error instanceof DomainError ||
    error instanceof PlatformStorageError ||
    error instanceof BrowserStorageError ||
    error instanceof ReaderStorageError
  )
    return {
      status: { not_found: 404, forbidden: 403, conflict: 409, invalid: 400 }[
        error.code
      ],
      code: error.code,
      message: error.message,
    };
  if (error instanceof ApplicationUnavailable)
    return { status: 503, code: "unavailable", message: error.message };
  if (error instanceof RuntimeTaskRunStatusError)
    return {
      status: { unavailable: 503, forbidden: 403, mismatch: 409 }[error.reason],
      code: `runtime_${error.reason}`,
      message: error.message,
    };
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
const scriptQuoteFields = (
  draft: Pick<
    ScriptDraft,
    | "title"
    | "text"
    | "location"
    | "storyTime"
    | "audienceKnowledge"
    | "characterKnowledge"
    | "setupPayoff"
    | "productionNotes"
  >,
) =>
  [
    draft.title,
    draft.text,
    draft.location,
    draft.storyTime,
    draft.audienceKnowledge,
    draft.characterKnowledge,
    draft.setupPayoff,
    draft.productionNotes,
  ].join("\n");
const documentLookup = z
  .object({
    contentId: identifier,
    revision: z.number().int().positive().optional(),
  })
  .strict();
const objectLookup = documentLookup;
const objectRename = z
  .object({
    commandId: z.uuid(),
    contentId: identifier,
    expectedCatalogRevision: z.number().int().positive(),
    title: z.string().trim().min(1).max(180),
  })
  .strict();
const objectAnnotations = z
  .object({
    contentId: identifier,
    limit: z.number().int().min(1).max(100).optional(),
    afterOrdinal: z.number().int().nonnegative().optional(),
  })
  .strict();
const objectAnnotationCreate = z
  .object({
    commandId: z.uuid(),
    contentId: identifier,
    revision: z.number().int().positive(),
    quote: z.string().min(1).max(10000),
    page: z.number().int().positive().optional(),
    body: z.string().trim().min(1).max(10000),
  })
  .strict();
const objectHistory = z
  .object({
    contentId: identifier,
    limit: z.number().int().min(1).max(100).optional(),
    beforeRevision: z.number().int().positive().optional(),
  })
  .strict();
const documentCreate = z
  .object({
    commandId: z.uuid(),
    objectId: identifier,
    projectId: identifier,
    title: z.string().trim().min(1).max(180),
    markdown: z.string().max(500_000),
  })
  .strict();
const documentImport = z
  .object({
    commandId: z.uuid(),
    objectId: identifier,
    projectId: identifier,
    relativePath: z.string().min(1).max(1000),
    text: z.string().max(maxDocumentCharacters),
  })
  .strict();
const documentRevise = z
  .object({
    commandId: z.uuid(),
    contentId: identifier,
    expectedRevision: z.number().int().positive(),
    title: z.string().trim().min(1).max(180),
    markdown: z.string().max(500_000),
  })
  .strict();
const imageCreate = z
  .object({
    commandId: z.uuid(),
    objectId: identifier,
    projectId: identifier,
    title: z.string().trim().min(1).max(180),
    assetId: z.string().regex(/^[a-f0-9]{64}$/),
    alt: z.string().max(2000),
  })
  .strict();
const imageRevise = z
  .object({
    commandId: z.uuid(),
    contentId: identifier,
    expectedRevision: z.number().int().positive(),
    title: z.string().trim().min(1).max(180),
    assetId: z.string().regex(/^[a-f0-9]{64}$/),
    alt: z.string().max(2000),
  })
  .strict();
const interactiveCreate = z
  .object({
    commandId: z.uuid(),
    objectId: identifier,
    projectId: identifier,
    title: z.string().trim().min(1).max(180),
    content: interactiveSchema,
  })
  .strict();
const interactiveRevise = z
  .object({
    commandId: z.uuid(),
    contentId: identifier,
    expectedRevision: z.number().int().positive(),
    title: z.string().trim().min(1).max(180),
    content: interactiveSchema,
  })
  .strict();
const interactiveRows = interactiveRowsQuerySchema.extend({
  contentId: identifier,
});
const interactivePatch = z
  .object({
    commandId: z.uuid(),
    contentId: identifier,
    expectedRevision: z.number().int().positive(),
    operations: z.array(interactiveRowOperationSchema).min(1).max(100),
  })
  .strict();
const contentLookup = z.object({ contentId: identifier }).strict();
const scriptLookup = contentLookup;
const scriptItems = scriptLookup
  .extend({
    parentId: identifier.nullable(),
    kind: z
      .enum(["source", "setting", "character", "outline", "episode", "scene"])
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
    after: z
      .object({ ordinal: z.number().int().nonnegative(), itemId: identifier })
      .strict()
      .optional(),
    expectedActivityRevision: z.number().int().positive().optional(),
  })
  .strict();
const scriptItem = scriptLookup
  .extend({
    itemId: identifier,
    revision: z.number().int().positive().optional(),
  })
  .strict();
const scriptCreate = z
  .object({
    commandId: z.uuid(),
    productionId: identifier,
    projectId: identifier,
    title: z.string().trim().min(1).max(180),
  })
  .strict();
const scriptUpdate = z
  .object({
    commandId: z.uuid(),
    contentId: identifier,
    expectedRevision: z.number().int().positive(),
    title: z.string().trim().min(1).max(180),
    brief: scriptBriefSchema,
    reviewerPrincipalIds: z.array(identifier).min(1).max(50),
    template: scriptExportTemplateSchema,
  })
  .strict();
const scriptItemCreate = z
  .object({
    commandId: z.uuid(),
    contentId: identifier,
    itemId: identifier,
    expectedActivityRevision: z.number().int().positive(),
    kind: z.enum([
      "source",
      "setting",
      "character",
      "outline",
      "episode",
      "scene",
    ]),
    draft: liveScriptDraftSchema,
  })
  .strict();
const scriptItemRevise = z
  .object({
    commandId: z.uuid(),
    contentId: identifier,
    itemId: identifier,
    expectedRevision: z.number().int().positive(),
    draft: liveScriptDraftSchema,
  })
  .strict();
const scriptItemRestore = z
  .object({
    commandId: z.uuid(),
    contentId: identifier,
    itemId: identifier,
    expectedRevision: z.number().int().positive(),
    restoreRevision: z.number().int().positive(),
  })
  .strict();
const scriptItemWorkflow = z
  .object({
    commandId: z.uuid(),
    contentId: identifier,
    itemId: identifier,
    expectedRevision: z.number().int().positive(),
    expectedWorkflowRevision: z.number().int().positive(),
    action: z.enum([
      "submit-review",
      "review-decision",
      "lock-item",
      "unlock-item",
    ]),
    decision: z.enum(["approve", "request-changes"]).optional(),
    note: z.string().max(5000).optional(),
  })
  .strict();
const scriptReviewChange = z.discriminatedUnion("action", [
  z
    .object({
      commandId: z.uuid(),
      contentId: identifier,
      action: z.literal("add-review"),
      itemId: identifier,
      itemRevision: z.number().int().positive(),
      quote: z.string().max(10_000),
      body: z.string().trim().min(1).max(10_000),
      severity: z.enum(["note", "warning", "blocking"]),
    })
    .strict(),
  z
    .object({
      commandId: z.uuid(),
      contentId: identifier,
      action: z.literal("resolve-review"),
      reviewId: identifier,
      expectedRevision: z.number().int().positive(),
      resolution: z.string().trim().min(1).max(5000),
    })
    .strict(),
]);
const scriptCandidateDecide = z
  .object({
    commandId: z.uuid(),
    contentId: identifier,
    candidateId: identifier,
    expectedRevision: z.number().int().positive(),
    decision: z.enum(["accept", "reject"]),
  })
  .strict();
const scriptExportRecord = z
  .object({
    commandId: z.uuid(),
    contentId: identifier,
    expectedRevision: z.number().int().positive(),
    items: z
      .array(
        z
          .object({ itemId: identifier, revision: z.number().int().positive() })
          .strict(),
      )
      .min(1)
      .max(5000),
    template: scriptExportTemplateSchema,
    workingCopy: z.literal(true).optional(),
  })
  .strict();
export const conversationScope = z
  .object({ projectId: z.string().min(1), conversationId: z.string().min(1) })
  .strict();
const conversationHistoryRequest = conversationScope.extend({
  before: z
    .object({ createdAt: z.iso.datetime(), id: z.string().min(1) })
    .strict()
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
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
  /** Parse an independent public request before any asynchronous identity work.
   * The same facade serves both local and HTTP ingress; no caller authority. */
  async cognitiveApp(method: CognitiveAppMethod, raw: unknown) {
    let commandId: string | undefined;
    try {
      let request;
      try {
        request = parseCognitiveAppRequest(method, raw);
      } catch {
        throw new CognitiveAppServiceError("invalid");
      }
      if ("commandId" in request && typeof request.commandId === "string")
        commandId = request.commandId;
      this.active();
      const domain = this.options.cognitiveApps;
      if (!domain) throw new CognitiveAppServiceError("unavailable", commandId);
      const result = await domain.authority.withSession<unknown>(
        this.access,
        () => this.active(),
        (actor) => {
          this.active();
          return domain.service[method](actor, request);
        },
      );
      this.active();
      return result;
    } catch (error) {
      if (error instanceof CognitiveAppServiceError)
        throw new CognitiveAppServiceError(
          error.reason,
          commandId ?? error.commandId,
        );
      if (error instanceof DomainError || error instanceof PlatformStorageError)
        throw new CognitiveAppServiceError(error.code, commandId);
      throw new CognitiveAppServiceError("unavailable", commandId);
    }
  }
  async cognitiveAppView(method: CognitiveAppViewMethod, raw: unknown) {
    let commandId: string | undefined;
    try {
      let request;
      try {
        request = parseCognitiveAppViewRequest(method, raw);
      } catch {
        throw new CognitiveAppServiceError("invalid");
      }
      if ("commandId" in request) commandId = request.commandId;
      this.active();
      const domain = this.options.cognitiveApps;
      if (!domain?.views)
        throw new CognitiveAppServiceError("unavailable", commandId);
      const views = domain.views;
      const result = await domain.authority.withSession<unknown>(
        this.access,
        () => this.active(),
        (actor) => {
          this.active();
          return views[method](actor, request);
        },
      );
      this.active();
      try {
        return parseCognitiveAppViewResponse(method, result);
      } catch {
        throw new CognitiveAppServiceError("contract", commandId);
      }
    } catch (error) {
      if (error instanceof CognitiveAppServiceError)
        throw new CognitiveAppServiceError(
          error.reason,
          commandId ?? error.commandId,
        );
      if (error instanceof DomainError || error instanceof PlatformStorageError)
        throw new CognitiveAppServiceError(error.code, commandId);
      throw new CognitiveAppServiceError("unavailable", commandId);
    }
  }
  /** Host-only fixed carrier. Keep its entire byte/digest/permission pipeline
   * under one HPA credential; no public method, fresh authority or GUI callback. */
  async cognitiveAppDocumentResource(
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<CognitiveAppDocumentResource> {
    try {
      let request;
      try {
        request = parseCognitiveAppDocumentResourceRequest(raw);
      } catch {
        throw new CognitiveAppServiceError("invalid");
      }
      const active = () => {
        this.active();
        if (signal?.aborted) throw new CognitiveAppServiceError("forbidden");
      };
      active();
      const domain = this.options.cognitiveApps;
      if (!domain?.views) throw new CognitiveAppServiceError("unavailable");
      const views = domain.views;
      const result = await domain.authority.withSession(
        this.access,
        active,
        (actor) => {
          active();
          return views.documentResource(actor, request, signal);
        },
      );
      active();
      let bytes;
      try {
        if (result.mime !== cognitiveAppDocumentResourceMime) throw new Error();
        bytes = parseCognitiveAppDocumentHtmlBytes(result.bytes);
      } catch {
        throw new CognitiveAppServiceError("contract");
      }
      active();
      return { mime: cognitiveAppDocumentResourceMime, bytes };
    } catch (error) {
      if (error instanceof CognitiveAppServiceError)
        throw new CognitiveAppServiceError(error.reason);
      if (error instanceof DomainError || error instanceof PlatformStorageError)
        throw new CognitiveAppServiceError(error.code);
      throw new CognitiveAppServiceError("unavailable");
    }
  }
  private runtime() {
    this.active();
    if (!this.options.runtime)
      throw new ApplicationUnavailable("尚未连接 Morphz Runtime。");
    return this.options.runtime;
  }
  private canManageModelSettings() {
    return (
      !!this.options.runtime &&
      !!this.options.connectionSetup &&
      !this.options.identity &&
      this.access.principalId === localAccess.principalId &&
      this.access.actantId === localAccess.actantId
    );
  }
  /** Client identity without serializing the legacy workspace, app objects,
   * inputs or Runtime event history. Domain pages query their own authorities.
   */
  platformBootstrap(identityGeneration: string) {
    this.active();
    return {
      centerId: this.store.identity(),
      csrfToken: identityGeneration,
      principalId: this.access.principalId,
      actantId: this.access.actantId,
      displayName: this.options.identity?.displayName(this.access) ?? "我",
      capabilities: {
        runtime: this.options.runtime?.isConnected ?? false,
        teamAuthentication: !!this.options.identity,
        directedInput: this.options.runtime?.supportsDirectedInput ?? false,
        localFiles: !!this.options.localFiles,
        browserBookmarks: !!this.options.bookmarkDomain,
        modelSettings: this.canManageModelSettings(),
      },
    };
  }
  private profileDomain() {
    this.active();
    const domain = this.options.profiles;
    if (!domain) throw new ApplicationUnavailable("Profile 服务暂不可用。");
    return domain;
  }
  readProfile() {
    const domain = this.profileDomain();
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      (actor) => domain.service.read(actor, () => this.active()),
    );
  }
  updateProfile(raw: unknown) {
    const domain = this.profileDomain();
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      (actor) => domain.service.update(actor, raw, () => this.active()),
    );
  }
  setProfileAvatar(raw: unknown) {
    const domain = this.profileDomain();
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new DomainError("invalid", "头像参数无效。");
    const { data, ...metadata } = raw as Record<string, unknown>;
    const request = profileAvatarCommandSchema.parse(metadata);
    if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer))
      throw new DomainError("invalid", "请上传头像文件。");
    if (!domain.service.avatars)
      throw new ApplicationUnavailable("当前部署尚未配置头像存储。");
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      (actor) =>
        domain.service.avatars!.set(
          actor,
          request,
          data instanceof Uint8Array ? data : new Uint8Array(data),
        ),
    );
  }
  clearProfileAvatar(raw: unknown) {
    const domain = this.profileDomain();
    if (!domain.service.avatars)
      throw new ApplicationUnavailable("当前部署尚未配置头像存储。");
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      (actor) => domain.service.avatars!.clear(actor, raw),
    );
  }
  readProfileAvatar(raw: unknown) {
    const domain = this.profileDomain();
    if (!domain.service.avatars)
      throw new ApplicationUnavailable("当前部署尚未配置头像存储。");
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      (actor) => domain.service.avatars!.read(actor, raw),
    );
  }
  /** Runtime-owned conversation status for the unchanged exchange chrome.
   * Project and application data are not read from the old workspace here. */
  platformRuntimeSnapshot() {
    this.active();
    return this.options.runtime?.platformStatus() ?? disconnectedRuntime;
  }
  async platformRuntimeNavigation(raw?: unknown) {
    const request = runtimeNavigationRequestSchema.parse(raw ?? {});
    const scope =
      request.projectId && request.conversationId
        ? {
            projectId: request.projectId,
            conversationId: request.conversationId,
          }
        : undefined;
    let { projectIds, catalogVersion, revisions } = await this.work(
      (service, actor) => service.conversationNavigation(actor),
    );
    if (request.refreshActivity && this.options.runtime) {
      await this.options.runtime.refreshPlatformActivity();
      // A read may finish after membership/identity changes. Re-read the
      // current Human's project grant before publishing the new inventory.
      ({ projectIds, catalogVersion, revisions } = await this.work(
        (service, actor) => service.conversationNavigation(actor),
      ));
    }
    let head:
      | Awaited<ReturnType<RuntimeBridge["platformConversationHead"]>>
      | undefined;
    if (scope && projectIds.includes(scope.projectId) && this.options.runtime) {
      try {
        head = await this.options.runtime.platformConversationHead(
          scope,
          this.access,
        );
      } catch (error) {
        // The selected conversation can disappear while the catalog refreshes.
        if (
          !(error instanceof DomainError) ||
          !["forbidden", "not_found"].includes(error.code)
        )
          throw error;
      }
    }
    // Read the connection projection after the Runtime head. A Runtime-only
    // transport failure must appear in this response without declaring the
    // independently authorized Platform catalog inaccessible.
    const value = this.options.runtime?.platformNavigationSnapshot(
      this.access,
      projectIds,
    ) ?? {
      runtime: disconnectedRuntime,
      activityByProject: {} as Record<string, string>,
      historyVersion: undefined as string | undefined,
    };
    if (head)
      value.historyVersion = createHash("sha256")
        .update(JSON.stringify([value.historyVersion, head]))
        .digest("hex");
    this.active();
    return { ...value, catalogVersion, revisions };
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
    if (!this.canManageModelSettings())
      throw new DomainError(
        "forbidden",
        "请在本机 Morphz 中管理模型；远端或多人工作空间请联系管理员。",
      );
    const settings = this.runtime().modelSettings;
    return write
      ? settings.apply(raw, signal, () => this.active())
      : settings.read(signal, () => this.active());
  }
  async listBookmarks(raw: unknown) {
    this.active();
    const domain = this.options.bookmarkDomain;
    if (!domain)
      throw new ApplicationUnavailable("浏览器收藏尚未接入独立存储。");
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      (actor) => domain.service.list(actor, raw),
    );
  }
  async commandBookmark(raw: unknown) {
    this.active();
    const domain = this.options.bookmarkDomain;
    if (!domain)
      throw new ApplicationUnavailable("浏览器收藏尚未接入独立存储。");
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      (actor) => domain.service.command(actor, raw),
    );
  }
  private async work<T>(
    operation: (
      service: PlatformWorkService,
      actor: PlatformActor,
    ) => Promise<T>,
  ) {
    this.active();
    const domain = this.options.platformWork;
    if (!domain)
      throw new ApplicationUnavailable(
        "项目、事项和内容目录尚未接入 Platform。",
      );
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      (actor) => operation(domain.service, actor),
    );
  }
  ensurePlatformSpaces() {
    return this.work((service, actor) => service.ensurePersonalSpaces(actor));
  }
  listPlatformProjects(raw: unknown) {
    return this.work((service, actor) => service.listProjects(actor, raw));
  }
  getPlatformProject(raw: unknown) {
    return this.work((service, actor) => service.getProject(actor, raw));
  }
  getPlatformProjectUnderstanding(raw: unknown) {
    return this.work((service, actor) =>
      service.getProjectUnderstanding(actor, raw),
    );
  }
  createPlatformProject(raw: unknown) {
    return this.work((service, actor) => service.createProject(actor, raw));
  }
  listPlatformAppViews() {
    return this.work((service, actor) => service.listAppViews(actor));
  }
  launchPlatformAppView(raw: unknown) {
    return this.work((service, actor) => service.launchAppView(actor, raw));
  }
  savePlatformAppView(raw: unknown) {
    return this.work((service, actor) => service.saveAppView(actor, raw));
  }
  closePlatformAppView(raw: unknown) {
    return this.work((service, actor) => service.closeAppView(actor, raw));
  }
  renamePlatformProject(raw: unknown) {
    return this.work((service, actor) => service.renameProject(actor, raw));
  }
  changePlatformProjectState(raw: unknown) {
    return this.work((service, actor) =>
      service.changeProjectState(actor, raw),
    );
  }
  listPlatformConversations(raw: unknown) {
    return this.work((service, actor) => service.listConversations(actor, raw));
  }
  listAccessiblePlatformConversations(raw: unknown) {
    return this.work((service, actor) =>
      service.listAccessibleConversations(actor, raw),
    );
  }
  updatePlatformConversation(raw: unknown) {
    return this.work((service, actor) =>
      service.updateConversation(actor, raw),
    );
  }
  listPlatformTasks(raw: unknown) {
    return this.work((service, actor) => service.listTasks(actor, raw));
  }
  platformTaskCounts() {
    return this.work((service, actor) => service.taskCounts(actor));
  }
  platformTaskHead(raw: unknown) {
    return this.work((service, actor) => service.taskHead(actor, raw));
  }
  createPlatformTask(raw: unknown) {
    return this.work((service, actor) => service.createTask(actor, raw));
  }
  getPlatformTaskVersion(raw: unknown) {
    return this.work((service, actor) => service.taskVersion(actor, raw));
  }
  listPlatformTaskVersions(raw: unknown) {
    return this.work((service, actor) => service.listTaskVersions(actor, raw));
  }
  revisePlatformTask(raw: unknown) {
    const reader = this.options.platformTaskRuns?.runtimeStatus;
    return this.work((service, actor) =>
      service.reviseTask(
        actor,
        raw,
        reader ? (runtime) => reader.inspect(runtime, this.access) : undefined,
      ),
    );
  }
  respondPlatformTask(raw: unknown) {
    return this.work((service, actor) => service.respondTask(actor, raw));
  }
  listPlatformTaskResponses(raw: unknown) {
    return this.work((service, actor) => service.listTaskResponses(actor, raw));
  }
  completePlatformTask(raw: unknown) {
    return this.work((service, actor) => service.completeTask(actor, raw));
  }
  requestPlatformTaskRun(raw: unknown) {
    const request = z
      .object({
        commandId: identifier,
        taskId: identifier,
        expectedRevision: z.number().int().positive(),
      })
      .strict()
      .parse(raw);
    const runtime = this.runtime();
    const statusReader = this.options.platformTaskRuns?.runtimeStatus;
    return this.work(async (service, actor) => {
      const task = await service.taskVersion(actor, {
        taskId: request.taskId,
        revision: request.expectedRevision,
      });
      if (!task.projectId)
        throw new PlatformStorageError(
          "invalid",
          "事项没有有效项目，不能执行。",
        );
      let priorRuntime;
      if (
        task.runRequested > 0 &&
        !(await service.taskRunWasWithdrawn(
          actor,
          task.taskId,
          task.runRequested,
        ))
      ) {
        if (!statusReader)
          throw new ApplicationUnavailable(
            "无法核对上一轮执行状态，未提交新执行。",
          );
        const previous = await service.taskRunRuntimeRef(actor, {
          taskId: request.taskId,
          runNumber: task.runRequested,
        });
        priorRuntime = await statusReader.inspect(previous, this.access);
      }
      if (task.modelId || task.reasoningEffort)
        await runtime.as(this.access, () =>
          runtime.validateInference(
            task.modelId ?? undefined,
            task.reasoningEffort ?? undefined,
          ),
        );
      const sessionId = await runtime.preparePlatformTaskSession(
        task.projectId,
      );
      const admission = await service.requestTaskRun(
        actor,
        {
          ...request,
          sessionId,
          intent: [task.title, task.description].filter(Boolean).join("\n\n"),
          modelAlias: task.modelId,
          reasoningEffort: task.reasoningEffort,
          notBefore: task.notBefore ?? task.createdAt,
          intervalSeconds: task.everySeconds,
        },
        priorRuntime,
      );
      this.active();
      return {
        taskId: admission.taskId,
        runNumber: admission.runNumber,
        eventId: admission.eventId,
      };
    });
  }
  getPlatformTaskOrder(raw: unknown) {
    return this.work((service, actor) => service.taskOrder(actor, raw));
  }
  reorderPlatformTask(raw: unknown) {
    return this.work((service, actor) => service.reorderTask(actor, raw));
  }
  reorderPlatformTaskSelection(raw: unknown) {
    return this.work((service, actor) =>
      service.reorderTaskSelection(actor, raw),
    );
  }
  listPlatformContent(raw: unknown) {
    return this.work((service, actor) => service.listContent(actor, raw));
  }
  listPlatformContentDeliveries(raw: unknown) {
    return this.work((service, actor) => service.contentDeliveries(actor, raw));
  }
  listPlatformContentCounts(raw: unknown) {
    return this.work((service, actor) => service.contentCounts(actor, raw));
  }
  getPlatformContent(raw: unknown) {
    const { contentId } = contentLookup.parse(raw);
    return this.work((service, actor) => service.content(actor, contentId));
  }
  resolvePlatformContent(raw: unknown) {
    return this.work((service, actor) => service.resolveContent(actor, raw));
  }
  movePlatformContent(raw: unknown) {
    return this.work((service, actor) => service.moveContent(actor, raw));
  }
  createPlatformProjectForContent(raw: unknown) {
    return this.work((service, actor) =>
      service.createProjectForContent(actor, raw),
    );
  }
  linkPlatformWork(raw: unknown) {
    return this.work((service, actor) => service.linkWork(actor, raw));
  }
  listPlatformWorkRelations(raw: unknown) {
    return this.work((service, actor) => service.listWorkRelations(actor, raw));
  }
  private async document<T>(
    operation: (
      domain: NonNullable<ApplicationOptions["platformDocuments"]>,
      actor: PlatformActor,
    ) => Promise<T>,
  ) {
    this.active();
    const domain = this.options.platformDocuments;
    if (!domain) throw new ApplicationUnavailable("文档应用尚未接入独立存储。");
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      (actor) => operation(domain, actor),
    );
  }
  private async documentOriginal(
    domain: NonNullable<ApplicationOptions["platformDocuments"]>,
    actor: PlatformActor,
    contentId: string,
  ) {
    const entry = await domain.platform.content(actor, contentId);
    if (
      entry.instance_id !== domain.instanceIds.objects ||
      entry.kind !== "document"
    )
      throw new DomainError("invalid", "所选内容不是此文档应用的原件。");
    return entry;
  }
  readPlatformObject(raw: unknown) {
    const request = objectLookup.parse(raw);
    return this.document(async (domain, actor) => {
      const entry = await domain.platform.content(actor, request.contentId);
      if (entry.instance_id !== domain.instanceIds.objects)
        throw new DomainError("invalid", "所选内容不是此应用的原件。");
      return domain.objects.readObject({
        credential: actor.credential,
        objectId: entry.app_object_id,
        ...(request.revision ? { revision: request.revision } : {}),
      });
    });
  }
  renamePlatformObject(raw: unknown) {
    const request = objectRename.parse(raw);
    return this.document(async (domain, actor) => {
      const entry = await domain.platform.content(actor, request.contentId);
      if (entry.instance_id !== domain.instanceIds.objects)
        throw new DomainError("invalid", "所选内容不是此应用的原件。");
      return renameObject({
        platform: domain.platform,
        objects: domain.objects,
        actor,
        instanceId: domain.instanceIds.objects,
        commandId: request.commandId,
        objectId: entry.app_object_id,
        expectedCatalogRevision: request.expectedCatalogRevision,
        title: request.title,
      });
    });
  }
  listPlatformObjectAnnotations(raw: unknown) {
    const request = objectAnnotations.parse(raw);
    return this.document(async (domain, actor) => {
      const entry = await domain.platform.content(actor, request.contentId);
      if (entry.instance_id !== domain.instanceIds.objects)
        throw new DomainError("invalid", "所选内容不是此应用的原件。");
      return domain.objects.listObjectAnnotations({
        credential: actor.credential,
        objectId: entry.app_object_id,
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        ...(request.afterOrdinal === undefined
          ? {}
          : { afterOrdinal: request.afterOrdinal }),
      });
    });
  }
  annotatePlatformObject(raw: unknown) {
    const request = objectAnnotationCreate.parse(raw);
    return this.document(async (domain, actor) => {
      const entry = await domain.platform.content(actor, request.contentId);
      if (entry.instance_id !== domain.instanceIds.objects)
        throw new DomainError("invalid", "所选内容不是此应用的原件。");
      return domain.objects.annotateObject({
        credential: actor.credential,
        commandId: request.commandId,
        objectId: entry.app_object_id,
        revision: request.revision,
        quote: request.quote,
        ...(request.page === undefined ? {} : { page: request.page }),
        body: request.body,
      });
    });
  }
  readPlatformDocument(raw: unknown) {
    const request = documentLookup.parse(raw);
    return this.document(async (domain, actor) => {
      const entry = await this.documentOriginal(
        domain,
        actor,
        request.contentId,
      );
      const version = await readDocument({
        objects: domain.objects,
        actor,
        objectId: entry.app_object_id,
        ...(request.revision ? { revision: request.revision } : {}),
      });
      return {
        contentId: request.contentId,
        objectId: version.objectId,
        projectId: version.projectId,
        revision: version.revision,
        headRevision: version.headRevision,
        title: version.title,
        markdown: version.content.markdown,
        author: version.author,
        createdAt: version.createdAt,
      };
    });
  }
  listPlatformObjectVersions(raw: unknown) {
    const request = objectHistory.parse(raw);
    return this.document(async (domain, actor) => {
      const entry = await domain.platform.content(actor, request.contentId);
      if (entry.instance_id !== domain.instanceIds.objects)
        throw new DomainError("invalid", "所选内容不是此应用的原件。");
      return listObjectVersions({
        objects: domain.objects,
        actor,
        objectId: entry.app_object_id,
        ...(request.limit ? { limit: request.limit } : {}),
        ...(request.beforeRevision
          ? { beforeRevision: request.beforeRevision }
          : {}),
      });
    });
  }
  createPlatformDocument(raw: unknown) {
    const request = documentCreate.parse(raw);
    return this.document(async (domain, actor) => {
      const result = await createDocument({
        platform: domain.platform,
        objects: domain.objects,
        actor,
        instanceId: domain.instanceIds.objects,
        ...request,
      });
      return {
        contentId: result.contentId,
        objectId: result.original.objectId,
        projectId: result.original.projectId,
        versionRef: result.original.versionRef,
        receiptId: result.original.receiptId,
      };
    });
  }
  importPlatformDocument(raw: unknown) {
    const request = documentImport.parse(raw);
    const issue =
      documentImportIssue(request.relativePath) ??
      documentTextIssue(request.text);
    if (issue) throw new DomainError("invalid", issue);
    const title =
      request.relativePath
        .split("/")
        .at(-1)!
        .replace(/\.(md|markdown|txt)$/i, "")
        .slice(0, 180) || "导入的文档";
    return this.document(async (domain, actor) => {
      const result = await createDocument({
        platform: domain.platform,
        objects: domain.objects,
        actor,
        instanceId: domain.instanceIds.objects,
        commandId: request.commandId,
        objectId: request.objectId,
        projectId: request.projectId,
        title,
        markdown: request.text,
        relativePath: request.relativePath,
      });
      return {
        contentId: result.contentId,
        objectId: result.original.objectId,
        projectId: result.original.projectId,
        versionRef: result.original.versionRef,
        receiptId: result.original.receiptId,
      };
    });
  }
  revisePlatformDocument(raw: unknown) {
    const request = documentRevise.parse(raw);
    return this.document(async (domain, actor) => {
      const entry = await this.documentOriginal(
        domain,
        actor,
        request.contentId,
      );
      const result = await reviseDocument({
        platform: domain.platform,
        objects: domain.objects,
        actor,
        instanceId: domain.instanceIds.objects,
        commandId: request.commandId,
        objectId: entry.app_object_id,
        expectedRevision: request.expectedRevision,
        title: request.title,
        markdown: request.markdown,
      });
      return {
        contentId: result.contentId,
        objectId: result.original.objectId,
        projectId: result.original.projectId,
        versionRef: result.original.versionRef,
        receiptId: result.original.receiptId,
      };
    });
  }
  createPlatformImage(raw: unknown) {
    const request = imageCreate.parse(raw);
    return this.document(async (domain, actor) => {
      const reference = await domain.images.uploadedReference(
        actor,
        request.assetId,
      );
      const result = await createImage({
        platform: domain.platform,
        objects: domain.objects,
        actor,
        instanceId: domain.instanceIds.objects,
        ...request,
        reference,
      });
      return {
        contentId: result.contentId,
        objectId: result.original.objectId,
        projectId: result.original.projectId,
        versionRef: result.original.versionRef,
        receiptId: result.original.receiptId,
      };
    });
  }
  revisePlatformImage(raw: unknown) {
    const request = imageRevise.parse(raw);
    return this.document(async (domain, actor) => {
      const entry = await domain.platform.content(actor, request.contentId);
      if (
        entry.instance_id !== domain.instanceIds.objects ||
        entry.kind !== "image"
      )
        throw new DomainError("invalid", "所选内容不是图片原件。");
      const reference = await domain.images.revisionReference(
        actor,
        entry.app_object_id,
        request.expectedRevision,
        request.assetId,
      );
      const result = await reviseImage({
        platform: domain.platform,
        objects: domain.objects,
        actor,
        instanceId: domain.instanceIds.objects,
        commandId: request.commandId,
        objectId: entry.app_object_id,
        expectedRevision: request.expectedRevision,
        title: request.title,
        assetId: request.assetId,
        alt: request.alt,
        reference,
      });
      return {
        contentId: result.contentId,
        objectId: result.original.objectId,
        projectId: result.original.projectId,
        versionRef: result.original.versionRef,
        receiptId: result.original.receiptId,
      };
    });
  }
  createPlatformInteractive(raw: unknown) {
    const request = interactiveCreate.parse(raw);
    return this.document(async (domain, actor) => {
      const result = await createInteractive({
        platform: domain.platform,
        objects: domain.objects,
        actor,
        instanceId: domain.instanceIds.objects,
        ...request,
      });
      return {
        contentId: result.contentId,
        objectId: result.original.objectId,
        projectId: result.original.projectId,
        versionRef: result.original.versionRef,
        receiptId: result.original.receiptId,
      };
    });
  }
  revisePlatformInteractive(raw: unknown) {
    const request = interactiveRevise.parse(raw);
    return this.document(async (domain, actor) => {
      const entry = await domain.platform.content(actor, request.contentId);
      if (
        entry.instance_id !== domain.instanceIds.objects ||
        entry.kind !== "interactive"
      )
        throw new DomainError("invalid", "所选内容不是交互表格原件。");
      const result = await reviseInteractive({
        platform: domain.platform,
        objects: domain.objects,
        actor,
        instanceId: domain.instanceIds.objects,
        commandId: request.commandId,
        objectId: entry.app_object_id,
        expectedRevision: request.expectedRevision,
        title: request.title,
        content: request.content,
      });
      return {
        contentId: result.contentId,
        objectId: result.original.objectId,
        projectId: result.original.projectId,
        versionRef: result.original.versionRef,
        receiptId: result.original.receiptId,
      };
    });
  }
  queryPlatformInteractiveRows(raw: unknown) {
    const request = interactiveRows.parse(raw);
    return this.document(async (domain, actor) => {
      const entry = await domain.platform.content(actor, request.contentId);
      if (
        entry.instance_id !== domain.instanceIds.objects ||
        entry.kind !== "interactive"
      )
        throw new DomainError("invalid", "所选内容不是交互表格原件。");
      const { contentId: _contentId, ...query } = request;
      return domain.objects.queryInteractiveRows({
        credential: actor.credential,
        objectId: entry.app_object_id,
        ...query,
      });
    });
  }
  patchPlatformInteractiveRows(raw: unknown) {
    const request = interactivePatch.parse(raw);
    return this.document(async (domain, actor) => {
      const entry = await domain.platform.content(actor, request.contentId);
      if (
        entry.instance_id !== domain.instanceIds.objects ||
        entry.kind !== "interactive"
      )
        throw new DomainError("invalid", "所选内容不是交互表格原件。");
      const result = await patchInteractiveRows({
        platform: domain.platform,
        objects: domain.objects,
        actor,
        instanceId: domain.instanceIds.objects,
        commandId: request.commandId,
        objectId: entry.app_object_id,
        expectedRevision: request.expectedRevision,
        operations: request.operations,
      });
      return {
        contentId: result.contentId,
        objectId: result.original.objectId,
        projectId: result.original.projectId,
        versionRef: result.original.versionRef,
        receiptId: result.original.receiptId,
      };
    });
  }
  private reader<T>(
    operation: (service: ReaderService, actor: PlatformActor) => Promise<T>,
  ) {
    this.active();
    const domain = this.options.platformReader;
    if (!domain) throw new ApplicationUnavailable("阅读器尚未接入独立存储。");
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      (actor) => operation(domain.service, actor),
    );
  }
  readPlatformReaderContents(raw: unknown) {
    const request = z
      .object({ artifactId: identifier, revision: z.number().int().positive() })
      .strict()
      .parse(raw);
    return this.reader((service, actor) =>
      service.contents(actor, request.artifactId, request.revision),
    );
  }
  readPlatformReaderBook(raw: unknown) {
    const request = z
      .object({ artifactId: identifier, revision: z.number().int().positive() })
      .strict()
      .parse(raw);
    return this.reader((service, actor) =>
      service.bookOverview(actor, request.artifactId, request.revision),
    );
  }
  readPlatformReaderOriginalMetadata(raw: unknown) {
    const request = z
      .object({ artifactId: identifier, revision: z.number().int().positive() })
      .strict()
      .parse(raw);
    return this.reader((service, actor) =>
      service.originalMetadata(actor, request.artifactId, request.revision),
    );
  }
  readPlatformReaderOriginalRange(raw: unknown) {
    const request = z
      .object({
        artifactId: identifier,
        revision: z.number().int().positive(),
        start: z.number().int().nonnegative(),
        endExclusive: z.number().int().positive(),
      })
      .strict()
      .parse(raw);
    return this.reader((service, actor) =>
      service.originalRange(
        actor,
        request.artifactId,
        request.revision,
        request.start,
        request.endExclusive,
      ),
    );
  }
  readPlatformReaderSection(raw: unknown) {
    const request = readerReadSchema.parse(raw);
    return this.reader((service, actor) =>
      service.read(
        actor,
        request.artifactId,
        request.revision,
        request.sectionId,
      ),
    );
  }
  readPlatformReaderState(raw: unknown) {
    const request = z
      .object({ artifactId: identifier, revision: z.number().int().positive() })
      .strict()
      .parse(raw);
    return this.reader((service, actor) =>
      service.state(actor, request.artifactId, request.revision),
    );
  }
  readPlatformReaderMarks(raw: unknown) {
    const request = readerMarksReadSchema.parse(raw);
    return this.reader((service, actor) =>
      service.marks(
        actor,
        request.artifactId,
        request.revision,
        request.deleted,
        request.offset,
        request.limit,
        {
          sectionId: request.sectionId,
          start: request.start,
          end: request.end,
          after: request.after,
        },
      ),
    );
  }
  commandPlatformReader(raw: unknown) {
    const request = z
      .object({
        commandId: identifier,
        artifactId: identifier,
        revision: z.number().int().positive(),
        command: readerCommandSchema,
      })
      .strict()
      .parse(raw);
    return this.reader((service, actor) =>
      service.command(actor, {
        commandId: request.commandId,
        contentId: request.artifactId,
        revision: request.revision,
        command: request.command,
      }),
    );
  }
  private script<T>(
    operation: (
      domain: NonNullable<ApplicationOptions["platformScripts"]>,
      actor: PlatformActor,
    ) => Promise<T>,
  ) {
    this.active();
    const domain = this.options.platformScripts;
    if (!domain)
      throw new ApplicationUnavailable("剧本工作室尚未接入独立存储。");
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      (actor) => operation(domain, actor),
    );
  }
  private async scriptOriginal(
    domain: NonNullable<ApplicationOptions["platformScripts"]>,
    actor: PlatformActor,
    contentId: string,
  ) {
    const entry = await domain.platform.content(actor, contentId);
    if (
      entry.app_id !== "morphz.script-studio" ||
      entry.instance_id !== domain.instanceIds.scriptStudio ||
      entry.kind !== "script" ||
      entry.availability !== "available"
    )
      throw new DomainError("invalid", "所选内容不是此剧本工作室的原件。");
    return entry;
  }
  readPlatformScript(raw: unknown) {
    const request = scriptLookup.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, request.contentId);
      return {
        contentId: request.contentId,
        ...(await domain.studio.readProductionOverview({
          credential: actor.credential,
          productionId: entry.app_object_id,
        })),
      };
    });
  }
  readPlatformScriptEditorHead(raw: unknown) {
    const request = scriptLookup.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, request.contentId);
      return domain.studio.readEditorHead({
        credential: actor.credential,
        productionId: entry.app_object_id,
      });
    });
  }
  readPlatformScriptEditorPage(raw: unknown) {
    const { contentId, ...request } = scriptEditorPageRequestSchema.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, contentId);
      return domain.studio.readEditorPage({
        credential: actor.credential,
        productionId: entry.app_object_id,
        ...request,
      });
    });
  }
  readPlatformScriptEditorDetail(raw: unknown) {
    const request = scriptEditorDetailRequestSchema.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, request.contentId);
      const scope = {
        credential: actor.credential,
        productionId: entry.app_object_id,
      };
      switch (request.kind) {
        case "candidate":
          return domain.studio.readCandidate({
            ...scope,
            candidateId: request.objectId!,
          });
        case "review":
          return domain.studio.readReview({
            ...scope,
            reviewId: request.objectId!,
          });
        case "export":
          return domain.studio.readExport({
            ...scope,
            exportId: request.objectId!,
          });
        case "context":
          return domain.studio.readEditorContext({
            ...scope,
            revision: request.revision!,
          });
        case "item-version-title":
          return domain.studio.readVersionTitle({
            ...scope,
            itemId: request.objectId!,
            revision: request.revision!,
          });
      }
    });
  }
  readPlatformScriptSnapshot(raw: unknown) {
    const request = scriptLookup.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, request.contentId);
      return domain.studio.readProduction({
        credential: actor.credential,
        productionId: entry.app_object_id,
      });
    });
  }
  listPlatformScriptItems(raw: unknown) {
    const request = scriptItems.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, request.contentId);
      return domain.studio.listItems({
        credential: actor.credential,
        productionId: entry.app_object_id,
        parentId: request.parentId,
        ...(request.kind ? { kind: request.kind } : {}),
        ...(request.limit ? { limit: request.limit } : {}),
        ...(request.after ? { after: request.after } : {}),
        ...(request.expectedActivityRevision
          ? { expectedActivityRevision: request.expectedActivityRevision }
          : {}),
      });
    });
  }
  readPlatformScriptItem(raw: unknown) {
    const request = scriptItem.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, request.contentId);
      return domain.studio.readItemVersion({
        credential: actor.credential,
        productionId: entry.app_object_id,
        itemId: request.itemId,
        ...(request.revision ? { revision: request.revision } : {}),
      });
    });
  }
  createPlatformScript(raw: unknown) {
    const request = scriptCreate.parse(raw);
    return this.script(async (domain, actor) => {
      const result = await createScriptProduction({
        platform: domain.platform,
        studio: domain.studio,
        actor,
        instanceId: domain.instanceIds.scriptStudio,
        ...request,
      });
      return {
        contentId: result.contentId,
        productionId: result.original.productionId,
        projectId: result.original.requestedProjectId,
        versionRef: result.original.versionRef,
        receiptId: result.original.receiptId,
      };
    });
  }
  updatePlatformScript(raw: unknown) {
    const request = scriptUpdate.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, request.contentId);
      const result = await updateScriptProduction({
        platform: domain.platform,
        studio: domain.studio,
        actor,
        instanceId: domain.instanceIds.scriptStudio,
        commandId: request.commandId,
        productionId: entry.app_object_id,
        expectedRevision: request.expectedRevision,
        title: request.title,
        brief: request.brief,
        reviewerPrincipalIds: request.reviewerPrincipalIds,
        template: request.template,
      });
      return {
        contentId: result.contentId,
        productionId: result.original.productionId,
        metadataRevision: result.original.metadataRevision,
        activityRevision: result.original.activityRevision,
        receiptId: result.original.receiptId,
      };
    });
  }
  renamePlatformScript(raw: unknown) {
    const request = objectRename.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, request.contentId);
      const observed = Number(entry.observed_version_ref);
      if (!Number.isSafeInteger(observed) || observed < 1)
        throw new DomainError("invalid", "剧本目录版本无效。");
      return renameScriptProduction({
        platform: domain.platform,
        studio: domain.studio,
        actor,
        instanceId: domain.instanceIds.scriptStudio,
        commandId: request.commandId,
        productionId: entry.app_object_id,
        expectedCatalogRevision: request.expectedCatalogRevision,
        currentCatalogRevision: entry.revision,
        expectedActivityRevision: observed,
        title: request.title,
      });
    });
  }
  createPlatformScriptItem(raw: unknown) {
    const request = scriptItemCreate.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, request.contentId);
      const result = await createScriptItem({
        platform: domain.platform,
        studio: domain.studio,
        actor,
        instanceId: domain.instanceIds.scriptStudio,
        commandId: request.commandId,
        productionId: entry.app_object_id,
        itemId: request.itemId,
        expectedActivityRevision: request.expectedActivityRevision,
        kind: request.kind,
        draft: request.draft,
      });
      return {
        contentId: result.contentId,
        itemId: result.original.itemId,
        revision: result.original.itemRevision,
        activityRevision: result.original.activityRevision,
        receiptId: result.original.receiptId,
      };
    });
  }
  revisePlatformScriptItem(raw: unknown) {
    const request = scriptItemRevise.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, request.contentId);
      const result = await reviseScriptItem({
        platform: domain.platform,
        studio: domain.studio,
        actor,
        instanceId: domain.instanceIds.scriptStudio,
        commandId: request.commandId,
        productionId: entry.app_object_id,
        itemId: request.itemId,
        expectedRevision: request.expectedRevision,
        draft: request.draft,
      });
      return {
        contentId: result.contentId,
        itemId: result.original.itemId,
        revision: result.original.itemRevision,
        activityRevision: result.original.activityRevision,
        receiptId: result.original.receiptId,
      };
    });
  }
  restorePlatformScriptItem(raw: unknown) {
    const request = scriptItemRestore.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, request.contentId);
      const result = await restoreScriptItem({
        platform: domain.platform,
        studio: domain.studio,
        actor,
        instanceId: domain.instanceIds.scriptStudio,
        commandId: request.commandId,
        productionId: entry.app_object_id,
        itemId: request.itemId,
        expectedRevision: request.expectedRevision,
        restoreRevision: request.restoreRevision,
      });
      return {
        contentId: result.contentId,
        itemId: result.original.itemId,
        revision: result.original.itemRevision,
        activityRevision: result.original.activityRevision,
        receiptId: result.original.receiptId,
      };
    });
  }
  transitionPlatformScriptWorkflow(raw: unknown) {
    const request = scriptItemWorkflow.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, request.contentId);
      const result = await transitionScriptWorkflow({
        platform: domain.platform,
        studio: domain.studio,
        actor,
        instanceId: domain.instanceIds.scriptStudio,
        commandId: request.commandId,
        productionId: entry.app_object_id,
        itemId: request.itemId,
        expectedRevision: request.expectedRevision,
        expectedWorkflowRevision: request.expectedWorkflowRevision,
        action: request.action,
        ...(request.decision ? { decision: request.decision } : {}),
        ...(request.note !== undefined ? { note: request.note } : {}),
      });
      return {
        contentId: result.contentId,
        itemId: result.original.itemId,
        activityRevision: result.original.activityRevision,
        receiptId: result.original.receiptId,
      };
    });
  }
  changePlatformScriptReview(raw: unknown) {
    const request = scriptReviewChange.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, request.contentId);
      const result = await changeScriptReview({
        platform: domain.platform,
        studio: domain.studio,
        actor,
        instanceId: domain.instanceIds.scriptStudio,
        productionId: entry.app_object_id,
        ...request,
      });
      return {
        contentId: result.contentId,
        reviewId: result.original.reviewId,
        activityRevision: result.original.activityRevision,
        receiptId: result.original.receiptId,
      };
    });
  }
  decidePlatformScriptCandidate(raw: unknown) {
    const request = scriptCandidateDecide.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, request.contentId);
      const result = await decideScriptCandidate({
        platform: domain.platform,
        studio: domain.studio,
        actor,
        instanceId: domain.instanceIds.scriptStudio,
        commandId: request.commandId,
        productionId: entry.app_object_id,
        candidateId: request.candidateId,
        expectedRevision: request.expectedRevision,
        decision: request.decision,
      });
      return {
        contentId: result.contentId,
        candidateId: result.original.candidateId,
        candidateRevision: result.original.candidateRevision,
        adoptedItemId: result.original.adoptedItemId,
        adoptedItemRevision: result.original.adoptedItemRevision,
        activityRevision: result.original.activityRevision,
        receiptId: result.original.receiptId,
      };
    });
  }
  recordPlatformScriptExport(raw: unknown) {
    const request = scriptExportRecord.parse(raw);
    return this.script(async (domain, actor) => {
      const entry = await this.scriptOriginal(domain, actor, request.contentId);
      const result = await recordScriptExport({
        platform: domain.platform,
        studio: domain.studio,
        actor,
        instanceId: domain.instanceIds.scriptStudio,
        commandId: request.commandId,
        productionId: entry.app_object_id,
        expectedRevision: request.expectedRevision,
        items: request.items,
        template: request.template,
        ...(request.workingCopy ? { workingCopy: true as const } : {}),
      });
      return {
        contentId: result.contentId,
        exportId: result.original.exportId,
        activityRevision: result.original.activityRevision,
        receiptId: result.original.receiptId,
      };
    });
  }
  /** Platform-scoped message ingress. It never creates a legacy project,
   * conversation or input merely to make the Runtime route work.
   */
  async platformMessage(raw: unknown) {
    const runtime = this.runtime();
    // Snapshot only the new reference; old carriers retain their original
    // optional-field and quote budgets. No accessor may supply the new slot.
    guardCognitiveAppInputCommand(raw);
    guardCognitiveAppApplicationCommand(raw);
    const command = commandSchema.parse(raw);
    const op = command.operation;
    if (op.type !== "record-input" || command.applicationInstanceId)
      throw new DomainError("invalid", "消息入口只接受输入。");
    if (op.applicationInstanceId && !op.application)
      throw new DomainError(
        "invalid",
        "应用消息缺少应用类型，请刷新工作台后重试；草稿已保留。",
      );
    if (
      op.continuation &&
      (op.continuation.mode !== "supplement" ||
        !!op.newConversation ||
        !!op.application ||
        !!op.browser ||
        !!op.reading ||
        !!op.scriptGeneration ||
        !!op.localFile ||
        !!op.directories?.length ||
        !!op.selection ||
        !!op.cognitiveObject ||
        !!op.cognitiveApplication ||
        (op.dispatchMode !== undefined && op.dispatchMode !== "parallel") ||
        !!op.model ||
        !!op.reasoningEffort)
    )
      throw new DomainError(
        "invalid",
        "补充只能向原工作添加消息或附件，不能更换执行范围。",
      );
    if (
      op.newConversation &&
      (!op.conversationId || op.conversationId === op.projectId)
    )
      throw new DomainError(
        "invalid",
        "新对话需要独立标识，并与第一条消息一起提交。",
      );
    if (op.model || op.reasoningEffort)
      await runtime.as(this.access, () =>
        runtime.validateInference(op.model, op.reasoningEffort),
      );
    // A Client window ID is presentation state, not a Platform app-data
    // instance or an execution grant. Resolve the requested built-in app to
    // the Host's registered data authority before pinning its Harness.
    const explicitCognitiveTarget = op.cognitiveApplication
      ? await this.document((domain, actor) =>
          authorizeCognitiveAppInputTarget(
            domain.platform, actor, op.projectId, op.cognitiveApplication!,
          ),
        )
      : undefined;
    const cognitiveTarget = op.cognitiveObject
      ? await this.document((domain, actor) =>
          authorizeCognitiveAppInputObject(
            domain.platform,
            actor,
            op.cognitiveObject!,
          ),
        )
      : undefined;
    if (
      cognitiveTarget &&
      op.application &&
      (op.application.id !== cognitiveTarget.appId ||
        op.application.version !== cognitiveTarget.version ||
        (op.applicationInstanceId &&
          op.applicationInstanceId !== cognitiveTarget.instanceId))
    )
      throw new DomainError(
        "conflict",
        "应用与认知原件保存方不一致，草稿已保留。",
      );
    const application = explicitCognitiveTarget
      ? {
          instanceId: explicitCognitiveTarget.instanceId,
          id: explicitCognitiveTarget.appId,
          version: explicitCognitiveTarget.version,
          harness: explicitCognitiveTarget.definition.harness,
        }
      : op.application && cognitiveTarget
      ? {
          instanceId: cognitiveTarget.instanceId,
          id: cognitiveTarget.appId,
          version: cognitiveTarget.version,
          harness: cognitiveTarget.definition.harness,
        }
      : op.application
      ? await this.document(async (domain, actor) => {
          const manifest = [
            objectsApplication,
            browserApplication,
            readerApplication,
            scriptStudioApplication,
          ].find(
            (item) =>
              item.id === op.application!.id &&
              item.version === op.application!.version,
          );
          if (!manifest)
            throw new DomainError(
              "invalid",
              "当前应用版本不可用，请刷新工作台后重试；草稿已保留。",
            );
          const instanceId =
            manifest.id === objectsApplication.id
              ? domain.instanceIds.objects
              : manifest.id === browserApplication.id
                ? domain.instanceIds.browser
                : manifest.id === readerApplication.id
                  ? domain.instanceIds.reader
                  : domain.instanceIds.scriptStudio;
          await domain.platform.authorizeApplicationProject(
            actor,
            instanceId,
            manifest.id,
            op.projectId,
          );
          return {
            instanceId,
            id: manifest.id,
            version: manifest.version,
            harness: manifest.harness,
          };
        })
      : undefined;
    // Each source is checked against its owning authority and exact version.
    // The client locator is never itself a read grant or proof of the quote.
    const quotedSources = new Map<
      string,
      Awaited<ReturnType<RuntimeBridge["platformMessageSource"]>>
    >();
    for (const quote of op.textQuotes ?? []) {
      const source = quote.source;
      if (source.kind === "script") {
        const entryId = source.entryId;
        if (!entryId)
          throw new DomainError("invalid", "请从具体剧本文稿中选择原文。");
        await this.script(async (domain, actor) => {
          const identity = await domain.platform.authorizeApplicationObject(
            actor,
            domain.instanceIds.scriptStudio,
            "morphz.script-studio",
            source.productionId,
            "read",
          );
          const entry = await this.scriptOriginal(
            domain,
            actor,
            identity.contentId,
          );
          if (
            entry.app_object_id !== source.productionId ||
            (identity.projectId !== source.projectId &&
              !(await domain.platform.projectAudiencesEqual(actor, [
                identity.projectId,
                source.projectId,
              ])))
          )
            throw new DomainError("invalid", "引用的剧本归属已变化。");
          if (source.candidateId) {
            if (quote.draft)
              throw new DomainError("invalid", "候选稿不能标记为编辑中草稿。");
            const candidate = await domain.studio.readCandidateQuoteSource({
              credential: actor.credential,
              productionId: source.productionId,
              candidateId: source.candidateId,
            });
            if (
              candidate.targetItemId !== entryId ||
              candidate.baseRevision !== source.revision ||
              source.title !==
                `${candidate.productionTitle} · ${candidate.draft.title} · 候选 ${candidate.ordinal}` ||
              !sourceContainsSelection(
                `${scriptQuoteFields(candidate.draft)}\n${candidate.explanation}`,
                quote.text,
              )
            )
              throw new DomainError("invalid", "引用文字不属于选定的候选稿。");
            return;
          }
          const item = await domain.studio.readItemVersion({
            credential: actor.credential,
            productionId: source.productionId,
            itemId: entryId,
            revision: source.revision,
          });
          const overview = await domain.studio.readProductionOverview({
            credential: actor.credential,
            productionId: source.productionId,
          });
          if (
            item.revision !== source.revision ||
            (quote.draft
              ? !quote.anchor?.field
              : source.title !== `${overview.title} · ${item.draft.title}` ||
                !sourceContainsSelection(
                  scriptQuoteFields(item.draft),
                  quote.text,
                ))
          )
            throw new DomainError("invalid", "引用文字不属于选定的剧本版本。");
        });
        continue;
      }
      if (source.kind === "reading") {
        if (quote.draft)
          throw new DomainError(
            "invalid",
            "阅读原文引用不能标记为未保存草稿。",
          );
        const location = source.location;
        const start =
          location.end > location.start
            ? location.start
            : (quote.anchor?.start ?? -1);
        const end =
          location.end > location.start
            ? location.end
            : (quote.anchor?.end ?? -1);
        const slice = await this.reader((service, actor) =>
          service.quoteSlice(actor, {
            contentId: source.artifactId,
            revision: source.revision,
            sourceProjectId: source.projectId,
            sectionId: location.sectionId,
            start,
            end,
          }),
        );
        if (
          slice.sourceLocatorId !== location.sourceId ||
          slice.title !== source.chapter ||
          !sourceContainsSelection(slice.text, quote.text)
        )
          throw new DomainError("invalid", "引用文字不属于选定的阅读位置。");
        continue;
      }
      if (source.kind === "artifact") {
        await this.document(async (domain, actor) => {
          const entry = await domain.platform.content(actor, source.artifactId);
          if (
            entry.app_id !== "morphz.objects" ||
            entry.instance_id !== domain.instanceIds.objects ||
            entry.availability !== "available" ||
            (entry.project_id !== source.projectId &&
              !(await domain.platform.projectAudiencesEqual(actor, [
                entry.project_id,
                source.projectId,
              ])))
          )
            throw new DomainError(
              "invalid",
              "引用的内容已不可用，请重新选择原文。",
            );
          const version = await domain.objects.readObject({
            credential: actor.credential,
            objectId: entry.app_object_id,
            revision: source.revision,
          });
          if (
            version.contentId !== source.artifactId ||
            version.revision !== source.revision ||
            (!quote.draft && version.title !== source.title) ||
            (source.page !== undefined &&
              (version.content.kind !== "pdf" ||
                !version.content.pages[source.page - 1]))
          )
            throw new DomainError(
              "invalid",
              "引用的内容版本已变化，请重新选择原文。",
            );
          const original =
            source.page === undefined
              ? quotedText(version.content)
              : version.content.kind === "pdf"
                ? version.content.pages[source.page - 1]!
                : "";
          if (
            (quote.draft && !quote.anchor?.field) ||
            (!quote.draft && !sourceContainsSelection(original, quote.text))
          )
            throw new DomainError("invalid", "引用文字不属于选定的内容版本。");
        });
        continue;
      }
      if (source.kind === "web" || source.kind === "surface") {
        // These selections are supplied by the user's Client. The Host has no
        // saved page/surface original to compare against, so they remain
        // explicitly unverified discussion material, not an App read grant.
        // Never carry a selection into a conversation with a wider audience.
        if (
          !(await this.work((service, actor) =>
            service.projectAudiencesEqual(actor, [
              op.projectId,
              source.projectId,
            ]),
          ))
        )
          throw new DomainError(
            "forbidden",
            "引用来源与当前对话的访问范围不同，请在原项目讨论。",
          );
        continue;
      }
      if (source.kind !== "message" || !source.inputId)
        throw new DomainError(
          "invalid",
          "这个引用的来源尚未接入新消息路径，请重新选择原文。",
        );
      const key = `${source.projectId}\u0000${source.conversationId}\u0000${source.messageId}\u0000${source.inputId}`;
      let matched = quotedSources.get(key);
      if (matched === undefined) {
        matched = await runtime.platformMessageSource(
          {
            projectId: source.projectId,
            conversationId: source.conversationId,
          },
          this.access,
          source.messageId,
          source.inputId,
        );
        quotedSources.set(key, matched);
      }
      if (
        !matched ||
        matched.projectId !== source.projectId ||
        matched.conversationId !== source.conversationId ||
        !sameIsoTimeMicros(matched.createdAt, source.createdAt) ||
        !sourceContainsSelection(matched.text, quote.text) ||
        matched.inputId !== source.inputId
      )
        throw new DomainError(
          "invalid",
          "引用的原消息已不可用，请检查引用后重试。",
        );
    }
    this.active();
    const input: RecordedInput = {
      id: command.commandId,
      projectId: op.projectId,
      conversationId: op.conversationId ?? op.projectId,
      artifactId: op.artifactId,
      artifactRevision: op.artifactRevision,
      ...(op.cognitiveObject ? { cognitiveObject: op.cognitiveObject } : {}),
      ...(op.cognitiveApplication
        ? { cognitiveApplication: op.cognitiveApplication }
        : {}),
      selection: op.selection,
      body: op.body,
      author: { ...this.access },
      targetActantId: op.targetActantId,
      status: "recorded",
      ...(op.intent ? { intent: op.intent } : {}),
      ...(op.dispatchMode ? { dispatchMode: op.dispatchMode } : {}),
      ...(op.model ? { model: op.model } : {}),
      ...(op.reasoningEffort ? { reasoningEffort: op.reasoningEffort } : {}),
      ...(op.textQuotes?.length ? { textQuotes: op.textQuotes } : {}),
      ...(op.attachments?.length ? { attachments: op.attachments } : {}),
      ...(op.continuation ? { continuation: op.continuation } : {}),
      ...(op.reading ? { reading: op.reading } : {}),
      ...(application ? { application } : {}),
      ...(op.scriptGeneration ? { scriptGeneration: op.scriptGeneration } : {}),
      ...(op.browser ? { browser: op.browser } : {}),
      ...(op.localFile ? { localFile: op.localFile } : {}),
      ...(op.directories?.length ? { directories: op.directories } : {}),
      createdAt: new Date().toISOString(),
    };
    if (op.scriptGeneration) {
      await this.script(async (domain, actor) => {
        const overview = await domain.studio.readProductionOverview({
          credential: actor.credential,
          productionId: op.scriptGeneration!.productionId,
        });
        if (overview.projectId !== op.projectId)
          throw new DomainError("forbidden", "剧本不属于本次输入的项目。");
        const prepared = await domain.studio.prepareGeneration({
          credential: actor.credential,
          commandId: command.commandId,
          productionId: op.scriptGeneration!.productionId,
          inputId: input.id,
          generation: op.scriptGeneration!,
        });
        if (
          JSON.stringify(prepared.generation) !==
          JSON.stringify(op.scriptGeneration)
        )
          throw new DomainError(
            "conflict",
            "生成范围缺少上游依赖，请重新准备。",
          );
      });
    }
    const entityId = await runtime.as(this.access, () =>
      runtime.enqueuePlatformInput(input, op.newConversation),
    );
    if (op.newConversation) {
      await this.work((service, actor) =>
        service.startConversation(actor, {
          commandId: command.commandId,
          conversationId: op.conversationId!,
          projectId: op.projectId,
          title: op.newConversation!.title,
          inputFingerprint: runtime.as(this.access, () =>
            runtime.platformInputFingerprint(entityId),
          ),
        }),
      );
      await runtime.as(this.access, () =>
        runtime.releasePlatformInput(entityId),
      );
    }
    if (op.continuation?.mode === "supplement")
      await runtime.as(this.access, () => runtime.confirmSupplement(entityId));
    this.active();
    return { commandId: command.commandId, entityId };
  }
  async platformConversationHistory(raw: unknown) {
    const { before, limit, ...scope } = conversationHistoryRequest.parse(raw);
    const history = await this.runtime().platformConversationHistory(
      scope,
      this.access,
      { before, limit },
    );
    this.active();
    if (!this.options.platformScripts || !history.inputs.length)
      return { ...history, scriptOutputs: [] };
    const scriptOutputs = await this.script(async (domain, actor) => {
      const inputIds = history.inputs.map((input) => input.id);
      const productionIds = await domain.studio.inputDeliveryProductions(
        domain.authority.tenantId,
        inputIds,
      );
      const visibleIds: string[] = [];
      for (let start = 0; start < productionIds.length; start += 50) {
        const batch = productionIds.slice(start, start + 50);
        const entries = await domain.platform.listContent(actor, {
          appId: "morphz.script-studio",
          appObjectIds: batch,
          availability: "available",
          limit: batch.length,
        });
        visibleIds.push(
          ...entries
            .filter(
              (entry) =>
                entry.instance_id === domain.instanceIds.scriptStudio &&
                entry.kind === "script",
            )
            .map((entry) => entry.app_object_id),
        );
      }
      return domain.studio.listInputDeliveries({
        credential: actor.credential,
        inputIds,
        productionIds: visibleIds,
      });
    });
    this.active();
    return { ...history, scriptOutputs };
  }
  async sendInput(inputId: unknown) {
    this.active();
    const runtime = this.runtime(),
      id = identifier.parse(inputId);
    if (!this.options.platformWork)
      throw new ApplicationUnavailable("消息投递尚未接入 Platform。");
    await runtime.as(this.access, () => runtime.retryPlatformInput(id));
    this.active();
    return { accepted: true };
  }
  async cancelInput(inputId: unknown) {
    const runtime = this.runtime(),
      id = identifier.parse(inputId);
    if (!this.options.platformWork)
      throw new ApplicationUnavailable("消息投递尚未接入 Platform。");
    await runtime.cancelPlatformInput(id, this.access);
    this.active();
    return { accepted: true };
  }
  search(raw: unknown): Promise<SearchResult> {
    return this.document(async (domain, actor) => {
      const work = this.options.platformWork?.service;
      if (!work) throw new ApplicationUnavailable("内容目录尚未接入独立存储。");
      return searchContent(
        {
          platform: domain.platform,
          objects: domain.objects,
          work,
          objectsInstanceId: domain.instanceIds.objects,
          provider: domain.provider,
        },
        actor,
        raw,
      );
    });
  }
  async directoryScope(raw: unknown) {
    this.active();
    const request = conversationScope.parse(raw);
    if (!this.options.localFiles)
      throw new DomainError("invalid", "目录授权仅在本机桌面应用可用。");
    await this.work((service, actor) =>
      service.authorizeLocalDirectory(
        actor,
        request.projectId,
        request.conversationId,
        true,
      ),
    );
    this.active();
    return { authorized: true };
  }
  async directories(raw: unknown, revoke = false) {
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
    await this.work((service, actor) =>
      service.authorizeLocalDirectory(
        actor,
        request.projectId,
        request.conversationId,
        false,
      ),
    );
    this.active();
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
  async localFiles(raw: unknown, revoke = false) {
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
    await this.work((service, actor) =>
      service.authorizeLocalFileProject(actor, request.projectId),
    );
    this.active();
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
  private uiPackages() {
    this.active();
    const domain = this.options.uiPackages;
    if (!domain) throw new ApplicationUnavailable("应用包 Store 尚未配置。");
    return domain;
  }
  listUiPackages() {
    const domain = this.uiPackages();
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      async (actor) =>
        (await domain.service.list(actor)).map((entry) => ({
          header: entry.header,
          installedAt: entry.installedAt,
          ...(entry.cognitive
            ? { cognitive: { definitionHash: entry.cognitive.definitionHash } }
            : {}),
        })),
    );
  }
  installUiPackage(raw: unknown) {
    const request = z
      .object({
        commandId: identifier,
        manifest: z.unknown(),
      })
      .strict()
      .parse(raw);
    const domain = this.uiPackages();
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      (actor) =>
        domain.service.install(actor, request.commandId, request.manifest),
    );
  }
  applicationView(raw: unknown) {
    const value = z
      .string()
      .regex(/^[a-z][a-z0-9.-]{2,80}@\d+\.\d+\.\d+$/)
      .parse(raw);
    const at = value.lastIndexOf("@");
    const domain = this.uiPackages();
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      async (actor) => {
        const manifest = await domain.service.read(
          actor,
          value.slice(0, at),
          value.slice(at + 1),
        );
        if (manifest.ui.type !== "sandbox")
          throw new DomainError("invalid", "不是独立应用界面。");
        return manifest.ui.html;
      },
    );
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
  async readSessionPermissions(raw: unknown) {
    this.active();
    const scope = sessionPermissionsReadSchema.parse(raw);
    const runtime = this.runtime();
    const result = await runtime.as(this.access, () =>
      runtime.readSessionPermissions(scope, this.access, () => this.active()),
    );
    this.active();
    return result;
  }
  async updateSessionPermissions(raw: unknown) {
    this.active();
    const request = sessionPermissionsUpdateSchema.parse(raw);
    const runtime = this.runtime();
    if (
      this.options.identity ||
      runtime.teamIdentity ||
      this.access.principalId !== localAccess.principalId ||
      this.access.actantId !== localAccess.actantId
    )
      throw new DomainError(
        "forbidden",
        "审批方式只能由本机本人调整；团队与远端会话暂为只读。",
      );
    // Use the exact current Human message route authority, not possession of
    // a Runtime operator token or a read grant, before changing this Session.
    const authorizeWrite = async () => {
      this.active();
      await this.work((service, actor) =>
        service.authorizeLocalDirectory(
          actor,
          request.projectId,
          request.conversationId,
          true,
        ),
      );
      this.active();
    };
    const result = await runtime.as(this.access, () =>
      runtime.updateSessionPermissions(request, this.access, authorizeWrite),
    );
    this.active();
    return result;
  }
  async asset(raw: unknown, attachment = false, rawSource?: unknown) {
    this.active();
    const id = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(raw);
    const source =
      rawSource === undefined
        ? undefined
        : z
            .object({
              projectId: z.string().min(1).max(200),
              conversationId: z.string().min(1).max(200),
              inputId: z.string().min(1).max(200),
            })
            .strict()
            .parse(rawSource);
    if (source && !attachment)
      throw new DomainError("invalid", "图片资源不接受消息来源参数。");
    const readAccepted = async () => {
      if (!source) return null;
      if (!this.options.runtime)
        throw new DomainError("not_found", "附件不存在或无权访问。");
      return this.options.runtime.platformAcceptedAttachment(
        source,
        this.access,
        source.inputId,
        id,
      );
    };
    if (attachment && this.options.messageAttachments) {
      const domain = this.options.messageAttachments;
      try {
        return await domain.authority.withSession(
          this.access,
          () => this.active(),
          (actor) => domain.service.readOwned(actor, id),
        );
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "not_found")
          throw error;
        const accepted = await readAccepted();
        if (accepted) return accepted;
        if (source)
          throw new DomainError("not_found", "附件不存在或无权访问。");
        const owner = this.options.runtime
          ? await this.options.runtime.platformAttachmentOwner(id, this.access)
          : null;
        if (!owner)
          throw new DomainError("not_found", "附件不存在或无权访问。");
        return domain.service.readForOwner(owner, id, undefined, async () => {
          this.active();
          if (
            (await this.runtime().platformAttachmentOwner(id, this.access)) !==
            owner
          )
            throw new DomainError("forbidden", "消息附件授权已变化。");
        });
      }
    }
    if (source) {
      const accepted = await readAccepted();
      if (accepted) return accepted;
      throw new DomainError("not_found", "附件不存在或无权访问。");
    }
    if (!attachment && this.options.images) {
      const domain = this.options.images;
      return domain.authority.withSession(
        this.access,
        () => this.active(),
        (actor) => domain.service.read(actor, id),
      );
    }
    throw new ApplicationUnavailable("当前图片或附件存储不可用。");
  }
  async addAsset(raw: unknown) {
    this.active();
    if (this.options.images) {
      const domain = this.options.images;
      return domain.authority.withSession(
        this.access,
        () => this.active(),
        (actor) => domain.service.upload(actor, bytes(raw, 6 * 1024 * 1024)),
      );
    }
    throw new ApplicationUnavailable("图片 Store 不可用；文件未保存。");
  }
  async addAttachment(raw: unknown) {
    this.active();
    const { name, data } = z
      .object({ name: z.string().min(1).max(180), data: z.unknown() })
      .strict()
      .parse(raw);
    if (this.options.messageAttachments) {
      const domain = this.options.messageAttachments;
      return domain.authority.withSession(
        this.access,
        () => this.active(),
        (actor) =>
          domain.service.upload(
            actor,
            name,
            bytes(data, maxMessageAttachmentBytes),
          ),
      );
    }
    throw new ApplicationUnavailable("附件 Store 不可用；文件未保存。");
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
    const issue = pdfImportIssue(relativePath);
    if (issue) throw new DomainError("invalid", issue);
    return this.reader((service, actor) =>
      service.import(actor, {
        commandId,
        projectId,
        name: relativePath.split("/").at(-1)!,
        bytes: bytes(data, maxPdfBytes),
      }),
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
    return this.reader((service, actor) =>
      service.import(actor, {
        commandId,
        projectId,
        name: relativePath,
        bytes: bytes(data, maxReadingFileBytes),
      }),
    );
  }
  async readingOcr(raw: unknown) {
    this.active();
    if (!this.options.readerOcr)
      throw new DomainError(
        "invalid",
        "当前连接未提供本地 OCR，请在本机 Morphz Desktop 中使用。",
      );
    return this.reader((service, actor) =>
      this.options.readerOcr!.callPlatform(raw, actor, service, (operation) =>
        this.reader((_reader, current) => operation(current)),
      ),
    );
  }
  async executionSnapshot(raw: unknown) {
    const runtime = this.runtime(),
      scope = executionScopeSchema.parse(raw);
    if (scope.taskRun) {
      const { controls, recheck } = await this.platformTaskExecution(scope);
      const result = await controls.snapshot(scope);
      await recheck();
      this.active();
      return result;
    }
    if (!this.options.platformWork)
      throw new ApplicationUnavailable("执行记录尚未接入 Platform。");
    const controls = await runtime.platformExecutionControls(
      scope,
      this.access,
    );
    const result = await controls.snapshot();
    this.active();
    return result;
  }
  async executionResult(raw: unknown) {
    const runtime = this.runtime();
    const { scope, jobId } = z
      .object({ scope: executionScopeSchema, jobId: identifier })
      .strict()
      .parse(raw);
    if (scope.taskRun) {
      const { controls, recheck } = await this.platformTaskExecution(scope);
      const result = await controls.result(scope, jobId);
      await recheck();
      this.active();
      return result;
    }
    if (!this.options.platformWork)
      throw new ApplicationUnavailable("执行记录尚未接入 Platform。");
    const controls = await runtime.platformExecutionControls(
      scope,
      this.access,
    );
    const result = await controls.result(jobId);
    this.active();
    return result;
  }
  async executionControl(raw: unknown) {
    const runtime = this.runtime(),
      control = executionControlSchema.parse(raw);
    if (control.scope.taskRun) {
      const { controls, recheck } = await this.platformTaskExecution(
        control.scope,
      );
      const result = await controls.control(control);
      await recheck();
      this.active();
      return result;
    }
    if (!this.options.platformWork)
      throw new ApplicationUnavailable("执行控制尚未接入 Platform。");
    const controls = await runtime.platformExecutionControls(
      control.scope,
      this.access,
    );
    const result = await controls.control(control);
    this.active();
    return result;
  }
  private async platformTaskExecution(
    scope: z.infer<typeof executionScopeSchema>,
  ) {
    if (!scope.artifactId || !scope.threadId)
      throw new DomainError("invalid", "请选择一次具体的事项执行。");
    const domain = this.options.platformTaskRuns;
    if (!domain)
      throw new ApplicationUnavailable("事项执行记录尚未接入新存储。");
    const ref = await domain.authority.withSession(
      this.access,
      () => this.active(),
      (actor) =>
        domain.store.taskRunExecutionRef(
          actor,
          scope.artifactId!,
          scope.projectId,
          scope.threadId!,
        ),
    );
    const controls = await this.runtime().platformTaskExecutionControls(
      ref.projectId,
      {
        sessionId: ref.sessionId,
        scheduleId: ref.scheduleId,
        threadId: ref.threadId,
      },
      this.access,
      (eventId) =>
        domain.authority.withSession(
          this.access,
          () => this.active(),
          (actor) =>
            domain.store.taskRunSourceEventForExecution(
              actor,
              scope.artifactId!,
              scope.projectId,
              ref,
              eventId,
            ),
        ),
      (afterEventId) =>
        domain.authority.withSession(
          this.access,
          () => this.active(),
          (actor) =>
            domain.store.taskRunSourceExecutionEvents(
              actor,
              scope.artifactId!,
              scope.projectId,
              ref,
              afterEventId,
            ),
        ),
    );
    const recheck = async () => {
      const current = await domain.authority.withSession(
        this.access,
        () => this.active(),
        (actor) =>
          domain.store.taskRunExecutionRef(
            actor,
            scope.artifactId!,
            scope.projectId,
            scope.threadId!,
          ),
      );
      if (
        current.sessionId !== ref.sessionId ||
        current.scheduleId !== ref.scheduleId ||
        current.threadId !== ref.threadId ||
        current.projectId !== ref.projectId
      )
        throw new PlatformStorageError(
          "conflict",
          "执行引用已变化，请刷新后查看。",
        );
    };
    return { controls, recheck };
  }
  async taskSnapshot(raw: unknown) {
    const taskId = identifier.parse(raw);
    const domain = this.options.platformTaskRuns;
    if (!domain) throw new ApplicationUnavailable("事项执行尚未接入新存储。");
    const read = <T>(work: (actor: PlatformActor) => Promise<T>) =>
      domain.authority.withSession(this.access, () => this.active(), work);
    const task = await read((actor) => domain.store.taskHead(actor, taskId));
    const runNumber = task.head_version.run_requested;
    const links = await this.taskRunHistory({ taskId, limit: 50 });
    const latest = links.find((link) => link.runNumber === runNumber);
    const preparation = runNumber
      ? await read((actor) =>
          domain.store.taskRunPrerequisites(actor, taskId, runNumber),
        )
      : null;
    const pendingStop = latest
      ? null
      : await read((actor) => domain.store.taskRunPendingStop(actor, taskId));
    let live:
      Awaited<ReturnType<ApplicationSession["taskRunStatus"]>> | undefined;
    let readError = "";
    if (latest) {
      if (!this.options.platformTaskRuns?.runtimeStatus)
        readError = "Runtime 执行状态暂不可用。";
      else
        try {
          live = await this.taskRunStatus({
            taskId,
            runNumber: latest.runNumber,
          });
        } catch (error) {
          if (!(error instanceof RuntimeTaskRunStatusError)) throw error;
          readError = error.message;
        }
    }
    const blockers: NonNullable<z.infer<typeof taskRuntimeSchema>["blockers"]> =
      [];
    if (
      preparation &&
      !preparation.withdrawn &&
      (!latest || (live && ["queued", "paused"].includes(live.schedule.status)))
    ) {
      let cursor = 0;
      const reasons = new Map<string, (typeof blockers)[number]["reason"]>();
      const dependencies = preparation.prerequisites;
      await Promise.all(
        Array.from({ length: Math.min(4, dependencies.length) }, async () => {
          while (cursor < dependencies.length) {
            const item = dependencies[cursor++]!;
            if (!preparation.prepared && item.execution === "cancelled")
              reasons.set(item.taskId, "cancelled");
            else if (item.kind === "human") {
              if (!item.response) reasons.set(item.taskId, "response");
            } else if (!item.runtime) reasons.set(item.taskId, "not-started");
            else if (!domain.runtimeStatus)
              readError ||= "暂时无法确认前置事项的执行状态。";
            else
              try {
                const observed = await domain.runtimeStatus.inspect(
                  item.runtime,
                  this.access,
                );
                if (observed.thread.lifecycle === "failed")
                  reasons.set(item.taskId, "failed");
                else if (
                  observed.thread.lifecycle === "cancelled" ||
                  observed.schedule.status === "cancelled"
                )
                  reasons.set(item.taskId, "cancelled");
                else if (observed.thread.lifecycle !== "completed")
                  reasons.set(item.taskId, "running");
              } catch (error) {
                if (!(error instanceof RuntimeTaskRunStatusError)) throw error;
                readError ||= "暂时无法确认前置事项的执行状态。";
              }
          }
        }),
      );
      for (const item of dependencies) {
        const reason = reasons.get(item.taskId);
        if (reason)
          blockers.push({
            taskId: item.taskId,
            title: item.title,
            assigneeName:
              item.assigneeId === this.access.actantId
                ? "你"
                : item.kind === "human"
                  ? "负责人"
                  : "Morphz",
            reason,
          });
      }
    }
    let approvalCount: number | undefined =
      !runNumber ||
      preparation?.withdrawn ||
      !preparation?.prepared ||
      (live && live.thread.lifecycle !== "open")
        ? 0
        : undefined;
    if (latest && live?.thread.lifecycle === "open") {
      const scope = {
        projectId: task.project_id,
        artifactId: taskId,
        threadId: latest.runtime.threadId,
        taskRun: true as const,
      };
      try {
        const { controls, recheck } = await this.platformTaskExecution(scope);
        approvalCount = await controls.pendingApprovalCount(scope);
        await recheck();
      } catch (error) {
        // Revocation and a changed binding must fail closed. An unavailable
        // Runtime remains an unknown count, never a fabricated zero.
        if (
          error instanceof PlatformStorageError ||
          error instanceof DomainError
        )
          throw error;
        readError ||= "暂时无法确认这次执行的待确认操作。";
      }
    }
    await read(async (actor) => {
      const current = await domain.store.taskHead(actor, taskId);
      if (
        current.project_id !== task.project_id ||
        current.revision !== task.revision
      )
        throw new PlatformStorageError(
          "conflict",
          "事项已变化，请重新读取执行状态。",
        );
      if (preparation) {
        const currentPreparation = await domain.store.taskRunPrerequisites(
          actor,
          taskId,
          runNumber,
        );
        if (JSON.stringify(currentPreparation) !== JSON.stringify(preparation))
          throw new PlatformStorageError(
            "conflict",
            "前置事项已变化，请重新读取执行状态。",
          );
      }
    });
    this.active();
    return taskRuntimeSchema.parse({
      error: readError,
      approvalCount,
      blockers,
      runs: [
        ...(!latest && preparation
          ? [
              {
                run: runNumber,
                artifactRevision: preparation.admission.taskRevision,
                record: null,
                error: readError,
                paused: false,
                sourceStopped: preparation.withdrawn,
                controlRevision: 1,
                hasSourceWatch: false,
                controlPending: null,
                stopRequested: !!pendingStop,
                threadState: null,
              },
            ]
          : []),
        ...links.map((link) => {
          const current = link.runNumber === latest?.runNumber;
          return {
            run: link.runNumber,
            artifactRevision: link.taskRevision,
            record: {
              id: link.runtime.scheduleId,
              revision:
                current && live
                  ? live.schedule.revision
                  : link.observed.scheduleRevision,
              thread_id: link.runtime.threadId,
              status:
                current && live
                  ? live.schedule.status
                  : link.observed.scheduleStatus,
              interval_seconds:
                current && live
                  ? live.schedule.intervalSeconds
                  : link.observed.scheduleIntervalSeconds,
              ...(current && live
                ? { not_before: live.schedule.notBefore }
                : {}),
            },
            error: link.bridge.error || (current ? readError : ""),
            paused: link.bridge.paused,
            sourceStopped: link.bridge.sourceStopped,
            controlRevision: link.bridge.controlRevision,
            hasSourceWatch: link.bridge.watchSourceIds.length > 0,
            controlPending:
              link.bridge.controlPending ||
              (current && readError ? "unverified" : null),
            stopRequested: link.bridge.stopRequested,
            threadState:
              current && live
                ? live.thread.lifecycle
                : link.observed.threadStatus,
          };
        }),
      ],
    });
  }
  async taskRunHistory(raw: unknown) {
    this.active();
    const request = z
      .object({
        taskId: identifier,
        limit: z.number().int().min(1).max(50).optional(),
        beforeRun: z.number().int().positive().optional(),
      })
      .strict()
      .parse(raw);
    const domain = this.options.platformTaskRuns;
    if (!domain)
      throw new ApplicationUnavailable("事项执行历史尚未接入新存储。");
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      (actor) => domain.store.listTaskRunLinks(actor, request.taskId, request),
    );
  }
  async taskRunStatus(raw: unknown) {
    this.active();
    const request = z
      .object({ taskId: identifier, runNumber: z.number().int().positive() })
      .strict()
      .parse(raw);
    const domain = this.options.platformTaskRuns;
    if (!domain?.runtimeStatus)
      throw new ApplicationUnavailable("事项执行当前状态尚未接入 Runtime。");
    const runtimeStatus = domain.runtimeStatus;
    return domain.authority.withSession(
      this.access,
      () => this.active(),
      async (actor) => {
        const runtime = await domain.store.taskRunRuntimeRef(
          actor,
          request.taskId,
          request.runNumber,
        );
        const status = await runtimeStatus.inspect(runtime, this.access);
        // The external reads are not in Platform's transaction. Recheck both
        // membership and the exact link before releasing a potentially stale
        // result to a Human whose project access changed during the await.
        const current = await domain.store.taskRunRuntimeRef(
          actor,
          request.taskId,
          request.runNumber,
        );
        if (
          current.sessionId !== runtime.sessionId ||
          current.scheduleId !== runtime.scheduleId ||
          current.threadId !== runtime.threadId
        )
          throw new PlatformStorageError(
            "conflict",
            "事项执行引用已变化，请重新读取。",
          );
        this.active();
        return status;
      },
    );
  }
  async taskControl(raw: unknown) {
    const { id, run, revision, action } = z
      .object({
        id: identifier,
        run: z.number().int().positive(),
        revision: z.number().int().positive(),
        action: z.enum(["pause", "resume", "cancel", "stop"]),
      })
      .strict()
      .parse(raw);
    const domain = this.options.platformTaskRuns;
    if (!domain)
      throw new ApplicationUnavailable("事项执行控制尚未接入新存储。");
    if (action === "cancel")
      throw new ApplicationUnavailable("此项执行控制尚未接入新存储。");
    await domain.authority.withSession(
      this.access,
      () => this.active(),
      (actor) =>
        domain.store.requestTaskRunControl(actor, id, run, revision, action),
    );
    this.active();
    return this.taskSnapshot(id);
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
  private async checkSpeech(raw: unknown) {
    const scope = speechScope.parse(raw);
    if (!!scope.artifactId !== !!scope.revision)
      throw new DomainError("invalid", "内容与版本必须一起指定。");
    await this.work(async (service, actor) => {
      if (scope.artifactId) {
        const content = await service.content(actor, scope.artifactId);
        if (content.projectId !== scope.projectId)
          throw new DomainError("forbidden", "内容不属于当前项目。");
      } else {
        const project = await service.getProject(actor, {
          projectId: scope.projectId,
        });
        if (project.deletedAt)
          throw new DomainError("forbidden", "项目已删除，不能使用语音服务。");
      }
    });
    this.active();
    return scope;
  }
  speechStream(raw: unknown, signal: AbortSignal) {
    const command = speechStreamCommandSchema.parse(raw);
    return this.application.speechStreams.call(
      command,
      this.access.principalId,
      async () => {
        await this.checkSpeech(command.scope);
      },
      signal,
    );
  }
  async transcribe(raw: unknown, signal: AbortSignal) {
    const { scope, data } = z
      .object({ scope: speechScope, data: z.unknown() })
      .strict()
      .parse(raw);
    await this.checkSpeech(scope);
    if (!this.options.speech)
      throw new DomainError("invalid", "语音服务尚未配置。");
    const result = await this.options.speech.transcribe(
      this.access.principalId,
      bytes(data, maxSpeechSegmentBytes),
      signal,
    );
    await this.checkSpeech(scope);
    signal.throwIfAborted();
    return { text: result };
  }
  async synthesize(raw: unknown, signal: AbortSignal) {
    const { scope, text } = z
      .object({ scope: speechScope, text: ttsRequestSchema.shape.text })
      .strict()
      .parse(raw);
    await this.checkSpeech(scope);
    if (!this.options.speech)
      throw new DomainError("invalid", "语音服务尚未配置。");
    const result = await this.options.speech.synthesize(
      this.access.principalId,
      text,
      signal,
    );
    await this.checkSpeech(scope);
    signal.throwIfAborted();
    return result;
  }
  async notifications() {
    this.active();
    if (!this.options.notifications)
      throw new ApplicationUnavailable("通知状态尚未接入 Platform 存储。");
    return this.options.notifications.snapshot(this.access, () =>
      this.active(),
    );
  }
  async controlNotifications(raw: unknown) {
    this.active();
    if (!this.options.notifications)
      throw new ApplicationUnavailable("通知状态尚未接入 Platform 存储。");
    return this.options.notifications.control(this.access, raw, () =>
      this.active(),
    );
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
  async observeBrowserDesktop(
    raw: unknown,
    emit: (hint: import("../../core/src/browser.js").BrowserWake) => void,
    onClose: () => void,
    signal?: AbortSignal,
  ): Promise<() => void> {
    this.active();
    signal?.throwIfAborted();
    if (!this.options.browser)
      throw new DomainError("invalid", "浏览器通道尚未启用。");
    let closed = false;
    let watcher:
      Awaited<ReturnType<BrowserBroker["observeDesktop"]>> | undefined;
    let disposeAccess: (() => void) | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", close);
      watcher?.close();
      disposeAccess?.();
      onClose();
    };
    signal?.addEventListener("abort", close, { once: true });
    try {
      watcher = await this.options.browser.observeDesktop(
        raw,
        this.access,
        () => this.active(),
        (hint) => {
          if (!closed) emit(hint);
        },
        close,
      );
      if (closed) {
        watcher.close();
        return close;
      }
      // Workspace events are permission invalidations, never page/control data.
      if (this.options.workspaceChanges)
        disposeAccess = await this.observeWorkspaceChanges(
          () => void watcher?.check(),
          close,
          signal,
        );
      if (closed) disposeAccess?.();
      return close;
    } catch (error) {
      close();
      throw error;
    }
  }
  async observeWorkspaceChanges(
    emit: (value: WorkspaceChange) => void,
    onClose: () => void,
    signal?: AbortSignal,
  ): Promise<() => void> {
    this.active();
    signal?.throwIfAborted();
    const domain = this.options.workspaceChanges;
    if (!domain) throw new ApplicationUnavailable("工作区变化通知尚未接入。");
    let closed = false,
      ready = false,
      draining = false,
      dirty = false,
      forceResync = true,
      sequence = 0,
      version: string | undefined,
      accessVersion: string | undefined;
    const subscriptions: ReturnType<typeof observeSqlChanges>[] = [];
    let disposeRuntime: (() => void) | undefined;
    let disposeOcr: (() => void) | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", close);
      disposeRuntime?.();
      disposeOcr?.();
      for (const subscription of subscriptions)
        void subscription.close().catch(() => {});
      onClose();
    };
    // Register before awaiting listener readiness: a disconnected PostgreSQL
    // listener must remain cancellable even before a disposer can be returned.
    signal?.addEventListener("abort", close, { once: true });
    const drain = async () => {
      if (!ready || closed || draining) return;
      draining = true;
      try {
        while (dirty && !closed) {
          dirty = false;
          const resync = forceResync;
          forceResync = false;
          this.active();
          const current = await domain.readVersion(this.access, () =>
            this.active(),
          );
          if (closed) break;
          this.active();
          const runtime = this.options.runtime?.platformNavigationSnapshot(
            this.access,
            current.projectIds,
          );
          const ocr =
            this.options.readerOcr && this.options.platformReader
              ? await this.reader(async () =>
                  this.options.readerOcr!.workspaceChangeVersion(
                    `${this.options.platformReader!.authority.tenantId}:${this.access.principalId}`,
                  ),
                )
              : undefined;
          // checkedAt is freshness bookkeeping, not a visible domain change.
          const next = createHash("sha256")
            .update(
              JSON.stringify(
                {
                  version: current.version,
                  runtime,
                  ocr,
                  execution:
                    this.options.runtime?.platformExecutionChangeVersion(
                      this.access,
                      current.projectIds,
                    ),
                },
                (key, value) => (key === "checkedAt" ? undefined : value),
              ),
            )
            .digest("hex");
          const accessChanged =
            accessVersion !== undefined &&
            accessVersion !== current.accessVersion;
          if (resync || version !== next || accessChanged) {
            version = next;
            accessVersion = current.accessVersion;
            emit({
              kind: "workspace",
              sequence: ++sequence,
              reason: resync ? "resync" : "changed",
              accessChanged,
            });
          }
        }
      } catch {
        close();
      } finally {
        draining = false;
        if (dirty && !closed) void drain();
      }
    };
    const wake = (resync = false) => {
      if (closed) return;
      dirty = true;
      forceResync ||= resync;
      void drain();
    };
    try {
      const sources = new Map(
        domain.sources.map((source) => [
          source.driver + source.identity,
          source,
        ]),
      );
      for (const source of sources.values())
        subscriptions.push(
          observeSqlChanges(source, (hint) => wake(hint.reason === "resync")),
        );
      disposeRuntime = this.options.runtime?.observeWorkspaceChanges(() =>
        wake(),
      );
      disposeOcr = this.options.readerOcr?.observeChanges(() => wake());
      await Promise.all(
        subscriptions.map((subscription) => subscription.ready),
      );
      if (closed) return close;
      this.active();
      ready = true;
      wake(true);
      return close;
    } catch (error) {
      close();
      throw error;
    }
  }

  async observePlatformConversation(
    raw: unknown,
    emit: (value: ConversationStream) => void,
    onClose: () => void,
    signal?: AbortSignal,
  ): Promise<() => void> {
    const scope = conversationScope.parse(raw);
    this.active();
    signal?.throwIfAborted();
    let closed = false;
    let dispose: (() => void) | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", close);
      dispose?.();
      onClose();
    };
    signal?.addEventListener("abort", close, { once: true });
    try {
      dispose = await this.runtime().observePlatformConversation(
        scope,
        this.access,
        (value) => {
          if (closed) return;
          try {
            this.active();
            emit(value);
          } catch {
            close();
          }
        },
        close,
        this.options.workspaceChanges
          ? (wake) => this.observeWorkspaceChanges(() => wake(), close, signal)
          : undefined,
      );
      if (closed) dispose();
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
  const cognitive = cognitiveAppApplicationRoute(method);
  if (cognitive) return session.cognitiveApp(cognitive.method, params);
  const view = cognitiveAppViewApplicationRoute(method);
  if (view) return session.cognitiveAppView(view.method, params);
  switch (method) {
    case "platform.bootstrap":
      return session.platformBootstrap(identityGeneration);
    case "profile.read":
      return session.readProfile();
    case "profile.update":
      return session.updateProfile(params);
    case "profile.avatar.set":
      return session.setProfileAvatar(params);
    case "profile.avatar.clear":
      return session.clearProfileAvatar(params);
    case "profile.avatar.read":
      return session.readProfileAvatar(params);
    case "runtime.snapshot":
      return session.platformRuntimeSnapshot();
    case "runtime.navigation":
      return session.platformRuntimeNavigation(params);
    case "connection.check":
      return session.connectionDetails(signal);
    case "connection.configure":
      return session.configureConnection(params, signal);
    case "bookmarks.list":
      return session.listBookmarks(params);
    case "bookmarks.command":
      return session.commandBookmark(params);
    case "apps.list":
      return session.listUiPackages();
    case "apps.install":
      return session.installUiPackage(params);
    case "app-views.list":
      return session.listPlatformAppViews();
    case "app-views.launch":
      return session.launchPlatformAppView(params);
    case "app-views.save":
      return session.savePlatformAppView(params);
    case "app-views.close":
      return session.closePlatformAppView(params);
    case "spaces.ensure":
      return session.ensurePlatformSpaces();
    case "projects.list":
      return session.listPlatformProjects(params);
    case "projects.get":
      return session.getPlatformProject(params);
    case "projects.understanding":
      return session.getPlatformProjectUnderstanding(params);
    case "projects.create":
      return session.createPlatformProject(params);
    case "projects.rename":
      return session.renamePlatformProject(params);
    case "projects.state":
      return session.changePlatformProjectState(params);
    case "conversations.list":
      return session.listPlatformConversations(params);
    case "conversations.navigation":
      return session.listAccessiblePlatformConversations(params);
    case "conversations.update":
      return session.updatePlatformConversation(params);
    case "conversations.history":
      return session.platformConversationHistory(params);
    case "tasks.list":
      return session.listPlatformTasks(params);
    case "tasks.counts":
      return session.platformTaskCounts();
    case "tasks.get":
      return session.platformTaskHead(params);
    case "tasks.create":
      return session.createPlatformTask(params);
    case "tasks.version":
      return session.getPlatformTaskVersion(params);
    case "tasks.versions":
      return session.listPlatformTaskVersions(params);
    case "tasks.revise":
      return session.revisePlatformTask(params);
    case "tasks.respond":
      return session.respondPlatformTask(params);
    case "tasks.responses":
      return session.listPlatformTaskResponses(params);
    case "tasks.complete":
      return session.completePlatformTask(params);
    case "tasks.run-request":
      return session.requestPlatformTaskRun(params);
    case "tasks.order":
      return session.getPlatformTaskOrder(params);
    case "tasks.reorder":
      return session.reorderPlatformTask(params);
    case "tasks.reorder-selection":
      return session.reorderPlatformTaskSelection(params);
    case "content.list":
      return session.listPlatformContent(params);
    case "content.deliveries":
      return session.listPlatformContentDeliveries(params);
    case "content.counts":
      return session.listPlatformContentCounts(params);
    case "content.get":
      return session.getPlatformContent(params);
    case "content.resolve":
      return session.resolvePlatformContent(params);
    case "content.move":
      return session.movePlatformContent(params);
    case "content.move-new-project":
      return session.createPlatformProjectForContent(params);
    case "work.link":
      return session.linkPlatformWork(params);
    case "work.relations":
      return session.listPlatformWorkRelations(params);
    case "documents.read":
      return session.readPlatformDocument(params);
    case "objects.read":
      return session.readPlatformObject(params);
    case "objects.rename":
      return session.renamePlatformObject(params);
    case "objects.annotations":
      return session.listPlatformObjectAnnotations(params);
    case "objects.annotate":
      return session.annotatePlatformObject(params);
    case "objects.versions":
      return session.listPlatformObjectVersions(params);
    case "documents.create":
      return session.createPlatformDocument(params);
    case "documents.import":
      return session.importPlatformDocument(params);
    case "documents.revise":
      return session.revisePlatformDocument(params);
    case "images.create":
      return session.createPlatformImage(params);
    case "images.revise":
      return session.revisePlatformImage(params);
    case "interactive.create":
      return session.createPlatformInteractive(params);
    case "interactive.revise":
      return session.revisePlatformInteractive(params);
    case "interactive.rows":
      return session.queryPlatformInteractiveRows(params);
    case "interactive.patch":
      return session.patchPlatformInteractiveRows(params);
    case "scripts.read":
      return session.readPlatformScript(params);
    case "scripts.editor.head":
      return session.readPlatformScriptEditorHead(params);
    case "scripts.editor.page":
      return session.readPlatformScriptEditorPage(params);
    case "scripts.editor.detail":
      return session.readPlatformScriptEditorDetail(params);
    case "scripts.snapshot":
      return session.readPlatformScriptSnapshot(params);
    case "scripts.items":
      return session.listPlatformScriptItems(params);
    case "scripts.item":
      return session.readPlatformScriptItem(params);
    case "scripts.create":
      return session.createPlatformScript(params);
    case "scripts.update":
      return session.updatePlatformScript(params);
    case "scripts.rename":
      return session.renamePlatformScript(params);
    case "scripts.item.create":
      return session.createPlatformScriptItem(params);
    case "scripts.item.revise":
      return session.revisePlatformScriptItem(params);
    case "scripts.item.restore":
      return session.restorePlatformScriptItem(params);
    case "scripts.item.workflow":
      return session.transitionPlatformScriptWorkflow(params);
    case "scripts.review.change":
      return session.changePlatformScriptReview(params);
    case "scripts.candidate.decide":
      return session.decidePlatformScriptCandidate(params);
    case "scripts.export.record":
      return session.recordPlatformScriptExport(params);
    case "platform.message":
      return session.platformMessage(params);
    case "input.send":
      return session.sendInput(params);
    case "input.cancel":
      return session.cancelInput(params);
    case "search":
      return session.search(params);
    case "local-files.read":
      return session.localFiles(params);
    case "directories.scope":
      return session.directoryScope(params);
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
    case "session-permissions.read":
      return session.readSessionPermissions(params);
    case "session-permissions.update":
      return session.updateSessionPermissions(params);
    case "asset.add":
      return session.addAsset(params);
    case "attachment.add":
      return session.addAttachment(params);
    case "pdf.import":
      return session.importPdf(params);
    case "reader.import":
      return session.importReading(params);
    case "reader.read":
      return session.readPlatformReaderSection(params);
    case "reader.book":
      return session.readPlatformReaderBook(params);
    case "reader.contents":
      return session.readPlatformReaderContents(params);
    case "reader.state":
      return session.readPlatformReaderState(params);
    case "reader.marks":
      return session.readPlatformReaderMarks(params);
    case "reader.command":
      return session.commandPlatformReader(params);
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
    case "task.run-history":
      return session.taskRunHistory(params);
    case "task.run-status":
      return session.taskRunStatus(params);
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
