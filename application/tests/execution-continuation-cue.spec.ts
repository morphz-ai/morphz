import { expect, type Page } from "@playwright/test";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";

async function prepare(page: Page) {
  const inputs: PlatformHistory["inputs"] = [];
  const runtime: PlatformHistory["runtime"] = {
    ...disconnectedRuntime,
    configured: true,
    connected: true,
    messages: [],
    deliveries: ["a", "b"].map((id) => ({
      inputId: `TEST-cue-${id}`,
      state: "completed",
      error: null,
      retryable: false,
    })),
    activity: { available: true, truncated: false, threads: [] },
  };
  const f = await mockPlatformConversation(page, () => ({ inputs, runtime }));
  for (const id of ["a", "b"]) {
    inputs.push(
      f.input(`TEST-cue-${id}`, `TEST 执行 ${id}。`, "2026-10-13T00:00:00Z"),
    );
    runtime.activity!.threads.push({
      ...f.scope,
      id: `TEST-thread-${id}`,
      inputId: `TEST-cue-${id}`,
      rootId: `TEST-root-${id}`,
      sessionId: `TEST-session-${id}`,
      kind: "execution",
      title: `TEST 工作 ${id}`,
      lifecycle: id === "a" ? "open" : "closed",
      phase: id === "a" ? "running" : "closed",
      revision: 1,
      updatedAt: "2026-10-13T00:00:10Z",
    });
    runtime.messages.push({
      ...f.scope,
      id: `TEST-progress-${id}-1`,
      inputId: `TEST-cue-${id}`,
      rootId: `TEST-root-${id}`,
      threadId: `TEST-thread-${id}`,
      artifactId: null,
      kind: "reply",
      text: `TEST ${id} 已经发布的一段进展，物理模型流已结束。`,
      createdAt: "2026-10-13T00:00:01Z",
    });
  }
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(platform\/messages|executions\/(cancel|continue))/.test(
        request.url(),
      )
    )
      writes.push(request.url());
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await (await openInput(page)).fill("TEST 继续处理提示不发送或清空草稿");
  return { ...f, runtime, writes };
}

test("发布进展后真实工作仍运行，在最新进展之后保留一个轻量动态提示；刷新、结束和并发不串线", async ({
  page,
}, info) => {
  const f = await prepare(page);
  const cue = page.locator('[data-waiting-input-id="TEST-cue-a"]');
  await expect(cue).toContainText("继续处理中");
  await expect(cue.locator(".response-elapsed")).toHaveCount(0);
  await expect(
    page.locator('[data-waiting-input-id="TEST-cue-b"]'),
  ).toHaveCount(0);
  await expect(cue.locator(".response-dots i").first()).toHaveCSS(
    "animation-name",
    "response-waiting-pulse",
  );
  const first = page.locator('[data-message-id="TEST-progress-a-1"]');
  expect((await cue.boundingBox())!.y).toBeGreaterThanOrEqual(
    (await first.boundingBox())!.y + (await first.boundingBox())!.height,
  );
  await expect(first).not.toContainText("继续处理中");
  f.runtime.messages.push({
    ...f.runtime.messages[0]!,
    id: "TEST-progress-a-2",
    createdAt: "2026-10-13T00:00:02Z",
    text: "TEST 第二段最新进展。",
  });
  await f.refresh();
  await expect(cue).toHaveCount(1);
  const latest = page.locator('[data-message-id="TEST-progress-a-2"]');
  await expect(latest).toBeVisible();
  expect((await cue.boundingBox())!.y).toBeGreaterThanOrEqual(
    (await latest.boundingBox())!.y + (await latest.boundingBox())!.height,
  );
  await page.screenshot({
    path: info.outputPath("ongoing-after-latest-progress.png"),
  });
  const thread = f.runtime.activity!.threads[0]!;
  thread.phase = "waiting";
  thread.revision++;
  await f.refresh();
  await expect(cue).toHaveCount(0);
  thread.phase = "running";
  thread.revision++;
  await f.refresh();
  await expect(cue).toContainText("继续处理中");
  thread.phase = "closed";
  thread.lifecycle = "closed";
  thread.revision++;
  await f.refresh();
  await expect(cue).toHaveCount(0);
  await expect(latest).toContainText("TEST 第二段最新进展。");
  await expect(await openInput(page)).toHaveValue(
    "TEST 继续处理提示不发送或清空草稿",
  );
  expect(f.writes).toEqual([]);
});

test("继续处理提示遵循减少动态且窄窗和两倍布局不溢出；断线与未知线程不伪报仍运行", async ({
  page,
}, info) => {
  const f = await prepare(page);
  const cue = page.locator('[data-waiting-input-id="TEST-cue-a"]');
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(cue.locator(".response-dots i").first()).toHaveCSS(
    "animation-name",
    "none",
  );
  for (const [width, zoom] of [
    [390, 1],
    [1440, 2],
  ]) {
    await page.setViewportSize({ width: width!, height: 960 });
    await page.evaluate((scale) => {
      document.documentElement.style.zoom = String(scale);
    }, zoom);
    await cue.scrollIntoViewIfNeeded();
    const box = (await cue.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width! + 1);
    await page.screenshot({
      path: info.outputPath(`continuation-${width}-${zoom}.png`),
    });
  }
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  f.runtime.connected = false;
  await f.refresh();
  await expect(cue).toHaveCount(0);
  f.runtime.connected = true;
  f.runtime.activity!.threads[0]!.kind = "dialogue_turn";
  await f.refresh();
  await expect(cue).toHaveCount(0);
  expect(f.writes).toEqual([]);
});
