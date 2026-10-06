import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "../packages/cognitive-app-sdk/src/domain-wire.js";
import { parseCognitiveAppDefinition } from "../packages/cognitive-app-sdk/src/protocol.js";
import { parseCognitiveAppCatalog } from "../packages/core/src/cognitive-app-api.js";
import { cognitiveAppCatalogMetadata } from "../packages/platform/src/cognitive-app-registry.js";
import {
  cognitiveCreationChoices,
  prepareBuiltinCreation,
  prepareCognitiveCreation,
} from "../apps/web/src/composer-creation-model.js";
import type { InputDraft } from "../apps/web/src/host/exchange-drafts.js";
import type { CognitiveApplicationEntry } from "../apps/web/src/application-presentation.js";

const schema = { type: "object", properties: {}, additionalProperties: false };
const operation = {
  id: "notes.create",
  title: "Create",
  description: "Create a note",
  effect: "write",
  scope: "project",
  inputSchema: schema,
  outputSchema: schema,
};
const definition = {
  format: "morphz-cognitive-app/v1",
  protocol: "morphz-domain/v1",
  id: "author.notes",
  version: "1.0.0",
  title: "作者笔记",
  description: "Headless independent notes",
  icon: "book",
  harness: null,
  ui: null,
  operations: [operation],
};
const compose = {
  kind: "create",
  label: "新建笔记",
  prompt: " 请帮我写笔记。\n",
};
const now = "2026-10-06T00:00:00.000Z";
function metadata(declaration: unknown = definition) {
  const parsed = parseCognitiveAppDefinition(declaration);
  return cognitiveAppCatalogMetadata({
    appId: parsed.id,
    installationId: "installation",
    version: parsed.version,
    definitionHash: "a".repeat(64),
    definition: parsed,
    installedByPrincipalId: "human",
    installedAt: now,
    registeredAt: now,
    installationState: "active",
    grant: {
      appId: parsed.id,
      version: parsed.version,
      state: "active",
      revision: 1,
      consentedAt: now,
      updatedAt: now,
    },
  });
}
function entry(): CognitiveApplicationEntry {
  const declared = metadata({
    ...definition,
    version: "1.1.0",
    operations: [{ ...operation, compose }],
  });
  return {
    kind: "cognitive",
    key: "author.notes@1.1.0",
    metadata: declared,
    inputAvailability: "selectable",
    gui: "absent",
    connections: ["A", "B"].map((id) => ({
      appId: declared.appId,
      connectionId: id,
      instanceId: "instance-" + id,
      serviceId: "service-" + id,
      dataAuthorityId: "data-" + id,
      state: "active",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })),
  };
}
const empty: InputDraft = { body: "", selection: "", revision: null };
const scope = {
  projectId: "project",
  expectedContextKey: "project:input",
  currentContextKey: "project:input",
};

test("creation declaration is explicit, bounded, project-scoped side effect only and preserves old canonical bytes", () => {
  const old = parseCognitiveAppDefinition(definition);
  assert.deepEqual(old, definition);
  assert.equal(
    createHash("sha256").update(canonicalJsonBytes(old)).digest("hex"),
    createHash("sha256").update(canonicalJsonBytes(definition)).digest("hex"),
  );
  assert(!Object.hasOwn(old.operations[0]!, "compose"));
  for (const effect of ["write", "execute"])
    assert.deepEqual(
      parseCognitiveAppDefinition({
        ...definition,
        version: "1.1.0",
        operations: [{ ...operation, effect, compose }],
      }).operations[0]!.compose,
      compose,
    );
  for (const bad of [
    { ...compose, kind: "update" },
    { ...compose, label: " " },
    { ...compose, label: "a".repeat(101) },
    { ...compose, label: "\u0000" },
    { ...compose, prompt: "\n\t" },
    { ...compose, prompt: "a".repeat(501) },
    { ...compose, prompt: "\ud800" },
    { ...compose, invoke: true },
  ])
    assert.throws(() =>
      parseCognitiveAppDefinition({
        ...definition,
        operations: [{ ...operation, compose: bad }],
      }),
    );
  for (const bad of [{ effect: "read" }, { scope: "objects" }])
    assert.throws(() =>
      parseCognitiveAppDefinition({
        ...definition,
        operations: [{ ...operation, ...bad, compose }],
      }),
    );
});

test("catalog contribution is a compact strict whitelist, never inferred from write or management metadata", () => {
  const plain = metadata();
  assert(!Object.hasOwn(plain, "creationIntents"));
  const declared = entry().metadata;
  assert.deepEqual(declared.creationIntents, [
    { operationId: operation.id, label: compose.label, prompt: compose.prompt },
  ]);
  const catalog = {
    versions: [declared],
    connections: [],
    nextVersionsAfter: null,
    nextConnectionsAfter: null,
  };
  assert.deepEqual(parseCognitiveAppCatalog(catalog), catalog);
  assert(!Object.hasOwn(declared, "operations"));
  for (const value of [
    [{ operationId: "notes.create", label: " " }],
    [{ operationId: "notes.create", label: "label", prompt: " " }],
    [{ operationId: "notes.create", label: "label", effect: "write" }],
    [
      { operationId: "notes.create", label: "label" },
      { operationId: "notes.create", label: "other" },
    ],
  ])
    assert.throws(() =>
      parseCognitiveAppCatalog({
        ...catalog,
        versions: [{ ...declared, creationIntents: value }],
      }),
    );
});

