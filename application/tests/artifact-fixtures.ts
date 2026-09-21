import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { contentSchema, type Content } from "../packages/core/src/model.js";

// Unrelated editor/notification tests seed real objects through the center API;
// the Agent-first request-to-tool path has its own end-to-end coverage.
export async function seedLibraryArtifact(
  page: Page,
  title: string,
  content: Content,
) {
  const label = await page
    .locator(".library-collection")
    .getAttribute("aria-label");
  const boot = await (await page.request.get("/api/workspace")).json();
  const project = boot.workspace.projects.find(
    (p: { title: string }) => label === `${p.title}的内容`,
  );
  expect(project, "The fixture must use the visible workspace").toBeTruthy();
  const response = await page.request.post("/api/commands", {
    headers: {
      "X-Morphz-Token": boot.csrfToken,
      Origin: "http://127.0.0.1:65421",
    },
    data: {
      commandId: randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: project.id,
        title,
        content,
      },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
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
