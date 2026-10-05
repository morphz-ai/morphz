import React, { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  useCognitiveView,
  type CognitiveViewLease,
} from "../../apps/web/src/host/use-cognitive-view.js";
import { useCognitiveOriginal } from "../../apps/web/src/host/use-cognitive-original.js";
import type { CognitiveViewOwnerPorts } from "../../apps/web/src/host/cognitive-view-owner.js";
import { composeSource } from "./cognitive-compose-data.js";
import type { CognitiveNavigationLocation } from "../../apps/web/src/host/cognitive-navigation-location.js";
import type { NavigationIdentity } from "../../apps/web/src/host/use-workspace-navigation-host.js";

// Real Chromium/React StrictMode effects and AbortControllers; service replies
// and private current-owner callback are deliberately controlled. No App/HPA,
// SQL, package SHA, author SDK/execution, or production permission claim.
const identity = {
  centerId: "center",
  principalId: "human",
  csrfToken: "session",
};
const slot = {
  projectId: "project",
  appId: "example.notes",
  version: "1.1.0",
  expectedDefinitionHash: "a".repeat(64),
};
type Config = {
  identity: NavigationIdentity;
  location: CognitiveNavigationLocation | null;
  epoch: number;
  valid: boolean;
};
type Pending = {
  method: string;
  parameters: any;
  signal: AbortSignal;
  done: boolean;
  replySlot: typeof slot;
  resolve(value: unknown): void;
  reject(error: unknown): void;
};
let pending: Pending[] = [],
  commits: unknown[] = [],
  originalCalls: string[] = [];
let controls: {
  config(change: Partial<Config>): void;
  mount(visible: boolean): void;
};
let mounted: { config: Config; view: ReturnType<typeof useCognitiveView> };
let leases: Array<CognitiveViewLease | null> = [];
let savedReloads: Array<() => void> = [];
let serial = 0;
const byView = new Map<string, typeof slot>();
let offset = 0;
const nativeNow = performance.now.bind(performance);
Object.defineProperty(performance, "now", {
  value: () => nativeNow() + offset,
});
let timers: Array<{ callback(): void; live: boolean }> = [];
const nativeTimeout = window.setTimeout.bind(window),
  nativeClear = window.clearTimeout.bind(window);
// Only the scheduler/monotonic clock of the unchanged production 30s deadline
// is controlled; no sleeping and no fabricated publication callbacks.
window.setTimeout = ((
  callback: TimerHandler,
  ms?: number,
  ...args: unknown[]
) => {
  if (ms === 30_000 && typeof callback === "function") {
    timers.push({ callback: () => callback(...args), live: true });
    return -timers.length;
  }
  return nativeTimeout(callback, ms, ...args);
}) as typeof window.setTimeout;
window.clearTimeout = ((id?: number) => {
  if (id && id < 0) {
    if (timers[-id - 1]) timers[-id - 1]!.live = false;
  } else nativeClear(id);
}) as typeof window.clearTimeout;
const call: CognitiveViewOwnerPorts["call"] = (method, parameters, options) =>
  new Promise((resolve, reject) => {
    const input: any = structuredClone(parameters);
    const replySlot =
      method === "cognitive-app-views.locate"
        ? input
        : byView.get(input.viewId);
    if (!replySlot || !options.signal)
      throw Error("Missing controlled own read source");
    pending.push({
      method,
      parameters: input,
      signal: options.signal,
      replySlot: structuredClone(replySlot),
      done: false,
      resolve,
      reject,
    });
    // Ignore abort on purpose: the production reader/hook must discard late replies.
  });
