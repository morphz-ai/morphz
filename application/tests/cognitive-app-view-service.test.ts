import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCognitiveAppViewService } from "../packages/application/src/cognitive-app-view-service.js";
import { CognitiveAppServiceError } from "../packages/application/src/cognitive-app-service.js";
import {
  alice,
  bob,
  agent,
  isolatedView,
  prepareView,
} from "./fixtures/cognitive-app-view-service-fixture.js";

const denied = (reason: string, commandId?: string) => (error: unknown) => {
  assert.ok(error instanceof CognitiveAppServiceError);
  assert.equal(error.reason, reason);
  assert.equal(error.commandId, commandId);
  assert.equal(error.message.includes("private_"), false);
  assert.equal("cause" in error, false);
  return true;
};
const cas = (receipt: {
  viewId: string;
  viewRevision: number;
  bindingRevision: number;
}) => ({
  viewId: receipt.viewId,
  expectedViewRevision: receipt.viewRevision,
  expectedBindingRevision: receipt.bindingRevision,
});

test("the independent Human window facade exists", () => {
  assert.equal(typeof createCognitiveAppViewService, "function");
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(`actual connection disable and lost project membership never inherit metadata byte permission on ${backend}`, async () =>
    isolatedView(backend, async (f) => {
      const p = await prepareView(f),
        launched = await f.service.launch(bob, p.launch),
        request = cas(launched.receipt);
      await f.platform.changeCognitiveAppConnectionState(bob, {
        appId: p.launch.appId,
        version: p.launch.version,
        connectionId: p.launch.connectionId,
        expectedRevision: 1,
        state: "disabled",
      });
      assert.equal(
        (await f.service.read(bob, { viewId: "view-bob" })).binding
          .connectionId,
        p.launch.connectionId,
      );
      await assert.rejects(f.service.readUi(bob, request), denied("forbidden"));
      await assert.rejects(
        f.service.save(bob, {
          ...request,
          commandId: "disabled-connection-save",
          state: {},
        }),
        denied("forbidden", "disabled-connection-save"),
      );
      await f.platform.changeCognitiveAppConnectionState(bob, {
        appId: p.launch.appId,
        version: p.launch.version,
        connectionId: p.launch.connectionId,
        expectedRevision: 2,
        state: "active",
      });
      const gate = f.platform.prepareCognitiveAppUiRead.bind(f.platform);
      let calls = 0;
      f.platform.prepareCognitiveAppUiRead = async (...args) => {
        const result = await gate(...args);
        if (++calls === 3)
          await f.q.change(
            "DELETE FROM project_members WHERE tenant_id='tenant-a' AND project_id='project-a' AND principal_id='bob'",
            [],
          );
        return result;
      };
      await assert.rejects(f.service.readUi(bob, request), denied("forbidden"));
      assert.equal(calls, 3);
      f.platform.prepareCognitiveAppUiRead = gate;
      await assert.rejects(
        f.service.read(bob, { viewId: "view-bob" }),
        denied("forbidden"),
      );
      await assert.rejects(
        f.service.close(bob, { ...request, commandId: "lost-project-close" }),
        denied("forbidden", "lost-project-close"),
      );
      assert.equal(Reflect.get(f.ui, "scopes").size, 0);
    }));

  test(`actual Human six-method lifecycle preserves original receipts, exact binding and cold reopen on ${backend}`, async () =>
    isolatedView(backend, async (f) => {
      const p = await prepareView(f);
      const rows = await f.q.all("SELECT * FROM app_ui_packages");
      const launched = await f.service.launch(bob, p.launch);
      assert.deepEqual(launched, {
        receipt: { viewId: "view-bob", viewRevision: 1, bindingRevision: 1 },
        replayed: false,
      });
      const state = { view: "list" };
      const save = {
        ...cas(launched.receipt),
        commandId: "save-original",
        state,
      };
      const saved = await f.service.save(bob, save);
      assert.equal(saved.receipt.viewRevision, 2);
      const read = await f.service.read(bob, {
        viewId: launched.receipt.viewId,
      });
      assert.deepEqual(read.view.state, state);
      const replay = await f.service.launch(bob, p.launch);
      assert.deepEqual(replay, { receipt: launched.receipt, replayed: true });
      assert.equal(
        (await f.service.read(bob, { viewId: "view-bob" })).view.revision,
        2,
      );
      const ui = await f.service.readUi(bob, cas(saved.receipt));
      assert.deepEqual(ui.manifest, p.input.manifest);
      assert.deepEqual(ui.definition, p.input.definition);
      assert.equal(ui.authority.definitionHash, p.installed.definitionHash);
      assert.equal(ui.authority.instanceId, p.connection.instanceId);
      const bound = await f.service.bind(bob, {
        ...p.launch,
        ...cas(saved.receipt),
        commandId: "bind-other",
        connectionId: p.other.connectionId,
        expectedConnectionRevision: p.other.revision,
      });
      assert.deepEqual(bound.receipt, {
        viewId: "view-bob",
        viewRevision: 3,
        bindingRevision: 2,
      });
      assert.deepEqual(
        (await f.service.read(bob, { viewId: "view-bob" })).view.state,
        {},
      );
      await assert.rejects(
        f.service.readUi(bob, cas(saved.receipt)),
        denied("conflict"),
      );
      assert.equal(
        (await f.service.readUi(bob, cas(bound.receipt))).authority
          .dataAuthorityId,
        "database/other",
      );
      const closed = await f.service.close(bob, {
        ...cas(bound.receipt),
        commandId: "close-original",
      });
      assert.equal(closed.receipt.viewRevision, 4);
      assert.equal(
        (await f.service.read(bob, { viewId: "view-bob" })).view.status,
        "closed",
      );
      await assert.rejects(
        f.service.readUi(bob, cas(closed.receipt)),
        denied("conflict"),
      );
      await f.reopen();
      assert.deepEqual(await f.service.save(bob, save), {
        receipt: saved.receipt,
        replayed: true,
      });
      assert.deepEqual(
        await f.service.close(bob, {
          ...cas(bound.receipt),
          commandId: "close-original",
        }),
        { receipt: closed.receipt, replayed: true },
      );
      assert.equal(
        (await f.service.read(bob, { viewId: "view-bob" })).view.revision,
        4,
      );
      assert.deepEqual(await f.q.all("SELECT * FROM app_ui_packages"), rows);
      assert.deepEqual(
        await f.q.all("SELECT * FROM cognitive_app_commands"),
        [],
        "Window lifecycle never invokes or records a business command.",
      );
      for (const forbidden of [
        "installedBy",
        "ownerPrincipal",
        "storeId",
        "artifactId",
        "hostBindingId",
        "credential",
        "proof",
      ])
        assert.equal(JSON.stringify(ui).includes(`\"${forbidden}\"`), false);
    }));

  test(`actual six methods deny Agent/foreign Human and strict dual CAS without exposing private causes on ${backend}`, async () =>
    isolatedView(backend, async (f) => {
      const p = await prepareView(f),
        launched = await f.service.launch(bob, p.launch);
      const readRequest = cas(launched.receipt);
      for (const outsider of [alice, agent]) {
        await assert.rejects(f.service.read(outsider, { viewId: "view-bob" }));
        await assert.rejects(f.service.readUi(outsider, readRequest));
        for (const [method, request] of [
          ["launch", { ...p.launch, commandId: "outsider-launch" }],
          ["bind", { ...p.launch, ...readRequest, commandId: "outsider-bind" }],
          ["save", { ...readRequest, commandId: "outsider-save", state: {} }],
          ["close", { ...readRequest, commandId: "outsider-close" }],
        ] as const)
          await assert.rejects(f.service[method](outsider, request));
      }
      for (const patch of [
        { expectedViewRevision: 2 },
        { expectedBindingRevision: 2 },
      ]) {
        await assert.rejects(
          f.service.readUi(bob, { ...readRequest, ...patch }),
          denied("conflict"),
        );
        await assert.rejects(
          f.service.save(bob, {
            ...readRequest,
            ...patch,
            commandId: "stale-save",
            state: {},
          }),
          denied("conflict", "stale-save"),
        );
      }
      await assert.rejects(
        f.service.launch(bob, {
          ...p.launch,
          commandId: "wrong-target",
          expectedDefinitionHash: "0".repeat(64),
        }),
        denied("conflict", "wrong-target"),
      );
      await assert.rejects(
        f.service.launch(bob, {
          ...p.launch,
          commandId: "wrong-grant",
          expectedGrantRevision: 2,
        }),
        denied("conflict", "wrong-grant"),
      );
      await assert.rejects(
        f.service.launch(bob, {
          ...p.launch,
          commandId: "wrong-connection",
          expectedConnectionRevision: 2,
        }),
        denied("conflict", "wrong-connection"),
      );
      assert.equal(
        (await f.service.read(bob, { viewId: "view-bob" })).view.revision,
        1,
      );
    }));

  test(`actual grant disable permits metadata/original replay/close but never active UI bytes or new save on ${backend}`, async () =>
    isolatedView(backend, async (f) => {
      const p = await prepareView(f),
        launched = await f.service.launch(bob, p.launch),
        request = cas(launched.receipt);
      await f.platform.changeCognitiveAppGrant(bob, {
        appId: p.launch.appId,
        version: p.launch.version,
        expectedRevision: 1,
        state: "disabled",
      });
      assert.equal(
        (await f.service.read(bob, { viewId: "view-bob" })).view.status,
        "open",
      );
      assert.deepEqual(await f.service.launch(bob, p.launch), {
        receipt: launched.receipt,
        replayed: true,
      });
      await assert.rejects(f.service.readUi(bob, request), denied("forbidden"));
      await assert.rejects(
        f.service.save(bob, {
          ...request,
          commandId: "disabled-save",
          state: {},
        }),
        denied("forbidden", "disabled-save"),
      );
      await assert.rejects(
        f.service.bind(bob, {
          ...p.launch,
          ...request,
          commandId: "disabled-bind",
        }),
        denied("forbidden", "disabled-bind"),
      );
      const closed = await f.service.close(bob, {
        ...request,
        commandId: "disabled-close",
      });
      assert.equal(closed.receipt.viewRevision, 2);
      assert.equal(
        (await f.service.read(bob, { viewId: "view-bob" })).view.status,
        "closed",
      );
    }));

  test(`actual concurrent save and same-id replay retain one CAS winner on ${backend}`, async () =>
    isolatedView(backend, async (f) => {
      const p = await prepareView(f),
        launched = await f.service.launch(bob, p.launch),
        request = cas(launched.receipt);
      const results = await Promise.allSettled(
        ["first", "second"].map((view) =>
          f.service.save(bob, {
            ...request,
            commandId: "save-" + view,
            state: { view },
          }),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const rejected = results.find((r) => r.status === "rejected")!;
      assert.equal(rejected.status, "rejected");
      if (rejected.status === "rejected") {
        assert.ok(rejected.reason instanceof CognitiveAppServiceError);
        assert.equal(rejected.reason.reason, "conflict");
      }
      const winner = results.findIndex((r) => r.status === "fulfilled"),
        state = { view: winner === 0 ? "first" : "second" };
      const replayRequest = {
        ...request,
        commandId: "save-" + state.view,
        state,
      };
      const replays = await Promise.all([
        f.service.save(bob, replayRequest),
        f.service.save(bob, replayRequest),
      ]);
      assert.deepEqual(replays[0], replays[1]);
      assert.equal(replays[0]!.replayed, true);
      await assert.rejects(
        f.service.save(bob, { ...replayRequest, state: { view: "changed" } }),
        denied("conflict", replayRequest.commandId),
      );
      assert.deepEqual(
        (await f.service.read(bob, { viewId: "view-bob" })).view.state,
        state,
      );
    }));

  test(`actual save preserves exact historical refs and rejects foreign object/navigation body on ${backend}`, async () =>
    isolatedView(backend, async (f) => {
      const p = await prepareView(f),
        launched = await f.service.launch(bob, p.launch),
        request = cas(launched.receipt);
      // Only catalog metadata is explicitly seeded. No author body/version
      // existence is claimed; that separate proof belongs to exact object read.
      const now = new Date().toISOString();
      await f.q.change(
        "INSERT INTO content_entries(tenant_id,content_id,app_id,instance_id,app_object_id,project_id,kind,title,observed_version_ref,observed_at,availability,revision,created_at,updated_at) VALUES('tenant-a','content-note','example.notes',?,'note/one','project-a','note','Original','head',?,'available',1,?,?)",
        [p.connection.instanceId, now, now, now],
      );
      const state = {
        object: { objectId: "note/one", versionRef: " exact/old\nref " },
      };
      const saved = await f.service.save(bob, {
        ...request,
        commandId: "save-exact",
        state,
      });
      assert.deepEqual(
        (await f.service.read(bob, { viewId: "view-bob" })).view.state,
        state,
      );
      assert.deepEqual(
        (await f.service.readUi(bob, cas(saved.receipt))).view.state,
        state,
      );
      await assert.rejects(
        f.service.save(bob, {
          ...cas(saved.receipt),
          commandId: "save-foreign",
          state: { object: { objectId: "missing", versionRef: "old" } },
        }),
        denied("not_found", "save-foreign"),
      );
      await assert.rejects(
        f.service.save(bob, {
          ...cas(saved.receipt),
          commandId: "save-body",
          state: { body: "private body" },
        }),
        denied("invalid"),
      );
      assert.deepEqual(
        (await f.service.read(bob, { viewId: "view-bob" })).view.state,
        state,
      );
    }));

  test(`actual SQL identity awaits cannot retarget launch/save/readUi or trusted credential snapshots on ${backend}`, async () =>
    isolatedView(backend, async (f) => {
      const p = await prepareView(f),
        caller = { credential: "bob" },
        mutable = { ...p.launch };
      let changed = false;
      f.control.beforeResolve = async () => {
        if (changed) return;
        await f.q.all("SELECT * FROM app_ui_packages");
        changed = true;
        caller.credential = "alice";
        mutable.connectionId = "connection-other";
        mutable.commandId = "changed-id";
      };
      const launched = await f.service.launch(caller, mutable);
      assert.equal(launched.receipt.viewId, "view-bob");
      f.control.beforeResolve = undefined;
      assert.equal(
        (await f.service.read(bob, { viewId: "view-bob" })).binding
          .connectionId,
        "connection-bob",
      );
      const state = { view: "original" },
        save = { ...cas(launched.receipt), commandId: "save-snapshot", state };
      changed = false;
      caller.credential = "bob";
      f.control.beforeResolve = async () => {
        if (changed) return;
        await f.q.all("SELECT * FROM app_ui_packages");
        changed = true;
        caller.credential = "alice";
        state.view = "changed";
        save.commandId = "changed-save";
      };
      const saved = await f.service.save(caller, save);
      f.control.beforeResolve = undefined;
      assert.deepEqual(
        (await f.service.read(bob, { viewId: "view-bob" })).view.state,
        { view: "original" },
      );
      const read = { ...cas(saved.receipt) };
      changed = false;
      caller.credential = "bob";
      f.control.beforeResolve = async () => {
        if (changed) return;
        await f.q.all("SELECT * FROM app_ui_packages");
        changed = true;
        caller.credential = "alice";
        read.viewId = "missing";
        read.expectedBindingRevision = 900;
      };
      assert.deepEqual(
        (await f.service.readUi(caller, read)).manifest,
        p.input.manifest,
      );
      f.control.beforeResolve = undefined;
      let calls = 0;
      const hostile = Object.defineProperty({ ...p.launch }, "commandId", {
        enumerable: true,
        get() {
          calls++;
          throw new Error("private secret");
        },
      });
      await assert.rejects(f.service.launch(bob, hostile), denied("invalid"));
      assert.equal(calls, 0);
      await assert.rejects(
        f.service.launch(bob, { ...p.launch, owner: "alice" }),
        denied("invalid"),
      );
    }));

  test(`actual byte owner remains immutable and late grant revocation withholds already-read HTML on ${backend}`, async () =>
    isolatedView(backend, async (f) => {
      const p = await prepareView(f),
        launched = await f.service.launch(bob, p.launch),
        request = cas(launched.receipt);
      await assert.rejects(f.ui.read(bob, p.launch.appId, p.launch.version));
      const original = await f.q.all("SELECT * FROM app_ui_packages");
      const gate = f.platform.prepareCognitiveAppUiRead.bind(f.platform);
      let calls = 0;
      f.platform.prepareCognitiveAppUiRead = async (...args) => {
        const result = await gate(...args);
        if (++calls === 3)
          await f.platform.changeCognitiveAppGrant(bob, {
            appId: p.launch.appId,
            version: p.launch.version,
            expectedRevision: 1,
            state: "disabled",
          });
        return result;
      };
      await assert.rejects(f.service.readUi(bob, request), denied("forbidden"));
      assert.equal(calls, 3);
      f.platform.prepareCognitiveAppUiRead = gate;
      assert.equal(Reflect.get(f.ui, "scopes").size, 0);
      assert.deepEqual(
        await f.q.all("SELECT * FROM app_ui_packages"),
        original,
      );
    }));

  test(`actual retained Store blob corruption is rejected without SQL/byte-owner rewrite on ${backend}`, async () =>
    isolatedView(backend, async (f) => {
      const p = await prepareView(f),
        launched = await f.service.launch(bob, p.launch),
        request = cas(launched.receipt);
      const original = await f.q.all<{ sha256: string }>(
        "SELECT * FROM app_ui_packages",
      );
      const sha = original[0]!.sha256,
        path = join(f.root, "ui-bytes", "blobs", sha.slice(0, 2), sha),
        bytes = readFileSync(path);
      bytes[0] = bytes[0]! ^ 1;
      writeFileSync(path, bytes);
      await assert.rejects(f.service.readUi(bob, request), (error: unknown) => {
        assert.ok(error instanceof CognitiveAppServiceError);
        assert.equal("cause" in error, false);
        return true;
      });
      assert.deepEqual(
        await f.q.all("SELECT * FROM app_ui_packages"),
        original,
      );
      assert.equal(Reflect.get(f.ui, "scopes").size, 0);
    }));

  test(`actual UI carrier accepts retained 1MB heavily escaped HTML and cold read without a 512KiB cutoff on ${backend}`, async () =>
    isolatedView(backend, async (f) => {
      const html = '"\\\n'.repeat(333_333) + "x",
        p = await prepareView(f, html);
      const launched = await f.service.launch(bob, p.launch),
        request = cas(launched.receipt);
      assert.equal(new TextEncoder().encode(html).byteLength, 1_000_000);
      assert.equal(
        (await f.service.readUi(bob, request)).manifest.ui.type,
        "sandbox",
      );
      await f.reopen();
      const result = await f.service.readUi(bob, request);
      assert.equal(result.manifest.ui.type, "sandbox");
      if (result.manifest.ui.type === "sandbox")
        assert.equal(result.manifest.ui.html, html);
    }));
}
