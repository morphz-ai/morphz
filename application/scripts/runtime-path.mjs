import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Source checkout location, not the caller's working directory or a sibling repo.
export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export function runtimeBinaryPath(
  env = process.env,
  {
    root = repositoryRoot,
    cwd = process.cwd(),
    platform = process.platform,
  } = {},
) {
  const configured =
    env.MORPHZ_APP_RUNTIME_BINARY ?? env.MORPHZWORK_RUNTIME_BINARY;
  if (configured !== undefined) {
    if (!configured.trim())
      throw new Error("MORPHZ_APP_RUNTIME_BINARY must name an executable path");
    return resolve(cwd, configured);
  }
  return join(
    root,
    "target",
    "debug",
    platform === "win32" ? "morphz.exe" : "morphz",
  );
}
