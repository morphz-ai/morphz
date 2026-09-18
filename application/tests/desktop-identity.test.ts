import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  applyMacBundleIdentity,
  desktopIdentity,
} = require("../scripts/mac-bundle-identity.mjs");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "morphz-identity-test-"));
  const bundle = join(root, "Morphz.app");
  const entries = [
    { path: bundle, name: "Electron", id: "com.github.Electron" },
    ...["", " (Renderer)", " (Plugin)", " (GPU)", " EH", " NP"].map(
      (suffix) => ({
        path: join(
          bundle,
          "Contents/Frameworks",
          `Electron Helper${suffix}.app`,
        ),
        name: `Electron Helper${suffix}`,
        id: "com.github.Electron.helper",
      }),
    ),
    {
      path: join(
        bundle,
        "Contents/Library/LoginItems/Electron Login Helper.app",
      ),
      name: "Electron Login Helper",
      id: "com.github.Electron.loginhelper",
    },
  ];
  for (const entry of entries) {
    mkdirSync(join(entry.path, "Contents/MacOS"), { recursive: true });
    writeFileSync(
      join(entry.path, "Contents/MacOS", entry.name),
      "binary bytes",
    );
    writeFileSync(
      join(entry.path, "Contents/Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${entry.id}</string>
<key>CFBundleName</key><string>${entry.name}</string>
<key>CFBundleExecutable</key><string>${entry.name}</string>
<key>LSUIElement</key><${entry.path === bundle ? "false" : "true"}/>
<key>UnrelatedKey</key><string>keep this</string>
</dict></plist>`,
    );
  }
  mkdirSync(join(bundle, "Contents/Resources/app"), { recursive: true });
  writeFileSync(
    join(bundle, "Contents/Resources/app/main.cjs"),
    "original profile/center config",
  );
  return { root, bundle, entries };
}

function plist(bundle: string) {
  return JSON.parse(
    execFileSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", join(bundle, "Contents/Info.plist")],
      { encoding: "utf8" },
    ),
  );
}

test(
  "Morphz 系统身份覆盖主程序和所有 Helper，保留启动配置且重复打包不改写",
  { skip: process.platform !== "darwin" },
  () => {
    const { root, bundle } = fixture();
    try {
      let mutations = 0;
      const first = applyMacBundleIdentity(bundle, () => mutations++);
      assert.equal(first.changed, true);
      assert.equal(mutations, 1);
      assert.equal(first.executable, join(bundle, "Contents/MacOS/Morphz"));
      assert.equal(existsSync(join(bundle, "Contents/MacOS/Electron")), false);
      assert.equal(readFileSync(first.executable, "utf8"), "binary bytes");
      const main = plist(bundle);
      assert.equal(main.CFBundleIdentifier, "ai.morphz.desktop");
      assert.equal(main.CFBundleExecutable, "Morphz");
      assert.equal(main.CFBundleDisplayName, "Morphz");
      assert.equal(main.CFBundleIconFile, "morphz.icns");
      assert.equal(main.LSUIElement, false);
      assert.equal(main.LSBackgroundOnly, false);
      assert.equal(main.UnrelatedKey, "keep this");
      assert.equal(first.helpers.length, 7);
      for (const helper of first.helpers) {
        const info = plist(helper);
        assert.ok(
          info.CFBundleIdentifier.startsWith(`${desktopIdentity.bundleId}.`),
        );
        assert.ok(info.CFBundleName.startsWith("Morphz "));
        assert.ok(
          existsSync(join(helper, "Contents/MacOS", info.CFBundleExecutable)),
        );
        assert.equal(info.LSUIElement, true);
        assert.equal(info.UnrelatedKey, "keep this");
      }
      assert.equal(
        readFileSync(join(bundle, "Contents/Resources/app/main.cjs"), "utf8"),
        "original profile/center config",
      );
      const before = [bundle, ...first.helpers].map((path) =>
        readFileSync(join(path, "Contents/Info.plist"), "utf8"),
      );
      const second = applyMacBundleIdentity(bundle, () => {
        throw new Error("Unexpected rewrite");
      });
      assert.equal(second.changed, false);
      assert.deepEqual(second.helpers, first.helpers);
      assert.deepEqual(
        [bundle, ...first.helpers].map((path) =>
          readFileSync(join(path, "Contents/Info.plist"), "utf8"),
        ),
        before,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "运行保护拒绝修改时，主程序、Helper 与旧 plist 都不产生半次迁移",
  { skip: process.platform !== "darwin" },
  () => {
    const { root, bundle, entries } = fixture();
    try {
      const before = entries.map((entry) =>
        readFileSync(join(entry.path, "Contents/Info.plist"), "utf8"),
      );
      assert.throws(
        () =>
          applyMacBundleIdentity(bundle, () => {
            throw new Error("running");
          }),
        /running/,
      );
      assert.deepEqual(
        entries.map((entry) =>
          readFileSync(join(entry.path, "Contents/Info.plist"), "utf8"),
        ),
        before,
      );
      assert.ok(existsSync(join(bundle, "Contents/MacOS/Electron")));
      assert.equal(existsSync(join(bundle, "Contents/MacOS/Morphz")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "共享 Electron 包不作为修改目标，Helper 冲突在所有写入之前拒绝",
  { skip: process.platform !== "darwin" },
  () => {
    assert.throws(
      () => applyMacBundleIdentity("/fixture/node_modules/Electron.app"),
      /不修改共享/,
    );
    const { root, bundle } = fixture();
    try {
      mkdirSync(join(bundle, "Contents/Frameworks/Morphz Helper.app"));
      const before = readFileSync(join(bundle, "Contents/Info.plist"), "utf8");
      assert.throws(() => applyMacBundleIdentity(bundle), /不能覆盖/);
      assert.equal(
        readFileSync(join(bundle, "Contents/Info.plist"), "utf8"),
        before,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
