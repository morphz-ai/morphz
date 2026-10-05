import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { packCognitiveNotesGui } from "./fixtures/cognitive-notes-gui-package.js";
import {
  openNotesGuiTransports,
  type NotesGuiPack,
  type NotesGuiTransports,
} from "./fixtures/cognitive-notes-gui-transports.js";
import {
  buildNotesProductionUi,
  openNotesProductionApp,
} from "./fixtures/cognitive-notes-production-app.js";
import type { Frame } from "@playwright/test";
import {
  parseCognitiveAppCommandResult,
  parseCognitiveAppGrant,
} from "../packages/core/src/cognitive-app-api.js";
import { parseCognitiveAppViewResponse } from "../packages/core/src/cognitive-app-view-api.js";

/** Production main/App/useWorkspace/navigation/input writer/consumer and real
 * HTTP, HPA, dual Platform SQL, independent packed author SQLite. Only setup
 * identity, loopback approval and own ephemeral automated server are controlled;
 * the explicitly named late case also controls delivery timing of real HTTP200.
 * No native Electron/user-window/Runtime-online acceptance is claimed. */
let packed: NotesGuiPack;
let ui: Awaited<ReturnType<typeof buildNotesProductionUi>>;
before(
  async () => {
    packed = packCognitiveNotesGui();
    packed.build();
    ui = await buildNotesProductionUi();
  },
  { timeout: 180_000 },
);
after(async () => {
  try {
    await ui?.close();
  } finally {
    packed?.close();
  }
});
async function status(guest: Frame, value: string) {
  await guest.waitForFunction(
    (value) => document.getElementById("status")?.textContent?.includes(value),
    value,
  );
}
async function save(
  guest: Frame,
  operationId: "notes.create" | "notes.revise",
) {
  const completed = guest
    .page()
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/api/platform/cognitive-apps/invoke" &&
        response.status() === 200 &&
        JSON.parse(response.request().postData() || "{}").operationId ===
          operationId,
    );
  void completed.catch(() => undefined);
  await guest.locator("#save").click();
  const commandId = await guest.locator("#command").inputValue();
  const response = await completed;
  assert.equal(
    JSON.parse(response.request().postData() || "{}").commandId,
    commandId,
  );
  const receipt = parseCognitiveAppCommandResult(await response.json());
  assert.equal(receipt.commandId, commandId);
  assert.equal(receipt.command.state, "committed");
  assert.equal(receipt.command.projectionState, "projected");
  await status(guest, "作者已确认保存");
  await guest.locator("#edit:enabled").waitFor();
}
async function create(guest: Frame, title: string, body: string) {
  await guest.locator("#new").click();
  await guest.locator("#title").fill(title);
  await guest.locator("#markdown").fill(body);
  await save(guest, "notes.create");
  return {
    commandId: await guest.locator("#command").inputValue(),
    version: (await guest.locator("#version").textContent())!.replace(
      "精确版本：",
      "",
    ),
  };
}
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
async function settledPaint(guest: Frame) {
  const finish = () =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  await guest.evaluate(finish);
  await guest.parentFrame()!.parentFrame()!.evaluate(finish);
}
function actualEventDeadline<T>(event: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_done, fail) => {
    // Same event budget as this fixture's real Playwright waiters. A missing
    // event fails into owner cleanup; it cannot strand a bare pending promise
    // until the outer Node test timeout or fabricate an observed event.
    timer = setTimeout(
      () => fail(new Error(`Actual event timed out: ${label}`)),
      12_000,
    );
  });
  return Promise.race([event, deadline]).finally(() => clearTimeout(timer));
}
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `ACTUAL production App Web + ${backend}: real author create/read/revise/receipt, private unsent compose and terminal original navigation`,
    { timeout: 180_000 },
    async () => {
      const f = await openNotesGuiTransports(backend, packed);
      const app = await openNotesProductionApp(f, ui.webRoot).catch(
        async (error) => {
          await f.close();
          throw error;
        },
      );
      try {
        const premisses = {
          definitions: f.authorRows("author_definitions"),
          metadata: f.authorRows("metadata"),
          acl: f.authorRows("project_acl"),
        };
        const noAutomatic = f.authorCalls.length;
        const { guest, outerElement } = await app.openGui();
        assert.equal(
          f.authorCalls.length,
          noAutomatic,
          "opening actual GUI never automatically invokes or reads author originals",
        );
        const pendingBefore = await unsent(f);
        await guest.locator("#refresh").click();
        await status(guest, "笔记列表已读取");
        const title = `TEST production App ${backend} original`;
        const body1 = `原始作者正文 ${backend}\n第二行😀 <script>不能执行</script>`;
        assert.ok(body1.includes("\n"), "author body has a real line break");
        assert.equal(body1.includes("\\n"), false);
        const first = await create(guest, title, body1);
        assert.equal(await guest.locator("#original").textContent(), body1);
        await guest.locator("#remember").click();
        await status(guest, "已记住阅读位置");
        const saved = (await f.source()).view.state;
        assert.ok(saved.object);
        assert.equal(saved.object.versionRef, first.version);
        await guest.locator("#edit").click();
        const body2 = body1 + "\n生产 App 的实际修订";
        assert.equal(body2.split("\n").length, 3);
        await guest.locator("#markdown").fill(body2);
        await save(guest, "notes.revise");
        const secondCommand = await guest.locator("#command").inputValue();
        const secondVersion = (await guest
          .locator("#version")
          .textContent())!.replace("精确版本：", "");
        assert.notEqual(secondCommand, first.commandId);
        assert.notEqual(secondVersion, first.version);
        const commands = (await f.rows("cognitive_app_commands")).filter(
          (r) =>
            r.command_id === first.commandId || r.command_id === secondCommand,
        );
        assert.equal(commands.length, 2);
        assert.ok(
          commands.every(
            (r) =>
              r.state === "committed" && r.projection_state === "projected",
          ),
        );
        assert.equal(f.authorRows("notes").length, 1);
        assert.equal(f.authorRows("note_versions").length, 2);
        for (const id of [first.commandId, secondCommand])
          assert.ok(
            f.authorRows("author_commands").some((r) => r.command_id === id),
          );
        // Each explicit click must complete its own actual public endpoint.
        // An already-present success paragraph cannot witness this request.
        for (const [button, path] of [
          ["status-command", "/api/platform/cognitive-apps/command-status"],
          ["recover", "/api/platform/cognitive-apps/recover"],
        ] as const) {
          const completed = app.page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === path &&
              response.status() === 200 &&
              JSON.parse(response.request().postData() || "{}").commandId ===
                secondCommand,
          );
          await guest.locator(`#${button}`).click();
          const result = await (await completed).json();
          assert.equal(result.commandId, secondCommand);
          // Receipt acceptance, author-owned command ID and actual GUI idle
          // establish that this click finished, not merely HTTP dispatch.
          await guest.locator(`#${button}:enabled`).waitFor();
          assert.ok(
            f
              .authorRows("author_commands")
              .some((r) => r.command_id === secondCommand),
          );
        }
        if (backend === "sqlite") {
          for (const mode of ["light", "dark"] as const) {
            await app.appearance(mode);
            await guest.waitForFunction(
              (mode) => document.documentElement.dataset.appearance === mode,
              mode,
            );
            assert.equal(guest.isDetached(), false);
            assert.equal(await guest.locator("#original").textContent(), body2);
            await settledPaint(guest);
            const screenshot = `/tmp/morphz-production-notes-wide-${mode}-oct06.png`;
            await app.page.screenshot({ path: screenshot });
            console.log(`production App actual GUI ${mode}: ${screenshot}`);
          }
          await app.appearance("light");
          await guest.waitForFunction(
            () => document.documentElement.dataset.appearance === "light",
          );
        }
        const sourcePreference = await app.preferences();
        assert.equal(sourcePreference.cognitiveLocation.kind, "view");
        // Reload the same actual production App/window: no fixture state seed,
        // no 0/0 launch or guessed view, read the saved opaque historical V1.
        const launchesBefore = app.requests.filter(
          (r) => r.path === "/api/platform/cognitive-app-views/launch",
        ).length;
        assert.ok(
          app.requests.some(
            (r) => r.path === "/api/platform/cognitive-app-views/locate",
          ),
        );
        await app.page.reload();
        await outerElement.waitFor();
        const outer =
          await (await outerElement.elementHandle())!.contentFrame();
        assert.ok(outer);
        await outer.waitForFunction(
          () => document.querySelector("iframe") !== null,
        );
        await outer
          .frameLocator("iframe")
          .locator("#connection")
          .filter({ hasText: /^工作区已连接$/ })
          .waitFor();
        const history = outer.childFrames()[0];
        assert.ok(history);
        await history.waitForFunction(
          () =>
            document.getElementById("connection")?.textContent ===
            "工作区已连接",
        );
        assert.equal(
          app.requests.filter(
            (r) => r.path === "/api/platform/cognitive-app-views/launch",
          ).length,
          launchesBefore,
        );
        await history.locator("#read").click();
        await status(history, "已读取所选精确版本");
        assert.equal(await history.locator("#original").textContent(), body1);
        const input = app.page.getByRole("textbox", {
          name: "AI 输入内容",
          exact: true,
        });
        if (!(await input.isVisible()))
          await app.page.keyboard.press("Control+j");
        await input.fill("真实本窗口未发送草稿\n保留这一行");
        const beforeCompose = await app.stored();
        await history.locator("#compose").click();
        await status(history, "原文引用已准备到输入框");
        const afterCompose = await app.stored();
        const draft = Object.values(afterCompose).find(
          (value) =>
            value.cognitiveObject?.object.objectId === saved.object!.objectId,
        );
        assert.ok(draft);
        assert.equal(
          draft.body,
          "真实本窗口未发送草稿\n保留这一行\n请基于这份原文整理要点。",
        );
        assert.equal(draft.cognitiveObject!.object.versionRef, first.version);
        assert.equal(
          draft.cognitiveApplication!.connectionId,
          f.target.connectionId,
        );
        assert.equal(draft.cognitiveObject!.projectId, f.projectId);
        assert.ok(
          !JSON.stringify(draft).includes(body1),
          "input carries the exact opaque original reference, never copied body",
        );
        assert.ok(
          !JSON.stringify(draft).includes(JSON.stringify(body1).slice(1, -1)),
          "JSON-escaped real multiline body must not be hidden in any draft field",
        );
        for (const [key, value] of Object.entries(beforeCompose))
          if (!value.body.includes("真实本窗口未发送草稿"))
            assert.deepEqual(afterCompose[key], value);
        assert.equal(await input.inputValue(), draft.body);
        assert.deepEqual(
          await app.recentContent(),
          [],
          "author reads and draft preparation are not premature Host visits",
        );
        const openingAt = Date.now();
        await history.locator("#open").click();
        const original = app.page.getByRole("article", {
          name: title,
          exact: true,
        });
        await original.waitFor();
        assert.ok(
          (await original.textContent())!.includes(`原始作者正文 ${backend}`),
        );
        assert.ok(
          !(await original.textContent())!.includes("生产 App 的实际修订"),
        );
        await outerElement.waitFor({ state: "detached" });
        const location = (await app.preferences()).cognitiveLocation;
        assert.equal(location.kind, "original");
        assert.equal(location.locator.object.versionRef, first.version);
        assert.equal(location.locator.projectId, f.projectId);
        assert.equal(location.locator.connectionId, f.target.connectionId);
        const visits = await app.recentContent();
        assert.equal(visits.length, 1);
        assert.equal(visits[0]!.artifactId, location.locator.contentId);
        assert.ok(
          visits[0]!.openedAt >= openingAt && visits[0]!.openedAt <= Date.now(),
          "the original personal visit projection records the committed open",
        );
        assert.deepEqual(
          await app.stored(),
          afterCompose,
          "terminal original navigation preserves the source's local draft",
        );
        assert.deepEqual(
          await unsent(f),
          pendingBefore,
          "GUI and compose do not submit input, task, Session or Runtime delivery",
        );
        assert.deepEqual(
          {
            definitions: f.authorRows("author_definitions"),
            metadata: f.authorRows("metadata"),
            acl: f.authorRows("project_acl"),
          },
          premisses,
        );
        assert.deepEqual(app.errors, []);
        assert.equal(
          f.authorCalls.filter((request) => request.path === "/invoke").length,
          3,
          "one explicit list and two explicit writes invoke author business; no retry",
        );
        assert.equal(
          f.authorCalls.filter((request) => request.path === "/objects/read")
            .length,
          2,
          "one explicit history read and one terminal original read; no automatic business re-read",
        );
        const screenshot = `/tmp/morphz-production-notes-${backend}-original-oct06.png`;
        await app.page.screenshot({ path: screenshot });
        console.log(
          `production App ${backend} terminal original screenshot: ${screenshot}`,
        );
      } catch (error) {
        await app.diagnostics(`${backend}-happy-failure`, error);
        throw error;
      } finally {
        try {
          await app.close();
        } finally {
          await f.close();
        }
      }
    },
  );
  test(
    `ACTUAL production App Web + ${backend}: real SQL change notification clears revoked GUI without focus/polling and never revives its old Document`,
    { timeout: 120_000 },
    async () => {
      const f = await openNotesGuiTransports(backend, packed);
      const app = await openNotesProductionApp(f, ui.webRoot).catch(
        async (error) => {
          await f.close();
          throw error;
        },
      );
      try {
        const { guest, outerElement } = await app.openGui();
        await create(
          guest,
          `TEST live grant ${backend}`,
          "真实原文，撤权后不能读",
        );
        const storedBefore = await app.stored();
        const authorBefore = f.authorCalls.length;
        const versionBefore = app.versions.at(-1)!;
        const versionCountBefore = app.versions.length;
        assert.ok(
          app.responses.some(
            (r) =>
              r.path === "/api/platform/workspace/stream" && r.status === 200,
          ),
        );
        const disabled = parseCognitiveAppGrant(
          await f.call("cognitive-apps.grant", {
            appId: f.target.appId,
            version: f.target.version,
            expectedRevision: 1,
            state: "disabled",
          }),
        );
        assert.equal(disabled.revision, 2);
        assert.equal(disabled.state, "disabled");
        app.trace.push({
          at: Date.now(),
          event: "grant-committed",
          path: "cognitive-apps.grant",
          value: disabled,
        });
        // No synthetic focus event, manual refresh or repeated client polling.
        // Real SQL source triggers HPA's actual changed access hash and the App
        // clears its protected owner. The old WindowProxy may not be reattached.
        await outerElement.waitFor({ state: "detached" });
        assert.ok(
          app.versions
            .slice(versionCountBefore)
            .some(
              (value) => value.accessVersion !== versionBefore.accessVersion,
            ),
        );
        assert.equal(guest.isDetached(), true);
        assert.equal(f.authorCalls.length, authorBefore);
        assert.deepEqual(await app.stored(), storedBefore);
        const catalogResponse = app.page.waitForResponse(async (response) => {
          if (
            new URL(response.url()).pathname !==
              "/api/platform/cognitive-apps/list" ||
            response.status() !== 200
          )
            return false;
          const catalog = await response.json();
          return catalog.versions.some(
            (value: {
              appId: string;
              version: string;
              grant: { revision: number; state: string } | null;
            }) =>
              value.appId === f.target.appId &&
              value.version === f.target.version &&
              value.grant?.revision === 3 &&
              value.grant.state === "active",
          );
        });
        // If an earlier assertion fails, cleanup closes the actual page. Keep
        // that pending listener's rejection observed without replacing the
        // original promise or weakening its required success below.
        void catalogResponse.catch(() => undefined);
        const restored = parseCognitiveAppGrant(
          await f.call("cognitive-apps.grant", {
            appId: f.target.appId,
            version: f.target.version,
            expectedRevision: 2,
            state: "active",
          }),
        );
        assert.equal(restored.revision, 3);
        assert.equal(restored.state, "active");
        app.trace.push({
          at: Date.now(),
          event: "grant-committed",
          path: "cognitive-apps.grant",
          value: restored,
        });
        await catalogResponse;
        await app.page
          .getByRole("button", {
            name: "TEST isolated actual notes GUI",
            exact: true,
          })
          .waitFor();
        assert.equal(
          guest.isDetached(),
          true,
          "grant recovery cannot revive a detached old author Document",
        );
        assert.equal(
          f.authorCalls.length,
          authorBefore,
          "restored permission does not retry business",
        );
        assert.deepEqual(await app.stored(), storedBefore);
        assert.deepEqual(app.errors, []);
        assert.ok(
          !app.requests.some(
            (r) => r.path === "/api/platform/messages" && r.method === "POST",
          ),
        );
        // A mid-read catalog HTTP200 alone cannot prove publication into the
        // actual React choice directory. Human explicitly chooses again; the
        // real opener captures grant3 and checks the fresh readUi response.
        // Persistent authorized views may independently restore a NEW owner;
        // this does not permit continuation of the detached old Document.
        let observedReopen:
          | ReturnType<typeof parseCognitiveAppViewResponse<"readUi">>
          | undefined;
        const reopenedSource = app.page.waitForResponse(async (response) => {
          if (
            new URL(response.url()).pathname !==
              "/api/platform/cognitive-app-views/read-ui" ||
            response.status() !== 200
          )
            return false;
          let body: unknown;
          try {
            body = await response.json();
          } catch (error) {
            // Chromium may discard a retired Document's response body while
            // another legitimate readUi is in flight. This observer cannot
            // rescue it or trigger a read: require an actually readable later
            // response plus the new connected Document below. Schema failures
            // and every other observation failure still reject this test.
            if (
              !(error instanceof Error) ||
              !error.message.includes("Network.getResponseBody") ||
              !error.message.includes("No data found for resource")
            )
              throw error;
            app.trace.push({
              at: Date.now(),
              event: "observer-retired-response-body-unavailable",
              path: "/api/platform/cognitive-app-views/read-ui",
              value: error.message,
            });
            return false;
          }
          const source = parseCognitiveAppViewResponse("readUi", body);
          const matches =
            source.grantRevision === 3 &&
            source.view.workspaceId === f.projectId &&
            source.binding.connectionId === f.target.connectionId &&
            source.definition.id === f.target.appId &&
            source.definition.version === f.target.version;
          if (matches) observedReopen = source;
          return matches;
        });
        void reopenedSource.catch(() => undefined);
        const reopened = await app.openGui();
        await reopenedSource;
        const source = observedReopen;
        assert.ok(
          source,
          "fresh readUi exact grant3 facts were actually observed",
        );
        assert.equal(source.grantRevision, 3);
        assert.equal(source.connectionRevision, 1);
        assert.equal(source.view.workspaceId, f.projectId);
        assert.equal(source.binding.connectionId, f.target.connectionId);
        assert.notEqual(reopened.guest, guest);
        assert.equal(guest.isDetached(), true);
        assert.equal(reopened.guest.isDetached(), false);
        assert.equal(f.authorCalls.length, authorBefore);
        assert.deepEqual(await app.stored(), storedBefore);
      } catch (error) {
        await app.diagnostics(`${backend}-live-failure`, error);
        throw error;
      } finally {
        try {
          await app.close();
        } finally {
          await f.close();
        }
      }
    },
  );
  test(
    `ACTUAL production App Web + ${backend}: controlled delivery hold of a real SQL/HPA locator HTTP200 cannot alter old/new drafts after real Human navigation`,
    { timeout: 120_000 },
    async () => {
      const f = await openNotesGuiTransports(backend, packed);
      const app = await openNotesProductionApp(f, ui.webRoot).catch(
        async (error) => {
          await f.close();
          throw error;
        },
      );
      try {
        const { guest, outerElement } = await app.openGui();
        const created = await create(
          guest,
          `TEST actual late compose ${backend}`,
          "原作者版本一\n未发送的原文引用。",
        );
        const originalSource = await f.source();
        const note = f.authorRows("notes")[0]!;
        assert.equal(typeof note.object_id, "string");
        assert.equal(note.current_version_ref, created.version);
        const input = app.page.getByRole("textbox", {
          name: "AI 输入内容",
          exact: true,
        });
        if (!(await input.isVisible()))
          await app.page.keyboard.press("Control+j");
        const oldBody = `原应用旧范围草稿 ${backend}\n原内容不可改。`;
        await input.fill(oldBody);
        const before = await app.stored();
        const oldKeys = Object.keys(before).filter(
          (key) => before[key]!.body === oldBody,
        );
        assert.equal(
          oldKeys.length,
          1,
          "actual original scope owns this draft",
        );
        const oldKey = oldKeys[0]!;
        assert.ok(oldKey.includes(":cognitive:"));
        const beforeLocation = (await app.preferences()).cognitiveLocation;
        assert.equal(beforeLocation.kind, "view");
        const noSend = await unsent(f);
        const platformCommands = await f.rows("cognitive_app_commands");
        const authorFacts = {
          notes: f.authorRows("notes"),
          versions: f.authorRows("note_versions"),
          commands: f.authorRows("author_commands"),
          definitions: f.authorRows("author_definitions"),
          metadata: f.authorRows("metadata"),
          acl: f.authorRows("project_acl"),
        };
        const authorBefore = f.authorCalls.length;
        const hold = app.holdNextResolution(
          note.object_id as string,
          originalSource.authority.instanceId,
        );
        const actual200 = app.page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname === "/api/platform/content/resolve" &&
            url.searchParams.get("appObjectId") === note.object_id &&
            response.status() === 200
          );
        });
        void actual200.catch(() => undefined);
        // The actual installed author calls the public SDK through its original
        // private port. There is no guest-to-Host test call or synthetic reply.
        await guest.locator("#compose").click();
        // Both events are required; the real response waiter's existing
        // deadline also retires a capture when no matching request is sent.
        const [held, response] = await Promise.all([hold.captured, actual200]);
        assert.match(
          (await response.headerValue("content-type")) ?? "",
          /^application\/json; charset=utf-8$/i,
        );
        assert.equal(held.status, 200);
        assert.equal(held.source.projectId, f.projectId);
        assert.equal(held.source.appId, f.target.appId);
        assert.equal(
          held.source.instanceId,
          originalSource.authority.instanceId,
        );
        assert.equal(held.source.appObjectId, note.object_id);
        assert.equal(held.query.appObjectId, note.object_id);
        assert.deepEqual(JSON.parse(held.body), held.source);
        await guest.locator("#compose:disabled").waitFor();
        assert.deepEqual(await app.stored(), before);
        const cancellation = app.page.waitForEvent("requestfailed", {
          predicate: (request) => request === response.request(),
        });
        void cancellation.catch(() => undefined);

        // The original App navigation retires the source lease/consumer and
        // its real HTTP signal. This is not the author's SDK cancel/dispose.
        await app.page
          .getByRole("navigation", { name: "主导航", exact: true })
          .getByRole("button", { name: "对话", exact: true })
          .click();
        await outerElement.waitFor({ state: "detached" });
        assert.equal(guest.isDetached(), true);
        const afterLocation = (await app.preferences()).cognitiveLocation;
        assert.equal(afterLocation, null);
        if (!(await input.isVisible()))
          await app.page.keyboard.press("Control+j");
        const newBody = `正常导航新范围草稿 ${backend}\n不得追加旧应用的文字。`;
        await input.fill(newBody);
        const afterNavigation = await app.stored();
        const newKeys = Object.keys(afterNavigation).filter(
          (key) => afterNavigation[key]!.body === newBody,
        );
        assert.equal(newKeys.length, 1);
        const newKey = newKeys[0]!;
        assert.notEqual(newKey, oldKey, "actual persistent scope key changed");
        assert.deepEqual(afterNavigation[oldKey], before[oldKey]);
        for (const [key, value] of Object.entries(before))
          if (key !== newKey) assert.deepEqual(afterNavigation[key], value);
        assert.equal(afterNavigation[newKey]!.body, newBody);
        const cancelledRequest = await cancellation;
        assert.equal(cancelledRequest, response.request());
        assert.equal(cancelledRequest.failure()?.errorText, "net::ERR_ABORTED");
        const closed = await actualEventDeadline(
          hold.closed,
          "this exact resolver response endpoint close",
        );
        assert.equal(closed.destroyed, true);
        assert.ok(closed.at >= held.at);
        assert.equal(
          hold.events.some((event) => event.event === "real-finish"),
          false,
          "this exact real resolver body was not consumed before retirement",
        );
        const retireAt = Date.now();
        hold.release();
        assert.equal(
          hold.events.filter((event) => event.event === "release-original-end")
            .length,
          1,
        );
        assert.ok(
          hold.events.some(
            (event) =>
              event.event === "release-original-end" && event.at >= retireAt,
          ),
        );
        // Chromium's actual abort/body-discard is the bounded Web negative.
        // Do not fake ignoring AbortSignal or claim a destroyed SDK Promise
        // terminal state/physical private-wire ACK count is observable here.
        await app.page.waitForFunction(
          () => !document.querySelector("iframe.cognitive-application-frame"),
        );
        assert.deepEqual(await app.stored(), afterNavigation);
        assert.equal(await input.inputValue(), newBody);
        assert.deepEqual(await unsent(f), noSend);
        assert.deepEqual(
          await f.rows("cognitive_app_commands"),
          platformCommands,
        );
        assert.deepEqual(
          {
            notes: f.authorRows("notes"),
            versions: f.authorRows("note_versions"),
            commands: f.authorRows("author_commands"),
            definitions: f.authorRows("author_definitions"),
            metadata: f.authorRows("metadata"),
            acl: f.authorRows("project_acl"),
          },
          authorFacts,
        );
        assert.equal(f.authorCalls.length, authorBefore);
        assert.ok(
          !app.requests.some(
            (request) =>
              request.path === "/api/platform/messages" &&
              request.method === "POST",
          ),
        );
        assert.deepEqual(app.errors, []);
        console.log(
          JSON.stringify({
            backend,
            scope:
              "actual production App, real SQL/HPA response; Node delivery timing controlled",
            original: {
              viewId: originalSource.view.id,
              viewRevision: originalSource.view.revision,
              bindingRevision: originalSource.binding.revision,
              object: { objectId: note.object_id, versionRef: created.version },
              location: beforeLocation,
              key: oldKey,
            },
            destination: { location: afterLocation, key: newKey },
            held: {
              path: held.path,
              query: held.query,
              status: held.status,
              source: held.source,
              at: held.at,
            },
            delivery: hold.events,
            network: app.trace.filter((event) =>
              event.event.startsWith("resolver-"),
            ),
            sourceDocumentDetached: guest.isDetached(),
            promiseTerminalState: "not observable after Document retirement",
          }),
        );
      } catch (error) {
        await app.diagnostics(`${backend}-late-compose-failure`, error);
        throw error;
      } finally {
        try {
          await app.close();
        } finally {
          await f.close();
        }
      }
    },
  );
}
