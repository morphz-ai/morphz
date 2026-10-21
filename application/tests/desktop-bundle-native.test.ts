import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Electron dependency, lockfile and lifecycle approval use one exact version", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const lock = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  const version = manifest.devDependencies.electron;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.packages[""].devDependencies.electron, version);
  assert.equal(lock.packages["node_modules/electron"].version, version);
  assert.deepEqual(
    Object.entries(manifest.allowScripts).filter(([name]) =>
      name.startsWith("electron@"),
    ),
    [[`electron@${version}`, true]],
  );
});

test(
  "fresh macOS development bundle seals the actual engine and unchanged reopen preserves every signed byte",
  { skip: process.platform !== "darwin", timeout: 90000 },
  () => {
    const fixture = mkdtempSync(join(tmpdir(), "morphz-native-bundle-test-"));
    try {
      const bundler = new URL("../scripts/desktop-bundle.mjs", import.meta.url)
        .href;
      // Only this isolated child substitutes a generated home for the bundler.
      // No HOME mutation, app launch, real profile, or original bundle writes.
      const source = `
        import os from 'node:os';
        import { mock } from 'node:test';
        import { syncBuiltinESMExports } from 'node:module';
        import { execFileSync } from 'node:child_process';
        import { readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs';
        import { createHash } from 'node:crypto';
        import { join } from 'node:path';
        import assert from 'node:assert/strict';
        const fixture = ${JSON.stringify(fixture)};
        mock.method(os, 'homedir', () => fixture);
        syncBuiltinESMExports();
        const { prepareDesktop } = await import(${JSON.stringify(bundler)});
        const config = { dataDir: join(fixture, 'automated-data'), profile: 'automated-native-bundle', envFile: '' };
        const first = prepareDesktop(config);
        execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', first.bundle]);
        const contents = join(first.bundle, 'Contents');
        assert.equal(readFileSync(join(contents, 'Resources/morphz-electron-version'), 'utf8').trim(), JSON.parse(readFileSync(new URL('../node_modules/electron/package.json', ${JSON.stringify(bundler)}), 'utf8')).version);
        assert.equal(readdirSync(contents).includes('morphz-icon-sha256'), false);
        assert.equal(readdirSync(contents).includes('morphz-electron-version'), false);
        const signature = join(contents, '_CodeSignature/CodeResources');
        const launcher = join(contents, 'Resources/app/main.cjs');
        const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
        const before = [digest(signature), digest(launcher), statSync(first.bundle).mtimeMs];
        const again = prepareDesktop(config);
        assert.deepEqual(again, first);
        assert.deepEqual([digest(signature), digest(launcher), statSync(first.bundle).mtimeMs], before);
        // A previously sealed framework that changes is rejected, not quietly
        // re-signed as if it were an unsealed fresh development distribution.
        const frameworkInfo = join(contents, 'Frameworks/Electron Framework.framework/Resources/Info.plist');
        const frameworkBytes = readFileSync(frameworkInfo);
        const changedFrameworkBytes = Buffer.concat([frameworkBytes, Buffer.from([10])]);
        writeFileSync(frameworkInfo, changedFrameworkBytes);
        assert.throws(() => prepareDesktop(config));
        assert.deepEqual(readFileSync(frameworkInfo), changedFrameworkBytes);
        writeFileSync(frameworkInfo, frameworkBytes);
        execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', first.bundle]);
        // A mismatched engine is refused without rewriting the signed launcher.
        writeFileSync(join(contents, 'Resources/morphz-electron-version'), '0.0.0');
        assert.throws(() => prepareDesktop(config), /Electron 已更新/);
        assert.equal(digest(launcher), before[1]);
        console.log(JSON.stringify({ signatureVerified: true, unchangedReopen: true, tamperedFrameworkRejected: true, versionGuard: true, originalModified: false }));
      `;
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          ["--input-type=module", "--eval", source],
          {
            cwd: new URL("../", import.meta.url),
            encoding: "utf8",
            timeout: 85000,
          },
        ),
      );
      assert.deepEqual(result, {
        signatureVerified: true,
        unchangedReopen: true,
        tamperedFrameworkRejected: true,
        versionGuard: true,
        originalModified: false,
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);
