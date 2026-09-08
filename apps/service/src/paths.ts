import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
export function dataDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir(),
): string {
  const paths = platform === "win32" ? win32 : { isAbsolute, join };
  if (env.MORPHZWORK_DATA_DIR) {
    if (!paths.isAbsolute(env.MORPHZWORK_DATA_DIR))
      throw new Error("MORPHZWORK_DATA_DIR 必须是绝对路径。");
    return env.MORPHZWORK_DATA_DIR;
  }
  if (platform === "darwin")
    return join(home, "Library", "Application Support", "MorphzWork");
  if (platform === "win32") {
    if (!env.LOCALAPPDATA || !paths.isAbsolute(env.LOCALAPPDATA))
      throw new Error("缺少有效的 LOCALAPPDATA，无法确定应用数据目录。");
    return paths.join(env.LOCALAPPDATA, "MorphzWork");
  }
  return join(
    env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : join(home, ".local", "share"),
    "morphzwork",
  );
}
