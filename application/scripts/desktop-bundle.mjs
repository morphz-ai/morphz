import { execFileSync, spawnSync } from "node:child_process";
import "./application-configuration.mjs";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  openSync,
  readSync,
  closeSync,
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
function bootstrapSource(config, { legacy = false } = {}) {
  if (
    config.envFile !== undefined &&
    config.envFile !== "" &&
    !isAbsolute(config.envFile)
  )
    throw new Error("服务端环境配置必须是绝对路径。");
  const envName = legacy ? "MORPHZWORK_ENV_FILE" : "MORPHZ_APP_ENV_FILE";
  const profileName = legacy ? "MORPHZWORK_TEST_PROFILE" : "MORPHZ_APP_PROFILE";
  return `const config = ${JSON.stringify(config)};\nprocess.chdir(config.root);\nif (config.envFile !== undefined && process.env.${envName} === undefined) process.env.${envName} = config.envFile;\nif (config.profile && !process.env.${profileName}) process.env.${profileName} = config.profile;\nif (!process.argv.some(arg => arg.startsWith('--center=') || arg.startsWith('--data-dir='))) { if (config.center) process.argv.push('--center=' + config.center); else if (config.dataDir) process.argv.push('--data-dir=' + config.dataDir); }\nif (config.hot && !process.argv.includes('--hot')) process.argv.push('--hot');\nfor (const origin of config.migrateOrigins) if (!process.argv.includes('--migrate-origin=' + origin)) process.argv.push('--migrate-origin=' + origin);\nrequire(require('node:path').join(config.root, 'apps/desktop/main.cjs'));\n`;
}

export function desktopBootstrap(config, options = {}) {
  const source = bootstrapSource(config, options);
  if (options.legacy) return source;
  // Direct bundle launches must honor explicitly supplied legacy settings too.
  const aliases = `if (process.env.MORPHZ_APP_ENV_FILE === undefined && process.env.MORPHZWORK_ENV_FILE !== undefined) process.env.MORPHZ_APP_ENV_FILE = process.env.MORPHZWORK_ENV_FILE;\nif (process.env.MORPHZ_APP_PROFILE === undefined && process.env.MORPHZWORK_TEST_PROFILE !== undefined) process.env.MORPHZ_APP_PROFILE = process.env.MORPHZWORK_TEST_PROFILE;\n`;
  return source
    .replace(
      "process.chdir(config.root);\n",
      "process.chdir(config.root);\n" + aliases,
    )
    .replace(
      "config.profile && !process.env.MORPHZ_APP_PROFILE",
      "config.profile && process.env.MORPHZ_APP_PROFILE === undefined",
    );
}

export function compatibleBootstrap(existing, config) {
  return (
    existing === desktopBootstrap(config) ||
    existing === desktopBootstrap(config, { legacy: true })
  );
}

function metadataStamp(contents, name) {
  const resource = join(contents, "Resources", name);
  const prior = join(contents, name);
  if (existsSync(resource) && existsSync(prior))
    throw new Error("应用包存在两份元数据，不能猜测覆盖；请保留后重建。");
  // Existing signed applications remain byte-for-byte unchanged on launch.
  // Fresh bundles keep ordinary data in Resources, never a nested-code area.
  return existsSync(prior) ? prior : resource;
}

function unsignedCode(signature) {
  return (
    signature.status !== 0 &&
    /code object is not signed at all/.test(signature.stderr ?? "")
  );
}

function sealFreshUnsignedFrameworkChildren(framework) {
  const root = realpathSync(framework);
  const executable = execFileSync(
    "/usr/libexec/PlistBuddy",
    [
      "-c",
      "Print :CFBundleExecutable",
      join(framework, "Resources", "Info.plist"),
    ],
    { encoding: "utf8" },
  ).trim();
  const main = realpathSync(join(framework, executable));
  if (!main.startsWith(root + "/"))
    throw new Error("Fresh framework executable escapes its copied bundle.");
  const magic = new Set([
    "feedface",
    "cefaedfe",
    "feedfacf",
    "cffaedfe",
    "cafebabe",
    "bebafeca",
    "cafebabf",
    "bfbafeca",
  ]);
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      // Follow only ordinary copied directories/files, never a framework link
      // back into node_modules or another application.
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || path === main) continue;
      const header = Buffer.alloc(4);
      const descriptor = openSync(path, "r");
      let length;
      try {
        length = readSync(descriptor, header, 0, 4, 0);
      } finally {
        closeSync(descriptor);
      }
      if (length !== 4 || !magic.has(header.toString("hex"))) continue;
      // CAFEBABE can also identify Java data. The platform inspector must
      // confirm actual Mach-O code before it can acquire a local code seal.
      if (
        !/^Mach-O\b/.test(
          execFileSync("/usr/bin/file", ["--brief", path], {
            encoding: "utf8",
          }),
        )
      )
        continue;
      try {
        execFileSync("/usr/bin/codesign", ["--verify", "--strict", path], {
          stdio: "pipe",
        });
      } catch (failure) {
        const signature = spawnSync(
          "/usr/bin/codesign",
          ["--display", "--verbose=4", path],
          { encoding: "utf8" },
        );
        if (!unsignedCode(signature)) throw failure;
        // No --force: an existing vendor signature is never replaced here.
        execFileSync(
          "/usr/bin/codesign",
          ["--sign", "-", "--timestamp=none", path],
          { stdio: "pipe" },
        );
        execFileSync("/usr/bin/codesign", ["--verify", "--strict", path], {
          stdio: "pipe",
        });
      }
    }
  };
  visit(root);
}

