import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { expect } from "@playwright/test";
import { packCognitiveNotesGui } from "./fixtures/cognitive-notes-gui-package.js";
import {
  openNotesGuiTransports,
  type NotesGuiPack,
  type NotesGuiTransports,
} from "./fixtures/cognitive-notes-gui-transports.js";
import {
  buildNotesProductionUi,
  notesProductionLoginToken,
  openNotesProductionApp,
} from "./fixtures/cognitive-notes-production-app.js";
import {
  buildNotesNativeProduction,
  openNotesNativeProduction,
  notesNativeStatus,
  type NotesNativeBuild,
} from "./fixtures/cognitive-notes-native-production.js";

/** Real Electron production main/preload/native morphz origin, current complete
 * production App, Remote, same actual IdentityCenter/HPA/dual Platform SQL and
 * independently packed author/public SDK. Only generated center/profile and
 * explicit test login/loopback author configuration are controlled. No Local
 * embedded, installed user App, original profile or online Runtime claim.
 */
let packed: NotesGuiPack;
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
        stage: "native-current-production-build",
        desktop: native.hashes,
        uiEntrySha256: native.uiEntrySha256,
        server: "tsconfig.server.json current source into own temporary tree",
      }),
    );
  },
  { timeout: 180_000 },
);
after(async () => {
  await native?.close();
  await ui?.close();
  packed?.close();
});
async function unsent(f: NotesGuiTransports) {
  return {
    tasks: await f.rows("tasks"),
    conversations: await f.rows("conversations"),
    runtime: f.local.application.store.runtimeState(),
    sessions: f.transportRows("runtime_sessions"),
    deliveries: f.transportRows("runtime_deliveries"),
    publications: f.transportRows("runtime_publications"),
    bindings: f.transportRows("runtime_thread_bindings"),
    events: f.transportRows("runtime_session_events"),
  };
}
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `ACTUAL native Electron Remote + SAME notes ${backend} center: public SDK originals, warm CAS, reload/compose/open; not Local/user App/online Runtime`,
    { timeout: 180_000 },
    async () => {
      const f = await openNotesGuiTransports(backend, packed);
      const center = await openNotesProductionApp(f, ui.webRoot).catch(
        async (error) => {
          await f.close();
          throw error;
        },
      );
      let app:
        Awaited<ReturnType<typeof openNotesNativeProduction>> | undefined;
      try {
        app = await openNotesNativeProduction(
          f,
          native,
          center.origin,
          notesProductionLoginToken,
        );
        const authorPremises = {
          definitions: f.authorRows("author_definitions"),
          metadata: f.authorRows("metadata"),
          acl: f.authorRows("project_acl"),
        };
        const beforeNoSend = await unsent(f);
        const callsBefore = f.authorCalls.length;
        const { guest, outer, element } = await app.openGui();
        const originalRoot = await guest.evaluateHandle(
          () => document.documentElement,
        );
        const geometry = await app.page.evaluate(() => {
          const frame = document.querySelector(
            "iframe.cognitive-application-frame",
          );
          const host = frame?.closest(".application-host");
          const primary = frame?.closest(".primary-panel");
          if (!frame || !host || !primary)
            throw Error("actual production native canvas hierarchy is missing");
          const frameBounds = frame.getBoundingClientRect();
          const hostBounds = host.getBoundingClientRect();
          const primaryBounds = primary.getBoundingClientRect();
          return {
            frame: {
              x: frameBounds.x,
              y: frameBounds.y,
              width: frameBounds.width,
              height: frameBounds.height,
            },
            host: {
              x: hostBounds.x,
              y: hostBounds.y,
              width: hostBounds.width,
              height: hostBounds.height,
            },
            primary: {
              x: primaryBounds.x,
              y: primaryBounds.y,
              width: primaryBounds.width,
              height: primaryBounds.height,
            },
          };
        });
        assert.ok(geometry.frame.width >= 700 && geometry.frame.height >= 300);
        assert.ok(Math.abs(geometry.frame.height - geometry.host.height) <= 1);
        assert.ok(Math.abs(geometry.frame.width - geometry.host.width) <= 1);
        assert.ok(geometry.frame.height <= geometry.primary.height);
        assert.equal(
          f.authorCalls.length,
          callsBefore,
          "production native GUI does not automatically read/invoke author business",
        );
        assert.ok(
          outer.url().startsWith("morphz://app/api/cognitive-app-document/"),
          "carrier is delivered by actual production native custom scheme",
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
          "real opaque author cannot acquire native bridge or parent authority",
        );
        await guest.locator("#refresh").click();
        await notesNativeStatus(guest, "笔记列表已读取");
        const title = `TEST native Remote ${backend} original`;
        const body1 = `原生公开 SDK 作者原文 ${backend}\n保留换行😀 <script>不可执行</script>`;
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
        assert.equal(f.authorRows("notes").length, 1);
        assert.equal(f.authorRows("note_versions").length, 1);
        // Retain the actual own-save/warm source assertion; do not solve a CAS
        // race by remounting the GUI, deleting this action or changing proofs.
        await guest.locator("#remember").click();
        await notesNativeStatus(guest, "已记住阅读位置");
        const sourceAfterSave = await f.source();
        assert.equal(sourceAfterSave.view.revision, 2);
        assert.equal(sourceAfterSave.binding.viewRevision, 2);
        assert.ok(sourceAfterSave.view.state.object);
        assert.equal(
          sourceAfterSave.view.state.object.versionRef,
          firstVersion,
        );
        const savedObject = sourceAfterSave.view.state.object;
        assert.equal(await element.count(), 1);
        assert.equal(
          await originalRoot.evaluate(
            (root) => root.isConnected && root === document.documentElement,
          ),
          true,
          "own saved CAS2 leaves the actual same author Document/root alive",
        );
        assert.equal(await guest.locator("#original").textContent(), body1);
        await guest.locator("#edit").click();
        const body2 = body1 + "\n第二个实际作者版本";
        await guest.locator("#markdown").fill(body2);
        await guest.locator("#save").click();
        await notesNativeStatus(guest, "作者已确认保存");
        const secondCommand = await guest.locator("#command").inputValue();
        const secondVersion = (await guest
          .locator("#version")
          .textContent())!.replace("精确版本：", "");
        assert.notEqual(secondCommand, firstCommand);
        assert.notEqual(secondVersion, firstVersion);
        assert.equal(f.authorRows("notes").length, 1);
        assert.equal(f.authorRows("note_versions").length, 2);
        assert.equal(
          await originalRoot.evaluate(
            (root) => root.isConnected && root === document.documentElement,
          ),
          true,
          "later business response does not replace the warm native Document",
        );
        await originalRoot.dispose();
        const commands = (await f.rows("cognitive_app_commands")).filter(
          (row) =>
            row.command_id === firstCommand || row.command_id === secondCommand,
        );
        assert.equal(commands.length, 2);
        assert.ok(
          commands.every(
            (row) =>
              row.state === "committed" && row.projection_state === "projected",
          ),
        );
        for (const id of [firstCommand, secondCommand])
          assert.ok(
            f
              .authorRows("author_commands")
              .some((row) => row.command_id === id),
          );
        for (const button of ["status-command", "recover"]) {
          const before = (await app.remoteRequests()).length;
          await guest.locator(`#${button}`).click();
          await expect(guest.locator(`#${button}`)).toBeEnabled();
          assert.ok(
            (await app.remoteRequests())
              .slice(before)
              .some(
                (request) =>
                  request.path ===
                    `/api/platform/cognitive-apps/${button === "status-command" ? "command-status" : "recover"}` &&
                  request.commandId === secondCommand &&
                  request.status === 200,
              ),
            "this actual native click completed its own public Host receipt endpoint",
          );
        }
        assert.equal((await app.preferences()).cognitiveLocation.kind, "view");
        const persistedViewBeforeRestore = {
          views: await f.rows("app_view_instances"),
          bindings: await f.rows("cognitive_app_view_bindings"),
        };
        await app.page.reload();
        const restored = await app.currentGuest();
        assert.notEqual(restored.guest, guest);
        assert.deepEqual(
          {
            views: await f.rows("app_view_instances"),
            bindings: await f.rows("cognitive_app_view_bindings"),
          },
          persistedViewBeforeRestore,
          "native restore locates the actual persisted window without launch/bind/state writes",
        );
        await restored.guest.locator("#read").click();
        await notesNativeStatus(restored.guest, "已读取所选精确版本");
        assert.equal(
          await restored.guest.locator("#original").textContent(),
          body1,
        );
        assert.equal(
          (await f.source()).view.state.object!.versionRef,
          firstVersion,
        );
        const input = app.page.getByRole("textbox", {
          name: "AI 输入内容",
          exact: true,
        });
        if (!(await input.isVisible()))
          await app.page.keyboard.press("Control+j");
        await input.fill("原生本窗口未发送草稿\n保留原稿");
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
          "原生本窗口未发送草稿\n保留原稿\n请基于这份原文整理要点。",
        );
        assert.equal(draft.cognitiveObject!.object.versionRef, firstVersion);
        assert.equal(draft.cognitiveObject!.projectId, f.projectId);
        assert.equal(
          draft.cognitiveApplication!.connectionId,
          f.target.connectionId,
        );
        assert.ok(!JSON.stringify(draft).includes(body1));
        for (const [key, value] of Object.entries(beforeCompose))
          if (!value.body.includes("原生本窗口未发送草稿"))
            assert.deepEqual(afterCompose[key], value);
        assert.equal(await input.inputValue(), draft.body);
        await restored.guest.locator("#open").click();
        const original = app.page.getByRole("article", {
          name: title,
          exact: true,
        });
        await original.waitFor();
        assert.ok(
          (await original.textContent())!.includes(
            `原生公开 SDK 作者原文 ${backend}`,
          ),
        );
        assert.ok(
          !(await original.textContent())!.includes("第二个实际作者版本"),
        );
        await restored.element.waitFor({ state: "detached" });
        const savedLocation = (await app.preferences()).cognitiveLocation;
        assert.equal(savedLocation.kind, "original");
        assert.equal(savedLocation.locator.object.versionRef, firstVersion);
        assert.equal(savedLocation.locator.connectionId, f.target.connectionId);
        assert.equal(savedLocation.locator.projectId, f.projectId);
        assert.deepEqual(await app.stored(), afterCompose);
        assert.deepEqual(await unsent(f), beforeNoSend);
        assert.deepEqual(
          {
            definitions: f.authorRows("author_definitions"),
            metadata: f.authorRows("metadata"),
            acl: f.authorRows("project_acl"),
          },
          authorPremises,
        );
        assert.deepEqual(app.errors, []);
        assert.ok(
          app.responses.some(
            (r) =>
              r.path.startsWith("/api/cognitive-app-document/") &&
              r.status === 200,
          ),
        );
        console.log(
          JSON.stringify({
            stage: "actual-native-remote-original-business",
            backend,
            center: app.bootstrap.centerId,
            authorNotes: f.authorRows("notes").length,
            versions: f.authorRows("note_versions").length,
            firstVersion,
            secondVersion,
            viewCAS: sourceAfterSave.view.revision,
            geometry,
            responses: app.responses,
          }),
        );
      } catch (error) {
        await app?.diagnostics(`failure-${backend}`).catch(() => undefined);
        await center
          .diagnostics(`native-failure-${backend}`)
          .catch(() => undefined);
        throw error;
      } finally {
        try {
          await app?.close();
        } finally {
          try {
            await center.close();
          } finally {
            await f.close();
          }
        }
      }
    },
  );
