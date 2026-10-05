import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  defaultAgentProfile,
  defaultHumanProfile,
} from "../../packages/core/src/profile.js";
import { parseCognitiveAppObjectLocator } from "../../packages/core/src/cognitive-app-object-locator.js";
// Same production stylesheet order as main.tsx, without importing main's
// second root initializer. This fixture owns no alternate UI stylesheet.
import "../../apps/web/src/ui/controls/base.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/shell/window-frame-base.css";
import "../../apps/web/src/shell/workspace-topbar-base.css";
import "../../apps/web/src/features/pdf/pdf-reading-base.css";
import "../../apps/web/src/ui/controls/adaptive.css";
import "../../apps/web/src/features/browser/browser-controls.css";
import "../../apps/web/src/ui/dialog-frame.css";
import "../../apps/web/src/ui/controls/metrics.css";
import "../../apps/web/src/ui.css";
import "../../apps/web/src/shell/window-frame-composition.css";
import "../../apps/web/src/shell/workspace-topbar-composition.css";
import "../../apps/web/src/ui/popup-surface.css";
import "../../apps/web/src/workflow.css";
import "../../apps/web/src/ui/dialog-surface.css";
import "../../apps/web/src/ui/controls/surfaces.css";
import "../../apps/web/src/visual-system.css";
import "../../apps/web/src/shell/workspace-topbar-packing.css";
import "../../apps/web/src/features/pdf/pdf-reading-adaptive.css";
import "../../apps/web/src/features/exchange/exchange-controls.css";
import "../../apps/web/src/exchange-layout.css";
import "../../apps/web/src/inspector.css";
import "../../apps/web/src/task-list.css";
import "../../apps/web/src/content-catalog.css";
import "../../apps/web/src/browser-bookmarks.css";
import "../../apps/web/src/text-quotes.css";
import "../../apps/web/src/profile-avatar.css";
import "../../apps/web/src/personality-profile.css";
import "../../apps/web/src/execution-activity.css";
import "../../apps/web/src/execution-thread-groups.css";
import "../../apps/web/src/application-icons.css";

// Full production App + useWorkspace + navigation + Conversation are imported
// below. Only the logical application bridge is controlled. These replies are
// not proof of native IPC, SQL authorization, HPA or author-service networking.
const now = "2026-10-05T00:00:00.000Z";
const authority = {
  appId: "author.notes",
  version: "1.0.0",
  definitionHash: "a".repeat(64),
  instanceId: "author-instance",
  serviceId: "author/service",
  dataAuthorityId: "author/data",
};
const boot = {
  centerId: "11111111-1111-4111-8111-111111111111",
  principalId: "human-A",
  csrfToken: "session-A",
  actantId: "human-A",
  displayName: "本人",
  capabilities: {
    runtime: true,
    teamAuthentication: true,
    directedInput: true,
    localFiles: false,
    browserBookmarks: false,
    modelSettings: false,
  },
};
function locator(
  objectId = "object-A",
  versionRef = "000900719925474099312345:旧😀\n",
) {
  return parseCognitiveAppObjectLocator({
    contentId: "content-" + objectId,
    projectId: "project-A",
    connectionId: "connection-author",
    authority,
    object: { objectId, versionRef },
  });
}
const first = locator(),
  second = locator("object-B", "opaque-B-旧");