function Reader({ config }: { config: Config }) {
  const view = useCognitiveView({
    location: config.location,
    identity: config.identity,
    navigationEpoch: config.epoch,
    isCurrent: () => config.valid,
    call,
  });
  const original = useCognitiveOriginal({
    location: config.location,
    identity: config.identity,
    navigationEpoch: config.epoch,
    isCurrent: () => config.valid,
    call: async (method) => {
      originalCalls.push(method);
      throw Error("Unexpected original read");
    },
  });
  mounted = { config, view };
  const state = {
    identity: config.identity,
    epoch: config.epoch,
    status: view.status,
    requested: view.requested,
    blocked: view.blocked,
    message: view.message,
    html:
      view.value?.manifest.ui.type === "sandbox"
        ? view.value.manifest.ui.html
        : null,
    viewId: view.value?.view.id ?? null,
    viewRevision: view.value?.view.revision ?? null,
    originalRequested: original.requested,
    originalBlocked: original.blocked,
  };
  useLayoutEffect(() => {
    commits.push(state);
  });
  return <output id="state">{JSON.stringify(state)}</output>;
}
function Fixture({ initial }: { initial: Partial<Config> }) {
  const [config, setConfig] = useState<Config>({
    identity,
    location: { kind: "view", slot },
    epoch: 1,
    valid: true,
    ...initial,
  });
  const [visible, setVisible] = useState(true);
  controls = {
    config: (change) => setConfig((old) => ({ ...old, ...change })),
    mount: setVisible,
  };
  return <main>{visible && <Reader config={config} />}</main>;
}
const root = createRoot(document.getElementById("root")!);
const records = {
  draft: JSON.stringify({
    body: "原草稿",
    model: "original",
    attachments: ["原附件"],
  }),
  prefs: JSON.stringify({ application: "builtin", location: "original" }),
};
localStorage.setItem("view-owner-original-draft", records.draft);
localStorage.setItem("view-owner-original-prefs", records.prefs);
function reset(initial: Partial<Config> = {}) {
  pending = [];
  commits = [];
  originalCalls = [];
  leases = [];
  savedReloads = [];
  timers = [];
  offset = 0;
  byView.clear();
  flushSync(() =>
    root.render(
      <StrictMode>
        <Fixture key={++serial} initial={initial} />
      </StrictMode>,
    ),
  );
}
function report() {
  const state = document.querySelector("#state")?.textContent;
  return {
    state: state ? JSON.parse(state) : null,
    commits,
    originalCalls,
    pending: pending.map((p, index) => ({
      index,
      method: p.method,
      parameters: p.parameters,
      done: p.done,
      aborted: p.signal.aborted,
    })),
    leases: leases.map((lease) =>
      lease
        ? {
            current: lease.isCurrent(),
            revision: lease.source.view.revision,
            bindingRevision: lease.source.binding.revision,
            surface: lease.surface,
          }
        : null,
    ),
    timers: timers.map((item) => ({ live: item.live })),
    records: {
      draft: localStorage.getItem("view-owner-original-draft"),
      prefs: localStorage.getItem("view-owner-original-prefs"),
    },
    initialRecords: records,
  };
}
function settle(index: number, status = "ready", label = "PRIVATE_INITIAL") {
  const p = pending[index];
  if (!p || p.done) throw Error("No pending read " + index);
  p.done = true;
  const s = p.replySlot;
  if (p.method === "cognitive-app-views.locate") {
    const viewId = "view_" + s.projectId;
    byView.set(viewId, s);
    p.resolve({
      slot: {
        projectId: s.projectId,
        appId: s.appId,
        version: s.version,
        definitionHash: s.expectedDefinitionHash,
      },
      view:
        status === "absent"
          ? null
          : {
              viewId,
              viewRevision: 2,
              status: status === "closed" ? "closed" : "open",
              binding:
                status === "unbound"
                  ? null
                  : {
                      bindingRevision: 3,
                      connectionId: "connection",
                      instanceId: "instance",
                      serviceId: "author/notes",
                      dataAuthorityId: "author/data",
                    },
            },
    });
  } else {
    const source = structuredClone(composeSource());
    source.view.id = source.binding.viewId = p.parameters.viewId;
    source.view.workspaceId = source.binding.projectId = s.projectId;
    source.view.revision = source.binding.viewRevision =
      p.parameters.expectedViewRevision;
    source.binding.revision = p.parameters.expectedBindingRevision;
    source.authority = {
      ...source.authority,
      definitionHash: s.expectedDefinitionHash,
    };
    source.manifest.ui = { type: "sandbox", html: label };
    p.resolve(source);
  }
}
Object.assign(window, {
  cognitiveViewFixture: {
    reset,
    report,
    slot,
    config: (change: Partial<Config>) =>
      flushSync(() => controls.config(change)),
    mount: (visible: boolean) => flushSync(() => controls.mount(visible)),
    settle,
    fail(index: number) {
      pending[index]!.done = true;
      pending[index]!.reject(Error("ACTUAL_CONTROLLED_READ_DENIED"));
    },
    retry: () => flushSync(() => mounted.view.reload()),
    saveReload() {
      savedReloads.push(mounted.view.reload);
    },
    oldReload(index: number) {
      flushSync(() => savedReloads[index]!());
    },
    expire() {
      offset += 30_001;
      for (const timer of [...timers]) if (timer.live) timer.callback();
    },
    advanceWithoutTimer() {
      offset += 30_001;
    },
    capture(revision?: number, change?: string) {
      const source = structuredClone(mounted.view.value!);
      if (revision !== undefined) {
        source.view.revision = source.binding.viewRevision = revision;
        source.view.state = { view: "saved" };
      }
      if (change === "binding") source.binding.revision++;
      if (change === "grant") source.grantRevision++;
      if (change === "connection") source.connectionRevision++;
      if (change === "authority")
        source.authority = {
          ...source.authority,
          definitionHash: "b".repeat(64),
        };
      leases.push(mounted.view.captureLease(source));
      return leases.length - 1;
    },
  },
});
reset();
