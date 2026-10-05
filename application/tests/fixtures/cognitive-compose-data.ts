import {
  parseCognitiveAppViewResponse,
  type CognitiveAppViewUi,
} from "../../packages/core/src/cognitive-app-view-api.js";
import { parseCognitiveAppObjectLocator } from "../../packages/core/src/cognitive-app-object-locator.js";
import { cognitiveWorkSurfaceKey } from "../../apps/web/src/host/work-surface.js";
import type { CognitiveComposeScope } from "../../apps/web/src/host/cognitive-compose-preparation.js";
import type { InputDraft } from "../../apps/web/src/host/exchange-drafts.js";
import type { TextQuote } from "../../packages/core/src/text-quotes.js";

// Controlled admitted metadata, not a SHA/SQL/author permission proof. Shared
// by pure UNIT and real React publication tests; no business calls are mocked
// into claims of actual authorization.
export function composeSource(): CognitiveAppViewUi {
  const definition = {
    format: "morphz-cognitive-app/v1",
    protocol: "morphz-domain/v1",
    id: "example.notes",
    version: "1.1.0",
    title: "笔记",
    description: "作者原件",
    icon: "document",
    harness: null,
    ui: { packageVersion: "1.1.0", sha256: "b".repeat(64) },
    operations: [],
  };
  const now = "2026-10-06T00:00:00Z";
  return parseCognitiveAppViewResponse("readUi", {
    definition,
    manifest: {
      format: "morphz-app/v1",
      id: definition.id,
      version: definition.version,
      title: definition.title,
      description: definition.description,
      icon: definition.icon,
      harness: null,
      permissions: ["input.compose"],
      ui: { type: "sandbox", html: "<!doctype html><p>作者原文</p>" },
    },
    authority: {
      appId: definition.id,
      version: definition.version,
      definitionHash: "a".repeat(64),
      instanceId: "instance",
      serviceId: "author/notes",
      dataAuthorityId: "author/data",
    },
    view: {
      id: "view",
      workspaceId: "project",
      applicationId: definition.id,
      applicationVersion: definition.version,
      revision: 2,
      state: {},
      status: "open",
      createdAt: now,
      updatedAt: now,
    },
    binding: {
      appId: definition.id,
      version: definition.version,
      instanceId: "instance",
      serviceId: "author/notes",
      dataAuthorityId: "author/data",
      viewId: "view",
      projectId: "project",
      connectionId: "connection",
      revision: 3,
      viewRevision: 2,
      createdAt: now,
      updatedAt: now,
    },
    grantRevision: 4,
    connectionRevision: 5,
  });
}
export function composeScope(source = composeSource()): CognitiveComposeScope {
  const surface = {
    kind: "view" as const,
    projectId: source.binding.projectId,
    viewId: source.view.id,
    connectionId: source.binding.connectionId,
    authority: source.authority,
  };
  return {
    key: "conversation:cognitive:" + cognitiveWorkSurfaceKey(surface),
    surface,
    viewRevision: source.view.revision,
    bindingRevision: source.binding.revision,
  };
}
export function composeLocator(versionRef = "opaque:V1/原文\n😀") {
  const source = composeSource();
  return parseCognitiveAppObjectLocator({
    contentId: "actual-catalog-entry",
    projectId: source.binding.projectId,
    connectionId: source.binding.connectionId,
    authority: source.authority,
    object: { objectId: "opaque:原件/😀", versionRef },
  });
}
export const composeEmpty: InputDraft = {
  body: "",
  selection: "",
  revision: null,
};
export const composeQuote: TextQuote = {
  id: "a546c188-411e-48f0-b124-cdc574bb49f8",
  source: { kind: "surface", projectId: "project", title: "原引用" },
  text: "原引用内容",
  comment: "用户评论",
};
export function composeDraft(): InputDraft {
  return {
    ...composeEmpty,
    body: "已写正文\n下一行",
    model: "original-model",
    reasoningEffort: "max",
    attachments: [
      { assetId: "f".repeat(64), name: "原附件.txt", mime: "text/plain" },
    ],
  };
}
