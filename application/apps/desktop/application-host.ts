import { join, resolve, relative, isAbsolute, extname } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  mkdirSync,
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApplicationRequestError } from "../../packages/core/src/application-api.js";
import {
  Application,
  applicationFailure,
} from "../../packages/application/src/application.js";
import { LocalApplicationConnection } from "../../packages/application/src/local-connection.js";
import { WorkspaceStore } from "../../packages/application/src/store.js";
import { openApplicationDomainsHost } from "../../packages/application/src/application-domains-host.js";
import { cognitiveAppLaunchConfig } from "../../packages/application/src/cognitive-app-launch-config.js";
import {
  loadRuntimeConfig,
  RuntimeBridge,
} from "../../packages/application/src/runtime.js";
import { loadIdentity } from "../../packages/application/src/identity-config.js";
import {
  BrowserBroker,
  platformBrowserPageAuthority,
} from "../../packages/application/src/browser.js";
import { SpeechService } from "../../packages/application/src/speech.js";
import { LocalFiles } from "../../packages/application/src/local-files.js";
import { loadServiceEnvironment } from "../../packages/application/src/environment.js";
import {
  listenLocalHostTools,
  prepareLocalHostTools,
} from "../../packages/application/src/host-tools-ipc.js";
import { runtimeAgentTools } from "../../packages/application/src/agent-tools.js";
import { LocalRuntimeConnection } from "../../packages/application/src/runtime-connection.js";
import {
  ReaderOcr,
  type ReadingOcrEngine,
} from "../../packages/application/src/reader-ocr.js";
import {
  appContentSecurityPolicy,
  applicationViewPolicy,
  applicationViewPermissions,
  resourceMime,
} from "../../packages/core/src/resource-policy.js";
import {
  parseCognitiveAppViewResourceURL,
  parseCognitiveAppViewHtmlBytes,
  cognitiveAppViewResourceMime,
  type CognitiveAppViewResource,
  type CognitiveAppViewResourceRequest,
} from "../../packages/core/src/cognitive-app-view-resource.js";
import {
  parseCognitiveAppDocumentResourceURL,
  parseCognitiveAppDocumentHtmlBytes,
  cognitiveAppDocumentResourceMime,
  type CognitiveAppDocumentResource,
  type CognitiveAppDocumentResourceRequest,
} from "../../packages/core/src/cognitive-app-document-resource.js";
import { cognitiveDocumentBootstrapPolicy } from "../../packages/application/src/cognitive-document-bootstrap.js";

const authSchema = z
  .object({
    centerId: z.string().uuid(),
    cookie: z.string().max(200).optional(),
  })
  .strict();
function authenticationFile(profile: string, centerId: string) {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const file = join(profile, `local-session-${centerId}.json`);
  return {
    exists: () => existsSync(file),
    read(): string | undefined {
      if (!existsSync(file)) return;
      const info = lstatSync(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 1024 ||
        (process.platform !== "win32" && info.mode & 0o077)
      )
        throw new Error("本机身份文件权限无效；未重置既有登录。");
      const saved = authSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      if (saved.centerId !== centerId)
        throw new Error("本机身份文件不属于此工作区。");
      return saved.cookie;
    },
    save(cookie: string | undefined) {
      const temporary = file + "." + randomUUID();
      writeFileSync(temporary, JSON.stringify({ centerId, cookie }), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, file);
    },
  };
}

