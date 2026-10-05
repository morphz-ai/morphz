import React, { StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  useExchangeInputDraftState,
  useExchangeConversationDraftState,
  useExchangeDiscardedDraftState,
  createExchangeDraftCommands,
  type InputDraft,
} from "../../apps/web/src/host/exchange-drafts.js";
import { createCognitiveComposePreparation } from "../../apps/web/src/host/cognitive-compose-preparation.js";
import {
  NavigationOriginLifetime,
  useWorkspaceNavigationOrigin,
} from "../../apps/web/src/host/use-workspace-navigation-host.js";
import {
  scopedStorage,
  draftKey,
} from "../../apps/web/src/local-preferences.js";
import {
  composeSource,
  composeScope,
  composeLocator,
  composeDraft,
  composeEmpty,
  composeQuote,
} from "./cognitive-compose-data.js";

// Actual StrictMode/public writer/scopedStorage/flushSync/layout publication
// and private-origin incarnation. Host policy/view metadata/locator are controlled;
// not actual SQL/GUI owner, authors' networking or original user App acceptance.
const storage = scopedStorage("cognitive-compose:isolated-human");
const key = composeScope().key;
storage.writeLocal(draftKey("inputs"), {
  [key]: composeDraft(),
  "conversation:quotes": { ...composeEmpty, textQuotes: [composeQuote] },
  other: { ...composeEmpty, body: "另一工作面" },
});
let alive = true,
  failStorage = false,
  mode = "normal",
  scope = composeScope();
let release: (() => void) | undefined;
let published: Record<string, InputDraft> = {},
  rendered: Record<string, InputDraft> = {};
const events: unknown[][] = [];
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
function identity(value: object | undefined) {
  if (!value) return null;
  if (!identities.has(value)) identities.set(value, ++nextIdentity);
  return identities.get(value)!;
}
let run: (action: string) => Promise<unknown>;
function Frame() {
  const inputs = useExchangeInputDraftState(storage);
  const conversations = useExchangeConversationDraftState(storage);
  const discarded = useExchangeDiscardedDraftState(storage);
  const origin = useWorkspaceNavigationOrigin({ isCurrentHost: () => alive });
  const commands = createExchangeDraftCommands({
    inputs,
    conversations,
    discarded,
    storage: {
      readLocal: storage.readLocal,
      writeLocal(name, value) {
        events.push(["storage", name]);
        if (failStorage) throw Error("controlled storage failure");
        storage.writeLocal(name, value);
      },
    },
    onNotice: (message) => events.push(["notice", message]),
  });
  let queued: Parameters<typeof commands.writeInputs>[0] | undefined;
  const prepare = createCognitiveComposePreparation({
    captureScope() {
      const incarnation = origin.capturePrivateCommit(),
        original = structuredClone(scope);
      return {
        scope: original,
        isCurrent: () =>
          origin.isActive() &&
          incarnation(undefined as never) &&
          JSON.stringify(scope) === JSON.stringify(original),
      };
    },
    async locatorForView() {
      if (mode === "held") await new Promise<void>((done) => (release = done));
      return composeLocator();
    },
    writeInputs(update) {
      if (mode === "deferred") {
        queued = update;
        return;
      }
      if (mode === "updater-retired") origin.retire();
      commands.writeInputs((previous) => {
        const next = update(previous);
        events.push(["updater", identity(previous[key]), identity(next[key])]);
        return next;
      });
    },
    flushSync,
    publishedDraft: (current) => {
      events.push(["witness", identity(published[current])]);
      return mode === "no-witness" ? undefined : published[current];
    },
    emptyDraft: composeEmpty,
    onPrepared: (changed) => events.push(["prepared", changed]),
  });
  rendered = inputs.value;
  useLayoutEffect(() => {
    published = inputs.value;
    events.push([
      "commit",
      published[key]?.body ?? null,
      identity(published[key]),
    ]);
  });
  const editLatest = () =>
    flushSync(() =>
      commands.writeInputs((previous) => ({
        ...previous,
        [key]: {
          ...previous[key]!,
          body: "实际最新正文\n保留换行",
          model: "latest-model",
          reasoningEffort: "max",
        },
      })),
    );
  run = async (action) => {
    let before = published;
    const text = "请基于原文整理要点";
    const request = {
      source: composeSource(),
      text,
      object: structuredClone(composeLocator().object),
    };
    let result: unknown;
    try {
      if (action === "special-input" || action === "different-original") {
        flushSync(() =>
          commands.writeInputs((previous) => {
            const { "conversation:quotes": _quotes, ...rest } = previous;
            return {
              ...rest,
              [key]: {
                ...previous[key]!,
                ...(action === "special-input"
                  ? { taskResult: { taskId: "original-task", revision: 3 } }
                  : {
                      cognitiveObject: {
                        ...composeLocator(),
                        object: {
                          ...composeLocator().object,
                          versionRef: "different:V2",
                        },
                      },
                    }),
              },
            };
          }),
        );
        before = published;
        result = await prepare(request, new AbortController().signal);
      } else if (action === "latest") {
        // Prepare retains this render's writer, but its updater sees the real
        // later draft, not inputs.value captured in this old render.
        editLatest();
        result = await prepare(request, new AbortController().signal);
      } else if (action === "held-latest") {
        mode = "held";
        const work = prepare(request, new AbortController().signal);
        editLatest();
        request.text = "变异文本不应进草稿";
        request.object.versionRef = "wrong:V2";
        release!();
        result = await work;
      } else if (action === "retired-reactivated" || action === "unmounted") {
        mode = "held";
        const work = prepare(request, new AbortController().signal);
        if (action === "unmounted") flushSync(() => root.unmount());
        else {
          origin.retire();
          origin.activate();
        }
        release!();
        result = await work;
      } else if (action === "owner-cas-changed") {
        mode = "held";
        const work = prepare(request, new AbortController().signal);
        scope = { ...scope, bindingRevision: scope.bindingRevision + 1 };
        release!();
        result = await work;
      } else if (
        action === "updater-retired" ||
        action === "deferred" ||
        action === "no-witness"
      ) {
        mode = action;
        result = await prepare(request, new AbortController().signal);
      } else if (action === "storage-refusal") {
        failStorage = true;
        result = await prepare(request, new AbortController().signal);
      } else throw Error("Unknown bounded action");
    } catch (error) {
      events.push([
        "failure",
        String(error),
        error instanceof Error ? error.stack : null,
      ]);
      result = { error: Reflect.get(error as object, "code") ?? "unavailable" };
    }
    if (queued) flushSync(() => commands.writeInputs(queued!));
    return {
      result,
      before,
      drafts: rendered,
      published,
      stored: storage.readLocal(draftKey("inputs"), {}),
      events: [...events],
      key,
      active: origin.isActive(),
      inputBody:
        document.getElementById("input")?.getAttribute("data-body") ?? null,
    };
  };
  return (
    <>
      <NavigationOriginLifetime origin={origin} />
      <main>
        <textarea
          id="input"
          readOnly
          data-body={inputs.value[key]?.body ?? ""}
          value={inputs.value[key]?.body ?? ""}
        />
        <output>{inputs.value[key]?.model ?? ""}</output>
      </main>
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
Reflect.set(window, "cognitiveComposeFixture", {
  run: (action: string) => run(action),
  unmount: () => flushSync(() => root.unmount()),
});
