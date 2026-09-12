import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

// Read configuration only in the center process, not in Vite or the renderer.
// A project .env is not permission to replace PATH, NODE_OPTIONS or other settings.
const privateKeys = ["DOUBAO_API_KEY"] as const;

export function defaultEnvironmentFile(moduleURL = import.meta.url): string {
  const compiled = new URL(moduleURL).pathname.includes("/dist/service/");
  return fileURLToPath(
    new URL(compiled ? "../../../../../.env" : "../../../.env", moduleURL),
  );
}

export function loadServiceEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  filename: string = defaultEnvironmentFile(),
): void {
  // An explicit empty path disables project configuration in isolated tests.
  const selected = env.MORPHZWORK_ENV_FILE ?? filename;
  if (selected === "") return;
  if (!isAbsolute(selected))
    throw new Error("MORPHZWORK_ENV_FILE 必须是绝对路径。");
  let source: string;
  try {
    source = readFileSync(selected, "utf8");
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      env.MORPHZWORK_ENV_FILE === undefined
    )
      return;
    // Do not attach a cause or print configuration text in an error report.
    throw new Error("无法读取服务端环境配置文件，请检查路径与权限。");
  }
  if (Buffer.byteLength(source, "utf8") > 128 * 1024)
    throw new Error("服务端环境配置文件超过大小限制。");
  let parsed: ReturnType<typeof parseEnv>;
  try {
    parsed = parseEnv(source);
  } catch {
    throw new Error("服务端环境配置格式无效，请检查 .env 格式。");
  }
  for (const key of privateKeys) {
    // A value supplied by the host (including an intentional blank) wins.
    if (env[key] !== undefined || parsed[key] === undefined) continue;
    env[key] = parsed[key].trim();
  }
}
