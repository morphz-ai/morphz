import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  defaultAgentProfile,
  defaultHumanProfile,
} from "../../packages/core/src/profile.js";
import { applicationWindowKey } from "../../packages/core/src/application-names.js";
import {
  parseCognitiveAppCatalog,
  type CognitiveAppCatalogDto,
} from "../../packages/core/src/cognitive-app-api.js";
import { parseCognitiveAppApplicationTarget } from "../../packages/core/src/cognitive-app-application-target.js";
import { parseCognitiveAppObjectLocator } from "../../packages/core/src/cognitive-app-object-locator.js";
import { cognitiveWorkSurfaceKey } from "../../apps/web/src/host/work-surface.js";
import type {
  ApplicationInvocation,
  ApplicationReply,
} from "../../packages/core/src/application-api.js";
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

// Actual full production App, stylesheet order and useWorkspace below. Only
// finite logical transport replies/events are controlled. No alternate owner,
// selection algorithm, SQL/HPA, native IPC, author service or manual-App proof.
const now = "2026-10-05T00:00:00.000Z";
const windowOwner = "22222222-2222-4222-8222-222222222222";
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
const authorIcon =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mXcAAAAASUVORK5CYII=";
function version(
  appId = "author.notes",
  value = "1.0.0",
  state: "active" | "disabled" = "active",
  gui = false,
): CognitiveAppCatalogDto["versions"][number] {
  return {
    appId,
    version: value,
    definitionHash: (value === "1.0.0" ? "a" : "b").repeat(64),
    title:
      appId === "author.notes"
        ? "作者笔记"
        : appId === "author.gui"
          ? "作者界面"
          : "未就绪应用",
    description: "由独立作者维护的应用声明",
    icon: "document",
    iconImage: authorIcon,
    registeredAt: now,
    installationState: state,
    harness: null,
    ui: gui ? { packageVersion: value, sha256: "c".repeat(64) } : null,
    grant: {
      appId,
      version: value,
      state,
      revision: 1,
      consentedAt: now,
      updatedAt: now,
    },
    creationIntents: [
      {
        operationId: "notes.create",
        label: "新建作者笔记",
        prompt: "请帮我构思一篇作者笔记。",
      },
    ],
  };
}
function connection(
  id: string,
  state: "active" | "disabled" = "active",
  appId = "author.notes",
): CognitiveAppCatalogDto["connections"][number] {
  return {
    appId,
    connectionId: id,
    instanceId: "instance-" + id,
    serviceId: "作者/服务/" + id,
    dataAuthorityId: "作者/资料/" + id,
    state,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}
const entries = [
  version(),
  version("author.notes", "2.0.0"),
  version("author.disabled", "1.0.0", "disabled"),
  version("author.empty"),
  version("author.gui", "1.0.0", "active", true),
];
const connections = [
  connection("connection-A"),
  connection("connection-B"),
  connection("connection-disabled", "disabled"),
  connection("connection-GUI", "active", "author.gui"),
];
function target(id = "connection-A", value = "1.0.0") {
  const c = connections.find((entry) => entry.connectionId === id)!;
  const v = entries.find(
    (entry) => entry.appId === c.appId && entry.version === value,
  )!;
  return parseCognitiveAppApplicationTarget({
    connectionId: c.connectionId,
    authority: {
      appId: v.appId,
      version: v.version,
      definitionHash: v.definitionHash,
      instanceId: c.instanceId,
      serviceId: c.serviceId,
      dataAuthorityId: c.dataAuthorityId,
    },
  });
}
const original = parseCognitiveAppObjectLocator({
  contentId: "original-content",
  projectId: "project-A",
  ...target(),
  object: {
    objectId: "opaque:原件😀",
    versionRef: "opaque:V1:0009007199254740993",
  },
});
const runtime = {
  configured: true,
  connected: true,
  model: "fixture-model",
  error: "",
  deliveries: [],
  messages: [],
  activity: { available: true, threads: [] },
};
const projects = (
  [
    ["desk", "desk", "工作台"],
    ["inbox", "inbox", "事项"],
    ["dialogue", "dialogue", "对话"],
    ["project-A", "project", "项目 A"],
    ["project-B", "project", "项目 B"],
  ] as const
).map(([id, kind, title]) => ({
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
}));
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
const originalEntry = {
  id: original.contentId,
  projectId: original.projectId,
  appId: original.authority.appId,
  instanceId: original.authority.instanceId,
  appObjectId: original.object.objectId,
  providerRevision: 1,
  kind: "note",
  title: "目录新头 V2",
  observedVersionRef: "opaque:V2",
  availability: "available",
  revision: 2,
  createdAt: now,
  updatedAt: now,
};
const existingInstance = {
  id: "legacy-cognitive-window",
  workspaceId: "desk",
  applicationId: "author.gui",
  applicationVersion: "1.0.0",
  revision: 7,
  state: { view: "author-location" },
  status: "open",
  createdAt: now,
  updatedAt: now,
};
const ok = (value: unknown): ApplicationReply => ({ ok: true, value });
const denied = (message: string, status = 502): ApplicationReply => ({
  ok: false,
  error: { status, message, code: "unavailable" },
});
type Bridge = NonNullable<NonNullable<Window["morphzDesktop"]>["application"]>;
type Event = Parameters<Parameters<Bridge["onStream"]>[0]>[0];
const requests: ApplicationInvocation[] = [],
  unknown: string[] = [],
  cancelled: string[] = [];
const pending: Array<{
  request: ApplicationInvocation;
  settled: boolean;
  resolve(reply: ApplicationReply): void;
}> = [];
const subscribers = new Map<
  string,
  { scope: Parameters<Bridge["subscribe"]>[1]; sequence: number }
>();
const listeners = new Set<(event: Event) => void>();
let catalogHidden = false,
  catalogRevision = 1,
  accessRevision = 1;
const bridge: Bridge = {
  async invoke(request) {
    requests.push(structuredClone(request));
    const p = request.params as Record<string, any>;
    switch (request.method) {
      case "platform.bootstrap":
        return ok(structuredClone(boot));
      case "spaces.ensure":
        return ok({ deskId: "desk", inboxId: "inbox", dialogueId: "dialogue" });
      case "cognitive-apps.list": {
        if (catalogHidden)
          return ok(
            parseCognitiveAppCatalog({
              versions: [],
              connections: [],
              nextVersionsAfter: null,
              nextConnectionsAfter: null,
            }),
          );
        // Short pages are transport facts. The actual shared owner must finish
        // its existing continuation protocol; the fixture never aggregates.
        const listedEntries = entries.map((entry) =>
          entry.appId === "author.gui" && mode.endsWith("disabled")
            ? {
                ...entry,
                installationState: "disabled",
                grant: { ...entry.grant!, state: "disabled" },
              }
            : entry.appId === "author.gui" && mode.endsWith("no-grant")
              ? { ...entry, grant: null }
              : entry,
        );
        return ok(
          parseCognitiveAppCatalog(
            p.versionsAfter || p.connectionsAfter
              ? {
                  versions: listedEntries.slice(1),
                  connections: connections.slice(1),
                  nextVersionsAfter: null,
                  nextConnectionsAfter: null,
                }
              : {
                  versions: listedEntries.slice(0, 1),
                  connections: connections.slice(0, 1),
                  nextVersionsAfter: "common_checkpoint_v2",
                  nextConnectionsAfter: "common_checkpoint_v2",
                },
          ),
        );
      }
      case "apps.list":
        // Exact same GUI definition also has an old installed header. The real
        // presentation must not offer the legacy sandbox as a safety bypass.
        return ok([
          {
            header: {
              format: "morphz-app/v1",
              id: "author.gui",
              version: "1.0.0",
              title: "作者界面",
              description: "同一认知应用的既有界面包",
              icon: "document",
              permissions: ["input.compose"],
              harness: null,
              ui: { type: "sandbox" },
            },
            installedAt: now,
            // Current SQL dynamically joins the exact definition and includes
            // this marker. The legacy-shaped omission is deliberately a
            // contradictory controlled port projection, not current SQL proof.
            ...(!mode.startsWith("existing-legacy-")
              ? { cognitive: { definitionHash: "a".repeat(64) } }
              : {}),
          },
        ]);
      case "app-views.list":
        return ok(mode.startsWith("existing-") ? [existingInstance] : []);
      case "tasks.counts":
      case "content.counts":
      case "content.deliveries":
        return ok([]);
      case "runtime.navigation":
        return ok({
          runtime,
          activityByProject: {},
          catalogVersion: catalogRevision,
          revisions: {
            projects: 1,
            conversations: 1,
            tasks: 1,
            access: accessRevision,
          },
          historyVersion: "d".repeat(64),
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
          inputs:
            p.projectId === "project-A"
              ? [
                  {
                    id: "input-original",
                    projectId: "project-A",
                    conversationId: "project-A",
                    author: {
                      principalId: boot.principalId,
                      actantId: boot.actantId,
                    },
                    targetActantId: "morphz-agent",
                    body: "原件历史",
                    cognitiveObject: original,
                    createdAt: now,
                  },
                ]
              : [],
          runtime,
          scriptOutputs: [],
          nextCursor: null,
        });
      case "content.list":
        return ok([originalEntry]);
      case "content.get":
        return ok(originalEntry);
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
      case "platform.message":
        return new Promise((resolve) =>
          pending.push({ request, settled: false, resolve }),
        );
      case "cognitive-apps.read-object":
        return ok({
          protocol: "morphz-domain/v1",
          authority: original.authority,
          object: original.object,
          title: "原件 V1",
          kind: "note",
          content: { format: "text", text: "原作者 V1 正文" },
        });
      default:
        unknown.push(request.method);
        return denied("Unexpected fixture RPC " + request.method);
    }
  },
  cancel(id) {
    cancelled.push(id);
  },
  async subscribe(id, scope) {
    subscribers.set(id, { scope, sequence: 0 });
  },
  unsubscribe(id) {
    subscribers.delete(id);
  },
  onStream(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};
const originalDesktop = window.morphzDesktop;
Object.assign(window, { morphzDesktop: { application: bridge } });
const preferencesKey = () =>
  `morphz:${boot.centerId}:${boot.principalId}:preferences`;
const inputsKey = () =>
  `morphz:${boot.centerId}:${boot.principalId}:draft:${windowOwner}:inputs`;
const initialBody = "原草稿字节\nUNCHANGED 😀";
const initialDraft = {
  body: initialBody,
  selection: "",
  revision: null,
  model: "fixture-model",
  reasoningEffort: "max",
  attachments: [
    { assetId: "e".repeat(64), name: "原附件.txt", mime: "text/plain" },
  ],
};
const quote = {
  id: "33333333-3333-4333-8333-333333333333",
  source: {
    kind: "web",
    projectId: "desk",
    title: "原引用",
    url: "https://example.invalid/original",
    pageId: "old-page",
    epoch: "old-epoch",
  },
  text: "原引用字节 😀",
  comment: "",
};
const mode = new URL(location.href).searchParams.get("mode") || "fresh";
if (mode !== "keep") {
  localStorage.clear();
  sessionStorage.setItem(applicationWindowKey, windowOwner);
  localStorage.setItem(
    preferencesKey(),
    JSON.stringify({
      view: mode === "project" || mode === "original" ? "projects" : "desk",
      projectId:
        mode === "project" || mode === "original" ? "project-A" : "desk",
      projectOpen: mode === "project" || mode === "original",
      artifactId: null,
      artifactRevision: null,
      sidebar: true,
      composer: true,
      conversation: true,
      collaboration: false,
      subjectOpen: false,
      selectedConversations: { "project-A": "project-A" },
      interactions: {
        desk: "input",
        "project-A": "input",
        "project-B": "input",
      },
      pinnedInputs: { desk: true, "project-A": true, "project-B": true },
      ...(mode.startsWith("existing-")
        ? { applications: { desk: existingInstance.id } }
        : {}),
      ...(mode === "empty-pins" ? { dockApplications: [] } : {}),
      ...(mode === "pinned"
        ? {
            dockApplications: [
              `cognitive:author.notes@1.0.0#${"a".repeat(64)}`,
              "author.hidden@9.0.0",
            ],
          }
        : {}),
      ...(mode === "original"
        ? { cognitiveLocation: { kind: "original", locator: original } }
        : {}),
    }),
  );
  localStorage.setItem(
    inputsKey(),
    JSON.stringify({
      "desk:desk:desk": {
        ...initialDraft,
        ...(mode === "task-result"
          ? { taskResult: { taskId: "old-task", revision: 2 } }
          : {}),
        ...(mode === "script-generation"
          ? {
              scriptGeneration: {
                productionId: "old-production",
                targetId: "old-script-item",
                baseRevision: 2,
                contextRevision: 3,
                purpose: "draft",
                references: [],
                maxCandidates: 1,
                maxOutputCharacters: 24000,
                maxReviewPasses: 1,
              },
            }
          : {}),
        ...(mode === "selected" || mode === "special"
          ? { cognitiveApplication: target() }
          : {}),
        ...(mode === "special"
          ? {
              continuation: {
                mode: "supplement",
                inputId: "old-input",
                threadId: "old-thread",
                generation: 1,
              },
              continuationLabel: "原工作",
              pendingSupplement: {
                commandId: "44444444-4444-4444-8444-444444444444",
                operation: {
                  type: "record-input",
                  continuation: {
                    mode: "supplement",
                    inputId: "old-input",
                    threadId: "old-thread",
                    generation: 1,
                  },
                  projectId: "desk",
                  conversationId: "desk",
                  artifactId: null,
                  artifactRevision: null,
                  selection: "",
                  body: "原补充",
                  targetActantId: "morphz-agent",
                },
              },
            }
          : {}),
      },
      "project-A:project-A:projects": {
        ...initialDraft,
        body: "项目 A 原草稿",
      },
      "project-B:project-B:projects": {
        ...initialDraft,
        body: "项目 B 原草稿",
      },
      "desk:quotes": {
        body: "",
        selection: "",
        revision: null,
        textQuotes: [quote],
      },
      "desk:legacy-cognitive-window": {
        ...initialDraft,
        body: "既有应用现场的未发送草稿",
      },
      ...(mode === "original"
        ? {
            ["project-A:cognitive:" +
            cognitiveWorkSurfaceKey({ kind: "original", locator: original })]: {
              ...initialDraft,
              body: "原件 V1 的未发送草稿",
              cognitiveObject: original,
              cognitiveApplication: target(),
            },
          }
        : {}),
    }),
  );
}
const { App } = await import("../../apps/web/src/App.js");
const storageGetItem = Storage.prototype.getItem;
const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
function changed(access = true) {
  if (access) accessRevision++;
  catalogRevision++;
  for (const [id, subscriber] of subscribers)
    if (subscriber.scope.kind === "workspace")
      for (const listener of listeners)
        listener({
          id,
          value: {
            kind: "workspace",
            sequence: ++subscriber.sequence,
            reason: "changed",
            accessChanged: access,
          },
        });
}
function report() {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="AI 输入内容"]',
  );
  return {
    boot: structuredClone(boot),
    requests: structuredClone(requests),
    unknown: [...unknown],
    cancelled: [...cancelled],
    pending: pending.map((p) => ({ request: p.request, settled: p.settled })),
    preferences: JSON.parse(localStorage.getItem(preferencesKey()) || "null"),
    drafts: JSON.parse(localStorage.getItem(inputsKey()) || "null"),
    stored: Object.fromEntries(
      Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
    ),
    textarea: textarea
      ? { value: textarea.value, disabled: textarea.disabled }
      : null,
    title: document.title,
    text: document.body.textContent,
    iframes: [...document.querySelectorAll("iframe")].map((frame) => ({
      src: frame.getAttribute("src"),
      sandbox: frame.getAttribute("sandbox"),
    })),
  };
}
Object.assign(window, {
  cognitiveChoiceAppFixture: {
    report,
    target,
    original,
    initialDraft,
    initialBody,
    quote,
    clearRequests() {
      requests.length = 0;
      unknown.length = 0;
    },
    settle(index: number) {
      const p = pending[index];
      if (!p || p.settled) throw Error("Missing pending command");
      p.settled = true;
      p.resolve(ok({ entityId: "controlled-input-" + index }));
    },
    hideCatalog() {
      catalogHidden = true;
      changed();
    },
    changeCreationHint(label: string, prompt: string) {
      for (const entry of entries)
        entry.creationIntents = [
          { operationId: "notes.create", label, prompt },
        ];
      changed();
    },
    manyCreationHints() {
      entries[0]!.creationIntents = Array.from({ length: 40 }, (_, index) => ({
        operationId: `notes.create-${index}`,
        label: `长名称的新建能力 ${index}`,
        prompt: `新建提示 ${index}`,
      }));
      changed();
    },
    refresh() {
      changed(false);
    },
    switchIdentity(
      field: "centerId" | "principalId" | "csrfToken",
      value: string,
    ) {
      boot[field] = value;
      changed();
    },
    rotateWindowOwner() {
      sessionStorage.setItem(
        applicationWindowKey,
        "55555555-5555-4555-8555-555555555555",
      );
    },
    denyWindowOwnerRead() {
      Storage.prototype.getItem = function (key) {
        if (this === sessionStorage && key === applicationWindowKey)
          throw new DOMException(
            "Controlled owner read failure",
            "SecurityError",
          );
        return storageGetItem.call(this, key);
      };
    },
    restoreWindowOwner() {
      Storage.prototype.getItem = storageGetItem;
      sessionStorage.setItem(applicationWindowKey, windowOwner);
    },
    unmount() {
      root.unmount();
    },
  },
});
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    root.unmount();
    Storage.prototype.getItem = storageGetItem;
    window.morphzDesktop = originalDesktop;
    listeners.clear();
    subscribers.clear();
  });
