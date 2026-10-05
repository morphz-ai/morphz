import assert from "node:assert/strict";
import test from "node:test";
import {
  focusedInputs,
  projectConversationReadScope,
} from "../apps/web/src/conversation-read.js";
import { parseCognitiveAppObjectLocator } from "../packages/core/src/cognitive-app-object-locator.js";
import type { Workspace } from "../packages/core/src/model.js";
import type { LiveMessage } from "../packages/core/src/live-conversation.js";

const original = parseCognitiveAppObjectLocator({
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
  object: { objectId: "opaque:对象", versionRef: "release/版本#001" },
});
type Locator = typeof original;
const input = (id: string, cognitiveObject?: Locator) =>
  ({ id, artifactId: null, cognitiveObject }) as Workspace["inputs"][number];
const reply = (id: string, inputId: string | null) =>
  ({ id, inputId, kind: "reply", text: id }) as LiveMessage;

test("UNIT cognitive focus uses the complete original identity, not version or a builtin ID", () => {
  const v2 = parseCognitiveAppObjectLocator({
    ...original,
    object: { ...original.object, versionRef: "release/版本#002" },
  });
  const same = [input("v1", original), input("v2", v2)];
  const others: Locator[] = [];
  for (const field of ["contentId", "projectId", "connectionId"] as const)
    others.push(
      parseCognitiveAppObjectLocator({ ...original, [field]: "other" }),
    );
  for (const field of Object.keys(
    original.authority,
  ) as (keyof Locator["authority"])[])
    others.push(
      parseCognitiveAppObjectLocator({
        ...original,
        authority: {
          ...original.authority,
          [field]:
            field === "definitionHash"
              ? "b".repeat(64)
              : field === "version"
                ? "2.0.0"
                : "other",
        },
      }),
    );
  others.push(
    parseCognitiveAppObjectLocator({
      ...original,
      object: { ...original.object, objectId: "other-object" },
    }),
  );
  const inputs = [
    ...same,
    ...others.map((locator, index) => input("different-" + index, locator)),
    { ...input("builtin"), artifactId: original.contentId },
    {
      ...input("legacy-app"),
      application: { instanceId: original.authority.instanceId },
    },
    input("ordinary"),
  ] as Workspace["inputs"];
  for (const focus of [original, v2]) {
    assert.deepEqual(
      focusedInputs(inputs, [], { cognitiveObject: focus }),
      same,
    );
    // Even a coincidental old selector cannot broaden the explicit original scope.
    assert.deepEqual(
      focusedInputs(inputs, [], {
        cognitiveObject: focus,
        artifactId: original.contentId,
        applicationId: original.authority.instanceId,
      }),
      same,
    );
  }
  assert.strictEqual(focusedInputs(inputs, [], {}), inputs);
  assert.equal(same[0]!.cognitiveObject!.object.versionRef, "release/版本#001");
});

test("UNIT badge and history share cognitive input scope and retain their old unfocused array contracts", () => {
  const inputs = [input("original", original), input("ordinary")];
  const messages = [
    reply("mine", "original"),
    reply("other", "ordinary"),
    reply("legacy", null),
  ];
  for (const messageArray of ["preserve-unfocused", "filter-always"] as const) {
    const scoped = projectConversationReadScope({
      inputs,
      messages,
      outputs: [],
      scriptOutputs: [],
      scope: { focus: { cognitiveObject: original }, messageArray },
    });
    assert.deepEqual(scoped.inputs, [inputs[0]]);
    assert.deepEqual(scoped.messages, [messages[0]]);
    const all = projectConversationReadScope({
      inputs,
      messages,
      outputs: [],
      scriptOutputs: [],
      scope: { focus: {}, messageArray },
    });
    assert.strictEqual(all.inputs, inputs);
    assert.deepEqual(all.messages, messages);
    assert.equal(
      all.messages === messages,
      messageArray === "preserve-unfocused",
    );
  }
});
