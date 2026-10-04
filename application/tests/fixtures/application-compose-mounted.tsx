import React, { StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createApplicationComposePreparation } from "../../apps/web/src/host/application-compose-preparation.js";
import { createFixedApplicationCompose } from "./application-compose-7c1aea5a.js";
import {
  useExchangeInputDraftState,
  useExchangeConversationDraftState,
  useExchangeDiscardedDraftState,
  createExchangeDraftCommands,
  type InputDraft,
} from "../../apps/web/src/host/exchange-drafts.js";
import {
  scopedStorage,
  draftKey,
} from "../../apps/web/src/local-preferences.js";
import { replaceComposerSurface } from "../../apps/web/src/composer-drafts.js";
import {
  artifact,
  catalog,
  empty,
  generation,
  production,
  quote,
} from "./application-compose-data.js";

// Real StrictMode + real flushSync + the actual scoped draft writer/storage.
// Inputs/navigation/ref/guard/focus ports are controlled; not actual App/HTTP,
// Sandbox authority, ScriptStudio UI, Runtime/native foreground acceptance.
const fixed = new URL(location.href).searchParams.get("lane") === "fixed";
const storage = scopedStorage("compose-test:human");
const inputKey = "conversation:artifact";
storage.writeLocal(draftKey("inputs"), {
  [inputKey]: { ...empty, body: "原渲染正文", model: "old-route" },
  "conversation:quotes": { ...empty, textQuotes: [quote] },
});
const events: unknown[][] = [];
let failStorage = false,
  alive = true;
let last: {
  drafts: Record<string, InputDraft>;
  command: ReturnType<typeof createApplicationComposePreparation>;
};
let control: (action: string) => unknown;
let rendered = 0;
function Frame() {
  const inputs = useExchangeInputDraftState(storage);
  const conversations = useExchangeConversationDraftState(storage);
  const discarded = useExchangeDiscardedDraftState(storage);
  const currentContext = useRef(inputKey);
  currentContext.current = inputKey;
  const dictationControls = useRef({
    interrupt() {
      events.push(["interrupt"]);
    },
  });
  const input = useRef<HTMLTextAreaElement>(null);
  const guardedStorage = {
    readLocal: storage.readLocal,
    writeLocal(key: string, value: unknown) {
      events.push(["storage", key]);
      if (failStorage) throw new Error("controlled-local-storage-failure");
      storage.writeLocal(key, value);
    },
  };
  const commands = createExchangeDraftCommands({
    inputs,
    conversations,
    discarded,
    storage: guardedStorage,
    onNotice: (message) => events.push(["notice", message]),
  });
  const writeDrafts = commands.writeInputs,
    drafts = inputs.value;
  const draft = drafts[inputKey] ?? empty;
  const origin = { isActive: () => alive };
  // Exact App7c guarded writer body, borrowed by the preparation command.
  function setDraft(key: string, value: InputDraft) {
    if (!origin.isActive()) return;
    if (key === currentContext.current && value.body !== drafts[key]?.body)
      dictationControls.current?.interrupt();
    writeDrafts((previous) =>
      replaceComposerSurface(previous, key, emptyDraft, value),
    );
  }
  const emptyDraft = empty;
  const options = {
    render: {
      state: { artifacts: [artifact()] },
      project: { id: "project" },
      draft,
      contextKey: inputKey,
      conversationId: "conversation",
      defaultConversation: "conversation",
      sending: false,
      emptyDraft,
    },
    client: {
      getScriptEditor: () => production(),
      contentCatalog: [catalog()],
    },
    setDraft,
    writeDrafts,
    flushSync,
    currentContext,
    dictationControls,
    prefer(change: { artifactId: string }) {
      events.push(["prefer", change]);
    },
    showInput() {
      events.push(["showInput"]);
      input.current?.focus({ preventScroll: true });
    },
  };
  const command = fixed
    ? createFixedApplicationCompose(options)
    : createApplicationComposePreparation(options);
  last = { drafts, command };
  rendered++;
  control = (action) => {
    if (action === "latest-artifact") {
      writeDrafts((previous) => ({
        ...previous,
        [inputKey]: {
          ...empty,
          body: "排队的最新正文",
          model: "new-route",
          reasoningEffort: "max",
        },
      }));
      events.push(["invoke"]);
      const result = command("artifact-append", "artifact");
      events.push(["ack", result]);
      return result;
    }
    if (action === "dedicated-refusal") {
      writeDrafts((previous) => ({
        ...previous,
        [inputKey]: { ...empty, body: "专用请求原文", annotation: true },
      }));
      events.push(["invoke"]);
      const result = command("不得追加", "artifact");
      events.push(["ack", result]);
      return result;
    }
    if (action === "limit-refusal") {
      writeDrafts((previous) => ({
        ...previous,
        [inputKey]: { ...empty, body: "x".repeat(30000) },
      }));
      const result = command("不得追加", "artifact");
      events.push(["ack", result]);
      return result;
    }
    if (action === "captured-plain") {
      const captured = () => command("plain-append");
      writeDrafts((previous) => ({
        ...previous,
        [inputKey]: { ...empty, body: "排队的最新正文" },
      }));
      const result = captured();
      events.push(["ack", result]);
      return result;
    }
    if (action === "script-captured") {
      writeDrafts((previous) => ({
        ...previous,
        [inputKey]: { ...empty, annotation: true, body: "最新专用请求" },
      }));
      const result = command("script-request", undefined, generation);
      events.push(["ack", result]);
      return result;
    }
    if (action === "storage-failure") {
      failStorage = true;
      const result = command("artifact-append", "artifact");
      events.push(["ack", result]);
      return result;
    }
    if (action === "retired-replace-port") {
      alive = false;
      const result = command("plain-append");
      events.push(["ack", result]);
      return result;
    }
    if (action === "clear-for-script") {
      flushSync(() =>
        writeDrafts((previous) => ({ ...previous, [inputKey]: { ...empty } })),
      );
      return undefined;
    }
    throw new Error("Unknown bounded fixture action");
  };
  return (
    <main>
      <textarea
        id="original-input"
        aria-label="准备夹具输入"
        value={draft.body}
        readOnly
        ref={input}
      />
      <output id="state">{draft.body}</output>
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
function snapshot() {
  return {
    drafts: last.drafts,
    stored: storage.readLocal(draftKey("inputs"), {}),
    events,
    rendered,
    active: document.activeElement?.id ?? "",
    connected: document.querySelector("#original-input")?.isConnected ?? false,
  };
}
Reflect.set(window, "applicationComposeFixture", {
  run(action: string) {
    const result = control(action);
    flushSync(() => {});
    return { result, snapshot: snapshot() };
  },
  snapshot,
  unmount() {
    root.unmount();
    return snapshot();
  },
});
