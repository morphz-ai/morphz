/** Explicit historical evidence, not default npm-test coverage. Missing genuine
 * history fails; no fetch, copied old parser or silent optional skip. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../packages/application/src/store.js";

test(
  "genuine Host20 loses explicit application target while retaining IO11; rejects Host21 before ledger read",
  { timeout: 60_000 },
  () => {
    const revision = "621c400f";
    const applicationRoot = fileURLToPath(new URL("../", import.meta.url));
    const directory = mkdtempSync(
      join(tmpdir(), "morphz-cognitive-target-old-reader-"),
    );
    const filename = join(directory, "new-transport.sqlite");
    try {
      const archive = execFileSync(
        "git",
        ["archive", revision, "application"],
        {
          cwd: join(applicationRoot, ".."),
          timeout: 10_000,
          maxBuffer: 64 * 1024 * 1024,
        },
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
      const current = new WorkspaceStore(filename, { mode: "transport" });
      current.close();
      const witness = `
      import assert from 'node:assert/strict';
      import {readFileSync} from 'node:fs';
      import {platformRuntimeHostFixture} from './application/tests/platform-runtime-host-fixture.ts';
      import {WorkspaceStore} from './application/packages/application/src/store.ts';
      import {localAccess} from './application/packages/core/src/model.ts';
      assert.throws(()=>new WorkspaceStore(${JSON.stringify(filename)},{mode:'transport'}),/版本高于/);
      const f=await platformRuntimeHostFixture();
      try {
        const definition=JSON.parse(readFileSync('./application/examples/cognitive-notes/definition.json','utf8'));
        const own=(fn)=>f.domains.content.authority.withSession(localAccess,()=>{},a=>fn(f.domains.content.platform,a));
        const installed=await own((p,a)=>p.installCognitiveApp(a,{definition}));
        await own((p,a)=>p.changeCognitiveAppGrant(a,{appId:definition.id,version:definition.version,expectedRevision:0,state:'active'}));
        const connection=await own((p,a)=>p.createVerifiedCognitiveAppConnection(a,{connectionId:'target_connection',expectedRevision:0,proof:{purpose:'connection-setup',appId:definition.id,version:definition.version,definitionHash:installed.definitionHash,serviceId:'service/notes',dataAuthorityId:'database:notes',hostBindingId:'controlled_metadata_only'}}));
        const id=(await f.session().platformMessage({commandId:${JSON.stringify(randomUUID())},operation:{type:'record-input',projectId:f.projectId,artifactId:null,artifactRevision:null,selection:'',body:'controlled future target',targetActantId:'morphz-agent'}})).entityId;
        const ledger=f.store.runtimeState(), row=ledger.deliveries[0];
        const target={connectionId:connection.connectionId,authority:{appId:definition.id,version:definition.version,definitionHash:installed.definitionHash,instanceId:connection.instanceId,serviceId:connection.serviceId,dataAuthorityId:connection.dataAuthorityId}};
        row.platformSource.cognitiveApplication=target;
        row.platformSource.application={instanceId:connection.instanceId,id:definition.id,version:definition.version,harness:definition.harness};
        row.request.client_metadata.source=structuredClone(row.platformSource);
        row.request.message.format.version='11'; row.request.message.content.value.cognitiveApplication=target; row.request.message.content.value.cognitiveObject=null;
        const original=JSON.stringify(row.request);row.state='failed';f.store.saveRuntimeState(ledger);
        await own((p,a)=>p.changeCognitiveAppGrant(a,{appId:definition.id,version:definition.version,expectedRevision:1,state:'disabled'}));
        await f.reopen();
        const reopened=f.runtime.state.deliveries[0];assert.equal(reopened.platformSource.cognitiveApplication,undefined);
        assert.deepEqual(reopened.platformSource.application,row.platformSource.application);assert.equal(JSON.stringify(reopened.request),original);
        await f.runtime.as(localAccess,()=>f.runtime.retryPlatformInput(id));
        assert.equal(f.store.runtimeState().deliveries[0].state,'queued');
        console.log('genuine Host20: target lost; application/request retained; withdrawn-target retry admitted; Host21 rejected before read');
      } finally {await f.close();}
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
          timeout: 40_000,
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
        },
      );
      assert.match(
        output,
        /target lost; application\/request retained; withdrawn-target retry admitted; Host21 rejected/,
      );
      console.log(output.trim());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
