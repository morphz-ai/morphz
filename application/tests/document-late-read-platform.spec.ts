import { test, expect, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { createAppServer } from "../apps/service/src/http.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import {
  Application,
  invokeApplication,
} from "../packages/application/src/application.js";
import type { ApplicationMethod } from "../packages/core/src/application-api.js";
import { applicationStoragePrefix } from "../packages/core/src/application-names.js";
import { openInput } from "./interaction-helpers.js";

async function openProjectContent(page: Page, title: string) {
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "项目", exact: true })
    .click();
  await page.getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "查看项目内容", exact: true }).click();
}

test("文档实际授权响应迟到，同一登录撤权后不能回填原件，新授权必须重新读取且保留允许项目草稿", async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-document-late-ui-"));
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"), {
    mode: "transport",
  });
  const owner = {
    principalId: "document-owner",
    actantId: "document-owner-human",
  };
  const reader = {
    principalId: "document-reader",
    actantId: "document-reader-human",
  };
  const token = "b".repeat(64);
  const members = [owner, reader].map((member) => ({
    ...member,
    projectIds: [] as string[],
    enabled: true,
  }));
  const identity = new IdentityCenter(
    store,
    {
      version: 1,
      members: [owner, reader].map((member, index) => ({
        ...member,
        enabled: true,
        loginTokenHash: createHash("sha256")
          .update(index === 1 ? token : "a".repeat(64))
          .digest("hex"),
      })),
    },
    Date.now,
    members,
  );
  const domains = await openApplicationDomainsHost(directory, store, identity);
  const options = {
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
  };
  const app = new Application(store, options);
  const ownerCall = (method: ApplicationMethod, params: unknown) =>
    invokeApplication(
      app.session(owner),
      method,
      params,
      "actual-human-test-setup",
      new AbortController().signal,
    );
  const projectIds = [randomUUID(), randomUUID()];
  const projectTitles = ["TEST 可撤权项目", "TEST 仍然允许项目"];
  const titles = ["TEST 授权原件", "TEST 允许原件"];
  const markdowns = [
    "实际保存的旧授权原文，不得在撤权后回填。",
    "允许项目的实际正文。",
  ];
  const contentIds: string[] = [];
  for (const [index, projectId] of projectIds.entries()) {
    await ownerCall("projects.create", {
      projectId,
      commandId: randomUUID(),
      title: projectTitles[index],
    });
    const result = (await ownerCall("documents.create", {
      objectId: randomUUID(),
      commandId: randomUUID(),
      projectId,
      title: titles[index],
      markdown: markdowns[index],
    })) as { contentId: string };
    contentIds.push(result.contentId);
  }
  const grants = [members[0]!, { ...members[1]!, projectIds }];
  await domains.content.platform.reconcileOperatorMembers(
    store.identity(),
    grants,
  );
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  const server = createAppServer(store, {
    ...options,
    port,
    webRoot: resolve("dist/web"),
  });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  const path = `/api/platform/objects/${contentIds[0]}`;
  const matchesPath = (url: URL) => url.pathname === path;
  let reached!: () => void;
  const started = new Promise<void>((done) => {
    reached = done;
  });
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let originalReads = 0;
  const originalResponses: number[] = [];
  page.on("response", (response) => {
    if (matchesPath(new URL(response.url())))
      originalResponses.push(response.status());
  });
  await page.route(matchesPath, async (route) => {
    originalReads++;
    if (originalReads !== 1) return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.content.markdown).toBe(markdowns[0]);
    expect(body.revision).toBe(1);
    reached();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.goto(origin);
    await page.getByLabel("登录凭据").fill(token);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.locator(".app")).toBeVisible();
    const bootstrap = () =>
      page.request.get(`${origin}/api/platform/bootstrap`);
    const initialIdentity = (await (await bootstrap()).json()) as {
      centerId: string;
      principalId: string;
      csrfToken: string;
    };
    await expect(page.locator(".library-results")).toHaveCount(0);
    expect(originalReads).toBe(0);
    // This case holds the explicit-open read, not a visible grid card's
    // independent preview. Set the normal scoped view preference before the
    // first collection mount; neither response bodies nor product state are
    // mocked, and the scope comes from this actual authenticated bootstrap.
    await page.evaluate(
      ({ prefix, centerId, principalId, projectIds }) => {
        const scope = `${prefix}${centerId}:${principalId}:`;
        for (const key of [
          "library-view:all-content",
          ...projectIds.map((id) => `library-view:${id}`),
        ]) {
          const saved = JSON.parse(localStorage.getItem(scope + key) ?? "{}");
          localStorage.setItem(
            scope + key,
            JSON.stringify({ ...saved, layout: "list" }),
          );
        }
      },
      {
        prefix: applicationStoragePrefix,
        centerId: initialIdentity.centerId,
        principalId: initialIdentity.principalId,
        projectIds,
      },
    );
    await openProjectContent(page, projectTitles[0]!);
    const listMode = page.getByRole("button", {
      name: "列表视图",
      exact: true,
    });
    await expect(listMode).toBeVisible();
    await expect(listMode).toHaveAttribute("aria-pressed", "true");
    const library = page.getByRole("region", { name: "内容列表", exact: true });
    await expect(library.locator(".artifact-list")).toBeVisible();
    await expect(
      library.getByRole("button", {
        name: `打开内容：${titles[0]}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(library.locator(".artifact-preview")).toHaveCount(0);
    expect(originalReads).toBe(0);
    await page.getByLabel(`打开内容：${titles[0]}`, { exact: true }).click();
    await started;
    expect(originalReads).toBe(1);

    await domains.content.platform.reconcileOperatorMembers(store.identity(), [
      grants[0]!,
      { ...grants[1]!, projectIds: [projectIds[1]!] },
    ]);
    const denied = await page.request.get(`${origin}${path}`);
    expect(denied.status()).toBe(404);
    expect((await (await bootstrap()).json()).csrfToken).toBe(
      initialIdentity.csrfToken,
    );
    const navigation = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/api/platform/runtime-navigation" && response.ok(),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await navigation;
    await expect(
      page.getByRole("button", { name: projectTitles[0], exact: true }),
    ).toHaveCount(0);
    await openProjectContent(page, projectTitles[1]!);
    await page.getByLabel(`打开内容：${titles[1]}`, { exact: true }).click();
    await expect(page.locator(".object-paper")).toContainText(markdowns[1]!);
    const draft = "TEST 允许项目尚未发送的草稿";
    await (await openInput(page)).fill(draft);
    const returned = page.waitForResponse(
      (response) => new URL(response.url()).pathname === path,
    );
    release();
    await returned;
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    await expect(page.locator(".object-paper")).toContainText(markdowns[1]!);
    await expect(page.getByLabel("AI 输入内容")).toHaveValue(draft);

    await domains.content.platform.reconcileOperatorMembers(
      store.identity(),
      grants,
    );
    const regranted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/api/platform/runtime-navigation" && response.ok(),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await regranted;
    await expect(
      page.getByRole("button", { name: projectTitles[0], exact: true }),
    ).toBeVisible();
    const freshRead = page.waitForResponse(
      (response) => new URL(response.url()).pathname === path && response.ok(),
    );
    await openProjectContent(page, projectTitles[0]!);
    await page.getByLabel(`打开内容：${titles[0]}`, { exact: true }).click();
    await freshRead;
    // A restored application may recheck the revoked original and receive
    // 404. Count actual successful body responses, not denied reads.
    expect(originalResponses.filter((status) => status === 200)).toHaveLength(
      2,
    );
    await expect(page.locator(".object-paper")).toContainText(markdowns[0]!);
    expect((await (await bootstrap()).json()).csrfToken).toBe(
      initialIdentity.csrfToken,
    );
    await openProjectContent(page, projectTitles[1]!);
    await page.getByLabel(`打开内容：${titles[1]}`, { exact: true }).click();
    await expect(page.locator(".object-paper")).toContainText(markdowns[1]!);
    await expect(await openInput(page)).toHaveValue(draft);
  } finally {
    release();
    await page.unroute(matchesPath);
    server.closeStreams();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await domains.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
