import React, { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type {
  ApplicationInvocation,
  ApplicationReply,
} from "../../packages/core/src/application-api.js";
import type {
  CognitiveAppCatalogDto,
  CognitiveAppRequestMap,
} from "../../packages/core/src/cognitive-app-api.js";
import { applicationWindowKey } from "../../packages/core/src/application-names.js";
import managementDefinition from "../../examples/cognitive-notes/definition.json";

// Actual production useWorkspace and application transport are loaded below.
// Only finite logical transport replies/events are controlled. This is not a
// native IPC, SQL/HPA, author network, App card, input selection or GUI proof.
const now = "2026-10-05T00:00:00.000Z";
const authorIcon =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mXcAAAAASUVORK5CYII=";
const boot = {
  centerId: "11111111-1111-4111-8111-111111111111",
  principalId: "human-A",
  csrfToken: "catalog-session-A",
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
const runtime = {
  configured: true,
  connected: true,
  model: "controlled-test-model",
  error: "",
  deliveries: [],
  messages: [],
  activity: { available: true, threads: [] },
};
function version(label: string): CognitiveAppCatalogDto["versions"][number] {
  return {
    appId: "example." + label,
    version: "1.0.0",
    definitionHash: "a".repeat(64),
    title: "声明 " + label + " 😀",
    description: "真实目录 DTO；无 GUI，不代表已经授权",
    icon: "document",
    ...(label === "one" ? { iconImage: authorIcon } : {}),
    registeredAt: now,
    installationState: "active",
    harness: null,
    ui: null,
    grant: null,
  };
}
function connection(
  label: string,
): CognitiveAppCatalogDto["connections"][number] {
  return {
    appId: "example." + label,
    connectionId: "connection-" + label,
    instanceId: "instance-" + label,
    serviceId: "author/service-" + label,
    dataAuthorityId: "author/data-" + label,
    state: "active",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}
function complete(label: string): CognitiveAppCatalogDto {
  return {
    versions: [version(label)],
    connections: [connection(label)],
    nextVersionsAfter: null,
    nextConnectionsAfter: null,
  };
}
const first: CognitiveAppCatalogDto = {
  versions: [version("one")],
  connections: [connection("one")],
  nextVersionsAfter: "versions-checkpoint-one",
  nextConnectionsAfter: "connections-checkpoint-one",
};
const second: CognitiveAppCatalogDto = {
  versions: [version("two")],
  connections: [connection("two")],
  nextVersionsAfter: "versions-checkpoint-two",
  nextConnectionsAfter: null,
};
const third: CognitiveAppCatalogDto = {
  versions: [version("three")],
  connections: [],
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
type CatalogPlan = { kind: "hold"; label: string } | { kind: "fail" };
const requests: ApplicationInvocation[] = [];
const unknown: string[] = [];
const cancelled: string[] = [];
const plans: CatalogPlan[] = [];
const held: Array<{
  request: ApplicationInvocation;
  label: string;
  settled: boolean;
  resolve(value: ApplicationReply): void;
}> = [];
const subscribers = new Map<
  string,
  {
    scope: Parameters<Bridge["subscribe"]>[1];
    generation: string;
    sequence: number;
  }
>();
const listeners = new Set<(event: StreamEvent) => void>();
// Management scripts control only public replies, never production ownership,
// retirement, refresh or retry. No script means an unexpected command fails.
type ManagementMethod =
  "describeRegistered" | "install" | "grant" | "connect" | "connectionState";
const managementLogical = {
  describeRegistered: "cognitive-apps.describe",
  install: "cognitive-apps.install",
  grant: "cognitive-apps.grant",
  connect: "cognitive-apps.connect",
  connectionState: "cognitive-apps.connection-state",
} as const;
const managementPlans: Array<{
  method: ManagementMethod;
  label: string;
  hold: boolean;
}> = [];
const managementHeld: Array<{
  request: ApplicationInvocation;
  label: string;
  settled: boolean;
  resolve(value: ApplicationReply): void;
}> = [];
const managementRuns: Array<{
  method: ManagementMethod | "login" | "logout";
  state: "pending" | "fulfilled" | "rejected";
  value?: unknown;
  error?: { message: string; code?: string };
}> = [];
function managementReply(request: ApplicationInvocation, label: string) {
  const p = request.params as Record<string, unknown>;
  switch (request.method) {
    case "cognitive-apps.describe":
      if (p.mode !== "registered-management")
        throw Error(
          "Only the exact registered-management describe is scripted",
        );
      return ok({
        mode: "registered-management",
        definition: {
          ...managementDefinition,
          title: "PRIVATE_DEFINITION_" + label,
        },
        definitionHash: p.expectedDefinitionHash,
        registeredAt: now,
        installationState: "active",
        grant: null,
      });
    case "cognitive-apps.install":
      if (p.mode !== "register-installed")
        throw Error("Only explicit register-installed is scripted");
      return ok({
        appId: p.appId,
        version: p.version,
        definitionHash: p.definitionHash,
      });
    case "cognitive-apps.grant":
      return ok({
        appId: p.appId,
        version: p.version,
        state: p.state,
        revision: Number(p.expectedRevision) + 1,
        consentedAt: now,
        updatedAt: now,
      });
    case "cognitive-apps.connect":
    case "cognitive-apps.connection-state":
      return ok({
        appId: p.appId,
        instanceId: "instance-management",
        connectionId: p.connectionId,
        serviceId: p.serviceId ?? "author/management-service",
        dataAuthorityId: p.dataAuthorityId ?? "author/management-data",
        state: p.state ?? "active",
        revision: Number(p.expectedRevision) + 1,
        createdAt: now,
        updatedAt: now,
      });
    default:
      throw Error("Unscripted management method " + request.method);
  }
}
let catalogRevision = 1;
let accessRevision = 1;
let failContentCounts = false;
const bridge: Bridge = {
  async invoke(request) {
    requests.push(structuredClone(request));
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case "platform.bootstrap":
        return ok(structuredClone(boot));
      case "spaces.ensure":
        return ok({ deskId: "desk", inboxId: "inbox", dialogueId: "dialogue" });
      case "app-views.list":
      case "apps.list":
      case "tasks.counts":
      case "content.list":
      case "content.deliveries":
        return ok([]);
      case "content.counts":
        if (failContentCounts) {
          failContentCounts = false;
          return denied("CONTROLLED_PARALLEL_READ_FAILED");
        }
        return ok([]);
      case "projects.list":
        return ok(
          (["desk", "inbox", "dialogue"] as const).map((id) => ({
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
          historyVersion: "b".repeat(64),
        });
      case "conversations.history":
        return ok({ inputs: [], runtime, scriptOutputs: [], nextCursor: null });
      case "tasks.order":
        return ok({ revision: 0 });
      case "cognitive-apps.describe":
      case "cognitive-apps.install":
      case "cognitive-apps.grant":
      case "cognitive-apps.connect":
      case "cognitive-apps.connection-state": {
        const plan = managementPlans.shift();
        if (!plan || managementLogical[plan.method] !== request.method) {
          unknown.push("unscripted management " + request.method);
          return denied("Unexpected management command");
        }
        if (!plan.hold) return managementReply(request, plan.label);
        return new Promise<ApplicationReply>((resolve) =>
          managementHeld.push({
            request,
            label: plan.label,
            settled: false,
            resolve,
          }),
        );
      }
      case "login":
        if (params.token !== "CONTROLLED_TEST_ONLY") {
          unknown.push("unscripted login");
          return denied("Unexpected test login");
        }
        boot.csrfToken = "catalog-login-session";
        return ok({});
      case "logout":
        return ok({});
      case "cognitive-apps.list": {
        // Finite response script, not a second pagination/merging algorithm.
        const v = params.versionsAfter;
        const c = params.connectionsAfter;
        if (v === undefined && c === undefined) {
          const plan = plans.shift();
          if (plan?.kind === "fail")
            return denied("CONTROLLED_CATALOG_READ_FAILED");
          if (plan?.kind === "hold")
            return new Promise<ApplicationReply>((resolve) =>
              held.push({
                request,
                label: plan.label,
                settled: false,
                resolve,
              }),
            );
          return ok(first);
        }
        if (
          (v === "versions-checkpoint-one" ||
            c === "connections-checkpoint-one") &&
          (v === undefined || v === "versions-checkpoint-one") &&
          (c === undefined || c === "connections-checkpoint-one")
        )
          return ok(second);
        if (v === "versions-checkpoint-two" && c === undefined)
          return ok(third);
        unknown.push("invalid catalog checkpoint " + JSON.stringify(params));
        return denied("Unexpected catalog continuation");
      }
      default:
        unknown.push(request.method);
        return denied("Unexpected owner fixture method " + request.method);
    }
  },
  cancel(id) {
    // Deliberately leave held replies resolvable: ignored IPC cancellation
    // must not let a retired projection reappear in production React state.
    cancelled.push(id);
  },
  async subscribe(id, scope, generation) {
    subscribers.set(id, { scope, generation, sequence: 0 });
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
localStorage.clear();
sessionStorage.setItem(applicationWindowKey, "catalog-owner-test-window");
const draftStorageKey = `morphz:${boot.centerId}:${boot.principalId}:draft:catalog-owner-test-window:inputs`;
const unsentBytes = JSON.stringify(
  {
    "conversation:dialogue": {
      body: "UNSENT_PRIVATE_😀\n保留所有字节",
      model: "user-model",
      reasoningEffort: "max",
      selection: "",
      revision: null,
    },
  },
  null,
  2,
);
localStorage.setItem(draftStorageKey, unsentBytes);
if (new URL(location.href).searchParams.get("mode") === "held")
  plans.push({ kind: "hold", label: "initial-held" });
const { useWorkspace } = await import("../../apps/web/src/client.js");
let latest: ReturnType<typeof useWorkspace> | null = null;
let mounted = true;
const trace: Array<{
  identity: { centerId: string; principalId: string; csrfToken: string } | null;
  catalog: { versions: string[]; connections: string[] };
}> = [];
function Owner() {
  const workspace = useWorkspace();
  latest = workspace;
  useEffect(() => {
    trace.push({
      identity: workspace.boot
        ? {
            centerId: workspace.boot.centerId,
            principalId: workspace.boot.principalId,
            csrfToken: workspace.boot.csrfToken,
          }
        : null,
      catalog: {
        versions: workspace.cognitiveAppCatalog.versions.map((v) => v.appId),
        connections: workspace.cognitiveAppCatalog.connections.map(
          (c) => c.connectionId,
        ),
      },
    });
  });
  return (
    <>
      <pre id="identity">
        {JSON.stringify(
          workspace.boot && {
            centerId: workspace.boot.centerId,
            principalId: workspace.boot.principalId,
            csrfToken: workspace.boot.csrfToken,
          },
        )}
      </pre>
      <pre id="catalog">{JSON.stringify(workspace.cognitiveAppCatalog)}</pre>
      <pre id="error">{workspace.error}</pre>
    </>
  );
}
const root = createRoot(document.getElementById("root")!);
function emit(accessChanged: boolean) {
  catalogRevision++;
  if (accessChanged) accessRevision++;
  for (const [id, subscriber] of subscribers)
    if (subscriber.scope.kind === "workspace") {
      subscriber.sequence++;
      for (const listener of listeners)
        listener({
          id,
          value: {
            kind: "workspace",
            sequence: subscriber.sequence,
            reason: "changed",
            accessChanged,
          },
        });
    }
}
function report() {
  return {
    mounted,
    boot: latest?.boot && {
      centerId: latest.boot.centerId,
      principalId: latest.boot.principalId,
      csrfToken: latest.boot.csrfToken,
    },
    catalog: latest?.cognitiveAppCatalog,
    error: latest?.error,
    online: latest?.online,
    renderedCatalog: document.getElementById("catalog")?.textContent,
    renderedError: document.getElementById("error")?.textContent,
    requests: structuredClone(requests),
    unknown: [...unknown],
    cancelled: [...cancelled],
    held: held.map((h, index) => ({
      index,
      label: h.label,
      id: h.request.id,
      settled: h.settled,
    })),
    trace: structuredClone(trace),
    subscribers: subscribers.size,
    unsentBytes,
    storedDraft: localStorage.getItem(draftStorageKey),
    draftStorageKey,
    managementRuns: structuredClone(managementRuns),
    managementHeld: managementHeld.map((h, index) => ({
      index,
      label: h.label,
      id: h.request.id,
      settled: h.settled,
    })),
  };
}
function observeManagement(
  method: ManagementMethod | "login" | "logout",
  operation: () => Promise<unknown>,
) {
  const run: (typeof managementRuns)[number] = { method, state: "pending" };
  managementRuns.push(run);
  // Observe the real public Promise. No private ref or synthetic owner is used.
  try {
    void operation().then(
      (value) => {
        run.state = "fulfilled";
        run.value = value;
      },
      (error: unknown) => {
        run.state = "rejected";
        run.error = {
          message: error instanceof Error ? error.message : String(error),
          ...(error && typeof error === "object" && "code" in error
            ? { code: String(error.code) }
            : {}),
        };
      },
    );
  } catch (error) {
    run.state = "rejected";
    run.error = {
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
Object.assign(window, {
  cognitiveCatalogOwnerFixture: {
    report,
    queueManagement(method: ManagementMethod, label: string, hold = true) {
      managementPlans.push({ method, label, hold });
    },
    startManagement(method: ManagementMethod, input: unknown) {
      const client = latest!;
      observeManagement(method, () => {
        switch (method) {
          case "describeRegistered":
            return client.cognitiveManagement.describeRegistered(
              input as Extract<
                CognitiveAppRequestMap["describe"],
                { mode: "registered-management" }
              >,
            );
          case "install":
            return client.cognitiveManagement.install(
              input as CognitiveAppRequestMap["install"],
            );
          case "grant":
            return client.cognitiveManagement.grant(
              input as CognitiveAppRequestMap["grant"],
            );
          case "connect":
            return client.cognitiveManagement.connect(
              input as CognitiveAppRequestMap["connect"],
            );
          case "connectionState":
            return client.cognitiveManagement.connectionState(
              input as CognitiveAppRequestMap["connectionState"],
            );
        }
      });
    },
    settleManagement(index: number) {
      const pending = managementHeld[index];
      if (!pending || pending.settled)
        throw Error("Missing unsettled management request " + index);
      pending.settled = true;
      pending.resolve(managementReply(pending.request, pending.label));
    },
    denyCatalogWithStatus(index: number, status: 401 | 403) {
      const pending = held[index];
      if (!pending || pending.settled)
        throw Error("Missing unsettled catalog read " + index);
      pending.settled = true;
      pending.resolve({
        ok: false,
        error: {
          status,
          code: status === 401 ? "unauthenticated" : "forbidden",
          message: "CONTROLLED_ACCESS_" + status,
        },
      });
    },
    login() {
      observeManagement("login", () => latest!.login("CONTROLLED_TEST_ONLY"));
    },
    logout() {
      observeManagement("logout", () => latest!.logout());
    },
    queueHold(label: string) {
      plans.push({ kind: "hold", label });
    },
    queueFailure() {
      plans.push({ kind: "fail" });
    },
    failNextContentCounts() {
      failContentCounts = true;
    },
    refresh() {
      void latest!.refresh();
    },
    async refreshAndWait() {
      await latest!.refresh();
    },
    invalidate: emit,
    changeIdentity(
      field: "centerId" | "principalId" | "csrfToken",
      value: string,
    ) {
      boot[field] = value;
      catalogRevision++;
    },
    settle(index: number) {
      const pending = held[index];
      if (!pending || pending.settled)
        throw Error("Missing unsettled catalog read " + index);
      pending.settled = true;
      pending.resolve(ok(complete(pending.label)));
    },
    fail(index: number) {
      const pending = held[index];
      if (!pending || pending.settled)
        throw Error("Missing unsettled catalog read " + index);
      pending.settled = true;
      pending.resolve(denied("CONTROLLED_CATALOG_READ_FAILED"));
    },
    settleWithContinuation(index: number) {
      const pending = held[index];
      if (!pending || pending.settled)
        throw Error("Missing unsettled catalog read " + index);
      pending.settled = true;
      pending.resolve(ok(first));
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
