import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { IdentityCenter } from "../apps/service/src/identity.js";
import { createAppServer } from "../apps/service/src/http.js";
import { openInput } from "./interaction-helpers.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";

test("同一桌面切换身份：登录、草稿隔离、重开恢复及撤销清空界面", async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-identity-ui-"));
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"), {
      mode: "transport",
    }),
    members = [
      { principalId: "alpha", actantId: "alpha-human" },
      { principalId: "beta", actantId: "beta-human" },
    ];
  const tokens = ["a".repeat(64), "b".repeat(64)],
    config = {
      version: 1,
      members: members.map((m, i) => ({
        ...m,
        enabled: true,
        loginTokenHash: createHash("sha256").update(tokens[i]!).digest("hex"),
      })),
    };
  const identity = new IdentityCenter(
      store,
      config,
      Date.now,
      members.map((member, i) => ({
        ...member,
        name: `测试成员${i + 1}`,
        projectIds: [],
        enabled: true,
      })),
    ),
    probe = createServer();
  const domains = await openApplicationDomainsHost(directory, store, identity);
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const server = createAppServer(store, {
    port,
    webRoot: resolve("dist/web"),
    identity,
    platformWork: domains.work,
    platformDocuments: domains.content,
    platformScripts: domains.content,
    platformReader: domains.reader,
    bookmarkDomain: domains.browser,
    messageAttachments: domains.messageAttachments,
    images: domains.images,
    uiPackages: domains.uiPackages,
    notifications: domains.notifications,
    platformTaskRuns: domains.taskRuns(),
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  try {
    const unauthenticated = await page.request.get(
      `http://127.0.0.1:${port}/api/platform/bootstrap`,
    );
    expect(unauthenticated.status()).toBe(401);
    expect((await unauthenticated.json()).message).toBe("请登录后继续操作。");
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByLabel("登录凭据").fill("c".repeat(64));
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("登录凭据无效或已撤销。");
    await expect(page.locator(".app")).toHaveCount(0);
    const login = async (i: number) => {
      await expect(
        page.getByRole("heading", { name: "登录 Morphz" }),
      ).toBeVisible();
      await page.getByLabel("登录凭据").fill(tokens[i]!);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await expect(page.locator(".sidebar-bottom")).toContainText(
        `测试成员${i + 1}`,
      );
    };
    await login(0);
    await page.getByLabel("AI 输入内容").fill("只有甲可见的未发送草稿");
    await page.getByRole("button", { name: "用户菜单", exact: true }).click();
    await page.getByRole("button", { name: "退出当前身份" }).click();
    await login(1);
    await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
    await page.getByLabel("AI 输入内容").fill("乙的草稿");
    await page.reload();
    await expect(page.getByLabel("AI 输入内容")).toHaveValue("乙的草稿");
    await page.getByRole("button", { name: "用户菜单", exact: true }).click();
    await page.getByRole("button", { name: "退出当前身份" }).click();
    await login(0);
    await openInput(page);
    await expect(page.getByLabel("AI 输入内容")).toHaveValue(
      "只有甲可见的未发送草稿",
    );
    const storage = await page.evaluate(() => JSON.stringify(localStorage));
    expect(storage).not.toContain(tokens[0]);
    expect(storage).not.toContain(tokens[1]);
    config.members[0]!.enabled = false;
    await identity.replaceConfiguration(config);
    await expect(
      page.getByRole("heading", { name: "登录 Morphz" }),
    ).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".app")).toHaveCount(0);
    await page.screenshot({ path: "test-results/identity-connection.png" });
  } finally {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await domains.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
