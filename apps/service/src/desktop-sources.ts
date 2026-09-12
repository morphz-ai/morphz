// Runs only in Electron's main process. There is no HTTP endpoint that accepts a host path.
import {
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  parse,
} from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ApplicationCaller } from "../../../packages/core/src/application-api.js";
import { HttpApplicationClient } from "../../../packages/core/src/http-application-client.js";
import {
  artifactSchema,
  commandSchema,
  type Command,
  type Operation,
} from "../../../packages/core/src/model.js";
import {
  documentImportIssue,
  documentTextIssue,
  maxDocumentBytes,
} from "../../../packages/core/src/sources.js";

const fileSchema = z
  .object({
    artifactId: z.uuid(),
    hash: z.string().nullable(),
    pending: commandSchema.nullable(),
    status: z.enum(["current", "paused", "unavailable"]).default("unavailable"),
  })
  .strict();
const grantSchema = z
  .object({
    id: z.uuid(),
    root: z.string(),
    inode: z.number(),
    device: z.number(),
    kind: z.enum(["file", "directory"]),
    label: z.string(),
    projectId: z.string(),
    centerId: z.uuid(),
    principalId: z.string(),
    enabled: z.boolean(),
    count: z.number(),
    error: z.string(),
    lastSync: z.string().nullable(),
    files: z.record(z.string(), fileSchema),
  })
  .strict();
const configSchema = z
  .object({
    version: z.literal(1),
    deviceId: z.uuid(),
    grants: z.array(grantSchema).max(20),
  })
  .strict();
type Grant = z.infer<typeof grantSchema>;
type Config = z.infer<typeof configSchema>;
const bootSchema = z.object({
  centerId: z.uuid(),
  csrfToken: z.string(),
  principalId: z.string(),
  workspace: z.object({
    artifacts: z.array(artifactSchema.pick({ id: true, source: true }).strip()),
    projects: z.array(
      z.object({ id: z.string(), members: z.array(z.string()) }),
    ),
  }),
});
type Boot = z.infer<typeof bootSchema>;

export async function inspectSource(path: string): Promise<{
  root: string;
  inode: number;
  device: number;
  kind: "file" | "directory";
  paths: string[];
}> {
  if (!isAbsolute(path)) throw new Error("资料选择必须来自系统文件选择器。");
  const raw = await lstat(path);
  if (raw.isSymbolicLink()) throw new Error("请直接选择资料，不接入符号链接。");
  const root = await realpath(path),
    info = await lstat(root);
  if (!info.isDirectory() && !info.isFile())
    throw new Error("请选择普通文件或资料目录。");
  const blocked = [
    parse(root).root,
    homedir(),
    "/Users",
    "/home",
    "/System",
    "/Library",
    "/Applications",
    "/usr",
    "/var",
    "/private",
    "/private/var",
    "/Windows",
    "/Program Files",
    "/ProgramData",
  ];
  if (blocked.some((p) => resolve(p).toLowerCase() === root.toLowerCase()))
    throw new Error(
      "请选择具体资料目录，不能接入系统盘、用户主目录或系统目录。",
    );
  const kind = info.isFile() ? "file" : "directory";
  const paths: string[] = [];
  if (kind === "file") {
    const issue = documentImportIssue(basename(root));
    if (issue) throw new Error(issue);
    paths.push(basename(root));
  } else {
    let visited = 0;
    async function walk(directory: string, depth: number) {
      if (depth > 12) throw new Error("资料层级超过 12 层，请缩小选择范围。");
      if (
        (await lstat(directory)).isSymbolicLink() ||
        (await realpath(directory)) !== directory
      )
        return;
      for await (const entry of await opendir(directory)) {
        if (++visited > 2000)
          throw new Error("目录条目超过 2000 项，请选择更具体的资料目录。");
        const full = join(directory, entry.name),
          path = relative(root, full).split(/[/\\]/).join("/");
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!documentImportIssue(path + "/source.txt"))
            await walk(full, depth + 1);
        } else if (entry.isFile() && !documentImportIssue(path))
          paths.push(path);
        if (paths.length > 100)
          throw new Error("单个来源最多 100 篇文本资料，请缩小选择范围。");
      }
    }
    await walk(root, 0);
  }
  return { root, inode: info.ino, device: info.dev, kind, paths: paths.sort() };
}

