import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  linkSync,
  unlinkSync,
  fsyncSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  parse,
  relative,
  resolve,
} from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  checkProject,
  DomainError,
  type AccessContext,
} from "../../core/src/model.js";
import {
  localFileReferenceSchema,
  type LocalFileReference,
  type LocalFileView,
  directoryGrantSchema,
  directoryRequestSchema,
  type DirectoryGrant,
  type DirectoryRequest,
} from "../../core/src/local-files.js";
import type { WorkspaceStore } from "./store.js";
import { extractPdf } from "./pdf.js";

const grantSchema = z
  .object({
    id: z.uuid(),
    root: z.string(),
    projectId: z.string(),
    principalId: z.string(),
    directory: z.boolean(),
    device: z.number(),
    inode: z.number(),
    conversationId: z.string().min(1).max(100).optional(),
    access: z.literal("read-write").optional(),
  })
  .strict();
const savedSchema = z
  .object({
    version: z.literal(1),
    centerId: z.uuid(),
    grants: z.array(grantSchema).max(200),
  })
  .strict();
const hash = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const blockedParts = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".ssh",
  ".aws",
  ".gnupg",
  ".codex",
  ".config",
]);
function permitted(path: string) {
  const parts = path.split(/[\\/]/);
  return !parts.some(
    (part) =>
      blockedParts.has(part.toLowerCase()) ||
      /^\.env(?:\.|$)/i.test(part) ||
      /^\.morphz-write-/i.test(part) ||
      /\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(part),
  );
}

/** Local, on-demand references. Never copies content, indexes it, watches it,
 * uploads it, or changes the source. Only the native picker calls select(). */
