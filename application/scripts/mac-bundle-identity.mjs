import { execFileSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

export const desktopIdentity = Object.freeze({
  name: "Morphz",
  bundleId: "ai.morphz.desktop",
  helperBundleId: "ai.morphz.desktop.helper",
});

const helperSuffixes = [
  " Helper",
  " Helper (Renderer)",
  " Helper (Plugin)",
  " Helper (GPU)",
  " Helper EH",
  " Helper NP",
];

function readPlist(path) {
  return JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
      encoding: "utf8",
    }),
  );
}

function planEntry(
  directory,
  oldName,
  name,
  identifier,
  extra = {},
  oldExecutableName = oldName,
) {
  const oldBundle = join(directory, `${oldName}.app`);
  const bundle = join(directory, `${name}.app`);
  if (oldBundle !== bundle && existsSync(oldBundle) && existsSync(bundle))
    throw new Error(`辅助程序存在新旧两份，不能覆盖：${name}`);
  const sourceBundle = existsSync(oldBundle) ? oldBundle : bundle;
  if (!existsSync(sourceBundle)) return undefined;
  const contents = join(sourceBundle, "Contents");
  const plist = join(contents, "Info.plist");
  const current = readPlist(plist);
  const expected = {
    CFBundleIdentifier: identifier,
    CFBundleName: name,
    CFBundleDisplayName: name,
    CFBundleExecutable: name,
    NSMicrophoneUsageDescription:
      "Morphz 在你开始听写或录音转文字时使用麦克风。",
    ...extra,
  };
  const oldExecutable = join(contents, "MacOS", oldExecutableName);
  const executable = join(contents, "MacOS", name);
  if (
    oldExecutable !== executable &&
    existsSync(oldExecutable) &&
    existsSync(executable)
  )
    throw new Error(`主程序存在新旧两份，不能覆盖：${name}`);
  const sourceExecutable = existsSync(oldExecutable)
    ? oldExecutable
    : executable;
  if (!existsSync(sourceExecutable))
    throw new Error(`应用包缺少可执行文件：${name}`);
  const changes = Object.entries(expected).filter(
    ([key, value]) => current[key] !== value,
  );
  return {
    sourceBundle,
    bundle,
    sourceExecutable,
    executable,
    plist,
    current,
    changes,
    changed:
      sourceBundle !== bundle ||
      sourceExecutable !== executable ||
      changes.length > 0,
  };
}

// Follow Electron Packager's main/helper plist and executable naming contract:
// https://github.com/electron/packager/blob/v19.0.1/src/mac.ts
// Framework names/install paths stay Electron's; they are third-party code,
// not the application's OS identity. Never modify the shared Electron.app.
export function applyMacBundleIdentity(bundle, beforeChange = () => {}) {
  if (!isAbsolute(bundle) || basename(bundle) !== "Morphz.app")
    throw new Error("只修正生成的 Morphz.app，不修改共享 Electron.app。");
  const main = planEntry(
    join(bundle, ".."),
    "Morphz",
    "Morphz",
    desktopIdentity.bundleId,
    {
      CFBundleIconFile: "morphz.icns",
      LSUIElement: false,
      LSBackgroundOnly: false,
    },
    "Electron",
  );
  if (!main) throw new Error("Morphz 应用包不存在。");
  const frameworks = join(bundle, "Contents", "Frameworks");
  const helpers = helperSuffixes
    .map((suffix) =>
      planEntry(
        frameworks,
        `Electron${suffix}`,
        `Morphz${suffix}`,
        `${desktopIdentity.helperBundleId}${suffix === " Helper EH" ? ".EH" : suffix === " Helper NP" ? ".NP" : ""}`,
      ),
    )
    .filter(Boolean);
  if (
    !helpers.some((helper) => basename(helper.bundle) === "Morphz Helper.app")
  )
    throw new Error("应用包缺少必需的 Morphz Helper。");
  const login = planEntry(
    join(bundle, "Contents", "Library", "LoginItems"),
    "Electron Login Helper",
    "Morphz Login Helper",
    `${desktopIdentity.bundleId}.loginhelper`,
  );
  const entries = [...helpers, ...(login ? [login] : []), main];
  const changed = entries.some((entry) => entry.changed);
  // Validate the entire plan before any rename or plist write, and let the
  // launcher refuse changes while this same application is running.
  if (changed) beforeChange();
  for (const entry of entries) {
    for (const [key, value] of entry.changes) {
      const exists = Object.hasOwn(entry.current, key);
      const type = typeof value === "boolean" ? "bool" : "string";
      execFileSync("/usr/libexec/PlistBuddy", [
        "-c",
        `${exists ? "Set" : "Add"} :${key}${exists ? "" : ` ${type}`} ${value}`,
        entry.plist,
      ]);
    }
    if (entry.sourceExecutable !== entry.executable)
      renameSync(entry.sourceExecutable, entry.executable);
    if (entry.sourceBundle !== entry.bundle)
      renameSync(entry.sourceBundle, entry.bundle);
  }
  return {
    changed,
    executable: main.executable,
    helpers: entries
      .filter((entry) => entry !== main)
      .map((entry) => entry.bundle),
  };
}