export async function readGrantedText(
  grant: Pick<Grant, "root" | "inode" | "device" | "kind">,
  path: string,
): Promise<string> {
  const issue = documentImportIssue(path);
  if (issue) throw new Error(issue);
  const rootStat = await lstat(grant.root);
  if (
    rootStat.isSymbolicLink() ||
    rootStat.ino !== grant.inode ||
    rootStat.dev !== grant.device ||
    (await realpath(grant.root)) !== grant.root
  )
    throw new Error("资料来源已替换或改为链接，请重新选择授权。");
  const target = grant.kind === "file" ? grant.root : join(grant.root, path);
  if (grant.kind === "file" && basename(grant.root) !== path)
    throw new Error("文件不在授权范围内。");
  if ((await realpath(target)) !== target)
    throw new Error("跳过符号链接，未读取内容。");
  const before = await lstat(target);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > maxDocumentBytes
  )
    throw new Error("资料不是普通文本文件或超过 8 MB。");
  const file = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const pinned = await file.stat(),
      after = await lstat(target);
    if (
      pinned.ino !== before.ino ||
      pinned.dev !== before.dev ||
      after.ino !== pinned.ino ||
      after.dev !== pinned.dev ||
      (await realpath(target)) !== target
    )
      throw new Error("资料在读取前发生变化，请稍后重试。");
    const bytes = Buffer.alloc(maxDocumentBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxDocumentBytes) throw new Error("资料超过 8 MB。");
    const final = await file.stat();
    if (
      final.mtimeMs !== pinned.mtimeMs ||
      final.size !== pinned.size ||
      bytesRead !== pinned.size
    )
      throw new Error("资料正在修改或未能完整读取，请稍后重试。");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, bytesRead),
    );
    const issue = documentTextIssue(text);
    if (issue) throw new Error(issue);
    return text;
  } finally {
    await file.close();
  }
}

