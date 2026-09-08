import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname } from "node:path";
import { ZodError } from "zod";
import {
  DomainError,
  localAccess as localIdentity,
  commandSchema,
  checkProject,
  applicationFor,
} from "../../../packages/core/src/model.js";
import { z } from "zod";
import { extractPdf } from "./pdf.js";
import { pdfImportIssue, maxPdfBytes } from "../../../packages/core/src/pdf.js";
import { disconnectedRuntime } from "../../../packages/core/src/conversation.js";
import type { RuntimeBridge } from "./runtime.js";
import type { WorkspaceStore } from "./store.js";
import type { AgentTools } from "./agent-tools.js";
import {
  executionScopeSchema,
  executionControlSchema,
} from "../../../packages/core/src/execution.js";
import { readArtifact } from "../../../packages/core/src/retrieval.js";
import type { BrowserBroker } from "./browser.js";
import { type SpeechService, ttsRequestSchema } from "./speech.js";
import { IdentityCenter, workspaceFor, requiresIdentity } from "./identity.js";
import { Notifications } from "./notifications.js";
import {
  maxSpeechSegmentSeconds,
  maxSpeechSegmentBytes,
} from "../../../packages/core/src/audio.js";
const csp =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; font-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
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
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
export function createAppServer(
  store: WorkspaceStore,
  options: {
    port: number;
    webRoot: string;
    devOrigin?: string;
    runtime?: RuntimeBridge;
    agentTools?: AgentTools;
    browser?: BrowserBroker;
    speech?: SpeechService;
    identity?: IdentityCenter;
  },
) {
  if (!options.identity && requiresIdentity(store))
    throw new Error("此中心已启用身份认证，不能在缺失身份配置时启动。");
  if (options.identity && options.runtime && !options.runtime.teamIdentity)
    throw new Error(
      "多人中心需要 trusted_gateway Runtime 连接，不能使用单用户管理令牌。",
    );
  if (!options.identity && options.runtime?.teamIdentity)
    throw new Error("trusted_gateway 连接必须启用中心身份认证。");
  const token = randomBytes(32).toString("hex");
  const notifications = new Notifications(store);
  const origins = new Set([
    `http://127.0.0.1:${options.port}`,
    `http://localhost:${options.port}`,
    ...(options.devOrigin ? [options.devOrigin] : []),
  ]);
  const hosts = new Set([...origins].map((origin) => new URL(origin).host));
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", csp);
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
          .parse(JSON.parse((await body(req, 1024)).toString()));
        const session = options.identity.login(
          data.token,
          req.socket.remoteAddress ?? "unknown",
        );
        res.setHeader(
          "Set-Cookie",
          `${options.identity.cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
        );
        json(res, 200, { connected: true });
        return;
      }
      const authentication = options.identity?.authenticate(req.headers.cookie),
        localAccess = authentication?.access ?? localIdentity,
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
      if (req.method === "GET" && url.pathname === "/api/notifications") {
        // This is after the universal /api authentication gate above. Keep a
        // second explicit check here: never fall back to local-owner in team mode.
        if (options.identity && !authentication) {
          json(res, 401, { message: "需要登录中心。" });
          return;
        }
        assertIdentity();
        json(
          res,
          200,
          notifications.snapshot(authentication?.access ?? localIdentity),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/speech/status") {
        json(res, 200, {
          configured: options.speech?.configured() ?? false,
          provider: "doubao",
          segmentSeconds: maxSpeechSegmentSeconds,
        });
        return;
      }
      const taskRuntime = /^\/api\/tasks\/([a-zA-Z0-9_-]+)\/runtime$/.exec(
        url.pathname,
      );
      if (req.method === "GET" && taskRuntime) {
        readArtifact(store.snapshot(), taskRuntime[1]!, localAccess);
        json(
          res,
          200,
          options.runtime?.collaboration.snapshot(taskRuntime[1]!) ?? {
            runs: [],
          },
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/host-tools/call") {
        // Server-to-server only. A renderer's CSRF token is not a tool credential.
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
            await options.agentTools.call(
              JSON.parse((await body(req, 4 * 1024 * 1024)).toString()),
            ),
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
      if (req.method === "GET" && url.pathname === "/api/health") {
        json(res, 200, {
          application: "morphzwork",
          protocol: 1,
          runtimeConnected: options.runtime?.snapshot().connected ?? false,
        });
        return;
      }
      if (
        req.method === "GET" &&
        ["/api/executions", "/api/executions/result"].includes(url.pathname)
      ) {
        if (!options.runtime) {
          json(res, 503, { message: "尚未连接 Morphz Runtime。" });
          return;
        }
        const scope = executionScopeSchema.parse({
          projectId: url.searchParams.get("projectId"),
          artifactId: url.searchParams.get("artifactId") || null,
        });
        const jobId = url.searchParams.get("jobId");
        checkProject(store.snapshot(), scope.projectId, localAccess);
        if (url.pathname.endsWith("/result")) {
          if (!jobId || !/^[a-zA-Z0-9_-]{1,200}$/.test(jobId))
            throw new DomainError("invalid", "执行标识无效。");
          json(
            res,
            200,
            await options.runtime.as(localAccess, () =>
              options.runtime!.executions.result(scope, jobId),
            ),
          );
        } else
          json(
            res,
            200,
            await options.runtime.as(localAccess, () =>
              options.runtime!.executions.snapshot(scope),
            ),
          );
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/search") {
        json(
          res,
          200,
          store.search(
            {
              query: url.searchParams.get("q") ?? "",
              ...(url.searchParams.has("projectId")
                ? { projectId: url.searchParams.get("projectId")! }
                : {}),
              limit: Number(url.searchParams.get("limit") ?? 20),
              offset: Number(url.searchParams.get("offset") ?? 0),
            },
            localAccess,
          ),
        );
        return;
      }
      const artifactRead = /^\/api\/artifacts\/([a-zA-Z0-9_-]+)$/.exec(
        url.pathname,
      );
      if (req.method === "GET" && artifactRead) {
        const revision = url.searchParams.has("revision")
          ? Number(url.searchParams.get("revision"))
          : undefined;
        if (
          revision !== undefined &&
          (!Number.isInteger(revision) || revision < 1)
        )
          throw new DomainError("invalid", "对象版本无效。");
        json(
          res,
          200,
          readArtifact(
            store.snapshot(),
            artifactRead[1]!,
            localAccess,
            revision,
          ),
        );
        return;
      }
      const appView = /^\/api\/application-view\/([a-zA-Z0-9_-]+)$/.exec(
        url.pathname,
      );
      if (req.method === "GET" && appView) {
        const state = store.snapshot();
        const instance = state.applicationInstances.find(
          (i) => i.id === appView[1] && i.status === "open",
        );
        if (!instance) throw new DomainError("not_found", "应用已关闭。");
        checkProject(state, instance.workspaceId, localAccess);
        const manifest = applicationFor(
          state,
          instance.applicationId,
          instance.applicationVersion,
        );
        if (manifest.ui.type !== "sandbox")
          throw new DomainError("invalid", "不是独立应用界面。");
        res.setHeader(
          "Content-Security-Policy",
          "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        );
        res.setHeader(
          "Permissions-Policy",
          "camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), clipboard-write=()",
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(manifest.ui.html);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/workspace") {
        const workspace = workspaceFor(store.snapshot(), localAccess),
          etag = `"workspace-${workspace.revision}-${requestToken.slice(0, 8)}"`;
        res.setHeader("ETag", etag);
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304);
          res.end();
          return;
        }
        json(res, 200, {
          workspace,
          centerId: store.identity(),
          csrfToken: requestToken,
          principalId: localAccess.principalId,
          actantId: localAccess.actantId,
          capabilities: {
            runtime: options.runtime?.snapshot().connected ?? false,
            teamAuthentication: !!options.identity,
          },
          runtime:
            options.runtime?.snapshot(localAccess) ?? disconnectedRuntime,
        });
        return;
      }
      if (
        req.method === "GET" &&
        /^\/api\/assets\/[a-f0-9]{64}$/.test(url.pathname)
      ) {
        const asset = store.visibleAsset(
          url.pathname.split("/").at(-1)!,
          localAccess,
        );
        if (!asset) {
          json(res, 404, { message: "文件不存在。" });
          return;
        }
        res.writeHead(200, { "Content-Type": asset.mime });
        res.end(asset.bytes);
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        if (
          !req.headers.origin ||
          !origins.has(req.headers.origin) ||
          req.headers["x-morphzwork-token"] !== requestToken
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
              `${options.identity.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
            );
          json(res, 200, { disconnected: true });
          return;
        }
        if (url.pathname === "/api/notifications") {
          // POST also passed the Origin and per-session CSRF checks above.
          if (options.identity && !authentication) {
            json(res, 401, { message: "需要登录中心。" });
            return;
          }
          const command = JSON.parse((await body(req, 20000)).toString());
          assertIdentity();
          json(
            res,
            200,
            notifications.control(
              authentication?.access ?? localIdentity,
              command,
            ),
          );
          return;
        }
        if (
          ["/api/speech/transcribe", "/api/speech/synthesize"].includes(
            url.pathname,
          )
        ) {
          if (!options.speech)
            throw new DomainError("invalid", "语音服务尚未配置。");
          const projectId = z
            .string()
            .min(1)
            .max(100)
            .parse(req.headers["x-project-id"]);
          checkProject(store.snapshot(), projectId, localAccess);
          const artifactId = req.headers["x-artifact-id"];
          if (artifactId) {
            const value = readArtifact(
              store.snapshot(),
              z.string().parse(artifactId),
              localAccess,
              z.coerce
                .number()
                .int()
                .positive()
                .parse(req.headers["x-artifact-revision"]),
            );
            if (value.projectId !== projectId)
              throw new DomainError("forbidden", "对象不属于当前项目。");
          }
          const controller = new AbortController();
          const abort = () => {
            if (!res.writableEnded) controller.abort();
          };
          req.on("aborted", abort);
          res.on("close", abort);
          try {
            if (url.pathname.endsWith("transcribe")) {
              if (req.headers["content-type"] !== "audio/wav")
                throw new DomainError("invalid", "需要 WAV 录音。");
              const bytes = await body(req, maxSpeechSegmentBytes);
              assertIdentity();
              checkProject(store.snapshot(), projectId, localAccess);
              const text = await options.speech.transcribe(
                localAccess.principalId,
                bytes,
                controller.signal,
              );
              assertIdentity();
              if (!controller.signal.aborted) json(res, 200, { text });
            } else {
              const { text } = ttsRequestSchema.parse(
                JSON.parse((await body(req, 16000)).toString()),
              );
              assertIdentity();
              checkProject(store.snapshot(), projectId, localAccess);
              const wav = await options.speech.synthesize(
                localAccess.principalId,
                text,
                controller.signal,
              );
              assertIdentity();
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
          url.pathname === "/api/browser/desktop/register" ||
          url.pathname === "/api/browser/desktop/exchange"
        ) {
          if (!options.browser)
            throw new DomainError("invalid", "浏览器通道尚未启用。");
          const key = z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(req.headers["x-desktop-key"]);
          const data = JSON.parse((await body(req, 500000)).toString());
          json(
            res,
            200,
            url.pathname.endsWith("register")
              ? options.browser.register(data, key, localAccess)
              : options.browser.exchange(data, key, localAccess),
          );
          return;
        }
        if (url.pathname === "/api/import/pdf") {
          const commandId = z.uuid().parse(req.headers["x-command-id"]);
          const projectId = z
            .string()
            .min(1)
            .max(100)
            .parse(req.headers["x-project-id"]);
          const relativePath = decodeURIComponent(
            z.string().min(1).max(4000).parse(req.headers["x-source-path"]),
          );
          checkProject(store.snapshot(), projectId, localAccess);
          const issue = pdfImportIssue(relativePath);
          if (issue) throw new DomainError("invalid", issue);
          const bytes = await body(req, maxPdfBytes);
          const pages = await extractPdf(bytes);
          assertIdentity();
          const content = store.addPdf(bytes, pages, localAccess);
          json(
            res,
            201,
            store.execute(
              {
                commandId,
                operation: {
                  type: "import-pdf",
                  projectId,
                  relativePath,
                  content,
                },
              },
              localAccess,
            ),
          );
          return;
        }
        if (url.pathname === "/api/executions/control") {
          if (!options.runtime) {
            json(res, 503, { message: "尚未连接 Morphz Runtime。" });
            return;
          }
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          json(
            res,
            200,
            await options.runtime.as(localAccess, async () => {
              const control = executionControlSchema.parse(
                JSON.parse((await body(req, 16384)).toString()),
              );
              assertIdentity();
              checkProject(
                store.snapshot(),
                control.scope.projectId,
                localAccess,
              );
              return options.runtime!.executions.control(control);
            }),
          );
          return;
        }
        if (taskRuntime) {
          if (!options.runtime)
            throw new DomainError("invalid", "尚未连接 Runtime。");
          const control = z
            .object({
              run: z.number().int().positive(),
              revision: z.number().int().positive(),
              action: z.enum(["pause", "resume", "cancel"]),
            })
            .strict()
            .parse(JSON.parse((await body(req, 4096)).toString()));
          assertIdentity();
          readArtifact(store.snapshot(), taskRuntime[1]!, localAccess);
          json(
            res,
            200,
            await options.runtime.as(localAccess, () =>
              options.runtime!.collaboration.control(
                taskRuntime[1]!,
                control.run,
                control.revision,
                control.action,
              ),
            ),
          );
          return;
        }
        if (url.pathname === "/api/commands") {
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          const command = JSON.parse(
            (await body(req, 16 * 1024 * 1024)).toString(),
          );
          assertIdentity();
          json(res, 200, store.execute(command, localAccess));
          return;
        }
        if (url.pathname === "/api/messages") {
          if (!options.runtime) {
            json(res, 503, { message: "请先连接 Morphz Runtime。" });
            return;
          }
          if (req.headers["content-type"] !== "application/json") {
            json(res, 415, { message: "需要 JSON 请求。" });
            return;
          }
          const command = commandSchema.parse(
            JSON.parse((await body(req, 1024 * 1024)).toString()),
          );
          if (command.operation.type !== "record-input")
            throw new DomainError("invalid", "消息入口只接受输入。");
          assertIdentity();
          const receipt = store.execute(command, localAccess);
          options.runtime.as(localAccess, () =>
            options.runtime!.enqueue(receipt.entityId),
          );
          json(res, 202, receipt);
          return;
        }
        const retry = /^\/api\/inputs\/([a-zA-Z0-9_-]+)\/send$/.exec(
          url.pathname,
        );
        const cancel = /^\/api\/inputs\/([a-zA-Z0-9_-]+)\/cancel$/.exec(
          url.pathname,
        );
        if (cancel) {
          if (!options.runtime)
            throw new DomainError("invalid", "尚未连接 Runtime。");
          options.runtime.as(localAccess, () =>
            options.runtime!.cancelInput(cancel[1]!),
          );
          json(res, 202, { accepted: true });
          return;
        }
        if (retry) {
          if (!options.runtime) {
            json(res, 503, { message: "请先连接 Morphz Runtime。" });
            return;
          }
          options.runtime.as(localAccess, () =>
            options.runtime!.enqueue(retry[1]!),
          );
          json(res, 202, { accepted: true });
          return;
        }
        if (url.pathname === "/api/assets") {
          const bytes = await body(req, 6 * 1024 * 1024);
          assertIdentity();
          json(res, 201, store.addAsset(bytes, localAccess));
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
        );
      const rel = relative(options.webRoot, target);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        json(res, 403, { message: "路径不可访问。" });
        return;
      }
      try {
        const info = await stat(target);
        if (!info.isFile()) throw new Error("not a file");
        const file = await readFile(target),
          mime: Record<string, string> = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".mjs": "text/javascript; charset=utf-8",
            ".wasm": "application/wasm",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".woff2": "font/woff2",
          };
        res.writeHead(200, {
          "Content-Type": mime[extname(target)] ?? "application/octet-stream",
        });
        res.end(req.method === "HEAD" ? undefined : file);
      } catch {
        json(res, 404, {
          message:
            "页面不存在。首次运行请先 npm run build，或使用 npm run dev。",
        });
      }
    } catch (error) {
      if (error instanceof DomainError)
        json(
          res,
          { not_found: 404, forbidden: 403, conflict: 409, invalid: 400 }[
            error.code
          ],
          { code: error.code, message: error.message },
        );
      else if (
        error instanceof ZodError ||
        error instanceof SyntaxError ||
        error instanceof URIError
      )
        json(res, 400, { code: "invalid", message: "请求格式无效。" });
      else {
        console.error(
          "Workspace request failed:",
          error instanceof Error ? error.message : "unknown error",
        );
        json(res, 500, {
          code: "storage_error",
          message: "保存失败。内容尚未确认写入，请保留草稿后重试。",
        });
      }
    }
  });
}