function sealFreshDevelopmentFrameworks(frameworks) {
  for (const entry of readdirSync(frameworks, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".framework")) continue;
    const framework = join(frameworks, entry.name);
    try {
      execFileSync(
        "/usr/bin/codesign",
        ["--verify", "--deep", "--strict", framework],
        {
          stdio: "pipe",
        },
      );
      continue; // Preserve a valid vendor signature; never replace its identity.
    } catch (failure) {
      const signature = spawnSync(
        "/usr/bin/codesign",
        ["--display", "--verbose=4", framework],
        { encoding: "utf8" },
      );
      const linkerOnly =
        signature.status === 0 &&
        signature.stderr.includes("linker-signed") &&
        signature.stderr.includes("Signature=adhoc") &&
        signature.stderr.includes("Sealed Resources=none") &&
        signature.stderr.includes("TeamIdentifier=not set");
      if (!linkerOnly && !unsignedCode(signature)) throw failure;
      // Some development distributions contain valid Mach-O linker signatures
      // but no bundle resource seal. Authenticate the code before adding that
      // missing local ad-hoc seal, only in this newly copied development app.
      // Invalid existing vendor signatures and installed apps are never repaired.
      if (linkerOnly)
        execFileSync(
          "/usr/bin/codesign",
          ["--verify", "--strict", "--ignore-resources", framework],
          { stdio: "pipe" },
        );
      // The pinned Intel Electron development distribution may contain wholly
      // unsigned code. Seal only that new copy's unsigned nested Mach-O files;
      // corrupt signed inputs and every already installed app remain rejected.
      sealFreshUnsignedFrameworkChildren(framework);
      execFileSync(
        "/usr/bin/codesign",
        [
          ...(linkerOnly ? ["--force"] : []),
          "--sign",
          "-",
          "--timestamp=none",
          framework,
        ],
        {
          stdio: "pipe",
        },
      );
      execFileSync(
        "/usr/bin/codesign",
        ["--verify", "--deep", "--strict", framework],
        {
          stdio: "pipe",
        },
      );
    }
  }
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
  envFile = process.env.MORPHZ_APP_ENV_FILE,
} = {}) {
  if (center && dataDir)
    throw new Error("本机数据目录与远端中心不能同时指定。");
  const config = {
    root,
    center,
    dataDir,
    hot,
    profile,
    migrateOrigins,
    envFile,
  };
  const bootstrap = desktopBootstrap(config);
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
  const stamp = metadataStamp(contents, "morphz-electron-version");
  let bundleChanged = false;
  let freshBundle = false;
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
    freshBundle = true;
    writeGenerated(stamp, version);
  }
  const identity = applyMacBundleIdentity(bundle, markChanged);
  const iconSource = join(root, "apps/desktop/assets/morphz.png");
  const iconHash = createHash("sha256")
    .update(readFileSync(iconSource))
    .digest("hex");
  const iconStamp = metadataStamp(contents, "morphz-icon-sha256");
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
  const bootstrapPath = join(appPath, "main.cjs");
  // A naming-only update does not rewrite a compatible installed launcher:
  // changing its signed bytes would invalidate the local ad-hoc TCC grant.
  if (
    !existsSync(bootstrapPath) ||
    !compatibleBootstrap(readFileSync(bootstrapPath, "utf8"), config)
  )
    writeGenerated(bootstrapPath, bootstrap);
  if (bundleChanged) {
    if (freshBundle)
      sealFreshDevelopmentFrameworks(join(contents, "Frameworks"));
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
