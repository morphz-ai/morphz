// Local development setup: reuse credentials from one explicitly selected running Runtime.
// Nothing secret is printed or stored in the repository / browser.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { dataDirectory } from "../packages/application/src/paths.ts";
import { randomUUID } from "node:crypto";
const pid = process.argv[2],
  origin = new URL(process.argv[3]);
if (
  !/^\d+$/.test(pid ?? "") ||
  origin.protocol !== "http:" ||
  origin.hostname !== "127.0.0.1" ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash ||
  origin.username ||
  origin.password
)
  throw new Error(
    "Usage: node scripts/connect-local-runtime.mjs <morphz-pid> http://127.0.0.1:<port>",
  );
const command = execFileSync("ps", ["-p", pid, "-o", "command="], {
  encoding: "utf8",
});
if (!/(?:^|\/)morphz\s/.test(command.trim()))
  throw new Error("所选进程不是 Morphz。");
const environment = execFileSync("ps", ["eww", "-p", pid, "-o", "command="], {
  encoding: "utf8",
});
const token = environment.match(/(?:^|\s)MORPHZ_DASHBOARD_TOKEN=([^\s]+)/)?.[1];
if (!token) throw new Error("该进程没有可复用的 Dashboard 凭据。");
const response = await fetch(origin.origin + "/api/status", {
  headers: { Authorization: `Bearer ${token}` },
  redirect: "error",
  signal: AbortSignal.timeout(5000),
});
if (!response.ok) throw new Error("Runtime 验证失败，未保存连接。");
const status = await response.json();
if (status.identity_mode !== "default")
  throw new Error("此开发连接器仅用于本机单用户 Runtime。");
const directory = dataDirectory();
mkdirSync(directory, { recursive: true, mode: 0o700 });
const filename = join(directory, "runtime.json");
const old = existsSync(filename)
  ? JSON.parse(readFileSync(filename, "utf8"))
  : null;
if (old && old.url !== origin.origin)
  throw new Error("已有其他 Runtime 连接，请勿覆盖。");
writeFileSync(
  filename,
  JSON.stringify({
    url: origin.origin,
    token,
    namespace: old?.namespace ?? randomUUID(),
  }),
  { mode: 0o600 },
);
chmodSync(filename, 0o600);
console.log(
  `已验证本机 Runtime，模型 ${status.model}。凭据保存在应用私有数据目录，未输出。`,
);
