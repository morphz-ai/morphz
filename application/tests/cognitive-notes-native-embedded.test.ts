import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { expect } from "@playwright/test";
import { packCognitiveNotesGui } from "./fixtures/cognitive-notes-gui-package.js";
import { buildNotesProductionUi } from "./fixtures/cognitive-notes-production-app.js";
import {
  buildNotesNativeProduction,
  notesNativeStatus,
  type NotesNativeBuild,
} from "./fixtures/cognitive-notes-native-production.js";
import {
  openNotesNativeEmbedded,
  type NotesNativeEmbedded,
} from "./fixtures/cognitive-notes-native-embedded.js";
import { parseCognitiveAppGrant } from "../packages/core/src/cognitive-app-api.js";
import { parseCognitiveAppViewResponse } from "../packages/core/src/cognitive-app-view-api.js";
import { cognitiveNavigationLocation } from "../apps/web/src/host/cognitive-navigation-location.js";

/** Actual unchanged production main/openEmbeddedApplication, complete App,
 * native morphz resource, public Human IPC/HPA/Platform SQLite and packed
 * independent author SQLite/public SDK. Only own synthetic operator config,
 * explicit numeric loopback author approval and generated center/profile are
 * controlled. Not Remote, PostgreSQL Local, installed user App or online Runtime.
 */
let packed: ReturnType<typeof packCognitiveNotesGui>;
let ui: Awaited<ReturnType<typeof buildNotesProductionUi>>;
let native: NotesNativeBuild;
before(
  async () => {
    packed = packCognitiveNotesGui();
    packed.build();
    ui = await buildNotesProductionUi();
    native = await buildNotesNativeProduction(ui.webRoot);
    console.log(
      JSON.stringify({
        stage: "native-embedded-current-production-build",
        desktop: native.hashes,
        uiEntrySha256: native.uiEntrySha256,
        server: "tsconfig.server.json actual source into own temporary tree",
        transport:
          "actual production main --data-dir: embedded SQLite; no --center or HTTP application service",
      }),
    );
  },
  { timeout: 180_000 },
);
after(async () => {
  try {
    await native?.close();
  } finally {
    try {
      await ui?.close();
    } finally {
      packed?.close();
    }
  }
});
function unsent(app: NotesNativeEmbedded) {
  return {
    tasks: app.rows("tasks"),
    conversations: app.rows("conversations"),
    sessions: app.transportRows("runtime_sessions"),
    deliveries: app.transportRows("runtime_deliveries"),
    publications: app.transportRows("runtime_publications"),
    bindings: app.transportRows("runtime_thread_bindings"),
    events: app.transportRows("runtime_session_events"),
  };
}
async function nativePremises(app: NotesNativeEmbedded) {
  const state = await app.nativeState();
  assert.deepEqual(state, {
    profile: app.profile,
    sandbox: true,
    nodeIntegration: false,
    contextIsolation: true,
    listeners: [],
  });
  app.noRuntimeFiles();
  assert.equal(
    app.requests.some((value) => {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        url.pathname.startsWith("/api/")
      );
    }),
    false,
    "actual Local renderer never calls an HTTP application API/resource",
  );
}

