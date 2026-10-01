import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationCall,
  applicationIdentity,
  subscribeConversation,
} from "../apps/web/src/application-transport.js";
import type { ConversationStream } from "../packages/core/src/live-conversation.js";
import {
  HttpApplicationClient,
  ApplicationRequestError,
} from "../packages/core/src/http-application-client.js";

test("界面传输：登录前的迟到快照不能恢复旧身份，切换期间不发送其他操作", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let workspaceCalls = 0,
    loginCalls = 0,
    commandCalls = 0;
  let releaseWorkspace!: (value: any) => void,
    releaseLogin!: (value: any) => void;
  const boot = (name: string) => ({
    centerId: "center",
    principalId: name,
    csrfToken: "generation-" + name,
  });
  Reflect.set(globalThis, "window", {
    morphzDesktop: {
      application: {
        invoke: async (request: any) => {
          if (request.method === "platform.bootstrap") {
            workspaceCalls++;
            if (workspaceCalls === 2)
              return new Promise((resolve) => {
                releaseWorkspace = resolve;
              });
            return {
              ok: true,
              value: boot(workspaceCalls === 1 ? "old" : "new"),
            };
          }
          if (request.method === "login") {
            loginCalls++;
            return new Promise((resolve) => {
              releaseLogin = resolve;
            });
          }
          if (request.method === "documents.create") commandCalls++;
          return { ok: true, value: {} };
        },
        cancel: () => {},
      },
    },
  });
  try {
    await applicationCall("platform.bootstrap");
    assert.match(applicationIdentity(), /old/);
    const old = applicationCall("platform.bootstrap");
    const login = applicationCall("login", { token: "fixture" });
    await assert.rejects(
      applicationCall("documents.create", {}),
      (error) =>
        error instanceof ApplicationRequestError && error.status === 409,
    );
    assert.equal(commandCalls, 0);
    releaseLogin({ ok: true, value: { connected: true } });
    await login;
    assert.equal(loginCalls, 1);
    await applicationCall("platform.bootstrap");
    releaseWorkspace({ ok: true, value: boot("old") });
    await assert.rejects(
      old,
      (error) => error instanceof DOMException && error.name === "AbortError",
    );
    assert.equal(applicationIdentity(), "center:new:generation-new");
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("HTTP 适配器不缓存跨身份的迟到快照，错误状态保留给稳定命令重试", async () => {
  let workspaceCalls = 0;
  let release!: (response: Response) => void;
  const client = new HttpApplicationClient(
    "https://fixture.example",
    async (url, init) => {
      if (String(url).endsWith("/api/platform/bootstrap")) {
        workspaceCalls++;
        if (workspaceCalls === 1)
          return new Promise((resolve) => {
            release = resolve;
          });
        assert.ok(!(init?.headers as Record<string, string>)["If-None-Match"]);
        return Response.json({ centerId: "new" }, { headers: { ETag: "new" } });
      }
      if (String(url).endsWith("/api/identity/login"))
        return Response.json({ connected: true });
      return Response.json({ message: "revision conflict" }, { status: 409 });
    },
  );
  const old = client.call("platform.bootstrap");
  await client.call("login", { token: "fixture" });
  release(Response.json({ centerId: "old" }, { headers: { ETag: "old" } }));
  await assert.rejects(
    old,
    (error) => error instanceof ApplicationRequestError && error.status === 408,
  );
  assert.deepEqual(await client.call("platform.bootstrap"), { centerId: "new" });
  await assert.rejects(
    client.call("documents.revise", {}),
    (error) => error instanceof ApplicationRequestError && error.status === 409,
  );
});

test("Platform 对话历史按项目和对话定位，不从旧 workspace 获取", async () => {
  const paths: string[] = [];
  const client = new HttpApplicationClient(
    "https://fixture.example",
    async (url, init) => {
      paths.push(String(url));
      assert.equal(init?.method, "GET");
      return Response.json({
        inputs: [],
        runtime: { messages: [], deliveries: [] },
      });
    },
  );
  assert.deepEqual(
    await client.call("conversations.history", {
      projectId: "work-one",
      conversationId: "conversation-two",
    }),
    { inputs: [], runtime: { messages: [], deliveries: [] } },
  );
  await client.call("conversations.history", {
    projectId: "work-one",
    conversationId: "conversation-two",
    before: { createdAt: "2026-09-28T00:00:00.000Z", id: "input-2" },
  });
  assert.deepEqual(paths, [
    "https://fixture.example/api/platform/projects/work-one/conversations/conversation-two/history",
    "https://fixture.example/api/platform/projects/work-one/conversations/conversation-two/history?beforeCreatedAt=2026-09-28T00%3A00%3A00.000Z&beforeId=input-2",
  ]);
  await assert.rejects(
    client.call("conversations.history", {
      projectId: "../outside",
      conversationId: "conversation-two",
    }),
    (error) => error instanceof ApplicationRequestError && error.status === 400,
  );
});

test("图片命令的 HTTP 适配器走正式 Images 路由", async () => {
  const paths: string[] = [];
  const client = new HttpApplicationClient(
    "https://fixture.example",
    async (url, init) => {
      paths.push(`${init?.method} ${String(url)}`);
      return Response.json({ contentId: "image-content" });
    },
  );
  const input = {
    commandId: "command-one",
    objectId: "image-one",
    projectId: "project-one",
    title: "图片",
    assetId: "a".repeat(64),
    alt: "说明",
  };
  await client.call("images.create", input);
  await client.call("images.revise", {
    commandId: "command-two",
    contentId: "image-content",
    expectedRevision: 1,
    title: "图片",
    assetId: input.assetId,
    alt: "新说明",
  });
  assert.deepEqual(paths, [
    "POST https://fixture.example/api/platform/images",
    "POST https://fixture.example/api/platform/images/revise",
  ]);
});

test("Desktop 流短暂断开和空快照不擦掉已显示正文，正式回执去重，取消订阅不接收迟到帧", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let listener!: (value: any) => void;
  let id = "",
    updates = 0;
  let subscribedScope: unknown;
  let current: ConversationStream = { connected: false, messages: [] };
  Reflect.set(globalThis, "window", {
    morphzDesktop: {
      application: {
        subscribe: async (value: string, scope: unknown) => {
          id = value;
          subscribedScope = scope;
        },
        unsubscribe: () => {},
        onStream: (value: typeof listener) => {
          listener = value;
          return () => {};
        },
      },
    },
  });
  const close = subscribeConversation(
    { projectId: "desk", conversationId: "conversation" },
    (value) => {
      current = value;
      updates++;
    },
  );
  const message = {
    id: "stream:attempt",
    publicationKey: "attempt",
    projectId: "desk",
    conversationId: "conversation",
    inputId: "input",
    rootId: "root",
    artifactId: null,
    createdAt: "2026-09-20T00:00:00Z",
    text: "已经读到的正文",
    kind: "reply",
    streaming: true,
  };
  try {
    assert.deepEqual(subscribedScope, {
      projectId: "desk",
      conversationId: "conversation",
      kind: "platform",
    });
    listener({ id, value: { connected: true, messages: [message] } });
    listener({ id, closed: true });
    assert.equal(current.messages[0]!.text, message.text);
    assert.equal(current.messages[0]!.streaming, false);
    listener({ id, value: { connected: true, messages: [] } });
    assert.equal(current.messages[0]!.text, message.text);
    listener({
      id,
      value: {
        connected: true,
        messages: [
          {
            ...message,
            id: "durable",
            sequence: 42,
            streaming: undefined,
            text: "完整正式正文",
          },
        ],
      },
    });
    assert.equal(current.messages.length, 1);
    assert.equal(current.messages[0]!.id, "durable");
    assert.equal(current.messages[0]!.text, "完整正式正文");
    close();
    const before = updates;
    listener({ id, value: { connected: true, messages: [message] } });
    assert.equal(updates, before);
  } finally {
    close();
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("Web 消息流只订阅 Platform 的项目会话入口", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousEventSource = Object.getOwnPropertyDescriptor(
    globalThis,
    "EventSource",
  );
  let subscribedUrl = "";
  let closed = false;
  class FakeEventSource {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      subscribedUrl = url;
    }
    close() {
      closed = true;
    }
  }
  Reflect.set(globalThis, "window", {});
  Reflect.set(globalThis, "EventSource", FakeEventSource);
  try {
    const close = subscribeConversation(
      { projectId: "project one", conversationId: "chat/two" },
      () => {},
    );
    assert.equal(
      subscribedUrl,
      "/api/platform/projects/project%20one/conversations/chat%2Ftwo/stream",
    );
    close();
    assert.equal(closed, true);
  } finally {
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousEventSource)
      Object.defineProperty(globalThis, "EventSource", previousEventSource);
    else Reflect.deleteProperty(globalThis, "EventSource");
  }
});
