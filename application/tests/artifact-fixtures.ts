import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { contentSchema, type Content } from "../packages/core/src/model.js";

async function platformCommand(page: Page, path: string, data: unknown) {
  const bootstrap = await (
    await page.request.get("/api/platform/bootstrap")
  ).json();
  const response = await page.request.post(path, {
    headers: {
      "X-Morphz-Token": bootstrap.csrfToken,
      Origin: new URL(page.url()).origin,
    },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

export async function libraryDestination(page: Page) {
  const bootstrap = await (
    await page.request.get("/api/platform/bootstrap")
  ).json();
  type Project = {
    id: string;
    kind: string;
    ownerPrincipalId: string | null;
    title: string;
    updatedAt: string;
  };
  const projects: Project[] = [];
  let after: Project | undefined;
  for (;;) {
    const query = new URLSearchParams({ status: "all", limit: "100" });
    if (after) {
      query.set("afterUpdatedAt", after.updatedAt);
      query.set("afterProjectId", after.id);
    }
    const response = await page.request.get(`/api/platform/projects?${query}`);
    expect(response.ok()).toBe(true);
    const batch = (await response.json()) as Project[];
    projects.push(...batch);
    if (batch.length < 100) break;
    const next = batch.at(-1)!;
    expect(next.id).not.toBe(after?.id);
    after = next;
  }
  const scope = page.getByLabel("内容范围", { exact: true });
  const destination = (await scope.isVisible())
    ? await scope.inputValue()
    : null;
  const label = await page
    .locator(".library-collection:visible")
    .getAttribute("aria-label");
  const project = projects.find((p) =>
    destination === null
      ? label === `${p.title}的内容`
      : destination === "all"
        ? p.kind === "desk" && p.ownerPrincipalId === bootstrap.principalId
        : p.id === destination,
  );
  expect(
    project,
    "Fixture ownership must match the visible content scope",
  ).toBeTruthy();
  return project!;
}

// Editor and notification tests seed real Platform/App objects. The
// Agent-first request-to-tool path has its own end-to-end coverage.
export async function seedLibraryArtifact(
  page: Page,
  title: string,
  content: Content,
) {
  const project = await libraryDestination(page);
  const commandId = randomUUID();
  if (content.kind === "document") {
    await platformCommand(page, "/api/platform/documents", {
      commandId,
      objectId: commandId,
      projectId: project.id,
      title,
      markdown: content.markdown,
    });
  } else if (content.kind === "interactive") {
    await platformCommand(page, "/api/platform/interactive", {
      commandId,
      objectId: commandId,
      projectId: project.id,
      title,
      content,
    });
  } else if (content.kind === "task") {
    await platformCommand(page, "/api/platform/tasks", {
      commandId,
      taskId: commandId,
      projectId: project.id,
      title,
      description: content.description,
      assigneeId: content.assigneeId,
      modelId: content.model,
      reasoningEffort: content.reasoningEffort ?? null,
      notBefore: content.notBefore,
      everySeconds: content.everySeconds,
      ...(content.dueDate ? { dueDate: content.dueDate } : {}),
    });
  } else {
    throw new Error(`测试夹具尚无「${content.kind}」的当前应用域创建路径。`);
  }
  if (content.kind === "task") {
    // Task interaction fixtures follow the normal live-object entry. Search
    // intentionally opens the indexed revision rather than a live task.
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: /^事项/ })
      .click();
    // A newly seeded row can be below the floating exchange. Reach it through
    // the same explicit collapse action a user has, without forced DOM clicks.
    const collapse = page.getByRole("button", {
      name: "收起 AI 输入框",
      exact: true,
    });
    if (await collapse.isVisible()) await collapse.click();
    await page
      .getByLabel("事项列表")
      .getByRole("button")
      .filter({ hasText: title })
      .click();
  } else {
    await page
      .locator(".artifact-card")
      .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
      .click();
  }
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  // A library card also contains the same heading. Wait for the opened object,
  // not the still-visible card while launch/persistence is in flight.
  await expect(page.locator(".object-paper")).toBeVisible();
  if (content.kind !== "task")
    await expect(
      page
        .locator(".object-paper")
        .getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
}

export function humanTask(description = "") {
  return contentSchema.parse({
    kind: "task",
    description,
    assigneeId: "local-human",
    model: null,
    priority: "normal",
    dueDate: null,
    assignment: "accepted",
    execution: "planned",
    delivery: "none",
    resultIds: [],
  });
}
