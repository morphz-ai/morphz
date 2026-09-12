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

/** HTTP is one adapter for logical application calls, used by Web and remote Desktop. */
export class HttpApplicationClient {
  private etag = "";
  private workspace: unknown;
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
      this.etag = "";
      this.workspace = undefined;
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
      case "workspace":
        path = "/api/workspace";
        if (this.etag) headers["If-None-Match"] = this.etag;
        break;
      case "login":
        path = "/api/identity/login";
        post(params);
        break;
      case "logout":
        path = "/api/identity/logout";
        post();
        break;
      case "command":
        path = "/api/commands";
        post(params);
        break;
      case "message":
        path = "/api/messages";
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
          });
        break;
      }
      case "artifact.read": {
        const p = fields(params);
        path =
          `/api/artifacts/${encodeURIComponent(String(p.id))}?` +
          query({ revision: p.revision });
        break;
      }
      case "models":
        path = "/api/models";
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
      case "pdf.import": {
        const p = fields(params);
        path = "/api/import/pdf";
        post();
        headers["X-Command-Id"] = String(p.commandId);
        headers["X-Project-Id"] = String(p.projectId);
        headers["X-Source-Path"] = encodeURIComponent(String(p.relativePath));
        data = binary(p.data);
        break;
      }
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
      case "task.control": {
        const { id, ...control } = fields(params);
        path = `/api/tasks/${encodeURIComponent(String(id))}/runtime`;
        post(control);
        break;
      }
      case "speech.status":
        path = "/api/speech/status";
        break;
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
    if (options.identityGeneration)
      headers["X-MorphzWork-Token"] = options.identityGeneration;
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
    if (
      response.status === 304 &&
      method === "workspace" &&
      this.workspace !== undefined
    )
      return this.workspace;
    if (!response.ok) {
      let message = "请求失败。";
      try {
        const failure = await response.json();
        if (typeof failure?.message === "string") message = failure.message;
      } catch {}
      if (epoch !== this.epoch)
        throw new ApplicationRequestError(408, "身份已切换，旧响应已丢弃。");
      throw new ApplicationRequestError(response.status, message);
    }
    const value: unknown = wav
      ? new Uint8Array(await response.arrayBuffer())
      : await response.json();
    if (epoch !== this.epoch)
      throw new ApplicationRequestError(408, "身份已切换，旧响应已丢弃。");
    if (method === "workspace") {
      this.workspace = value;
      this.etag = response.headers.get("etag") ?? "";
    }
    if (method === "login" || method === "logout") {
      this.workspace = undefined;
      this.etag = "";
    }
    return value;
  }
}
