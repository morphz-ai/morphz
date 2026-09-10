import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { RuntimeBridge } from "../apps/service/src/runtime.js";
import { BrowserBroker } from "../apps/service/src/browser.js";
import { localAccess, type Operation } from "../packages/core/src/model.js";
import { browserApplication } from "../packages/core/src/applications.js";
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XGmQAAAAASUVORK5CYII=",
  "base64",
);

test("standalone browser launches with no website artifact and cannot change its project", () => {
  assert.equal(browserApplication.ui.presentation, "workspace");
  const store = new WorkspaceStore(":memory:");
  try {
    const execute = (operation: Operation) =>
      store.execute({ commandId: randomUUID(), operation }, localAccess);
    const instance = execute({
      type: "launch-application",
      workspaceId: "first-project",
      applicationId: browserApplication.id,
      applicationVersion: browserApplication.version,
    });
    assert.equal(store.snapshot().artifacts.length, 0);
    assert.ok(
      store
        .snapshot()
        .applicationInstances.some((i) => i.id === instance.entityId),
    );
    const broker = new BrowserBroker(store);
    const state = {
      pageId: randomUUID(),
      epoch: randomUUID(),
      artifactId: null,
      projectId: "first-project",
      url: "https://example.com/",
      title: "Example",
      visible: true,
      granted: false,
    };
    const key = "a".repeat(64);
    broker.register(state, key, localAccess);
    assert.throws(
      () =>
        broker.exchange(
          { state: { ...state, projectId: "other" }, receipts: [] },
          key,
          localAccess,
        ),
      /更换/,
    );
    assert.throws(() =>
      broker.register(
        { ...state, pageId: randomUUID(), projectId: "nonexistent" },
        key,
        localAccess,
      ),
    );
    broker.exchange(
      { state: { ...state, granted: true }, receipts: [] },
      key,
      localAccess,
    );
    assert.equal(store.snapshot().artifacts.length, 0);
  } finally {
    store.close();
  }
});

test("draft and sent attachments do not become artifacts; upload ownership is enforced", async () => {
  const store = new WorkspaceStore(":memory:");
  const bridge = new RuntimeBridge(store, {
    url: "http://127.0.0.1:1",
    token: "test-only",
    namespace: randomUUID(),
  });
  try {
    const attachment = {
      ...store.addAsset(image),
      mime: "image/png" as const,
      name: "截图.png",
    };
    const input: Operation = {
      type: "record-input",
      projectId: "first-project",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "",
      targetActantId: "morphz-agent",
      attachments: [attachment],
    };
    assert.equal(
      store.visibleAsset(attachment.assetId, localAccess),
      undefined,
    );
    assert.ok(store.attachmentAsset(attachment.assetId, localAccess));
    assert.throws(
      () =>
        store.attachmentAsset(attachment.assetId, {
          principalId: "stranger",
          actantId: "stranger",
        }),
      /不匹配/,
    );
    const command = { commandId: randomUUID(), operation: input };
    const receipt = store.execute(command, localAccess);
    assert.deepEqual(store.execute(command, localAccess), receipt);
    assert.equal(store.snapshot().inputs.length, 1);
    assert.equal(store.snapshot().artifacts.length, 0);
    bridge.enqueue(receipt.entityId);
    const delivery = (store.runtimeState() as any).deliveries[0];
    assert.equal(delivery.request.message.content.value.text, "");
    assert.equal(delivery.request.message.content.value.attachments.length, 1);
    assert.equal(
      delivery.resourceUploads[0].dataBase64,
      image.toString("base64"),
    );
    bridge.enqueue(receipt.entityId);
    assert.equal((store.runtimeState() as any).deliveries.length, 1);
    assert.throws(
      () =>
        store.execute(
          {
            commandId: randomUUID(),
            operation: {
              ...input,
              attachments: [{ assetId: "a".repeat(64), name: "unknown.png" }],
            },
          },
          localAccess,
        ),
      /无权/,
    );
    const text = store.addAttachment(
      Buffer.from("仅供本机测试"),
      "sample.txt",
      localAccess,
    );
    assert.equal(text.mime, "text/plain");
    assert.equal(store.snapshot().artifacts.length, 0);
    assert.throws(
      () =>
        store.addAttachment(
          Buffer.from("<script/>"),
          "unsafe.html",
          localAccess,
        ),
      /支持/,
    );
  } finally {
    await bridge.stop();
    store.close();
  }
});
