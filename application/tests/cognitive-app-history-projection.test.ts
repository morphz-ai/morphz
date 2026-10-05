import { prepareConnectionCreation } from "./fixtures/cognitive-connection-creation.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  PlatformClient,
  platformHistorySchema,
} from "../apps/web/src/platform-client.js";
import {
  mergePlatformHistories,
  readPlatformWorkspace,
} from "../apps/web/src/platform-workspace-view.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import { localAccess, morphzAgentAccess } from "../packages/core/src/model.js";
import {
  parseCognitiveAppObjectLocator,
  type CognitiveAppObjectLocator,
} from "../packages/core/src/cognitive-app-object-locator.js";
import { parseCognitiveAppDefinition } from "../packages/cognitive-app-sdk/src/protocol.js";
import { createAppServer } from "../apps/service/src/http.js";
import { platformMessageFixture } from "./platform-message-fixture.js";

const at = "2026-10-05T01:00:00.000Z";
const original = {
  objectId: "note/原件:001😀",
  versionRef: "0009007199254740993:old😀",
};
const source = (locator?: CognitiveAppObjectLocator) => ({
  id: "input_exact",
  projectId: "first-project",
  conversationId: "first-project",
  author: {
    principalId: localAccess.principalId,
    actantId: localAccess.actantId,
  },
  targetActantId: morphzAgentAccess.actantId,
  body: "讨论原来的版本",
  ...(locator ? { cognitiveObject: locator } : {}),
  createdAt: at,
});
const locator = parseCognitiveAppObjectLocator({
  contentId: "content_exact",
  projectId: "first-project",
  connectionId: "connection_exact",
  authority: {
    appId: "example.notes",
    version: "1.0.0",
    definitionHash: "a".repeat(64),
    instanceId: "instance_exact",
    serviceId: "service/notes",
    dataAuthorityId: "database:notes",
  },
  object: original,
});
const history = (inputs: unknown[]) => ({
  inputs,
  runtime: disconnectedRuntime,
  scriptOutputs: [],
  nextCursor: null,
});

test("UNIT history parser preserves the complete detached opaque locator, never a numeric artifact version", () => {
  const raw = JSON.parse(JSON.stringify(history([source(locator)]))) as {
    inputs: Array<{ cognitiveObject: CognitiveAppObjectLocator }>;
  };
  const parsed = platformHistorySchema.parse(raw);
  assert.deepEqual(parsed.inputs[0]?.cognitiveObject, locator);
  assert.notEqual(
    parsed.inputs[0]?.cognitiveObject,
    raw.inputs[0]!.cognitiveObject,
  );
  assert.equal(parsed.inputs[0]?.artifactId, undefined);
  assert.equal(parsed.inputs[0]?.artifactRevision, undefined);
  assert.equal(
    parsed.inputs[0]?.cognitiveObject?.object.versionRef,
    original.versionRef,
  );
  raw.inputs[0]!.cognitiveObject = {
    ...locator,
    object: { ...original, versionRef: "head" },
  };
  assert.equal(
    parsed.inputs[0]?.cognitiveObject?.object.versionRef,
    original.versionRef,
  );
});

test("UNIT history parser uses the exact Core locator guard and preserves legacy field/unknown-field rules", () => {
  for (const candidate of [
    { ...locator, object: { ...original, versionRef: 2 } },
    {
      ...locator,
      authority: { ...locator.authority, definitionHash: "wrong" },
    },
    { ...locator, privateAlias: "not-a-public-source" },
    { ...locator, object: { ...original, versionRef: "unpaired\ud800" } },
  ])
    assert.equal(
      platformHistorySchema.safeParse(
        history([{ ...source(), cognitiveObject: candidate }]),
      ).success,
      false,
    );
  const legacy = {
    ...source(),
    artifactId: "builtin_content",
    artifactRevision: 2,
    selection: "旧引用",
  };
  assert.deepEqual(
    platformHistorySchema.parse(history([legacy])),
    history([legacy]),
  );
  const optional = platformHistorySchema.parse(
    history([
      {
        ...legacy,
        cognitiveObject: undefined,
        ignoredLegacyMetadata: "unchanged stripping",
      },
    ]),
  );
  assert.equal(optional.inputs[0]?.cognitiveObject, undefined);
  assert.equal("ignoredLegacyMetadata" in optional.inputs[0]!, false);
  assert.equal(optional.inputs[0]?.artifactRevision, 2);
});

