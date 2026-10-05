/** Explicit historical compatibility smoke. Not part of default npm test.
 * Requires the genuine retained Git revision; missing history fails, never
 * fetches, substitutes a copied parser, or silently skips this evidence. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../packages/application/src/store.js";

test(
  "actual committed19 reader strips future source but preserves IO10; actual old Store rejects20",
  { timeout: 60_000 },
  () => {
    // Controlled downlevel Host/transport evidence, not a model or paid Runtime.
    const revision = "3e19256a813a0fde80e074ffb043095c40d95425";
    const applicationRoot = fileURLToPath(new URL("../", import.meta.url));
    const repository = join(applicationRoot, "..");
    const directory = mkdtempSync(
      join(tmpdir(), "morphz-cognitive-old-reader-"),
    );
    const filename = join(directory, "new-transport.sqlite");
    const locator = {
      contentId: "content_exact",
      projectId: "project_exact",
      connectionId: "connection_exact",
      authority: {
        appId: "example.notes",
        version: "1.0.0",
        definitionHash: "a".repeat(64),
        instanceId: "instance_exact",
        serviceId: "service/笔记",
        dataAuthorityId: "data:原件",
      },
      object: {
        objectId: "笔记/0001",
        versionRef: "000900719925474099312345\n版本",
      },
    };
    try {
      const archive = execFileSync(
        "git",
        ["archive", revision, "application"],
        { cwd: repository, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
      );
      execFileSync("tar", ["-xf", "-", "-C", directory], {
        input: archive,
        timeout: 10_000,
      });
      symlinkSync(
        join(applicationRoot, "node_modules"),
        join(directory, "application/node_modules"),
        "dir",
      );
      const store = new WorkspaceStore(filename, { mode: "transport" });
      store.close();
      const witness = `
      import assert from 'node:assert/strict';
      import { platformRuntimeHostFixture } from './application/tests/platform-runtime-host-fixture.ts';
      import { WorkspaceStore } from './application/packages/application/src/store.ts';
      assert.throws(() => new WorkspaceStore(${JSON.stringify(filename)}, {mode:'transport'}), /版本高于/);
      const f = await platformRuntimeHostFixture();
      try {
        const id = (await f.session().platformMessage({commandId:${JSON.stringify(randomUUID())},operation:{type:'record-input',projectId:f.projectId,artifactId:null,artifactRevision:null,selection:'',body:'old-reader controlled future envelope',targetActantId:'morphz-agent'}})).entityId;
        const ledger = f.store.runtimeState(); const row = ledger.deliveries[0];
        const locator = ${JSON.stringify(locator)}; locator.projectId = f.projectId;
        row.platformSource.cognitiveObject = locator;
        row.request.message.format.version = '10';
        row.request.message.content.value.cognitiveObject = locator;
        const original = JSON.stringify(row.request); row.state = 'failed';
        f.store.saveRuntimeState(ledger); await f.reopen();
        const reopened = f.runtime.state.deliveries[0];
        assert.equal(reopened.platformSource.cognitiveObject, undefined);
        assert.equal(JSON.stringify(reopened.request), original);
        await f.runtime.retryPlatformInput(id);
        assert.equal(f.store.runtimeState().deliveries[0].state, 'queued');
        console.log('old-reader witness: source stripped, IO10 preserved, old retry admitted; old Store20 rejected');
      } finally { await f.close(); }
    `;
      const script = join(directory, "witness.mjs");
      writeFileSync(script, witness);
      const env: NodeJS.ProcessEnv = { NODE_NO_WARNINGS: "1" };
      for (const key of ["PATH", "HOME", "TMPDIR"])
        if (process.env[key] !== undefined) env[key] = process.env[key];
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          join(applicationRoot, "node_modules/tsx/dist/loader.mjs"),
          script,
        ],
        {
          cwd: directory,
          env,
          timeout: 45_000,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        },
      );
      assert.match(
        output,
        /source stripped, IO10 preserved, old retry admitted/,
      );
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        assert.equal(
          (db.prepare("PRAGMA user_version").get() as { user_version: number })
            .user_version,
          20,
        );
      } finally {
        db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
