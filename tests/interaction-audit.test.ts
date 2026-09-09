import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { localAccess, type Command } from "../packages/core/src/model.js";
import {
  SafeMarkdown,
  webURL,
  objectLink,
} from "../apps/web/src/SafeMarkdown.js";

test("交付回执与对象原子保存，幂等、跨输入隔离、失败回滚且重启可见", () => {
  const dir = mkdtempSync(join(tmpdir(), "morphz-output-audit-"));
  const file = join(dir, "workspace.sqlite");
  let store = new WorkspaceStore(file);
  const execute = (operation: Command["operation"]) =>
    store.execute({ commandId: randomUUID(), operation }, localAccess);
  try {
    const input = execute({
      type: "record-input",
      projectId: "first-project",
      body: "写一篇文档",
      selection: "",
      artifactId: null,
      artifactRevision: null,
      targetActantId: "morphz-agent",
    });
    const other = execute({
      type: "record-input",
      projectId: "first-project",
      body: "另一条输入",
      selection: "",
      artifactId: null,
      artifactRevision: null,
      targetActantId: "morphz-agent",
    });
    const command: Command = {
      commandId: randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: "first-project",
        title: "已交付",
        content: { kind: "document", markdown: "实际内容" },
      },
    };
    const receipt = store.execute(command, localAccess, input.entityId);
    assert.deepEqual(
      store.execute(command, localAccess, input.entityId),
      receipt,
    );
    assert.equal(store.artifactOutputs(localAccess).length, 1);
    assert.throws(
      () => store.execute(command, localAccess, other.entityId),
      /改绑/,
    );
    const before = store.snapshot().revision;
    assert.throws(
      () =>
        store.execute(
          { ...command, commandId: randomUUID() },
          localAccess,
          "missing-input",
        ),
      /原始输入/,
    );
    assert.equal(store.snapshot().revision, before);
    assert.equal(store.artifactOutputs(localAccess).length, 1);
    const project = execute({ type: "create-project", title: "另一个项目" });
    assert.throws(
      () =>
        store.execute(
          {
            commandId: randomUUID(),
            operation: {
              type: "create-artifact",
              projectId: project.entityId,
              title: "跨项目",
              content: { kind: "document", markdown: "" },
            },
          },
          localAccess,
          input.entityId,
        ),
      /原始输入/,
    );
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "revise-artifact",
          artifactId: receipt.entityId,
          expectedRevision: 1,
          title: "已修订",
          content: { kind: "document", markdown: "第二版" },
        },
      },
      localAccess,
      other.entityId,
    );
    assert.deepEqual(
      store.artifactOutputs(localAccess).map((o) => [o.inputId, o.revision]),
      [
        [input.entityId, 1],
        [other.entityId, 2],
      ],
    );
    store.close();
    store = new WorkspaceStore(file);
    assert.equal(store.artifactOutputs(localAccess).length, 2);
    assert.deepEqual(
      store.artifactOutputs({ principalId: "outsider", actantId: "outsider" }),
      [],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("Markdown 只开放合法网页与授权对象；不会渲染脚本或主动加载外部图片", () => {
  assert.equal(webURL("javascript:alert(1)"), null);
  assert.equal(webURL("file:///etc/passwd"), null);
  assert.equal(webURL("https://user:secret@example.com"), null);
  assert.equal(webURL("https://example.com/a"), "https://example.com/a");
  assert.equal(objectLink("morphz://artifact/test_1"), "test_1");
  assert.equal(objectLink("morphz://artifact/../other"), null);
  const store = new WorkspaceStore(":memory:");
  try {
    const obj = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "文档",
          content: { kind: "document", markdown: "正文" },
        },
      },
      localAccess,
    );
    const html = renderToStaticMarkup(
      createElement(SafeMarkdown, {
        state: store.snapshot(),
        onOpen: () => {},
        children: [
          "[网页](https://example.com)",
          "[危险](javascript:alert%281%29)",
          "![外部图](https://example.com/image.png)",
          "[文件](file:///etc/passwd)",
          "[内部](morphz://artifact/" + obj.entityId + ")",
          "[未授权](artifact:missing)",
          '<script>alert("unsafe")</script>',
        ].join("\n\n"),
      }),
    );
    assert.match(html, /target="_blank"/);
    assert.match(html, /inline-object-link/);
    assert.match(html, /未授权（不可用）/);
    assert.match(html, /查看外部图片/);
    assert.doesNotMatch(html, /<img|<script|href="(?:javascript|file):/);
  } finally {
    store.close();
  }
});

test("Markdown 内嵌图片仅渲染授权对象使用的中心附件", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=",
      "base64",
    );
    const { assetId } = store.addAsset(bytes);
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "已授权图片",
          content: { kind: "image", assetId, alt: "封面" },
        },
      },
      localAccess,
    );
    const html = renderToStaticMarkup(
      createElement(SafeMarkdown, {
        state: store.snapshot(),
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
  } finally {
    store.close();
  }
});
