import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  applicationMethods,
  ApplicationRequestError,
  type ApplicationReply,
  type ApplicationMethod,
  type ApplicationCallOptions,
} from "../../packages/core/src/application-api.js";
import { HttpApplicationClient } from "../../packages/core/src/http-application-client.js";
import {
  conversationFrameSchema,
  type ConversationStream,
} from "../../packages/core/src/live-conversation.js";
import { applicationFailure } from "../../packages/application/src/application.js";
import { maxReadingFileBytes } from "../../packages/core/src/reader.js";

const requestSchema = z
  .object({
    id: z.string().uuid(),
    method: z.enum(applicationMethods),
    params: z.unknown().optional(),
    identityGeneration: z.string().max(128).optional(),
  })
  .strict();

/** Explicit remote connection. It never opens or copies the local database. */
export class RemoteApplicationConnection {
  private client: HttpApplicationClient;
  private generation = "";
  private epoch = 0;
  private closed = false;
  private identityTransition = false;
  private requests = new Map<string, AbortController>();
  private streams = new Map<string, AbortController>();
  constructor(
    private origin: string,
    private request: typeof fetch,
  ) {
    this.client = new HttpApplicationClient(origin, request);
  }
  async call(
    method: ApplicationMethod,
    params?: unknown,
    options: ApplicationCallOptions = {},
  ) {
    options.signal?.throwIfAborted();
    const id = randomUUID(),
      abort = () => this.cancel(id);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const reply = await this.invoke({
        id,
        method,
        params,
        identityGeneration: options.identityGeneration,
      });
      options.signal?.throwIfAborted();
      if (!reply.ok)
        throw new ApplicationRequestError(
          reply.error.status,
          reply.error.message,
        );
      return reply.value;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }
  async invoke(raw: unknown): Promise<ApplicationReply> {
    let id: string | undefined;
    let changingIdentity = false;
    try {
      this.assertOpen();
      const request = requestSchema.parse(raw);
      if (this.identityTransition)
        throw new ApplicationRequestError(409, "身份正在切换，请稍后重试。");
      if (this.requests.size >= 64 || this.requests.has(request.id))
        throw new ApplicationRequestError(400, "请求过多或标识重复。");
      if (
        !["platform.bootstrap", "login"].includes(request.method) &&
        (!request.identityGeneration ||
          request.identityGeneration !== this.generation)
      )
        throw new ApplicationRequestError(403, "身份已切换，操作未发送。");
      changingIdentity = ["login", "logout"].includes(request.method);
      if (changingIdentity) {
        this.identityTransition = true;
        this.invalidate();
      }
      const epoch = this.epoch;
      id = request.id;
      const controller = new AbortController();
      this.requests.set(id, controller);
      const result = await this.client.call(request.method, request.params, {
        identityGeneration: request.identityGeneration,
        signal: controller.signal,
      });
      if (epoch !== this.epoch || controller.signal.aborted)
        throw new ApplicationRequestError(
          408,
          "连接已改变；已提交的操作不会回滚。",
        );
      if (request.method === "platform.bootstrap")
        this.generation = z
          .object({ csrfToken: z.string() })
          .parse(result).csrfToken;
      if (["login", "logout"].includes(request.method)) this.invalidate();
      return { ok: true, value: result };
    } catch (error) {
      return {
        ok: false,
        error:
          id && this.requests.get(id)?.signal.aborted
            ? {
                status: 408,
                code: "cancelled",
                message: "请求已取消；已提交的操作不会回滚。",
              }
            : error instanceof ApplicationRequestError
              ? {
                  status: error.status,
                  code: "remote_error",
                  message: error.message,
                }
              : applicationFailure(error),
      };
    } finally {
      if (id) this.requests.delete(id);
      if (changingIdentity) this.identityTransition = false;
    }
  }
  cancel(id: unknown) {
    if (typeof id === "string") this.requests.get(id)?.abort();
  }
  async resource(
    kind: "assets" | "attachments" | "application-view",
    id: string,
    source?: { projectId: string; conversationId: string; inputId: string },
  ) {
    this.assertOpen();
    if (this.identityTransition)
      throw new ApplicationRequestError(409, "身份正在切换。");
    if (
      !["assets", "attachments", "application-view"].includes(kind) ||
      !(kind === "application-view"
        ? /^[a-z][a-z0-9.-]{2,80}@\d+\.\d+\.\d+$/.test(id)
        : /^[a-zA-Z0-9_-]{1,200}$/.test(id))
    )
      throw new ApplicationRequestError(400, "资源标识无效。");
    if (this.requests.size >= 64)
      throw new ApplicationRequestError(400, "请求过多。");
    const epoch = this.epoch;
    const requestId = randomUUID(),
      controller = new AbortController();
    this.requests.set(requestId, controller);
    const timeout = setTimeout(() => controller.abort(), 30000);
    const limit = 24 * 1024 * 1024;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const resourceURL = new URL(`/api/${kind}/${id}`, this.origin);
      if (source) {
        if (kind !== "attachments")
          throw new ApplicationRequestError(400, "资源来源参数无效。");
        resourceURL.search = new URLSearchParams(source).toString();
      }
      const response = await this.request(resourceURL.toString(), {
        credentials: "include",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok)
        throw new ApplicationRequestError(
          response.status,
          "资源不存在或已无访问权限。",
        );
      if (Number(response.headers.get("content-length")) > limit) {
        await response.body?.cancel();
        throw new ApplicationRequestError(413, "资源超过大小限制。");
      }
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (epoch !== this.epoch || controller.signal.aborted)
            throw new ApplicationRequestError(
              403,
              "连接身份已变化或读取已取消。",
            );
          if (done) break;
          size += value.byteLength;
          if (size > limit)
            throw new ApplicationRequestError(413, "资源超过大小限制。");
          chunks.push(value);
        }
      if (epoch !== this.epoch || controller.signal.aborted)
        throw new ApplicationRequestError(403, "连接身份已变化或读取已取消。");
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        mime:
          response.headers.get("content-type") ?? "application/octet-stream",
        bytes,
      };
    } finally {
      clearTimeout(timeout);
      await reader?.cancel().catch(() => {});
      controller.abort();
      this.requests.delete(requestId);
    }
  }
  private async withReaderOriginalRange<T>(
    artifactId: string,
    revision: number,
    start: number,
    endExclusive: number,
    use: (
      response: Response,
      metadata: { byteLength: number; sha256: string },
      assertActive: () => void,
    ) => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    if (this.identityTransition)
      throw new ApplicationRequestError(409, "身份正在切换。");
    if (
      !/^[a-zA-Z0-9_-]{1,200}$/.test(artifactId) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(endExclusive) ||
      start < 0 ||
      endExclusive <= start ||
      endExclusive - start > 1024 * 1024
    )
      throw new ApplicationRequestError(400, "PDF 原件读取范围无效。");
    if (this.requests.size >= 64)
      throw new ApplicationRequestError(400, "请求过多。");
    const epoch = this.epoch;
    const requestId = randomUUID();
    const controller = new AbortController();
    this.requests.set(requestId, controller);
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response: Response | undefined;
    const assertActive = () => {
      this.assertOpen();
      if (epoch !== this.epoch || controller.signal.aborted)
        throw new ApplicationRequestError(403, "连接身份已变化或读取已取消。");
    };
    try {
      const url = new URL("/api/reader/original", this.origin);
      url.search = new URLSearchParams({
        artifactId,
        revision: String(revision),
      }).toString();
      response = await this.request(url.toString(), {
        credentials: "include",
        redirect: "error",
        headers: { Range: `bytes=${start}-${endExclusive - 1}` },
        signal: controller.signal,
      });
      assertActive();
      if (response.status !== 206)
        throw new ApplicationRequestError(
          response.status,
          "PDF 原件不存在或已无访问权限。",
        );
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
        response.headers.get("content-range") ?? "",
      );
      const sha = /^"([a-f0-9]{64})"$/.exec(response.headers.get("etag") ?? "");
      const byteLength = Number(range?.[3]);
      if (
        response.headers.get("content-type") !== "application/pdf" ||
        !range ||
        !sha ||
        Number(range[1]) !== start ||
        Number(range[2]) !== endExclusive - 1 ||
        !Number.isSafeInteger(byteLength) ||
        byteLength < endExclusive ||
        byteLength > maxReadingFileBytes ||
        Number(response.headers.get("content-length")) !== endExclusive - start
      )
        throw new ApplicationRequestError(502, "远端 PDF 原件响应无效。");
      return await use(response, { byteLength, sha256: sha[1]! }, assertActive);
    } finally {
      clearTimeout(timeout);
      try {
        await response?.body?.cancel();
      } catch {}
      controller.abort();
      this.requests.delete(requestId);
    }
  }
  readerOriginalMetadata(artifactId: string, revision: number) {
    return this.withReaderOriginalRange(
      artifactId,
      revision,
      0,
      1,
      async (_response, metadata) => metadata,
    );
  }
  readerOriginalRange(
    artifactId: string,
    revision: number,
    start: number,
    endExclusive: number,
    expectedSha256?: string,
  ) {
    return this.withReaderOriginalRange(
      artifactId,
      revision,
      start,
      endExclusive,
      async (response, metadata, assertActive) => {
        if (expectedSha256 && metadata.sha256 !== expectedSha256)
          throw new ApplicationRequestError(502, "PDF 原件版本已变化。");
        const reader = response.body?.getReader();
        if (!reader)
          throw new ApplicationRequestError(502, "远端 PDF 原件没有字节流。");
        const bytes = new Uint8Array(endExclusive - start);
        let offset = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            assertActive();
            if (done) break;
            if (offset + value.byteLength > bytes.byteLength)
              throw new ApplicationRequestError(502, "远端 PDF 分块超出范围。");
            bytes.set(value, offset);
            offset += value.byteLength;
          }
          if (offset !== bytes.byteLength)
            throw new ApplicationRequestError(502, "远端 PDF 分块不完整。");
          return bytes;
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      },
    );
  }
  async observe(
    rawId: unknown,
    rawScope: unknown,
    generation: unknown,
    emit: (value: ConversationStream) => void,
    close: () => void,
  ) {
    this.assertOpen();
    const id = z.string().uuid().parse(rawId),
      platform = z
        .object({
          kind: z.literal("platform"),
          projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
          conversationId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
        })
        .strict()
        .parse(rawScope);
    if (
      this.identityTransition ||
      !generation ||
      generation !== this.generation ||
      this.streams.size >= 32 ||
      this.streams.has(id)
    )
      throw new ApplicationRequestError(403, "订阅身份已失效或订阅过多。");
    const controller = new AbortController(),
      epoch = this.epoch;
    this.streams.set(id, controller);
    const finish = () => {
      if (this.streams.get(id) === controller) {
        this.streams.delete(id);
        close();
      }
    };
    const run = async () => {
      const streamPath = `/api/platform/projects/${encodeURIComponent(platform.projectId)}/conversations/${encodeURIComponent(platform.conversationId)}/stream`;
      const response = await this.request(this.origin + streamPath, {
        credentials: "include",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("远端订阅不可用。");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      const messages = new Map<
        string,
        ConversationStream["messages"][number]
      >();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (epoch !== this.epoch || controller.signal.aborted) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 4 * 1024 * 1024)
            throw new Error("远端订阅超过大小限制。");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => line.slice(6))
              .join("\n");
            if (!data) continue;
            const parsed = conversationFrameSchema.parse(JSON.parse(data));
            if (parsed.reset) messages.clear();
            for (const id of parsed.removed) messages.delete(id);
            for (const message of parsed.messages)
              messages.set(message.id, message);
            emit({
              connected: parsed.connected,
              messages: [...messages.values()],
            });
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    };
    void run()
      .catch(() => {})
      .finally(finish);
  }
  unobserve(id: unknown) {
    if (typeof id === "string") {
      this.streams.get(id)?.abort();
      this.streams.delete(id);
    }
  }
  invalidate() {
    this.epoch++;
    this.generation = "";
    for (const request of this.requests.values()) request.abort();
    for (const stream of this.streams.values()) stream.abort();
    this.streams.clear();
  }
  close() {
    this.closed = true;
    this.invalidate();
  }
  private assertOpen() {
    if (this.closed) throw new ApplicationRequestError(408, "远端连接已关闭。");
  }
}
