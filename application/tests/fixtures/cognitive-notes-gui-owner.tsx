/** Isolated trusted Chromium owner, not App.tsx/native UI acceptance.
 * Real public transport/consumer/original locator/compose/draft publication;
 * the private mount incarnation and unsent fixture draft are controlled here.
 * openObject deliberately refuses: production navigation hand-off is not yet
 * wired, and keeping an old application warm is not an opened ACK witness.
 */
import React, { StrictMode, useEffect, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { applicationCall } from "../../apps/web/src/application-transport.js";
import type { WorkspaceClient } from "../../apps/web/src/client.js";
import type { PlatformBoot } from "../../apps/web/src/platform-client.js";
import { createCognitiveDocumentConsumer } from "../../apps/web/src/host/cognitive-document-consumer.js";
import { createCognitiveObjectOwner } from "../../apps/web/src/host/cognitive-object-owner.js";
import { createCognitiveComposePreparation } from "../../apps/web/src/host/cognitive-compose-preparation.js";
import { cognitiveWorkSurfaceKey } from "../../apps/web/src/host/work-surface.js";
import {
  useWorkspaceNavigationHost,
  NavigationHostLifetime,
  useWorkspaceNavigationOrigin,
  NavigationOriginLifetime,
} from "../../apps/web/src/host/use-workspace-navigation-host.js";
import {
  useExchangeInputDraftState,
  useExchangeConversationDraftState,
  useExchangeDiscardedDraftState,
  createExchangeDraftCommands,
  type InputDraft,
} from "../../apps/web/src/host/exchange-drafts.js";
import {
  draftKey,
  scopedStorage,
  requirePersistentDraftOwner,
} from "../../apps/web/src/local-preferences.js";
import { parseCognitiveAppViewResponse } from "../../packages/core/src/cognitive-app-view-api.js";
import type { TextQuote } from "../../packages/core/src/text-quotes.js";

const settings = await Reflect.get(window, "notesGuiSettings")();
if (settings.adapter !== "Web")
  Reflect.set(window, "morphzDesktop", {
    application: {
      invoke: (request: unknown) =>
        Reflect.get(window, "notesGuiInvoke")(request),
      cancel: (id: string) => {
        void Reflect.get(window, "notesGuiCancel")(id);
      },
    },
  });
const boot = (await applicationCall("platform.bootstrap")) as PlatformBoot;
const projects = await applicationCall("projects.list", {});
const read = parseCognitiveAppViewResponse(
  "read",
  await applicationCall("cognitive-app-views.read", {
    viewId: settings.viewId,
  }),
);
const source = parseCognitiveAppViewResponse(
  "readUi",
  await applicationCall("cognitive-app-views.read-ui", {
    viewId: read.view.id,
    expectedViewRevision: read.view.revision,
    expectedBindingRevision: read.binding.revision,
  }),
);
// This projection carries actual boot/projects only for the production hooks'
// current-owner guards. It is not a synthesized full workspace or app snapshot.
const projection = {
  ...boot,
  workspace: { projects },
} as unknown as NonNullable<ReturnType<WorkspaceClient["getSnapshot"]>>;
const draftOwner = requirePersistentDraftOwner();
const surface = {
  kind: "view" as const,
  projectId: source.binding.projectId,
  viewId: source.view.id,
  connectionId: source.binding.connectionId,
  authority: source.authority,
};
const key =
  source.binding.projectId +
  ":" +
  draftOwner +
  ":cognitive:" +
  cognitiveWorkSurfaceKey(surface);
const scope = {
  key,
  surface,
  viewRevision: source.view.revision,
  bindingRevision: source.binding.revision,
};
const storage = scopedStorage(`${boot.centerId}:${boot.principalId}`);
const empty: InputDraft = { body: "", selection: "", revision: null };
const quote: TextQuote = {
  id: "a546c188-411e-48f0-b124-cdc574bb49f8",
  source: {
    kind: "surface",
    projectId: source.binding.projectId,
    title: "原引用",
  },
  text: "保留原引用",
  comment: "原评论",
};
const initial: InputDraft = {
  ...empty,
  body: "原草稿\n原换行",
  model: "fixture-selected-model",
  reasoningEffort: "max",
  attachments: [
    { assetId: "f".repeat(64), name: "未发送附件.txt", mime: "text/plain" },
  ],
};
storage.writeLocal(draftKey("inputs"), {
  [key]: initial,
  [source.binding.projectId + ":quotes"]: { ...empty, textQuotes: [quote] },
  unrelated: { ...empty, body: "另一草稿" },
});
let alive = true,
  mounted = false,
  holdLocator = false,
  releaseLocator: (() => void) | undefined;
let published: Record<string, InputDraft> = {},
  rendered: Record<string, InputDraft> = {};
let currentUi = source;
const report = {
  ready: false,
  prepared: 0,
  retired: 0,
  held: 0,
  refused: [] as string[],
  calls: [] as {
    method: string;
    params: unknown;
    ok: boolean;
    code?: string;
  }[],
};
let latest!: () => void, retire!: () => void;

function Frame() {
  const host = useWorkspaceNavigationHost({
    identity: boot,
    getSnapshot: () => (alive ? projection : null),
  });
  const origin = useWorkspaceNavigationOrigin(host);
  const inputs = useExchangeInputDraftState(storage);
  const conversations = useExchangeConversationDraftState(storage);
  const discarded = useExchangeDiscardedDraftState(storage);
  const commands = createExchangeDraftCommands({
    inputs,
    conversations,
    discarded,
    storage,
    onNotice: () => {},
  });
  const container = useRef<HTMLElement>(null);
  const persistentCurrent = () => {
    try {
      return (
        alive &&
        origin.isActive() &&
        requirePersistentDraftOwner() === draftOwner
      );
    } catch {
      return false;
    }
  };
  const call: typeof applicationCall = async (method, params, options) => {
    try {
      const value = await applicationCall(method, params, {
        ...options,
        identityGeneration: boot.csrfToken,
      });
      if (method === "cognitive-app-views.read-ui")
        currentUi = parseCognitiveAppViewResponse("readUi", value);
      report.calls.push({ method, params: structuredClone(params), ok: true });
      return value;
    } catch (error) {
      report.calls.push({
        method,
        params: structuredClone(params),
        ok: false,
        code:
          error && typeof error === "object"
            ? String(Reflect.get(error, "code"))
            : undefined,
      });
      throw error;
    }
  };
  const owner = createCognitiveObjectOwner({ call });
  const compose = createCognitiveComposePreparation({
    captureScope(value) {
      if (!persistentCurrent()) return null;
      const premises = JSON.stringify([
        value.view,
        value.binding,
        value.authority,
        value.grantRevision,
        value.connectionRevision,
      ]);
      const matches = () =>
        premises ===
        JSON.stringify([
          currentUi.view,
          currentUi.binding,
          currentUi.authority,
          currentUi.grantRevision,
          currentUi.connectionRevision,
        ]);
      if (!matches()) return null;
      const incarnation = origin.capturePrivateCommit();
      return {
        scope: {
          ...scope,
          viewRevision: value.view.revision,
          bindingRevision: value.binding.revision,
        },
        isCurrent: () =>
          persistentCurrent() && incarnation(projection) && matches(),
      };
    },
    async locatorForView(value, object, signal) {
      const locator = await owner.locatorForView(value, object, signal);
      if (holdLocator) {
        report.held++;
        await new Promise<void>((done) => (releaseLocator = done));
      }
      return locator;
    },
    writeInputs: commands.writeInputs,
    flushSync,
    publishedDraft: (current) => published[current],
    emptyDraft: empty,
    onPrepared() {
      report.prepared++;
    },
  });
  rendered = inputs.value;
  useLayoutEffect(() => {
    published = inputs.value;
  });
  latest = () =>
    flushSync(() =>
      commands.writeInputs((previous) => ({
        ...previous,
        [key]: {
          ...previous[key]!,
          body: "实际最新草稿\n第二行",
          model: "latest-fixture-model",
          reasoningEffort: "high",
        },
      })),
    );
  retire = () => {
    alive = false;
    origin.retire();
  };
  useEffect(() => {
    mounted = true;
    const controller = new AbortController();
    const consumer = createCognitiveDocumentConsumer({
      source,
      container: container.current!,
      routerPorts: {
        call,
        async compose(request, signal) {
          try {
            return await compose(request, signal);
          } catch (error) {
            report.refused.push(
              error && typeof error === "object"
                ? String(Reflect.get(error, "code"))
                : "unavailable",
            );
            throw error;
          }
        },
        async openObject() {
          throw Object.assign(
            new Error("Production navigation hand-off not yet connected."),
            { code: "unavailable" },
          );
        },
      },
      current: persistentCurrent,
      signal: controller.signal,
      presentation: {
        active: true,
        theme: { appearance: "light", accent: "iris" },
        presentation: { mode: "workspace", returnControl: null },
      },
      onRetire: () => report.retired++,
    });
    consumer.ready.then((value) => {
      if (value) report.ready = true;
    });
    return () => {
      mounted = false;
      controller.abort();
      consumer.retire();
    };
  }, []);
  return (
    <>
      <NavigationHostLifetime host={host} />
      <NavigationOriginLifetime origin={origin} />
      <section ref={container} id="application" />
      <textarea
        id="unsent-input"
        readOnly
        value={inputs.value[key]?.body ?? ""}
      />
      <output id="input-model">{inputs.value[key]?.model}</output>
    </>
  );
}
const root = createRoot(document.getElementById("root")!);
flushSync(() =>
  root.render(
    <StrictMode>
      <Frame />
    </StrictMode>,
  ),
);
Reflect.set(window, "notesGuiOwner", {
  get ready() {
    return report.ready;
  },
  snapshot() {
    return {
      ...structuredClone(report),
      key,
      source,
      boot,
      mounted,
      rendered,
      published,
      stored: storage.readLocal(draftKey("inputs"), {}),
      input:
        document.getElementById("unsent-input") instanceof HTMLTextAreaElement
          ? (document.getElementById("unsent-input") as HTMLTextAreaElement)
              .value
          : null,
    };
  },
  latest: () => latest(),
  retire: () => retire(),
  holdLocator() {
    holdLocator = true;
  },
  releaseLocator() {
    holdLocator = false;
    if (!releaseLocator)
      throw Error("Actual locator has not reached owner barrier.");
    releaseLocator();
    releaseLocator = undefined;
  },
  rotateWindowOwner() {
    sessionStorage.clear();
  },
  unmount() {
    flushSync(() => root.unmount());
  },
});