/** Opens the exact existing database in the desktop process. Does not spawn an application service. */
export async function openEmbeddedApplication(
  directory: string,
  profile: string,
  legacyAuthentication?: (cookieName: string) => Promise<string | undefined>,
  ocrEngine?: ReadingOcrEngine,
) {
  if (!isAbsolute(directory) || !isAbsolute(profile))
    throw new Error("应用目录必须是明确的绝对路径。");
  loadServiceEnvironment();
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"), {
    mode: "transport",
  });
  let runtime: RuntimeBridge | undefined;
  let tools: Awaited<ReturnType<typeof listenLocalHostTools>> | undefined;
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    const identity = await loadIdentity(store, directory);
    const config = loadRuntimeConfig(directory);
    runtime = config ? new RuntimeBridge(store, config, identity) : undefined;
    const readerOcr = new ReaderOcr(
      join(directory, "reader-ocr-models"),
      ocrEngine,
    );
    const localFiles = new LocalFiles(
      join(profile, "local-file-references.json"),
      store.identity(),
    );
    domains = await openApplicationDomainsHost(directory, store, identity, {
      cognitiveApps: cognitiveAppLaunchConfig(),
    });
    const browser = new BrowserBroker(
      store,
      platformBrowserPageAuthority(domains),
    );
    const bookmarkAgent = runtime
      ? domains.bindRuntime(runtime, localFiles)
      : undefined;
    let taskDispatcher = bookmarkAgent?.dispatcher;
    const application = new Application(store, {
      runtime,
      identity,
      browser,
      speech: new SpeechService(process.env.DOUBAO_API_KEY),
      localFiles,
      readerOcr,
      bookmarkDomain: domains.browser,
      platformWork: domains.work,
      platformDocuments: domains.content,
      platformScripts: domains.content,
      platformReader: domains.reader,
      messageAttachments: domains.messageAttachments,
      images: domains.images,
      profiles: domains.profiles,
      workspaceChanges: domains.workspaceChanges,
      uiPackages: domains.uiPackages,
      cognitiveApps: domains.cognitiveApps,
      notifications: domains.notifications,
      platformTaskRuns: domains.taskRuns(runtime),
    });
    const authentication = authenticationFile(profile, store.identity());
    let cookie = authentication.read();
    if (identity && !authentication.exists() && legacyAuthentication) {
      const previous =
        (await legacyAuthentication(identity.cookieName)) ??
        (await legacyAuthentication(identity.legacyCookieName));
      if (await identity.authenticateShared(previous)) {
        cookie = previous;
        authentication.save(cookie);
      }
    }
    if (identity && cookie && !(await identity.authenticateShared(cookie))) {
      cookie = undefined;
      authentication.save(undefined);
    }
    const connection = new LocalApplicationConnection(application, cookie);
    let manifest = config
      ? prepareLocalHostTools(
          directory,
          config.namespace,
          runtime!.teamIdentity,
        )
      : undefined;
    if (runtime && manifest && bookmarkAgent)
      tools = await listenLocalHostTools(
        manifest.endpoint,
        runtimeAgentTools(
          runtime,
          manifest.token,
          {
            authority: bookmarkAgent.authority,
            work: domains.work.service,
            content: domains.content,
            profile: domains.profiles.service,
            reader: domains.reader.service,
            cognitiveApps: domains.cognitiveApps.service,
          },
          {
            browser: browser,
            localFiles: localFiles,
            readerOcr: readerOcr,
            bookmarkDomain: bookmarkAgent,
          },
        ),
      );
    if (!identity)
      application.options.connectionSetup = new LocalRuntimeConnection(
        directory,
        store,
        async (next) => {
          if (runtime) {
            const current = runtime;
            current.validateConnection(next);
            return {
              commit: () => current.updateConnection(next),
              discard: async () => {},
            };
          }
          const candidate = new RuntimeBridge(store, next, undefined, false);
          const prepared = prepareLocalHostTools(
            directory,
            next.namespace,
            false,
          );
          const candidateBookmarks = domains!.bindRuntime(
            candidate,
            localFiles,
          );
          let listener;
          try {
            listener = await listenLocalHostTools(
              prepared.endpoint,
              runtimeAgentTools(
                candidate,
                prepared.token,
                {
                  authority: candidateBookmarks.authority,
                  work: domains!.work.service,
                  content: domains!.content,
                  profile: domains!.profiles.service,
                  reader: domains!.reader.service,
                  cognitiveApps: domains!.cognitiveApps.service,
                },
                {
                  browser: browser,
                  localFiles: localFiles,
                  readerOcr: readerOcr,
                  bookmarkDomain: candidateBookmarks,
                },
              ),
            );
          } catch (error) {
            await domains!.unbindRuntime(candidateBookmarks.authority);
            await candidate.stop();
            throw error;
          }
          return {
            commit() {
              runtime = candidate;
              tools = listener;
              manifest = prepared;
              application.options.runtime = candidate;
              application.options.platformTaskRuns =
                domains!.taskRuns(candidate);
              taskDispatcher = candidateBookmarks.dispatcher;
              candidate.start();
              taskDispatcher.start();
            },
            async discard() {
              await listener.close();
              await domains!.unbindRuntime(candidateBookmarks.authority);
              await candidate.stop();
            },
          };
        },
      );
    runtime?.start();
    taskDispatcher?.start();
    let stopping: Promise<void> | undefined;
    return {
      connection,
      localFiles,
      get manifestPath() {
        return manifest?.path;
      },
      persistAuthentication() {
        authentication.save(connection.authenticationCookie());
      },
      close() {
        return (stopping ??= (async () => {
          connection.close();
          readerOcr.close();
          application.speechStreams.close();
          await tools?.close();
          await taskDispatcher?.stop();
          await runtime?.stop();
          await domains?.close();
          store.close();
        })());
      },
    };
  } catch (error) {
    await tools?.close();
    await runtime?.stop();
    await domains?.close();
    store.close();
    throw error;
  }
}

