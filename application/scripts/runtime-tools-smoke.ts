/** Real Runtime integration of the current Platform/App storage paths.
 * Each acceptance owns fresh databases and a synthetic local provider. The
 * retired whole-workspace HTTP fixture is deliberately not a fallback. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

if (process.argv.length > 2)
  throw new Error("此联合验收只使用隔离数据和本机合成模型，不接受 live 参数。");

const applicationRoot = fileURLToPath(new URL("../", import.meta.url));
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      (!name.startsWith("MORPHZ_APP_") ||
        name === "MORPHZ_APP_RUNTIME_BINARY") &&
      !name.startsWith("MORPHZWORK_") &&
      name !== "DOUBAO_API_KEY",
  ),
);

for (const script of [
  "platform-message-runtime-smoke.ts",
  "platform-task-runtime-smoke.ts",
  "runtime-ipc-smoke.ts",
]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(applicationRoot, "scripts", script)],
      { cwd: applicationRoot, env: environment, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} 验收失败：${signal ?? code}`));
    });
  });
}
