import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseCognitiveApplication,
  type CognitiveApplicationChoiceScope,
} from "../apps/web/src/host/cognitive-application-choice.js";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";
import { parseCognitiveAppApplicationTarget } from "../packages/core/src/cognitive-app-application-target.js";
import { parseCognitiveAppObjectLocator } from "../packages/core/src/cognitive-app-object-locator.js";
import { updateComposerDraft } from "../apps/web/src/composer-drafts.js";

// Pure latest-draft preparation UNIT; not catalog authorization, persistence,
// mounted App, actual Human/SQL, author networking or Runtime acceptance.
const authority = {
  appId: "author.notes",
  version: "1.0.0",
  definitionHash: "a".repeat(64),
  instanceId: "instance-one",
  serviceId: "service-one",
  dataAuthorityId: "data-one",
};
const target = (connectionId = "connection-one") =>
  parseCognitiveAppApplicationTarget({ connectionId, authority });
const locator = (versionRef = "opaque:旧😀@V1") =>
  parseCognitiveAppObjectLocator({
    contentId: "content-one",
    projectId: "project-one",
    connectionId: "connection-one",
    authority,
    object: { objectId: "opaque:原件", versionRef },
  });
const empty: InputDraft = { body: "", selection: "", revision: null };
const scope = (): CognitiveApplicationChoiceScope => ({
  projectId: "project-one",
  expectedContextKey: "conversation:desk",
  currentContextKey: "conversation:desk",
  artifactId: null,
  cognitiveSurface: null,
});
const draft = (): InputDraft => ({
  ...empty,
  body: "原有\n正文",
  model: "my-model",
  reasoningEffort: "max",
  attachments: [
    { assetId: "a".repeat(64), name: "original.txt", mime: "text/plain" },
  ],
});

test("UNIT select/clear change only exact app slot on actual latest draft and keep independent scope", () => {
  let previous = {
    [scope().currentContextKey]: draft(),
    "other:surface": { ...empty, body: "other" },
  };
  const key = scope().currentContextKey;
  previous = {
    ...previous,
    [key]: { ...previous[key]!, body: "latest byte\n正文" },
  };
  let chosen: ReturnType<typeof chooseCognitiveApplication> | undefined;
  const next = updateComposerDraft(previous, key, empty, (current) => {
    chosen = chooseCognitiveApplication(current, target(), scope());
    return chosen.ok ? chosen.draft : current;
  });
  assert.equal(chosen?.ok, true);
  assert.equal(next[key]!.body, "latest byte\n正文");
  assert.deepEqual(next[key]!.cognitiveApplication, target());
  assert.strictEqual(next[key]!.attachments, previous[key]!.attachments);
  assert.strictEqual(next["other:surface"], previous["other:surface"]);
  assert.equal(next[key]!.cognitiveObject, undefined);
  const selected = chooseCognitiveApplication(draft(), target(), scope());
  assert.ok(selected.ok);
  const cleared = chooseCognitiveApplication(selected.draft, null, scope());
  assert.ok(cleared.ok);
  assert.deepEqual(cleared.draft, draft());
  assert.equal("cognitiveApplication" in cleared.draft, false);
});

test("UNIT exact original V1 survives V2 current surface and selection never fabricates an original", () => {
  const current = { ...draft(), cognitiveObject: locator() };
  const s = {
    ...scope(),
    cognitiveSurface: {
      kind: "original" as const,
      locator: locator("new-head:V2"),
    },
  };
  const result = chooseCognitiveApplication(current, target(), s);
  assert.ok(result.ok);
  assert.strictEqual(result.draft.cognitiveObject, current.cognitiveObject);
  assert.deepEqual(result.draft.cognitiveApplication, target());
  for (const currentSurface of [
    s.cognitiveSurface,
    {
      kind: "view" as const,
      projectId: "project-one",
      viewId: "view-one",
      ...target(),
    },
  ]) {
    const selected = chooseCognitiveApplication(empty, target(), {
      ...scope(),
      cognitiveSurface: currentSurface,
    });
    assert.ok(selected.ok);
    assert.equal(selected.draft.cognitiveObject, undefined);
  }
});

test("UNIT connection and all six authority fields cannot replace original/view binding", () => {
  const changes = [
    { ...target(), connectionId: "other-connection" },
    ...(
      [
        "appId",
        "version",
        "definitionHash",
        "instanceId",
        "serviceId",
        "dataAuthorityId",
      ] as const
    ).map((field) => ({
      ...target(),
      authority: {
        ...authority,
        [field]:
          field === "appId"
            ? "other.notes"
            : field === "version"
              ? "2.0.0"
              : field === "definitionHash"
                ? "b".repeat(64)
                : "other",
      },
    })),
  ];
  for (const value of changes)
    for (const s of [
      scope(),
      {
        ...scope(),
        cognitiveSurface: { kind: "original" as const, locator: locator() },
      },
      {
        ...scope(),
        cognitiveSurface: {
          kind: "view" as const,
          projectId: "project-one",
          viewId: "view-one",
          ...target(),
        },
      },
    ]) {
      const old = { ...draft(), cognitiveObject: locator() };
      assert.equal(
        chooseCognitiveApplication(
          old,
          parseCognitiveAppApplicationTarget(value),
          s,
        ).ok,
        false,
      );
      assert.deepEqual(old.cognitiveObject, locator());
      assert.equal(old.body, draft().body);
    }
});