function entry(contentId: string) {
  const selected = contentId === second.contentId ? second : first;
  return {
    id: selected.contentId,
    projectId: selected.projectId,
    appId: authority.appId,
    instanceId: authority.instanceId,
    appObjectId: selected.object.objectId,
    providerRevision: 1,
    kind: "note",
    title: "目录已更新 V2",
    observedVersionRef: "OPAQUE_V2_HEAD",
    availability: "available",
    revision: 2,
    createdAt: now,
    updatedAt: now,
  };
}
const runtime = {
  configured: true,
  connected: true,
  model: "fixture-model",
  error: "",
  deliveries: [],
  messages: [],
  activity: { available: true, threads: [] },
};
function project(
  id: string,
  kind: "project" | "desk" | "inbox" | "dialogue",
  title: string,
) {
  return {
    id,
    kind,
    title,
    ownerPrincipalId: boot.principalId,
    memberPrincipalIds: [boot.principalId],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
  };
}
const projects = [
  project("desk", "desk", "工作台"),
  project("inbox", "inbox", "事项"),
  project("dialogue", "dialogue", "对话"),
  project("project-A", "project", "原文项目 A"),
  project("project-B", "project", "其他项目 B"),
];
const conversations = projects.map((p) => ({
  id: p.id,
  projectId: p.id,
  kind: "default",
  title: p.title,
  revision: 1,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
}));
const inputs = [first, second].map((cognitiveObject, index) => ({
  id: "input-" + index,
  projectId: "project-A",
  conversationId: "project-A",
  author: { principalId: boot.principalId, actantId: boot.actantId },
  targetActantId: "morphz-agent",
  body: "查看历史原件 " + index,
  cognitiveObject,
  createdAt: now,
}));
let requests: Array<any> = [],
  pending: Array<any> = [],
  cancelled: string[] = [];
let subscribers = new Map<string, { scope: any; generation: string }>();
let listeners = new Set<(event: any) => void>();
let unknown: string[] = [];
function ok(value: unknown) {
  return { ok: true as const, value };
}
function denied(message: string, status = 403) {
  return { ok: false as const, error: { status, message, code: "forbidden" } };
}
const bridge = {
  async invoke(request: any) {
    requests.push(structuredClone(request));
    const p = request.params;
    switch (request.method) {
      case "platform.bootstrap":
        return ok(structuredClone(boot));
      case "spaces.ensure":
        return ok({ deskId: "desk", inboxId: "inbox", dialogueId: "dialogue" });
      case "cognitive-apps.list":
        return ok({
          versions: [],
          connections: [],
          nextVersionsAfter: null,
          nextConnectionsAfter: null,
        });
      case "app-views.list":
      case "apps.list":
      case "tasks.counts":
      case "content.counts":
      case "content.deliveries":
        return ok([]);
      case "runtime.navigation":
        return ok({
          runtime,
          activityByProject: {},
          catalogVersion: 1,
          revisions: { projects: 1, conversations: 1, tasks: 1, access: 1 },
          historyVersion: "b".repeat(64),
        });
      case "projects.list":
        return ok(
          projects.map((p) => ({
            ...p,
            ownerPrincipalId: boot.principalId,
            memberPrincipalIds: [boot.principalId],
          })),
        );
      case "conversations.navigation":
        return ok(conversations);
      case "conversations.history":
        return ok({
          inputs: p.projectId === "project-A" ? inputs : [],
          runtime,
          scriptOutputs: [],
          nextCursor: null,
        });
      case "content.list":
        return ok([entry(first.contentId), entry(second.contentId)]);
      case "tasks.order":
        return ok({ revision: 0 });
      case "notifications.read":
        return ok({ mode: "all", revision: 0, unread: 0, items: [] });
      case "projects.understanding":
        return ok(null);
      case "profile.read":
        return ok({
          human: {
            data: defaultHumanProfile,
            revision: 0,
            available: true,
            enabled: true,
            editable: true,
            avatar: { revision: 0, media: null },
          },
          agent: {
            id: "morphz-agent",
            data: defaultAgentProfile,
            revision: 0,
            available: true,
            enabled: true,
            editable: true,
            avatar: { revision: 0, media: null },
          },
          avatarUploadAvailable: false,
        });
      case "models":
        return ok({
          current: "fixture-model",
          options: [{ id: "fixture-model", label: "Fixture" }],
        });
      case "session-permissions.read":
        return ok({
          scope: { ...p, kind: "conversation" },
          runtimeSessionId: null,
          permissionMode: "request_approval",
          sandboxMode: "workspace-write",
          reviewer: "user",
          source: "safe_default",
          canUpdate: false,
          readOnlyReason: "not_started",
          fingerprint: null,
          workspace: {
            targetId: null,
            targetName: null,
            workspaceRoot: null,
            ready: false,
            reason: "not_started",
          },
        });
      case "content.get":
        return ok(entry(p.contentId));
      case "cognitive-apps.read-object":
        return new Promise((resolve) => pending.push({ request, resolve }));
      default:
        unknown.push(request.method);
        return denied("Unexpected fixture method " + request.method, 502);
    }
  },
  cancel(id: string) {
    cancelled.push(id);
  },
  async subscribe(id: string, scope: any, generation: string) {
    subscribers.set(id, { scope, generation });
  },
  unsubscribe(id: string) {
    subscribers.delete(id);
  },
  onStream(callback: (event: any) => void) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};