export class DesktopSources {
  private client: ApplicationCaller;
  private config: Config;
  private running: Promise<void> | null = null;
  private closing = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private filename: string,
    application: string | ApplicationCaller,
    request: typeof fetch = fetch,
  ) {
    if (
      !isAbsolute(filename) ||
      (typeof application === "string" &&
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(application))
    )
      throw new Error("桌面来源配置无效。");
    this.client =
      typeof application === "string"
        ? new HttpApplicationClient(application, request)
        : application;
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    try {
      const info = lstatSync(filename);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (process.platform !== "win32" && info.mode & 0o077)
      )
        throw new Error("来源授权文件必须为私有普通文件。");
      this.config = configSchema.parse(
        JSON.parse(readFileSync(filename, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("来源授权配置无法读取；未重置既有授权。");
      this.config = { version: 1, deviceId: randomUUID(), grants: [] };
      this.save();
    }
  }
  private save() {
    const temporary = this.filename + "." + randomUUID();
    writeFileSync(temporary, JSON.stringify(this.config), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, this.filename);
  }
  list() {
    return this.config.grants.map(
      ({ id, label, projectId, enabled, count, error, lastSync }) => ({
        id,
        label,
        projectId,
        enabled,
        count,
        error,
        lastSync,
      }),
    );
  }
  private async boot(grant?: Grant): Promise<Boot> {
    const value = bootSchema.parse(
      await this.client.call("workspace", undefined, {
        signal: AbortSignal.timeout(6000),
      }),
    );
    if (
      grant &&
      (grant.centerId !== value.centerId ||
        grant.principalId !== value.principalId ||
        !value.workspace.projects.some(
          (p) =>
            p.id === grant.projectId && p.members.includes(value.principalId),
        ))
    )
      throw new Error("中心身份或项目权限已改变，资料没有发送。");
    return value;
  }
  async addSelection(path: string, projectId: string) {
    if (this.config.grants.length >= 20)
      throw new Error("最多接入 20 个来源，请先移除不再使用的来源。");
    const boot = await this.boot();
    if (
      !boot.workspace.projects.some(
        (p) => p.id === projectId && p.members.includes(boot.principalId),
      )
    )
      throw new Error("无权接入此项目。");
    const selected = await inspectSource(path);
    if (!selected.paths.length)
      throw new Error("没有可接入的 Markdown 或 UTF-8 文本文件。");
    if (
      this.config.grants.some(
        (g) =>
          g.root === selected.root &&
          g.projectId === projectId &&
          g.centerId === boot.centerId,
      )
    )
      throw new Error("此来源已接入。");
    this.config.grants.push({
      id: randomUUID(),
      root: selected.root,
      inode: selected.inode,
      device: selected.device,
      kind: selected.kind,
      label: basename(selected.root),
      projectId,
      centerId: boot.centerId,
      principalId: boot.principalId,
      enabled: false,
      count: selected.paths.length,
      error: "",
      lastSync: null,
      files: {},
    });
    this.save();
    return this.list();
  }
  private async post(boot: Boot, command: Command) {
    await this.client.call("command", command, {
      identityGeneration: boot.csrfToken,
      signal: AbortSignal.timeout(8000),
    });
  }
  private async status(
    grant: Grant,
    status: "current" | "paused" | "unavailable",
    artifactId?: string,
  ) {
    const boot = await this.boot(grant);
    await this.post(boot, {
      commandId: randomUUID(),
      operation: {
        type: "linked-source-status",
        projectId: grant.projectId,
        sourceId: grant.id,
        deviceId: this.config.deviceId,
        status,
        ...(artifactId ? { artifactId } : {}),
      },
    });
  }
  async control(id: string, action: "resume" | "pause" | "remove" | "refresh") {
    const grant = this.config.grants.find((g) => g.id === id);
    if (!grant) throw new Error("资料来源不存在。");
    if (action === "pause" || action === "remove") {
      grant.enabled = false;
      this.save();
      await this.running;
      try {
        const status = action === "remove" ? "unavailable" : "paused";
        await this.status(grant, status);
        for (const file of Object.values(grant.files)) file.status = status;
      } catch {
        grant.error = "本机已停止同步；中心暂未确认状态。";
      }
      if (action === "remove")
        this.config.grants = this.config.grants.filter((g) => g.id !== id);
      this.save();
    } else {
      if (action === "resume") grant.enabled = true;
      if (!grant.enabled) throw new Error("先恢复来源，再检查更新。");
      this.save();
      await this.tick();
    }
    return this.list();
  }
  start() {
    if (this.timer) return;
    this.closing = false;
    const poll = () =>
      void this.tick().catch(() => {
        this.closing = true;
        for (const grant of this.config.grants) {
          grant.enabled = false;
          grant.error =
            "本机授权记录无法保存，已停止资料同步。请检查磁盘和应用目录权限后重新打开桌面。";
        }
      });
    this.timer = setInterval(poll, 15000);
    this.timer.unref();
    poll();
  }
  async stop() {
    this.closing = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.sync().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async sync() {
    for (const grant of this.config.grants) {
      if (this.closing) break;
      if (!grant.enabled) continue;
      try {
        const boot = await this.boot(grant);
        const persistedSources = new Map(
          boot.workspace.artifacts.map((artifact) => [
            artifact.id,
            artifact.source,
          ]),
        );
        const pinnedRoot = await lstat(grant.root);
        if (
          pinnedRoot.isSymbolicLink() ||
          pinnedRoot.ino !== grant.inode ||
          pinnedRoot.dev !== grant.device ||
          (await realpath(grant.root)) !== grant.root
        )
          throw new Error("资料来源已替换，请重新授权。");
        const selected = await inspectSource(grant.root);
        if (
          selected.inode !== grant.inode ||
          selected.device !== grant.device ||
          selected.root !== grant.root
        )
          throw new Error("资料来源已替换，请重新授权。");
        grant.count = selected.paths.length;
        const problems: string[] = [];
        for (const path of selected.paths) {
          if (!grant.enabled || this.closing) break;
          const record = (grant.files[path] ??= {
            artifactId: randomUUID(),
            hash: null,
            pending: null,
            status: "unavailable",
          });
          try {
            let acknowledged = false;
            if (record.pending) {
              await this.post(boot, record.pending);
              record.hash =
                record.pending.operation.type === "sync-linked-document"
                  ? createHash("sha256")
                      .update(record.pending.operation.text)
                      .digest("hex")
                  : null;
              record.pending = null;
              record.status = "current";
              acknowledged = true;
              this.save();
            }
            if (!grant.enabled || this.closing) break;
            const text = await readGrantedText(grant, path),
              hash = createHash("sha256").update(text).digest("hex");
            if (hash === record.hash) {
              // The private cache can survive a transient failure or an older
              // process that already marked the application object unavailable.
              // Reconcile with the authorized application snapshot, not just the
              // unchanged file hash. A replay acknowledged above is already current.
              if (!acknowledged) {
                const source = persistedSources.get(record.artifactId);
                const connection = source?.connection;
                if (
                  source?.mode !== "linked" ||
                  connection?.sourceId !== grant.id ||
                  connection.deviceId !== this.config.deviceId
                )
                  throw new Error("资料对象的来源关系已改变，未覆盖内容。");
                if (
                  record.status !== "current" ||
                  connection.status !== "current"
                ) {
                  await this.status(grant, "current", record.artifactId);
                  record.status = "current";
                  this.save();
                }
              }
              continue;
            }
            const operation: Operation = {
              type: "sync-linked-document",
              projectId: grant.projectId,
              artifactId: record.artifactId,
              sourceId: grant.id,
              deviceId: this.config.deviceId,
              relativePath: path,
              text,
            };
            record.pending = { commandId: randomUUID(), operation };
            this.save();
            if (!grant.enabled || this.closing) break;
            await this.post(boot, record.pending);
            record.hash = hash;
            record.pending = null;
            record.status = "current";
            this.save();
          } catch {
            problems.push(path);
            if (record.status !== "unavailable") {
              try {
                await this.status(grant, "unavailable", record.artifactId);
                record.status = "unavailable";
              } catch {}
            }
            if (record.pending) break; // Backpressure: keep one uncertain delivery, don't read an entire folder into an outbox.
          }
        }
        for (const [path, record] of Object.entries(grant.files))
          if (!selected.paths.includes(path) && record.hash) {
            problems.push(path);
            if (record.status !== "unavailable") {
              await this.status(grant, "unavailable", record.artifactId);
              record.status = "unavailable";
            }
          }
        grant.error = problems.length
          ? `${problems.length} 项暂时无法同步，保留上次版本：${problems.slice(0, 3).join("、")}`
          : "";
        grant.lastSync = new Date().toISOString();
        this.save();
      } catch (error) {
        grant.error =
          error instanceof Error && !(error as NodeJS.ErrnoException).code
            ? error.message
            : "来源暂时不可读，请检查文件是否仍在原位置以及访问权限。";
        try {
          await this.status(grant, "unavailable");
          for (const file of Object.values(grant.files))
            file.status = "unavailable";
        } catch {
          /* Never send to a different center as an error recovery path. */
        }
        this.save();
      }
    }
  }
}
