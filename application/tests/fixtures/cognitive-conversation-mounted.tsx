import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Conversation } from "../../apps/web/src/Conversation.js";
import { initialWorkspace } from "../../packages/core/src/model.js";
import { disconnectedRuntime } from "../../packages/core/src/conversation.js";
import { parseCognitiveAppObjectLocator } from "../../packages/core/src/cognitive-app-object-locator.js";
import { cognitiveWorkSurfaceKey } from "../../apps/web/src/host/work-surface.js";
import type { WorkspaceClient } from "../../apps/web/src/client.js";
import type { ExchangePosition } from "../../apps/web/src/Conversation.js";
import {
  viewportInput,
  viewportReply,
} from "./conversation-viewport-mounted.js";

// Complete current Conversation mounted in React StrictMode. Business/read ports
// are controlled: this proves rendering/reading ownership, not App navigation,
// current grants, author service or Runtime execution.
const locator = (objectId = "opaque:对象-A", versionRef = "release/版本#001") =>
  parseCognitiveAppObjectLocator({
    contentId: objectId === "opaque:对象-B" ? "content-B" : "content-A",
    projectId: "first-project",
    connectionId: "connection-one",
    authority: {
      appId: "author.notes",
      version: "1.0.0",
      definitionHash: "a".repeat(64),
      instanceId: "instance-one",
      serviceId: "service-one",
      dataAuthorityId: "authority-one",
    },
    object: { objectId, versionRef },
  });
const first = locator(),
  second = locator("opaque:对象-B"),
  v2 = locator(undefined, "release/版本#002"),
  foreign = parseCognitiveAppObjectLocator({
    ...first,
    authority: { ...first.authority, dataAuthorityId: "other-authority" },
  });
const inputs = [
  { ...viewportInput("input-V1"), artifactId: null, cognitiveObject: first },
  { ...viewportInput("input-V2"), artifactId: null, cognitiveObject: v2 },
  { ...viewportInput("input-B"), artifactId: null, cognitiveObject: second },
  {
    ...viewportInput("input-foreign"),
    artifactId: null,
    cognitiveObject: foreign,
  },
  { ...viewportInput("input-ordinary"), artifactId: null },
];
const state = initialWorkspace("2026-10-05T00:00:00.000Z");
state.inputs = inputs;
const messages = inputs.flatMap((input) =>
  Array.from({ length: 8 }, (_, index) =>
    viewportReply(
      "reply-" + input.id + "-" + index,
      "Reply " + input.id + " " + "readable content ".repeat(25),
      input.id,
    ),
  ),
);
const runtime = { ...disconnectedRuntime, messages };
const positions = new Map<string, ExchangePosition>();
const events: unknown[][] = [];
const client = {
  boot: {
    workspace: state,
    runtime,
    outputs: [],
    scriptOutputs: [],
    localSavedInputIds: [],
    localInputSubmissions: {},
    actantId: "human",
  },
  online: true,
  contentCatalog: [],
  contentVersionTitle: () => null,
  loadHistoryUntil: () => {
    throw Error("Unexpected history load");
  },
  cancelInput: () => {
    throw Error("Unexpected stop");
  },
} as unknown as WorkspaceClient;
let select: (key: string) => void;
function Frame() {
  const [focus, setFocus] = useState(first);
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  select = (key) => setFocus(key === "B" ? second : key === "V2" ? v2 : first);
  return (
    <main>
      <header ref={setToolbar} />
      <input id="composer" defaultValue="Unsent draft" />
      <Conversation
        inputs={inputs}
        state={state}
        runtime={runtime}
        messages={messages}
        streamConnected={false}
        seenReplies={{}}
        onRead={(receipts) => events.push(["read", receipts])}
        conversationId="conversation-A"
        onRetry={async () => {
          throw Error("Unexpected retry");
        }}
        client={client}
        onOpen={() => {
          throw Error("Cognitive object must not use builtin opening");
        }}
        onOpenCognitiveObject={(value) => events.push(["open", value])}
        positions={positions}
        revealInputId={null}
        focusedCognitiveObject={focus}
        toolbarTarget={toolbar}
        onFocusComposer={() => document.getElementById("composer")?.focus()}
      />
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
Reflect.set(window, "cognitiveConversationFixture", {
  select(key: string) {
    flushSync(() => select(key));
  },
  scroll(top: number) {
    const el = document.querySelector<HTMLElement>(".conversation")!;
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
  },
  report() {
    return {
      positions: [...positions],
      events,
      top: document.querySelector(".conversation")?.scrollTop,
      keys: [first, second, v2].map((value) =>
        JSON.stringify([
          "cognitive",
          "conversation-A",
          cognitiveWorkSurfaceKey({ kind: "original", locator: value }),
        ]),
      ),
    };
  },
});
