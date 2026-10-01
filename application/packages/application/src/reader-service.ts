import { createHash } from "node:crypto";
import type {
  PlatformActor,
  ApplicationProviderRoute,
  PlatformAuthorityVerifier,
  PlatformStore,
} from "../../platform/src/store.js";
import type { ObjectsStore } from "../../objects/src/store.js";
import type { ManagedArtifactStore } from "../../managed-artifact-store/src/store.js";
import {
  ReaderStore,
  readerBookEventId,
  type ReaderAuthorityVerifier,
  type ReaderDomainAction,
  type ReaderOriginal,
  type ReaderSourceImport,
  type ReaderBookCommit,
} from "../../reader/src/store.js";
import type { ReaderCommand, ReadingInput } from "../../core/src/reader.js";
import { maxReadingFileBytes } from "../../core/src/reader.js";
import type { ReadingOcr } from "../../core/src/reader-ocr.js";
import { parsePublication, safeReadingSection } from "./reader-import.js";
import { extractPdf } from "./pdf.js";
import { contentIdForAppObject } from "./content-id.js";
import { readerParserIdentity } from "./reader-parser-identity.js";

/** Reader borrows an exact Objects original; it owns only the derived reading
 * source and each person's marks/position. A current Platform permission is
 * checked on every read and write, including idempotent command retries.
 */
export function platformReaderAuthority(request: {
  platform: PlatformStore;
  objects: ObjectsStore;
  objectsInstanceId: string;
  readerInstanceId: string;
  objectsProvider: () => ApplicationProviderRoute;
  readerProvider: () => ApplicationProviderRoute;
  originalStore: ManagedArtifactStore;
  originalStoreId: string;
  verifier: PlatformAuthorityVerifier;
}): ReaderAuthorityVerifier {
  const checkOriginal = (original: ReaderOriginal) => {
    if (
      !/^[1-9]\d*$/.test(original.versionRef) ||
      !Number.isSafeInteger(Number(original.versionRef)) ||
      !(
        (original.appId === "morphz.objects" &&
          original.instanceId === request.objectsInstanceId) ||
        (original.appId === "morphz.reader" &&
          original.instanceId === request.readerInstanceId)
      )
    )
      throw new Error("阅读来源不是受支持的文档原件。");
    return Number(original.versionRef);
  };
  return {
    async resolveActor({ credential }) {
      const actor = await request.verifier.resolveActor({ credential });
      return (
        actor && {
          tenantId: actor.tenantId,
          principalId: actor.principalId,
          kind: actor.kind,
          inputId: actor.runtimeInputId,
        }
      );
    },
    async verifyOriginal(original) {
      const revision = checkOriginal(original);
      if (original.appId === "morphz.reader") return;
      await request.objects.verifyDocumentVersion({
        tenantId: original.tenantId,
        objectId: original.objectId,
        revision,
      });
    },
    async verifyBookCreate(commit) {
      const identity = await request.platform.authorizeContentProject(
        { credential: commit.credential },
        request.readerInstanceId,
        "morphz.reader",
        commit.projectId,
        request.readerProvider(),
      );
      if (
        identity.tenantId !== commit.tenantId ||
        identity.principalId !== commit.principalId ||
        identity.actantId !== commit.actantId ||
        identity.runtimeInputId !== commit.runtimeInputId ||
        identity.runtimeTaskRunEventId !== commit.runtimeTaskRunEventId
      )
        throw new Error("书籍创建身份或项目授权不一致。");
    },
    async verifyBookBytes({ credential, original, bytes }) {
      if (
        original.appId !== "morphz.reader" ||
        original.instanceId !== request.readerInstanceId ||
        bytes.storageKind !== "app_private" ||
        bytes.providerId !== request.originalStoreId ||
        bytes.objectRef !== bytes.bookId
      )
        throw new Error("阅读书籍字节保存方不一致。");
      const version = await request.originalStore.verifyVersion({
        credential,
        artifactId: bytes.objectRef,
        revision: bytes.revision,
      });
      if (
        version.storeId !== bytes.providerId ||
        version.artifactId !== bytes.bookId ||
        version.revision !== bytes.revision ||
        version.sha256 !== bytes.sha256 ||
        version.byteLength !== bytes.byteLength
      )
        throw new Error("阅读书籍原件字节不完整。");
    },
    async verifyAccess({ credential, original, principalId, inputId, action }) {
      checkOriginal(original);
      const permitted = await request.platform.authorizeApplicationObject(
        { credential },
        original.instanceId,
        original.appId,
        original.objectId,
        action === "annotate" ? "write" : "read",
        original.appId === "morphz.reader"
          ? request.readerProvider()
          : request.objectsProvider(),
      );
      if (
        permitted.tenantId !== original.tenantId ||
        permitted.principalId !== principalId ||
        permitted.runtimeInputId !== (inputId ?? null) ||
        permitted.objectKind !==
          (original.appId === "morphz.reader" ? "publication" : "document")
      )
        throw new Error("阅读原件授权与当前身份不一致。");
    },
  };
}

