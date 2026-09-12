import { createHash, randomBytes } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { z, ZodError } from "zod";
import { DomainError } from "../../core/src/model.js";
import { type AgentTools, workToolDefinition } from "./agent-tools.js";
import { workInputFormat, workInputFormatV1 } from "./session-io.js";

const maxRequest = 4 * 1024 * 1024,
  maxResponse = 2 * 1024 * 1024;
function privateFile(path: string) {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 262144 ||
    (process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid!()))
  )
    throw new Error("Host 工具配置必须是当前用户的私有普通文件。");
}

/** A separate manifest preserves the existing HTTP host and all durable job identities. */
export function prepareLocalHostTools(
  directory: string,
  namespace: string,
  teamIdentity = false,
) {
  if (process.platform === "win32")
    throw new Error(
      "当前本地 Runtime 工具通信支持 macOS/Linux；Windows 可使用远端连接。",
    );
  if (!isAbsolute(directory))
    throw new Error("本地应用数据目录必须是绝对路径。");
  const key = createHash("sha256")
    .update(directory + "\0" + namespace)
    .digest("hex")
    .slice(0, 20);
  let endpoint: string;
  {
    const folder = join(
      process.platform === "darwin" ? "/private/tmp" : "/tmp",
      `morphz-host-${process.getuid!()}-${key}`,
    );
    if (!existsSync(folder)) mkdirSync(folder, { mode: 0o700 });
    const info = lstatSync(folder);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid!()
    )
      throw new Error("本地工具通信目录不属于当前用户或权限不安全。");
    endpoint = join(folder, "application.sock");
  }
  const path = join(directory, "host-tools-desktop.json");
  const context = `mw-context-${namespace}`;
  const scope = {
    context_ids: teamIdentity ? [] : [context],
    ...(teamIdentity ? { context_id_prefixes: [context + "-"] } : {}),
  };
  let token = randomBytes(32).toString("hex");
  if (existsSync(path)) {
    privateFile(path);
    const previous = z
      .object({
        protocol: z.literal(1),
        tools: z
          .array(
            z
              .object({
                ipc_path: z.string(),
                token: z.string().regex(/^[a-f0-9]{64}$/),
                context_ids: z.array(z.string()),
                context_id_prefixes: z.array(z.string()).default([]),
              })
              .passthrough(),
          )
          .length(1),
      })
      .passthrough()
      .parse(JSON.parse(readFileSync(path, "utf8")));
    const tool = previous.tools[0]!;
    if (
      tool.ipc_path !== endpoint ||
      JSON.stringify(tool.context_ids) !== JSON.stringify(scope.context_ids) ||
      JSON.stringify(tool.context_id_prefixes) !==
        JSON.stringify(scope.context_id_prefixes ?? [])
    )
      throw new Error("本地 Host 配置与此工作区不匹配；原配置未覆盖。");
    token = tool.token;
  }
  const temporary = path + "." + randomBytes(6).toString("hex");
  writeFileSync(
    temporary,
    JSON.stringify(
      {
        protocol: 1,
        formats: [workInputFormat, workInputFormatV1],
        tools: [
          {
            ipc_path: endpoint,
            token,
            ...scope,
            definition: workToolDefinition,
          },
        ],
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  renameSync(temporary, path);
  return { token, path, endpoint };
}

async function clearStaleSocket(path: string) {
  if (process.platform === "win32" || !existsSync(path)) return;
  const info = lstatSync(path);
  if (
    !info.isSocket() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid!()
  )
    throw new Error("本地通信路径被其他文件占用，未修改。");
  const unused = await new Promise<boolean>((resolve) => {
    const socket = createConnection(path);
    socket.setTimeout(700);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT"),
    );
  });
  if (!unused) throw new Error("此工作区的本地工具宿主已在运行。");
  if (existsSync(path)) {
    const after = lstatSync(path);
    if (after.ino !== info.ino || after.dev !== info.dev || !after.isSocket())
      throw new Error("本地通信路径发生变化，未修改。");
    unlinkSync(path);
  }
}

/** Length-framed private local IPC inside the application process, never HTTP. */
export async function listenLocalHostTools(
  endpoint: string,
  tools: AgentTools,
) {
  await clearStaleSocket(endpoint);
  const connections = new Set<Socket>(),
    pending = new Set<Promise<void>>();
  let closing = false;
  const server = createServer((socket) => {
    if (closing || connections.size >= 32) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.setTimeout(20000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => connections.delete(socket));
    let chunks: Buffer[] = [],
      size = 0,
      length: number | undefined,
      started = false;
    const send = (value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > maxResponse || socket.destroyed) {
        socket.destroy();
        return;
      }
      const header = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);
      socket.end(Buffer.concat([header, bytes]));
    };
    const execute = async (bytes: Buffer) => {
      try {
        const envelope = z
          .object({
            protocol: z.literal(1),
            token: z.string().max(1024),
            request: z.unknown(),
          })
          .strict()
          .parse(JSON.parse(bytes.toString("utf8")));
        if (!tools.authenticate(`Bearer ${envelope.token}`)) {
          send({ protocol: 1, ok: false, code: "forbidden" });
          return;
        }
        try {
          send({
            protocol: 1,
            ok: true,
            value: await tools.call(envelope.request),
          });
        } catch (error) {
          if (error instanceof DomainError && error.code !== "forbidden")
            send({
              protocol: 1,
              ok: true,
              value: { ok: false, code: error.code, message: error.message },
            });
          else if (error instanceof ZodError)
            send({
              protocol: 1,
              ok: true,
              value: { ok: false, code: "invalid", message: "工具参数无效。" },
            });
          else
            send({
              protocol: 1,
              ok: false,
              code: error instanceof DomainError ? "forbidden" : "unavailable",
            });
        }
      } catch {
        send({ protocol: 1, ok: false, code: "invalid" });
      }
    };
    socket.on("data", (chunk) => {
      if (started) {
        socket.destroy();
        return;
      }
      size += chunk.length;
      if (size > maxRequest + 4) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      if (length === undefined && size >= 4) {
        const all = Buffer.concat(chunks);
        length = all.readUInt32BE();
        chunks = [all];
      }
      if (length === undefined) return;
      if (length < 2 || length > maxRequest || size > length + 4) {
        socket.destroy();
        return;
      }
      if (size === length + 4) {
        started = true;
        const request = execute(Buffer.concat(chunks).subarray(4));
        chunks = [];
        pending.add(request);
        void request.finally(() => pending.delete(request));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") chmodSync(endpoint, 0o600);
  server.on("error", () => {
    closing = true;
  });
  return {
    async close() {
      if (closing && !server.listening) return;
      closing = true;
      const stopped = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      for (const socket of connections) socket.destroy();
      await Promise.allSettled([...pending]);
      await stopped;
    },
  };
}
