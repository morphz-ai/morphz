import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../packages/application/src/application.js";
import { parseCognitiveAppCatalog } from "../packages/core/src/cognitive-app-api.js";
import {
  workspaceChangeSchema,
  type WorkspaceChange,
} from "../packages/core/src/workspace-changes.js";
import { withViewTransport } from "./fixtures/cognitive-app-view-transport-fixture.js";
import { prepareConnectionCreation } from "./fixtures/cognitive-connection-creation.js";

type Fixture = Parameters<Parameters<typeof withViewTransport>[1]>[0];
type Proof = Awaited<ReturnType<Fixture["platform"]["workspaceChangeVersion"]>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string) {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function rows(f: Fixture) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "navigation_heads",
    "app_installations",
    "app_ui_packages",
    "cognitive_app_registrations",
    "cognitive_app_versions",
    "cognitive_app_grants",
    "cognitive_app_connections",
    "cognitive_app_authorities",
    "cognitive_app_view_bindings",
    "app_view_instances",
    "cognitive_app_commands",
    "command_receipts",
    "content_entries",
    "projects",
    "project_members",
    "team_login_sessions",
  ])
    result[table] = await f.q.all(`SELECT * FROM ${table}`);
  return result;
}
function forbidBusinessAndBytes(f: Fixture) {
  const calls: string[] = [];
  for (const [owner, methods] of [
    [f.host.service, ["describe", "invoke", "readObject", "recover"]],
    [f.ui, ["readCognitive", "readCognitiveDocument"]],
  ] as const)
    for (const method of methods)
      Reflect.set(owner, method, () => {
        calls.push(method);
        throw new Error("Observer must not read author bytes or business.");
      });
  return calls;
}

/** Actual IdentityCenter/HPA, same SQL change source and production Session
 * drain. The existing fixture's connection setup is explicit admission, not
 * author-network evidence. This is not a mounted GUI or full Domains Host. */
