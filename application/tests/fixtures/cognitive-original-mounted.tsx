import React, { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useCognitiveOriginal } from "../../apps/web/src/host/use-cognitive-original.js";
import { parseCognitiveAppObjectLocator } from "../../packages/core/src/cognitive-app-object-locator.js";
import { CognitiveOriginalView } from "../../apps/web/src/CognitiveOriginalView.js";
import { initialWorkspace } from "../../packages/core/src/model.js";

// Controlled current-Human read ports, real React/DOM lifecycle. These replies
// do not constitute SQL, HPA, independent author network or original-App proof.
const authority = {
  appId: "author.notes",
  version: "1.0.0",
  definitionHash: "a".repeat(64),
  instanceId: "author_instance",
  serviceId: "author/service",
  dataAuthorityId: "author/data",
};
const identity = {
  centerId: "center",
  principalId: "human",
  csrfToken: "session",
};
function locator(
  versionRef = "000900719925474099312345:旧😀\n",
  objectId = "原件/ 😀\n",
) {
  return parseCognitiveAppObjectLocator({
    contentId: "catalog_original",
    projectId: "project_original",
    connectionId: "connection_original",
    authority,
    object: { objectId, versionRef },
  });
}
const first = locator();
let reads: Array<{ method: string; parameters: any; signal: AbortSignal }> = [];
let pending: Array<{
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  parameters: any;
  signal: AbortSignal;
}> = [];
let commits: unknown[] = [];
let controls: any;
let mounted: any;
let explicit: any;
let serial = 0;
let ignoreCancellation = true;
let monotonicOffset = 0;
const nativeNow = performance.now.bind(performance);
Object.defineProperty(performance, "now", {
  value: () => nativeNow() + monotonicOffset,
});
let clockTimers: Array<{ callback: () => void; ms: number; live: boolean }> =
  [];
const nativeTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);
// The production deadline duration is kept intact. Only its scheduler is
// controlled; the mounted hook and AbortController remain production code.
window.setTimeout = ((
  callback: TimerHandler,
  ms?: number,
  ...args: unknown[]
) => {
  if (ms === 30_000 && typeof callback === "function") {
    const item = { callback: () => callback(...args), ms, live: true };
    clockTimers.push(item);
    return -clockTimers.length;
  }
  return nativeTimeout(callback, ms, ...args);
}) as typeof window.setTimeout;
window.clearTimeout = ((id?: number) => {
  if (id && id < 0) {
    const item = clockTimers[-id - 1];
    if (item) item.live = false;
  } else nativeClearTimeout(id);
}) as typeof window.clearTimeout;
const call = async (
  method: string,
  parameters: any,
  { signal }: { signal: AbortSignal },
) => {
  const input = structuredClone(parameters);
  reads.push({ method, parameters: input, signal });
  if (method === "content.get")
    return {
      id: "catalog_original",
      projectId: "project_original",
      appId: authority.appId,
      instanceId: authority.instanceId,
      appObjectId: mounted.config.objectId ?? first.object.objectId,
      kind: "note",
      title: "Current catalog title",
      observedVersionRef: "LATEST_HEAD_NOT_REQUESTED",
      providerRevision: 1,
      availability: "available",
      revision: 1,
      createdAt: "2026-10-05T00:00:00Z",
      updatedAt: "2026-10-05T00:00:00Z",
    };
  if (method !== "cognitive-apps.read-object")
    throw Error("unexpected method " + method);
  return new Promise((resolve, reject) => {
    pending.push({ resolve, reject, parameters: input, signal });
    if (!ignoreCancellation)
      signal.addEventListener("abort", () => reject(Error("cancelled")), {
        once: true,
      });
  });
};
function Reader({ config }: { config: any }) {
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const value = useCognitiveOriginal({
    location: config.location,
    identity: config.identity,
    navigationEpoch: config.epoch,
    isCurrent: () => config.valid,
    call,
  });
  mounted = { ...mounted, config, value };
  const report = {
    scope: config.identity,
    epoch: config.epoch,
    blocked: value.blocked,
    requested: value.requested,
    message: value.message,
    body: value.value?.original.content,
    version: value.value?.locator.object.versionRef ?? null,
  };
  useLayoutEffect(() => {
    commits.push(report);
  });
  return (
    <>
      <header id="toolbar" ref={setToolbar} />
      <output id="state">{JSON.stringify(report)}</output>
      <CognitiveOriginalView
        original={value.value}
        message={value.message}
        onRetry={value.reload}
        toolbarTarget={toolbar}
        state={initialWorkspace("2026-10-05T00:00:00Z")}
        onOpen={(id) => {
          throw Error("unexpected builtin navigation " + id);
        }}
      />
    </>
  );
}
const root = createRoot(document.getElementById("root")!);
function Fixture({ initial }: { initial: any }) {
  const [config, setConfig] = useState({
    identity,
    epoch: 1,
    valid: true,
    location: { kind: "original", locator: first },
    ...initial,
  });
  const [visible, setVisible] = useState(true);
  controls = {
    config(value: any) {
      setConfig((old: any) => ({ ...old, ...value }));
    },
    mount(value: boolean) {
      setVisible(value);
    },
  };
  return <main>{visible && <Reader config={config} />}</main>;
}
function reset(initial = {}) {
  monotonicOffset = 0;
  reads = [];
  pending = [];
  commits = [];
  explicit = null;
  clockTimers = [];
  flushSync(() =>
    root.render(
      <StrictMode>
        <Fixture key={++serial} initial={initial} />
      </StrictMode>,
    ),
  );
}
function report() {
  return {
    state: document.querySelector("#state")
      ? JSON.parse(document.querySelector("#state")!.textContent!)
      : null,
    dom: {
      text: document.querySelector("article")?.textContent ?? null,
      rendered: document.querySelector(".document-body")?.innerHTML ?? null,
      toolbar: document.querySelector("#toolbar")?.textContent ?? null,
      lineBreaks: document.querySelectorAll(".document-body br").length,
      images: document.querySelectorAll(".document-body img").length,
      scripts: document.querySelectorAll(".document-body script").length,
      inputs: document.querySelectorAll("article input,article textarea")
        .length,
      artifactQuotes: document.querySelectorAll("[data-artifact-id]").length,
      ran: Reflect.get(window, "originalInjected") ?? null,
    },
    reads: reads.map(({ method, parameters, signal }) => ({
      method,
      parameters,
      aborted: signal.aborted,
    })),
    pending: pending.map(({ signal, parameters }) => ({
      aborted: signal.aborted,
      parameters,
    })),
    commits,
    timers: clockTimers.map(({ ms, live }) => ({ ms, live })),
  };
}
Object.assign(window, {
  cognitiveOriginalFixture: {
    reset,
    report,
    locator,
    config(value: any) {
      flushSync(() => controls.config(value));
    },
    mount(value: boolean) {
      flushSync(() => controls.mount(value));
    },
    settle(index: number, text = "PINNED_V1_PRIVATE", format = "markdown") {
      const p = pending[index];
      if (!p) throw Error("missing pending original " + index);
      p.resolve({
        protocol: "morphz-domain/v1",
        authority,
        object: p.parameters.object,
        kind: "note",
        title: "Historical original title",
        content:
          format === "json"
            ? { format, value: JSON.parse(text) }
            : { format, text },
      });
    },
    fail(index: number, message = "READ_DENIED") {
      pending[index].reject(Error(message));
    },
    retry() {
      flushSync(() => mounted.value.reload());
    },
    explicitRead() {
      const captured = mounted.value;
      const abort = new AbortController();
      explicit = { captured, abort, value: null, error: null };
      void captured.readOriginal(first, abort.signal).then(
        (value: unknown) => {
          explicit.value = value;
        },
        (error: Error) => {
          explicit.error = error.message;
        },
      );
    },
    explicitStatus() {
      return { value: !!explicit?.value, error: explicit?.error ?? null };
    },
    cancelExplicit() {
      explicit.abort.abort();
    },
    explicitReadAlreadyCancelled() {
      const captured = mounted.value;
      const abort = new AbortController();
      abort.abort();
      explicit = { captured, abort, value: null, error: null };
      void captured.readOriginal(first, abort.signal).then(
        (value: unknown) => {
          explicit.value = value;
        },
        (error: Error) => {
          explicit.error = error.message;
        },
      );
    },
    adopt(epoch: number, oldClosure = false) {
      const owner = oldClosure ? explicit.captured : mounted.value;
      flushSync(() => owner.adopt(explicit.value, epoch));
    },
    deadline() {
      for (const timer of clockTimers)
        if (timer.live) {
          timer.live = false;
          timer.callback();
        }
    },
    latest() {
      return {
        kind: "original",
        locator: locator("LATEST_HEAD_NOT_REQUESTED"),
      };
    },
    forgedAdopt(epoch: number) {
      flushSync(() =>
        mounted.value.adopt(structuredClone(explicit.value), epoch),
      );
    },
    elapseWithoutTimer(ms: number) {
      monotonicOffset += ms;
    },
  },
});
reset();
