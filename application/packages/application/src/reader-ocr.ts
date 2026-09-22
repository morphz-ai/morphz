import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  bookmarkOwner,
  checkProject,
  DomainError,
  getArtifact,
  type AccessContext,
} from "../../core/src/model.js";
import { assertProjectWritable } from "../../core/src/projects.js";
import { readArtifact } from "../../core/src/retrieval.js";
import {
  ocrEngine,
  ocrResultSchema,
  orderOcr,
  readerOcrRequestSchema,
  type ReaderOcrStatus,
  type ReaderOcrRequest,
} from "../../core/src/reader-ocr.js";
import type { WorkspaceStore } from "./store.js";

const origin =
  "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/";
export const readingOcrModels = [
  {
    name: "PP-OCRv6_small_det",
    size: 9_891_840,
    sha256: "d218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4",
  },
  {
    name: "PP-OCRv6_small_rec",
    size: 21_319_680,
    sha256: "d267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1",
  },
] as const;
export type ReadingOcrEngine = (
  request: { pdf: Uint8Array; page: number; models: Uint8Array[] },
  signal: AbortSignal,
) => Promise<unknown>;
type Job = {
  owner: string;
  binding: string;
  request: Extract<ReaderOcrRequest, { operation: "start" }>;
  state: ReaderOcrStatus["state"];
  abort: AbortController;
  sectionId?: string;
  message?: string;
};

