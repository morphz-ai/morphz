import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  applyMacBundleIdentity,
  desktopIdentity,
} from "./mac-bundle-identity.mjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));

// Store a configuration file reference, never its contents. Finder/Dock launches
// do not inherit the shell that previously hosted the application's service.
export function desktopBootstrap(config) {
  if (
    config.envFile !== undefined &&
    config.envFile !== "" &&
    !isAbsolute(config.envFile)
  )
    throw new Error("服务端环境配置必须是绝对路径。");
  return `const config = ${JSON.stringify(config)};\nprocess.chdir(config.root);\nif (config.envFile !== undefined && process.env.MORPHZWORK_ENV_FILE === undefined) process.env.MORPHZWORK_ENV_FILE = config.envFile;\nif (config.profile && !process.env.MORPHZWORK_TEST_PROFILE) process.env.MORPHZWORK_TEST_PROFILE = config.profile;\nif (!process.argv.some(arg => arg.startsWith('--center=') || arg.startsWith('--data-dir='))) { if (config.center) process.argv.push('--center=' + config.center); else if (config.dataDir) process.argv.push('--data-dir=' + config.dataDir); }\nif (config.hot && !process.argv.includes('--hot')) process.argv.push('--hot');\nfor (const origin of config.migrateOrigins) if (!process.argv.includes('--migrate-origin=' + origin)) process.argv.push('--migrate-origin=' + origin);\nrequire(require('node:path').join(config.root, 'apps/desktop/main.cjs'));\n`;
}

