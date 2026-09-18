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
import { maxSpeechSegmentBytes } from "../../../packages/core/src/audio.js";
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
        const secret = options.identity.login(
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
      const authentication = options.identity?.authenticate(req.headers.cookie);
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
          message: "请连接中心，或重新验证已失效的身份。",
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
      if (req.method === "GET") {
        if (url.pathname === "/api/health") {
          json(res, 200, {
            application: "morphz",
            protocol: 1,
            runtimeConnected: options.runtime?.snapshot().connected ?? false,
          });
          return;
        }
        if (url.pathname === "/api/workspace") {
          const boot = business.workspace(requestToken),
            etag = `"workspace-${boot.workspace.revision}-${requestToken.slice(0, 8)}"`;
          res.setHeader("ETag", etag);
          if (req.headers["if-none-match"] === etag) {
            res.writeHead(304);
            res.end();
            return;
          }
          json(res, 200, boot);
          return;
        }
        if (url.pathname === "/api/notifications") {
          json(res, 200, business.notifications());
          return;
        }
        if (url.pathname === "/api/speech/status") {
          json(res, 200, business.speechStatus());
          return;
        }
        if (task) {
          json(res, 200, business.taskSnapshot(task[1]));
          return;
        }
        if (url.pathname === "/api/models") {
          json(res, 200, await business.models());
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
          json(
            res,
            200,
            business.search({
              query: url.searchParams.get("q") ?? "",
              ...(url.searchParams.has("projectId")
                ? { projectId: url.searchParams.get("projectId") }
                : {}),
              limit: Number(url.searchParams.get("limit") ?? 20),
              offset: Number(url.searchParams.get("offset") ?? 0),
            }),
          );
          return;
        }
        const artifact = /^\/api\/artifacts\/([a-zA-Z0-9_-]+)$/.exec(
          url.pathname,
        );
        if (artifact) {
          json(
            res,
            200,
            business.artifact({
              id: artifact[1],
              ...(url.searchParams.has("revision")
                ? { revision: Number(url.searchParams.get("revision")) }
                : {}),
            }),
          );
          return;
        }
        const view = /^\/api\/application-view\/([a-zA-Z0-9_-]+)$/.exec(
          url.pathname,
        );
        if (view) {
          const html = business.applicationView(view[1]);
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
          const file = business.asset(asset[2], asset[1] === "attachments");
          res.writeHead(200, {
            "Content-Type": file.mime,
            "Cache-Control": "private, no-store",
          });
          res.end(file.bytes);
          return;
        }
        if (url.pathname === "/api/conversation/stream") {
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
            dispose = business.observeConversation(
              Object.fromEntries(url.searchParams),
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
        if (url.pathname === "/api/identity/logout") {
          if (options.identity && authentication)
            options.identity.logout(authentication.sessionHash);
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
        if (url.pathname === "/api/notifications") {
          json(
            res,
            200,
            business.controlNotifications(await jsonBody(req, 20000)),
          );
          return;
        }
        if (
          ["/api/speech/transcribe", "/api/speech/synthesize"].includes(
            url.pathname,
          )
        ) {
          const controller = new AbortController(),
            abort = () => {
              if (!res.writableEnded) controller.abort();
            };
          req.on("aborted", abort);
          res.on("close", abort);
          try {
            if (url.pathname.endsWith("transcribe")) {
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
            business.browserRegister(
              {
                key: req.headers["x-desktop-key"],
                data: await jsonBody(req, 500000),
              },
              url.pathname.endsWith("exchange"),
            ),
          );
          return;
        }
        if (url.pathname === "/api/import/pdf") {
          json(
            res,
            201,
            await business.importPdf({
              commandId: req.headers["x-command-id"],
              projectId: req.headers["x-project-id"],
              relativePath: decodeURIComponent(
                z.string().parse(req.headers["x-source-path"]),
              ),
              data: await body(req, maxPdfBytes),
            }),
          );
          return;
        }
        if (
          [
            "/api/executions/control",
            "/api/commands",
            "/api/messages",
          ].includes(url.pathname)
        ) {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          if (url.pathname === "/api/executions/control") {
            json(
              res,
              200,
              await business.executionControl(await jsonBody(req, 16384)),
            );
            return;
          }
          const message = url.pathname === "/api/messages";
          const command = await jsonBody(
            req,
            message ? 1024 * 1024 : 16 * 1024 * 1024,
          );
          json(
            res,
            message ? 202 : 200,
            await (message
              ? business.message(command)
              : business.command(command)),
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
              ? business.sendInput(input[1])
              : business.cancelInput(input[1]),
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
            business.addAttachment({
              name,
              data: await body(req, 20 * 1024 * 1024),
            }),
          );
          return;
        }
        if (url.pathname === "/api/assets") {
          json(res, 201, business.addAsset(await body(req, 6 * 1024 * 1024)));
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
    },
  });
}
import { applicationTokenMatches } from "../../../packages/core/src/application-names.js";
