import React, { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CognitiveDocumentView } from "../../apps/web/src/features/applications/CognitiveDocumentView.js";
import type { CognitiveAppViewUi } from "../../packages/core/src/cognitive-app-view-api.js";
import type { CognitiveBrowserRouterPorts } from "../../apps/web/src/host/cognitive-browser-router.js";
import type { CognitiveDocumentPresentation } from "../../apps/web/src/host/cognitive-document-consumer.js";

// Actual React StrictMode, accepted consumer, native Chromium ports, SDK and
// authenticated fixed resource. Parent publication and owner invalidation are
// controlled real React commits, not the production App's private owner.
declare global {
  interface Window {
    documentViewSource(): Promise<CognitiveAppViewUi>;
    documentViewCall(
      id: string,
      method: string,
      parameters: unknown,
    ): Promise<unknown>;
    documentViewAbort(id: string): Promise<void>;
    documentViewSettings: { initiallyValid?: boolean; holdAuthorize?: boolean };
    documentViewFixture: ReturnType<typeof controls>;
  }
}

const records = { draft: "原草稿 😀", preferences: "原应用现场" };
for (const [key, value] of Object.entries(records))
  localStorage.setItem("document-view-" + key, value);
const initialSource = await window.documentViewSource();
const ownerValidity = new Map<string, boolean>([
  ["owner-1", window.documentViewSettings.initiallyValid !== false],
]);
let publishedOwner: string | null = null;
let visible = true;
let holdAuthorize = window.documentViewSettings.holdAuthorize ?? false;
let serial = 1;
let storedFrame: HTMLIFrameElement | null = null;
const calls: Array<{
  method: string;
  parameters: unknown;
  aborted: boolean;
  done: boolean;
}> = [];
const guards: Array<{ captured: string; published: string | null }> = [];
const publications: string[] = [];
const authorEvents: Array<{ proof: string; event: unknown }> = [];
window.addEventListener("message", (event) => {
  if (event.data?.kind !== "document-view-author-observation") return;
  const outer = document.querySelector<HTMLIFrameElement>(
    ".cognitive-document-container>iframe",
  );
  const guest = outer?.contentDocument?.querySelector("iframe");
  // Test observation only, never authority/RPC. Ignore a retiring Document's
  // notification; the current DOM Window relationship is the positive control.
  if (!outer || !guest || event.source !== guest.contentWindow) return;
  authorEvents.push({
    proof: new URL(outer.src).searchParams.get("documentProof")!,
    event: structuredClone(event.data),
  });
});
const waiting: Array<() => void> = [];
const actions = { retry: 0, close: 0, abort: 0 };
type Config = {
  source: CognitiveAppViewUi | null;
  owner: string;
  status: "ready" | "loading" | "absent" | "closed" | "unbound" | "error";
  presentation: CognitiveDocumentPresentation;
  replaceGuard: boolean;
};
let changeConfig!: (change: Partial<Config>) => void;
let setVisible!: (value: boolean) => void;
let configValue: Config;
const ports: CognitiveBrowserRouterPorts = {
  async call(method, parameters, options) {
    const item = {
      method,
      parameters: structuredClone(parameters),
      aborted: false,
      done: false,
    };
    calls.push(item);
    const id = crypto.randomUUID();
    const abort = () => {
      item.aborted = true;
      actions.abort++;
      void window.documentViewAbort(id);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (method === "cognitive-app-views.read-ui" && holdAuthorize)
        await new Promise<void>((resolve) => waiting.push(resolve));
      return await window.documentViewCall(id, method, parameters);
    } finally {
      item.done = true;
      options.signal?.removeEventListener("abort", abort);
    }
  },
  // No business/object/draft owner is implemented in this isolated shell.
  async compose() {
    throw { code: "unavailable" };
  },
  async openObject() {
    throw { code: "unavailable" };
  },
};
function Parent() {
  const [config, setConfig] = useState<Config>({
    source: initialSource,
    owner: "owner-1",
    status: "ready",
    presentation: {
      theme: { appearance: "dark", accent: "cyan" },
      presentation: { mode: "workspace", returnControl: null },
      active: true,
    },
    replaceGuard: false,
  });
  const [shown, show] = useState(true);
  configValue = config;
  changeConfig = (change) => setConfig((old) => ({ ...old, ...change }));
  setVisible = show;
  // React runs this parent's layout after child layout. The new component's
  // initial consumer must therefore be created in passive effect, not layout.
  useLayoutEffect(() => {
    publishedOwner = config.owner;
    publications.push(config.owner);
  });
  const capturedOwner = config.owner;
  const current = config.replaceGuard
    ? () => true
    : () => {
        guards.push({ captured: capturedOwner, published: publishedOwner });
        return (
          publishedOwner === capturedOwner &&
          ownerValidity.get(capturedOwner) === true
        );
      };
  return (
    <div className="primary-panel" style={{ height: 600, width: 1000 }}>
      <main className="application-canvas">
        <div className="object-surface">
          {shown && (
            <CognitiveDocumentView
              source={config.source}
              mountKey={config.owner}
              status={config.status}
              message={
                config.status === "ready"
                  ? ""
                  : "真实窗口当前为 " + config.status
              }
              current={current}
              routerPorts={ports}
              presentation={config.presentation}
              onRetry={() => actions.retry++}
              onClose={() => actions.close++}
            />
          )}
        </div>
      </main>
    </div>
  );
}
const root = createRoot(document.getElementById("mount")!);
function controls() {
  return {
    report() {
      const frames = [
        ...document.querySelectorAll<HTMLIFrameElement>(
          ".cognitive-document-container>iframe",
        ),
      ];
      return {
        calls,
        guards,
        publications,
        authorEvents,
        actions,
        visible,
        frames: frames.map((frame) => ({
          src: frame.src,
          className: frame.className,
          title: frame.title,
        })),
        sameFrame: frames.length === 1 && frames[0] === storedFrame,
        status:
          document.querySelector("[role=status], [role=alert]")?.textContent ??
          null,
        records: Object.fromEntries(
          Object.keys(records).map((key) => [
            key,
            localStorage.getItem("document-view-" + key),
          ]),
        ),
      };
    },
    captureFrame() {
      storedFrame = document.querySelector(
        ".cognitive-document-container>iframe",
      );
    },
    presentation(presentation: CognitiveDocumentPresentation) {
      flushSync(() => changeConfig({ presentation }));
    },
    rerender() {
      flushSync(() => changeConfig({ replaceGuard: configValue.replaceGuard }));
    },
    invalidate(replaceGuard = false) {
      ownerValidity.set(configValue.owner, false);
      flushSync(() => changeConfig({ replaceGuard }));
      return document.querySelectorAll(".cognitive-document-container>iframe")
        .length;
    },
    async replaceSource() {
      const latest = (await window.documentViewCall(
        crypto.randomUUID(),
        "cognitive-app-views.read-ui",
        {
          viewId: initialSource.view.id,
          expectedViewRevision: 2,
          expectedBindingRevision: initialSource.binding.revision,
        },
      )) as CognitiveAppViewUi;
      const owner = "owner-" + ++serial;
      ownerValidity.set(owner, true);
      flushSync(() =>
        changeConfig({ source: latest, owner, replaceGuard: false }),
      );
    },
    status(status: Config["status"]) {
      flushSync(() =>
        changeConfig({
          status,
          source: status === "ready" ? initialSource : null,
        }),
      );
    },
    unmount() {
      visible = false;
      flushSync(() => setVisible(false));
      return document.querySelectorAll("iframe").length;
    },
    release() {
      holdAuthorize = false;
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}
window.documentViewFixture = controls();
flushSync(() =>
  root.render(
    <StrictMode>
      <Parent />
    </StrictMode>,
  ),
);
