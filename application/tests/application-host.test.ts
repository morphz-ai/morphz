import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import type { RuntimeBridge } from "../packages/application/src/runtime.js";
import type { LocalFiles } from "../packages/application/src/local-files.js";
import type { ReaderOcr } from "../packages/application/src/reader-ocr.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { localAccess } from "../packages/core/src/model.js";
import type {
  ApplicationMethod,
  ApplicationReply,
} from "../packages/core/src/application-api.js";
import { createAppServer } from "../apps/service/src/http.js";
import { emptyPlatformStream } from "./platform-stream-fixture.js";

function value(reply: ApplicationReply): any {
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.ok ? reply.value : undefined;
}
function failure(reply: ApplicationReply, status: number) {
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.error.status, status, reply.error.message);
}
const invoke = (
  host: LocalApplicationConnection,
  method: ApplicationMethod,
  params?: unknown,
  identityGeneration?: string,
) => host.invoke({ id: randomUUID(), method, params, identityGeneration });

test("缺少领域配置时，读取、字节写入、文件授权和执行操作不回退到旧库", async () => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const legacy = () => {
    throw new Error("不得调用旧工作区或字节接口");
  };
  const unavailableLegacy = new Set([
    "snapshot",
    "addAsset",
    "addAttachment",
    "visibleAsset",
    "attachmentAsset",
  ]);
  const guardedStore = new Proxy(store, {
    get(target, property) {
      if (typeof property === "string" && unavailableLegacy.has(property))
        return legacy;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtime = {
    teamIdentity: false,
    as: legacy,
  } as unknown as RuntimeBridge;
  const host = new LocalApplicationConnection(
    new Application(guardedStore, {
      runtime,
      localFiles: {} as LocalFiles,
      readerOcr: { call: legacy } as unknown as ReaderOcr,
    }),
  );
  try {
    const boot = value(await invoke(host, "platform.bootstrap"));
    const scope = { projectId: "old-project", conversationId: "old-project" };
    const execution = { ...scope, artifactId: null };
    const cases: [ApplicationMethod, unknown][] = [
      ["asset.add", new Uint8Array([0])],
      ["attachment.add", { name: "未保存.txt", data: new Uint8Array([0]) }],
      ["directories.scope", scope],
      ["directories.list", scope],
      [
        "local-files.read",
        { projectId: scope.projectId, grantId: randomUUID() },
      ],
      ["reader.ocr", {}],
      ["input.send", "old-input"],
      ["input.cancel", "old-input"],
      ["execution.snapshot", execution],
      ["execution.result", { scope: execution, jobId: "old-job" }],
      [
        "execution.control",
        {
          scope: execution,
          action: { type: "cancel-job", jobId: "old-job", revision: 1 },
        },
      ],
    ];
    for (const [method, params] of cases) {
      const reply = await invoke(host, method, params, boot.csrfToken);
      failure(reply, 503);
      if (!reply.ok) assert.equal(reply.error.code, "unavailable", method);
    }
    for (const type of ["assets", "attachments"] as const)
      await assert.rejects(
        host.resource(type, "a".repeat(64)),
        (error: unknown) =>
          error instanceof Error && /存储不可用/.test(error.message),
      );
  } finally {
    host.close();
    store.close();
  }
});

test("共享业务层：本地调用与 Web HTTP 复用同一命令回执、修订与文件权限", async () => {
  assert.match(createAppServer.toString(), /new Application/);
  const directory = mkdtempSync(join(tmpdir(), "morphz-shared-platform-host-"));
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"), {
    mode: "transport",
  });
  const domains = await openApplicationDomainsHost(directory, store);
  const domainOptions = {
    platformWork: domains.work,
    platformDocuments: domains.content,
    images: domains.images,
  };
  const host = new LocalApplicationConnection(
    new Application(store, domainOptions),
  );
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const server = createAppServer(store, {
    port,
    webRoot: "/nonexistent",
    ...domainOptions,
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${port}`;
  try {
    const local = value(await invoke(host, "platform.bootstrap"));
    const remote = await (
      await fetch(origin + "/api/platform/bootstrap")
    ).json();
    assert.equal(local.centerId, remote.centerId);
    assert.equal(local.principalId, remote.principalId);
    const spaces = value(
      await invoke(host, "spaces.ensure", undefined, local.csrfToken),
    );
    const request = {
      commandId: randomUUID(),
      objectId: `document_${randomUUID().replaceAll("-", "")}`,
      projectId: spaces.deskId,
      title: "共享业务验收",
      markdown: "两个宿主，同一回执",
    };
    const receipt = value(
      await invoke(host, "documents.create", request, local.csrfToken),
    );
    const post = (data: unknown, path = "/api/platform/documents") =>
      fetch(origin + path, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Morphz-Token": remote.csrfToken,
        },
        body: JSON.stringify(data),
      });
    assert.deepEqual(await (await post(request)).json(), receipt);
    const artifact = value(
      await invoke(
        host,
        "documents.read",
        { contentId: receipt.contentId, revision: 1 },
        local.csrfToken,
      ),
    );
    assert.deepEqual(
      await (
        await fetch(
          origin +
            "/api/platform/documents/" +
            receipt.contentId +
            "?revision=1",
        )
      ).json(),
      artifact,
    );
    const stale = {
      commandId: randomUUID(),
      contentId: receipt.contentId,
      expectedRevision: 99,
      title: "冲突",
      markdown: "不应写入",
    };
    // Stale revisions receive identical conflict responses; neither host mutates state.
    failure(
      await invoke(host, "documents.revise", stale, local.csrfToken),
      409,
    );
    assert.equal(
      (await post(stale, "/api/platform/documents/revise")).status,
      409,
    );
    assert.deepEqual(
      value(
        await invoke(
          host,
          "documents.read",
          { contentId: receipt.contentId, revision: 1 },
          local.csrfToken,
        ),
      ),
      artifact,
    );
    const uploaded = value(
      await invoke(
        host,
        "asset.add",
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]),
        local.csrfToken,
      ),
    );
    await assert.rejects(
      async () => host.resource("assets", uploaded.assetId),
      /图片不存在或无权访问/,
    );
    assert.equal(
      (await fetch(origin + "/api/assets/" + uploaded.assetId)).status,
      404,
    );
    failure(
      await host.invoke({
        id: randomUUID(),
        method: "documents.create",
        params: request,
        principalId: "forged",
        identityGeneration: local.csrfToken,
      }),
      400,
    );
    failure(
      await host.invoke({ id: randomUUID(), method: "sql", params: "DELETE" }),
      400,
    );
  } finally {
    host.close();
    server.closeStreams();
    await new Promise<void>((r) => server.close(() => r()));
    await domains.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("本地桥：身份由主进程持有，旧请求、越权读取、退出和撤销都失败", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-local-identity-"));
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"), {
    mode: "transport",
  });
  const other = { principalId: "other", actantId: "other-human" };
  const tokens = ["a".repeat(64), "b".repeat(64)];
  const config = {
    version: 1,
    members: [localAccess, other].map((access, i) => ({
      ...access,
      loginTokenHash: createHash("sha256").update(tokens[i]!).digest("hex"),
      enabled: true,
    })),
  };
  const identity = new IdentityCenter(store, config);
  const domains = await openApplicationDomainsHost(directory, store, identity);
  const domainOptions = {
    identity,
    platformWork: domains.work,
    platformDocuments: domains.content,
  };
  const host = new LocalApplicationConnection(
    new Application(store, domainOptions),
  );
  try {
    failure(await invoke(host, "platform.bootstrap"), 401);
    value(await invoke(host, "login", { token: tokens[0] }));
    const first = value(await invoke(host, "platform.bootstrap"));
    const spaces = value(
      await invoke(host, "spaces.ensure", undefined, first.csrfToken),
    );
    const privateId = value(
      await invoke(
        host,
        "documents.create",
        {
          commandId: randomUUID(),
          objectId: randomUUID(),
          projectId: spaces.deskId,
          title: "私有对象",
          markdown: "不可泄露",
        },
        first.csrfToken,
      ),
    ).contentId;
    assert.equal(
      value(
        await invoke(
          host,
          "documents.read",
          { contentId: privateId, revision: 1 },
          first.csrfToken,
        ),
      ).markdown,
      "不可泄露",
    );
    value(await invoke(host, "login", { token: tokens[1] }));
    const second = value(await invoke(host, "platform.bootstrap"));
    assert.equal(second.principalId, other.principalId);
    assert.ok(!JSON.stringify(second).includes("不可泄露"));
    failure(
      await invoke(
        host,
        "documents.read",
        { contentId: privateId, revision: 1 },
        first.csrfToken,
      ),
      403,
    );
    failure(
      await invoke(
        host,
        "documents.read",
        { contentId: privateId, revision: 1 },
        second.csrfToken,
      ),
      404,
    );
    const restored = new LocalApplicationConnection(
      new Application(store, domainOptions),
      host.authenticationCookie(),
    );
    assert.equal(
      value(await invoke(restored, "platform.bootstrap")).principalId,
      other.principalId,
    );
    restored.close();
    await identity.replaceConfiguration({
      ...config,
      members: config.members.map((m) => ({
        ...m,
        enabled: m.principalId !== other.principalId,
      })),
    });
    failure(await invoke(host, "platform.bootstrap"), 401);
    value(await invoke(host, "login", { token: tokens[0] }));
    const next = value(await invoke(host, "platform.bootstrap"));
    value(await invoke(host, "logout", undefined, next.csrfToken));
    failure(await invoke(host, "platform.bootstrap"), 401);
  } finally {
    host.close();
    await domains.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("本地桥：取消传到提供方，迟到结果不返回，失效后关闭订阅且不写入", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-speech-cancel-"));
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"), {
    mode: "transport",
  });
  const domains = await openApplicationDomainsHost(directory, store);
  await domains.work.authority.withSession(
    localAccess,
    () => {},
    (actor) =>
      domains.work.service.createProject(actor, {
        commandId: randomUUID(),
        projectId: "platform-speech-only",
        title: "听写项目",
      }),
  );
  let release!: (s: string) => void;
  let providerSignal: AbortSignal | undefined;
  let providerStarted!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => {
    providerStarted = resolve;
  });
  const speech = {
    provider: { id: "fixture", label: "Fixture" },
    configured: () => true,
    transcribe: async (
      _principal: string,
      _wav: Uint8Array,
      signal: AbortSignal,
    ) => {
      providerSignal = signal;
      providerStarted(signal);
      return new Promise<string>((r) => {
        release = r;
      });
    },
    synthesize: async () => Buffer.from([]),
  };
  const host = new LocalApplicationConnection(
    new Application(store, {
      speech,
      platformWork: domains.work,
      runtime: emptyPlatformStream(domains, { teamIdentity: false }),
    }),
  );
  try {
    const boot = value(await invoke(host, "platform.bootstrap"));
    const id = randomUUID();
    const pending = host.invoke({
      id,
      method: "speech.transcribe",
      params: {
        scope: { projectId: "platform-speech-only" },
        data: new Uint8Array([0]),
      },
      identityGeneration: boot.csrfToken,
    });
    const signalFromProvider = await Promise.race([
      started,
      pending.then((reply) => {
        throw new Error(JSON.stringify(reply));
      }),
    ]);
    assert.equal(signalFromProvider, providerSignal);
    host.cancel(id);
    assert.ok(signalFromProvider.aborted);
    release("迟到文字");
    failure(await pending, 408);
    let closed = 0,
      events = 0;
    await assert.rejects(
      host.observe(
        randomUUID(),
        { projectId: "first-project", conversationId: "first-project" },
        boot.csrfToken,
        () => events++,
        () => closed++,
      ),
      ZodError,
    );
    assert.equal(events, 0);
    const spaces = value(
      await invoke(host, "spaces.ensure", undefined, boot.csrfToken),
    );
    await host.observe(
      randomUUID(),
      {
        kind: "platform",
        projectId: spaces.dialogueId,
        conversationId: spaces.dialogueId,
      },
      boot.csrfToken,
      () => events++,
      () => closed++,
    );
    assert.equal(events, 1);
    const before = value(
      await invoke(host, "projects.list", { status: "all" }, boot.csrfToken),
    );
    host.invalidate();
    assert.equal(closed, 1);
    failure(
      await invoke(
        host,
        "projects.create",
        {
          commandId: randomUUID(),
          projectId: "stale-identity-project",
          title: "不会保存",
        },
        boot.csrfToken,
      ),
      403,
    );
    const next = value(await invoke(host, "platform.bootstrap"));
    assert.deepEqual(
      value(
        await invoke(host, "projects.list", { status: "all" }, next.csrfToken),
      ),
      before,
    );
  } finally {
    host.close();
    await domains.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
