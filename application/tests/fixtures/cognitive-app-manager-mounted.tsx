import { StrictMode, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ApplicationInvocation,
  ApplicationReply,
} from "../../packages/core/src/application-api.js";
import type { CognitiveAppCatalogDto } from "../../packages/core/src/cognitive-app-api.js";
import { applicationWindowKey } from "../../packages/core/src/application-names.js";
import { canonicalJsonBytes } from "../../packages/cognitive-app-sdk/src/domain-wire.js";
import definitionSource from "../../examples/cognitive-notes/definition.json";
// Keep the production entry's stylesheet order, including its extracted modal
// frame and shared controls; ui.css alone is no longer a complete UI shell.
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

// Real Chromium + production StrictMode useWorkspace, public management owner,
// facade, local retry helper and modal. ONLY finite logical transport replies
// are controlled. This is not native IPC, SQL, HPA or author-network evidence.
const now = "2026-10-05T00:00:00.000Z";
type EntryRun = { url: string; existingChildren: number; time: number };
const priorEntries: unknown = Reflect.get(
  window,
  "cognitiveManagerEntryEvidence",
);
const entryEvidence: EntryRun[] = Array.isArray(priorEntries)
  ? priorEntries
  : [];
entryEvidence.push({
  url: import.meta.url,
  existingChildren: document.getElementById("root")!.childNodes.length,
  time: Date.now(),
});
Reflect.set(window, "cognitiveManagerEntryEvidence", entryEvidence);
let uuidCalls = 0;
const originalRandomUUID = crypto.randomUUID.bind(crypto);
crypto.randomUUID = () => {
  uuidCalls++;
  return originalRandomUUID();
};
const rendererErrors: Array<{ text: string; stack: string }> = [];
let holdFileRead = false;
let holdDigest = false;
const digestReads: Array<{
  bytes: ArrayBuffer;
  resolve(bytes: ArrayBuffer): void;
}> = [];
const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = async (
  algorithm: AlgorithmIdentifier,
  data: BufferSource,
) => {
  const bytes = await originalDigest(algorithm, data);
  if (!holdDigest) return bytes;
  holdDigest = false;
  return new Promise<ArrayBuffer>((resolve) =>
    digestReads.push({ bytes, resolve }),
  );
};
const fileReads: Array<{
  bytes: ArrayBuffer;
  resolve(bytes: ArrayBuffer): void;
}> = [];
const originalArrayBuffer = File.prototype.arrayBuffer;
File.prototype.arrayBuffer = async function () {
  const bytes = await originalArrayBuffer.call(this);
  if (!holdFileRead) return bytes;
  holdFileRead = false;
  return new Promise<ArrayBuffer>((resolve) =>
    fileReads.push({ bytes, resolve }),
  );
};
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  rendererErrors.push({
    text: args.map(String).join(" "),
    stack: new Error("Actual renderer console.error").stack ?? "",
  });
  originalConsoleError(...args);
};
const boot = {
  centerId: "11111111-1111-4111-8111-111111111111",
  principalId: "manager-human-A",
  csrfToken: "manager-session-A",
  actantId: "manager-human-A",
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
const runtime = {
  configured: true,
  connected: true,
  model: "controlled-model",
  error: "",
  deliveries: [],
  messages: [],
  activity: { available: true, threads: [] },
};
type Metadata = CognitiveAppCatalogDto["versions"][number];
function version(v: string, grant: Metadata["grant"]): Metadata {
  return {
    appId: "example.notes",
    version: v,
    definitionHash: (v === "1.0.0" ? "a" : "b").repeat(64),
    title: "独立笔记 " + v,
    description: "作者原件与精确版本",
    icon: "document",
    registeredAt: now,
    installationState: "active",
    harness: null,
    ui: null,
    grant,
  };
}
let catalog: CognitiveAppCatalogDto = {
  versions: [
    version("1.0.0", null),
    version("2.0.0", {
      appId: "example.notes",
      version: "2.0.0",
      state: "disabled",
      revision: 7,
      consentedAt: now,
      updatedAt: now,
    }),
  ],
  connections: [
    {
      appId: "example.notes",
      connectionId: "connection-original",
      instanceId: "instance-original",
      serviceId: "author/service-original",
      dataAuthorityId: "author/data-original",
      state: "active",
      revision: 4,
      createdAt: now,
      updatedAt: now,
    },
  ],
  nextVersionsAfter: null,
  nextConnectionsAfter: null,
};
const ok = (value: unknown): ApplicationReply => ({ ok: true, value });
const denied = (message: string): ApplicationReply => ({
  ok: false,
  error: { status: 503, message, code: "unavailable" },
});
type Bridge = NonNullable<NonNullable<Window["morphzDesktop"]>["application"]>;
type StreamEvent = Parameters<Parameters<Bridge["onStream"]>[0]>[0];
type Plan = { method: string; hold: boolean; fail: boolean; label: string };
const plans: Plan[] = [],
  requests: ApplicationInvocation[] = [],
  unknown: string[] = [],
  cancelled: string[] = [];
const held: Array<{
  request: ApplicationInvocation;
  plan: Plan;
  settled: boolean;
  reply?: ApplicationReply;
  resolve(reply: ApplicationReply): void;
}> = [];
const listeners = new Set<(event: StreamEvent) => void>();
const subscribers = new Map<
  string,
  { scope: Parameters<Bridge["subscribe"]>[1]; sequence: number }
>();
let catalogRevision = 1,
  accessRevision = 1;
const methods = new Set([
  "cognitive-apps.describe",
  "cognitive-apps.install",
  "cognitive-apps.grant",
  "cognitive-apps.connect",
  "cognitive-apps.connection-state",
]);
function managementReply(
  request: ApplicationInvocation,
  plan: Plan,
): ApplicationReply {
  if (plan.fail) return denied("CONTROLLED_MANAGEMENT_FAILURE");
  const p = request.params as Record<string, unknown>;
  if (request.method === "cognitive-apps.describe") {
    if (p.mode !== "registered-management")
      throw Error("Only exact Human management describe is scripted");
    const entry = catalog.versions.find(
      (v) =>
        v.appId === p.appId &&
        v.version === p.version &&
        v.definitionHash === p.expectedDefinitionHash,
    );
    if (!entry) return denied("CONTROLLED_ENTRY_GONE");
    return ok({
      mode: "registered-management",
      definition: {
        ...definitionSource,
        version: entry.version,
        title: entry.title,
        description: "PRIVATE_PREVIEW_" + plan.label,
      },
      definitionHash: entry.definitionHash,
      registeredAt: entry.registeredAt,
      installationState: entry.installationState,
      grant: entry.grant,
    });
  }
  if (request.method === "cognitive-apps.install") {
    const d = p.definition as Record<string, unknown> | undefined;
    catalogRevision++;
    return ok({
      appId: p.appId ?? d?.id,
      version: p.version ?? d?.version,
      definitionHash: p.definitionHash ?? "c".repeat(64),
    });
  }
  if (request.method === "cognitive-apps.grant") {
    const grant = {
      appId: p.appId,
      version: p.version,
      state: p.state,
      revision: Number(p.expectedRevision) + 1,
      consentedAt: now,
      updatedAt: now,
    };
    catalog = {
      ...catalog,
      versions: catalog.versions.map((v) =>
        v.appId === p.appId && v.version === p.version
          ? { ...v, grant: grant as Metadata["grant"] }
          : v,
      ),
    };
    catalogRevision++;
    accessRevision++;
    return ok(grant);
  }
  const prior = catalog.connections.find(
    (c) => c.connectionId === p.connectionId,
  );
  // Controlled existing successful receipt reply, not a second create/enable.
  // Actual receipt/SQL authorization is validated by the separate backend suite.
  if (
    request.method === "cognitive-apps.connect" &&
    plan.label === "receipt-current"
  ) {
    if (!prior) throw Error("Missing controlled original receipt connection");
    return ok(structuredClone(prior));
  }
  const connection = {
    appId: String(p.appId),
    instanceId: prior?.instanceId ?? "instance-new",
    connectionId: String(p.connectionId),
    serviceId: String(p.serviceId ?? prior?.serviceId),
    dataAuthorityId: String(p.dataAuthorityId ?? prior?.dataAuthorityId),
    state: (p.state ?? "active") as "active" | "disabled" | "unavailable",
    revision: Number(p.expectedRevision) + 1,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  };
  catalog = {
    ...catalog,
    connections: [
      ...catalog.connections.filter(
        (c) => c.connectionId !== connection.connectionId,
      ),
      connection,
    ],
  };
  catalogRevision++;
  accessRevision++;
  return ok(connection);
}
const bridge: Bridge = {
  async invoke(request) {
    requests.push(structuredClone(request));
    if (methods.has(request.method)) {
      const plan = plans.shift();
      if (!plan || plan.method !== request.method) {
        unknown.push("unscripted mutation/preview " + request.method);
        return denied("Unexpected management call");
      }
      if (plan.hold)
        return new Promise<ApplicationReply>((resolve) =>
          held.push({
            request,
            plan,
            resolve,
            settled: false,
            ...(request.method === "cognitive-apps.describe"
              ? { reply: managementReply(request, plan) }
              : {}),
          }),
        );
      return managementReply(request, plan);
    }
    switch (request.method) {
      case "platform.bootstrap":
        return ok(structuredClone(boot));
      case "spaces.ensure":
        return ok({ deskId: "desk", inboxId: "inbox", dialogueId: "dialogue" });
      case "app-views.list":
      case "apps.list":
      case "tasks.counts":
      case "content.counts":
      case "content.list":
      case "content.deliveries":
        return ok([]);
      case "projects.list":
        return ok(
          ["desk", "inbox", "dialogue"].map((id) => ({
            id,
            kind: id,
            ownerPrincipalId: boot.principalId,
            memberPrincipalIds: [boot.principalId],
            title: id,
            revision: 1,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            deletedAt: null,
          })),
        );
      case "conversations.navigation":
        return ok(
          ["desk", "inbox", "dialogue"].map((id) => ({
            id,
            projectId: id,
            kind: "default",
            title: id,
            revision: 1,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          })),
        );
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
      case "conversations.history":
        return ok({ inputs: [], runtime, scriptOutputs: [], nextCursor: null });
      case "tasks.order":
        return ok({ revision: 0 });
      case "cognitive-apps.list": {
        if (plans[0]?.method === request.method) {
          const plan = plans.shift()!;
          if (plan.hold)
            return new Promise<ApplicationReply>((resolve) =>
              held.push({ request, plan, resolve, settled: false }),
            );
          if (plan.fail) return denied("CONTROLLED_REFRESH_FAILURE");
        }
        return ok(structuredClone(catalog));
      }
      default:
        unknown.push(request.method);
        return denied("Unexpected fixture method " + request.method);
    }
  },
  cancel(id) {
    cancelled.push(id);
  }, // Late replies deliberately remain possible.
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
Object.assign(window, { morphzDesktop: { application: bridge } });
// New isolated BrowserContext only: a genuine same-window reload must retain
// the production retry record/window identity rather than re-seed its bytes.
if (!sessionStorage.getItem("cognitive-manager-fixture-initialized")) {
  localStorage.clear();
  sessionStorage.setItem(applicationWindowKey, "manager-mounted-window");
  sessionStorage.setItem("cognitive-manager-fixture-initialized", "true");
}
const draftStorageKey = `morphz:${boot.centerId}:${boot.principalId}:draft:manager-mounted-window:inputs`;
const unsentBytes = JSON.stringify(
  {
    "conversation:dialogue": {
      body: "未发送旧稿 😀\n全部保留",
      selection: "",
      revision: null,
    },
  },
  null,
  2,
);
localStorage.setItem(draftStorageKey, unsentBytes);
// Dynamic imports ensure the real transport captures the installed bridge and
// the actual persisted window owner, never a test double of the production UI.
const { useWorkspace } = await import("../../apps/web/src/client.js");
const { CognitiveAppManager } =
  await import("../../apps/web/src/features/applications/CognitiveAppManager.js");
let latest: ReturnType<typeof useWorkspace> | null = null;
let openManager: (() => void) | null = null;
let changeConditionalHost: ((enabled: boolean) => void) | null = null;
let mounted = true;
const actualGrantRuns: Array<{
  state: "pending" | "fulfilled" | "rejected";
  value?: unknown;
  error?: string;
}> = [];
const actualConnectRuns: typeof actualGrantRuns = [];
const trace: Array<{
  identity: string | null;
  preview: string;
  notice: string;
}> = [];
function Owner() {
  const workspace = useWorkspace();
  latest = workspace;
  const [open, setOpen] = useState(false);
  const [conditionalHost, setConditionalHost] = useState(false);
  changeConditionalHost = setConditionalHost;
  const identity = useRef<{
    centerId: string;
    principalId: string;
    csrfToken: string;
  } | null>(null);
  if (workspace.boot)
    identity.current = {
      centerId: workspace.boot.centerId,
      principalId: workspace.boot.principalId,
      csrfToken: workspace.boot.csrfToken,
    };
  openManager = () => setOpen(true);
  useLayoutEffect(() => {
    // Real App's protected private subtree loses its own modal state when boot
    // clears. A successful refresh must not automatically reopen management.
    if (conditionalHost && !workspace.boot) setOpen(false);
    trace.push({
      identity: workspace.boot ? JSON.stringify(identity.current) : null,
      preview:
        document.querySelector(".cognitive-app-manager-definition")
          ?.textContent ?? "",
      notice:
        document.querySelector(".cognitive-app-manager-notice")?.textContent ??
        "",
    });
  });
  return (
    <div
      className="app"
      data-theme="cyan"
      style={{ height: "100dvh", width: "100%", display: "block" }}
    >
      <main
        className="workspace"
        style={{ width: "100%", height: "100%", margin: 0 }}
      >
        <button
          id="manager-trigger"
          type="button"
          disabled={!workspace.boot}
          onClick={() => setOpen(true)}
        >
          管理应用
        </button>
        {open && identity.current && (!conditionalHost || workspace.boot) && (
          <CognitiveAppManager
            catalog={workspace.cognitiveAppCatalog}
            management={{
              ...workspace.cognitiveManagement,
              connect(input, signal) {
                const run: (typeof actualConnectRuns)[number] = {
                  state: "pending",
                };
                actualConnectRuns.push(run);
                const actual = workspace.cognitiveManagement.connect(
                  input,
                  signal,
                );
                void actual.then(
                  (value) => {
                    run.state = "fulfilled";
                    run.value = value;
                  },
                  (error: unknown) => {
                    run.state = "rejected";
                    run.error =
                      error instanceof Error ? error.message : String(error);
                  },
                );
                return actual;
              },
              grant(input, signal) {
                const run: (typeof actualGrantRuns)[number] = {
                  state: "pending",
                };
                actualGrantRuns.push(run);
                const actual = workspace.cognitiveManagement.grant(
                  input,
                  signal,
                );
                void actual.then(
                  (value) => {
                    run.state = "fulfilled";
                    run.value = value;
                  },
                  (error: unknown) => {
                    run.state = "rejected";
                    run.error =
                      error instanceof Error ? error.message : String(error);
                  },
                );
                return actual;
              },
            }}
            identity={identity.current}
            onClose={() => setOpen(false)}
          />
        )}
      </main>
    </div>
  );
}
const root = createRoot(document.getElementById("root")!);
function emit(accessChanged = false) {
  catalogRevision++;
  if (accessChanged) accessRevision++;
  for (const [id, s] of subscribers)
    if (s.scope.kind === "workspace") {
      s.sequence++;
      for (const listener of listeners)
        listener({
          id,
          value: {
            kind: "workspace",
            sequence: s.sequence,
            reason: "changed",
            accessChanged,
          },
        });
    }
}
function report() {
  return {
    mounted,
    boot: latest?.boot
      ? {
          centerId: latest.boot.centerId,
          principalId: latest.boot.principalId,
          csrfToken: latest.boot.csrfToken,
        }
      : null,
    online: latest?.online ?? false,
    catalog: latest?.cognitiveAppCatalog ?? { versions: [], connections: [] },
    requests: structuredClone(requests),
    unknown: [...unknown],
    cancelled: [...cancelled],
    held: held.map((h, index) => ({
      index,
      method: h.request.method,
      label: h.plan.label,
      settled: h.settled,
    })),
    trace: structuredClone(trace),
    rendererErrors: structuredClone(rendererErrors),
    entryEvidence: structuredClone(entryEvidence),
    actualGrantRuns: structuredClone(actualGrantRuns),
    actualConnectRuns: structuredClone(actualConnectRuns),
    fileReads: fileReads.length,
    digestReads: digestReads.length,
    uuidCalls,
    draftStorageKey,
    unsentBytes,
    storedDraft: localStorage.getItem(draftStorageKey),
    retryRecords: Object.keys(localStorage)
      .filter((k) => k.includes(":cognitive-installation:"))
      .map((key) => ({ key, bytes: localStorage.getItem(key) })),
    connectionRetryRecords: Object.keys(localStorage)
      .filter((key) => key.includes(":cognitive-connection:"))
      .map((key) => ({ key, bytes: localStorage.getItem(key) })),
    notice:
      document.querySelector(".cognitive-app-manager-notice")?.textContent ??
      "",
    preview:
      document.querySelector(".cognitive-app-manager-definition")
        ?.textContent ?? "",
  };
}
export type CognitiveAppManagerMountedReport = ReturnType<typeof report>;
Object.assign(window, {
  cognitiveAppManagerFixture: {
    report,
    queue(method: string, label: string, hold = false, fail = false) {
      plans.push({ method, label, hold, fail });
    },
    settle(index: number) {
      const h = held[index];
      if (!h || h.settled) throw Error("Missing held reply " + index);
      h.settled = true;
      h.resolve(
        h.reply ??
          (h.request.method === "cognitive-apps.list"
            ? ok(structuredClone(catalog))
            : managementReply(h.request, h.plan)),
      );
    },
    refresh() {
      void latest!.refresh();
    },
    changeIdentity(
      field: "centerId" | "principalId" | "csrfToken",
      value: string,
    ) {
      boot[field] = value;
      emit(true);
    },
    removeSelected(version: string) {
      catalog = {
        ...catalog,
        versions: catalog.versions.filter((v) => v.version !== version),
      };
      emit();
    },
    setGrant(version: string, revision: number, state: "active" | "disabled") {
      catalog = {
        ...catalog,
        versions: catalog.versions.map((v) =>
          v.version === version
            ? {
                ...v,
                grant: {
                  appId: v.appId,
                  version,
                  revision,
                  state,
                  consentedAt: now,
                  updatedAt: now,
                },
              }
            : v,
        ),
      };
      emit();
    },
    corruptRetry() {
      for (const key of Object.keys(localStorage))
        if (key.includes(":cognitive-installation:"))
          localStorage.setItem(key, "null");
    },
    materializeConnect(wrongData = false) {
      const request = requests.findLast(
        (r) => r.method === "cognitive-apps.connect",
      );
      if (!request) throw Error("Missing original connect");
      const copied = structuredClone(request);
      if (wrongData)
        (copied.params as Record<string, unknown>).dataAuthorityId =
          "author/wrong-data";
      managementReply(copied, {
        method: copied.method,
        label: "materialized-original",
        hold: false,
        fail: false,
      });
      emit();
    },
    setConnectionState(
      connectionId: string,
      state: "disabled" | "unavailable",
      revision: number,
    ) {
      catalog = {
        ...catalog,
        connections: catalog.connections.map((connection) =>
          connection.connectionId === connectionId
            ? { ...connection, state, revision }
            : connection,
        ),
      };
      emit();
    },
    materializeConnectionRequest(
      input: Record<string, unknown>,
      state: "disabled" | "unavailable",
      revision: number,
    ) {
      // Public connection metadata in a controlled reply fixture only. This is
      // not an author receipt/SQL claim or a second Host operation.
      catalog = {
        ...catalog,
        connections: [
          ...catalog.connections.filter(
            (c) => c.connectionId !== input.connectionId,
          ),
          {
            appId: String(input.appId),
            connectionId: String(input.connectionId),
            instanceId: "instance-replayed",
            serviceId: String(input.serviceId),
            dataAuthorityId: String(input.dataAuthorityId),
            state,
            revision,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
      emit();
    },
    async replaceConnectionRetry() {
      const key = Object.keys(localStorage).find(
        (key) =>
          key.startsWith("morphz:") && key.includes(":cognitive-connection:"),
      );
      if (!key) throw Error("Missing real pending connection record");
      const stored = JSON.parse(localStorage.getItem(key)!) as {
        request: Record<string, unknown>;
        requestSha: string;
      };
      stored.request.connectionId = "separately_prepared_attempt";
      const digest = await crypto.subtle.digest(
        "SHA-256",
        Uint8Array.from(canonicalJsonBytes(stored.request)),
      );
      stored.requestSha = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      localStorage.setItem(key, JSON.stringify(stored));
    },
    corruptConnectionRetry() {
      for (const key of Object.keys(localStorage))
        if (key.includes(":cognitive-connection:"))
          localStorage.setItem(key, "null");
    },
    loseWindowOwner() {
      sessionStorage.removeItem(applicationWindowKey);
    },
    holdFile() {
      holdFileRead = true;
    },
    holdDigest() {
      holdDigest = true;
    },
    settleDigest(index: number) {
      const read = digestReads[index];
      if (!read) throw Error("Missing actual WebCrypto digest " + index);
      read.resolve(read.bytes);
    },
    settleFile(index: number) {
      const read = fileReads[index];
      if (!read) throw Error("Missing actual file read " + index);
      read.resolve(read.bytes);
    },
    failCleanup() {
      const original = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key: string) {
        if (key.includes(":cognitive-installation:"))
          throw Error("CONTROLLED_CLEANUP_FAILURE");
        original.call(this, key);
      };
    },
    open() {
      openManager!();
    },
    conditionalHost(enabled: boolean) {
      changeConditionalHost!(enabled);
    },
    unmount() {
      mounted = false;
      root.unmount();
    },
  },
});
root.render(
  <StrictMode>
    <Owner />
  </StrictMode>,
);
// Vite marks this TSX entry self-accepting. A hot replacement must retire its
// own root/listeners and instrumentation before running the entry again. It
// deliberately retains same-window persistent attempts; page reload is still
// a separate tested lifecycle. No production warning is filtered or ignored.
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    mounted = false;
    root.unmount();
    listeners.clear();
    subscribers.clear();
    console.error = originalConsoleError;
    File.prototype.arrayBuffer = originalArrayBuffer;
    crypto.subtle.digest = originalDigest;
    crypto.randomUUID = originalRandomUUID;
  });