/** Read-only custom-scheme resources. Dynamic mutations exist only on the restricted bridge. */
export function embeddedResources(
  webRoot: string,
  connection: {
    cognitiveAppDocumentResource?(
      request: CognitiveAppDocumentResourceRequest,
      signal?: AbortSignal,
    ): CognitiveAppDocumentResource | Promise<CognitiveAppDocumentResource>;
    cognitiveAppViewResource?(
      request: CognitiveAppViewResourceRequest,
      signal?: AbortSignal,
    ): CognitiveAppViewResource | Promise<CognitiveAppViewResource>;
    resource(
      kind: "assets" | "attachments" | "application-view",
      id: string,
      source?: { projectId: string; conversationId: string; inputId: string },
    ):
      | { mime: string; bytes: Uint8Array }
      | Promise<{ mime: string; bytes: Uint8Array }>;
    readerOriginalMetadata?(
      artifactId: string,
      revision: number,
    ): Promise<{ byteLength: number; sha256: string }>;
    readerOriginalRange?(
      artifactId: string,
      revision: number,
      start: number,
      endExclusive: number,
      expectedSha256?: string,
    ): Promise<Uint8Array>;
  },
) {
  const handle = async (request: Request): Promise<Response> => {
    const headers = {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Content-Security-Policy": appContentSecurityPolicy,
      "Cross-Origin-Resource-Policy": "same-origin",
    };
    try {
      const url = new URL(request.url);
      if (
        url.protocol !== "morphz:" ||
        url.host !== "app" ||
        url.username ||
        url.password
      )
        return new Response("Forbidden", { status: 403, headers });
      if (!["GET", "HEAD"].includes(request.method))
        return new Response("Method not allowed", { status: 405, headers });
      let cognitiveDocument;
      try {
        cognitiveDocument = parseCognitiveAppDocumentResourceURL(url);
      } catch {
        throw new ApplicationRequestError(400, "界面资源请求无效。", "invalid");
      }
      if (cognitiveDocument) {
        if (request.signal.aborted)
          throw new ApplicationRequestError(
            408,
            "界面资源读取已取消。",
            "cancelled",
          );
        if (!connection.cognitiveAppDocumentResource)
          throw new ApplicationRequestError(
            503,
            "界面资源尚不可用。",
            "unavailable",
          );
        const resource = await connection.cognitiveAppDocumentResource(
          cognitiveDocument,
          request.signal,
        );
        if (request.signal.aborted)
          throw new ApplicationRequestError(
            408,
            "界面资源读取已取消。",
            "cancelled",
          );
        if (resource.mime !== cognitiveAppDocumentResourceMime)
          throw new ApplicationRequestError(
            502,
            "界面资源不符合固定契约。",
            "contract",
          );
        let bytes;
        try {
          bytes = parseCognitiveAppDocumentHtmlBytes(resource.bytes);
        } catch {
          throw new ApplicationRequestError(
            502,
            "界面资源不符合固定契约。",
            "contract",
          );
        }
        return new Response(
          request.method === "HEAD" ? null : new Uint8Array(bytes),
          {
            headers: {
              ...headers,
              "Content-Type": cognitiveAppDocumentResourceMime,
              "Content-Length": String(bytes.byteLength),
              "Content-Security-Policy": cognitiveDocumentBootstrapPolicy,
              "Permissions-Policy": applicationViewPermissions,
            },
          },
        );
      }
      let cognitiveView;
      try {
        cognitiveView = parseCognitiveAppViewResourceURL(url);
      } catch {
        throw new ApplicationRequestError(400, "界面资源请求无效。", "invalid");
      }
      if (cognitiveView) {
        if (request.signal.aborted)
          throw new ApplicationRequestError(
            408,
            "界面资源读取已取消。",
            "cancelled",
          );
        if (!connection.cognitiveAppViewResource)
          throw new ApplicationRequestError(
            503,
            "界面资源尚不可用。",
            "unavailable",
          );
        const resource = await connection.cognitiveAppViewResource(
          cognitiveView,
          request.signal,
        );
        if (request.signal.aborted)
          throw new ApplicationRequestError(
            408,
            "界面资源读取已取消。",
            "cancelled",
          );
        if (resource.mime !== cognitiveAppViewResourceMime)
          throw new ApplicationRequestError(
            502,
            "界面资源不符合固定契约。",
            "contract",
          );
        let bytes;
        try {
          bytes = parseCognitiveAppViewHtmlBytes(resource.bytes);
        } catch {
          throw new ApplicationRequestError(
            502,
            "界面资源不符合固定契约。",
            "contract",
          );
        }
        return new Response(
          request.method === "HEAD" ? null : new Uint8Array(bytes),
          {
            headers: {
              ...headers,
              "Content-Type": cognitiveAppViewResourceMime,
              "Content-Length": String(bytes.byteLength),
              "Content-Security-Policy": applicationViewPolicy,
              "Permissions-Policy": applicationViewPermissions,
            },
          },
        );
      }
      if (url.pathname === "/api/reader/original") {
        const artifactId = url.searchParams.get("artifactId");
        const revisionText = url.searchParams.get("revision");
        const revision = Number(revisionText);
        if (
          [...url.searchParams.keys()].length !== 2 ||
          !artifactId ||
          !revisionText ||
          !/^[1-9]\d*$/.test(revisionText) ||
          !Number.isSafeInteger(revision)
        )
          return new Response("Invalid PDF source", { status: 400, headers });
        if (
          !connection.readerOriginalMetadata ||
          !connection.readerOriginalRange
        )
          return new Response("PDF source unavailable", {
            status: 503,
            headers,
          });
        const original = await connection.readerOriginalMetadata(
          artifactId,
          revision,
        );
        const size = original.byteLength;
        const range = request.headers.get("range");
        const match = range === null ? null : /^bytes=(\d+)-(\d*)$/.exec(range);
        const start = match ? Number(match[1]) : 0;
        const inclusiveEnd =
          match && match[2] !== "" ? Number(match[2]) : size - 1;
        if (
          range !== null &&
          (!match ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(inclusiveEnd) ||
            start >= size ||
            inclusiveEnd < start)
        )
          return new Response(null, {
            status: 416,
            headers: { ...headers, "Content-Range": `bytes */${size}` },
          });
        const end = Math.min(inclusiveEnd + 1, size);
        let offset = start;
        const body =
          request.method === "HEAD"
            ? null
            : new ReadableStream<Uint8Array>({
                async pull(controller) {
                  try {
                    if (request.signal.aborted)
                      throw (
                        request.signal.reason ?? new Error("PDF 读取已取消。")
                      );
                    if (offset >= end) {
                      controller.close();
                      return;
                    }
                    const next = Math.min(offset + 1024 * 1024, end);
                    const bytes = await connection.readerOriginalRange!(
                      artifactId,
                      revision,
                      offset,
                      next,
                      original.sha256,
                    );
                    if (bytes.byteLength !== next - offset)
                      throw new Error("PDF 原件分块长度不匹配。");
                    offset = next;
                    controller.enqueue(new Uint8Array(bytes));
                  } catch (error) {
                    controller.error(error);
                  }
                },
              });
        return new Response(body, {
          status: match ? 206 : 200,
          headers: {
            ...headers,
            "Content-Type": "application/pdf",
            "Content-Length": String(end - start),
            "Accept-Ranges": "bytes",
            ETag: `"${original.sha256}"`,
            ...(match
              ? { "Content-Range": `bytes ${start}-${end - 1}/${size}` }
              : {}),
          },
        });
      }
      const resource =
        /^\/api\/(assets|attachments|application-view)\/([a-zA-Z0-9._@-]+)$/.exec(
          url.pathname.replace(/%40/gi, "@"),
        );
      if (resource) {
        const kind = resource[1] as
          "assets" | "attachments" | "application-view";
        const keys = [...url.searchParams.keys()];
        if (
          keys.length &&
          (kind !== "attachments" ||
            keys.length !== 3 ||
            !["projectId", "conversationId", "inputId"].every((key) =>
              url.searchParams.get(key),
            ))
        )
          return new Response("Invalid resource source", {
            status: 400,
            headers,
          });
        const source = keys.length
          ? {
              projectId: url.searchParams.get("projectId")!,
              conversationId: url.searchParams.get("conversationId")!,
              inputId: url.searchParams.get("inputId")!,
            }
          : undefined;
        const file = await connection.resource(kind, resource[2]!, source);
        return new Response(
          request.method === "HEAD" ? null : new Uint8Array(file.bytes),
          {
            headers: {
              ...headers,
              "Content-Type": file.mime,
              ...(kind === "application-view"
                ? {
                    "Content-Security-Policy": applicationViewPolicy,
                    "Permissions-Policy": applicationViewPermissions,
                  }
                : {}),
            },
          },
        );
      }
      if (url.pathname.startsWith("/api/"))
        return new Response("Not found", { status: 404, headers });
      const root = await realpath(webRoot);
      const target = resolve(
        root,
        "." +
          decodeURIComponent(
            url.pathname === "/" ? "/index.html" : url.pathname,
          ),
      );
      const inside = (path: string) => {
        const rel = relative(root, path);
        return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
      };
      if (
        !inside(target) ||
        !inside(await realpath(target)) ||
        !(await stat(target)).isFile()
      )
        return new Response("Forbidden", { status: 403, headers });
      return new Response(
        request.method === "HEAD"
          ? null
          : new Uint8Array(await readFile(target)),
        {
          headers: {
            ...headers,
            "Content-Type":
              resourceMime[extname(target)] ?? "application/octet-stream",
          },
        },
      );
    } catch (error) {
      const failure =
        error instanceof ApplicationRequestError
          ? {
              status: error.status,
              code: "remote_error",
              message: error.message,
            }
          : applicationFailure(error);
      return Response.json(
        { message: failure.message, code: failure.code },
        {
          status:
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? 404
              : failure.status,
          headers,
        },
      );
    }
  };
  // Electron's custom protocol does not apply Node HTTP's automatic HEAD
  // body suppression. Enforce it once at the carrier boundary, including
  // early refusals and safe JSON failures; authorization and GET stay intact.
  return async (request: Request): Promise<Response> => {
    const response = await handle(request);
    return request.method === "HEAD"
      ? new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      : response;
  };
}
