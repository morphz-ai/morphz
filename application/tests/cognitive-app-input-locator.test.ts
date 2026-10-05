import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  commandSchema,
  operationSchema,
  type RecordedInput,
} from "../packages/core/src/model.js";
import {
  workInputFormats,
  workInputRequest,
} from "../packages/application/src/session-io.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import {
  parseCognitiveAppObjectLocator,
  guardCognitiveAppInputCommand,
} from "../packages/core/src/cognitive-app-object-locator.js";

const locator = {
  contentId: "content_exact",
  projectId: "project_exact",
  connectionId: "connection_exact",
  authority: {
    appId: "example.notes",
    version: "1.0.0",
    definitionHash: "a".repeat(64),
    instanceId: "instance_exact",
    serviceId: "service/笔记",
    dataAuthorityId: "data:原件",
  },
  object: {
    objectId: "笔记/0001",
    versionRef: "000900719925474099312345\n版本",
  },
};
const operation = () => ({
  type: "record-input",
  projectId: locator.projectId,
  artifactId: null,
  artifactRevision: null,
  selection: "",
  body: "Discuss this exact original",
  targetActantId: "morphz-agent",
  cognitiveObject: structuredClone(locator),
});

test("record-input accepts an independent opaque cognitive locator, not a builtin numeric revision", () => {
  const value = operationSchema.parse(operation());
  assert.deepEqual(value, operation());
});

test("locator is a bounded independent own-data snapshot and preserves portable opaque text", () => {
  const raw = structuredClone(locator);
  const parsed = parseCognitiveAppObjectLocator(raw);
  raw.object.versionRef = "changed";
  raw.authority.serviceId = "changed";
  assert.deepEqual(parsed, locator);
  assert.ok(
    Object.isFrozen(parsed) &&
      Object.isFrozen(parsed.object) &&
      Object.isFrozen(parsed.authority),
  );
  for (const versionRef of [
    1,
    null,
    "",
    "nul\u0000",
    "unpaired\ud800",
    "x".repeat(201),
  ])
    assert.throws(() =>
      parseCognitiveAppObjectLocator({
        ...locator,
        object: { ...locator.object, versionRef },
      }),
    );
  for (const extra of [
    { actor: "alice" },
    { grantRevision: 1 },
    { hostBindingId: "private" },
    { body: "private" },
  ])
    assert.throws(() =>
      parseCognitiveAppObjectLocator({ ...locator, ...extra }),
    );
  let getters = 0;
  const unsafe = Object.defineProperty({}, "objectId", {
    enumerable: true,
    get() {
      getters++;
      throw new Error("private");
    },
  });
  assert.throws(() =>
    parseCognitiveAppObjectLocator({ ...locator, object: unsafe }),
  );
  assert.equal(getters, 0);
  for (const change of [
    { artifactId: "builtin", artifactRevision: 1 },
    { reading: {} },
    { selection: "other" },
    { projectId: "other" },
  ])
    assert.equal(
      operationSchema.safeParse({ ...operation(), ...change }).success,
      false,
    );
});

test("new slot accessors never execute while old optional undefined and large valid quotes keep their budget", () => {
  let executed = 0;
  const getter = () => {
    executed++;
    throw new Error("caller-secret");
  };
  const command = { commandId: randomUUID(), operation: operation() };
  for (const raw of [
    Object.defineProperty({}, "operation", { enumerable: true, get: getter }),
    Object.create(
      Object.defineProperty({}, "operation", { enumerable: true, get: getter }),
    ),
    {
      ...command,
      operation: Object.defineProperty({}, "cognitiveObject", {
        enumerable: true,
        get: getter,
      }),
    },
    { ...command, operation: Object.create({ cognitiveObject: locator }) },
  ])
    assert.throws(() => guardCognitiveAppInputCommand(raw));
  assert.equal(executed, 0);
  const { cognitiveObject: _locator, ...oldOperation } = operation();
  const optional = {
    commandId: randomUUID(),
    applicationInstanceId: undefined,
    operation: { ...oldOperation, model: undefined },
  };
  guardCognitiveAppInputCommand(optional);
  assert.doesNotThrow(() => commandSchema.parse(optional));
  const huge = {
    commandId: randomUUID(),
    operation: {
      ...oldOperation,
      textQuotes: Array.from({ length: 30 }, () => ({
        id: randomUUID(),
        source: {
          kind: "web",
          projectId: "project_exact",
          pageId: "page",
          epoch: "epoch",
          title: "Known source",
          url: "https://example.com/" + "字".repeat(8100),
        },
        text: "x",
        comment: "",
      })),
    },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) > 512 * 1024);
  guardCognitiveAppInputCommand(huge);
  assert.doesNotThrow(() => commandSchema.parse(huge));
});

