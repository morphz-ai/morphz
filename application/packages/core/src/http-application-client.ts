import {
  ApplicationRequestError,
  type ApplicationMethod,
  type ApplicationCallOptions as CallOptions,
} from "./application-api.js";
export { ApplicationRequestError } from "./application-api.js";
export type { ApplicationCallOptions as CallOptions } from "./application-api.js";

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("应用参数无效。");
  return value as Record<string, unknown>;
}
function binary(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (value instanceof Uint8Array) return new Uint8Array(value).buffer;
  throw new Error("需要二进制内容。");
}
const query = (data: Record<string, unknown>) =>
  new URLSearchParams(
    Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  ).toString();
const projectPathId = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value))
    throw new ApplicationRequestError(400, "项目标识无效。", "invalid");
  return encodeURIComponent(value);
};
const taskPathId = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value))
    throw new ApplicationRequestError(400, "事项标识无效。", "invalid");
  return encodeURIComponent(value);
};
const contentPathId = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value))
    throw new ApplicationRequestError(400, "内容标识无效。", "invalid");
  return encodeURIComponent(value);
};

/** HTTP is one adapter for logical application calls, used by Web and remote Desktop. */
export class HttpApplicationClient {
  private epoch = 0;
  constructor(
    private origin = "",
    private request: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {}
  async call(
    method: ApplicationMethod,
    params?: unknown,
    options: CallOptions = {},
  ): Promise<unknown> {
    if (method === "login" || method === "logout") {
      this.epoch++;
    }
    const epoch = this.epoch;
    let path: string,
      data: BodyInit | undefined,
      verb = "GET",
      wav = false;
    const headers: Record<string, string> = {};
    const post = (value?: unknown) => {
      verb = "POST";
      if (value !== undefined) {
        headers["Content-Type"] = "application/json";
        data = JSON.stringify(value);
      }
    };
    switch (method) {
      case "platform.bootstrap":
        path = "/api/platform/bootstrap";
        break;
      case "runtime.snapshot":
        path = "/api/platform/runtime-snapshot";
        break;
      case "runtime.navigation": {
        const p = params === undefined ? {} : fields(params);
        path = "/api/platform/runtime-navigation";
        if (p.projectId !== undefined || p.conversationId !== undefined)
          path +=
            "?" +
            query({
              projectId: projectPathId(p.projectId),
              conversationId: projectPathId(p.conversationId),
            });
        break;
      }
      case "login":
        path = "/api/identity/login";
        post(params);
        break;
      case "logout":
        path = "/api/identity/logout";
        post();
        break;
      case "bookmarks.list":
        path = "/api/bookmarks?" + query(fields(params ?? {}));
        break;
      case "bookmarks.command":
        path = "/api/bookmarks/commands";
        post(params);
        break;
      case "apps.list":
        path = "/api/platform/apps";
        break;
      case "apps.install":
        path = "/api/platform/apps/install";
        post(params);
        break;
      case "app-views.list":
        path = "/api/platform/app-views";
        break;
      case "app-views.launch":
      case "app-views.save":
      case "app-views.close":
        path = "/api/platform/app-views/" + method.slice("app-views.".length);
        post(params);
        break;
      case "spaces.ensure":
        path = "/api/platform/spaces/ensure";
        post();
        break;
      case "projects.list": {
        const p = fields(params ?? {});
        const after = p.after ? fields(p.after) : {};
        path =
          "/api/platform/projects?" +
          query({
            status: p.status,
            limit: p.limit,
            afterUpdatedAt: after.updatedAt,
            afterProjectId: after.projectId,
          });
        break;
      }
      case "projects.get": {
        const p = fields(params ?? {});
        path = `/api/platform/projects/${projectPathId(p.projectId)}`;
        break;
      }
      case "projects.understanding": {
        const p = fields(params ?? {});
        path =
          `/api/platform/projects/${projectPathId(p.projectId)}/understanding?` +
          query({ revision: p.revision });
        break;
      }
      case "projects.create":
        path = "/api/platform/projects";
        post(params);
        break;
      case "projects.rename":
        path = "/api/platform/projects/rename";
        post(params);
        break;
      case "projects.state":
        path = "/api/platform/projects/state";
        post(params);
        break;
      case "conversations.list": {
        const p = fields(params ?? {});
        const after = p.after ? fields(p.after) : {};
        path =
          `/api/platform/projects/${projectPathId(p.projectId)}/conversations?` +
          query({
            archived: p.archived,
            limit: p.limit,
            afterUpdatedAt: after.updatedAt,
            afterConversationId: after.conversationId,
          });
        break;
      }
      case "conversations.navigation": {
        const p = fields(params ?? {});
        const after = p.after ? fields(p.after) : {};
        path =
          "/api/platform/conversations/navigation?" +
          query({
            limit: p.limit,
            afterUpdatedAt: after.updatedAt,
            afterConversationId: after.conversationId,
          });
        break;
      }
      case "conversations.update":
        path = "/api/platform/conversations/update";
        post(params);
        break;
      case "conversations.history": {
        const p = fields(params ?? {});
        const before = p.before ? fields(p.before) : undefined;
        path =
          `/api/platform/projects/${projectPathId(p.projectId)}` +
          `/conversations/${projectPathId(p.conversationId)}/history` +
          (before || p.limit !== undefined
            ? `?${query({ beforeCreatedAt: before?.createdAt, beforeId: before?.id, limit: p.limit })}`
            : "");
        break;
      }
      case "platform.message":
        path = "/api/platform/messages";
        post(params);
        break;
      case "tasks.list": {
        const p = fields(params ?? {});
        const after = p.after ? fields(p.after) : {};
        path =
          "/api/platform/tasks?" +
          query({
            projectId: p.projectId,
            owner: p.owner,
            search: p.query,
            limit: p.limit,
            afterOrderRank: after.orderRank,
            afterTaskId: after.taskId,
          });
        break;
      }
      case "tasks.counts":
        path = "/api/platform/tasks/counts";
        break;
      case "tasks.get": {
        const p = fields(params ?? {});
        path = `/api/platform/tasks/${taskPathId(p.taskId)}`;
        break;
      }
      case "tasks.create":
        path = "/api/platform/tasks";
        post(params);
        break;
      case "tasks.version": {
        const p = fields(params ?? {});
        path =
          `/api/platform/tasks/${taskPathId(p.taskId)}/version?` +
          query({ revision: p.revision });
        break;
      }
      case "tasks.versions": {
        const p = fields(params ?? {});
        path =
          `/api/platform/tasks/${taskPathId(p.taskId)}/versions?` +
          query({ limit: p.limit, beforeRevision: p.beforeRevision });
        break;
      }
      case "tasks.revise":
        path = "/api/platform/tasks/revise";
        post(params);
        break;
      case "tasks.respond":
        path = "/api/platform/tasks/respond";
        post(params);
        break;
      case "tasks.responses": {
        const p = fields(params ?? {});
        const after = p.after ? fields(p.after) : {};
        path =
          `/api/platform/tasks/${taskPathId(p.taskId)}/responses?` +
          query({
            limit: p.limit,
            afterCreatedAt: after.createdAt,
            afterResponseId: after.responseId,
          });
        break;
      }
      case "tasks.complete":
        path = "/api/platform/tasks/complete";
        post(params);
        break;
      case "tasks.run-request":
        path = "/api/platform/tasks/run-request";
        post(params);
        break;
      case "tasks.order": {
        const p = fields(params ?? {});
        path =
          p.projectId === undefined
            ? "/api/platform/tasks/order"
            : `/api/platform/projects/${projectPathId(p.projectId)}/task-order`;
        break;
      }
      case "tasks.reorder":
        path = "/api/platform/tasks/reorder";
        post(params);
        break;
      case "tasks.reorder-selection":
        path = "/api/platform/tasks/reorder-selection";
        post(params);
        break;
      case "content.list": {
        const p = fields(params ?? {});
        const before = p.before ? fields(p.before) : {};
        path =
          "/api/platform/content?" +
          query({
            projectId: p.projectId,
            contentIds: Array.isArray(p.contentIds)
              ? JSON.stringify(p.contentIds)
              : p.contentIds,
            appObjectIds: Array.isArray(p.appObjectIds)
              ? JSON.stringify(p.appObjectIds)
              : p.appObjectIds,
            appId: p.appId,
            appIds: Array.isArray(p.appIds)
              ? JSON.stringify(p.appIds)
              : p.appIds,
            kind: p.kind,
            kinds: Array.isArray(p.kinds) ? JSON.stringify(p.kinds) : p.kinds,
            availability: p.availability,
            query: p.query,
            sort: p.sort,
            limit: p.limit,
            beforeKey: before.key,
            beforeContentId: before.contentId,
          });
        break;
      }
      case "content.deliveries": {
        const p = fields(params ?? {});
        const after = p.after ? fields(p.after) : {};
        path =
          "/api/platform/content/deliveries?" +
          query({
            inputIds: Array.isArray(p.inputIds)
              ? JSON.stringify(p.inputIds)
              : p.inputIds,
            limit: p.limit,
            afterCommittedAt: after.committedAt,
            afterCommandId: after.commandId,
          });
        break;
      }
      case "content.counts": {
        const p = fields(params ?? {});
        path =
          "/api/platform/content/counts?" +
          query({
            projectId: p.projectId,
            contentIds: Array.isArray(p.contentIds)
              ? JSON.stringify(p.contentIds)
              : p.contentIds,
            appObjectIds: Array.isArray(p.appObjectIds)
              ? JSON.stringify(p.appObjectIds)
              : p.appObjectIds,
            appId: p.appId,
            appIds: Array.isArray(p.appIds)
              ? JSON.stringify(p.appIds)
              : p.appIds,
            kind: p.kind,
            kinds: Array.isArray(p.kinds) ? JSON.stringify(p.kinds) : p.kinds,
            availability: p.availability,
            query: p.query,
          });
        break;
      }
      case "content.get": {
        const p = fields(params ?? {});
        path = `/api/platform/content/${contentPathId(p.contentId)}`;
        break;
      }
      case "content.resolve": {
        const p = fields(params ?? {});
        path =
          "/api/platform/content/resolve?" +
          query({
            appId: p.appId,
            appObjectId: p.appObjectId,
            instanceId: p.instanceId,
          });
        break;
      }
      case "content.move":
        path = "/api/platform/content/move";
        post(params);
        break;
      case "content.move-new-project":
        path = "/api/platform/content/move-new-project";
        post(params);
        break;
      case "work.link":
        path = "/api/platform/work/relations";
        post(params);
        break;
      case "work.relations": {
        const p = fields(params ?? {});
        path =
          `/api/platform/work/${contentPathId(p.objectId)}/relations?` +
          query({ limit: p.limit, after: p.after });
        break;
      }
      case "objects.read": {
        const p = fields(params ?? {});
        path =
          `/api/platform/objects/${contentPathId(p.contentId)}?` +
          query({ revision: p.revision });
        break;
      }
      case "objects.rename":
        path = "/api/platform/objects/rename";
        post(params);
        break;
      case "objects.annotations": {
        const p = fields(params ?? {});
        path =
          `/api/platform/objects/${contentPathId(p.contentId)}/annotations?` +
          query({ limit: p.limit, afterOrdinal: p.afterOrdinal });
        break;
      }
      case "objects.annotate":
        path = "/api/platform/objects/annotate";
        post(params);
        break;
      case "documents.read": {
        const p = fields(params ?? {});
        path =
          `/api/platform/documents/${contentPathId(p.contentId)}?` +
          query({ revision: p.revision });
        break;
      }
      case "objects.versions": {
        const p = fields(params ?? {});
        path =
          `/api/platform/objects/${contentPathId(p.contentId)}/versions?` +
          query({ limit: p.limit, beforeRevision: p.beforeRevision });
        break;
      }
      case "documents.create":
        path = "/api/platform/documents";
        post(params);
        break;
      case "documents.import":
        path = "/api/platform/documents/import";
        post(params);
        break;
      case "documents.revise":
        path = "/api/platform/documents/revise";
        post(params);
        break;
      case "images.create":
        path = "/api/platform/images";
        post(params);
        break;
      case "images.revise":
        path = "/api/platform/images/revise";
        post(params);
        break;
      case "interactive.create":
        path = "/api/platform/interactive";
        post(params);
        break;
      case "interactive.revise":
        path = "/api/platform/interactive/revise";
        post(params);
        break;
      case "interactive.rows":
        path = "/api/platform/interactive/rows";
        post(params);
        break;
      case "interactive.patch":
        path = "/api/platform/interactive/patch";
        post(params);
        break;
      case "scripts.read": {
        const p = fields(params ?? {});
        path = `/api/platform/scripts/${contentPathId(p.contentId)}`;
        break;
      }
      case "scripts.editor.head":
        path = "/api/platform/scripts/editor/head";
        post(params);
        break;
      case "scripts.editor.page":
        path = "/api/platform/scripts/editor/page";
        post(params);
        break;
      case "scripts.editor.detail":
        path = "/api/platform/scripts/editor/detail";
        post(params);
        break;
      case "scripts.snapshot": {
        const p = fields(params ?? {});
        path = `/api/platform/scripts/${contentPathId(p.contentId)}/snapshot`;
        break;
      }
      case "scripts.items": {
        const p = fields(params ?? {});
        const after = p.after ? fields(p.after) : {};
        path =
          `/api/platform/scripts/${contentPathId(p.contentId)}/items?` +
          query({
            parentId: p.parentId,
            kind: p.kind,
            limit: p.limit,
            expectedActivityRevision: p.expectedActivityRevision,
            afterOrdinal: after.ordinal,
            afterItemId: after.itemId,
          });
        break;
      }
      case "scripts.item": {
        const p = fields(params ?? {});
        path =
          `/api/platform/scripts/${contentPathId(p.contentId)}/items/${contentPathId(p.itemId)}?` +
          query({ revision: p.revision });
        break;
      }
      case "scripts.create":
        path = "/api/platform/scripts";
        post(params);
        break;
      case "scripts.update":
        path = "/api/platform/scripts/update";
        post(params);
        break;
      case "scripts.rename":
        path = "/api/platform/scripts/rename";
        post(params);
        break;
      case "scripts.item.create":
        path = "/api/platform/scripts/items";
        post(params);
        break;
      case "scripts.item.revise":
        path = "/api/platform/scripts/items/revise";
        post(params);
        break;
      case "scripts.item.restore":
        path = "/api/platform/scripts/items/restore";
        post(params);
        break;
      case "scripts.item.workflow":
        path = "/api/platform/scripts/items/workflow";
        post(params);
        break;
      case "scripts.review.change":
        path = "/api/platform/scripts/reviews";
        post(params);
        break;
      case "scripts.candidate.decide":
        path = "/api/platform/scripts/candidates/decide";
        post(params);
        break;
      case "scripts.export.record":
        path = "/api/platform/scripts/exports";
        post(params);
        break;
      case "input.send":
      case "input.cancel":
        path = `/api/inputs/${encodeURIComponent(String(params))}/${method === "input.send" ? "send" : "cancel"}`;
        post();
        break;
      case "search": {
        const p = fields(params);
        path =
          "/api/search?" +
          query({
            q: p.query,
            projectId: p.projectId,
            limit: p.limit,
            offset: p.offset,
            includeTitles: p.includeTitles,
            kind: p.kind,
            kinds: Array.isArray(p.kinds) ? JSON.stringify(p.kinds) : p.kinds,
            appIds: Array.isArray(p.appIds)
              ? JSON.stringify(p.appIds)
              : p.appIds,
            sort: p.sort,
          });
        break;
      }
      case "models":
        path = "/api/models";
        break;
      case "session-permissions.read":
        path = "/api/session-permissions?" + query(fields(params));
        break;
      case "session-permissions.update":
        path = "/api/session-permissions/update";
        post(params);
        break;
      case "connection.check":
        path = "/api/connection/check";
        post();
        break;
      case "connection.configure":
        path = "/api/connection/configure";
        post(params);
        break;
      case "model-settings.read":
      case "model-settings.update":
        path = "/api/" + method.replace(".", "/");
        post(params);
        break;
      case "asset.add":
        path = "/api/assets";
        post();
        data = binary(params);
        break;
      case "attachment.add": {
        const p = fields(params);
        path = "/api/attachments";
        post();
        headers["X-File-Name"] = encodeURIComponent(String(p.name));
        data = binary(p.data);
        break;
      }
      case "pdf.import":
      case "reader.import": {
        const p = fields(params);
        path =
          method === "reader.import"
            ? "/api/import/reading"
            : "/api/import/pdf";
        post();
        headers["X-Command-Id"] = String(p.commandId);
        headers["X-Project-Id"] = String(p.projectId);
        headers["X-Source-Path"] = encodeURIComponent(String(p.relativePath));
        data = binary(p.data);
        break;
      }
      case "reader.read":
      case "reader.book":
      case "reader.contents":
      case "reader.state":
      case "reader.marks":
        path =
          (
            {
              "reader.read": "/api/reader/section?",
              "reader.book": "/api/reader/book?",
              "reader.contents": "/api/reader/contents?",
              "reader.state": "/api/reader/state?",
              "reader.marks": "/api/reader/marks?",
            } as const
          )[method] + query(fields(params));
        break;
      case "reader.command":
        path = "/api/reader/commands";
        post(params);
        break;
      case "reader.ocr":
        path = "/api/reader/ocr";
        post(params);
        break;
      case "execution.snapshot":
        path = "/api/executions?" + query(fields(params));
        break;
      case "execution.result": {
        const p = fields(params);
        path =
          "/api/executions/result?" +
          query({ ...fields(p.scope), jobId: p.jobId });
        break;
      }
      case "execution.control":
        path = "/api/executions/control";
        post(params);
        break;
      case "task.snapshot":
        path = `/api/tasks/${encodeURIComponent(String(params))}/runtime`;
        break;
      case "task.run-history": {
        const p = fields(params);
        path =
          `/api/tasks/${encodeURIComponent(String(p.taskId))}/runs?` +
          query({ limit: p.limit, beforeRun: p.beforeRun });
        break;
      }
      case "task.run-status": {
        const p = fields(params);
        path = `/api/tasks/${encodeURIComponent(String(p.taskId))}/runs/${encodeURIComponent(String(p.runNumber))}/status`;
        break;
      }
      case "task.control": {
        const { id, ...control } = fields(params);
        path = `/api/tasks/${encodeURIComponent(String(id))}/runtime`;
        post(control);
        break;
      }
      case "speech.status":
        path = "/api/speech/status";
        break;
      case "speech.stream": {
        path = "/api/speech/stream";
        const p = fields(params);
        post(
          p.action === "push"
            ? { ...p, data: Array.from(new Uint8Array(binary(p.data))) }
            : p,
        );
        break;
      }
      case "speech.transcribe":
      case "speech.synthesize": {
        const p = fields(params),
          scope = fields(p.scope);
        path =
          "/api/speech/" +
          (method === "speech.transcribe" ? "transcribe" : "synthesize");
        headers["X-Project-Id"] = String(scope.projectId);
        if (scope.artifactId) {
          headers["X-Artifact-Id"] = String(scope.artifactId);
          headers["X-Artifact-Revision"] = String(scope.revision);
        }
        if (method === "speech.transcribe") {
          post();
          headers["Content-Type"] = "audio/wav";
          data = binary(p.data);
        } else {
          post({ text: p.text });
          wav = true;
        }
        break;
      }
      case "notifications.read":
        path = "/api/notifications";
        break;
      case "notifications.control":
        path = "/api/notifications";
        post(params);
        break;
      case "browser.register":
      case "browser.exchange": {
        const p = fields(params);
        path =
          "/api/browser/desktop/" +
          (method === "browser.register" ? "register" : "exchange");
        post(p.data);
        headers["X-Desktop-Key"] = String(p.key);
        break;
      }
      default:
        throw new Error("不支持这个应用操作。");
    }
    if (options.identityGeneration) {
      headers[applicationTokenHeader] = options.identityGeneration;
      // The same request also works with an older remote center; never retry a
      // write under another name after an uncertain response.
      headers[legacyApplicationTokenHeader] = options.identityGeneration;
    }
    // In a browser Origin is managed by the browser; a trusted native remote adapter supplies it explicitly.
    if (verb === "POST" && this.origin) headers.Origin = this.origin;
    const response = await this.request(this.origin + path, {
      method: verb,
      headers,
      body: data,
      signal: options.signal,
      credentials: "include",
      redirect: "error",
      cache: "no-store",
    });
    if (epoch !== this.epoch)
      throw new ApplicationRequestError(408, "身份已切换，旧响应已丢弃。");
    if (!response.ok) {
      let message = "请求失败。",
        code: string | undefined;
      try {
        const failure = await response.json();
        if (typeof failure?.message === "string") message = failure.message;
        if (typeof failure?.code === "string") code = failure.code;
      } catch {}
      if (epoch !== this.epoch)
        throw new ApplicationRequestError(408, "身份已切换，旧响应已丢弃。");
      throw new ApplicationRequestError(response.status, message, code);
    }
    const value: unknown = wav
      ? new Uint8Array(await response.arrayBuffer())
      : await response.json();
    if (epoch !== this.epoch)
      throw new ApplicationRequestError(408, "身份已切换，旧响应已丢弃。");
    return value;
  }
}
import {
  applicationTokenHeader,
  legacyApplicationTokenHeader,
} from "./application-names.js";