test(
  "ACTUAL native embedded Local SQLite: production-created UUID, public setup/SDK author originals, same warm CAS, exact restore/compose/terminal original; no application HTTP/Runtime",
  { timeout: 180_000 },
  async () => {
    const app = await openNotesNativeEmbedded(native, packed);
    try {
      await nativePremises(app);
      const authorPremises = {
        definitions: app.authorRows("author_definitions"),
        metadata: app.authorRows("metadata"),
        acl: app.authorRows("project_acl"),
      };
      const pendingBefore = unsent(app);
      assert.equal(
        app.rows("app_view_instances").length,
        0,
        "Human setup never invented a view ID or silently launched GUI",
      );
      assert.equal(app.authorRows("notes").length, 0);
      const { guest, outer, element } = await app.openGui();
      assert.ok(
        outer.url().startsWith("morphz://app/api/cognitive-app-document/"),
      );
      assert.ok(
        app.responses.some(
          (response) => response.url === outer.url() && response.status === 200,
        ),
      );
      assert.deepEqual(
        await guest.evaluate(() => ({
          origin: location.origin,
          node: typeof Reflect.get(window, "require"),
          desktop: typeof Reflect.get(window, "morphzDesktop"),
          parentDOM: (() => {
            try {
              return !!parent.document;
            } catch {
              return false;
            }
          })(),
          topDOM: (() => {
            try {
              return !!top!.document;
            } catch {
              return false;
            }
          })(),
        })),
        {
          origin: "null",
          node: "undefined",
          desktop: "undefined",
          parentDOM: false,
          topDOM: false,
        },
      );
      const liveRoot = await guest.evaluateHandle(
        () => document.documentElement,
      );
      assert.equal(app.rows("app_view_instances").length, 1);
      assert.equal(app.rows("cognitive_app_view_bindings").length, 1);
      const launchSource = await app.source();
      assert.equal(launchSource.view.revision, 1);
      assert.equal(launchSource.binding.revision, 1);
      assert.equal(launchSource.grantRevision, 1);
      const actualConnection = app
        .rows("cognitive_app_connections")
        .find((row) => row.connection_id === app.target.connectionId);
      assert.ok(actualConnection);
      assert.equal(actualConnection.owner_principal_id, app.principalId);
      assert.equal(actualConnection.tenant_id, app.bootstrap.centerId);
      assert.deepEqual(launchSource.authority, {
        appId: app.installed.appId,
        version: app.installed.version,
        definitionHash: app.installed.definitionHash,
        instanceId: actualConnection.instance_id,
        serviceId: actualConnection.service_id,
        dataAuthorityId: actualConnection.data_authority_id,
      });
      const geometry = await app.page.evaluate(() => {
        const frame = document.querySelector(
          "iframe.cognitive-application-frame",
        );
        const host = frame?.closest(".application-host");
        const primary = frame?.closest(".primary-panel");
        if (!frame || !host || !primary)
          throw Error("actual Local native canvas hierarchy is missing");
        const f = frame.getBoundingClientRect(),
          h = host.getBoundingClientRect(),
          p = primary.getBoundingClientRect();
        return {
          frame: { width: f.width, height: f.height },
          host: { width: h.width, height: h.height },
          primary: { width: p.width, height: p.height },
        };
      });
      assert.ok(geometry.frame.width >= 700 && geometry.frame.height >= 300);
      assert.ok(Math.abs(geometry.frame.width - geometry.host.width) <= 1);
      assert.ok(Math.abs(geometry.frame.height - geometry.host.height) <= 1);
      assert.ok(geometry.frame.height <= geometry.primary.height);
      await guest.locator("#refresh").click();
      await notesNativeStatus(guest, "笔记列表已读取");
      const title = "TEST native embedded Local actual original";
      const body1 =
        "原生 Local 公共 SDK 的作者原文\n第二行😀 <script>不能执行</script>";
      await guest.locator("#new").click();
      await guest.locator("#title").fill(title);
      await guest.locator("#markdown").fill(body1);
      await guest.locator("#save").click();
      await notesNativeStatus(guest, "作者已确认保存");
      const firstCommand = await guest.locator("#command").inputValue();
      const firstVersion = (await guest
        .locator("#version")
        .textContent())!.replace("精确版本：", "");
      assert.equal(await guest.locator("#original").textContent(), body1);
      assert.equal(app.authorRows("notes").length, 1);
      assert.equal(app.authorRows("note_versions").length, 1);
      await guest.locator("#remember").click();
      await notesNativeStatus(guest, "已记住阅读位置");
      const savedSource = await app.source();
      assert.equal(savedSource.view.revision, 2);
      assert.equal(savedSource.binding.viewRevision, 2);
      assert.equal(savedSource.binding.revision, 1);
      assert.ok(savedSource.view.state.object);
      const savedObject = savedSource.view.state.object;
      assert.equal(savedObject.versionRef, firstVersion);
      assert.equal(
        await liveRoot.evaluate(
          (root) => root.isConnected && root === document.documentElement,
        ),
        true,
        "own save CAS2 retains the same actual Document",
      );
      await guest.locator("#edit").click();
      const body2 = body1 + "\n真实作者第二版，不改已保存历史位置";
      await guest.locator("#markdown").fill(body2);
      await guest.locator("#save").click();
      await notesNativeStatus(guest, "作者已确认保存");
      const secondCommand = await guest.locator("#command").inputValue();
      const secondVersion = (await guest
        .locator("#version")
        .textContent())!.replace("精确版本：", "");
      assert.notEqual(secondCommand, firstCommand);
      assert.notEqual(secondVersion, firstVersion);
      assert.equal(
        await liveRoot.evaluate(
          (root) => root.isConnected && root === document.documentElement,
        ),
        true,
      );
      assert.equal(app.authorRows("note_versions").length, 2);
      await liveRoot.dispose();
      const commands = app.rows("cognitive_app_commands");
      for (const id of [firstCommand, secondCommand]) {
        const command = commands.find((row) => row.command_id === id);
        assert.ok(
          command &&
            command.state === "committed" &&
            command.projection_state === "projected",
        );
        assert.ok(
          app
            .authorRows("author_commands")
            .some((row) => row.command_id === id),
        );
      }
      // Different exact command IDs create a genuine DOM completion barrier for
      // each actual SDK call. Local has no HTTP response to pretend to observe.
      await guest.locator("#command").fill(firstCommand);
      await guest.locator("#status-command").click();
      await expect(guest.locator("#status")).toHaveText(
        `作者已确认保存。原命令 ID：${firstCommand}`,
      );
      await expect(guest.locator("#status-command")).toBeEnabled();
      await guest.locator("#command").fill(secondCommand);
      await guest.locator("#recover").click();
      await expect(guest.locator("#status")).toHaveText(
        `作者已确认保存。原命令 ID：${secondCommand}`,
      );
      await expect(guest.locator("#recover")).toBeEnabled();
      const receiptRows = {
        commands: app.rows("cognitive_app_commands"),
        versions: app.authorRows("note_versions"),
      };
      assert.deepEqual(receiptRows.commands, commands);
      const persistedBeforeRestore = {
        views: app.rows("app_view_instances"),
        bindings: app.rows("cognitive_app_view_bindings"),
      };
      await app.page.reload();
      const restored = await app.currentGuest();
      await app.refreshBootstrap();
      assert.notEqual(restored.guest, guest);
      assert.equal(guest.isDetached(), true);
      assert.deepEqual(
        {
          views: app.rows("app_view_instances"),
          bindings: app.rows("cognitive_app_view_bindings"),
        },
        persistedBeforeRestore,
        "Local reload locates saved view without launch/bind/state mutation",
      );
      await restored.guest.locator("#read").click();
      await notesNativeStatus(restored.guest, "已读取所选精确版本");
      assert.equal(
        await restored.guest.locator("#original").textContent(),
        body1,
      );
      assert.equal(
        (await app.source()).view.state.object!.versionRef,
        firstVersion,
      );
      const input = app.page.getByRole("textbox", {
        name: "AI 输入内容",
        exact: true,
      });
      if (!(await input.isVisible()))
        await app.page.keyboard.press("Control+j");
      await input.fill("原生 Local 本窗口未发送草稿\n不改原稿");
      const beforeCompose = await app.stored();
      await restored.guest.locator("#compose").click();
      await notesNativeStatus(restored.guest, "原文引用已准备到输入框");
      const afterCompose = await app.stored();
      const draft = Object.values(afterCompose).find(
        (value) =>
          value.cognitiveObject?.object.objectId === savedObject.objectId,
      );
      assert.ok(draft);
      assert.equal(
        draft.body,
        "原生 Local 本窗口未发送草稿\n不改原稿\n请基于这份原文整理要点。",
      );
      assert.equal(draft.cognitiveObject!.object.versionRef, firstVersion);
      assert.equal(draft.cognitiveObject!.projectId, app.projectId);
      assert.equal(
        draft.cognitiveApplication!.connectionId,
        app.target.connectionId,
      );
      assert.ok(!JSON.stringify(draft).includes(body1));
      assert.equal(await input.inputValue(), draft.body);
      for (const [key, value] of Object.entries(beforeCompose))
        if (!value.body.includes("原生 Local 本窗口未发送草稿"))
          assert.deepEqual(afterCompose[key], value);
      assert.deepEqual(await app.recentContent(), []);
      const openingAt = Date.now();
      await restored.guest.locator("#open").click();
      const original = app.page.getByRole("article", {
        name: title,
        exact: true,
      });
      await original.waitFor();
      assert.ok(
        (await original.textContent())!.includes(
          "原生 Local 公共 SDK 的作者原文",
        ),
      );
      assert.ok(!(await original.textContent())!.includes("真实作者第二版"));
      await expect(element).toHaveCount(0);
      const navigationLocation = cognitiveNavigationLocation(
        (await app.preferences()).cognitiveLocation,
      );
      assert.ok(navigationLocation?.kind === "original");
      assert.equal(
        navigationLocation.locator.object.objectId,
        savedObject.objectId,
      );
      assert.equal(navigationLocation.locator.object.versionRef, firstVersion);
      const recent = await app.recentContent();
      assert.equal(recent.length, 1);
      assert.equal(recent[0]!.artifactId, navigationLocation.locator.contentId);
      assert.ok(
        recent[0]!.openedAt >= openingAt && recent[0]!.openedAt <= Date.now(),
      );
      assert.deepEqual(await app.stored(), afterCompose);
      assert.deepEqual(unsent(app), pendingBefore);
      assert.deepEqual(
        {
          definitions: app.authorRows("author_definitions"),
          metadata: app.authorRows("metadata"),
          acl: app.authorRows("project_acl"),
        },
        authorPremises,
      );
      assert.equal(app.errors.length, 0);
      await nativePremises(app);
      await app.diagnostics("happy-accepted");
      console.log(
        JSON.stringify({
          stage: "actual-native-embedded-business",
          centerId: app.bootstrap.centerId,
          firstCommand,
          secondCommand,
          firstVersion,
          secondVersion,
          geometry,
          resource: outer.url(),
          listenerState: await app.nativeState(),
          authorVersions: app.authorRows("note_versions").length,
          unsentLedgerUnchanged: true,
        }),
      );
    } catch (error) {
      await app.diagnostics("happy-failure").catch(() => undefined);
      throw error;
    } finally {
      await app.close();
    }
  },
);

