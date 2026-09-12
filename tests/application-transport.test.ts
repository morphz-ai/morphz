import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationCall,
  applicationIdentity,
} from "../apps/web/src/application-transport.js";
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
          if (request.method === "workspace") {
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
          if (request.method === "command") commandCalls++;
          return { ok: true, value: {} };
        },
        cancel: () => {},
      },
    },
  });
  try {
    await applicationCall("workspace");
    assert.match(applicationIdentity(), /old/);
    const old = applicationCall("workspace");
    const login = applicationCall("login", { token: "fixture" });
    await assert.rejects(
      applicationCall("command", {}),
      (error) =>
        error instanceof ApplicationRequestError && error.status === 409,
    );
    assert.equal(commandCalls, 0);
    releaseLogin({ ok: true, value: { connected: true } });
    await login;
    assert.equal(loginCalls, 1);
    await applicationCall("workspace");
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
      if (String(url).endsWith("/api/workspace")) {
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
  const old = client.call("workspace");
  await client.call("login", { token: "fixture" });
  release(Response.json({ centerId: "old" }, { headers: { ETag: "old" } }));
  await assert.rejects(
    old,
    (error) => error instanceof ApplicationRequestError && error.status === 408,
  );
  assert.deepEqual(await client.call("workspace"), { centerId: "new" });
  await assert.rejects(
    client.call("command", {}),
    (error) => error instanceof ApplicationRequestError && error.status === 409,
  );
});