export class ReaderService {
  constructor(
    private readonly platform: PlatformStore,
    private readonly objects: ObjectsStore,
    private readonly reader: ReaderStore,
    private readonly objectsInstanceId: string,
    private readonly readerInstanceId: string,
    private readonly objectsProvider: () => ApplicationProviderRoute,
    private readonly readerProvider: () => ApplicationProviderRoute,
    private readonly originalStore: ManagedArtifactStore,
    private readonly originalStoreId: string,
  ) {}

  /** Commit order: parse and authorize, save immutable bytes, commit Reader
   * original with its outbox receipt, then project one catalog reference.
   * Retrying a failed projection never creates a second book. */
  async import(
    actor: PlatformActor,
    request: {
      commandId: string;
      projectId: string;
      name: string;
      bytes: Uint8Array;
    },
  ) {
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(request.commandId) ||
      !request.name ||
      request.name.length > 180 ||
      /[/\\\u0000-\u001f]/.test(request.name) ||
      request.name.startsWith(".") ||
      !request.bytes.length ||
      request.bytes.length > maxReadingFileBytes
    )
      throw new Error("读物文件名、操作标识或大小无效。");
    const identity = await this.platform.authorizeContentProject(
      actor,
      this.readerInstanceId,
      "morphz.reader",
      request.projectId,
      this.readerProvider(),
    );
    const originalBytes = Buffer.from(request.bytes);
    const digest = createHash("sha256").update(originalBytes).digest("hex");
    const extension = request.name.split(".").at(-1)!.toLowerCase();
    const parser = readerParserIdentity(request.name);
    const bookCommit: ReaderBookCommit = {
      credential: actor.credential,
      commandId: request.commandId,
      projectId: request.projectId,
      tenantId: identity.tenantId,
      principalId: identity.principalId,
      actantId: identity.actantId,
      runtimeInputId: identity.runtimeInputId,
      runtimeTaskRunEventId: identity.runtimeTaskRunEventId,
    };
    const cached = await this.reader.readImportResult({
      commit: bookCommit,
      sha256: digest,
      byteLength: originalBytes.length,
      ...parser,
    });
    const parserVersion = cached?.parserVersion ?? parser.parserVersion;
    let title: string;
    let author = "";
    let edition = "";
    let language = "";
    let format: string;
    let sections: ReaderSourceImport["sections"];
    if (cached) {
      ({ title, author, edition, language, format, sections } = cached);
    } else if (extension === "pdf") {
      const pages = await extractPdf(originalBytes);
      title = request.name.slice(0, -4);
      format = "pdf";
      const escape = (value: string) =>
        value.replace(
          /[&<>"']/g,
          (character) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[character]!,
        );
      sections = pages.map((text, index) => ({
        ...safeReadingSection(
          `page-${index + 1}`,
          `第 ${index + 1} 页`,
          `<pre>${escape(text)}</pre>`,
        ),
        pageNumber: index + 1,
      }));
    } else {
      const parsed = await parsePublication(request.name, originalBytes);
      title = parsed.title;
      author = parsed.content.author;
      edition = parsed.content.edition;
      language = parsed.content.language;
      format = parsed.content.format;
      sections = parsed.sections;
    }
    const bookId = `book_${createHash("sha256")
      .update(JSON.stringify([identity.tenantId, request.commandId]))
      .digest("hex")
      .slice(0, 40)}`;
    const contentId = contentIdForAppObject(
      identity.tenantId,
      this.readerInstanceId,
      bookId,
    );
    const stored = await this.originalStore.put({
      credential: actor.credential,
      commandId: request.commandId,
      artifactId: bookId,
      baseRevision: 0,
      mime:
        extension === "pdf" ? "application/pdf" : "application/octet-stream",
      expectedSha256: digest,
      bytes: originalBytes,
    });
    const original: ReaderOriginal = {
      tenantId: identity.tenantId,
      appId: "morphz.reader",
      instanceId: this.readerInstanceId,
      objectId: bookId,
      versionRef: String(stored.revision),
    };
    const source: ReaderSourceImport = {
      tenantId: identity.tenantId,
      readingSourceId: `reader_${createHash("sha256").update(JSON.stringify(original)).digest("hex")}`,
      original,
      sourceLocatorId: `${contentId}@${stored.revision}`,
      book: {
        bookId,
        ownerPrincipalId: identity.principalId,
        revision: stored.revision,
        storageKind: "app_private",
        providerId: this.originalStoreId,
        objectRef: stored.artifactId,
        sha256: stored.sha256,
        byteLength: stored.byteLength,
        parserVersion,
      },
      bookCommit,
      importCache: { optionsSha256: parser.optionsSha256 },
      title,
      author,
      edition,
      format,
      language,
      createdAt: new Date().toISOString(),
      sections,
    };
    if (
      await this.reader.hasSourceBinding({
        tenantId: source.tenantId,
        readingSourceId: source.readingSourceId,
        original,
      })
    )
      await this.reader.verifyImportedSource(source);
    else {
      try {
        await this.reader.importSource(source);
      } catch (error) {
        if (
          !(await this.reader.hasSourceBinding({
            tenantId: source.tenantId,
            readingSourceId: source.readingSourceId,
            original,
          }))
        )
          throw error;
        await this.reader.verifyImportedSource(source);
      }
    }
    const receiptId = readerBookEventId(identity.tenantId, request.commandId);
    await this.platform.recordContent(
      actor,
      { instanceId: this.readerInstanceId, proof: receiptId },
      {
        commandId: `catalog_${createHash("sha256")
          .update(
            JSON.stringify([
              identity.tenantId,
              this.readerInstanceId,
              receiptId,
            ]),
          )
          .digest("hex")
          .slice(0, 40)}`,
        appReceiptId: receiptId,
        contentId,
        objectId: bookId,
        projectId: request.projectId,
        kind: "publication",
        title,
        observedVersionRef: String(stored.revision),
      },
    );
    await this.reader.markDirectoryProjected(identity.tenantId, receiptId);
    return {
      entityId: contentId,
      bookId,
      revision: stored.revision,
      receiptId,
    };
  }

