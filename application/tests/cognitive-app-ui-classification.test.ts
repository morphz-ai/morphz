import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import {
  readPlatformWorkspace,
  type PlatformWorkspaceCatalog,
} from "../apps/web/src/platform-workspace-view.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  objectsApplication,
  browserApplication,
} from "../packages/core/src/applications.js";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import {
  alice,
  bob,
  isolatedView,
  prepareView,
  viewSubmission,
} from "./fixtures/cognitive-app-view-service-fixture.js";
import { withViewTransport } from "./fixtures/cognitive-app-view-transport-fixture.js";

// Actual isolated relational/byte stores and HTTP/HPA. Connection admission in
// the shared fixtures is controlled, not author-network or live Runtime proof.
for (const backend of ["sqlite", "postgres"] as const) {
  test(`actual exact UI classification is independent of personal consent on ${backend}`, async () =>
    isolatedView(backend, async (f) => {
      const input = viewSubmission();
      await f.ui.install(alice, "install-ui-only", input.manifest);
      const legacy = await f.platform.launchAppView(alice, {
        commandId: "legacy-launch",
        projectId: "project-a",
        appId: input.manifest.id,
        packageVersion: input.manifest.version,
        state: {},
      });
      assert.deepEqual(
        await f.ui.read(alice, input.manifest.id, input.manifest.version),
        input.manifest,
      );
      assert.equal(
        Reflect.get((await f.ui.list(alice))[0]!, "cognitive"),
        undefined,
      );
      const originalPackage = await f.platform.uiPackage(
        alice,
        input.manifest.id,
        input.manifest.version,
      );
      assert.equal((await f.platform.listAppViews(alice))[0]?.id, legacy.id);
      const receiptsBefore = await f.q.all(
        "SELECT * FROM command_receipts WHERE tenant_id='tenant-a' AND command_id='legacy-launch'",
        [],
      );
      const installed = await f.ui.installCognitive(
        alice,
        "install-ui-only",
        input,
      );
      assert.deepEqual(Reflect.get((await f.ui.list(alice))[0]!, "cognitive"), {
        definitionHash: installed.definitionHash,
      });
      assert.deepEqual(
        Reflect.get(
          await f.platform.uiPackage(
            alice,
            input.manifest.id,
            input.manifest.version,
          ),
          "cognitive",
        ),
        { definitionHash: installed.definitionHash },
      );
      assert.deepEqual(
        await f.platform.uiPackage(
          alice,
          input.manifest.id,
          input.manifest.version,
        ),
        {
          ...originalPackage,
          cognitive: { definitionHash: installed.definitionHash },
        },
        "Classification must not alter retained installer/byte references or immutable package metadata",
      );
      assert.deepEqual(
        await f.ui.list(bob),
        [],
        "The classification marker does not grant an installer catalogue to another principal",
      );
      await assert.rejects(
        f.ui.read(alice, input.manifest.id, input.manifest.version),
      );
      for (const commandId of ["legacy-launch", "new-legacy-launch"])
        await assert.rejects(
          f.platform.launchAppView(alice, {
            commandId,
            projectId: "project-a",
            appId: input.manifest.id,
            packageVersion: input.manifest.version,
            state: {},
          }),
        );
      assert.deepEqual(
        await f.platform.listAppViews(alice),
        [],
        "Even an unbound former UI-only window cannot enter the old Sandbox",
      );
      assert.deepEqual(
        await f.q.all(
          "SELECT * FROM command_receipts WHERE tenant_id='tenant-a' AND command_id='legacy-launch'",
          [],
        ),
        receiptsBefore,
      );
      await f.platform.changeCognitiveAppGrant(alice, {
        appId: input.definition.id,
        version: input.definition.version,
        expectedRevision: 0,
        state: "active",
      });
      await f.platform.changeCognitiveAppGrant(alice, {
        appId: input.definition.id,
        version: input.definition.version,
        expectedRevision: 1,
        state: "disabled",
      });
      assert.deepEqual(Reflect.get((await f.ui.list(alice))[0]!, "cognitive"), {
        definitionHash: installed.definitionHash,
      });
      await f.reopen();
      assert.deepEqual(Reflect.get((await f.ui.list(alice))[0]!, "cognitive"), {
        definitionHash: installed.definitionHash,
      });
      await assert.rejects(
        f.ui.read(alice, input.manifest.id, input.manifest.version),
      );
    }));

  test(`actual bound cognitive views stay on the exact C1 path, never legacy listing on ${backend}`, async () =>
    isolatedView(backend, async (f) => {
      const p = await prepareView(f);
      const launched = await f.service.launch(bob, p.launch);
      assert.deepEqual(await f.platform.listAppViews(bob), []);
      await assert.rejects(
        f.platform.launchAppView(bob, {
          commandId: "legacy-cognitive",
          projectId: "project-a",
          appId: p.input.definition.id,
          packageVersion: p.input.definition.version,
          state: {},
        }),
      );
      const exact = {
        viewId: launched.receipt.viewId,
        expectedViewRevision: launched.receipt.viewRevision,
        expectedBindingRevision: launched.receipt.bindingRevision,
      };
      assert.deepEqual(
        (await f.service.readUi(bob, exact)).manifest,
        p.input.manifest,
      );
      await f.platform.changeCognitiveAppGrant(bob, {
        appId: p.input.definition.id,
        version: p.input.definition.version,
        state: "disabled",
        expectedRevision: 1,
      });
      await assert.rejects(f.service.readUi(bob, exact));
      assert.deepEqual(await f.platform.listAppViews(bob), []);
    }));

  test(`actual legacy byte read cannot disclose after an exact cognitive declaration arrives on ${backend}`, async () =>
    isolatedView(backend, async (f) => {
      const input = viewSubmission();
      await f.ui.install(alice, "install-before-read", input.manifest);
      const original = f.platform.uiPackage.bind(f.platform);
      let reads = 0;
      f.platform.uiPackage = async (...args) => {
        if (++reads === 2) {
          f.platform.uiPackage = original;
          await f.ui.installCognitive(alice, "install-before-read", input);
        }
        return original(...args);
      };
      await assert.rejects(
        f.ui.read(alice, input.manifest.id, input.manifest.version),
      );
      assert.equal(reads, 2);
      assert.equal((await f.platform.listUiPackages(alice)).length, 1);
    }));

  test(`actual headless declaration retires only the exact legacy UI version on ${backend}`, async () =>
    isolatedView(backend, async (f) => {
      const input = viewSubmission();
      const later = { ...input.manifest, version: "2.0.0" };
      await f.ui.install(alice, "install-headless-original-ui", input.manifest);
      await f.ui.install(alice, "install-other-version-ui", later);
      const installed = await f.platform.installCognitiveApp(alice, {
        definition: { ...input.definition, ui: null },
      });
      const first = (await f.platform.listUiPackages(alice)).find(
        (item) => item.version === input.manifest.version,
      )!;
      const second = (await f.platform.listUiPackages(alice)).find(
        (item) => item.version === later.version,
      )!;
      assert.deepEqual(Reflect.get(first, "cognitive"), {
        definitionHash: installed.definitionHash,
      });
      assert.equal(Reflect.get(second, "cognitive"), undefined);
      await assert.rejects(
        f.ui.read(alice, input.manifest.id, input.manifest.version),
      );
      await assert.rejects(
        f.platform.launchAppView(alice, {
          commandId: "headless-legacy-open",
          projectId: "project-a",
          appId: input.manifest.id,
          packageVersion: input.manifest.version,
          state: {},
        }),
      );
      assert.deepEqual(await f.ui.read(alice, later.id, later.version), later);
      const open = await f.platform.launchAppView(alice, {
        commandId: "ui-other-version-open",
        projectId: "project-a",
        appId: later.id,
        packageVersion: later.version,
        state: {},
      });
      assert.equal((await f.platform.listAppViews(alice))[0]?.id, open.id);
    }));

  test(`actual HTTP exposes only exact classification and the typed legacy projection excludes cognitive headers/windows on ${backend}`, async () =>
    withViewTransport(backend, async (f) => {
      const manifest = { ...viewSubmission().manifest, id: "example.personal" };
      const definition = { ...viewSubmission().definition, id: manifest.id };
      const installed = await f.ui.installCognitive(
        { credential: "setup-bob" },
        "install-personal",
        { manifest, definition },
      );
      const legacyManifest = { ...manifest, id: "example.ui-only" };
      await f.ui.install(
        { credential: "setup-bob" },
        "install-personal-legacy",
        legacyManifest,
      );
      const probe = createServer();
      probe.listen(0, "127.0.0.1");
      await once(probe, "listening");
      const address = probe.address();
      assert.ok(address && typeof address !== "string");
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const server = createAppServer(f.workspace, {
        identity: f.identity,
        port: address.port,
        webRoot: "/nonexistent",
        uiPackages: { authority: f.human, service: f.ui },
      });
      let cookie: string | undefined;
      const http = new HttpApplicationClient(
        `http://127.0.0.1:${address.port}`,
        async (url, init) => {
          const headers = new Headers(init?.headers);
          if (cookie) headers.set("Cookie", cookie);
          const response = await fetch(url, { ...init, headers });
          const received = response.headers
            .getSetCookie()
            .find((value) => value.startsWith(f.identity.cookieName + "="));
          if (received) cookie = received.split(";")[0]!;
          return response;
        },
      );
      try {
        server.listen(address.port, "127.0.0.1");
        await once(server, "listening");
        await http.call("login", { token: "b".repeat(64) });
        const client = await PlatformClient.connect(http);
        const raw = await http.call("apps.list", undefined, {
          identityGeneration: client.boot.csrfToken,
        });
        const typed = await client.uiPackages();
        const entry = typed.find((item) => item.header.id === manifest.id)!;
        assert.deepEqual(Reflect.get(entry, "cognitive"), {
          definitionHash: installed.definitionHash,
        });
        assert.deepEqual(Object.keys(entry).sort(), [
          "cognitive",
          "header",
          "installedAt",
        ]);
        assert.equal(JSON.stringify(raw).includes("storeId"), false);
        assert.equal(JSON.stringify(raw).includes("artifactId"), false);
        assert.equal(JSON.stringify(raw).includes(manifest.ui.html), false);
        const legacyEntry = typed.find(
          (item) => item.header.id === legacyManifest.id,
        )!;
        assert.equal(Reflect.get(legacyEntry, "cognitive"), undefined);
        const rawRead = (appId: string) =>
          fetch(
            `http://127.0.0.1:${address.port}/api/application-view/${appId}@1.0.0`,
            { headers: { Cookie: cookie! } },
          );
        const cognitiveBytes = await rawRead(manifest.id);
        assert.equal(cognitiveBytes.status, 403);
        assert.equal(
          (await cognitiveBytes.text()).includes(manifest.ui.html),
          false,
        );
        const legacyBytes = await rawRead(legacyManifest.id);
        assert.equal(legacyBytes.status, 200);
        assert.equal(await legacyBytes.text(), legacyManifest.ui.html);
        const project = {
          id: "project-a",
          kind: "project" as const,
          ownerPrincipalId: "alice",
          memberPrincipalIds: ["alice", "bob"],
          title: "Project",
          revision: 1,
          createdAt: "2026-10-05T00:00:00.000Z",
          updatedAt: "2026-10-05T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
        };
        const catalog: PlatformWorkspaceCatalog = {
          personal: {
            deskId: "project-a",
            dialogueId: "project-a",
            inboxId: "project-a",
          },
          projects: [project],
          conversations: [],
          tasks: [],
          tasksLoaded: true,
          taskCounts: [],
          headContents: [],
          contents: [],
          contentCounts: [],
          scriptLibrary: [],
          taskOrderRevision: 0,
          uiPackages: typed,
        };
        const at = project.createdAt;
        const window = (
          id: string,
          applicationId: string,
          applicationVersion = "1.0.0",
          state = {},
        ) => ({
          id,
          workspaceId: project.id,
          applicationId,
          applicationVersion,
          state,
          revision: 1,
          status: "open" as const,
          createdAt: at,
          updatedAt: at,
        });
        const staleCognitive = window(
          "stale-cognitive",
          manifest.id,
          manifest.version,
          { artifactId: "not-a-builtin-object" },
        );
        const legacyWindow = window(
          "old-ui",
          legacyManifest.id,
          legacyManifest.version,
        );
        const objectWindow = window(
          "objects",
          objectsApplication.id,
          objectsApplication.version,
        );
        const browserWindow = window(
          "browser",
          browserApplication.id,
          browserApplication.version,
        );
        const projected = await readPlatformWorkspace(
          client,
          [staleCognitive, legacyWindow, objectWindow, browserWindow],
          1,
          disconnectedRuntime,
          undefined,
          undefined,
          { scope: null },
          undefined,
          catalog,
        );
        assert.equal(
          projected.workspace.applications.some(
            (item) => item.id === manifest.id,
          ),
          false,
        );
        assert.equal(
          projected.workspace.applications.some(
            (item) => item.id === legacyManifest.id,
          ),
          true,
        );
        assert.deepEqual(
          projected.workspace.applicationInstances.map((item) => item.id),
          [legacyWindow.id, objectWindow.id, browserWindow.id],
        );
        assert.equal(projected.workspace.artifacts.length, 0);
        // Parser safety is independent of a claimed marker on an untrusted DTO.
        for (const cognitive of [
          { definitionHash: "invalid" },
          { definitionHash: installed.definitionHash, grant: true },
        ]) {
          const invalid = await PlatformClient.connect({
            call: async (method) =>
              method === "platform.bootstrap"
                ? client.boot
                : [{ ...legacyEntry, cognitive }],
          });
          await assert.rejects(invalid.uiPackages());
        }
      } finally {
        server.closeStreams();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }));
}
