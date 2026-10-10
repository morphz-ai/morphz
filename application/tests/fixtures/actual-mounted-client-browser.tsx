import React, { useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { flushSync } from "react-dom";
import {
  useWorkspace,
  type WorkspaceClient,
} from "../../apps/web/src/client.js";
import { readSavedInputs } from "../../apps/web/src/local-saved-inputs.js";

// This is a mounted Client, not a fake transport or a production App. All API
// replies/cookies/storage are real. The sole seam holds an already received
// native HTTP response before the actual Client may consume it.
const nativeFetch = window.fetch.bind(window);
const requests: Array<{
  url: string;
  path: string;
  method: string;
  status: number;
  headers: Array<[string, string]>;
  body: unknown;
}> = [];
const holds = new Map<
  string,
  {
    path: string;
    reached: boolean;
    value: unknown;
    status?: number;
    pending: Promise<void>;
    release: () => void;
  }
>();
let armed: string | null = null;
window.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    location.origin,
  );
  if (url.origin !== location.origin)
    throw new Error("Only this isolated actual HTTP Host is in scope");
  const response = await nativeFetch(input, init);
  requests.push({
    url: url.href,
    path: url.pathname,
    method: init?.method ?? "GET",
    status: response.status,
    headers: [...new Headers(init?.headers)],
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  });
  const active = armed ? holds.get(armed) : undefined;
  if (active && active.path === url.pathname) {
    armed = null;
    active.status = response.status;
    active.value = await response.clone().json();
    active.reached = true;
    await active.pending;
  }
  return response;
};
let client!: WorkspaceClient;
const slots = new Map<string, unknown>();
const pending = new Map<string, Promise<unknown>>();
let sequence = 0;
let ssrCaptured = false;
const beforeConstruction = requests.length;
function ConstructionOnly() {
  useWorkspace();
  ssrCaptured = true;
  return <span />;
}
const construction = {
  html: renderToString(<ConstructionOnly />),
  captured: ssrCaptured,
  before: beforeConstruction,
  after: requests.length,
};
const publications: string[] = [];
function Probe() {
  client = useWorkspace();
  useLayoutEffect(() => {
    if (client.boot) publications.push(client.boot.csrfToken);
  });
  return (
    <p id="mounted-client">
      {client.boot?.principalId ?? client.error ?? "connecting"}
    </p>
  );
}
let root: Root | null = null;
function mount() {
  root = createRoot(document.getElementById("root")!);
  flushSync(() => root!.render(<Probe />));
}
function unmount() {
  flushSync(() => root?.unmount());
  root = null;
}
function errorValue(error: unknown) {
  return {
    name: error instanceof Error ? error.name : "unknown",
    message: error instanceof Error ? error.message : String(error),
    status: (error as { status?: number })?.status,
    code: (error as { code?: string })?.code,
  };
}
const allowed = new Set([
  "login",
  "logout",
  "refresh",
  "resolveArtifact",
  "resolveCatalogContent",
  "execute",
  "dispatchInput",
  "executionSnapshot",
  "executionResult",
  "cancelInput",
  "controlExecution",
  "approvalSubmitted",
]);
const api = {
  construction,
  async call(name: string, args: unknown[], slot?: string) {
    if (!allowed.has(name)) throw new Error("Unexpected Client method");
    try {
      const fn = Reflect.get(client, name) as (...values: unknown[]) => unknown;
      const value = await fn(...args);
      if (slot) slots.set(slot, value);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: errorValue(error) };
    }
  },
  start(name: string, args: unknown[], slot?: string) {
    const id = "pending-" + ++sequence;
    pending.set(id, api.call(name, args, slot));
    return id;
  },
  async finish(id: string) {
    const result = pending.get(id);
    if (!result) throw new Error("Unknown actual pending operation");
    return result;
  },
  snapshot(slot?: string) {
    const value = client.getSnapshot();
    if (slot) slots.set(slot, value);
    return value;
  },
  sameSnapshot(slot: string) {
    return client.getSnapshot() === slots.get(slot);
  },
  sameResult(left: string, right: string) {
    return slots.get(left) === slots.get(right);
  },
  sameContent(left: string, right: string) {
    return (
      (slots.get(left) as { content?: unknown })?.content ===
      (slots.get(right) as { content?: unknown })?.content
    );
  },
  artifactIdentity(contentId: string, slot: string) {
    return (
      client
        .getSnapshot()
        ?.workspace.artifacts.find((value) => value.id === contentId) ===
      slots.get(slot)
    );
  },
  stagedExecute(args: unknown[], key: string) {
    const id = "pending-" + ++sequence;
    pending.set(
      id,
      (async () => {
        try {
          const value = await Reflect.apply(client.execute, undefined, [
            ...args,
            (commandId: string) => slots.set(key, commandId),
          ]);
          return { ok: true, value };
        } catch (error) {
          return { ok: false, error: errorValue(error) };
        }
      })(),
    );
    return id;
  },
  staged(key: string) {
    return slots.get(key);
  },
  saved(scope: string) {
    return readSavedInputs(localStorage, scope);
  },
  storage() {
    return Object.fromEntries(
      Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
    );
  },
  reads() {
    return requests;
  },
  clearReads() {
    requests.length = 0;
  },
  hold(path: string) {
    if (armed) throw new Error("A preceding response hold was not reached");
    const id = "hold-" + ++sequence;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    holds.set(id, {
      path,
      reached: false,
      value: undefined,
      pending: wait,
      release,
    });
    armed = id;
    return id;
  },
  holdReport(id: string) {
    const value = holds.get(id);
    if (!value) throw new Error("Unknown actual response hold");
    return { reached: value.reached, status: value.status, value: value.value };
  },
  release(id: string) {
    holds.get(id)?.release();
  },
  remount() {
    unmount();
    mount();
  },
  mount,
  unmount,
  report() {
    return {
      snapshot: client.getSnapshot(),
      error: client.error,
      publications,
      mounted: !!root,
    };
  },
  cleanup() {
    for (const hold of holds.values()) hold.release();
    unmount();
  },
};
Reflect.set(window, "actualMountedClient", api);
