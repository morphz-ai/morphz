import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { basename, join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess, type Command } from "../packages/core/src/model.js";
import { seedLegacyWebsite } from "./legacy-website-fixture.js";

/** Synthetic Agent output / retained legacy data, in the isolated E2E center.
 * Real domain operations and SQLite index; no production API identity bypass. */
export async function seedCenter(
  page: Page,
  operation: Command["operation"],
  agent = false,
) {
  const boot = await (await page.request.get("/api/workspace")).json();
  const { directory } = JSON.parse(
    readFileSync("node_modules/.cache/morphz-e2e-center.json", "utf8"),
  );
  if (!isAbsolute(directory) || !basename(directory).startsWith("morphz-e2e-"))
    throw new Error("An isolated E2E center is required");
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
  try {
    expect(store.identity()).toBe(boot.centerId);
    return store.execute(
      { commandId: randomUUID(), operation },
      agent
        ? { principalId: "morphz-service", actantId: "morphz-agent" }
        : localAccess,
    ).entityId;
  } finally {
    store.close();
  }
}

export async function seedLegacyDocument(
  page: Page,
  projectId: string,
  relativePath: string,
  text: string,
) {
  return seedCenter(page, {
    type: "import-document",
    projectId,
    relativePath,
    text,
  });
}

export async function seedLegacyWebsiteCenter(
  page: Page,
  title: string,
  projectId = "first-project",
) {
  const boot = await (await page.request.get("/api/workspace")).json();
  const { directory } = JSON.parse(
    readFileSync("node_modules/.cache/morphz-e2e-center.json", "utf8"),
  );
  if (!isAbsolute(directory) || !basename(directory).startsWith("morphz-e2e-"))
    throw new Error("An isolated E2E center is required");
  const filename = join(directory, "workspace.sqlite");
  const store = new WorkspaceStore(filename);
  try {
    expect(store.identity()).toBe(boot.centerId);
  } finally {
    store.close();
  }
  return seedLegacyWebsite(filename, {
    commandId: randomUUID(),
    operation: {
      type: "create-artifact",
      projectId,
      title,
      content: {
        kind: "website",
        url: "https://example.com/",
        description: "保留的旧链接",
      },
    },
  }).entityId;
}