export class LocalFiles {
  private saved: z.infer<typeof savedSchema>;
  constructor(
    private file: string,
    private store: WorkspaceStore,
  ) {
    try {
      const stat = lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 1_000_000 ||
        (process.platform !== "win32" && stat.mode & 0o077)
      )
        throw new Error("本地文件引用记录权限无效。");
      this.saved = savedSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      if (this.saved.centerId !== store.identity())
        throw new Error("文件引用不属于当前工作空间。");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.saved = { version: 1, centerId: store.identity(), grants: [] };
    }
  }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + randomUUID();
    writeFileSync(temporary, JSON.stringify(this.saved), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, this.file);
  }
  select(
    path: string,
    projectId: string,
    access: AccessContext,
    conversationId?: string,
  ): LocalFileView {
    checkProject(this.store.snapshot(), projectId, access);
    if (!isAbsolute(path) || lstatSync(path).isSymbolicLink())
      throw new Error("请直接选择原文件或目录。");
    const root = realpathSync(path),
      info = lstatSync(root);
    if (
      (!info.isFile() && !info.isDirectory()) ||
      (conversationId !== undefined && !info.isDirectory()) ||
      !permitted(root) ||
      [
        parse(root).root,
        homedir(),
        "/Users",
        "/System",
        "/Library",
        "/private",
        "/private/var",
        "/usr",
        "/etc",
      ].includes(root)
    )
      throw new Error("请选择具体的工作文件或目录，不开放系统目录或凭据。");
    const existing = this.saved.grants.find(
      (g) =>
        g.root === root &&
        g.projectId === projectId &&
        g.principalId === access.principalId &&
        g.conversationId === conversationId &&
        g.device === info.dev &&
        g.inode === info.ino,
    );
    const grant = existing ?? {
      id: randomUUID(),
      root,
      projectId,
      principalId: access.principalId,
      directory: info.isDirectory(),
      device: info.dev,
      inode: info.ino,
      ...(conversationId !== undefined
        ? { conversationId, access: "read-write" as const }
        : {}),
    };
    if (!existing) {
      if (this.saved.grants.length >= 200)
        throw new Error("本机文件引用已达上限，请先关闭不再使用的引用。");
      this.saved.grants.push(grant);
    }
    try {
      // Directory authorization does not scan or preview its contents.
      const view: LocalFileView =
        conversationId !== undefined
          ? {
              location: root,
              reference: {
                grantId: grant.id,
                path: "",
                name: basename(root),
                kind: "directory",
                version: hash(`${info.dev}:${info.ino}`),
              },
            }
          : this.read(grant.id, "", projectId, access);
      this.save();
      return view;
    } catch (e) {
      if (!existing)
        this.saved.grants = this.saved.grants.filter((g) => g !== grant);
      throw e;
    }
  }
  private directoryView(grant: z.infer<typeof grantSchema>): DirectoryGrant {
    return {
      grantId: grant.id,
      name: basename(grant.root),
      path: grant.root,
      access: "read-write",
    };
  }
  directories(
    projectId: string,
    conversationId: string,
    access: AccessContext,
  ) {
    checkProject(this.store.snapshot(), projectId, access);
    return this.saved.grants
      .filter(
        (g) =>
          g.projectId === projectId &&
          g.conversationId === conversationId &&
          g.principalId === access.principalId &&
          g.access === "read-write",
      )
      .map((g) => this.directoryView(g));
  }
  authorizeDirectory(
    path: string,
    projectId: string,
    conversationId: string,
    access: AccessContext,
  ) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(conversationId))
      throw new Error("对话范围无效。");
    const existing = this.store
      .snapshot()
      .conversations.find((c) => c.id === conversationId);
    // The shared default conversation may span workspaces. Named conversations cannot.
    if (
      existing &&
      existing.id !== existing.projectId &&
      existing.projectId !== projectId
    )
      throw new Error("对话不属于此工作空间。");
    if (this.directories(projectId, conversationId, access).length >= 8)
      throw new Error("此对话最多授权 8 个目录，请先撤销不再使用的目录。");
    const view = this.select(path, projectId, access, conversationId);
    return this.directoryView(
      this.grant(view.reference.grantId, projectId, access),
    );
  }
  validateDirectory(
    raw: DirectoryGrant,
    projectId: string,
    conversationId: string,
    access: AccessContext,
  ) {
    const ref = directoryGrantSchema.parse(raw),
      g = this.grant(ref.grantId, projectId, access);
    if (
      g.access !== "read-write" ||
      g.conversationId !== conversationId ||
      !g.directory ||
      JSON.stringify(this.directoryView(g)) !== JSON.stringify(ref)
    )
      throw new DomainError(
        "forbidden",
        "目录未获此对话的读写授权，或授权已经撤销。",
      );
    return g;
  }
  async directoryForAgent(
    reference: DirectoryGrant,
    projectId: string,
    conversationId: string,
    author: AccessContext,
    raw: DirectoryRequest,
    operationKey: string,
  ) {
    const request = directoryRequestSchema.parse(raw);
    const g = this.validateDirectory(
      reference,
      projectId,
      conversationId,
      author,
    );
    if (request.grantId !== g.id)
      throw new DomainError("forbidden", "目录授权不匹配。");
    if (request.operation !== "write") {
      const view = this.read(g.id, request.path, projectId, author);
      if ((request.operation === "list") !== !!view.entries)
        throw new DomainError(
          "invalid",
          "请对目录使用 list，对文件使用 read。",
        );
      return this.forAgent(view.reference, projectId, author, request);
    }
    if (
      request.text === undefined ||
      request.expectedVersion === undefined ||
      request.text.includes("\0")
    )
      throw new DomainError(
        "invalid",
        "写入需要 UTF-8 text 和 expectedVersion；新文件必须显式传 null。",
      );
    const path = request.path;
    if (
      !path ||
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((p) => !p || p === "." || p === "..") ||
      !permitted(path)
    )
      throw new DomainError("forbidden", "只能写入授权目录内的普通文件。");
    if (/\.(?:pdf|epub|png|jpe?g|webp|zip|exe|dmg)$/i.test(path))
      throw new DomainError("invalid", "目录写入目前只支持文本文件。");
    const target = resolve(g.root, path),
      parent = dirname(target),
      parentInfo = lstatSync(parent);
    if (
      realpathSync(parent) !== parent ||
      !parentInfo.isDirectory() ||
      parentInfo.isSymbolicLink()
    )
      throw new DomainError("forbidden", "不能通过符号链接写入文件。");
    const verifyParent = () => {
      this.validateDirectory(reference, projectId, conversationId, author);
      const now = lstatSync(parent);
      if (
        realpathSync(parent) !== parent ||
        now.dev !== parentInfo.dev ||
        now.ino !== parentInfo.ino
      )
        throw new DomainError("conflict", "目录在写入前发生变化，未继续写入。");
    };
    const currentVersion = () => {
      verifyParent();
      let info;
      try {
        info = lstatSync(target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new DomainError("forbidden", "不能覆盖链接或非普通文件。");
      const view = this.read(g.id, path, projectId, author);
      if (view.reference.kind !== "text")
        throw new DomainError("invalid", "目录写入目前只支持文本文件。");
      return view.reference.version;
    };
    const after = hash(Buffer.from(request.text, "utf8"));
    const fingerprint = hash(
      JSON.stringify({ projectId, conversationId, author, reference, request }),
    );
    const receiptDir = this.file + ".writes";
    mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
    const receiptPath = resolve(receiptDir, hash(operationKey) + ".json");
    const receiptSchema = z
      .object({
        fingerprint: z.string(),
        before: z.string().nullable(),
        after: z.string(),
        status: z.enum(["pending", "done"]),
      })
      .strict();
    let receipt: z.infer<typeof receiptSchema> | undefined;
    try {
      receipt = receiptSchema.parse(
        JSON.parse(readFileSync(receiptPath, "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (receipt && receipt.fingerprint !== fingerprint)
      throw new DomainError("conflict", "相同工具调用不能更换写入内容。");
    const result = {
      path,
      version: after,
      bytes: Buffer.byteLength(request.text, "utf8"),
      written: true,
    };
    if (receipt?.status === "done") return result;
    const persist = (status: "pending" | "done") => {
      const temp = receiptPath + "." + randomUUID();
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify({
            fingerprint,
            before: request.expectedVersion,
            after,
            status,
          }),
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, receiptPath);
    };
    const version = currentVersion();
    if (receipt && version === after) {
      persist("done");
      return result;
    }
    if (version !== request.expectedVersion)
      throw new DomainError(
        "conflict",
        "文件已被修改或已存在。请重新读取并核对，不要覆盖他人的修改。",
      );
    persist("pending");
    const temporary = resolve(parent, ".morphz-write-" + randomUUID());
    const mode = version === null ? 0o600 : lstatSync(target).mode & 0o777;
    const fd = openSync(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      mode,
    );
    try {
      writeFileSync(fd, request.text, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      if (currentVersion() !== version)
        throw new DomainError("conflict", "文件在写入前发生变化，未覆盖。");
      if (version === null) {
        linkSync(temporary, target);
        unlinkSync(temporary);
      } else renameSync(temporary, target);
    } catch (e) {
      try {
        unlinkSync(temporary);
      } catch {
        /* already moved */
      }
      throw e;
    }
    persist("done");
    return result;
  }
  private grant(id: string, projectId: string, access: AccessContext) {
    checkProject(this.store.snapshot(), projectId, access);
    const grant = this.saved.grants.find(
      (g) =>
        g.id === id &&
        g.projectId === projectId &&
        g.principalId === access.principalId,
    );
    if (!grant)
      throw new DomainError(
        "forbidden",
        "原文件未获授权，或本机引用已关闭。请重新打开。",
      );
    const info = lstatSync(grant.root);
    if (
      info.isSymbolicLink() ||
      realpathSync(grant.root) !== grant.root ||
      (grant.directory &&
        (info.dev !== grant.device || info.ino !== grant.inode))
    )
      throw new DomainError("conflict", "原目录已移动或替换，请重新打开。");
    return grant;
  }
  read(
    id: string,
    path: string,
    projectId: string,
    access: AccessContext,
  ): LocalFileView {
    const grant = this.grant(id, projectId, access);
    if (
      path.length > 4096 ||
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((p) => p === "..") ||
      !permitted(path) ||
      (!grant.directory && path)
    )
      throw new DomainError("forbidden", "不能读取所选范围外的文件。");
    const target = grant.directory ? resolve(grant.root, path) : grant.root;
    const rel = relative(grant.root, target);
    if (
      rel.startsWith("..") ||
      isAbsolute(rel) ||
      realpathSync(target) !== target ||
      lstatSync(target).isSymbolicLink()
    )
      throw new DomainError("forbidden", "不能通过符号链接访问其他位置。");
    const info = lstatSync(target);
    const reference = (
      kind: LocalFileReference["kind"],
      version: string,
    ): LocalFileReference => ({
      grantId: id,
      path,
      name: basename(target),
      kind,
      version,
    });
    if (info.isDirectory()) {
      const rows = [];
      const directory = opendirSync(target);
      try {
        for (
          let entry = directory.readSync();
          entry;
          entry = directory.readSync()
        ) {
          if (rows.length >= 5000)
            throw new Error("目录条目过多，请直接打开更具体的目录。");
          rows.push(entry);
        }
      } finally {
        directory.closeSync();
      }
      return {
        location: target,
        reference: reference("directory", hash(`${info.dev}:${info.ino}`)),
        entries: rows
          .filter(
            (e) =>
              !e.isSymbolicLink() &&
              (e.isFile() || e.isDirectory()) &&
              permitted(e.name),
          )
          .sort(
            (a, b) =>
              Number(b.isDirectory()) - Number(a.isDirectory()) ||
              a.name.localeCompare(b.name),
          )
          .map((e) => ({
            name: e.name,
            path: [path, e.name].filter(Boolean).join("/"),
            directory: e.isDirectory(),
          })),
      };
    }
    if (!info.isFile() || info.size > 20 * 1024 * 1024)
      throw new Error("仅支持不超过 20 MB 的普通文件。");
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let data: Buffer;
    try {
      const before = fstatSync(fd);
      if (
        before.ino !== info.ino ||
        before.dev !== info.dev ||
        !before.isFile() ||
        before.size > 20 * 1024 * 1024
      )
        throw new Error("文件在读取前发生变化，请重试。");
      const buffer = Buffer.alloc(20 * 1024 * 1024 + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = readSync(fd, buffer, size, buffer.length - size, size);
        if (!read) break;
        size += read;
      }
      data = buffer.subarray(0, size);
      const after = fstatSync(fd);
      if (
        data.length > 20 * 1024 * 1024 ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        realpathSync(target) !== target
      )
        throw new Error("文件在读取时发生变化，请重试。");
    } finally {
      closeSync(fd);
    }
    const version = hash(data),
      extension = extname(target).toLowerCase();
    if (extension === ".pdf")
      return {
        location: target,
        reference: reference("pdf", version),
        mime: "application/pdf",
        data: data.toString("base64"),
      };
    const mime = (
      {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
      } as Record<string, string>
    )[extension];
    if (mime)
      return {
        location: target,
        reference: reference("image", version),
        mime,
        data: data.toString("base64"),
      };
    if (extension === ".epub" || data.includes(0))
      throw new Error("此格式暂未提供原位阅读器；没有导入或复制文件。");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return { location: target, reference: reference("text", version), text };
  }
  validate(
    raw: LocalFileReference,
    projectId: string,
    access: AccessContext,
    quote = "",
  ) {
    const ref = localFileReferenceSchema.parse(raw),
      view = this.read(ref.grantId, ref.path, projectId, access);
    if (
      ref.version !== view.reference.version ||
      ref.kind !== view.reference.kind ||
      ref.name !== view.reference.name
    )
      throw new DomainError(
        "conflict",
        "原文件已变化，请刷新文件后再发送；草稿已保留。",
      );
    if (quote && !view.text?.includes(quote))
      throw new DomainError("invalid", "选区与原文件内容不符。");
    return view;
  }
  revoke(id: string, projectId: string, access: AccessContext) {
    checkProject(this.store.snapshot(), projectId, access);
    if (
      !this.saved.grants.some(
        (g) =>
          g.id === id &&
          g.projectId === projectId &&
          g.principalId === access.principalId,
      )
    )
      throw new DomainError("forbidden", "文件引用不属于当前身份。");
    this.saved.grants = this.saved.grants.filter((g) => g.id !== id);
    this.save();
  }
  async forAgent(
    reference: LocalFileReference,
    projectId: string,
    author: AccessContext,
    request: { path?: string; offset?: number; limit?: number },
  ) {
    const original = this.validate(reference, projectId, author);
    const anotherPath =
      request.path !== undefined && request.path !== reference.path;
    if (
      anotherPath &&
      (reference.kind !== "directory" ||
        (reference.path && !request.path!.startsWith(reference.path + "/")))
    )
      throw new DomainError(
        "forbidden",
        "Agent 只能读取本次输入引用的文件或目录范围。",
      );
    const view = anotherPath
      ? this.read(reference.grantId, request.path!, projectId, author)
      : original;
    if (view.entries)
      return {
        reference: view.reference,
        location: view.location,
        entries: view.entries.slice(
          request.offset ?? 0,
          (request.offset ?? 0) + Math.min(request.limit ?? 100, 200),
        ),
        total: view.entries.length,
      };
    let text = view.text;
    if (view.reference.kind === "pdf")
      text = (await extractPdf(Buffer.from(view.data!, "base64"))).join("\n\n");
    if (text === undefined)
      return {
        reference: view.reference,
        location: view.location,
        error: "图片请由用户作为消息附件发送；此工具不上传原文件。",
      };
    const offset = request.offset ?? 0,
      limit = Math.min(request.limit ?? 12000, 24000);
    return {
      reference: view.reference,
      location: view.location,
      text: text.slice(offset, offset + limit),
      total: text.length,
      hasMore: offset + limit < text.length,
    };
  }
}