  private async source(
    actor: PlatformActor,
    contentId: string,
    revision: number,
  ) {
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new Error("阅读原件版本无效。");
    const entry = await this.platform.content(actor, contentId);
    if (
      !(
        (entry.app_id === "morphz.objects" &&
          entry.instance_id === this.objectsInstanceId &&
          entry.kind === "document") ||
        (entry.app_id === "morphz.reader" &&
          entry.instance_id === this.readerInstanceId &&
          entry.kind === "publication")
      ) ||
      entry.availability !== "available"
    )
      throw new Error("所选内容不是可阅读的文档原件。");
    const identity = await this.platform.authorizeApplicationObject(
      actor,
      entry.instance_id,
      entry.app_id,
      entry.app_object_id,
      "read",
      entry.app_id === "morphz.reader"
        ? this.readerProvider()
        : this.objectsProvider(),
    );
    if (identity.contentId !== contentId)
      throw new Error("文档目录身份已变化。");
    const original: ReaderOriginal = {
      tenantId: identity.tenantId,
      appId: entry.app_id,
      instanceId: entry.instance_id,
      objectId: entry.app_object_id,
      versionRef: String(revision),
    };
    const readingSourceId = `reader_${createHash("sha256")
      .update(JSON.stringify(original))
      .digest("hex")}`;
    const sourceLocatorId = `${contentId}@${revision}`;
    if (entry.app_id === "morphz.reader") {
      if (
        !(await this.reader.hasSourceBinding({
          tenantId: original.tenantId,
          readingSourceId,
          original,
        }))
      )
        throw new Error("阅读书籍原件缺少派生阅读数据。");
    } else if (
      !(await this.reader.hasSourceBinding({
        tenantId: original.tenantId,
        readingSourceId,
        original,
      }))
    ) {
      const version = await this.objects.readDocument({
        credential: actor.credential,
        objectId: original.objectId,
        revision,
      });
      if (version.contentId !== contentId || version.revision !== revision)
        throw new Error("文档目录与精确原件版本不一致。");
      const sections = version.content.markdown.trim()
        ? (
            await parsePublication(
              `${version.title.replace(/[\/\\]/g, "_") || "文档"}.md`,
              Buffer.from(version.content.markdown, "utf8"),
            )
          ).sections
        : [safeReadingSection("section-1", "正文", "<p></p>")];
      const source: ReaderSourceImport = {
        tenantId: original.tenantId,
        readingSourceId,
        original,
        sourceLocatorId,
        title: version.title,
        author: "",
        edition: "",
        format: "markdown",
        language: "",
        createdAt: version.createdAt,
        sections,
      };
      try {
        await this.reader.importSource(source);
      } catch (error) {
        // Concurrent first reads may race. Equality is checked against the
        // complete immutable source; unrelated failures are not disguised.
        if (
          !(await this.reader.hasSourceBinding({
            tenantId: original.tenantId,
            readingSourceId,
            original,
          }))
        )
          throw error;
        await this.reader.verifyImportedSource(source);
      }
    }
    return {
      credential: actor.credential,
      tenantId: original.tenantId,
      principalId: identity.principalId,
      projectId: identity.projectId,
      ...(identity.runtimeInputId ? { inputId: identity.runtimeInputId } : {}),
      readingSourceId,
    };
  }