// A local development bundle, not a Developer ID signed/distributable release.
// Give this application its own OS identity; never modify shared Electron.app,
// move the existing user profile, or change the selected center as a brand edit.
export function prepareDesktop({
  center,
  dataDir,
  hot = false,
  profile,
  migrateOrigins = [],
  envFile = process.env.MORPHZWORK_ENV_FILE,
} = {}) {
  if (center && dataDir)
    throw new Error("本机数据目录与远端中心不能同时指定。");
  const bootstrap = desktopBootstrap({
    root,
    center,
    dataDir,
    hot,
    profile,
    migrateOrigins,
    envFile,
  });
  if (process.platform !== "darwin")
    return {
      executable: require("electron"),
      args: [
        join(root, "apps/desktop/main.cjs"),
        ...(center ? [`--center=${center}`] : []),
        ...(dataDir ? [`--data-dir=${dataDir}`] : []),
        ...migrateOrigins.map((origin) => `--migrate-origin=${origin}`),
        ...(hot ? ["--hot"] : []),
      ],
    };
  const source = dirname(dirname(dirname(require("electron"))));
  // The app is a persistent desktop installation, even when its development
  // source tree lives under /tmp. Keep OS discovery/TCC lookup on a stable app
  // path; dataDir/profile remain the original, independently selected paths.
  const bundle = join(homedir(), "Applications", "Morphz.app");
  const contents = join(bundle, "Contents");
  const resources = join(contents, "Resources");
  const version = require("electron/package.json").version;
  const stamp = join(contents, "morphz-electron-version");
  let bundleChanged = false;
  const markChanged = () => {
    if (bundleChanged) return;
    const paths = existsSync(bundle)
      ? [bundle, realpathSync(bundle)]
      : [bundle];
    const running = execFileSync("/bin/ps", ["-axo", "command="], {
      encoding: "utf8",
    })
      .split("\n")
      .some((command) =>
        paths.some((path) =>
          command.trimStart().startsWith(`${path}/Contents/MacOS/`),
        ),
      );
    if (running)
      throw new Error(
        "Morphz 正在运行；先正常退出后再更新应用包，不在运行中修改签名。",
      );
    bundleChanged = true;
  };
  const writeGenerated = (path, value) => {
    if (existsSync(path) && readFileSync(path, "utf8") === value) return;
    markChanged();
    writeFileSync(path, value);
  };
  if (existsSync(stamp) && readFileSync(stamp, "utf8") !== version)
    throw new Error(
      "Electron 已更新；请正常退出桌面，保留旧 Morphz.app 后再重建。",
    );
  if (!existsSync(stamp)) {
    if (existsSync(bundle))
      throw new Error("发现未完成的 Morphz 开发包，请先移走后重建。");
    markChanged();
    mkdirSync(dirname(bundle), { recursive: true });
    // Framework links must stay relative and inside the copied bundle; resolving
    // them would point signing/loading back into the shared Electron installation.
    cpSync(source, bundle, { recursive: true, verbatimSymlinks: true });
    writeGenerated(stamp, version);
  }
  const identity = applyMacBundleIdentity(bundle, markChanged);
  const iconSource = join(root, "apps/desktop/assets/morphz.png");
  const iconHash = createHash("sha256")
    .update(readFileSync(iconSource))
    .digest("hex");
  const iconStamp = join(contents, "morphz-icon-sha256");
  if (
    !existsSync(iconStamp) ||
    readFileSync(iconStamp, "utf8") !== iconHash ||
    !existsSync(join(resources, "morphz.icns"))
  ) {
    markChanged();
    const iconset = join(root, "dist/desktop/morphz.iconset");
    mkdirSync(iconset, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        execFileSync(
          "/usr/bin/sips",
          [
            "-z",
            String(size * scale),
            String(size * scale),
            iconSource,
            "--out",
            join(
              iconset,
              `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`,
            ),
          ],
          { stdio: "ignore" },
        );
      }
    }
    execFileSync("/usr/bin/iconutil", [
      "-c",
      "icns",
      iconset,
      "-o",
      join(resources, "morphz.icns"),
    ]);
    writeGenerated(iconStamp, iconHash);
  }
  const appPath = join(resources, "app");
  mkdirSync(appPath, { recursive: true });
  writeGenerated(
    join(appPath, "package.json"),
    JSON.stringify({
      name: "morphz",
      productName: "Morphz",
      version: "0.0.0",
      main: "main.cjs",
      morphzDevelopmentBundle: true,
    }),
  );
  // Persist only launch configuration, never service credentials. Reopening the
  // Dock item after quitting returns to this same source tree and center.
  writeGenerated(join(appPath, "main.cjs"), bootstrap);
  if (bundleChanged) {
    // Sign changed nested application identities before the outer app, without
    // replacing the unmodified third-party framework's signature. Explicit IDs
    // prevent codesign from retaining the old com.github.Electron identifier.
    for (const helper of identity.helpers) {
      const identifier = execFileSync(
        "/usr/libexec/PlistBuddy",
        [
          "-c",
          "Print :CFBundleIdentifier",
          join(helper, "Contents/Info.plist"),
        ],
        { encoding: "utf8" },
      ).trim();
      execFileSync(
        "/usr/bin/codesign",
        [
          "--force",
          "--sign",
          "-",
          "--identifier",
          identifier,
          "--timestamp=none",
          helper,
        ],
        { stdio: "pipe" },
      );
    }
    execFileSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        "-",
        "--identifier",
        desktopIdentity.bundleId,
        "--timestamp=none",
        bundle,
      ],
      { stdio: "pipe" },
    );
  }
  // Unchanged launches never rewrite/resign the app or weaken its designated
  // requirement to an identifier-only check. Ad-hoc builds are local-only;
  // actual code/resource changes can still require renewed macOS permission.
  execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", bundle],
    { stdio: "pipe" },
  );
  // Finder/Launch Services and app consumers can cache bundle metadata using
  // the outer directory's mtime, which editing Contents/Info.plist does not
  // change. Publish the completed metadata update only after signing succeeds.
  if (bundleChanged) {
    const now = new Date();
    utimesSync(bundle, now, now);
  }
  return { executable: identity.executable, args: [], bundle };
}
