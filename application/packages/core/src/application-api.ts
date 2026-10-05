// Logical application operations. No HTTP, Electron, filesystem or credentials.
// Both hosts call the same business layer; only their transport adapters differ.
import { z } from "zod";
import type { CognitiveAppMethod } from "./cognitive-app-api.js";
import { cognitiveAppViewApplicationMethods } from "./cognitive-app-view-methods.js";

/** Exact public facade ingress. Host-only capabilities never enter this map. */
export const cognitiveAppApplicationMethods = [
  "cognitive-apps.list",
  "cognitive-apps.describe",
  "cognitive-apps.install",
  "cognitive-apps.grant",
  "cognitive-apps.connect",
  "cognitive-apps.connection-state",
  "cognitive-apps.invoke",
  "cognitive-apps.read-object",
  "cognitive-apps.command-status",
  "cognitive-apps.recover",
] as const;
export const cognitiveAppApplicationRoutes = Object.freeze({
  "cognitive-apps.list": {
    method: "list",
    path: "/api/platform/cognitive-apps/list",
  },
  "cognitive-apps.describe": {
    method: "describe",
    path: "/api/platform/cognitive-apps/describe",
  },
  "cognitive-apps.install": {
    method: "install",
    path: "/api/platform/cognitive-apps/install",
  },
  "cognitive-apps.grant": {
    method: "grant",
    path: "/api/platform/cognitive-apps/grant",
  },
  "cognitive-apps.connect": {
    method: "connect",
    path: "/api/platform/cognitive-apps/connect",
  },
  "cognitive-apps.connection-state": {
    method: "connectionState",
    path: "/api/platform/cognitive-apps/connection-state",
  },
  "cognitive-apps.invoke": {
    method: "invoke",
    path: "/api/platform/cognitive-apps/invoke",
  },
  "cognitive-apps.read-object": {
    method: "readObject",
    path: "/api/platform/cognitive-apps/read-object",
  },
  "cognitive-apps.command-status": {
    method: "commandStatus",
    path: "/api/platform/cognitive-apps/command-status",
  },
  "cognitive-apps.recover": {
    method: "recover",
    path: "/api/platform/cognitive-apps/recover",
  },
} as const satisfies Record<
  (typeof cognitiveAppApplicationMethods)[number],
  { method: CognitiveAppMethod; path: string }
>);
for (const route of Object.values(cognitiveAppApplicationRoutes))
  Object.freeze(route);
export function cognitiveAppApplicationRoute(method: string) {
  return Object.hasOwn(cognitiveAppApplicationRoutes, method)
    ? cognitiveAppApplicationRoutes[
        method as keyof typeof cognitiveAppApplicationRoutes
      ]
    : null;
}

/** Invalidation metadata, never permission grants or Client-owned revisions. */
export const navigationRevisionsSchema = z.object({
  projects: z.number().int().nonnegative(),
  conversations: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
  access: z.number().int().nonnegative(),
});
export type NavigationRevisions = z.infer<typeof navigationRevisionsSchema>;
export const runtimeNavigationRequestSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    /** Explicit read-only refresh only; routine navigation polling omits it. */
    refreshActivity: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => !!value.projectId === !!value.conversationId,
    "对话范围参数不完整。",
  );

export const applicationMethods = [
  ...cognitiveAppApplicationMethods,
  ...cognitiveAppViewApplicationMethods,
  "platform.bootstrap",
  "profile.read",
  "profile.update",
  "profile.avatar.set",
  "profile.avatar.clear",
  "profile.avatar.read",
  "runtime.snapshot",
  "runtime.navigation",
  "connection.check",
  "connection.configure",
  "login",
  "logout",
  "bookmarks.list",
  "bookmarks.command",
  "apps.list",
  "apps.install",
  "app-views.list",
  "app-views.launch",
  "app-views.save",
  "app-views.close",
  "spaces.ensure",
  "projects.list",
  "projects.get",
  "projects.understanding",
  "projects.create",
  "projects.rename",
  "projects.state",
  "conversations.list",
  "conversations.navigation",
  "conversations.update",
  "conversations.history",
  "tasks.list",
  "tasks.counts",
  "tasks.get",
  "tasks.create",
  "tasks.version",
  "tasks.versions",
  "tasks.revise",
  "tasks.respond",
  "tasks.responses",
  "tasks.complete",
  "tasks.run-request",
  "tasks.order",
  "tasks.reorder",
  "tasks.reorder-selection",
  "content.list",
  "content.deliveries",
  "content.counts",
  "content.get",
  "content.resolve",
  "content.move",
  "content.move-new-project",
  "work.link",
  "work.relations",
  "objects.read",
  "objects.rename",
  "objects.annotations",
  "objects.annotate",
  "documents.read",
  "objects.versions",
  "documents.create",
  "documents.import",
  "documents.revise",
  "images.create",
  "images.revise",
  "interactive.create",
  "interactive.revise",
  "interactive.rows",
  "interactive.patch",
  "scripts.read",
  "scripts.editor.head",
  "scripts.editor.page",
  "scripts.editor.detail",
  "scripts.snapshot",
  "scripts.items",
  "scripts.item",
  "scripts.create",
  "scripts.update",
  "scripts.rename",
  "scripts.item.create",
  "scripts.item.revise",
  "scripts.item.restore",
  "scripts.item.workflow",
  "scripts.review.change",
  "scripts.candidate.decide",
  "scripts.export.record",
  "platform.message",
  "input.send",
  "input.cancel",
  "search",
  "local-files.read",
  "directories.scope",
  "directories.list",
  "directories.revoke",
  "local-files.revoke",
  "models",
  "model-settings.read",
  "model-settings.update",
  "session-permissions.read",
  "session-permissions.update",
  "asset.add",
  "attachment.add",
  "pdf.import",
  "reader.import",
  "reader.book",
  "reader.read",
  "reader.contents",
  "reader.state",
  "reader.marks",
  "reader.command",
  "reader.ocr",
  "execution.snapshot",
  "execution.result",
  "execution.control",
  "task.snapshot",
  "task.run-history",
  "task.run-status",
  "task.control",
  "speech.status",
  "speech.transcribe",
  "speech.stream",
  "speech.synthesize",
  "notifications.read",
  "notifications.control",
  "browser.register",
  "browser.exchange",
] as const;
export type ApplicationMethod = (typeof applicationMethods)[number];
export type ApplicationFailure = {
  status: number;
  code: string;
  message: string;
  /** Original operation identity; never an invitation to regenerate/retry it. */
  commandId?: string;
};
export type ApplicationReply =
  { ok: true; value: unknown } | { ok: false; error: ApplicationFailure };
export type ApplicationInvocation = {
  id: string;
  method: ApplicationMethod;
  params?: unknown;
  identityGeneration?: string;
};
export type ApplicationConnection =
  { mode: "local" } | { mode: "remote"; url: string };
export type ApplicationCallOptions = {
  identityGeneration?: string;
  signal?: AbortSignal;
};
export interface ApplicationCaller {
  call(
    method: ApplicationMethod,
    params?: unknown,
    options?: ApplicationCallOptions,
  ): Promise<unknown>;
}
export class ApplicationRequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public commandId?: string,
  ) {
    super(message);
  }
}