/** A single page, explicit local model installation. No document is sent to a network service. */
export class ReaderOcr {
  private jobs = new Map<string, Job>();
  private installed: boolean | undefined;
  private running = false;
  constructor(
    private store: WorkspaceStore,
    private directory: string,
    private engine?: ReadingOcrEngine,
    private fetcher: typeof fetch = fetch,
  ) {}
  private modelPath(model: (typeof readingOcrModels)[number]) {
    return join(this.directory, `${model.sha256}.tar`);
  }
  private async cached() {
    const models: Uint8Array[] = [];
    for (const model of readingOcrModels) {
      try {
        const info = await lstat(this.modelPath(model));
        if (!info.isFile() || info.size !== model.size) {
          this.installed = false;
          return null;
        }
        const bytes = await readFile(this.modelPath(model));
        if (
          bytes.length !== model.size ||
          createHash("sha256").update(bytes).digest("hex") !== model.sha256
        ) {
          this.installed = false;
          return null;
        }
        models.push(bytes);
      } catch {
        this.installed = false;
        return null;
      }
    }
    this.installed = true;
    return models;
  }
  private async models(download: boolean, signal: AbortSignal) {
    const cached = await this.cached();
    if (cached) return cached;
    if (!download)
      throw new DomainError(
        "invalid",
        "请先在阅读器确认下载约 31 MB 的本地 OCR 模型；不会上传书籍。",
      );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const models: Uint8Array[] = [];
    for (const model of readingOcrModels) {
      signal.throwIfAborted();
      const response = await this.fetcher(
        `${origin}${model.name}_onnx_infer.tar`,
        {
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          redirect: "error",
          credentials: "omit",
        },
      );
      if (!response.ok || !response.body)
        throw new Error("下载模型失败，请检查网络后重试。");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > model.size) {
          await response.body.cancel().catch(() => {});
          throw new Error("模型大小与固定版本不符，已拒绝加载。");
        }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (
        size !== model.size ||
        createHash("sha256").update(bytes).digest("hex") !== model.sha256
      )
        throw new Error("模型完整性校验失败，已拒绝加载。");
      signal.throwIfAborted();
      const temporary = this.modelPath(model) + "." + randomUUID();
      try {
        await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
        await rename(temporary, this.modelPath(model));
      } finally {
        await unlink(temporary).catch(() => {});
      }
      models.push(bytes);
    }
    this.installed = true;
    return models;
  }
  private authorize(
    request: ReaderOcrRequest,
    access: AccessContext,
    inputId?: string,
  ) {
    const state = this.store.snapshot(),
      owner = bookmarkOwner(state, access, inputId),
      artifact = getArtifact(state, request.artifactId);
    const project = checkProject(state, artifact.projectId, access),
      input = state.inputs.find((i) => i.id === inputId);
    if (
      !project.members.includes(owner) ||
      (inputId && input?.projectId !== project.id)
    )
      throw new DomainError(
        "forbidden",
        "OCR 不能越出发起用户和实际输入的授权范围。",
      );
    const version = readArtifact(state, artifact.id, access, request.revision);
    if (
      version.content.kind !== "pdf" ||
      version.content.pages[request.page - 1] === undefined
    )
      throw new DomainError("invalid", "请选择存在的 PDF 页面。");
    return { owner, artifact, project, assetId: version.content.assetId };
  }
  async call(
    raw: unknown,
    access: AccessContext,
    inputId?: string,
  ): Promise<ReaderOcrStatus> {
    const request = readerOcrRequestSchema.parse(raw),
      allowed = this.authorize(request, access, inputId);
    this.installed ??= !!(await this.cached());
    const base = {
      available: !!this.engine,
      installed: this.installed,
      downloadBytes: readingOcrModels.reduce((s, m) => s + m.size, 0),
    };
    const binding = JSON.stringify([
      request.artifactId,
      request.revision,
      request.page,
    ]);
    if (request.operation === "correct") {
      assertProjectWritable(allowed.project);
      const source = this.store.readerSection(
        request.artifactId,
        request.revision,
        request.sectionId,
        access,
      );
      if (
        !source.ocr ||
        !request.sectionId.startsWith(`page-${request.page}-ocr-`) ||
        !source.ocr.items[request.line]
      )
        throw new DomainError("invalid", "识别文字位置不存在。");
      const result = structuredClone(source.ocr);
      result.items[request.line]!.correction = request.text;
      result.parent = request.sectionId;
      return {
        ...base,
        state: "complete",
        sectionId: this.store.saveReadingOcr(
          request.artifactId,
          request.revision,
          request.page,
          result,
          access,
        ),
      };
    }
    const previous = request.jobId ? this.jobs.get(request.jobId) : undefined;
    if (
      previous &&
      (previous.owner !== allowed.owner || previous.binding !== binding)
    )
      throw new DomainError("forbidden", "OCR 任务不属于当前读物或身份。");
    if (request.operation === "cancel") {
      if (!previous)
        throw new DomainError("not_found", "OCR 任务已结束或应用已重启。");
      previous.abort.abort();
      if (["loading", "recognizing"].includes(previous.state))
        previous.state = "cancelled";
    }
    if (
      request.operation === "start" &&
      previous &&
      JSON.stringify(previous.request) !== JSON.stringify(request)
    )
      throw new DomainError("conflict", "重试标识已用于不同的 OCR 请求。");
    if (request.operation !== "start" || previous) {
      return {
        ...base,
        state: previous?.state ?? "idle",
        jobId: request.jobId,
        sectionId:
          previous?.sectionId ??
          (request.jobId
            ? undefined
            : this.store.latestReadingOcr(
                request.artifactId,
                request.revision,
                request.page,
                access,
              )),
        message: previous?.message,
      };
    }
    assertProjectWritable(allowed.project);
    if (!this.engine)
      throw new DomainError(
        "invalid",
        "当前连接未提供本地 OCR 引擎，请在本机 Morphz Desktop 中使用。",
      );
    if (inputId && request.download)
      throw new DomainError(
        "forbidden",
        "下载模型需要用户在阅读器明确确认；Agent 不能代替确认。",
      );
    const saved = this.store.latestReadingOcr(
      request.artifactId,
      request.revision,
      request.page,
      access,
    );
    if (saved && !request.force) {
      const prior = this.store.readerSection(
        request.artifactId,
        request.revision,
        saved,
        access,
      );
      if (
        prior.ocr?.layout === request.layout &&
        prior.ocr.engine === ocrEngine
      )
        return { ...base, state: "complete", sectionId: saved };
    }
    if (this.running)
      throw new DomainError(
        "conflict",
        "正在识别另一页，请等待完成或取消后重试。",
      );
    if (!base.installed && !request.download)
      throw new DomainError(
        "invalid",
        "请先在阅读器确认下载约 31 MB 的本地 OCR 模型；不会上传书籍。",
      );
    // Keep only bounded task statuses. Persisted source versions remain in SQLite.
    if (this.jobs.size >= 128) this.jobs.delete(this.jobs.keys().next().value!);
    const job: Job = {
      owner: allowed.owner,
      binding,
      request,
      state: "loading",
      abort: new AbortController(),
    };
    this.jobs.set(request.jobId, job);
    this.running = true;
    void (async () => {
      try {
        const models = await this.models(request.download, job.abort.signal);
        job.abort.signal.throwIfAborted();
        this.authorize(request, access, inputId);
        const pdf = this.store.asset(allowed.assetId);
        if (!pdf) throw new DomainError("not_found", "PDF 原文件不存在。");
        job.state = "recognizing";
        const result = ocrResultSchema.parse(
          await this.engine!(
            { pdf: pdf.bytes, page: request.page, models },
            job.abort.signal,
          ),
        );
        job.abort.signal.throwIfAborted();
        assertProjectWritable(this.authorize(request, access, inputId).project);
        job.sectionId = this.store.saveReadingOcr(
          request.artifactId,
          request.revision,
          request.page,
          {
            ...orderOcr(result, request.layout),
            engine: ocrEngine,
            layout: request.layout,
          },
          access,
        );
        job.state = "complete";
      } catch (e) {
        job.state = job.abort.signal.aborted ? "cancelled" : "failed";
        job.message = job.abort.signal.aborted
          ? "已取消，原页与已有标注未改动。"
          : e instanceof DomainError
            ? e.message
            : "本地 OCR 未完成，请重试或继续阅读原页；未上传文档。";
      } finally {
        // Cancellation must finish tearing down its isolated engine before
        // another page starts, even though the UI already says cancelled.
        this.running = false;
      }
    })();
    return { ...base, state: job.state, jobId: request.jobId };
  }
  close() {
    for (const job of this.jobs.values()) job.abort.abort();
  }
}
