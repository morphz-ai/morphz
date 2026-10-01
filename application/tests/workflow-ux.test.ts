import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { browserControlFixture } from "./browser-control-fixture.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import { localAccess, type Operation } from "../packages/core/src/model.js";
import { browserApplication } from "../packages/core/src/applications.js";
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XGmQAAAAASUVORK5CYII=",
  "base64",
);

test("standalone browser launches with no website artifact and cannot change its project", async () => {
  assert.equal(browserApplication.ui.presentation, "workspace");
  const fixture = await browserControlFixture();
  try {
    const instance = await fixture.client.launchAppView({
      commandId: randomUUID(),
      appId: browserApplication.id,
      packageVersion: browserApplication.version,
      projectId: fixture.projectId,
      state: {},
    });
    assert.equal(
      (await fixture.client.content({ projectId: fixture.projectId })).items
        .length,
      0,
    );
    assert.ok(instance.id);
    const broker = fixture.createBroker();
    const state = {
      pageId: randomUUID(),
      epoch: randomUUID(),
      artifactId: null,
      projectId: fixture.projectId,
      url: "https://example.com/",
      title: "Example",
      visible: true,
      granted: false,
    };
    const key = "a".repeat(64);
    await broker.register(state, key, localAccess);
    await assert.rejects(
      broker.exchange(
        { state: { ...state, projectId: "other" }, receipts: [] },
        key,
        localAccess,
      ),
      /更换/,
    );
    await assert.rejects(
      broker.register(
        { ...state, pageId: randomUUID(), projectId: "nonexistent" },
        key,
        localAccess,
      ),
    );
    await broker.exchange(
      { state: { ...state, granted: true }, receipts: [] },
      key,
      localAccess,
    );
    assert.equal(
      (await fixture.client.content({ projectId: fixture.projectId })).items
        .length,
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("draft and sent attachments do not become artifacts; upload ownership is enforced", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const attachment = {
      ...(await f.session().addAttachment({ name: "截图.png", data: image })),
      name: "截图.png",
    };
    const input: Operation = {
      type: "record-input",
      projectId: f.projectId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "",
      targetActantId: "morphz-agent",
      attachments: [attachment],
    };
    await assert.rejects(f.session().asset(attachment.assetId), /不存在|无权/);
    assert.deepEqual(
      Buffer.from((await f.session().asset(attachment.assetId, true)).bytes),
      image,
    );
    await assert.rejects(
      f
        .session({ principalId: "stranger", actantId: "stranger" })
        .asset(attachment.assetId, true),
      /身份|无权|不匹配/,
    );
    const command = { commandId: randomUUID(), operation: input };
    const receipt = await f.session().platformMessage(command);
    assert.deepEqual(await f.session().platformMessage(command), receipt);
    assert.deepEqual(
      await f.session().listPlatformContent({ projectId: f.projectId }),
      [],
    );
    const state = f.store.runtimeState() as {
      deliveries: {
        request: {
          message: {
            content: { value: { text: string; attachments: unknown[] } };
          };
        };
        resourceUploads: { assetId: string; dataBase64?: string }[];
      }[];
    };
    assert.equal(state.deliveries.length, 1);
    const delivery = state.deliveries[0]!;
    assert.equal(delivery.request.message.content.value.text, "");
    assert.equal(delivery.request.message.content.value.attachments.length, 1);
    assert.equal(delivery.resourceUploads[0]!.assetId, attachment.assetId);
    assert.equal(delivery.resourceUploads[0]!.dataBase64, undefined);
    assert.ok(!JSON.stringify(state).includes(image.toString("base64")));
    await assert.rejects(
      f.session().platformMessage({
        commandId: randomUUID(),
        operation: {
          ...input,
          attachments: [{ assetId: "a".repeat(64), name: "unknown.png" }],
        },
      }),
      /不存在|无权/,
    );
    const text = await f
      .session()
      .addAttachment({ name: "sample.txt", data: Buffer.from("仅供本机测试") });
    assert.equal(text.mime, "text/plain");
    assert.deepEqual(
      await f.session().listPlatformContent({ projectId: f.projectId }),
      [],
    );
    await assert.rejects(
      f
        .session()
        .addAttachment({ name: "unsafe.html", data: Buffer.from("<script/>") }),
      /支持/,
    );
    await f.reopen();
    assert.deepEqual(
      Buffer.from((await f.session().asset(attachment.assetId, true)).bytes),
      image,
    );
    assert.equal((f.store.runtimeState() as typeof state).deliveries.length, 1);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});
