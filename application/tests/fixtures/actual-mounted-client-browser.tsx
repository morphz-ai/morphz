import React, { useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { flushSync } from "react-dom";
import {
  useWorkspace,
  type WorkspaceClient,
} from "../../apps/web/src/client.js";
import { readSavedInputs } from "../../apps/web/src/local-saved-inputs.js";
import { draftKey } from "../../apps/web/src/local-preferences.js";
import { PlatformClient } from "../../apps/web/src/platform-client.js";
import { applicationCall } from "../../apps/web/src/application-transport.js";
import { UnsentOperationError } from "../../apps/web/src/data/operation-delivery.js";
import { ConversationHistoryNotice } from "../../apps/web/src/WorkspaceNotice.js";
import { deriveWorkSurface } from "../../apps/web/src/host/work-surface.js";
import { initialWorkspace } from "../../packages/core/src/model.js";
import type {
  ApplicationInvocation,
  ApplicationReply,
} from "../../packages/core/src/application-api.js";

// This is a mounted Client, not a fake transport or a production App. All API
// replies/cookies/storage are real. The sole seam holds an already received
// native HTTP response before the actual Client may consume it.
const nativeFetch = window.fetch.bind(window);
const requests: Array<{
  url: string;
  path: string;
  query: string;
  method: string;
  status: number;
  headers: Array<[string, string]>;
  body: unknown;
  response: unknown;
  returnedStatus?: number;
}> = [];
const holds = new Map<
  string,
  {
    path: string;
    matcherName?: string;
    reached: boolean;
    value: unknown;
    status?: number;
    pending: Promise<void>;
    release: () => void;
  }
>();
let armed: string | null = null;
let lostResponsePath: string | null = null;
let lostResponseMessage = "TEST lost authorized bookmark receipt";
let failStorageClear = false;
let failStorageClearOnce = false;
let storageFailureMessage = "TEST success clear storage failure";
let replacedResponse: { path: string; status: number } | null = null;
let networkPending = 0,
  networkSettledAt = Date.now();
const nativeSetItem = Storage.prototype.setItem;
Storage.prototype.setItem = function (key, value) {
  if (this === localStorage && failStorageClear && value === "null") {
    if (failStorageClearOnce) failStorageClear = false;
    throw Error(storageFailureMessage);
  }
  return nativeSetItem.call(this, key, value);
};
window.fetch = async (input, init) => {
  networkPending++;
  let networkFinished = false;
  const finishNetwork = () => {
    if (networkFinished) return;
    networkFinished = true;
    networkPending--;
    networkSettledAt = Date.now();
  };
  try {
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
    let requestBody: unknown;
    if (typeof init?.body === "string") {
      try {
        requestBody = JSON.parse(init.body);
      } catch {
        requestBody = init.body;
      }
    } else if (
      init?.body instanceof ArrayBuffer ||
      ArrayBuffer.isView(init?.body)
    ) {
      const bytes =
        init.body instanceof ArrayBuffer
          ? new Uint8Array(init.body)
          : new Uint8Array(
              init.body.buffer,
              init.body.byteOffset,
              init.body.byteLength,
            );
      requestBody = { bytes: [...bytes] };
    }
    requests.push({
      url: url.href,
      path: url.pathname,
      query: url.search,
      method: init?.method ?? "GET",
      status: response.status,
      headers: [...new Headers(init?.headers)],
      body: requestBody,
      response: response.headers
        .get("content-type")
        ?.includes("application/json")
        ? await response.clone().json()
        : undefined,
    });
    finishNetwork();
    if (lostResponsePath === url.pathname) {
      lostResponsePath = null;
      if (
        response.status !== (url.pathname === "/api/import/reading" ? 201 : 200)
      )
        throw Error("TEST loss requires a committed endpoint receipt");
      throw Error(lostResponseMessage);
    }
    const active = armed ? holds.get(armed) : undefined;
    if (
      active &&
      (active.matcherName
        ? await Reflect.get(
            window,
            active.matcherName,
          )({
            url: url.href,
            status: response.status,
            value: requests.at(-1)?.response,
          })
        : active.path === url.pathname)
    ) {
      armed = null;
      active.status = response.status;
      active.value = await response.clone().json();
      active.reached = true;
      await active.pending;
    }
    if (replacedResponse?.path === url.pathname) {
      const { status } = replacedResponse;
      replacedResponse = null;
      if (response.status !== 200)
        throw Error(
          "TEST replacement requires a real authorized success/commit",
        );
      requests.at(-1)!.returnedStatus = status;
      return new Response(
        JSON.stringify({
          message: "TEST controlled reply after real commit",
          code: "test_after_commit",
        }),
        { status, headers: { "Content-Type": "application/json" } },
      );
    }
    return response;
  } finally {
    finishNetwork();
  }
};
let client!: WorkspaceClient;
const slots = new Map<string, unknown>();
const pending = new Map<string, Promise<unknown>>();
const abortControllers = new Map<string, AbortController>();
const ocrStatus = {
  available: true,
  installed: false,
  downloadBytes: 0,
  state: "idle",
};
const ocrRequests: ApplicationInvocation[] = [],
  ocrCancelled: string[] = [];
let holdOcr = false,
  acceptOcr: ((reply: ApplicationReply) => void) | undefined;
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
  const surface = deriveWorkSurface({
    state: client.boot?.workspace,
    principalId: client.boot?.principalId ?? "",
    teamAuthentication: client.boot?.capabilities.teamAuthentication ?? false,
    scriptLibrary: client.boot?.scriptLibrary ?? [],
    prefs: {
      view: "dialogue",
      projectId: "",
      projectOpen: false,
      artifactId: null,
    },
    contentScope: "",
    conversationDrafts: {},
    restoredPlace: null,
  });
  useLayoutEffect(() => {
    if (client.boot) publications.push(client.boot.csrfToken);
  });
  return (
    <>
      <p id="mounted-client">
        {client.boot?.principalId ?? client.error ?? "connecting"}
      </p>
      <ConversationHistoryNotice
        error={client.historyError}
        projectId={surface.conversationProjectId}
        conversationId={surface.conversationId}
        onRetry={() => void client.refresh()}
      />
    </>
  );
}
// Opt-in presentation fixture: real work-surface derivation and production
// notice, not a Host authorization or a second conversation-routing owner.
function HistoryNoticeScopes() {
  const state = initialWorkspace("2026-10-04T00:00:00.000Z");
  state.conversations.push({
    ...state.conversations[0]!,
    id: "TEST-named",
    projectId: "first-project",
  });
  const base = {
    state,
    principalId: "local-owner",
    teamAuthentication: false,
    scriptLibrary: [],
    contentScope: "",
    conversationDrafts: {},
    restoredPlace: null,
  };
  const shared = deriveWorkSurface({
    ...base,
    prefs: {
      view: "dialogue",
      projectId: "",
      projectOpen: false,
      artifactId: null,
    },
  });
  const named = deriveWorkSurface({
    ...base,
    prefs: {
      view: "projects",
      projectId: "first-project",
      projectOpen: true,
      artifactId: null,
      selectedConversations: { "first-project": "TEST-named" },
    },
  });
  const sharedError = {
    projectId: shared.conversationProjectId,
    conversationId: shared.conversationId,
    message: "TEST shared history unavailable",
  };
  const namedError = {
    projectId: named.conversationProjectId,
    conversationId: named.conversationId,
    message: "TEST named history unavailable",
  };
  const retry = () => {};
  return (
    <>
      <section
        data-testid="shared-history"
        data-content-owner={shared.project?.id}
        data-history-owner={shared.conversationProjectId}
      >
        <ConversationHistoryNotice
          error={sharedError}
          projectId={shared.conversationProjectId}
          conversationId={shared.conversationId}
          onRetry={retry}
        />
      </section>
      <section data-testid="wrong-content-owner">
        <ConversationHistoryNotice
          error={sharedError}
          projectId={shared.project?.id ?? ""}
          conversationId={shared.conversationId}
          onRetry={retry}
        />
      </section>
      <section
        data-testid="named-history"
        data-conversation={named.conversationId}
      >
        <ConversationHistoryNotice
          error={namedError}
          projectId={named.conversationProjectId}
          conversationId={named.conversationId}
          onRetry={retry}
        />
      </section>
      <section data-testid="wrong-named-history">
        <ConversationHistoryNotice
          error={namedError}
          projectId={named.conversationProjectId}
          conversationId="TEST-other"
          onRetry={retry}
        />
      </section>
      <section data-testid="revoked-history">
        <ConversationHistoryNotice
          error={null}
          projectId={named.conversationProjectId}
          conversationId={named.conversationId}
          onRetry={retry}
        />
      </section>
    </>
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
    // Checked against the actual class in its own browser realm, not inferred
    // from translated text or reconstructed by the Node test.
    unsentOperation: error instanceof UnsentOperationError,
  };
}
const allowed = new Set([
  "verifyArtifact",
  "taskRuntime",
  "taskResponses",
  "login",
  "logout",
  "refresh",
  "resolveArtifact",
  "readArtifactVersionPage",
  "resolveCatalogContent",
  "execute",
  "dispatchInput",
  "executionSnapshot",
  "executionResult",
  "cancelInput",
  "controlExecution",
  "approvalSubmitted",
  "bookmarkCommand",
  "bookmarkList",
  "listObjectAnnotations",
  "workRelationsFor",
  "readingContents",
  "readReading",
  "readingMarks",
  "readingState",
  "readingOcr",
  "readerCommand",
  "importReading",
  "getScriptEditor",
  "readScriptEditor",
  "readScriptVersion",
  "readScriptVersionTitle",
  "scriptVersionTitle",
  "resolveScriptLocation",
]);
const api = {
  construction,
  async call(name: string, args: unknown[], slot?: string) {
    if (!allowed.has(name)) throw new Error("Unexpected Client method");
    try {
      const fn = Reflect.get(client, name) as (...values: unknown[]) => unknown;
      const deserialize = (value: unknown): unknown => {
        if (value && typeof value === "object" && "__fixtureFile" in value) {
          const file = value as {
            bytes: number[];
            name: string;
            type: string;
            lastModified: number;
          };
          return new File([new Uint8Array(file.bytes)], file.name, {
            type: file.type,
            lastModified: file.lastModified,
          });
        }
        if (value && typeof value === "object" && "__fixtureAbort" in value)
          return abortControllers.get(String(value.__fixtureAbort))!.signal;
        // Resolve cross-realm leaf handles without cloning the browser's
        // caller-owned containers: mutation-after-await tests must mutate the
        // exact object passed into the real Client, not a detached fixture copy.
        if (value && typeof value === "object") {
          for (const [key, item] of Object.entries(value))
            Reflect.set(value, key, deserialize(item));
        }
        return value;
      };
      const values = args.map(deserialize);
      const value = await fn(...values);
      if (slot) slots.set(slot, value);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: errorValue(error) };
    }
  },
  async platform(name: string, args: unknown[]) {
    if (!["reviseDocument", "createDocument", "annotateObject"].includes(name))
      throw new Error("Unexpected fixture Platform method");
    const platform = await PlatformClient.connect({ call: applicationCall });
    return Reflect.apply(Reflect.get(platform, name), platform, args);
  },
  start(name: string, args: unknown[], slot?: string) {
    const id = "pending-" + ++sequence;
    pending.set(id, api.call(name, args, slot));
    return id;
  },
  startWithArgs(name: string, args: unknown[], argumentSlot: string) {
    slots.set(argumentSlot, args);
    return api.start(name, args);
  },
  mutateArgument(slot: string, index: number, key: string, value: unknown) {
    const args = slots.get(slot) as object[];
    Reflect.set(args[index]!, key, value);
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
  sameNestedResult(left: string, key: string, right: string) {
    return Reflect.get(slots.get(left) as object, key) === slots.get(right);
  },
  editorMatches(productionId: string, slot: string, field?: string) {
    const expected = slots.get(slot);
    return (
      client.getScriptEditor(productionId) ===
      (field ? Reflect.get(expected as object, field) : expected)
    );
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
  abortController(aborted: boolean) {
    const id = "abort-" + ++sequence;
    const controller = new AbortController();
    if (aborted) controller.abort();
    abortControllers.set(id, controller);
    return id;
  },
  abort(id: string) {
    abortControllers.get(id)?.abort();
  },
  forgetAbort(id: string) {
    abortControllers.delete(id);
  },
  ocrInstall(enabled: boolean, hold = false) {
    holdOcr = hold;
    slots.set("ocr-status", ocrStatus);
    if (!enabled) {
      Reflect.deleteProperty(window, "morphzDesktop");
      return;
    }
    Reflect.set(window, "morphzDesktop", {
      application: {
        async invoke(
          request: ApplicationInvocation,
        ): Promise<ApplicationReply> {
          if (request.method !== "reader.ocr")
            throw Error(
              "Only controlled OCR is allowed on this fixture bridge",
            );
          ocrRequests.push(request);
          if (holdOcr)
            return new Promise((resolve) => {
              acceptOcr = resolve;
            });
          return { ok: true, value: ocrStatus };
        },
        cancel(id: string) {
          ocrCancelled.push(id);
        },
      },
    });
  },
  ocrReport() {
    return {
      requests: ocrRequests,
      cancelled: ocrCancelled,
      status: ocrStatus,
    };
  },
  ocrResolve() {
    if (!acceptOcr) throw Error("No pending controlled OCR request");
    acceptOcr({ ok: true, value: ocrStatus });
    acceptOcr = undefined;
  },
  saved(scope: string) {
    return readSavedInputs(localStorage, scope);
  },
  storage() {
    return Object.fromEntries(
      Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
    );
  },
  bookmarkKey(digest: string) {
    const identity = client.getSnapshot()!;
    return (
      `morphz:${identity.centerId}:${identity.principalId}:${identity.actantId}:` +
      draftKey("pending:bookmark:" + digest)
    );
  },
  failStorageClear(enabled: boolean) {
    failStorageClear = enabled;
    failStorageClearOnce = false;
    storageFailureMessage = "TEST success clear storage failure";
  },
  failNextClear() {
    failStorageClear = true;
    failStorageClearOnce = true;
    storageFailureMessage = "TEST committed pending clear failed";
  },
  interceptNext(path: string, status = 500) {
    if (replacedResponse)
      throw Error("A response replacement is already armed");
    replacedResponse = { path, status };
  },
  loseNext(path: string, message = "TEST lost authorized bookmark receipt") {
    if (lostResponsePath) throw Error("A response loss is already armed");
    lostResponsePath = path;
    lostResponseMessage = message;
  },
  reads() {
    return requests;
  },
  clearReads() {
    requests.length = 0;
  },
  hold(path: string, matcherName?: string) {
    if (armed) throw new Error("A preceding response hold was not reached");
    const id = "hold-" + ++sequence;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    holds.set(id, {
      path,
      matcherName,
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
  historyNoticeScopes() {
    flushSync(() => root!.render(<HistoryNoticeScopes />));
  },
  report() {
    return {
      snapshot: client.getSnapshot(),
      error: client.error,
      historyError: client.historyError,
      publications,
      mounted: !!root,
      networkPending,
      networkSettledAt,
    };
  },
  cleanup() {
    for (const hold of holds.values()) hold.release();
    unmount();
  },
};
Reflect.set(window, "actualMountedClient", api);