  async contents(actor: PlatformActor, contentId: string, revision: number) {
    const source = await this.source(actor, contentId, revision);
    const result: Array<{ id: string; title: string; characters: number }> = [];
    let afterOrdinal: number | undefined;
    for (;;) {
      const page = await this.reader.listSections({
        ...source,
        ...(afterOrdinal === undefined ? {} : { afterOrdinal }),
        limit: 100,
      });
      result.push(
        ...page.map((item) => ({
          id: item.sectionId,
          title: item.title,
          characters: item.characters,
        })),
      );
      if (page.length < 100) return result;
      afterOrdinal = page.at(-1)!.ordinal;
    }
  }

  async read(
    actor: PlatformActor,
    contentId: string,
    revision: number,
    sectionId: string,
  ) {
    const source = await this.source(actor, contentId, revision);
    return this.reader.readDisplaySection({ ...source, sectionId });
  }

  async bookOverview(
    actor: PlatformActor,
    contentId: string,
    revision: number,
  ) {
    const source = await this.source(actor, contentId, revision);
    return this.reader.bookOverview(source);
  }

  async originalMetadata(
    actor: PlatformActor,
    contentId: string,
    revision: number,
  ) {
    const overview = await this.bookOverview(actor, contentId, revision);
    if (overview.format !== "pdf") throw new Error("此书籍不是 PDF 原件。");
    const metadata = await this.originalStore.readVersionMetadata({
      credential: actor.credential,
      artifactId: overview.bookId,
      revision,
    });
    if (
      metadata.storeId !== this.originalStoreId ||
      metadata.sha256 !== overview.sha256 ||
      metadata.byteLength !== overview.byteLength
    )
      throw new Error("PDF 原件字节与阅读器版本不一致。");
    return { byteLength: metadata.byteLength, sha256: metadata.sha256 };
  }

