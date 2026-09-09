import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { RuntimeBridge } from "../apps/service/src/runtime.js";
import { AgentTools } from "../apps/service/src/agent-tools.js";
import { localAccess } from "../packages/core/src/model.js";

const config = () => ({
  url: "http://127.0.0.1:1",
  token: "test-only",
  namespace: randomUUID(),
});
type Ledger = {
  deliveries: {
    inputId: string;
    request: Record<string, any>;
    resourceUploads?: {
      dataBase64: string;
      mediaType: string;
      stageId: string;
    }[];
  }[];
};
function recordInput(
  store: WorkspaceStore,
  artifactId: string | null = null,
  selection = "",
) {
  return store.execute(
    {
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId: "first-project",
        artifactId,
        artifactRevision: artifactId ? 1 : null,
        selection,
        body: "Inspect the original input",
        targetActantId: "morphz-agent",
      },
    },
    localAccess,
  ).entityId;
}

test("existing outbox requests keep their protocol and fingerprint after reopening", async () => {
  const store = new WorkspaceStore(":memory:");
  const connection = config();
  let bridge = new RuntimeBridge(store, connection);
  try {
    const inputId = recordInput(store);
    bridge.enqueue(inputId);
    const state = store.runtimeState() as Ledger;
    const oldRequest = {
      text: "Previously persisted legacy request",
      client_message_id: inputId,
      dispatch_mode: "parallel",
    };
    state.deliveries[0]!.request = oldRequest;
    store.saveRuntimeState(state);
    await bridge.stop();
    // Restore the simulated old durable ledger after stopping the first bridge.
    store.saveRuntimeState(state);
    bridge = new RuntimeBridge(store, connection);
    bridge.enqueue(inputId);
    const second = recordInput(store);
    bridge.enqueue(second);
    const reopened = store.runtimeState() as Ledger;
    assert.deepEqual(reopened.deliveries[0]!.request, oldRequest);
    assert.equal(reopened.deliveries[1]!.request.io_version, "1");
    assert.equal(
      reopened.deliveries[1]!.request.message.content.value.text,
      "Inspect the original input",
    );
  } finally {
    await bridge.stop();
    store.close();
  }
});

test("images retain real attachment bytes and original text without a prompt prefix", async () => {
  const store = new WorkspaceStore(":memory:");
  const bridge = new RuntimeBridge(store, config());
  try {
    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=";
    const { assetId } = store.addAsset(Buffer.from(base64, "base64"));
    const artifactId = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "Image",
          content: { kind: "image", assetId, alt: "fixture" },
        },
      },
      localAccess,
    ).entityId;
    bridge.enqueue(recordInput(store, artifactId));
    const delivery = (store.runtimeState() as Ledger).deliveries[0]!;
    const request = delivery.request;
    assert.equal(
      request.message.content.value.text,
      "Inspect the original input",
    );
    assert.equal(request.io_version, "1");
    assert.equal(delivery.resourceUploads![0]!.dataBase64, base64);
    assert.equal(delivery.resourceUploads![0]!.mediaType, "image/png");
    assert.deepEqual(request.message.content.value.attachments, [
      { stage_id: delivery.resourceUploads![0]!.stageId },
    ]);
    assert.ok(!JSON.stringify(request).includes(base64));
  } finally {
    await bridge.stop();
    store.close();
  }
});

test("read-input resolves only the actual invocation scope, never a model-selected input", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const artifactId = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "Quoted text",
          content: { kind: "document", markdown: "quoted (kernel data)" },
        },
      },
      localAccess,
    ).entityId;
    const inputId = recordInput(store, artifactId, "quoted (kernel data)");
    let boundInput: string | undefined = inputId;
    const tools = new AgentTools(store, "test-only", () => ({
      projectId: "first-project",
      inputId: boundInput,
      access: { principalId: "morphz-service", actantId: "morphz-agent" },
    }));
    const request = {
      protocol: 1,
      tool: "host_morphz_work",
      invocation: {
        job_id: "test-job",
        tool_call_id: "test-call",
        session_id: "test-session",
        context_id: "test-context",
        principal_id: "test-principal",
        agent_id: "test-agent",
        target_id: "local",
        thread_id: "test-thread",
      },
      arguments: { action: "read-input" },
    };
    const result = tools.call(request) as {
      input: { input_id: string; text: string; selection: string };
    };
    assert.equal(result.input.input_id, inputId);
    assert.equal(result.input.text, "Inspect the original input");
    assert.equal(result.input.selection, "quoted (kernel data)");
    boundInput = undefined;
    assert.throws(() => tools.call(request), /原始输入/);
    assert.throws(() =>
      tools.call({ ...request, arguments: { action: "read-input", inputId } }),
    );
  } finally {
    store.close();
  }
});