test(
  "ACTUAL native embedded Local SQLite: real IPC access invalidation retires GUI; resource revocation and explicit grant3/closed-CAS reopen preserve drafts and originals",
  { timeout: 180_000 },
  async () => {
    const app = await openNotesNativeEmbedded(native, packed);
    try {
      await nativePremises(app);
      const { guest, outer, element } = await app.openGui();
      await guest.locator("#new").click();
      await guest.locator("#title").fill("TEST native embedded grant cycle");
      await guest.locator("#markdown").fill("许可循环中保留的真实作者原文");
      await guest.locator("#save").click();
      await notesNativeStatus(guest, "作者已确认保存");
      await guest.locator("#remember").click();
      await notesNativeStatus(guest, "已记住阅读位置");
      const before = await app.source();
      const input = app.page.getByRole("textbox", {
        name: "AI 输入内容",
        exact: true,
      });
      if (!(await input.isVisible()))
        await app.page.keyboard.press("Control+j");
      await input.fill("许可循环未发送原稿");
      const originalDrafts = await app.stored();
      const originalRows = {
        commands: app.rows("cognitive_app_commands"),
        notes: app.authorRows("notes"),
        versions: app.authorRows("note_versions"),
        views: app.rows("app_view_instances"),
        bindings: app.rows("cognitive_app_view_bindings"),
      };
      const pendingBefore = unsent(app);
      const streamBefore = (await app.streams()).length;
      // Use the current accepted own-save CAS, not the carrier's initial CAS1:
      // a genuine authorized HEAD positive control must precede revocation.
      const currentResource = new URL(outer.url());
      currentResource.searchParams.set(
        "expectedViewRevision",
        String(before.view.revision),
      );
      currentResource.searchParams.set(
        "expectedBindingRevision",
        String(before.binding.revision),
      );
      const resourceHeadBefore = await app.page.evaluate(async (url) => {
        const response = await fetch(url, {
          method: "HEAD",
          cache: "no-store",
        });
        return {
          status: response.status,
          length: (await response.arrayBuffer()).byteLength,
        };
      }, currentResource.href);
      assert.deepEqual(resourceHeadBefore, { status: 200, length: 0 });
      const revoked = parseCognitiveAppGrant(
        await app.call("cognitive-apps.grant", {
          appId: app.installed.appId,
          version: app.installed.version,
          expectedRevision: 1,
          state: "disabled",
        }),
      );
      assert.equal(revoked.revision, 2);
      await expect(element).toHaveCount(0);
      assert.equal(guest.isDetached(), true);
      const streamAfter = (await app.streams()).slice(streamBefore);
      assert.ok(
        streamAfter.some(
          (value) =>
            value &&
            typeof value === "object" &&
            "kind" in value &&
            value.kind === "workspace" &&
            "accessChanged" in value &&
            value.accessChanged === true,
        ),
        "actual post-revoke preload workspace stream delivered access invalidation without HTTP/SSE/focus polling",
      );
      const afterRevocation = {
        commands: app.rows("cognitive_app_commands"),
        notes: app.authorRows("notes"),
        versions: app.authorRows("note_versions"),
        views: app.rows("app_view_instances"),
        bindings: app.rows("cognitive_app_view_bindings"),
      };
      assert.deepEqual(afterRevocation, originalRows);
      const denied = await app.page.evaluate(async (url) => {
        const response = await fetch(url, {
          method: "HEAD",
          cache: "no-store",
        });
        return {
          status: response.status,
          length: (await response.arrayBuffer()).byteLength,
        };
      }, currentResource.href);
      assert.deepEqual(
        denied,
        { status: 403, length: 0 },
        "actual private Local resource pipeline rechecks current grant; no former HTML leaks",
      );
      assert.deepEqual(await app.stored(), originalDrafts);
      const grant = parseCognitiveAppGrant(
        await app.call("cognitive-apps.grant", {
          appId: app.installed.appId,
          version: app.installed.version,
          expectedRevision: 2,
          state: "active",
        }),
      );
      assert.equal(grant.revision, 3);
      const reopened = await app.openGui();
      const current = await app.source();
      assert.notEqual(reopened.guest, guest);
      assert.equal(current.grantRevision, 3);
      assert.equal(current.view.id, before.view.id);
      assert.equal(current.view.revision, before.view.revision);
      assert.deepEqual(app.rows("app_view_instances"), originalRows.views);
      assert.deepEqual(
        app.rows("cognitive_app_view_bindings"),
        originalRows.bindings,
      );
      await reopened.guest.locator("#read").click();
      await notesNativeStatus(reopened.guest, "已读取所选精确版本");
      assert.equal(
        await reopened.guest.locator("#original").textContent(),
        "许可循环中保留的真实作者原文",
      );
      assert.deepEqual(await app.stored(), originalDrafts);
      const closeStreamBefore = (await app.streams()).length;
      const closed = parseCognitiveAppViewResponse(
        "close",
        await app.call("cognitive-app-views.close", {
          commandId: crypto.randomUUID(),
          viewId: current.view.id,
          expectedViewRevision: current.view.revision,
          expectedBindingRevision: current.binding.revision,
        }),
      );
      // Retain the genuine automatic-unmount RED, then collect independent
      // metadata/gate evidence without making a request-triggered retirement
      // impersonate automatic event reconciliation.
      const automaticCloseFailure = await expect(reopened.element)
        .toHaveCount(0)
        .then(
          () => null,
          (error: unknown) => error,
        );
      assert.equal(closed.receipt.viewRevision, current.view.revision + 1);
      const closedLocation = parseCognitiveAppViewResponse(
        "locate",
        await app.call("cognitive-app-views.locate", {
          projectId: app.projectId,
          appId: app.installed.appId,
          version: app.installed.version,
          expectedDefinitionHash: app.installed.definitionHash,
        }),
      );
      assert.equal(closedLocation.view!.status, "closed");
      assert.equal(
        closedLocation.view!.viewRevision,
        closed.receipt.viewRevision,
      );
      const closedSql = app
        .rows("app_view_instances")
        .find((row) => row.view_id === current.view.id);
      assert.ok(closedSql);
      assert.equal(closedSql.status, "closed");
      assert.equal(closedSql.revision, closed.receipt.viewRevision);
      const closeHints = (await app.streams()).slice(closeStreamBefore);
      assert.ok(
        closeHints.some(
          (value) =>
            value &&
            typeof value === "object" &&
            "kind" in value &&
            value.kind === "workspace",
        ),
        "actual post-close native workspace metadata invalidation arrives",
      );
      await assert.rejects(
        app.call("cognitive-app-views.read-ui", {
          viewId: current.view.id,
          expectedViewRevision: current.view.revision,
          expectedBindingRevision: current.binding.revision,
        }),
        /409\/conflict/,
        "the actual Human read-ui gate rejects the formerly authorized closed CAS",
      );
      assert.deepEqual(
        app.rows("cognitive_app_commands"),
        originalRows.commands,
      );
      assert.deepEqual(app.authorRows("notes"), originalRows.notes);
      assert.deepEqual(app.authorRows("note_versions"), originalRows.versions);
      assert.deepEqual(await app.stored(), originalDrafts);
      assert.deepEqual(unsent(app), pendingBefore);
      console.log(
        JSON.stringify({
          stage: "actual-native-embedded-close-reconciliation-witness",
          centerId: app.bootstrap.centerId,
          actualSql: {
            viewId: closedSql.view_id,
            status: closedSql.status,
            revision: closedSql.revision,
          },
          actualLocator: closedLocation,
          actualNativeHints: closeHints,
          formerReadUiCas: "409/conflict",
          automaticUnmount: automaticCloseFailure === null,
          oldGuestDetachedBeforeAnyGuestBusinessCall:
            reopened.guest.isDetached(),
          commandsOriginalsDraftsAndUnsentLedgerUnchanged: true,
        }),
      );
      if (automaticCloseFailure !== null) throw automaticCloseFailure;
      const opened = await app.openGui();
      const openedSource = await app.source();
      assert.notEqual(opened.guest, reopened.guest);
      assert.equal(openedSource.view.id, current.view.id);
      assert.equal(openedSource.view.revision, closed.receipt.viewRevision + 1);
      assert.equal(openedSource.binding.revision, current.binding.revision);
      assert.equal(openedSource.grantRevision, 3);
      assert.equal(
        app.rows("app_view_instances").length,
        1,
        "exact close CAS reopen preserves the one own view slot, never retries 0/0",
      );
      assert.deepEqual(
        app.rows("cognitive_app_commands"),
        originalRows.commands,
      );
      assert.deepEqual(app.authorRows("notes"), originalRows.notes);
      assert.deepEqual(app.authorRows("note_versions"), originalRows.versions);
      assert.deepEqual(await app.stored(), originalDrafts);
      assert.deepEqual(unsent(app), pendingBefore);
      assert.equal(app.errors.length, 0);
      await nativePremises(app);
      await app.diagnostics("grant-cycle-accepted");
      console.log(
        JSON.stringify({
          stage: "actual-native-embedded-grant-cycle",
          centerId: app.bootstrap.centerId,
          grantRevision: openedSource.grantRevision,
          initialViewRevision: before.view.revision,
          closedViewRevision: closed.receipt.viewRevision,
          reopenedViewRevision: openedSource.view.revision,
          actualAccessChangedFrames: streamAfter,
          revokedResource: denied,
        }),
      );
    } catch (error) {
      await app.diagnostics("grant-cycle-failure").catch(() => undefined);
      throw error;
    } finally {
      await app.close();
    }
  },
);
