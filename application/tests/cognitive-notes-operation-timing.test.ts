import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  packCognitiveNotesGui,
} from "./fixtures/cognitive-notes-gui-package.js";
import {
  openNotesGuiTransports,
  type NotesGuiMounted,
} from "./fixtures/cognitive-notes-gui-transports.js";
import { waitForNotesOperationStatus } from "./fixtures/cognitive-notes-operation-status.js";
import { cognitiveBrowserLimits } from "../packages/cognitive-app-sdk/src/browser-wire.js";

let packed: ReturnType<typeof packCognitiveNotesGui>;
before(() => {
  packed = packCognitiveNotesGui();
  packed.build();
});
after(() => packed?.close());

async function draft(m: NotesGuiMounted, title: string) {
  await m.guest.locator("#new").click();
  await m.guest.locator("#title").fill(title);
  await m.guest.locator("#markdown").fill("TEST retained timing-contract draft\n真实独立作者原文");
}
function deadline<T>(value: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    value,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("actual response never reached hold")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

test("real held COMMIT response after 13s still completes the same SDK operation once", { timeout: 90_000 }, async () => {
  const f = await openNotesGuiTransports("sqlite", packed);
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    const m = await f.mount("Web");
    const title = "TEST real 13s hold " + randomUUID();
    await draft(m, title);
    const hold = f.hold("/invoke");
    // Observe the exact unique request before the only click. This is the
    // original real HTTP response; the hold never manufactures its contents.
    const completed = m.page.waitForResponse((response) => {
      if (!response.url().endsWith("/api/platform/cognitive-apps/invoke") || response.status() !== 200) return false;
      const request = JSON.parse(response.request().postData() || "{}");
      return request.operationId === "notes.create" && request.parameters.title === title;
    }, { timeout: cognitiveBrowserLimits.deadlineMs });
    void completed.catch(() => undefined);
    await m.guest.locator("#save").click();
    const command = await m.guest.locator("#command").inputValue();
    await deadline(hold.reached, cognitiveBrowserLimits.deadlineMs);
    assert.equal(f.authorRows("author_commands").length, 1, "the real author has already committed before withholding HTTP200");
    const heldAt = Date.now();
    release = setTimeout(() => hold.release(), 13_000);
    await waitForNotesOperationStatus(m.guest, "作者已确认保存");
    const result = await (await completed).json();
    assert.ok(Date.now() - heldAt >= 13_000);
    assert.equal(result.commandId, command);
    assert.equal(result.command.state, "committed");
    assert.equal(result.command.projectionState, "projected");
    assert.equal(await m.guest.locator("#command").inputValue(), command);
    assert.equal(await m.guest.locator("#original").textContent(), "TEST retained timing-contract draft\n真实独立作者原文");
    assert.equal(f.authorRows("author_commands").length, 1);
    assert.equal(f.authorRows("note_versions").length, 1);
    assert.equal(f.authorCalls.filter((call) => call.path === "/invoke").length, 1, "no re-click, reinvoke or second command");
    const row = (await f.rows("cognitive_app_commands")).find((row) => row.command_id === command);
    assert.equal(row?.state, "committed");
    assert.equal(row?.projection_state, "projected");
  } finally {
    clearTimeout(release);
    await f.close();
  }
});

test("real SDK request deadline still rejects an unreleased committed response without resending", { timeout: 90_000 }, async () => {
  const f = await openNotesGuiTransports("sqlite", packed);
  try {
    const m = await f.mount("Web");
    await draft(m, "TEST real SDK deadline " + randomUUID());
    const hold = f.hold("/invoke");
    const start = Date.now();
    await m.guest.locator("#save").click();
    const command = await m.guest.locator("#command").inputValue();
    await deadline(hold.reached, cognitiveBrowserLimits.deadlineMs);
    assert.equal(f.authorRows("author_commands").length, 1);
    let terminalError: { name: string; message: string } | undefined;
    await assert.rejects(
      waitForNotesOperationStatus(m.guest, "作者已确认保存"),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        terminalError = { name: error.name, message: error.message };
        // A new test-side TimeoutError is not proof of the real SDK deadline.
        return /尚未确认保存结果|已结束|detached/i.test(error.message);
      },
    );
    assert.ok(Date.now() - start >= cognitiveBrowserLimits.deadlineMs - 500, "the actual SDK/channel deadline, not an 8s test guard, ended the operation");
    await m.page.waitForFunction(
      () => Reflect.get(window, "notesGuiOwner").snapshot().retired > 0,
    );
    assert.ok(f.authorRows("author_commands").some((row) => row.command_id === command));
    assert.equal(f.authorRows("author_commands").length, 1);
    assert.equal(f.authorRows("note_versions").length, 1);
    assert.equal(f.authorCalls.filter((call) => call.path === "/invoke").length, 1, "deadline never automatically reissues the committed write");
    console.log(JSON.stringify({
      case: "actual-sdk-request-deadline",
      elapsedAfterSaveMs: Date.now() - start,
      terminalError,
      authorCommands: f.authorRows("author_commands").length,
      authorVersions: f.authorRows("note_versions").length,
    }));
  } finally {
    await f.close();
  }
});