test("typed image upload resumes after lost acknowledgements without rewriting or resending accepted work", async () => {
  const store = new WorkspaceStore(":memory:");
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=",
    "base64",
  );
  const sessions = new Map<string, { id: string; context_id: string }>();
  let declared: { sha: string; stage: string; client: string } | undefined;
  let uploaded: Buffer | undefined;
  let uploads = 0,
    messages = 0;
  let accepted: string | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body =
      request.headers["content-type"] === "application/json" && bytes.length
        ? JSON.parse(bytes.toString())
        : null;
    const path = new URL(request.url!, "http://localhost").pathname;
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
    };
    assert.equal(request.headers.authorization, "Bearer test-only");
    if (path === "/api/status") return send(200, { model: "fixture" });
    if (path === "/api/session-io/capabilities")
      return send(200, { enabled: true, resources: true });
    if (path === "/api/sessions" && request.method === "POST") {
      const session = { id: body.id, context_id: body.mount.context_id };
      sessions.set(session.id, session);
      return send(201, session);
    }
    const session = sessions.get(path.split("/")[3]!);
    if (path.endsWith("/principal"))
      return send(200, {
        principal_id: "fixture-user",
        session_id: session!.id,
        context_id: session!.context_id,
      });
    if (path.endsWith("/attachment-stages") && request.method === "POST") {
      if (declared) {
        assert.equal(body.stage_id, declared.stage);
        assert.equal(body.expected_sha256, declared.sha);
      }
      declared = {
        sha: body.expected_sha256,
        stage: body.stage_id,
        client: body.client_message_id,
      };
      return send(200, {
        offset: uploaded?.length ?? 0,
        status: uploaded ? "ready" : "uploading",
        sha256: uploaded ? declared.sha : null,
      });
    }
    if (path.endsWith("/content") && request.method === "PUT") {
      uploads++;
      assert.equal(request.headers["x-morphz-upload-offset"], "0");
      uploaded = bytes;
      assert.deepEqual(uploaded, image);
      return send(500, { error: "lost upload acknowledgement" });
    }
    if (path.endsWith("/io/messages")) {
      messages++;
      assert.deepEqual(uploaded, image);
      assert.equal(body.client_message_id, declared!.client);
      assert.deepEqual(body.message.content.value.attachments, [
        { stage_id: declared!.stage },
      ]);
      assert.equal(
        body.message.content.value.text,
        "Inspect the original input",
      );
      if (!accepted) {
        accepted = JSON.stringify(body);
        return send(500, { error: "lost input acknowledgement" });
      }
      assert.equal(JSON.stringify(body), accepted);
      return send(200, { accepted: true, event_id: "image-root" });
    }
    if (path.endsWith("/events")) return send(200, { events: [] });
    return send(session ? 200 : 404, session ?? {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connection = {
    ...config(),
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
  let bridge = new RuntimeBridge(store, connection);
  try {
    const { assetId } = store.addAsset(image);
    const artifact = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "Image",
          content: { kind: "image", assetId, alt: "fixture" },
        },
      },
      localAccess,
    ).entityId;
    const input = recordInput(store, artifact);
    bridge.enqueue(input);
    await bridge.tick();
    assert.equal(messages, 0, "do not submit before confirming upload");
    assert.equal(bridge.snapshot().deliveries[0]!.state, "failed");
    for (let retry = 0; retry < 2; retry++) {
      await bridge.stop();
      bridge = new RuntimeBridge(store, connection);
      bridge.enqueue(input);
      await bridge.tick();
    }
    assert.equal(
      uploads,
      1,
      "lost upload acknowledgement must resume from the server's confirmed offset",
    );
    assert.equal(messages, 2);
    assert.equal(bridge.snapshot().deliveries[0]!.state, "running");
    assert.ok(
      !JSON.stringify(bridge.snapshot()).includes(image.toString("base64")),
      "private upload bytes never enter UI snapshots",
    );
  } finally {
    await bridge.stop();
    store.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