test("headless quick entries contribute each exact active connection; no GUI or first/default connection inference", () => {
  const enabled = entry();
  const choices = cognitiveCreationChoices({
    entries: [enabled],
    quickEntries: [enabled],
  });
  assert.equal(choices.length, 2);
  assert.deepEqual(
    choices.map((choice) => choice.target.connectionId),
    ["A", "B"],
  );
  assert.deepEqual(
    choices.map((choice) => choice.target.authority.definitionHash),
    ["a".repeat(64), "a".repeat(64)],
  );
  assert.equal(
    cognitiveCreationChoices({ entries: [enabled], quickEntries: [] }).length,
    0,
  );
  for (const inputAvailability of [
    "not-granted",
    "installation-inactive",
    "no-active-connection",
    "project-unavailable",
  ] as const)
    assert.equal(
      cognitiveCreationChoices({
        entries: [enabled],
        quickEntries: [{ ...enabled, inputAvailability }],
      }).length,
      0,
    );
  assert.equal(
    cognitiveCreationChoices({
      entries: [enabled],
      quickEntries: [{ ...enabled, metadata: metadata() }],
    }).length,
    0,
  );
  const prepared = prepareCognitiveCreation(empty, choices[1]!, scope);
  assert(prepared.ok);
  assert.equal(prepared.draft.body, compose.prompt);
  assert.deepEqual(prepared.draft.cognitiveApplication, choices[1]!.target);
  assert(!Object.hasOwn(prepared.draft, "operationId"));
  assert(!Object.hasOwn(prepared.draft, "intent"));
  assert.equal(
    prepareCognitiveCreation(
      { ...empty, cognitiveApplication: choices[1]!.target },
      choices[1]!,
      scope,
    ).ok,
    true,
  );
  assert.equal(
    prepareCognitiveCreation(
      { ...empty, cognitiveApplication: choices[0]!.target },
      choices[1]!,
      scope,
    ).ok,
    false,
  );
  const view = {
    kind: "view" as const,
    projectId: "project",
    viewId: "view",
    authority: choices[1]!.target.authority,
    connectionId: choices[1]!.target.connectionId,
  };
  assert.equal(
    prepareCognitiveCreation(empty, choices[1]!, {
      ...scope,
      cognitiveSurface: view,
    }).ok,
    true,
  );
  assert.equal(
    prepareCognitiveCreation(empty, choices[0]!, {
      ...scope,
      cognitiveSurface: view,
    }).ok,
    false,
  );
});

test("third-party author draft preparation rejects occupied/special sources atomically; builtin preserves ordinary ideas/materials", () => {
  const choice = cognitiveCreationChoices({
    entries: [entry()],
    quickEntries: [entry()],
  })[0]!;
  const materials: InputDraft = {
    ...empty,
    body: "已有构思\n原字节",
    selection: "普通素材",
    revision: 3,
    page: 1,
    attachments: [
      { assetId: "b".repeat(64), name: "原附件.txt", mime: "text/plain" },
    ],
    textQuotes: [],
  };
  const unchanged = structuredClone(materials);
  assert.equal(prepareCognitiveCreation(materials, choice, scope).ok, false);
  assert.deepEqual(materials, unchanged);
  const prepared = prepareBuiltinCreation(materials, "script");
  assert(prepared.ok);
  assert.deepEqual(prepared.draft, { ...unchanged, intent: "script" });
  for (const special of [
    { annotation: true },
    { taskResult: { taskId: "task", revision: 1 } },
    { scriptGeneration: {} },
    { reading: {} },
    { cognitiveApplication: choice.target },
    { cognitiveObject: {} },
    { continuation: {} },
    { pendingSupplement: {} },
    { continuationFailure: "unknown" },
  ]) {
    const draft = { ...empty, ...special } as InputDraft;
    assert.equal(prepareBuiltinCreation(draft, "task").ok, false);
    assert.equal(prepareBuiltinCreation(draft, "document").ok, false);
  }
  for (const draft of [
    { ...empty, body: " " },
    { ...empty, intent: "task" as const },
    { ...empty, annotation: true },
    { ...empty, taskResult: { taskId: "task", revision: 1 } },
  ])
    assert.equal(prepareCognitiveCreation(draft, choice, scope).ok, false);
  assert.equal(
    prepareCognitiveCreation(empty, choice, {
      ...scope,
      currentContextKey: "other",
    }).ok,
    false,
  );
});