test("UNIT selection and clear both reject stale work scope, other project/original identity and special draft", () => {
  const operation = {
    type: "record-input" as const,
    projectId: "project-one",
    artifactId: null,
    artifactRevision: null,
    selection: "",
    body: "pending",
    targetActantId: "morphz-agent",
  };
  const requests: Partial<InputDraft>[] = [
    {
      continuation: {
        mode: "supplement",
        inputId: "input-one",
        threadId: "thread-one",
        generation: 1,
      },
    },
    {
      continuation: {
        mode: "follow-up",
        inputId: "input-one",
        threadId: "thread-one",
        generation: 1,
      },
    },
    { pendingSupplement: { commandId: "original-command", operation } },
    { continuationFailure: "unknown" },
    { annotation: true },
    { taskResult: { taskId: "task-one", revision: 1 } },
    { reading: { format: "future" } as never },
    { selection: "old selected text" },
    { revision: 2 },
    { page: 3 },
    {
      scriptGeneration: {
        productionId: "script",
        targetId: "item",
        baseRevision: 1,
        contextRevision: 1,
        purpose: "rewrite",
        references: [],
        maxCandidates: 1,
        maxOutputCharacters: 100,
        maxReviewPasses: 0,
      },
    },
  ];
  for (const change of requests)
    for (const value of [target(), null]) {
      const old = { ...draft(), ...change, cognitiveApplication: target() };
      assert.equal(chooseCognitiveApplication(old, value, scope()).ok, false);
      assert.deepEqual(old.cognitiveApplication, target());
    }
  for (const s of [
    { ...scope(), currentContextKey: "new:scope" },
    { ...scope(), artifactId: "builtin-artifact" },
    {
      ...scope(),
      projectId: "other-project",
      cognitiveSurface: { kind: "original" as const, locator: locator() },
    },
    {
      ...scope(),
      cognitiveSurface: {
        kind: "original" as const,
        locator: parseCognitiveAppObjectLocator({
          ...locator(),
          contentId: "other-content",
        }),
      },
    },
  ])
    for (const value of [target(), null])
      assert.equal(
        chooseCognitiveApplication(
          { ...draft(), cognitiveObject: locator() },
          value,
          s,
        ).ok,
        false,
      );
});

test("UNIT malformed own-data, prototype and nested getters reject without execution; target detaches", () => {
  let reads = 0;
  const raw = structuredClone(target());
  const result = chooseCognitiveApplication(draft(), raw, scope());
  assert.ok(result.ok);
  Object.defineProperty(raw.authority, "serviceId", {
    value: "late caller mutation",
    enumerable: true,
  });
  assert.deepEqual(result.draft.cognitiveApplication, target());
  for (const field of ["cognitiveApplication", "cognitiveObject"] as const) {
    const inherited = Object.assign(
      Object.create({
        [field]: field === "cognitiveApplication" ? target() : locator(),
      }),
      draft(),
    );
    assert.equal(
      chooseCognitiveApplication(inherited, target(), scope()).ok,
      false,
    );
    const getter = Object.defineProperty(draft(), field, {
      enumerable: true,
      get() {
        reads++;
        return target();
      },
    });
    assert.equal(chooseCognitiveApplication(getter, null, scope()).ok, false);
  }
  const malformed = structuredClone(target());
  Object.defineProperty(malformed.authority, "serviceId", {
    enumerable: true,
    get() {
      reads++;
      return "secret";
    },
  });
  assert.equal(
    chooseCognitiveApplication(draft(), malformed, scope()).ok,
    false,
  );
  const badScope = Object.defineProperty(scope(), "projectId", {
    enumerable: true,
    get() {
      reads++;
      return "project-one";
    },
  });
  assert.equal(
    chooseCognitiveApplication(draft(), target(), badScope).ok,
    false,
  );
  assert.equal(
    chooseCognitiveApplication(draft(), target(), {
      ...scope(),
      privateAuthority: true,
    } as never).ok,
    false,
  );
  assert.equal(reads, 0);
});

test("UNIT strict Host scope rejects coerced project and falsy/invalid artifact or surface values", () => {
  for (const change of [
    { projectId: 123 },
    { projectId: false },
    { projectId: null },
    { artifactId: 0 },
    { artifactId: false },
    { artifactId: "" },
    { artifactId: "bad\u0000id" },
    { artifactId: {} },
    { cognitiveSurface: false },
    { cognitiveSurface: 0 },
    { cognitiveSurface: "" },
  ])
    for (const selection of [target(), null]) {
      const old = { ...draft(), cognitiveApplication: target() };
      assert.equal(
        chooseCognitiveApplication(old, selection, {
          ...scope(),
          ...change,
        } as never).ok,
        false,
      );
      assert.deepEqual(old.cognitiveApplication, target());
    }
});