  async originalRange(
    actor: PlatformActor,
    contentId: string,
    revision: number,
    start: number,
    endExclusive: number,
  ) {
    const overview = await this.bookOverview(actor, contentId, revision);
    if (overview.format !== "pdf" || endExclusive > overview.byteLength)
      throw new Error("PDF 原件读取范围无效。");
    const result = await this.originalStore.readRange({
      credential: actor.credential,
      artifactId: overview.bookId,
      revision,
      start,
      endExclusive,
    });
    if (
      result.version.storeId !== this.originalStoreId ||
      result.version.sha256 !== overview.sha256 ||
      result.version.byteLength !== overview.byteLength
    )
      throw new Error("PDF 原件字节与阅读器版本不一致。");
    return result.bytes;
  }

  private async ocrSource(
    actor: PlatformActor,
    contentId: string,
    revision: number,
    page: number,
    write = false,
  ) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 300)
      throw new Error("PDF 页码无效。");
    const source = await this.source(actor, contentId, revision);
    const overview = await this.reader.bookOverview(source);
    if (
      overview.format !== "pdf" ||
      !overview.sections.some((section) => section.id === `page-${page}`)
    )
      throw new Error("请选择存在的 PDF 页面。");
    if (write) {
      const entry = await this.platform.content(actor, contentId);
      const permitted = await this.platform.authorizeApplicationObject(
        actor,
        this.readerInstanceId,
        "morphz.reader",
        entry.app_object_id,
        "write",
        this.readerProvider(),
      );
      if (
        entry.app_id !== "morphz.reader" ||
        entry.instance_id !== this.readerInstanceId ||
        permitted.contentId !== contentId
      )
        throw new Error("OCR 原件不属于当前阅读器或不可修改。");
    }
    return { source, overview };
  }

  async ocrContext(
    actor: PlatformActor,
    contentId: string,
    revision: number,
    page: number,
    write = false,
  ) {
    const { source } = await this.ocrSource(
      actor,
      contentId,
      revision,
      page,
      write,
    );
    return {
      owner: `${source.tenantId}:${source.principalId}`,
      readingSourceId: source.readingSourceId,
      inputId: source.inputId ?? null,
    };
  }

  async latestOcr(
    actor: PlatformActor,
    contentId: string,
    revision: number,
    page: number,
  ) {
    const { source } = await this.ocrSource(actor, contentId, revision, page);
    return this.reader.latestOcrVersion({ ...source, page });
  }

  async readOcr(
    actor: PlatformActor,
    contentId: string,
    revision: number,
    page: number,
    sectionId: string,
  ) {
    const { source } = await this.ocrSource(actor, contentId, revision, page);
    if (!sectionId.startsWith(`page-${page}-ocr-`))
      throw new Error("OCR 来源不属于这一页。");
    return this.reader.readOcrVersion({ ...source, sectionId });
  }

  async saveOcr(
    actor: PlatformActor,
    contentId: string,
    revision: number,
    page: number,
    result: ReadingOcr,
  ) {
    const { source } = await this.ocrSource(
      actor,
      contentId,
      revision,
      page,
      true,
    );
    return this.reader.saveOcrVersion({ ...source, page, result });
  }

  async ocrPdfBytes(
    actor: PlatformActor,
    contentId: string,
    revision: number,
    page: number,
  ) {
    const { overview } = await this.ocrSource(
      actor,
      contentId,
      revision,
      page,
      true,
    );
    if (overview.byteLength < 1 || overview.byteLength > maxReadingFileBytes)
      throw new Error("PDF 原件大小超出阅读器范围。");
    const bytes = Buffer.alloc(overview.byteLength);
    const digest = createHash("sha256");
    for (let start = 0; start < bytes.length; start += 8 * 1024 * 1024) {
      const endExclusive = Math.min(start + 8 * 1024 * 1024, bytes.length);
      const part = await this.originalStore.readRange({
        credential: actor.credential,
        artifactId: overview.bookId,
        revision,
        start,
        endExclusive,
      });
      if (
        part.version.storeId !== this.originalStoreId ||
        part.version.sha256 !== overview.sha256 ||
        part.version.byteLength !== overview.byteLength ||
        part.bytes.length !== endExclusive - start
      )
        throw new Error("PDF 原件分块与阅读版本不一致。");
      bytes.set(part.bytes, start);
      digest.update(part.bytes);
    }
    if (digest.digest("hex") !== overview.sha256)
      throw new Error("PDF 原件完整摘要不匹配。");
    return bytes;
  }

  async readSlice(
    actor: PlatformActor,
    contentId: string,
    revision: number,
    sectionId: string,
    offset: number,
    limit: number,
  ) {
    const source = await this.source(actor, contentId, revision);
    const result = await this.reader.readSection({
      ...source,
      sectionId,
      offset,
      limit,
    });
    if (offset > result.totalCharacters)
      throw new Error("文字位置超出章节范围。");
    const recognized = /^page-[1-9]\d*-ocr-[a-f0-9]{64}$/.test(sectionId)
      ? await this.reader.readOcrVersion({ ...source, sectionId })
      : null;
    let lineOffset = 0;
    const end = offset + result.text.length;
    const lines = recognized?.items.flatMap((item, line) => {
      const text = item.correction ?? item.text;
      const start = lineOffset;
      lineOffset += text.length + 1;
      const from = Math.max(start, offset);
      const to = Math.min(start + text.length, end);
      return from < to
        ? [
            {
              line,
              start: from,
              end: to,
              text: text.slice(from - start, to - start),
              partial: from !== start || to !== start + text.length,
              corrected: item.correction !== undefined,
              polygon: item.poly,
            },
          ]
        : [];
    });
    return {
      ...result,
      ...(recognized
        ? {
            ocr: {
              engine: recognized.engine,
              layout: recognized.layout,
              warning: "识别文本可能有错漏，模型分数不是正确率；需对照原页。",
              lineIndexBase: 0,
              lines: lines!.slice(0, 200),
              linesTruncated: lines!.length > 200,
            },
          }
        : {}),
    };
  }

  /** Verify an input against the exact app-owned source. A position-only
   * message reads metadata; selected words use bounded slices, never a full
   * chapter or book merely to admit the input. */
  async validateInputReference(
    actor: PlatformActor,
    contentId: string,
    revision: number,
    reference: ReadingInput,
    selection: string,
  ) {
    const source = await this.source(actor, contentId, revision);
    const location = reference.location;
    const metadata = await this.reader.sectionMetadata({
      ...source,
      sectionId: location.sectionId,
    });
    if (
      metadata.sourceLocatorId !== location.sourceId ||
      metadata.title !== reference.chapter ||
      location.end > metadata.totalCharacters ||
      JSON.stringify(metadata.book) !== JSON.stringify(reference.book)
    )
      throw new Error("阅读位置与原件版本不匹配，请重新选择。");
    if (!("quote" in reference)) {
      if (selection) throw new Error("没有选文的阅读位置不能附带选中文本。");
      return;
    }
    if (
      !selection ||
      selection !== reference.quote ||
      location.end <= location.start
    )
      throw new Error("阅读选文与原件位置不匹配，请重新选择。");
    const quote = await this.reader.readSection({
      ...source,
      sectionId: location.sectionId,
      offset: location.start,
      limit: location.end - location.start,
    });
    if (quote.text !== reference.quote)
      throw new Error("阅读选文与原件版本不匹配，请重新选择。");
    if (reference.before) {
      if (reference.before.length > location.start)
        throw new Error("阅读选文前文已变化，请重新选择。");
      const before = await this.reader.readSection({
        ...source,
        sectionId: location.sectionId,
        offset: location.start - reference.before.length,
        limit: reference.before.length,
      });
      if (before.text !== reference.before)
        throw new Error("阅读选文前文已变化，请重新选择。");
    }
    if (reference.after) {
      if (location.end + reference.after.length > metadata.totalCharacters)
        throw new Error("阅读选文后文已变化，请重新选择。");
      const after = await this.reader.readSection({
        ...source,
        sectionId: location.sectionId,
        offset: location.end,
        limit: reference.after.length,
      });
      if (after.text !== reference.after)
        throw new Error("阅读选文后文已变化，请重新选择。");
    }
  }

  /** Verify a quoted span against the exact authorized source. A moved book
   * retains its old citation only when both project audiences are identical.
   * Only the selected bounded slice is read, never the whole book. */
  async quoteSlice(
    actor: PlatformActor,
    request: {
      contentId: string;
      revision: number;
      sourceProjectId: string;
      sectionId: string;
      start: number;
      end: number;
    },
  ) {
    const source = await this.source(
      actor,
      request.contentId,
      request.revision,
    );
    if (
      source.projectId !== request.sourceProjectId &&
      !(await this.platform.projectAudiencesEqual(actor, [
        source.projectId,
        request.sourceProjectId,
      ]))
    )
      throw new Error("引用读物的项目权限已变化。");
    if (
      !Number.isSafeInteger(request.start) ||
      !Number.isSafeInteger(request.end) ||
      request.start < 0 ||
      request.end <= request.start ||
      request.end - request.start > 8000
    )
      throw new Error("引用的阅读范围无效。");
    const slice = await this.reader.readSection({
      ...source,
      sectionId: request.sectionId,
      offset: request.start,
      limit: request.end - request.start,
    });
    if (request.end > slice.totalCharacters)
      throw new Error("引用的阅读位置超出原文。");
    return slice;
  }

  async marks(
    actor: PlatformActor,
    contentId: string,
    revision: number,
    deleted: boolean,
    offset: number,
    limit: number,
    filters: {
      sectionId?: string;
      start?: number;
      end?: number;
      after?: string;
    } = {},
  ) {
    const source = await this.source(actor, contentId, revision);
    return this.reader.listMarks({
      ...source,
      deleted,
      offset,
      limit,
      ...filters,
    });
  }

  async state(actor: PlatformActor, contentId: string, revision: number) {
    const source = await this.source(actor, contentId, revision);
    const position = await this.reader.readPosition(source);
    return { position };
  }

  async command(
    actor: PlatformActor,
    request: {
      commandId: string;
      contentId: string;
      revision: number;
      command: ReaderCommand;
    },
  ) {
    const binding = await this.source(
      actor,
      request.contentId,
      request.revision,
    );
    const command = request.command;
    let action: ReaderDomainAction;
    if (command.action === "mark-add" || command.action === "save-position") {
      if (
        command.artifactId !== request.contentId ||
        command.artifactRevision !== request.revision
      )
        throw new Error("阅读命令未绑定当前原件版本。");
      const {
        artifactId: _id,
        artifactRevision: _revision,
        ...operation
      } = command;
      action = { ...operation, readingSourceId: binding.readingSourceId };
    } else action = command;
    return this.reader.command({
      credential: actor.credential,
      tenantId: binding.tenantId,
      principalId: binding.principalId,
      ...(binding.inputId ? { inputId: binding.inputId } : {}),
      commandId: request.commandId,
      expectedReadingSourceId: binding.readingSourceId,
      action,
    });
  }
}

