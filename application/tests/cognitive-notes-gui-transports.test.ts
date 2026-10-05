import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { randomUUID } from "node:crypto";
import { packCognitiveNotesGui } from "./fixtures/cognitive-notes-gui-package.js";
import {
  openNotesGuiTransports,
  type NotesGuiMounted,
  type NotesGuiTransports,
  type NotesGuiPack,
} from "./fixtures/cognitive-notes-gui-transports.js";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";
import { parseCognitiveAppViewResponse } from "../packages/core/src/cognitive-app-view-api.js";
import {
  parseDomainReceipt,
  parseReceiptReadRequest,
} from "../packages/cognitive-app-sdk/src/domain-wire.js";

/** Actual author business/SQL/HPA/adapter/SDK/private-port/compose components.
 * The mounted owner and Local/Remote Chromium resource delivery are controlled
 * test shells, not original App.tsx or native Electron acceptance. open ACK is
 * intentionally not claimed before production navigation hand-off exists.
 */
let packed: NotesGuiPack;
before(() => {
  packed = packCognitiveNotesGui();
  packed.build();
});
after(() => packed?.close());
const adapters = ["Web", "Local", "Remote"] as const;
async function status(m: NotesGuiMounted, pattern: string) {
  await m.guest.waitForFunction(
    (pattern) =>
      document.getElementById("status")?.textContent?.includes(pattern),
    pattern,
  );
}
async function create(m: NotesGuiMounted, title: string, body: string) {
  await m.guest.locator("#new").click();
  await m.guest.locator("#title").fill(title);
  await m.guest.locator("#markdown").fill(body);
  await m.guest.locator("#save").click();
  await status(m, "作者已确认保存");
  return {
    commandId: await m.guest.locator("#command").inputValue(),
    version: (await m.guest.locator("#version").textContent())!.replace(
      "精确版本：",
      "",
    ),
  };
}
async function facts(f: NotesGuiTransports) {
  return {
    commands: await f.rows("cognitive_app_commands"),
    content: await f.rows("content_entries"),
    notes: f.authorRows("notes"),
    versions: f.authorRows("note_versions"),
    authorCommands: f.authorRows("author_commands"),
  };
}
async function unsentFacts(f: NotesGuiTransports) {
  // Inputs reach Runtime through this real Host delivery ledger, not a
  // nonexistent Platform "inputs" table. SQL metadata alone is insufficient.
  return {
    conversations: await f.rows("conversations"),
    tasks: await f.rows("tasks"),
    runtime: f.local.application.store.runtimeState(),
    sessions: f.transportRows("runtime_sessions"),
    deliveries: f.transportRows("runtime_deliveries"),
    publications: f.transportRows("runtime_publications"),
    bindings: f.transportRows("runtime_thread_bindings"),
    events: f.transportRows("runtime_session_events"),
  };
}
type Snapshot = {
  key: string;
  prepared: number;
  retired: number;
  held: number;
  refused: string[];
  input: string;
  published: Record<string, InputDraft>;
  rendered: Record<string, InputDraft>;
  stored: Record<string, InputDraft>;
  calls: { method: string; params: any; ok: boolean }[];
};
async function snapshot(m: NotesGuiMounted) {
  return (await m.snapshot()) as Snapshot;
}
async function settledControl(m: NotesGuiMounted, id: string) {
  await m.guest.waitForFunction((id) => {
    const control = document.getElementById(id);
    return control instanceof HTMLButtonElement && !control.disabled;
  }, id);
}
async function commandAction(
  m: NotesGuiMounted,
  button: "status-command" | "recover",
  commandId: string,
) {
  const method =
    button === "status-command"
      ? "cognitive-apps.command-status"
      : "cognitive-apps.recover";
  const before = (await snapshot(m)).calls.length;
  await m.guest.locator("#" + button).click();
  await m.page.waitForFunction(
    ({ method, commandId, before }) =>
      Reflect.get(window, "notesGuiOwner")
        .snapshot()
        .calls.slice(before)
        .some(
          (entry: {
            method: string;
            params: { commandId?: string };
            ok: boolean;
          }) =>
            entry.method === method &&
            entry.params.commandId === commandId &&
            entry.ok,
        ),
    { method, commandId, before },
  );
  // The already-rendered status text is not a new response witness. The actual
  // call must return and the author SDK must settle its current busy operation.
  await settledControl(m, button);
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `ACTUAL packed author SQLite + Platform ${backend}: Web/Local/Remote same fixed target, GUI create/read/revise/history, original-ID receipts and committed compose`,
    { timeout: 180_000 },
    async (t) => {
      const f = await openNotesGuiTransports(backend, packed);
      try {
        const authorPremises = {
          definitions: f.authorRows("author_definitions"),
          metadata: f.authorRows("metadata"),
          acl: f.authorRows("project_acl"),
        };
        const unsentBusiness = await unsentFacts(f);
        let authority: unknown;
        for (const adapter of adapters)
          await t.test(adapter, async () => {
            const before = await facts(f),
              callsBefore = f.authorCalls.length;
            const m = await f.mount(adapter);
            try {
              if (authority) assert.deepEqual(m.source.authority, authority);
              else authority = m.source.authority;
              assert.equal(
                m.source.binding.connectionId,
                f.target.connectionId,
              );
              assert.equal(m.source.binding.projectId, f.projectId);
              assert.deepEqual(
                await facts(f),
                before,
                "opening GUI reads metadata only, no automatic business write/read",
              );
              assert.equal(
                f.authorCalls.length,
                callsBefore,
                "GUI connect/context does not invoke or read author business",
              );
              await m.guest.locator("#refresh").click();
              await status(m, "笔记列表已读取");
              const title = `TEST ${backend} ${adapter} real original`;
              const body1 = `真实原文 ${adapter}\n第二行😀 <script>不可执行</script>`;
              const first = await create(m, title, body1);
              assert.match(first.commandId, /^[a-f0-9-]{36}$/);
              assert.equal(
                await m.guest.locator("#original").textContent(),
                body1,
              );
              await m.guest.locator("#remember").click();
              await status(m, "已记住阅读位置");
              const oldState = (await f.source()).view.state;
              assert.ok(oldState.object);
              assert.equal(oldState.object.versionRef, first.version);
              assert.deepEqual(Object.keys(oldState).sort(), [
                "object",
                "view",
              ]);
              await m.guest.locator("#edit").click();
              const body2 = body1 + "\n修订后的新行";
              await m.guest.locator("#markdown").fill(body2);
              await m.guest.locator("#save").click();
              await status(m, "作者已确认保存");
              const secondCommand = await m.guest
                .locator("#command")
                .inputValue();
              const secondVersion = (await m.guest
                .locator("#version")
                .textContent())!.replace("精确版本：", "");
              assert.notEqual(secondCommand, first.commandId);
              assert.notEqual(secondVersion, first.version);
              await commandAction(m, "status-command", secondCommand);
              await status(m, "作者已确认保存");
              await commandAction(m, "recover", secondCommand);
              await status(m, "作者已确认保存");
              assert.equal(
                await m.guest.locator("#command").inputValue(),
                secondCommand,
              );
              const rows = await facts(f);
              assert.equal(rows.notes.length, before.notes.length + 1);
              assert.equal(rows.versions.length, before.versions.length + 2);
              assert.equal(
                rows.authorCommands.length,
                before.authorCommands.length + 2,
              );
              const commands = rows.commands.filter(
                (row) =>
                  row.command_id === first.commandId ||
                  row.command_id === secondCommand,
              );
              assert.equal(commands.length, 2);
              assert.ok(
                commands.every(
                  (row) =>
                    row.state === "committed" &&
                    row.projection_state === "projected",
                ),
              );
              const entry = rows.content.find(
                (row) => row.app_object_id === oldState.object!.objectId,
              );
              assert.ok(entry);
              assert.equal(entry.observed_version_ref, secondVersion);
              await m.close();
              const history = await f.mount(adapter);
              try {
                const noAutoRead = f.authorCalls.filter(
                  (value) => value.path === "/objects/read",
                ).length;
                await history.guest.locator("#read").click();
                await status(history, "已读取所选精确版本");
                assert.equal(
                  await history.guest.locator("#original").textContent(),
                  body1,
                  "saved historical opaque V1 is not silently latest V2",
                );
                assert.equal(
                  f.authorCalls.filter(
                    (value) => value.path === "/objects/read",
                  ).length,
                  noAutoRead + 1,
                );
                const beforeCompose = await facts(f);
                await history.latest();
                const latest = await snapshot(history);
                await history.guest.locator("#compose").click();
                await status(history, "原文引用已准备到输入框");
                const committed = await snapshot(history),
                  draft = committed.published[committed.key]!;
                assert.equal(committed.prepared, 1);
                assert.equal(committed.input, draft.body);
                assert.equal(
                  draft.body,
                  "实际最新草稿\n第二行\n请基于这份原文整理要点。",
                );
                assert.equal(draft.model, "latest-fixture-model");
                assert.equal(draft.reasoningEffort, "high");
                assert.deepEqual(
                  draft.attachments,
                  latest.published[latest.key]!.attachments,
                );
                assert.deepEqual(
                  committed.published[f.projectId + ":quotes"],
                  latest.published[f.projectId + ":quotes"],
                );
                assert.deepEqual(
                  committed.published.unrelated,
                  latest.published.unrelated,
                );
                assert.deepEqual(
                  draft.cognitiveObject?.object,
                  oldState.object,
                );
                assert.equal(
                  draft.cognitiveObject?.contentId,
                  entry.content_id,
                );
                assert.deepEqual(
                  draft.cognitiveObject?.authority,
                  history.source.authority,
                );
                assert.equal(
                  draft.cognitiveApplication?.connectionId,
                  f.target.connectionId,
                );
                assert.deepEqual(committed.stored, committed.published);
                assert.ok(
                  !JSON.stringify(draft).includes(body1),
                  "compose carries opaque reference, not original body copy",
                );
                assert.deepEqual(
                  await facts(f),
                  beforeCompose,
                  "compose never creates author commands/objects or input business",
                );
                assert.ok(
                  !committed.calls.some((value) =>
                    /platform\.message|tasks\.(?:create|run)|conversations\.(?:create|start)/.test(
                      value.method,
                    ),
                  ),
                );
                assert.deepEqual(history.errors, []);
                if (adapter !== "Web")
                  assert.ok(
                    history.resources.some(
                      (value) => value.status === 200 && value.bytes > 0,
                    ),
                  );
              } finally {
                await history.close();
              }
              assert.deepEqual(m.errors, []);
            } finally {
              await m.close();
            }
          });
        assert.deepEqual(
          {
            definitions: f.authorRows("author_definitions"),
            metadata: f.authorRows("metadata"),
            acl: f.authorRows("project_acl"),
          },
          authorPremises,
          "author releases, service/data authority and ACL are unchanged",
        );
        assert.deepEqual(
          await unsentFacts(f),
          unsentBusiness,
          "GUI and compose do not create an input, conversation, task, Session or Runtime delivery",
        );
      } finally {
        await f.close();
      }
    },
  );

  test(
    `ACTUAL ${backend} author response lost after COMMIT: each GUI keeps its original command/draft, explicit status/recovery reveals one real fact without reinvoke`,
    { timeout: 180_000 },
    async (t) => {
      const f = await openNotesGuiTransports(backend, packed);
      try {
        for (const adapter of adapters)
          await t.test(adapter, async () => {
            const before = await facts(f),
              invokes = f.authorCalls.filter(
                (value) => value.path === "/invoke",
              ).length;
            const m = await f.mount(adapter);
            try {
              await m.guest.locator("#new").click();
              const title = `TEST lost response ${adapter}`,
                body = `作者实际提交后丢回执 ${adapter}\n保留草稿😀`;
              await m.guest.locator("#title").fill(title);
              await m.guest.locator("#markdown").fill(body);
              f.dropCommittedResponse();
              await m.guest.locator("#save").click();
              await status(m, "结果尚未确认");
              const commandId = await m.guest.locator("#command").inputValue();
              assert.match(commandId, /^[a-f0-9-]{36}$/);
              assert.equal(await m.guest.locator("#save").isDisabled(), true);
              assert.equal(await m.guest.locator("#new").isDisabled(), true);
              assert.equal(
                await m.guest.locator("#markdown").inputValue(),
                body,
              );
              const pending = await facts(f),
                hostCommand = pending.commands.find(
                  (row) => row.command_id === commandId,
                );
              assert.ok(hostCommand);
              assert.equal(hostCommand.state, "unknown");
              const authorCommand = pending.authorCommands.filter(
                (row) => row.command_id === commandId,
              );
              assert.equal(authorCommand.length, 1);
              const originalReceipt = parseDomainReceipt(
                JSON.parse(String(authorCommand[0]!.receipt_json)),
              );
              assert.equal(originalReceipt.status, "committed");
              assert.equal(originalReceipt.binding.commandId, commandId);
              assert.equal(
                originalReceipt.binding.requestHash,
                hostCommand.request_hash,
              );
              assert.deepEqual(
                originalReceipt.binding.authority,
                m.source.authority,
              );
              assert.equal(pending.notes.length, before.notes.length + 1);
              assert.equal(pending.versions.length, before.versions.length + 1);
              assert.equal(
                pending.authorCommands.length,
                before.authorCommands.length + 1,
              );
              assert.equal(
                f.authorCalls.filter((value) => value.path === "/invoke")
                  .length,
                invokes + 1,
              );
              await commandAction(m, "status-command", commandId);
              await status(m, "结果尚未确认");
              assert.equal(
                await m.guest.locator("#command").inputValue(),
                commandId,
              );
              const receiptsBefore = f.authorCalls.length;
              await commandAction(m, "recover", commandId);
              await status(m, "作者已确认保存");
              const recovered = await facts(f),
                final = recovered.commands.find(
                  (row) => row.command_id === commandId,
                )!;
              assert.equal(final.state, "committed");
              assert.equal(final.projection_state, "projected");
              assert.ok(final.receipt_ref && final.receipt_hash);
              assert.deepEqual(recovered.notes, pending.notes);
              assert.deepEqual(recovered.versions, pending.versions);
              assert.deepEqual(
                recovered.authorCommands,
                pending.authorCommands,
              );
              assert.equal(
                f.authorCalls.filter((value) => value.path === "/invoke")
                  .length,
                invokes + 1,
                "explicit recovery never creates a second author invoke",
              );
              const recoveredReads = f.authorCalls
                .slice(receiptsBefore)
                .filter((value) => value.path === "/receipts/read");
              assert.equal(recoveredReads.length, 1);
              const recovery = parseReceiptReadRequest(recoveredReads[0]!.body);
              assert.equal(
                recovery.delegation.historicalAdmission.commandId,
                commandId,
              );
              assert.equal(
                recovery.delegation.historicalAdmission.requestHash,
                originalReceipt.binding.requestHash,
              );
              assert.deepEqual(
                recovery.delegation.authority,
                originalReceipt.binding.authority,
              );
              assert.equal(
                await m.guest.locator("#command").inputValue(),
                commandId,
              );
              assert.equal(
                await m.guest.locator("#original").textContent(),
                body,
              );
              assert.deepEqual(m.errors, []);
            } finally {
              await m.close();
            }
          });
      } finally {
        await f.close();
      }
    },
  );

  test(
    `ACTUAL ${backend} GUI compose: real locator barrier keeps latest draft; retired/window-owner-changed delayed continuations are refused without publication`,
    { timeout: 180_000 },
    async (t) => {
      const f = await openNotesGuiTransports(backend, packed);
      try {
        for (const adapter of adapters)
          await t.test(adapter, async () => {
            const m = await f.mount(adapter);
            try {
              await create(
                m,
                `TEST compose barrier ${adapter}`,
                "真实原文，不进入输入正文",
              );
              const business = await facts(f);
              await m.page.evaluate(() =>
                Reflect.get(window, "notesGuiOwner").holdLocator(),
              );
              await m.guest.locator("#compose").click();
              await m.page.waitForFunction(
                () =>
                  Reflect.get(window, "notesGuiOwner").snapshot().held === 1,
              );
              await m.latest();
              const latest = await snapshot(m);
              await m.page.evaluate(() =>
                Reflect.get(window, "notesGuiOwner").releaseLocator(),
              );
              await status(m, "原文引用已准备到输入框");
              const accepted = await snapshot(m);
              assert.equal(accepted.prepared, 1);
              assert.equal(
                accepted.input,
                "实际最新草稿\n第二行\n请基于这份原文整理要点。",
              );
              assert.deepEqual(
                accepted.published[accepted.key]!.attachments,
                latest.published[latest.key]!.attachments,
              );
              assert.equal(
                accepted.published[accepted.key]!.model,
                latest.published[latest.key]!.model,
              );
              assert.deepEqual(await facts(f), business);
              await m.page.evaluate(() =>
                Reflect.get(window, "notesGuiOwner").holdLocator(),
              );
              await m.guest.locator("#compose").click();
              await m.page.waitForFunction(
                () =>
                  Reflect.get(window, "notesGuiOwner").snapshot().held === 2,
              );
              const unchanged = await snapshot(m);
              if (adapter === "Local")
                await m.page.evaluate(() =>
                  Reflect.get(window, "notesGuiOwner").rotateWindowOwner(),
                );
              else await m.retire();
              await m.page.evaluate(() =>
                Reflect.get(window, "notesGuiOwner").releaseLocator(),
              );
              await m.page.waitForFunction(
                () =>
                  Reflect.get(window, "notesGuiOwner").snapshot().refused
                    .length > 0,
              );
              const refused = await snapshot(m);
              assert.equal(refused.prepared, unchanged.prepared);
              assert.deepEqual(refused.published, unchanged.published);
              assert.deepEqual(refused.stored, unchanged.stored);
              assert.equal(refused.input, unchanged.input);
              assert.deepEqual(await facts(f), business);
              assert.deepEqual(m.errors, []);
            } finally {
              await m.close();
            }
          });
      } finally {
        await f.close();
      }
    },
  );

  test(
    `ACTUAL ${backend} GUI live grant revision and stale view CAS: no protected author read/compose publication after revocation or close`,
    { timeout: 180_000 },
    async (t) => {
      const f = await openNotesGuiTransports(backend, packed);
      try {
        let grantRevision = 1;
        for (const adapter of adapters)
          await t.test(adapter, async () => {
            const m = await f.mount(adapter);
            try {
              await create(m, `TEST live permission ${adapter}`, "受权原件");
              const business = await facts(f),
                before = await snapshot(m);
              const callsBefore = f.authorCalls.length;
              await f.call("cognitive-apps.grant", {
                appId: f.target.appId,
                version: f.target.version,
                expectedRevision: grantRevision++,
                state: "disabled",
              });
              await m.guest.locator("#compose").click();
              await m.page.waitForFunction(() =>
                Reflect.get(window, "notesGuiOwner")
                  .snapshot()
                  .calls.some(
                    (value: { method: string; ok: boolean }) =>
                      value.method === "cognitive-app-views.read-ui" &&
                      !value.ok,
                  ),
              );
              const denied = await snapshot(m);
              assert.equal(denied.prepared, 0);
              assert.deepEqual(denied.published, before.published);
              assert.deepEqual(denied.stored, before.stored);
              assert.equal(f.authorCalls.length, callsBefore);
              assert.deepEqual(await facts(f), business);
              await f.call("cognitive-apps.grant", {
                appId: f.target.appId,
                version: f.target.version,
                expectedRevision: grantRevision++,
                state: "active",
              });
              // A fresh grant must not silently revive this old endpoint's fixed
              // admission. Per-request refusal need not itself destroy a Document.
              await settledControl(m, "compose");
              const oldCalls = (await snapshot(m)).calls.length;
              await m.guest.locator("#compose").click();
              await m.page.waitForFunction(
                (before) =>
                  Reflect.get(window, "notesGuiOwner")
                    .snapshot()
                    .calls.slice(before)
                    .some(
                      (value: { method: string; ok: boolean }) =>
                        value.method === "cognitive-app-views.read-ui" &&
                        value.ok,
                    ),
                oldCalls,
              );
              await settledControl(m, "compose");
              await status(m, "这次操作未获确认");
              const oldDenied = await snapshot(m);
              assert.equal(oldDenied.prepared, 0);
              assert.deepEqual(oldDenied.published, before.published);
              assert.deepEqual(oldDenied.stored, before.stored);
              assert.equal(f.authorCalls.length, callsBefore);
              assert.deepEqual(await facts(f), business);
              // A new Document separately reads the new grant facts.
              const fresh = await f.mount(adapter);
              try {
                const current = await f.source();
                const stale = {
                  viewId: current.view.id,
                  expectedViewRevision: current.view.revision + 1,
                  expectedBindingRevision: current.binding.revision,
                };
                await assert.rejects(
                  f.call("cognitive-app-views.read-ui", stale),
                  (error: unknown) =>
                    !!error &&
                    typeof error === "object" &&
                    Reflect.get(error, "status") === 409,
                );
                const protectedBeforeClose = await snapshot(fresh),
                  authorBeforeClose = f.authorCalls.length;
                const closed = parseCognitiveAppViewResponse(
                  "close",
                  await f.call("cognitive-app-views.close", {
                    viewId: current.view.id,
                    expectedViewRevision: current.view.revision,
                    expectedBindingRevision: current.binding.revision,
                    commandId: randomUUID(),
                  }),
                );
                await fresh.guest.locator("#refresh").click();
                await fresh.page.waitForFunction(() =>
                  Reflect.get(window, "notesGuiOwner")
                    .snapshot()
                    .calls.some(
                      (value: { method: string; ok: boolean }) =>
                        value.method === "cognitive-app-views.read-ui" &&
                        !value.ok,
                    ),
                );
                const deniedClosed = await snapshot(fresh);
                assert.equal(deniedClosed.prepared, 0);
                assert.deepEqual(
                  deniedClosed.stored,
                  protectedBeforeClose.stored,
                );
                assert.deepEqual(
                  deniedClosed.published,
                  protectedBeforeClose.published,
                );
                assert.equal(f.authorCalls.length, authorBeforeClose);
                assert.deepEqual(await facts(f), business);
                // Explicit next fixture opening retains the actual receipt CAS;
                // this is never a replay of the original 0/0 creation or rebinding.
                const reopened = parseCognitiveAppViewResponse(
                  "launch",
                  await f.call("cognitive-app-views.launch", {
                    ...f.target,
                    expectedGrantRevision: grantRevision,
                    commandId: randomUUID(),
                    expectedViewRevision: closed.receipt.viewRevision,
                    expectedBindingRevision: closed.receipt.bindingRevision,
                  }),
                );
                assert.equal(reopened.receipt.viewId, current.view.id);
                assert.deepEqual(fresh.errors, []);
              } finally {
                await fresh.close();
              }
              assert.deepEqual(m.errors, []);
            } finally {
              await m.close();
            }
          });
      } finally {
        await f.close();
      }
    },
  );
}
