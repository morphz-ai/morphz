import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
export function dataDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir(),
  exists = existsSync,
): string {
  const paths = platform === "win32" ? win32 : { isAbsolute, join };
  const selected = env.MORPHZ_APP_DATA_DIR ?? env.MORPHZWORK_DATA_DIR;
  if (selected !== undefined) {
    if (!paths.isAbsolute(selected))
      throw new Error("MORPHZ_APP_DATA_DIR 必须是绝对路径。");
    return selected;
  }
  let current: string, legacy: string;
  if (platform === "darwin")
    [current, legacy] = [
      join(home, "Library", "Application Support", "Morphz", "application"),
      join(home, "Library", "Application Support", "MorphzWork"),
    ];
  else if (platform === "win32") {
    if (!env.LOCALAPPDATA || !paths.isAbsolute(env.LOCALAPPDATA))
      throw new Error("缺少有效的 LOCALAPPDATA，无法确定应用数据目录。");
    current = paths.join(env.LOCALAPPDATA, "Morphz", "application");
    legacy = paths.join(env.LOCALAPPDATA, "MorphzWork");
  } else {
    const base =
      env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
        ? env.XDG_DATA_HOME
        : join(home, ".local", "share");
    current = join(base, "morphz", "application");
    legacy = join(base, "morphzwork");
  }
  const hasCenter = (directory: string) =>
    ["workspace.sqlite", "runtime.json"].some((name) =>
      exists(paths.join(directory, name)),
    );
  if (hasCenter(current) && hasCenter(legacy))
    throw new Error(
      "发现两份应用数据；请用 MORPHZ_APP_DATA_DIR 明确选择，未移动或合并数据。",
    );
  return hasCenter(legacy) ? legacy : current;
}
