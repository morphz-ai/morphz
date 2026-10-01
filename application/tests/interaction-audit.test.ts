import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { viewModelFixture } from "./view-model-fixture.js";
import {
  createDocument,
  reviseDocument,
} from "../packages/application/src/document-service.js";
import {
  SafeMarkdown,
  webURL,
  objectLink,
} from "../apps/web/src/SafeMarkdown.js";

test("交付回执与对象原子保存，幂等、跨输入隔离、失败回滚且重启可见", async () => {
  const fixture = await agentDomainFixture();
  const input = fixture.route;
  const other = fixture.input(fixture.projectId, "另一条输入");
  const firstInputId = (await fixture.readAcceptedInput(input)).input_id;
  const secondInputId = (await fixture.readAcceptedInput(other)).input_id;
  const deliveries = () =>
    fixture.withHuman((actor) =>
      fixture.domains.work.service.contentDeliveries(actor, {
        inputIds: [firstInputId, secondInputId],
      }),
    );
  const command = {
    commandId: randomUUID(),
    objectId: randomUUID(),
    projectId: fixture.projectId,
    title: "已交付",
    markdown: "实际内容",
  };
  const create = (route = input, request = command) =>
    fixture.withAgent(
      (actor) =>
        createDocument({
          ...fixture.domains.content,
          actor,
          instanceId: fixture.domains.content.instanceIds.objects,
          ...request,
        }),
      route,
    );
  try {
    const receipt = await create();
    assert.deepEqual(await create(), receipt);
    assert.equal((await deliveries()).length, 1);
    await assert.rejects(create(other), /相同命令|不同内容|另一项|改绑/);
    const before = await fixture.withHuman((actor) =>
      fixture.domains.work.service.listContent(actor, {}),
    );
    const missing = fixture.input();
    fixture.forgetInput(missing);
    await assert.rejects(
      create(missing, {
        ...command,
        commandId: randomUUID(),
        objectId: randomUUID(),
      }),
      /Unknown fixture|原始输入|来源/,
    );
    assert.deepEqual(
      await fixture.withHuman((actor) =>
        fixture.domains.work.service.listContent(actor, {}),
      ),
      before,
    );
    assert.equal((await deliveries()).length, 1);
    const projectId = randomUUID();
    await fixture.withHuman((actor) =>
      fixture.domains.work.service.createProject(actor, {
        commandId: randomUUID(),
        projectId,
        title: "另一个项目",
      }),
    );
    await assert.rejects(
      create(input, {
        ...command,
        commandId: randomUUID(),
        objectId: randomUUID(),
        projectId,
        title: "跨项目",
        markdown: "",
      }),
      /范围|项目|输入/,
    );
    await fixture.withAgent(
      (actor) =>
        reviseDocument({
          ...fixture.domains.content,
          actor,
          instanceId: fixture.domains.content.instanceIds.objects,
          commandId: randomUUID(),
          objectId: receipt.original.objectId,
          expectedRevision: 1,
          title: "已修订",
          markdown: "第二版",
        }),
      other,
    );
    assert.deepEqual(
      (await deliveries()).map((o) => [o.inputId, Number(o.versionRef)]),
      [
        [firstInputId, 1],
        [secondInputId, 2],
      ],
    );
    await fixture.reopen();
    assert.equal((await deliveries()).length, 2);
    await assert.rejects(
      fixture.domains.work.authority.withSession(
        { principalId: "outsider", actantId: "outsider" },
        () => {},
        (actor) =>
          fixture.domains.work.service.contentDeliveries(actor, {
            inputIds: [firstInputId, secondInputId],
          }),
      ),
      /失效|无权|身份/,
    );
    fixture.assertNoLegacyData();
  } finally {
    await fixture.close();
  }
});

test("Markdown 只开放合法网页与授权对象；不会渲染脚本或主动加载外部图片", () => {
  assert.equal(webURL("javascript:alert(1)"), null);
  assert.equal(webURL("file:///etc/passwd"), null);
  assert.equal(webURL("https://user:secret@example.com"), null);
  assert.equal(webURL("https://example.com/a"), "https://example.com/a");
  assert.equal(objectLink("morphz://artifact/test_1"), "test_1");
  assert.equal(objectLink("morphz://artifact/../other"), null);
  const fixture = viewModelFixture();
  const obj = fixture.seedArtifact({
    projectId: "first-project",
    title: "文档",
    content: { kind: "document", markdown: "正文" },
  });
  const html = renderToStaticMarkup(
    createElement(SafeMarkdown, {
      state: fixture.state,
      onOpen: () => {},
      children: [
        "[网页](https://example.com)",
        "[危险](javascript:alert%281%29)",
        "![外部图](https://example.com/image.png)",
        "[文件](file:///etc/passwd)",
        "[内部](morphz://artifact/" + obj.id + ")",
        "[未授权](artifact:missing)",
        '<script>alert("unsafe")</script>',
      ].join("\n\n"),
    }),
  );
  assert.match(html, /target="_blank"/);
  assert.match(html, /inline-object-link/);
  assert.match(html, /<button[^>]*inline-object-link[^>]*>未授权<\/button>/);
  assert.match(html, /查看外部图片/);
  assert.doesNotMatch(html, /<img|<script|href="(?:javascript|file):/);
});

test("Markdown 内嵌图片仅渲染授权对象使用的中心附件", () => {
  const fixture = viewModelFixture();
  // This verifies renderer visibility, not image-byte persistence.
  const assetId = "a".repeat(64);
  fixture.seedArtifact({
    projectId: "first-project",
    title: "已授权图片",
    content: { kind: "image", assetId, alt: "封面" },
  });
  const html = renderToStaticMarkup(
    createElement(SafeMarkdown, {
      state: fixture.state,
      onOpen: () => {},
      children:
        "![封面](/api/assets/" +
        assetId +
        ")\n\n![未知附件](/api/assets/missing)\n\n![外部](https://example.com/track.png)",
    }),
  );
  assert.equal((html.match(/<img /g) ?? []).length, 1);
  assert.ok(html.includes('src="/api/assets/' + assetId + '"'));
  assert.match(html, /未知附件（图片不可用）/);
  assert.doesNotMatch(html, /<img[^>]+example\.com/);
});
