import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname } from "node:path";
import { z, ZodError } from "zod";
import { DomainError, localAccess } from "../../../packages/core/src/model.js";
import type { ConversationStream } from "../../../packages/core/src/live-conversation.js";
import { maxPdfBytes } from "../../../packages/core/src/pdf.js";
import { maxReadingFileBytes } from "../../../packages/core/src/reader.js";
import { maxSpeechSegmentBytes } from "../../../packages/core/src/audio.js";
import { maxMessageAttachmentBytes } from "../../../packages/core/src/message-attachment-policy.js";
import {
  appContentSecurityPolicy,
  applicationViewPolicy,
  applicationViewPermissions,
  resourceMime,
} from "../../../packages/core/src/resource-policy.js";
import {
  Application,
  applicationFailure,
  type ApplicationOptions,
} from "../../../packages/application/src/application.js";
import type { WorkspaceStore } from "../../../packages/application/src/store.js";
import type { AgentTools } from "../../../packages/application/src/agent-tools.js";

async function body(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw new DomainError("invalid", "请求内容超过大小限制。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const jsonBody = async (req: IncomingMessage, limit: number) =>
  JSON.parse((await body(req, limit)).toString()) as unknown;
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
function executionScope(url: URL) {
  return {
    projectId: url.searchParams.get("projectId"),
    artifactId: url.searchParams.get("artifactId") || null,
    ...Object.fromEntries(
      ["conversationId", "inputId", "threadId"].flatMap((key) =>
        url.searchParams.get(key) ? [[key, url.searchParams.get(key)]] : [],
      ),
    ),
    ...(url.searchParams.get("taskRun") === "true" ? { taskRun: true } : {}),
  };
}
function speechScope(req: IncomingMessage) {
  return {
    projectId: req.headers["x-project-id"],
    ...(req.headers["x-artifact-id"]
      ? {
          artifactId: req.headers["x-artifact-id"],
          revision: Number(req.headers["x-artifact-revision"]),
        }
      : {}),
  };
}
function platformQuery(url: URL, allowed: readonly string[]) {
  for (const key of url.searchParams.keys())
    if (!allowed.includes(key))
      throw new DomainError("invalid", "Platform 查询参数无效。");
  const value = (key: string) => url.searchParams.get(key) ?? undefined;
  const number = (key: string) =>
    url.searchParams.has(key) ? Number(value(key)) : undefined;
  const boolean = (key: string) => {
    const raw = value(key);
    if (raw === undefined) return undefined;
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new DomainError("invalid", "Platform 布尔查询参数无效。");
  };
  return { value, number, boolean };
}
function platformArrayQuery(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new DomainError("invalid", "Platform 列表筛选参数无效。");
  }
}

/** Web-only HTTP adapter. Business operations live in the shared package. */
export function createAppServer(
  store: WorkspaceStore,
  options: ApplicationOptions & {
    port: number;
    webRoot: string;
    devOrigin?: string;
    publicOrigin?: string;
    agentTools?: AgentTools;
  },
) {
  const application = new Application(store, options);
  const token = randomBytes(32).toString("hex");
  if (options.publicOrigin) {
    const publicURL = new URL(options.publicOrigin);
    if (
      publicURL.protocol !== "https:" ||
      publicURL.origin !== options.publicOrigin
    )
      throw new Error("公开 Web 地址必须是明确的 HTTPS origin。");
    if (!options.identity) throw new Error("公开 Web 服务必须启用身份认证。");
  }
  const origins = new Set([
    `http://127.0.0.1:${options.port}`,
    `http://localhost:${options.port}`,
    ...(options.devOrigin ? [options.devOrigin] : []),
    ...(options.publicOrigin ? [options.publicOrigin] : []),
  ]);
  const hosts = new Set([...origins].map((origin) => new URL(origin).host));
  const streams = new Set<() => void>();
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", appContentSecurityPolicy);
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    try {
      if (!req.headers.host || !hosts.has(req.headers.host)) {
        json(res, 403, { message: "不接受这个 Host。" });
        return;
      }
      if (
        (req.headers.origin && !origins.has(req.headers.origin)) ||
        req.headers["sec-fetch-site"] === "cross-site"
      ) {
        json(res, 403, { message: "不接受跨站请求。" });
        return;
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (req.method === "POST" && url.pathname === "/api/identity/login") {
        if (
          !options.identity ||
          !req.headers.origin ||
          !origins.has(req.headers.origin) ||
          req.headers["content-type"] !== "application/json"
        )
          throw new DomainError("forbidden", "连接请求无效。");
        const data = z
          .object({ token: z.string().max(128) })
          .strict()
          .parse(await jsonBody(req, 1024));
        const secret = await options.identity.login(
          data.token,
          req.socket.remoteAddress ?? "unknown",
        );
        res.setHeader("Set-Cookie", [
          `${options.identity.cookieName}=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${options.publicOrigin ? "; Secure" : ""}`,
          `${options.identity.legacyCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${options.publicOrigin ? "; Secure" : ""}`,
        ]);
        json(res, 200, { connected: true });
        return;
      }
      const authentication = await options.identity?.authenticateShared(
        req.headers.cookie,
      );
      const access = authentication?.access ?? localAccess,
        requestToken = authentication?.csrf ?? token;
      if (
        options.identity &&
        !authentication &&
        url.pathname.startsWith("/api/") &&
        !["/api/health", "/api/host-tools/call"].includes(url.pathname)
      ) {
        json(res, 401, {
          code: "authentication_required",
          message: "请登录后继续操作。",
        });
        return;
      }
      const assertIdentity = () => {
        if (
          options.identity &&
          !options.identity.authenticate(req.headers.cookie)
        )
          throw new DomainError("forbidden", "身份已失效，操作未执行。");
      };
      const business = application.session(access, assertIdentity);
      if (req.method === "POST" && url.pathname === "/api/host-tools/call") {
        if (
          req.headers.origin ||
          req.headers["sec-fetch-site"] ||
          !options.agentTools?.authenticate(req.headers.authorization)
        ) {
          json(res, 403, { code: "forbidden", message: "Host 工具认证失败。" });
          return;
        }
        if (req.headers["content-type"] !== "application/json") {
          json(res, 415, { message: "需要 JSON 请求。" });
          return;
        }
        try {
          json(
            res,
            200,
            await options.agentTools.call(await jsonBody(req, 4 * 1024 * 1024)),
          );
        } catch (error) {
          if (error instanceof DomainError && error.code !== "forbidden")
            json(res, 200, {
              ok: false,
              code: error.code,
              message: error.message,
            });
          else if (error instanceof ZodError)
            json(res, 200, {
              ok: false,
              code: "invalid",
              message: "工具参数无效。",
            });
          else throw error;
        }
        return;
      }
      const task = /^\/api\/tasks\/([a-zA-Z0-9_-]+)\/runtime$/.exec(
        url.pathname,
      );
      const taskRunHistory = /^\/api\/tasks\/([a-zA-Z0-9_-]+)\/runs$/.exec(
        url.pathname,
      );
      const taskRunStatus =
        /^\/api\/tasks\/([a-zA-Z0-9_-]+)\/runs\/([1-9][0-9]*)\/status$/.exec(
          url.pathname,
        );
      if (
        ["/api/model-settings/read", "/api/model-settings/update"].includes(
          url.pathname,
        )
      )
        throw new DomainError(
          "forbidden",
          "请在本机 Morphz 中管理模型；远端或多人工作空间请联系管理员。",
        );
      if (req.method === "GET") {
        if (url.pathname === "/api/reader/original") {
          const artifactId = url.searchParams.get("artifactId");
          const revision = Number(url.searchParams.get("revision"));
          const request = { artifactId, revision };
          const original =
            await business.readPlatformReaderOriginalMetadata(request);
          const size = original.byteLength;
          const range = req.headers.range;
          const match =
            range === undefined ? null : /^bytes=(\d+)-(\d*)$/.exec(range);
          if (
            range !== undefined &&
            (!match ||
              Number(match[1]) >= size ||
              (match[2] !== "" && Number(match[2]) < Number(match[1])))
          ) {
            res.writeHead(416, { "Content-Range": `bytes */${size}` });
            res.end();
            return;
          }
          const start = match ? Number(match[1]) : 0;
          const end =
            match && match[2] !== ""
              ? Math.min(Number(match[2]) + 1, size)
              : size;
          res.writeHead(match ? 206 : 200, {
            "Content-Type": "application/pdf",
            "Content-Length": String(end - start),
            "Accept-Ranges": "bytes",
            ETag: `"${original.sha256}"`,
            ...(match
              ? { "Content-Range": `bytes ${start}-${end - 1}/${size}` }
              : {}),
          });
          for (
            let offset = start;
            offset < end && !res.destroyed;
            offset += 1024 * 1024
          ) {
            const bytes = await business.readPlatformReaderOriginalRange({
              ...request,
              start: offset,
              endExclusive: Math.min(offset + 1024 * 1024, end),
            });
            if (!res.write(bytes))
              await new Promise<void>((resolve, reject) => {
                const done = () => {
                  res.off("drain", drained);
                  res.off("close", closed);
                };
                const drained = () => {
                  done();
                  resolve();
                };
                const closed = () => {
                  done();
                  reject(new Error("PDF 原件读取连接已关闭。"));
                };
                res.once("drain", drained);
                res.once("close", closed);
              });
          }
          if (!res.destroyed) res.end();
          return;
        }
        if (url.pathname === "/api/reader/marks") {
          const params = url.searchParams;
          json(
            res,
            200,
            await business.readPlatformReaderMarks({
              artifactId: params.get("artifactId"),
              revision: Number(params.get("revision")),
              ...(params.has("deleted")
                ? {
                    deleted:
                      params.get("deleted") === "true"
                        ? true
                        : params.get("deleted") === "false"
                          ? false
                          : params.get("deleted"),
                  }
                : {}),
              ...(params.has("sectionId")
                ? { sectionId: params.get("sectionId") }
                : {}),
              ...(params.has("start")
                ? { start: Number(params.get("start")) }
                : {}),
              ...(params.has("end") ? { end: Number(params.get("end")) } : {}),
              ...(params.has("after") ? { after: params.get("after") } : {}),
              ...(params.has("offset")
                ? { offset: Number(params.get("offset")) }
                : {}),
              ...(params.has("limit")
                ? { limit: Number(params.get("limit")) }
                : {}),
            }),
          );
          return;
        }
        if (
          url.pathname === "/api/reader/section" ||
          url.pathname === "/api/reader/book" ||
          url.pathname === "/api/reader/contents" ||
          url.pathname === "/api/reader/state"
        ) {
          const request = {
            artifactId: url.searchParams.get("artifactId"),
            revision: Number(url.searchParams.get("revision")),
            ...(url.pathname.endsWith("/section")
              ? { sectionId: url.searchParams.get("sectionId") }
              : {}),
          };
          json(
            res,
            200,
            await (url.pathname.endsWith("/section")
              ? business.readPlatformReaderSection(request)
              : url.pathname.endsWith("/book")
                ? business.readPlatformReaderBook(request)
                : url.pathname.endsWith("/contents")
                  ? business.readPlatformReaderContents(request)
                  : business.readPlatformReaderState(request)),
          );
          return;
        }
        if (url.pathname === "/api/health") {
          json(res, 200, {
            application: "morphz",
            protocol: 1,
            runtimeConnected: options.runtime?.isConnected ?? false,
          });
          return;
        }
        if (url.pathname === "/api/platform/bootstrap") {
          platformQuery(url, []);
          json(res, 200, business.platformBootstrap(requestToken));
          return;
        }
        if (url.pathname === "/api/profile") {
          platformQuery(url, []);
          json(res, 200, await business.readProfile());
          return;
        }
        if (url.pathname === "/api/profile/avatar") {
          const query = platformQuery(url, ["subject", "revision", "variant"]);
          const file = await business.readProfileAvatar({ subject: query.value("subject"), revision: query.number("revision"), variant: query.value("variant") });
          assertIdentity();
          res.writeHead(200, { "Content-Type": file.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
          res.end(file.bytes);
          return;
        }
        if (url.pathname === "/api/platform/apps") {
          platformQuery(url, []);
          json(res, 200, await business.listUiPackages());
          return;
        }
        if (url.pathname === "/api/platform/app-views") {
          platformQuery(url, []);
          json(res, 200, await business.listPlatformAppViews());
          return;
        }
        if (url.pathname === "/api/platform/runtime-snapshot") {
          platformQuery(url, []);
          json(res, 200, business.platformRuntimeSnapshot());
          return;
        }
        if (url.pathname === "/api/platform/runtime-navigation") {
          const query = platformQuery(url, [
            "projectId",
            "conversationId",
            "refreshActivity",
          ]);
          const projectId = query.value("projectId");
          const conversationId = query.value("conversationId");
          const refreshActivity = query.boolean("refreshActivity");
          if (!!projectId !== !!conversationId)
            throw new DomainError("invalid", "对话范围参数不完整。");
          json(
            res,
            200,
            await business.platformRuntimeNavigation({
              projectId,
              conversationId,
              refreshActivity,
            }),
          );
          return;
        }
        if (url.pathname === "/api/bookmarks") {
          const deleted = url.searchParams.get("deleted");
          if (deleted !== null && deleted !== "true" && deleted !== "false")
            throw new DomainError("invalid", "收藏筛选条件无效。");
          json(
            res,
            200,
            await business.listBookmarks({
              ...(deleted !== null ? { deleted: deleted === "true" } : {}),
              ...(url.searchParams.has("query")
                ? { query: url.searchParams.get("query") }
                : {}),
              ...(url.searchParams.has("offset")
                ? { offset: Number(url.searchParams.get("offset")) }
                : {}),
              ...(url.searchParams.has("limit")
                ? { limit: Number(url.searchParams.get("limit")) }
                : {}),
            }),
          );
          return;
        }
        if (url.pathname === "/api/platform/projects") {
          const query = platformQuery(url, [
            "status",
            "limit",
            "afterUpdatedAt",
            "afterProjectId",
          ]);
          json(
            res,
            200,
            await business.listPlatformProjects({
              status: query.value("status"),
              limit: query.number("limit"),
              ...(query.value("afterUpdatedAt") || query.value("afterProjectId")
                ? {
                    after: {
                      updatedAt: query.value("afterUpdatedAt"),
                      projectId: query.value("afterProjectId"),
                    },
                  }
                : {}),
            }),
          );
          return;
        }
        const projectUnderstanding =
          /^\/api\/platform\/projects\/([a-zA-Z0-9_-]+)\/understanding$/.exec(
            url.pathname,
          );
        if (projectUnderstanding) {
          const query = platformQuery(url, ["revision"]);
          json(
            res,
            200,
            await business.getPlatformProjectUnderstanding({
              projectId: projectUnderstanding[1],
              revision: query.number("revision"),
            }),
          );
          return;
        }
        const platformProject =
          /^\/api\/platform\/projects\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
        if (platformProject) {
          platformQuery(url, []);
          json(
            res,
            200,
            await business.getPlatformProject({
              projectId: platformProject[1],
            }),
          );
          return;
        }
        if (url.pathname === "/api/platform/conversations/navigation") {
          const query = platformQuery(url, [
            "limit",
            "afterUpdatedAt",
            "afterConversationId",
          ]);
          json(
            res,
            200,
            await business.listAccessiblePlatformConversations({
              limit: query.number("limit"),
              ...(query.value("afterUpdatedAt") ||
              query.value("afterConversationId")
                ? {
                    after: {
                      updatedAt: query.value("afterUpdatedAt"),
                      conversationId: query.value("afterConversationId"),
                    },
                  }
                : {}),
            }),
          );
          return;
        }
        const platformConversations =
          /^\/api\/platform\/projects\/([a-zA-Z0-9_-]+)\/conversations$/.exec(
            url.pathname,
          );
        if (platformConversations) {
          const query = platformQuery(url, [
            "archived",
            "limit",
            "afterUpdatedAt",
            "afterConversationId",
          ]);
          json(
            res,
            200,
            await business.listPlatformConversations({
              projectId: platformConversations[1],
              archived: query.boolean("archived"),
              limit: query.number("limit"),
              ...(query.value("afterUpdatedAt") ||
              query.value("afterConversationId")
                ? {
                    after: {
                      updatedAt: query.value("afterUpdatedAt"),
                      conversationId: query.value("afterConversationId"),
                    },
                  }
                : {}),
            }),
          );
          return;
        }
        const platformConversationHistory =
          /^\/api\/platform\/projects\/([a-zA-Z0-9_-]+)\/conversations\/([a-zA-Z0-9_-]+)\/history$/.exec(
            url.pathname,
          );
        if (platformConversationHistory) {
          const query = platformQuery(url, [
            "beforeCreatedAt",
            "beforeId",
            "limit",
          ]);
          const beforeCreatedAt = query.value("beforeCreatedAt");
          const beforeId = query.value("beforeId");
          if (!!beforeCreatedAt !== !!beforeId)
            throw new DomainError("invalid", "对话历史游标不完整。");
          json(
            res,
            200,
            await business.platformConversationHistory({
              projectId: platformConversationHistory[1],
              conversationId: platformConversationHistory[2],
              ...(beforeCreatedAt && beforeId
                ? { before: { createdAt: beforeCreatedAt, id: beforeId } }
                : {}),
              ...(query.number("limit") !== undefined
                ? { limit: query.number("limit") }
                : {}),
            }),
          );
          return;
        }
        if (url.pathname === "/api/platform/tasks/order") {
          platformQuery(url, []);
          json(res, 200, await business.getPlatformTaskOrder({}));
          return;
        }
        const platformTaskOrder =
          /^\/api\/platform\/projects\/([a-zA-Z0-9_-]+)\/task-order$/.exec(
            url.pathname,
          );
        if (platformTaskOrder) {
          platformQuery(url, []);
          json(
            res,
            200,
            await business.getPlatformTaskOrder({
              projectId: platformTaskOrder[1],
            }),
          );
          return;
        }
        if (url.pathname === "/api/platform/tasks/counts") {
          platformQuery(url, []);
          json(res, 200, await business.platformTaskCounts());
          return;
        }
        if (url.pathname === "/api/platform/tasks") {
          const query = platformQuery(url, [
            "projectId",
            "owner",
            "search",
            "limit",
            "afterOrderRank",
            "afterTaskId",
          ]);
          json(
            res,
            200,
            await business.listPlatformTasks({
              projectId: query.value("projectId"),
              owner: query.value("owner"),
              query: query.value("search"),
              limit: query.number("limit"),
              ...(query.value("afterOrderRank") || query.value("afterTaskId")
                ? {
                    after: {
                      orderRank: query.number("afterOrderRank"),
                      taskId: query.value("afterTaskId"),
                    },
                  }
                : {}),
            }),
          );
          return;
        }
        const platformTaskHead =
          /^\/api\/platform\/tasks\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
        if (platformTaskHead) {
          platformQuery(url, []);
          json(
            res,
            200,
            await business.platformTaskHead({ taskId: platformTaskHead[1] }),
          );
          return;
        }
        const platformTaskVersion =
          /^\/api\/platform\/tasks\/([a-zA-Z0-9_-]+)\/version$/.exec(
            url.pathname,
          );
        if (platformTaskVersion) {
          const query = platformQuery(url, ["revision"]);
          json(
            res,
            200,
            await business.getPlatformTaskVersion({
              taskId: platformTaskVersion[1],
              revision: query.number("revision"),
            }),
          );
          return;
        }
        const platformTaskVersions =
          /^\/api\/platform\/tasks\/([a-zA-Z0-9_-]+)\/versions$/.exec(
            url.pathname,
          );
        if (platformTaskVersions) {
          const query = platformQuery(url, ["limit", "beforeRevision"]);
          json(
            res,
            200,
            await business.listPlatformTaskVersions({
              taskId: platformTaskVersions[1],
              limit: query.number("limit"),
              beforeRevision: query.number("beforeRevision"),
            }),
          );
          return;
        }
        const platformTaskResponses =
          /^\/api\/platform\/tasks\/([a-zA-Z0-9_-]+)\/responses$/.exec(
            url.pathname,
          );
        if (platformTaskResponses) {
          const query = platformQuery(url, [
            "limit",
            "afterCreatedAt",
            "afterResponseId",
          ]);
          json(
            res,
            200,
            await business.listPlatformTaskResponses({
              taskId: platformTaskResponses[1],
              limit: query.number("limit"),
              ...(query.value("afterCreatedAt") ||
              query.value("afterResponseId")
                ? {
                    after: {
                      createdAt: query.value("afterCreatedAt"),
                      responseId: query.value("afterResponseId"),
                    },
                  }
                : {}),
            }),
          );
          return;
        }
        if (url.pathname === "/api/platform/content/resolve") {
          const query = platformQuery(url, [
            "appId",
            "appObjectId",
            "instanceId",
          ]);
          json(
            res,
            200,
            await business.resolvePlatformContent({
              appId: query.value("appId"),
              appObjectId: query.value("appObjectId"),
              instanceId: query.value("instanceId"),
            }),
          );
          return;
        }
        if (url.pathname === "/api/platform/content/counts") {
          const query = platformQuery(url, [
            "projectId",
            "contentIds",
            "appObjectIds",
            "appId",
            "appIds",
            "kind",
            "kinds",
            "availability",
            "query",
          ]);
          json(
            res,
            200,
            await business.listPlatformContentCounts({
              projectId: query.value("projectId"),
              contentIds: platformArrayQuery(query.value("contentIds")),
              appObjectIds: platformArrayQuery(query.value("appObjectIds")),
              appId: query.value("appId"),
              appIds: platformArrayQuery(query.value("appIds")),
              kind: query.value("kind"),
              kinds: platformArrayQuery(query.value("kinds")),
              availability: query.value("availability"),
              query: query.value("query"),
            }),
          );
          return;
        }
        if (url.pathname === "/api/platform/content/deliveries") {
          const query = platformQuery(url, [
            "inputIds",
            "limit",
            "afterCommittedAt",
            "afterCommandId",
          ]);
          json(
            res,
            200,
            await business.listPlatformContentDeliveries({
              inputIds: platformArrayQuery(query.value("inputIds")),
              limit: query.number("limit"),
              ...(query.value("afterCommittedAt") ||
              query.value("afterCommandId")
                ? {
                    after: {
                      committedAt: query.value("afterCommittedAt"),
                      commandId: query.value("afterCommandId"),
                    },
                  }
                : {}),
            }),
          );
          return;
        }
        const platformContent =
          /^\/api\/platform\/content\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
        if (platformContent) {
          platformQuery(url, []);
          json(
            res,
            200,
            await business.getPlatformContent({
              contentId: platformContent[1],
            }),
          );
          return;
        }
        if (url.pathname === "/api/platform/content") {
          const query = platformQuery(url, [
            "projectId",
            "contentIds",
            "appObjectIds",
            "appId",
            "appIds",
            "kind",
            "kinds",
            "availability",
            "query",
            "sort",
            "limit",
            "beforeKey",
            "beforeContentId",
          ]);
          json(
            res,
            200,
            await business.listPlatformContent({
              projectId: query.value("projectId"),
              contentIds: platformArrayQuery(query.value("contentIds")),
              appObjectIds: platformArrayQuery(query.value("appObjectIds")),
              appId: query.value("appId"),
              appIds: platformArrayQuery(query.value("appIds")),
              kind: query.value("kind"),
              kinds: platformArrayQuery(query.value("kinds")),
              availability: query.value("availability"),
              query: query.value("query"),
              sort: query.value("sort"),
              limit: query.number("limit"),
              ...(query.value("beforeKey") || query.value("beforeContentId")
                ? {
                    before: {
                      key: query.value("beforeKey"),
                      contentId: query.value("beforeContentId"),
                    },
                  }
                : {}),
            }),
          );
          return;
        }
        const platformWorkRelations =
          /^\/api\/platform\/work\/([a-zA-Z0-9_-]+)\/relations$/.exec(
            url.pathname,
          );
        if (platformWorkRelations) {
          const query = platformQuery(url, ["limit", "after"]);
          json(
            res,
            200,
            await business.listPlatformWorkRelations({
              objectId: platformWorkRelations[1],
              limit: query.number("limit"),
              after: query.value("after"),
            }),
          );
          return;
        }
        const platformObject =
          /^\/api\/platform\/objects\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
        const platformAnnotations =
          /^\/api\/platform\/objects\/([a-zA-Z0-9_-]+)\/annotations$/.exec(
            url.pathname,
          );
        if (platformAnnotations) {
          const query = platformQuery(url, ["limit", "afterOrdinal"]);
          json(
            res,
            200,
            await business.listPlatformObjectAnnotations({
              contentId: platformAnnotations[1],
              limit: query.number("limit"),
              afterOrdinal: query.number("afterOrdinal"),
            }),
          );
          return;
        }
        if (platformObject) {
          const query = platformQuery(url, ["revision"]);
          json(
            res,
            200,
            await business.readPlatformObject({
              contentId: platformObject[1],
              revision: query.number("revision"),
            }),
          );
          return;
        }
        const platformObjectVersions =
          /^\/api\/platform\/objects\/([a-zA-Z0-9_-]+)\/versions$/.exec(
            url.pathname,
          );
        if (platformObjectVersions) {
          const query = platformQuery(url, ["limit", "beforeRevision"]);
          json(
            res,
            200,
            await business.listPlatformObjectVersions({
              contentId: platformObjectVersions[1],
              limit: query.number("limit"),
              beforeRevision: query.number("beforeRevision"),
            }),
          );
          return;
        }
        const platformDocument =
          /^\/api\/platform\/documents\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
        if (platformDocument) {
          const query = platformQuery(url, ["revision"]);
          json(
            res,
            200,
            await business.readPlatformDocument({
              contentId: platformDocument[1],
              revision: query.number("revision"),
            }),
          );
          return;
        }
        const platformScriptItem =
          /^\/api\/platform\/scripts\/([a-zA-Z0-9_-]+)\/items\/([a-zA-Z0-9_-]+)$/.exec(
            url.pathname,
          );
        if (platformScriptItem) {
          const query = platformQuery(url, ["revision"]);
          json(
            res,
            200,
            await business.readPlatformScriptItem({
              contentId: platformScriptItem[1],
              itemId: platformScriptItem[2],
              revision: query.number("revision"),
            }),
          );
          return;
        }
        const platformScriptItems =
          /^\/api\/platform\/scripts\/([a-zA-Z0-9_-]+)\/items$/.exec(
            url.pathname,
          );
        if (platformScriptItems) {
          const query = platformQuery(url, [
            "parentId",
            "kind",
            "limit",
            "expectedActivityRevision",
            "afterOrdinal",
            "afterItemId",
          ]);
          json(
            res,
            200,
            await business.listPlatformScriptItems({
              contentId: platformScriptItems[1],
              parentId: query.value("parentId") ?? null,
              kind: query.value("kind"),
              limit: query.number("limit"),
              expectedActivityRevision: query.number(
                "expectedActivityRevision",
              ),
              ...(query.value("afterOrdinal") || query.value("afterItemId")
                ? {
                    after: {
                      ordinal: query.number("afterOrdinal"),
                      itemId: query.value("afterItemId"),
                    },
                  }
                : {}),
            }),
          );
          return;
        }
        const platformScriptSnapshot =
          /^\/api\/platform\/scripts\/([a-zA-Z0-9_-]+)\/snapshot$/.exec(
            url.pathname,
          );
        if (platformScriptSnapshot) {
          platformQuery(url, []);
          json(
            res,
            200,
            await business.readPlatformScriptSnapshot({
              contentId: platformScriptSnapshot[1],
            }),
          );
          return;
        }
        const platformScript =
          /^\/api\/platform\/scripts\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
        if (platformScript) {
          platformQuery(url, []);
          json(
            res,
            200,
            await business.readPlatformScript({ contentId: platformScript[1] }),
          );
          return;
        }
        if (url.pathname === "/api/notifications") {
          json(res, 200, await business.notifications());
          return;
        }
        if (url.pathname === "/api/speech/status") {
          json(res, 200, business.speechStatus());
          return;
        }
        if (task) {
          json(res, 200, await business.taskSnapshot(task[1]));
          return;
        }
        if (taskRunHistory) {
          json(
            res,
            200,
            await business.taskRunHistory({
              taskId: taskRunHistory[1],
              ...(url.searchParams.has("limit")
                ? { limit: Number(url.searchParams.get("limit")) }
                : {}),
              ...(url.searchParams.has("beforeRun")
                ? { beforeRun: Number(url.searchParams.get("beforeRun")) }
                : {}),
            }),
          );
          return;
        }
        if (taskRunStatus) {
          json(
            res,
            200,
            await business.taskRunStatus({
              taskId: taskRunStatus[1],
              runNumber: Number(taskRunStatus[2]),
            }),
          );
          return;
        }
        if (url.pathname === "/api/models") {
          json(res, 200, await business.models());
          return;
        }
        if (url.pathname === "/api/session-permissions") {
          const query = platformQuery(url, ["projectId", "conversationId"]);
          const result = await business.readSessionPermissions({
            projectId: query.value("projectId"),
            conversationId: query.value("conversationId"),
          });
          // This transport is Web/remote, not the local Human settings host.
          json(res, 200, {
            ...result,
            canUpdate: false,
            readOnlyReason: result.canUpdate
              ? "local_only"
              : result.readOnlyReason,
          });
          return;
        }
        if (url.pathname === "/api/executions") {
          json(res, 200, await business.executionSnapshot(executionScope(url)));
          return;
        }
        if (url.pathname === "/api/executions/result") {
          json(
            res,
            200,
            await business.executionResult({
              scope: executionScope(url),
              jobId: url.searchParams.get("jobId"),
            }),
          );
          return;
        }
        if (url.pathname === "/api/search") {
          const query = platformQuery(url, [
            "q",
            "projectId",
            "limit",
            "offset",
            "includeTitles",
            "kind",
            "kinds",
            "appIds",
            "sort",
          ]);
          json(
            res,
            200,
            await business.search({
              query: query.value("q") ?? "",
              projectId: query.value("projectId"),
              limit: query.number("limit"),
              offset: query.number("offset"),
              includeTitles: query.boolean("includeTitles"),
              kind: query.value("kind"),
              kinds: platformArrayQuery(query.value("kinds")),
              appIds: platformArrayQuery(query.value("appIds")),
              sort: query.value("sort"),
            }),
          );
          return;
        }
        const view =
          /^\/api\/application-view\/([a-z][a-z0-9.-]{2,80}@\d+\.\d+\.\d+)$/.exec(
            url.pathname.replace(/%40/gi, "@"),
          );
        if (view) {
          const html = await business.applicationView(view[1]);
          res.setHeader("Content-Security-Policy", applicationViewPolicy);
          res.setHeader("Permissions-Policy", applicationViewPermissions);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }
        const asset = /^\/api\/(assets|attachments)\/([a-f0-9]{64})$/.exec(
          url.pathname,
        );
        if (asset) {
          const attachment = asset[1] === "attachments";
          const query = platformQuery(
            url,
            attachment ? ["projectId", "conversationId", "inputId"] : [],
          );
          const source = url.searchParams.size
            ? {
                projectId: query.value("projectId"),
                conversationId: query.value("conversationId"),
                inputId: query.value("inputId"),
              }
            : undefined;
          const file = await business.asset(asset[2], attachment, source);
          res.writeHead(200, {
            "Content-Type": file.mime,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(file.bytes);
          return;
        }
        const platformStream =
          /^\/api\/platform\/projects\/([a-zA-Z0-9_-]+)\/conversations\/([a-zA-Z0-9_-]+)\/stream$/.exec(
            url.pathname,
          );
        if (platformStream) {
          platformQuery(url, []);
          let closed = false,
            dispose: (() => void) | undefined;
          let previous = new Map<string, string>(),
            connection: boolean | undefined;
          const close = () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            streams.delete(close);
            dispose?.();
            if (res.headersSent) res.end();
          };
          const heartbeat = setInterval(() => {
            if (!closed && res.headersSent) res.write(": keepalive\n\n");
          }, 1000);
          res.on("close", close);
          streams.add(close);
          const send = (value: ConversationStream) => {
            if (closed) return;
            if (!res.headersSent) {
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "X-Accel-Buffering": "no",
                Connection: "keep-alive",
              });
              res.flushHeaders();
            }
            const next = new Map(
              value.messages.map((m) => [m.id, JSON.stringify(m)]),
            );
            const messages = value.messages.filter(
                (m) => previous.get(m.id) !== next.get(m.id),
              ),
              removed = [...previous.keys()].filter((id) => !next.has(id));
            if (
              connection === value.connected &&
              !messages.length &&
              !removed.length
            )
              return;
            if (res.writableLength > 4 * 1024 * 1024) {
              close();
              return;
            }
            res.write(
              `data: ${JSON.stringify({ connected: value.connected, reset: connection === undefined, removed, messages })}\n\n`,
            );
            previous = next;
            connection = value.connected;
          };
          try {
            dispose = await business.observePlatformConversation(
              {
                projectId: platformStream[1],
                conversationId: platformStream[2],
              },
              send,
              close,
            );
            if (closed) dispose();
          } catch (error) {
            clearInterval(heartbeat);
            streams.delete(close);
            res.off("close", close);
            if (res.headersSent || res.writableEnded) {
              close();
              return;
            }
            throw error;
          }
          return;
        }
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        if (
          !req.headers.origin ||
          !origins.has(req.headers.origin) ||
          !applicationTokenMatches(req.headers, requestToken)
        ) {
          json(res, 403, {
            message: "请求验证已失效，请重新连接后再试。",
            code: "forbidden",
          });
          return;
        }
        const scriptEditor =
          /^\/api\/platform\/scripts\/editor\/(head|page|detail)$/.exec(
            url.pathname,
          );
        if (url.pathname === "/api/session-permissions/update")
          throw new DomainError(
            "forbidden",
            "审批方式只能由本机本人调整；团队与远端会话暂为只读。",
          );
        if (scriptEditor) {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          const raw = await jsonBody(req, 16 * 1024);
          json(
            res,
            200,
            scriptEditor[1] === "head"
              ? await business.readPlatformScriptEditorHead(raw)
              : scriptEditor[1] === "page"
                ? await business.readPlatformScriptEditorPage(raw)
                : await business.readPlatformScriptEditorDetail(raw),
          );
          return;
        }
        if (url.pathname === "/api/reader/ocr") {
          json(
            res,
            200,
            await business.readingOcr(await jsonBody(req, 32 * 1024)),
          );
          return;
        }
        if (url.pathname === "/api/reader/commands") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.commandPlatformReader(
              await jsonBody(req, 32 * 1024),
            ),
          );
          return;
        }
        if (url.pathname === "/api/bookmarks/commands") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.commandBookmark(await jsonBody(req, 16 * 1024)),
          );
          return;
        }
        if (url.pathname === "/api/platform/apps/install") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.installUiPackage(
              await jsonBody(req, 2 * 1024 * 1024),
            ),
          );
          return;
        }
        if (url.pathname.startsWith("/api/platform/app-views/")) {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          const command = await jsonBody(req, 80 * 1024);
          const action = url.pathname.slice("/api/platform/app-views/".length);
          const result =
            action === "launch"
              ? await business.launchPlatformAppView(command)
              : action === "save"
                ? await business.savePlatformAppView(command)
                : action === "close"
                  ? await business.closePlatformAppView(command)
                  : null;
          if (!result)
            throw new DomainError("not_found", "应用窗口操作不存在。");
          json(res, 200, result);
          return;
        }
        if (url.pathname === "/api/platform/messages") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            202,
            await business.platformMessage(await jsonBody(req, 1024 * 1024)),
          );
          return;
        }
        if (url.pathname === "/api/platform/conversations/update") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.updatePlatformConversation(
              await jsonBody(req, 16 * 1024),
            ),
          );
          return;
        }
        if (url.pathname === "/api/platform/objects/annotate") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.annotatePlatformObject(
              await jsonBody(req, 32 * 1024),
            ),
          );
          return;
        }
        if (url.pathname === "/api/platform/objects/rename") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.renamePlatformObject(await jsonBody(req, 16 * 1024)),
          );
          return;
        }
        if (
          url.pathname === "/api/platform/interactive/rows" ||
          url.pathname === "/api/platform/interactive/patch"
        ) {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          const payload = await jsonBody(
            req,
            url.pathname.endsWith("/rows") ? 16 * 1024 : 3 * 1024 * 1024,
          );
          json(
            res,
            200,
            url.pathname.endsWith("/rows")
              ? await business.queryPlatformInteractiveRows(payload)
              : await business.patchPlatformInteractiveRows(payload),
          );
          return;
        }
        if (
          url.pathname === "/api/platform/documents" ||
          url.pathname === "/api/platform/documents/import" ||
          url.pathname === "/api/platform/documents/revise" ||
          url.pathname === "/api/platform/images" ||
          url.pathname === "/api/platform/images/revise" ||
          url.pathname === "/api/platform/interactive" ||
          url.pathname === "/api/platform/interactive/revise"
        ) {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          const payload = await jsonBody(
            req,
            url.pathname === "/api/platform/documents/import"
              ? 9 * 1024 * 1024
              : 3 * 1024 * 1024,
          );
          json(
            res,
            200,
            url.pathname.startsWith("/api/platform/images")
              ? url.pathname.endsWith("/revise")
                ? await business.revisePlatformImage(payload)
                : await business.createPlatformImage(payload)
              : url.pathname.startsWith("/api/platform/interactive")
                ? url.pathname.endsWith("/revise")
                  ? await business.revisePlatformInteractive(payload)
                  : await business.createPlatformInteractive(payload)
                : url.pathname.endsWith("/import")
                  ? await business.importPlatformDocument(payload)
                  : url.pathname.endsWith("/revise")
                    ? await business.revisePlatformDocument(payload)
                    : await business.createPlatformDocument(payload),
          );
          return;
        }
        if (url.pathname === "/api/platform/scripts") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.createPlatformScript(await jsonBody(req, 16 * 1024)),
          );
          return;
        }
        if (url.pathname === "/api/platform/scripts/update") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.updatePlatformScript(await jsonBody(req, 32 * 1024)),
          );
          return;
        }
        if (url.pathname === "/api/platform/scripts/rename") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.renamePlatformScript(await jsonBody(req, 16 * 1024)),
          );
          return;
        }
        if (url.pathname === "/api/platform/scripts/items") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.createPlatformScriptItem(
              await jsonBody(req, 3 * 1024 * 1024),
            ),
          );
          return;
        }
        if (url.pathname === "/api/platform/scripts/items/revise") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.revisePlatformScriptItem(
              await jsonBody(req, 3 * 1024 * 1024),
            ),
          );
          return;
        }
        if (url.pathname === "/api/platform/scripts/items/restore") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.restorePlatformScriptItem(
              await jsonBody(req, 16 * 1024),
            ),
          );
          return;
        }
        if (url.pathname === "/api/platform/scripts/items/workflow") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.transitionPlatformScriptWorkflow(
              await jsonBody(req, 16 * 1024),
            ),
          );
          return;
        }
        if (url.pathname === "/api/platform/scripts/reviews") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.changePlatformScriptReview(
              await jsonBody(req, 32 * 1024),
            ),
          );
          return;
        }
        if (url.pathname === "/api/platform/scripts/candidates/decide") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.decidePlatformScriptCandidate(
              await jsonBody(req, 16 * 1024),
            ),
          );
          return;
        }
        if (url.pathname === "/api/platform/scripts/exports") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.recordPlatformScriptExport(
              await jsonBody(req, 256 * 1024),
            ),
          );
          return;
        }
        if (url.pathname === "/api/platform/spaces/ensure") {
          platformQuery(url, []);
          json(res, 200, await business.ensurePlatformSpaces());
          return;
        }
        if (
          url.pathname === "/api/platform/projects" ||
          url.pathname === "/api/platform/projects/rename" ||
          url.pathname === "/api/platform/projects/state" ||
          url.pathname === "/api/platform/tasks" ||
          url.pathname === "/api/platform/tasks/revise" ||
          url.pathname === "/api/platform/tasks/respond" ||
          url.pathname === "/api/platform/tasks/complete" ||
          url.pathname === "/api/platform/tasks/run-request" ||
          url.pathname === "/api/platform/tasks/reorder" ||
          url.pathname === "/api/platform/tasks/reorder-selection" ||
          url.pathname === "/api/platform/content/move" ||
          url.pathname === "/api/platform/content/move-new-project" ||
          url.pathname === "/api/platform/work/relations"
        ) {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          const payload = await jsonBody(
            req,
            url.pathname === "/api/platform/tasks/reorder-selection"
              ? 64 * 1024
              : 16 * 1024,
          );
          json(
            res,
            200,
            url.pathname === "/api/platform/tasks"
              ? await business.createPlatformTask(payload)
              : url.pathname === "/api/platform/tasks/revise"
                ? await business.revisePlatformTask(payload)
                : url.pathname === "/api/platform/tasks/respond"
                  ? await business.respondPlatformTask(payload)
                  : url.pathname === "/api/platform/tasks/complete"
                    ? await business.completePlatformTask(payload)
                    : url.pathname === "/api/platform/tasks/run-request"
                      ? await business.requestPlatformTaskRun(payload)
                      : url.pathname === "/api/platform/tasks/reorder"
                        ? await business.reorderPlatformTask(payload)
                        : url.pathname ===
                            "/api/platform/tasks/reorder-selection"
                          ? await business.reorderPlatformTaskSelection(payload)
                          : url.pathname === "/api/platform/content/move"
                            ? await business.movePlatformContent(payload)
                            : url.pathname ===
                                "/api/platform/content/move-new-project"
                              ? await business.createPlatformProjectForContent(
                                  payload,
                                )
                              : url.pathname === "/api/platform/work/relations"
                                ? await business.linkPlatformWork(payload)
                                : url.pathname ===
                                    "/api/platform/projects/state"
                                  ? await business.changePlatformProjectState(
                                      payload,
                                    )
                                  : url.pathname.endsWith("/rename")
                                    ? await business.renamePlatformProject(
                                        payload,
                                      )
                                    : await business.createPlatformProject(
                                        payload,
                                      ),
          );
          return;
        }
        if (url.pathname === "/api/identity/logout") {
          if (options.identity && authentication)
            await options.identity.logout(authentication.sessionHash);
          if (options.identity)
            res.setHeader(
              "Set-Cookie",
              [
                options.identity.cookieName,
                options.identity.legacyCookieName,
              ].map(
                (name) =>
                  `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${options.publicOrigin ? "; Secure" : ""}`,
              ),
            );
          json(res, 200, { disconnected: true });
          return;
        }
        if (
          ["/api/connection/check", "/api/connection/configure"].includes(
            url.pathname,
          )
        ) {
          const controller = new AbortController();
          const abort = () => {
            if (!res.writableEnded) controller.abort();
          };
          req.on("aborted", abort);
          res.on("close", abort);
          try {
            // HTTP callers may inspect, but never reconfigure a host's local credentials.
            if (url.pathname.endsWith("configure"))
              throw new DomainError(
                "forbidden",
                "请在本机 Morphz 中设置连接；远端中心请联系管理员。",
              );
            const result = await business.connectionDetails(controller.signal);
            if (!controller.signal.aborted)
              json(res, 200, {
                ...result,
                configurable: false,
                endpoint: undefined,
                version: undefined,
                modelSettingsAvailable: undefined,
              });
          } finally {
            req.off("aborted", abort);
            res.off("close", abort);
          }
          return;
        }
        if (url.pathname === "/api/notifications") {
          json(
            res,
            200,
            await business.controlNotifications(await jsonBody(req, 20000)),
          );
          return;
        }
        if (
          [
            "/api/speech/transcribe",
            "/api/speech/synthesize",
            "/api/speech/stream",
          ].includes(url.pathname)
        ) {
          const controller = new AbortController(),
            abort = () => {
              if (!res.writableEnded) controller.abort();
            };
          req.on("aborted", abort);
          res.on("close", abort);
          try {
            if (url.pathname.endsWith("stream")) {
              const result = await business.speechStream(
                await jsonBody(req, 40000),
                controller.signal,
              );
              if (!controller.signal.aborted) json(res, 200, result);
            } else if (url.pathname.endsWith("transcribe")) {
              if (req.headers["content-type"] !== "audio/wav")
                throw new DomainError("invalid", "需要 WAV 录音。");
              const result = await business.transcribe(
                {
                  scope: speechScope(req),
                  data: await body(req, maxSpeechSegmentBytes),
                },
                controller.signal,
              );
              if (!controller.signal.aborted) json(res, 200, result);
            } else {
              const data = z
                .object({ text: z.string() })
                .strict()
                .parse(await jsonBody(req, 16000));
              const wav = await business.synthesize(
                { scope: speechScope(req), text: data.text },
                controller.signal,
              );
              if (!controller.signal.aborted) {
                res.writeHead(200, { "Content-Type": "audio/wav" });
                res.end(wav);
              }
            }
          } finally {
            req.off("aborted", abort);
            res.off("close", abort);
          }
          return;
        }
        if (
          [
            "/api/browser/desktop/register",
            "/api/browser/desktop/exchange",
          ].includes(url.pathname)
        ) {
          json(
            res,
            200,
            await business.browserRegister(
              {
                key: req.headers["x-desktop-key"],
                data: await jsonBody(req, 500000),
              },
              url.pathname.endsWith("exchange"),
            ),
          );
          return;
        }
        if (
          url.pathname === "/api/import/pdf" ||
          url.pathname === "/api/import/reading"
        ) {
          json(
            res,
            201,
            await (
              url.pathname.endsWith("/reading")
                ? business.importReading.bind(business)
                : business.importPdf.bind(business)
            )({
              commandId: req.headers["x-command-id"],
              projectId: req.headers["x-project-id"],
              relativePath: decodeURIComponent(
                z.string().parse(req.headers["x-source-path"]),
              ),
              data: await body(
                req,
                url.pathname.endsWith("/reading")
                  ? maxReadingFileBytes
                  : maxPdfBytes,
              ),
            }),
          );
          return;
        }
        if (url.pathname === "/api/executions/control") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await business.executionControl(await jsonBody(req, 16384)),
          );
          return;
        }
        if (task) {
          const data = z
            .object({
              run: z.number(),
              revision: z.number(),
              action: z.string(),
            })
            .strict()
            .parse(await jsonBody(req, 4096));
          json(res, 200, await business.taskControl({ id: task[1], ...data }));
          return;
        }
        const input = /^\/api\/inputs\/([a-zA-Z0-9_-]+)\/(send|cancel)$/.exec(
          url.pathname,
        );
        if (input) {
          json(
            res,
            202,
            input[2] === "send"
              ? await business.sendInput(input[1])
              : await business.cancelInput(input[1]),
          );
          return;
        }
        if (url.pathname === "/api/attachments") {
          const name = decodeURIComponent(
            String(req.headers["x-file-name"] ?? "").slice(0, 1200),
          );
          json(
            res,
            201,
            await business.addAttachment({
              name,
              data: await body(req, maxMessageAttachmentBytes),
            }),
          );
          return;
        }
        if (url.pathname === "/api/assets") {
          json(
            res,
            201,
            await business.addAsset(await body(req, 6 * 1024 * 1024)),
          );
          return;
        }
        if (url.pathname === "/api/profile") {
          platformQuery(url, []);
          json(res, 200, await business.updateProfile(await jsonBody(req, 8192)));
          return;
        }
        if (url.pathname === "/api/profile/avatar/clear") {
          platformQuery(url, []);
          json(res, 200, await business.clearProfileAvatar(await jsonBody(req, 1024)));
          return;
        }
        if (url.pathname === "/api/profile/avatar") {
          const query = platformQuery(url, ["subject", "commandId", "expectedRevision"]);
          json(res, 200, await business.setProfileAvatar({ subject: query.value("subject"), commandId: query.value("commandId"), expectedRevision: query.number("expectedRevision"), data: await body(req, 4 * 1024 * 1024) }));
          return;
        }
      }
      if (url.pathname.startsWith("/api/")) {
        json(res, 404, { message: "接口不存在。" });
        return;
      }
      if (!["GET", "HEAD"].includes(req.method ?? "")) {
        json(res, 405, { message: "不支持这个方法。" });
        return;
      }
      const decoded = decodeURIComponent(url.pathname),
        target = resolve(
          options.webRoot,
          "." + (decoded === "/" ? "/index.html" : decoded),
        ),
        rel = relative(options.webRoot, target);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        json(res, 403, { message: "路径不可访问。" });
        return;
      }
      try {
        const info = await stat(target);
        if (!info.isFile()) throw new Error("not a file");
        const file = await readFile(target);
        res.writeHead(200, {
          "Content-Type":
            resourceMime[extname(target)] ?? "application/octet-stream",
        });
        res.end(req.method === "HEAD" ? undefined : file);
      } catch {
        json(res, 404, {
          message:
            "页面不存在。首次运行请先 npm run build，或使用 npm run dev。",
        });
      }
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        res.end();
        return;
      }
      const failure = applicationFailure(error);
      if (failure.status === 500)
        console.error(
          "Workspace request failed:",
          error instanceof Error ? error.message : "unknown error",
        );
      json(res, failure.status, {
        code: failure.code,
        message: failure.message,
      });
    }
  });
  return Object.assign(server, {
    closeStreams: () => {
      for (const close of streams) close();
      application.speechStreams.close();
    },
  });
}
import { applicationTokenMatches } from "../../../packages/core/src/application-names.js";
