import React, { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  useWorkspace,
  type WorkspaceClient,
} from "../../apps/web/src/client.js";
import { disconnectedRuntime } from "../../packages/core/src/conversation.js";
import type {
  ApplicationInvocation,
  ApplicationReply,
} from "../../packages/core/src/application-api.js";
import type { WorkspaceChange } from "../../packages/core/src/workspace-changes.js";

// Actual mounted React + original Client / transport / finite schemas. The
// logical bridge below is controlled: this is NOT SQL, HPA or Electron proof.
const centerId = "605a3e53-71c7-4689-81a6-7b5cb42f13d7";
const listeners = new Set<(event: any) => void>();
const subscriptions: Array<{
  id: string;
  generation: string;
  closed: boolean;
}> = [];
const calls: Array<{
  id: string;
  method: string;
  generation?: string;
  cancelled: boolean;
}> = [];
const publications: Array<{
  principalId: string;
  csrfToken: string;
  title: string;
}> = [];
let identity = "one",
  access = 1,
  catalog = 1,
  sequence = 0;
let unauthorized = false;
let hold: {
  method: string;
  skip: number;
  release?: () => void;
  entered: boolean;
} | null = null;
let client: WorkspaceClient;
let privateMounts = 0,
  privateUnmounts = 0;
let heldCompletions = 0;
const outcomes: Record<string, unknown> = {};
let logoutHold: {
  entered: boolean;
  release: () => void;
  pending: Promise<void>;
} | null = null;
let logoutFailure: "500" | "timeout" | null = null;
const project = (kind: "desk" | "inbox" | "dialogue") => ({
  id: kind,
  kind,
  ownerPrincipalId: identity,
  memberPrincipalIds: [identity],
  title: `${identity}-${catalog}-${kind}`,
  revision: catalog,
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
});
function result(method: string): unknown {
  switch (method) {
    case "platform.bootstrap":
      return {
        centerId,
        csrfToken: `generation-${identity}`,
        principalId: identity,
        actantId: `${identity}-human`,
        displayName: identity,
        capabilities: {
          runtime: false,
          teamAuthentication: false,
          directedInput: false,
          localFiles: false,
          browserBookmarks: false,
          modelSettings: false,
        },
      };
    case "spaces.ensure":
      return { deskId: "desk", inboxId: "inbox", dialogueId: "dialogue" };
    case "runtime.navigation":
      return {
        runtime: disconnectedRuntime,
        activityByProject: {},
        catalogVersion: catalog,
        revisions: { access, projects: catalog, conversations: 1, tasks: 1 },
      };
    case "projects.list":
      return [project("desk"), project("inbox"), project("dialogue")];
    case "tasks.order":
      return { revision: 0 };
    case "cognitive-apps.list":
      return {
        versions: [],
        connections: [],
        nextVersionsAfter: null,
        nextConnectionsAfter: null,
      };
    case "app-views.list":
    case "apps.list":
    case "tasks.counts":
    case "content.counts":
    case "content.list":
    case "conversations.navigation":
      return [];
    default:
      throw new Error(`Unexpected logical request: ${method}`);
  }
}
const bridge = {
  async invoke(request: ApplicationInvocation): Promise<ApplicationReply> {
    const item = {
      id: request.id,
      method: request.method,
      generation: request.identityGeneration,
      cancelled: false,
    };
    calls.push(item);
    if (request.method === "login") {
      identity = String((request.params as { token: string }).token);
      unauthorized = false;
      return { id: request.id, ok: true, value: undefined };
    }
    if (request.method === "logout") {
      const failure = logoutFailure;
      logoutFailure = null;
      if (failure === "500")
        return {
          id: request.id,
          ok: false,
          error: { status: 500, message: "Controlled logout failed" },
        };
      if (failure !== "timeout") unauthorized = true;
      if (logoutHold) {
        logoutHold.entered = true;
        await logoutHold.pending;
      }
      return { id: request.id, ok: true, value: undefined };
    }
    if (unauthorized)
      return {
        id: request.id,
        ok: false,
        error: { status: 401, message: "Controlled session expired" },
      };
    // Capture the original response before a delay, including its identity and
    // CAS. Cancellation deliberately cannot stop a late bridge completion.
    const value = structuredClone(result(request.method));
    if (hold?.method === request.method && !hold.entered) {
      if (hold.skip) hold.skip--;
      else {
        const active = hold;
        active.entered = true;
        await new Promise<void>((resolve) => {
          active.release = resolve;
        });
        heldCompletions++;
      }
    }
    return { id: request.id, ok: true, value };
  },
  cancel(id: string) {
    const item = calls.find((entry) => entry.id === id);
    if (item) item.cancelled = true;
  },
  async subscribe(id: string, _scope: unknown, generation: string) {
    subscriptions.push({ id, generation, closed: false });
  },
  unsubscribe(id: string) {
    const item = subscriptions.find((entry) => entry.id === id);
    if (item) item.closed = true;
  },
  onStream(listener: (event: any) => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
Object.defineProperty(window, "morphzDesktop", {
  configurable: true,
  value: { application: bridge },
});
localStorage.setItem(
  "workspace-owner-original-draft",
  "原未发送草稿 / original command",
);
function Private() {
  useLayoutEffect(() => {
    privateMounts++;
    return () => {
      privateUnmounts++;
    };
  }, []);
  return <p id="private">{client.boot!.workspace.projects[0]!.title}</p>;
}
function Probe() {
  client = useWorkspace();
  useLayoutEffect(() => {
    if (client.boot)
      publications.push({
        principalId: client.boot.principalId,
        csrfToken: client.boot.csrfToken,
        title: client.boot.workspace.projects[0]!.title,
      });
  });
  return client.boot ? (
    <Private />
  ) : (
    <p id="connection">{client.error || "connecting"}</p>
  );
}
const root = createRoot(document.getElementById("root")!);
flushSync(() => root.render(<Probe />));
const controls = {
  configure(value: {
    identity?: string;
    access?: number;
    catalog?: number;
    unauthorized?: boolean;
  }) {
    if (value.identity !== undefined) identity = value.identity;
    if (value.access !== undefined) access = value.access;
    if (value.catalog !== undefined) catalog = value.catalog;
    if (value.unauthorized !== undefined) unauthorized = value.unauthorized;
  },
  arm(method: string, skip = 0) {
    if (hold && !hold.entered)
      throw new Error("Existing hold was never reached");
    hold = { method, skip, entered: false };
  },
  release() {
    hold?.release?.();
    hold = null;
  },
  emit(
    accessChanged: boolean,
    reason: WorkspaceChange["reason"] = "changed",
    id?: string,
  ) {
    const subscription = id
      ? subscriptions.find((value) => value.id === id)
      : subscriptions.at(-1);
    if (!subscription) throw new Error("No real subscription yet");
    const value: WorkspaceChange = {
      kind: "workspace",
      sequence: ++sequence,
      reason,
      accessChanged,
    };
    // Sending even a disposed ID positively exercises the transport / owner
    // lifetime guards, rather than the controlled source suppressing it.
    for (const listener of listeners) listener({ id: subscription.id, value });
  },
  refresh() {
    return client.refresh();
  },
  startRefresh() {
    void client.refresh().then((value) => {
      outcomes.refresh = value;
    });
  },
  login(token: string) {
    return client.login(token);
  },
  logout() {
    return client.logout();
  },
  holdLogout() {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    logoutHold = { entered: false, release, pending };
  },
  releaseLogout() {
    logoutHold?.release();
  },
  failLogout(failure: "500" | "timeout") {
    logoutFailure = failure;
  },
  startLogout() {
    const started = performance.now();
    void client.logout().then(
      () => {
        outcomes.logout = true;
      },
      (error: unknown) => {
        outcomes.logout = {
          name: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : String(error),
          status: (error as { status?: number })?.status,
          elapsed: performance.now() - started,
        };
      },
    );
  },
  unmount() {
    flushSync(() => root.unmount());
  },
  report() {
    return {
      snapshot: client.getSnapshot()
        ? {
            principalId: client.getSnapshot()!.principalId,
            csrfToken: client.getSnapshot()!.csrfToken,
            title: client.getSnapshot()!.workspace.projects[0]!.title,
          }
        : null,
      error: client.error,
      authenticationRequired: client.authenticationRequired,
      calls: structuredClone(calls),
      subscriptions: structuredClone(subscriptions),
      listeners: listeners.size,
      held: hold?.entered ?? false,
      heldCompletions,
      logoutHeld: logoutHold?.entered ?? false,
      outcomes: structuredClone(outcomes),
      privateMounts,
      privateUnmounts,
      publications: structuredClone(publications),
      draft: localStorage.getItem("workspace-owner-original-draft"),
      domPrivate: !!document.getElementById("private"),
    };
  },
};
Reflect.set(window, "workspaceChangeOwner", controls);
