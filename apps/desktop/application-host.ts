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
import {
  loadRuntimeConfig,
  RuntimeBridge,
} from "../../packages/application/src/runtime.js";
import { loadIdentity } from "../../packages/application/src/identity-config.js";
import { BrowserBroker } from "../../packages/application/src/browser.js";
import { SpeechService } from "../../packages/application/src/speech.js";
import { loadServiceEnvironment } from "../../packages/application/src/environment.js";
import {
  listenLocalHostTools,
  prepareLocalHostTools,
} from "../../packages/application/src/host-tools-ipc.js";
import { runtimeAgentTools } from "../../packages/application/src/agent-tools.js";
import {
  appContentSecurityPolicy,
  applicationViewPolicy,
  applicationViewPermissions,
  resourceMime,
} from "../../packages/core/src/resource-policy.js";

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
) {
  if (!isAbsolute(directory) || !isAbsolute(profile))
    throw new Error("应用目录必须是明确的绝对路径。");
  loadServiceEnvironment();
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let runtime: RuntimeBridge | undefined;
  let tools: Awaited<ReturnType<typeof listenLocalHostTools>> | undefined;
  try {
    const identity = loadIdentity(store, directory);
    const config = loadRuntimeConfig(directory);
    runtime = config ? new RuntimeBridge(store, config, identity) : undefined;
    const browser = new BrowserBroker(store);
    runtime?.attachBrowser(browser);
    const application = new Application(store, {
      runtime,
      identity,
      browser,
      speech: new SpeechService(process.env.DOUBAO_API_KEY),
    });
    const authentication = authenticationFile(profile, store.identity());
    let cookie = authentication.read();
    if (identity && !authentication.exists() && legacyAuthentication) {
      const previous = await legacyAuthentication(identity.cookieName);
      if (identity.authenticate(previous)) {
        cookie = previous;
        authentication.save(cookie);
      }
    }
    const connection = new LocalApplicationConnection(application, cookie);
    const manifest = config
      ? prepareLocalHostTools(
          directory,
          config.namespace,
          runtime!.teamIdentity,
        )
      : undefined;
    if (runtime && manifest)
      tools = await listenLocalHostTools(
        manifest.endpoint,
        runtimeAgentTools(store, runtime, manifest.token, browser),
      );
    runtime?.start();
    let stopping: Promise<void> | undefined;
    return {
      connection,
      manifestPath: manifest?.path,
      persistAuthentication() {
        authentication.save(connection.authenticationCookie());
      },
      close() {
        return (stopping ??= (async () => {
          connection.close();
          await tools?.close();
          await runtime?.stop();
          store.close();
        })());
      },
    };
  } catch (error) {
    await tools?.close();
    await runtime?.stop();
    store.close();
    throw error;
  }
}

/** Read-only custom-scheme resources. Dynamic mutations exist only on the restricted bridge. */
export function embeddedResources(
  webRoot: string,
  connection: {
    resource(
      kind: "assets" | "attachments" | "application-view",
      id: string,
    ):
      | { mime: string; bytes: Uint8Array }
      | Promise<{ mime: string; bytes: Uint8Array }>;
  },
) {
  return async (request: Request): Promise<Response> => {
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
      const resource =
        /^\/api\/(assets|attachments|application-view)\/([a-zA-Z0-9_-]+)$/.exec(
          url.pathname,
        );
      if (resource) {
        const kind = resource[1] as
          "assets" | "attachments" | "application-view";
        const file = await connection.resource(kind, resource[2]!);
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
}
