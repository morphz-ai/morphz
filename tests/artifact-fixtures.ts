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
    (p: { title: string }) => label === `${p.title}的资料`,
  );
  expect(project, "The fixture must use the visible workspace").toBeTruthy();
  const response = await page.request.post("/api/commands", {
    headers: {
      "X-MorphzWork-Token": boot.csrfToken,
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
  await page
    .locator(".artifact-card")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .click();
  await expect(page.locator(".object-paper > h1")).toHaveText(title);
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