async function observe(f: Fixture) {
  const auth = await f.identity.authenticateShared(f.cookie());
  assert.ok(auth);
  assert.equal(auth.access.principalId, "bob");
  assert.equal(auth.access.actantId, "bob-human");
  let live = true;
  const proofs: Proof[] = [];
  const frames: WorkspaceChange[] = [];
  const frameProofs: Proof[] = [];
  const waits = new Set<() => void>();
  let lastProof!: Proof;
  const application = new Application(f.workspace, {
    identity: f.identity,
    workspaceChanges: {
      sources: [f.platform.changeSource()],
      async readVersion(access, assertActive) {
        assert.deepEqual(access, auth.access);
        lastProof = await f.human.withSession(access, assertActive, (actor) =>
          f.platform.workspaceChangeVersion(actor),
        );
        proofs.push(lastProof);
        for (const notify of waits) notify();
        return lastProof;
      },
    },
  });
  const dispose = await application
    .session(auth.access, () => assert.equal(live, true))
    .observeWorkspaceChanges(
      (raw) => {
        frames.push(workspaceChangeSchema.parse(raw));
        frameProofs.push(lastProof);
        for (const notify of waits) notify();
      },
      () => {},
    );
  async function until(check: () => boolean, label: string) {
    if (check()) return;
    const gate = deferred<void>();
    const notify = () => {
      if (check()) gate.resolve();
    };
    waits.add(notify);
    notify();
    try {
      await bounded(gate.promise, label);
    } finally {
      waits.delete(notify);
    }
  }
  await until(() => frames.length === 1, "Missing actual initial resync.");
  assert.deepEqual(frames[0], {
    kind: "workspace",
    sequence: 1,
    reason: "resync",
    accessChanged: false,
  });
  return {
    frames,
    proofs,
    frameProofs,
    async changed(previous: Proof, count: number, accessChanged: boolean) {
      await until(
        () => frames.length > count,
        `Actual SQL observer lost cognitive change: ${proofs.length} completed metadata reads, ${frames.length} frames.`,
      );
      const frame = frames[count]!;
      assert.equal(frame.reason, "changed");
      assert.equal(frame.sequence, count + 1);
      assert.equal(frame.accessChanged, accessChanged);
      const current = frameProofs[count]!;
      assert.notEqual(current.version, previous.version);
      if (accessChanged)
        assert.notEqual(current.accessVersion, previous.accessVersion);
      else assert.equal(current.accessVersion, previous.accessVersion);
      return current;
    },
    async consumedHint(readCount: number) {
      await until(
        () => proofs.length > readCount,
        "The actual SQL commit hint did not reach the observer.",
      );
      // No time-based negative wait: with no Runtime/OCR, the production drain
      // performs its synchronous frame decision immediately after readVersion.
      // Flush that actual continuation before inspecting the negative result.
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    close() {
      dispose();
      live = false;
      application.speechStreams.close();
    },
  };
}

const target = (f: Fixture) => ({
  appId: f.input.definition.id,
  version: f.input.definition.version,
  expectedDefinitionHash: f.installed.definitionHash,
});
for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["grant", "connection"] as const)
    test(`${backend} actual Human observer: own ${kind} disable/re-enable invalidates access`, async () => {
      await withViewTransport(backend, async (f) => {
        const business = forbidBusinessAndBytes(f);
        const watcher = await observe(f);
        try {
          let proof = watcher.frameProofs[0]!;
          for (const [state, expectedRevision] of [
            ["disabled", 1],
            ["active", 2],
          ] as const) {
            const count = watcher.frames.length;
            const reads = watcher.proofs.length;
            await f.local.call(
              kind === "grant"
                ? "cognitive-apps.grant"
                : "cognitive-apps.connection-state",
              kind === "grant"
                ? {
                    appId: f.input.definition.id,
                    version: f.input.definition.version,
                    state,
                    expectedRevision,
                  }
                : {
                    ...target(f),
                    connectionId: f.connection.connectionId,
                    state,
                    expectedRevision,
                  },
              { identityGeneration: f.localCsrf },
            );
            const saved = await rows(f);
            await watcher.consumedHint(reads);
            proof = await watcher.changed(proof, count, true);
            assert.deepEqual(await rows(f), saved);
            assert.deepEqual(business, []);
            assert.equal(Reflect.get(f.human, "issued").size, 0);
            assert.equal(Reflect.get(f.ui, "scopes").size, 0);
          }
        } finally {
          watcher.close();
        }
      });
    });

  test(`${backend} actual observer: another Human's grant and connection do not clear Bob`, async () => {
    await withViewTransport(backend, async (f) => {
      const alice = { credential: "setup-alice" };
      await f.platform.changeCognitiveAppGrant(alice, {
        ...target(f),
        state: "active",
        expectedRevision: 0,
      });
      const created = await f.platform.createVerifiedCognitiveAppConnection(
        alice,
        await prepareConnectionCreation(f.platform, alice, {
          connectionId: "connection-alice",
          expectedRevision: 0,
          proof: {
            purpose: "connection-setup",
            appId: f.input.definition.id,
            version: f.input.definition.version,
            definitionHash: f.installed.definitionHash,
            serviceId: "service/notes",
            dataAuthorityId: "database/alice",
            hostBindingId: "private_alice",
          },
        }),
      );
      const business = forbidBusinessAndBytes(f);
      const watcher = await observe(f);
      try {
        const original = watcher.frameProofs[0]!;
        for (const kind of ["grant", "connection"] as const) {
          const reads = watcher.proofs.length;
          if (kind === "grant")
            await f.platform.changeCognitiveAppGrant(alice, {
              ...target(f),
              state: "disabled",
              expectedRevision: 1,
            });
          else
            await f.platform.changeCognitiveAppConnectionState(alice, {
              ...target(f),
              connectionId: created.connectionId,
              state: "disabled",
              expectedRevision: 1,
            });
          const saved = await rows(f);
          await watcher.consumedHint(reads);
          assert.equal(watcher.frames.length, 1);
          assert.deepEqual(watcher.proofs.at(-1), original);
          assert.deepEqual(await rows(f), saved);
          assert.deepEqual(business, []);
        }
      } finally {
        watcher.close();
      }
    });
  });

  test(`${backend} actual observer: own view save emits change without retiring access`, async () => {
    await withViewTransport(backend, async (f) => {
      const opened = await f.local.call(
        "cognitive-app-views.launch",
        f.launch,
        {
          identityGeneration: f.localCsrf,
        },
      );
      const business = forbidBusinessAndBytes(f);
      const watcher = await observe(f);
      try {
        await f.local.call(
          "cognitive-app-views.save",
          {
            viewId: opened.receipt.viewId,
            expectedViewRevision: opened.receipt.viewRevision,
            expectedBindingRevision: opened.receipt.bindingRevision,
            commandId: "save-original-view-navigation",
            state: { view: "inspector" },
          },
          { identityGeneration: f.localCsrf },
        );
        const saved = await rows(f);
        await watcher.changed(watcher.frameProofs[0]!, 1, false);
        assert.deepEqual(await rows(f), saved);
        assert.deepEqual(business, []);
      } finally {
        watcher.close();
      }
    });
  });

  test(`${backend} actual observer: grant beyond the catalogue's first page is included`, async () => {
    await withViewTransport(backend, async (f) => {
      // The actual catalogue is paged, not a database cardinality constraint.
      // Explicitly install/register metadata before starting the observer;
      // no declaration body is needed by the later version proof.
      let tail!: Awaited<
        ReturnType<Fixture["platform"]["installCognitiveApp"]>
      >;
      for (let i = 0; i <= 100; i++) {
        tail = await f.platform.installCognitiveApp(
          { credential: "setup-alice" },
          {
            definition: {
              ...f.input.definition,
              id: "dev.observer-many",
              version: i === 100 ? "9.0.0" : `1.0.${i}`,
              ui: null,
            },
          },
        );
        await f.local.call(
          "cognitive-apps.install",
          {
            mode: "register-installed",
            commandId: `observer-register-${i}`,
            appId: tail.appId,
            version: tail.version,
            definitionHash: tail.definitionHash,
          },
          { identityGeneration: f.localCsrf },
        );
      }
      const page = parseCognitiveAppCatalog(
        await f.local.call(
          "cognitive-apps.list",
          { appId: tail.appId, limit: 100 },
          { identityGeneration: f.localCsrf },
        ),
      );
      assert.equal(page.versions.length, 100);
      assert.ok(page.nextVersionsAfter);
      assert.equal(
        page.versions.some((v) => v.version === tail.version),
        false,
      );
      const business = forbidBusinessAndBytes(f);
      const watcher = await observe(f);
      try {
        const reads = watcher.proofs.length;
        await f.local.call(
          "cognitive-apps.grant",
          {
            appId: tail.appId,
            version: tail.version,
            state: "active",
            expectedRevision: 0,
          },
          { identityGeneration: f.localCsrf },
        );
        const saved = await rows(f);
        await watcher.consumedHint(reads);
        await watcher.changed(watcher.frameProofs[0]!, 1, true);
        assert.deepEqual(await rows(f), saved);
        assert.deepEqual(business, []);
      } finally {
        watcher.close();
      }
    });
  });

  test(`${backend} actual observer: connection beyond the catalogue's first page is included`, async () => {
    await withViewTransport(backend, async (f) => {
      let tail!: Awaited<
        ReturnType<Fixture["platform"]["createVerifiedCognitiveAppConnection"]>
      >;
      for (let i = 0; i <= 100; i++)
        tail = await f.platform.createVerifiedCognitiveAppConnection(
          { credential: "setup-bob" },
          await prepareConnectionCreation(
            f.platform,
            { credential: "setup-bob" },
            {
              connectionId: i === 100 ? "zz-tail" : `page-${i}`,
              expectedRevision: 0,
              proof: {
                purpose: "connection-setup",
                appId: f.input.definition.id,
                version: f.input.definition.version,
                definitionHash: f.installed.definitionHash,
                serviceId: f.connection.serviceId,
                dataAuthorityId: f.connection.dataAuthorityId,
                hostBindingId: `page_${i}`,
              },
            },
          ),
        );
      const page = parseCognitiveAppCatalog(
        await f.local.call(
          "cognitive-apps.list",
          { appId: f.input.definition.id, limit: 100 },
          { identityGeneration: f.localCsrf },
        ),
      );
      assert.equal(page.connections.length, 100);
      assert.ok(page.nextConnectionsAfter);
      assert.equal(
        page.connections.some((c) => c.connectionId === tail.connectionId),
        false,
      );
      const business = forbidBusinessAndBytes(f);
      const watcher = await observe(f);
      try {
        const reads = watcher.proofs.length;
        await f.local.call(
          "cognitive-apps.connection-state",
          {
            ...target(f),
            connectionId: tail.connectionId,
            expectedRevision: tail.revision,
            state: "disabled",
          },
          { identityGeneration: f.localCsrf },
        );
        const saved = await rows(f);
        await watcher.consumedHint(reads);
        await watcher.changed(watcher.frameProofs[0]!, 1, true);
        assert.deepEqual(await rows(f), saved);
        assert.deepEqual(business, []);
      } finally {
        watcher.close();
      }
    });
  });
}
