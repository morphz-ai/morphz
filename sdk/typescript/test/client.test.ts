import assert from "node:assert/strict";
import test from "node:test";
import { MorphzClient, MorphzHttpError } from "../src/index.ts";

test("every Session request carries the trusted Principal separately from content", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new MorphzClient({
    baseUrl: "https://runtime.example/v1/..",
    serviceToken: "service-secret",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        accepted: true,
        duplicate: false,
        event_id: "event-1",
        client_message_id: "message-1",
      });
    },
  });

  await client.sendMessage(
    { id: "site-user-42", displayName: "Alice" },
    "session-a",
    "I am somebody else",
    "message-1",
  );

  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("authorization"), "Bearer service-secret");
  assert.equal(headers.get("x-morphz-principal"), "site-user-42");
  assert.equal(headers.get("x-morphz-principal-name"), "Alice");
  assert.match(String(calls[0].init?.body), /somebody else/);
});

test("structured HTTP errors preserve the stable SDK code", async () => {
  const client = new MorphzClient({
    baseUrl: "https://runtime.example",
    fetch: async () =>
      Response.json(
        { error: { code: "forbidden", message: "not your session" } },
        { status: 403 },
      ),
  });
  await assert.rejects(
    () => client.getSession({ id: "site-user-b" }, "session-a"),
    (error: unknown) =>
      error instanceof MorphzHttpError &&
      error.status === 403 &&
      error.code === "forbidden",
  );
});

test("WebSocket URL carries service credential and Principal for the handshake", () => {
  const client = new MorphzClient({
    baseUrl: "https://runtime.example",
    serviceToken: "secret",
  });
  const url = new URL(
    client.sessionWebSocketUrl({ id: "site-user-7" }, "session/with space"),
  );
  assert.equal(url.protocol, "wss:");
  assert.equal(url.searchParams.get("session_id"), "session/with space");
  assert.equal(url.searchParams.get("principal_id"), "site-user-7");
  assert.equal(url.searchParams.get("token"), "secret");
});

test("Context control calls use service authority while Session mutations carry Principal", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new MorphzClient({
    baseUrl: "https://runtime.example",
    serviceToken: "service-secret",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ id: "record-1", agent_id: "agent-1", title: "record" });
    },
  });

  await client.createContext({ title: "shared" });
  await client.updateSession(
    { id: "site-user-42" },
    "session-a",
    { title: "renamed" },
  );

  const contextHeaders = new Headers(calls[0].init?.headers);
  assert.equal(contextHeaders.get("authorization"), "Bearer service-secret");
  assert.equal(contextHeaders.get("x-morphz-principal"), null);
  const sessionHeaders = new Headers(calls[1].init?.headers);
  assert.equal(sessionHeaders.get("x-morphz-principal"), "site-user-42");
  assert.equal(calls[1].init?.method, "PATCH");
});

test("Session list unwraps the HTTP collection envelope", async () => {
  const client = new MorphzClient({
    baseUrl: "https://runtime.example",
    fetch: async () =>
      Response.json({
        sessions: [
          {
            id: "session-a",
            agent_id: "agent-a",
            context_id: "context-a",
            title: "A",
            status: "active",
          },
        ],
      }),
  });
  const sessions = await client.listSessions({ id: "site-user-42" });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "session-a");
});

test("attachment staging keeps binary bytes out of JSON and preserves draft identity", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const stage = {
    stage_id: "stage-1",
    principal_id: "site-user-42",
    session_id: "session-a",
    client_message_id: "message-1",
    name: "manual.pdf",
    media_type: "application/pdf",
    size_bytes: 3,
    offset: 3,
    sha256: "a".repeat(64),
    status: "ready" as const,
    created_at: "2026-09-02T00:00:00Z",
    expires_at: "2026-09-09T00:00:00Z",
  };
  const client = new MorphzClient({
    baseUrl: "https://runtime.example",
    serviceToken: "service-secret",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (String(url).includes("client_message_id="))
        return Response.json({ stages: [stage] });
      return Response.json(stage);
    },
  });
  const principal = { id: "site-user-42" };

  await client.createMessageAttachmentStage(principal, "session-a", {
    stage_id: "stage-1",
    client_message_id: "message-1",
    name: "manual.pdf",
    media_type: "application/pdf",
    size_bytes: 3,
  });
  const bytes = new Uint8Array([1, 2, 3]);
  await client.uploadMessageAttachmentStage(
    principal,
    "session-a",
    "stage-1",
    0,
    bytes,
  );
  const listed = await client.listMessageAttachmentStages(
    principal,
    "session-a",
    "message-1",
  );
  await client.cancelMessageAttachmentStage(principal, "session-a", "stage-1");

  assert.equal(listed[0].client_message_id, "message-1");
  const upload = calls[1];
  const uploadHeaders = new Headers(upload.init?.headers);
  assert.equal(upload.init?.method, "PUT");
  assert.equal(uploadHeaders.get("content-type"), "application/octet-stream");
  assert.equal(uploadHeaders.get("x-morphz-upload-offset"), "0");
  assert.equal(upload.init?.body, bytes);
  assert.equal(uploadHeaders.get("x-morphz-principal"), "site-user-42");
  assert.match(calls[2].url, /client_message_id=message-1/);
});
