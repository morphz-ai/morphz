import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  operationSchema,
  type RecordedInput,
} from "../packages/core/src/model.js";
import {
  parseCognitiveAppApplicationTarget,
  guardCognitiveAppApplicationCommand,
} from "../packages/core/src/cognitive-app-application-target.js";
import {
  workInputFormats,
  workInputRequest,
  cognitiveApplicationInputFormat,
  cognitiveApplicationObjectInputFormat,
} from "../packages/application/src/session-io.js";

const target = {
  connectionId: "connection_exact",
  authority: {
    appId: "example.notes",
    version: "1.0.0",
    definitionHash: "a".repeat(64),
    instanceId: "instance_exact",
    serviceId: "service/notes",
    dataAuthorityId: "database:notes",
  },
};
const operation = () => ({
  type: "record-input",
  projectId: "project_exact",
  artifactId: null,
  artifactRevision: null,
  selection: "",
  body: "Use the explicitly chosen application",
  targetActantId: "morphz-agent",
  cognitiveApplication: structuredClone(target),
});
function input(): RecordedInput {
  return {
    id: "input_exact",
    ...operation(),
    status: "recorded",
    author: { principalId: "local-user", actantId: "local-user" },
    createdAt: "2026-10-05T00:00:00Z",
    application: {
      instanceId: target.authority.instanceId,
      id: target.authority.appId,
      version: target.authority.version,
      harness: { id: "example.notes-harness", version: "1.0.0" },
    },
  } as RecordedInput;
}

test("explicit cognitive application is independent of GUI and original reference", () => {
  assert.deepEqual(operationSchema.parse(operation()), operation());
});

test("IO11 requires strict target and null original; IO12 requires strict whole original", () => {
  const request = workInputRequest(input());
  assert.equal(request.message.format.version, "11");
  assert.deepEqual(request.message.content.value.cognitiveApplication, target);
  assert.equal(request.message.content.value.cognitiveObject, null);
  const first = cognitiveApplicationInputFormat;
  const second = cognitiveApplicationObjectInputFormat;
  assert.ok(
    workInputFormats.includes(first) && workInputFormats.includes(second),
  );
  for (const descriptor of [first, second]) {
    assert.ok(
      (descriptor.required_visible_paths as readonly string[]).includes(
        "/cognitiveApplication",
      ),
    );
    assert.ok(
      (descriptor.required_visible_paths as readonly string[]).includes(
        "/cognitiveObject",
      ),
    );
    assert.ok(
      (descriptor.schema.required as readonly string[]).includes(
        "cognitiveApplication",
      ),
    );
    assert.ok(
      (descriptor.schema.required as readonly string[]).includes(
        "cognitiveObject",
      ),
    );
  }
  assert.equal(first.schema.properties.cognitiveObject.type, "null");
  assert.equal(second.schema.properties.cognitiveObject.type, "object");
});

test("IO10 registered descriptor remains unchanged", () => {
  const old = workInputFormats.find((value) => value.version === "10")!;
  assert.equal(
    createHash("sha256").update(JSON.stringify(old)).digest("hex"),
    "d1850ee7908e7c7f3227d2b46351bd5cb40ab4e5c2a15e738b5e0c86a083c686",
  );
});

test("target snapshots are strict own JSON, portable and immutable without executing getters", () => {
  const raw = structuredClone(target);
  const parsed = parseCognitiveAppApplicationTarget(raw);
  raw.authority.serviceId = "changed";
  assert.deepEqual(parsed, target);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.authority));
  for (const value of [
    null,
    "target",
    { ...target, actor: "other" },
    { ...target, connectionId: "bad/path" },
    { ...target, authority: { ...target.authority, serviceId: "NUL\u0000" } },
  ])
    assert.throws(() => parseCognitiveAppApplicationTarget(value));
  let getters = 0;
  const nested = Object.defineProperty({}, "serviceId", {
    enumerable: true,
    get() {
      getters++;
      throw new Error("secret");
    },
  });
  assert.throws(() =>
    parseCognitiveAppApplicationTarget({
      ...target,
      authority: { ...target.authority, ...{}, serviceId: nested },
    }),
  );
  const command = {
    operation: Object.defineProperty(operation(), "cognitiveApplication", {
      enumerable: true,
      get() {
        getters++;
        throw new Error("secret");
      },
    }),
  };
  assert.throws(() => guardCognitiveAppApplicationCommand(command));
  assert.throws(() =>
    guardCognitiveAppApplicationCommand({
      operation: Object.assign(
        Object.create({ cognitiveApplication: target }),
        { type: "record-input" },
      ),
    }),
  );
  assert.equal(getters, 0);
  guardCognitiveAppApplicationCommand({
    operation: { ...operation(), cognitiveApplication: undefined },
  });
});

test("explicit target rejects duplicate selectors, builtin specialized work and different original authority", () => {
  const specialized = [
    {
      scriptGeneration: {
        productionId: "production",
        targetId: "target",
        baseRevision: 1,
        contextRevision: 1,
        purpose: "draft",
        references: [],
        maxCandidates: 1,
        maxOutputCharacters: 100,
        maxReviewPasses: 0,
      },
    },
    {
      reading: {
        book: {
          title: "Book",
          author: "Author",
          edition: "Edition",
          format: "text",
        },
        location: {
          sourceId: "source",
          sectionId: "section",
          start: 0,
          end: 1,
        },
        chapter: "Chapter",
      },
    },
  ];
  for (const additions of specialized) {
    assert.ok(
      operationSchema.safeParse({
        ...operation(),
        cognitiveApplication: undefined,
        ...additions,
      }).success,
      "The specialized context is itself valid in the old contract",
    );
    assert.throws(() =>
      operationSchema.parse({ ...operation(), ...additions }),
    );
  }
  for (const additions of [
    {
      application: {
        id: target.authority.appId,
        version: target.authority.version,
      },
    },
    { applicationInstanceId: target.authority.instanceId },
    {
      cognitiveObject: {
        contentId: "content",
        projectId: "project_exact",
        connectionId: "other",
        authority: target.authority,
        object: { objectId: "opaque", versionRef: "000123" },
      },
    },
  ])
    assert.throws(() =>
      operationSchema.parse({ ...operation(), ...additions }),
    );
  const locator = {
    contentId: "content",
    projectId: "project_exact",
    ...target,
    object: {
      objectId: "笔记/001",
      versionRef: "000900719925474099312345\nold😀",
    },
  };
  const request = workInputRequest({ ...input(), cognitiveObject: locator });
  assert.equal(request.message.format.version, "12");
  assert.deepEqual(request.message.content.value.cognitiveObject, locator);
  const supplement = workInputRequest({
    ...input(),
    continuation: {
      mode: "supplement",
      inputId: "original",
      threadId: "thread",
      generation: 1,
    },
  });
  assert.equal(supplement.activation.harness, undefined);
  assert.deepEqual(
    supplement.message.content.value.cognitiveApplication,
    target,
  );
});
