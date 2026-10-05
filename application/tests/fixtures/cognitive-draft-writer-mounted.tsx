import React, { StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  createExchangeDraftCommands,
  useExchangeInputDraftState,
  useExchangeConversationDraftState,
  useExchangeDiscardedDraftState,
  type InputDraft,
} from "../../apps/web/src/host/exchange-drafts.js";
import {
  createCognitiveDraftWriter,
  type CognitiveDraftWriterScope,
} from "../../apps/web/src/host/cognitive-draft-writer.js";
import { cognitiveWorkSurfaceKey } from "../../apps/web/src/host/work-surface.js";
import { parseCognitiveAppObjectLocator } from "../../packages/core/src/cognitive-app-object-locator.js";
import {
  replaceComposerSurface,
  updateComposerDraft,
  consumeComposerDraft,
} from "../../apps/web/src/composer-drafts.js";
import {
  scopedStorage,
  draftKey,
} from "../../apps/web/src/local-preferences.js";

// Actual React StrictMode + scopedStorage + public draft commands/writer.
// Owner facts/edits are controlled, not full App or Human/network/Runtime gates.
const empty: InputDraft = { body: "", selection: "", revision: null };
const locator = (versionRef = "opaque:V1") =>
  parseCognitiveAppObjectLocator({
    contentId: "content-one",
    projectId: "project-one",
    connectionId: "connection-one",
    authority: {
      appId: "author.notes",
      version: "1.0.0",
      definitionHash: "a".repeat(64),
      instanceId: "instance-one",
      serviceId: "service-one",
      dataAuthorityId: "authority-one",
    },
    object: { objectId: "opaque:对象", versionRef },
  });
const ownerScope = (versionRef = "opaque:V1"): CognitiveDraftWriterScope => {
  const surface = { kind: "original" as const, locator: locator(versionRef) };
  return {
    key: "conversation:cognitive:" + cognitiveWorkSurfaceKey(surface),
    surface,
  };
};
const inputKey = ownerScope().key;
const storage = scopedStorage("cognitive-draft-writer:isolated-human");
storage.writeLocal(draftKey("inputs"), {});
const events: unknown[][] = [];
let alive = true,
  failStorage = false;
let scope: CognitiveDraftWriterScope | null = ownerScope();
let last: Record<string, InputDraft> = {},
  rendered = 0;
let run: (action: string) => void;
function Frame() {
  const inputs = useExchangeInputDraftState(storage);
  const conversations = useExchangeConversationDraftState(storage);
  const discarded = useExchangeDiscardedDraftState(storage);
  const commands = createExchangeDraftCommands({
    inputs,
    conversations,
    discarded,
    storage: {
      readLocal: storage.readLocal,
      writeLocal(key: string, value: unknown) {
        events.push(["storage", key]);
        if (failStorage) throw Error("controlled localStorage failure");
        storage.writeLocal(key, value);
      },
    },
    onNotice: (message) => events.push(["notice", message]),
  });
  const writeDrafts = createCognitiveDraftWriter({
    writeInputs: commands.writeInputs,
    captureScope: () => scope,
    onError: (message) => events.push(["error", message]),
  });
  const drafts = inputs.value,
    emptyDraft = empty;
  const currentContext = useRef(inputKey);
  const dictationControls = useRef({
    interrupt() {
      events.push(["interrupt"]);
    },
  });
  const origin = { isActive: () => alive };
  // Exact current App guarded functions. Only their borrowed writer changes.
  function setDraft(key: string, value: InputDraft) {
    if (!origin.isActive()) return;
    if (key === currentContext.current && value.body !== drafts[key]?.body)
      dictationControls.current?.interrupt();
    writeDrafts((previous) =>
      replaceComposerSurface(previous, key, emptyDraft, value),
    );
  }
  function updateDraft(
    key: string,
    update: (value: InputDraft) => InputDraft,
    initial: InputDraft = emptyDraft,
  ) {
    if (!origin.isActive()) return;
    writeDrafts((previous) =>
      updateComposerDraft(previous, key, emptyDraft, update, initial),
    );
  }
  last = drafts;
  rendered++;
  run = (action) => {
    if (action === "first-and-reopen") {
      setDraft(inputKey, {
        ...empty,
        body: "V1 text",
        model: "user-model",
        reasoningEffort: "max",
      });
      // The first updater is queued; changing the actual source before flush
      // must not replace the captured V1 with the new V2.
      scope = ownerScope("opaque:V2");
      updateDraft(inputKey, (old) => ({
        ...old,
        body: old.body + "\nV2 continued",
      }));
    } else if (action === "attachment") {
      updateDraft(inputKey, (old) => ({
        ...old,
        attachments: [
          { assetId: "a".repeat(64), name: "file.txt", mime: "text/plain" },
        ],
      }));
    } else if (action === "refuse") {
      flushSync(() => setDraft(inputKey, { ...empty, body: "saved V1" }));
      updateDraft(inputKey, (old) => ({
        ...old,
        body: "must not commit",
        cognitiveObject: parseCognitiveAppObjectLocator({
          ...locator(),
          object: { objectId: "other-object", versionRef: "opaque:V2" },
        }),
      }));
    } else if (action === "cleanup") {
      flushSync(() =>
        setDraft(inputKey, { ...empty, body: "saved V1", model: "choice" }),
      );
      updateDraft(inputKey, (old) => consumeComposerDraft(old, empty));
    } else if (action === "storage-failure") {
      failStorage = true;
      setDraft(inputKey, { ...empty, body: "kept in React" });
    } else if (action === "retired") {
      alive = false;
      setDraft(inputKey, { ...empty, body: "must not write" });
      updateDraft(inputKey, (old) => ({
        ...old,
        body: "must not write either",
      }));
    } else if (action === "ordinary") {
      scope = null;
      setDraft("conversation:legacy", {
        ...empty,
        body: "legacy text",
        revision: 2,
        selection: "old builtin",
      });
    } else throw Error("Unknown bounded action");
  };
  return (
    <main>
      <textarea
        id="original-input"
        value={drafts[inputKey]?.body ?? ""}
        readOnly
      />
      <output id="state">{drafts[inputKey]?.body ?? ""}</output>
    </main>
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
const snapshot = () => ({
  drafts: last,
  stored: storage.readLocal(draftKey("inputs"), {}),
  events,
  rendered,
  key: inputKey,
});
Reflect.set(window, "cognitiveDraftWriterFixture", {
  run(action: string) {
    flushSync(() => run(action));
    return { returned: null, snapshot: snapshot() };
  },
  snapshot,
  unmount() {
    root.unmount();
  },
});