/** Re-project only Reader commits whose Platform directory update was
 * interrupted. The receipt, not a fresh import, is the recovery authority. */
export async function projectPendingReaderDirectory(request: {
  platform: PlatformStore;
  reader: ReaderStore;
  tenantId: string;
  instanceId: string;
  after?: { createdAt: string; eventId: string };
  limit?: number;
}) {
  const events = await request.reader.pendingDirectoryEvents(
    request.tenantId,
    request.limit ?? 100,
    request.after,
  );
  let projected = 0;
  const unresolved: string[] = [];
  for (const event of events) {
    try {
      await request.platform.recordCommittedContent(
        {
          tenantId: request.tenantId,
          principalId: event.principalId,
          actantId: event.actantId,
          runtimeInputId: event.runtimeInputId,
          runtimeTaskRunEventId: event.runtimeTaskRunEventId,
          instanceId: request.instanceId,
          receiptId: event.eventId,
        },
        {
          objectId: event.bookId,
          projectId: event.projectId,
          kind: "publication",
          title: event.title,
          observedVersionRef: event.versionRef,
        },
      );
      await request.reader.markDirectoryProjected(
        request.tenantId,
        event.eventId,
      );
      projected++;
    } catch {
      unresolved.push(event.eventId);
    }
  }
  const last = events.at(-1);
  return {
    examined: events.length,
    projected,
    unresolved,
    nextCursor: last
      ? { createdAt: last.createdAt, eventId: last.eventId }
      : null,
  };
}
