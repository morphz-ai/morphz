import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

const config = () => ({
  url: "http://127.0.0.1:1",
  token: "test-only",
  namespace: randomUUID(),
});
type Ledger = {
  deliveries: {
    inputId: string;
    state: string;
    request: Record<string, any>;
    resourceUploads?: {
      assetId: string;
      mediaType: string;
      stageId: string;
      dataBase64?: string;
    }[];
  }[];
};
async function recordInput(
  f: Awaited<ReturnType<typeof platformRuntimeHostFixture>>,
  attachments?: { assetId: string; name: string; mime?: string }[],
) {
  return (
    await f.session().platformMessage({
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId: f.projectId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "Inspect the original input",
        targetActantId: "morphz-agent",
        ...(attachments ? { attachments } : {}),
      },
    })
  ).entityId;
}

test("existing outbox requests keep their protocol and fingerprint after reopening", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const inputId = await recordInput(f);
    const state = f.store.runtimeState() as Ledger;
    const oldRequest = {
      text: "Previously persisted legacy request",
      client_message_id: inputId,
      dispatch_mode: "parallel",
    };
    state.deliveries[0]!.request = oldRequest;
    state.deliveries[0]!.state = "failed";
    f.store.saveRuntimeState(state);
    await f.reopen();
    await f.runtime.retryPlatformInput(inputId);
    await recordInput(f);
    const reopened = f.store.runtimeState() as Ledger;
    assert.deepEqual(reopened.deliveries[0]!.request, oldRequest);
    assert.equal(reopened.deliveries[1]!.request.io_version, "1");
    assert.equal(
      reopened.deliveries[1]!.request.message.content.value.text,
      "Inspect the original input",
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("名称统一不重写已排队的旧 typed v2 请求，新输入才采用 Morphz 格式", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const first = await recordInput(f);
    const ledger = f.store.runtimeState() as Ledger;
    ledger.deliveries[0]!.request.message.format = {
      id: "morphzwork.input",
      version: "2",
    };
    ledger.deliveries[0]!.state = "failed";
    const original = JSON.stringify(ledger.deliveries[0]!.request);
    f.store.saveRuntimeState(ledger);
    await f.reopen();
    await f.runtime.retryPlatformInput(first);
    await recordInput(f);
    const next = f.store.runtimeState() as Ledger;
    assert.equal(JSON.stringify(next.deliveries[0]!.request), original);
    assert.deepEqual(next.deliveries[1]!.request.message.format, {
      id: "morphz.application.input",
      version: "1",
    });
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("image messages retain real managed attachment bytes and original text without a prompt prefix", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=";
    const image = Buffer.from(base64, "base64");
    const uploaded = await f
      .session()
      .addAttachment({ name: "image.png", data: image });
    await recordInput(f, [{ ...uploaded, name: "image.png" }]);
    const delivery = (f.store.runtimeState() as Ledger).deliveries[0]!;
    const request = delivery.request;
    assert.equal(
      request.message.content.value.text,
      "Inspect the original input",
    );
    assert.equal(request.io_version, "1");
    assert.equal(delivery.resourceUploads![0]!.assetId, uploaded.assetId);
    assert.equal(delivery.resourceUploads![0]!.dataBase64, undefined);
    assert.equal(delivery.resourceUploads![0]!.mediaType, "image/png");
    assert.deepEqual(request.message.content.value.attachments, [
      { stage_id: delivery.resourceUploads![0]!.stageId },
    ]);
    assert.deepEqual(
      Buffer.from((await f.session().asset(uploaded.assetId, true)).bytes),
      image,
    );
    assert.ok(!JSON.stringify(f.store.runtimeState()).includes(base64));
    await f.reopen();
    assert.deepEqual(
      Buffer.from((await f.session().asset(uploaded.assetId, true)).bytes),
      image,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("read-input resolves only the actual invocation scope, never a model-selected input", async () => {
  const f = await agentDomainFixture();
  try {
    const route = f.input(
      f.projectId,
      "Inspect the original input",
      "quoted (kernel data)",
    );
    const other = f.input(f.projectId, "Different original", "Other quote");
    const request = f.envelope({ action: "read-input" }, route);
    const result = (await f.tools.call(request)) as {
      input: { input_id: string; text: string; selection: string };
    };
    assert.equal(
      result.input.input_id,
      route.thread_id.slice("thread_".length),
    );
    assert.equal(result.input.text, "Inspect the original input");
    assert.equal(result.input.selection, "quoted (kernel data)");
    const otherInput = await f.call<typeof result>(
      { action: "read-input" },
      other,
    );
    assert.equal(otherInput.input.text, "Different original");
    assert.throws(() =>
      f.tools.call({
        ...request,
        arguments: { action: "read-input", inputId: otherInput.input.input_id },
      }),
    );
    await assert.rejects(
      Promise.resolve().then(() =>
        f.tools.call({
          ...request,
          invocation: { ...request.invocation, principal_id: "model-spoof" },
        }),
      ),
      /身份|来源|执行|输入|principal/,
    );
    f.forgetInput(route);
    await assert.rejects(Promise.resolve().then(() => f.tools.call(request)));
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("typed image upload resumes after lost acknowledgements without rewriting or resending accepted work", async () => {
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
      return send(200, {
        enabled: true,
        client_metadata: true,
        resources: true,
      });
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
  const f = await platformRuntimeHostFixture(connection);
  const delivery = () => (f.store.runtimeState() as Ledger).deliveries[0]!;
  try {
    const uploadedAttachment = await f
      .session()
      .addAttachment({ name: "image.png", data: image });
    const input = await recordInput(f, [
      { ...uploadedAttachment, name: "image.png" },
    ]);
    await f.enableDispatch();
    await f.runtime.tick();
    assert.equal(messages, 0, "do not submit before confirming upload");
    assert.equal(delivery().state, "failed");
    for (let retry = 0; retry < 2; retry++) {
      await f.reopen(false);
      await f.runtime.retryPlatformInput(input);
      await f.runtime.tick();
    }
    assert.equal(
      uploads,
      1,
      "lost upload acknowledgement must resume from the server's confirmed offset",
    );
    assert.equal(messages, 2);
    assert.equal(delivery().state, "running");
    assert.ok(
      !JSON.stringify(f.runtime.platformStatus()).includes(
        image.toString("base64"),
      ),
      "private upload bytes never enter UI snapshots",
    );
    assert.ok(
      !JSON.stringify(f.store.runtimeState()).includes(
        image.toString("base64"),
      ),
    );
    assert.deepEqual(
      Buffer.from(
        (await f.session().asset(uploadedAttachment.assetId, true)).bytes,
      ),
      image,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