Object.assign(window, { morphzDesktop: { application: bridge } });
const preferencesKey = () =>
  `morphz:${boot.centerId}:${boot.principalId}:preferences`;
const mode = new URL(location.href).searchParams.get("mode");
const pref = {
  view: "projects",
  projectId: "project-A",
  projectOpen: true,
  artifactId: null,
  artifactRevision: null,
  sidebar: true,
  composer: true,
  conversation: true,
  collaboration: false,
  subjectOpen: false,
  selectedConversations: { "project-A": "project-A" },
  interactions: { "project-A": "history", "project-B": "history" },
  pinnedInputs: { "project-A": true, "project-B": true },
  ...(mode === "restore"
    ? { cognitiveLocation: { kind: "original", locator: first } }
    : {}),
};
if (mode !== "keep") {
  // Each independent mounted case owns a fresh local preference/draft scope.
  // mode=keep is reserved for the deliberate real full-App reload case.
  localStorage.clear();
  if (mode === "restore") pref.interactions["project-A"] = "recent";
  localStorage.setItem(preferencesKey(), JSON.stringify(pref));
}
// No implementation hook or navigation function is replaced/extracted.
const { App } = await import("../../apps/web/src/App.js");
const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
function report() {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="AI 输入内容"]',
  );
  const send = document.querySelector<HTMLButtonElement>(
    'button[aria-label="发送消息"]',
  );
  return {
    requests: structuredClone(requests),
    pending: pending.map((x) => ({
      request: x.request,
      cancelled: cancelled.includes(x.request.id),
    })),
    unknown: [...unknown],
    cancelled: [...cancelled],
    preferences: JSON.parse(localStorage.getItem(preferencesKey()) ?? "null"),
    textarea: textarea
      ? { value: textarea.value, disabled: textarea.disabled }
      : null,
    send: send ? { disabled: send.disabled } : null,
    text: document.body.textContent,
    original: document.querySelector(".document-body")?.textContent ?? null,
    originalLayout: (() => {
      let element: Element | null = document.querySelector(
        "article.object-paper",
      );
      const chain = [];
      while (element) {
        const style = getComputedStyle(element),
          rect = element.getBoundingClientRect();
        chain.push({
          name: element.tagName,
          className: element.className,
          display: style.display,
          height: rect.height,
          width: rect.width,
          visibility: style.visibility,
        });
        element = element.parentElement;
      }
      return chain;
    })(),
    stored: Object.fromEntries(
      Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
    ),
  };
}
Object.assign(window, {
  cognitiveOriginalAppFixture: {
    report,
    locator,
    boot,
    clearRequests() {
      requests = [];
      unknown = [];
    },
    settle(index: number, text = "AUTHOR_PINNED_V1_PRIVATE") {
      const held = pending[index];
      if (!held) throw Error("missing original " + index);
      held.resolve(
        ok({
          protocol: "morphz-domain/v1",
          authority,
          object: held.request.params.object,
          title: "历史原件 V1",
          kind: "note",
          content: { format: "markdown", text },
        }),
      );
    },
    fail(index: number) {
      pending[index].resolve(denied("AUTHOR_READ_DENIED"));
    },
    switchIdentity(
      field: "centerId" | "principalId" | "csrfToken",
      value: string,
    ) {
      const locationPreferences = JSON.parse(
        localStorage.getItem(preferencesKey()) ?? "{}",
      );
      boot[field] = value;
      // Restore locators only in the new Human's preference scope. No original
      // body or read authorization is transferred by this preference write.
      localStorage.setItem(
        preferencesKey(),
        JSON.stringify(locationPreferences),
      );
      for (const [id, subscriber] of subscribers)
        if (subscriber.scope.kind === "workspace")
          for (const listener of listeners)
            listener({
              id,
              value: {
                kind: "workspace",
                sequence: 1,
                reason: "changed",
                accessChanged: true,
              },
            });
    },
  },
});