test("only cognitive inputs select IO10 and their whole exact locator is required-visible", () => {
  const input = {
    ...operation(),
    type: undefined,
    id: randomUUID(),
    author: { principalId: "alice", actantId: "human_alice" },
    status: "recorded",
    createdAt: "2026-10-05T01:00:00.000Z",
  } as unknown as RecordedInput;
  const request = workInputRequest(input);
  assert.equal(request.message.format.version, "10");
  assert.deepEqual(request.message.content.value.cognitiveObject, locator);
  const descriptor = workInputFormats.find(
    (f) => f.id === "morphz.application.input" && f.version === "10",
  );
  assert.ok(descriptor);
  assert.ok(
    (descriptor.required_visible_paths as readonly string[]).includes(
      "/cognitiveObject",
    ),
  );
  assert.ok(
    (descriptor.schema.required as readonly string[]).includes(
      "cognitiveObject",
    ),
  );
});

test("all pre-existing registered descriptors remain byte-for-byte unchanged", () => {
  const old = workInputFormats
    .filter((f) => f.version !== "10")
    .map((f) => [
      f.id,
      f.version,
      createHash("sha256").update(JSON.stringify(f)).digest("hex"),
    ]);
  assert.deepEqual(old, [
    [
      "morphz.application.input",
      "9",
      "7cb5bd05528ddef50ee5cc826b4488879540090ee97d56a0f0cbb0d19c747b0b",
    ],
    [
      "morphz.application.input",
      "8",
      "49b96e6e63fa37d6ff8e9d28446a174eb0cd30f9efc4a92a02611f7ae0b09a4c",
    ],
    [
      "morphz.application.input",
      "5",
      "2e99e072d9c8d53fca4541b82743bea9221e36d274ca2cd90ccb6fd4403308ea",
    ],
    [
      "morphz.application.input",
      "4",
      "666990386926aa96d0395001922b1e3a7fe6dba6ca221d62053b3803e312686b",
    ],
    [
      "morphz.application.input",
      "3",
      "89f3d58ad37a2abc59116e4d66b165d7aa354a0445ddb573b4f2a807ad291fd6",
    ],
    [
      "morphz.application.input",
      "2",
      "ff37f846777178e093a36c636e5053a74694e1fa5af2b3095685e0353fa3c91c",
    ],
    [
      "morphz.application.input",
      "1",
      "759f21fc3df45a0ae98f2e40813e63817616cbbe0a559601a5c43b1af9cc4873",
    ],
    [
      "morphzwork.input",
      "2",
      "7119aede3e278014ad0c19ebb31efbd21984412281ccd4968e01bd572837c026",
    ],
    [
      "morphzwork.input",
      "1",
      "9fbf6b9715556bfae62dc01373e3d4af884b6a5d02fcbc22573115f3e691635b",
    ],
  ]);
});

test("Host delivery schema20 fences downlevel19 readers without rewriting old delivery bytes", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "morphz-cognitive-input-fence-"),
  );
  const filename = join(directory, "transport.sqlite");
  try {
    const store = new WorkspaceStore(filename, { mode: "transport" });
    const request = {
      io_version: "1",
      client_message_id: "retained-old-input",
      message: {
        format: { id: "morphz.application.input", version: "9" },
        content: {
          encoding: "json",
          value: { text: "历史字节\n", input_id: "retained-old-input" },
        },
      },
      activation: { mode: "evaluate", dispatch_mode: "parallel" },
    };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex");
    store.saveRuntimeState({
      sessions: {},
      deliveries: [
        {
          inputId: "retained-old-input",
          sessionId: "retained-session",
          state: "queued",
          request,
          fingerprint,
        },
      ],
      publications: {},
      threadBindings: {},
    });
    store.close();
    const db = new DatabaseSync(filename);
    let retainedBytes: string;
    try {
      assert.equal(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
        20,
      );
      retainedBytes = (
        db
          .prepare("SELECT body FROM runtime_deliveries WHERE key=?")
          .get("retained-old-input") as { body: string }
      ).body;
      db.exec("PRAGMA user_version=19");
    } finally {
      db.close();
    }
    const reopened = new WorkspaceStore(filename, { mode: "transport" });
    reopened.close();
    const upgraded = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(
        (
          upgraded.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
        20,
      );
      assert.equal(
        (
          upgraded
            .prepare("SELECT body FROM runtime_deliveries WHERE key=?")
            .get("retained-old-input") as { body: string }
        ).body,
        retainedBytes,
      );
      const retained = JSON.parse(retainedBytes) as {
        request: unknown;
        fingerprint: string;
        state: string;
      };
      assert.deepEqual(retained.request, request);
      assert.equal(retained.fingerprint, fingerprint);
      assert.equal(retained.state, "queued");
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