/** Actual isolated SQLite, Human ingress, Host HTTP, persistent outbox and
 * RuntimeBridge's production pending-history reader. Dispatch is paused and
 * the Runtime HTTP is controlled: this is not Rust/author-network/GUI proof. */
test(
  "ACTUAL Host HTTP and pending Runtime history retain opaque originals through the typed client and Workspace projection",
  { timeout: 30000 },
  async () => {
    const f = await platformMessageFixture([], {
      browser: true,
      model: "controlled-history-model",
    });
    let database: DatabaseSync | undefined;
    let server: ReturnType<typeof createAppServer> | undefined;
    try {
      const applicationOptions = f.applicationOptions;
      assert.ok(applicationOptions);
      const domain = applicationOptions.platformDocuments;
      assert.ok(domain);
      const definition = parseCognitiveAppDefinition({
        format: "morphz-cognitive-app/v1",
        protocol: "morphz-domain/v1",
        id: "example.notes",
        version: "1.0.0",
        title: "TEST History Notes",
        description: "Metadata-only history fixture",
        icon: "document",
        harness: null,
        ui: null,
        operations: [
          {
            id: "notes.list",
            title: "List",
            description: "Read",
            effect: "read",
            scope: "project",
            inputSchema: { type: "null" },
            outputSchema: { type: "string" },
          },
        ],
      });
      const exact = await domain.authority.withSession(
        localAccess,
        () => {},
        async (actor) => {
          const installed = await domain.platform.installCognitiveApp(actor, {
            definition,
          });
          await domain.platform.changeCognitiveAppGrant(actor, {
            appId: definition.id,
            version: definition.version,
            expectedRevision: 0,
            state: "active",
          });
          // Explicit metadata fixture proof. No author endpoint/credential is used.
          const connection =
            await domain.platform.createVerifiedCognitiveAppConnection(
              actor,
              await prepareConnectionCreation(domain.platform, actor, {
                connectionId: "connection_exact",
                expectedRevision: 0,
                proof: {
                  purpose: "connection-setup",
                  appId: definition.id,
                  version: definition.version,
                  definitionHash: installed.definitionHash,
                  serviceId: "service/notes",
                  dataAuthorityId: "database:notes",
                  hostBindingId: "test_metadata_only",
                },
              }),
            );
          return parseCognitiveAppObjectLocator({
            ...locator,
            authority: {
              ...locator.authority,
              definitionHash: installed.definitionHash,
              instanceId: connection.instanceId,
            },
          });
        },
      );
      database = new DatabaseSync(join(f.directory, "platform.sqlite"));
      database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      database
        .prepare(
          "INSERT INTO content_entries(tenant_id,content_id,app_id,instance_id,app_object_id,project_id,kind,title,observed_version_ref,observed_at,availability,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,'note','TEST exact history','newer-opaque-head',?,'available',1,?,?)",
        )
        .run(
          f.transport.identity(),
          exact.contentId,
          exact.authority.appId,
          exact.authority.instanceId,
          original.objectId,
          exact.projectId,
          at,
          at,
          at,
        );
      const made = await f.session().createPlatformDocument({
        commandId: randomUUID(),
        objectId: "builtin_content",
        projectId: "first-project",
        title: "TEST Legacy History",
        markdown: "内置原件",
      });
      const probe = createServer();
      await new Promise<void>((resolve) =>
        probe.listen(0, "127.0.0.1", resolve),
      );
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      server = createAppServer(f.transport, {
        ...applicationOptions,
        port,
        webRoot: "/nonexistent-test-only",
      });
      await new Promise<void>((resolve) =>
        server!.listen(port, "127.0.0.1", resolve),
      );
      const http = new HttpApplicationClient(`http://127.0.0.1:${port}`);
      const client = await PlatformClient.connect(http);
      const options = { identityGeneration: client.boot.csrfToken };
      const inputIds = {
        plain: randomUUID(),
        builtin: randomUUID(),
        cognitive: randomUUID(),
      };
      const send = async (commandId: string, fields: Record<string, unknown>) =>
        http.call(
          "platform.message",
          {
            commandId,
            operation: {
              type: "record-input",
              projectId: "first-project",
              conversationId: "first-project",
              artifactId: null,
              artifactRevision: null,
              selection: "",
              body: "TEST History input",
              targetActantId: morphzAgentAccess.actantId,
              ...fields,
            },
          },
          options,
        );
      await send(inputIds.plain, {});
      await send(inputIds.builtin, {
        artifactId: made.contentId,
        artifactRevision: 1,
        selection: "内置原件",
      });
      await send(inputIds.cognitive, { cognitiveObject: exact });
      assert.equal(
        f.deliveries().length,
        3,
        "Inputs exist in the actual persistent Host outbox, not injected history rows",
      );
      assert.deepEqual(f.input(inputIds.cognitive).cognitiveObject, exact);
      const scope = {
        projectId: "first-project",
        conversationId: "first-project",
      };
      const received = await http.call("conversations.history", scope, options);
      assert.ok(
        received && typeof received === "object" && "inputs" in received,
      );
      const rawInputs = (
        received as {
          inputs: Array<{
            id: string;
            cognitiveObject?: CognitiveAppObjectLocator;
          }>;
        }
      ).inputs;
      assert.deepEqual(
        rawInputs.find((input) => input.id === inputIds.cognitive)
          ?.cognitiveObject,
        exact,
        "Raw actual HTTP already retains the complete original; the renderer parser is the boundary under test",
      );
      const typed = await client.history(scope.projectId, scope.conversationId);
      assert.deepEqual(
        typed.inputs.find((input) => input.id === inputIds.cognitive)
          ?.cognitiveObject,
        exact,
      );
      const builtin = typed.inputs.find(
        (input) => input.id === inputIds.builtin,
      )!;
      assert.equal(builtin.artifactId, made.contentId);
      assert.equal(builtin.artifactRevision, 1);
      assert.equal(builtin.selection, "内置原件");
      assert.equal(builtin.cognitiveObject, undefined);
      const projected = await readPlatformWorkspace(
        client,
        [],
        1,
        { ...disconnectedRuntime, configured: true },
        undefined,
        undefined,
        { scope },
      );
      const input = projected.workspace.inputs.find(
        (value) => value.id === inputIds.cognitive,
      )!;
      assert.deepEqual(input.cognitiveObject, exact);
      assert.equal(input.artifactId, null);
      assert.equal(input.artifactRevision, null);
      assert.equal(
        projected.catalog.contents.find((entry) => entry.id === exact.contentId)
          ?.observedVersionRef,
        "newer-opaque-head",
      );
      assert.equal(
        projected.workspace.artifacts.some(
          (artifact) => artifact.id === exact.contentId,
        ),
        false,
        "Third-party metadata must not become a builtin artifact/original read",
      );
      const cached = await readPlatformWorkspace(
        client,
        [],
        2,
        { ...disconnectedRuntime, configured: true },
        undefined,
        projected.workspace,
        { scope },
        { scope, version: "same-history", value: projected.history! },
        projected.catalog,
        undefined,
        "same-history",
      );
      assert.deepEqual(
        cached.workspace.inputs.find((value) => value.id === input.id)
          ?.cognitiveObject,
        exact,
      );
      const older = platformHistorySchema.parse({
        ...history([source(exact)]),
        nextCursor: { createdAt: at, id: "input_exact" },
      });
      const merged = mergePlatformHistories(typed, older);
      assert.deepEqual(
        merged.inputs.find((value) => value.id === "input_exact")
          ?.cognitiveObject,
        exact,
      );
      assert.deepEqual(merged.nextCursor, older.nextCursor);
      assert.equal(
        merged.inputs.find((value) => value.id === inputIds.builtin)
          ?.artifactRevision,
        1,
      );
      assert.deepEqual(
        projected.runtime.messages,
        [],
        "Paused dispatch never invents accepted model replies",
      );
      f.assertNoLegacyData();
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      database?.close();
      await f.close();
    }
  },
);
