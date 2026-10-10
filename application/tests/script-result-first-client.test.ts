import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as portProbe } from "node:net";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { scriptStudioApplication } from "../packages/core/src/applications.js";
import { localAccess } from "../packages/core/src/model.js";
import {
  emptyScriptDraft,
  prepareScriptGeneration,
} from "../packages/core/src/script-studio.js";

test("真实 Human HTTP Client 的新输入固定 current；旧无应用输入及持久重试保留原契约", async () => {
  const f = await platformRuntimeHostFixture();
  let server: ReturnType<typeof createAppServer> | undefined;
  try {
    const probe = portProbe();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    server = createAppServer(f.store, {
      port,
      webRoot: "/nonexistent",
      runtime: f.runtime,
      platformWork: f.domains.work,
      platformScripts: f.domains.content,
      platformDocuments: f.domains.content,
    });
    await new Promise<void>((resolve) =>
      server!.listen(port, "127.0.0.1", resolve),
    );
    const cookies = new Map<string, string>();
    const fetchWithCookies: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      if (cookies.size) headers.set("Cookie", [...cookies.values()].join("; "));
      const response = await fetch(url, { ...init, headers });
      for (const cookie of response.headers.getSetCookie()) {
        const value = cookie.split(";")[0]!;
        cookies.set(value.split("=")[0]!, value);
      }
      return response;
    };
    const client = new HttpApplicationClient(
      `http://127.0.0.1:${port}`,
      fetchWithCookies,
    );
    const boot = (await client.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const options = { identityGeneration: boot.csrfToken };
    const original = (await client.call(
      "scripts.create",
      {
        commandId: randomUUID(),
        productionId: randomUUID(),
        projectId: f.projectId,
        title: "TEST HTTP 直接创作契约",
      },
      options,
    )) as { contentId: string; productionId: string };
    const itemId = randomUUID();
    await client.call(
      "scripts.item.create",
      {
        commandId: randomUUID(),
        contentId: original.contentId,
        itemId,
        expectedActivityRevision: 1,
        kind: "outline",
        draft: { ...emptyScriptDraft("大纲"), sources: [] },
      },
      options,
    );
    const snapshot = await f
      .session()
      .readPlatformScriptSnapshot({ contentId: original.contentId });
    const generation = prepareScriptGeneration(snapshot, {
      productionId: original.productionId,
      targetId: itemId,
      baseRevision: 1,
      contextRevision: 1,
      purpose: "draft",
      maxCandidates: 1,
    });
    const frozen = JSON.stringify(generation);
    const base = {
      type: "record-input",
      projectId: f.projectId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "TEST HTTP 生成大纲正文",
      targetActantId: "morphz-agent",
      scriptGeneration: generation,
    };
    const legacyCommand = { commandId: randomUUID(), operation: base };
    const currentCommand = {
      commandId: randomUUID(),
      operation: {
        ...base,
        application: {
          id: scriptStudioApplication.id,
          version: scriptStudioApplication.version,
        },
      },
    };
    const legacy = (await client.call(
      "platform.message",
      legacyCommand,
      options,
    )) as { entityId: string };
    const current = (await client.call(
      "platform.message",
      currentCommand,
      options,
    )) as { entityId: string };
    const studio = f.domains.content.studio!;
    await f.domains.work.authority.withSession(
      localAccess,
      () => {},
      async (actor) => {
        for (const [inputId, submissionMode] of [
          [legacy.entityId, "candidate"],
          [current.entityId, "current"],
        ] as const) {
          const preparation = await studio.readPreparation({
            credential: actor.credential,
            productionId: original.productionId,
            inputId,
          });
          assert.ok(preparation);
          assert.equal(preparation.submissionMode, submissionMode);
          assert.deepEqual(preparation.generation, generation);
        }
      },
    );
    assert.equal(
      JSON.stringify(generation),
      frozen,
      "No new property is injected into immutable Session IO",
    );
    const before = structuredClone(f.store.runtimeState());
    assert.deepEqual(
      await client.call("platform.message", currentCommand, options),
      current,
    );
    assert.deepEqual(f.store.runtimeState(), before);
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
    await f.reopen();
    assert.deepEqual(
      await f.session().platformMessage(currentCommand),
      current,
    );
    assert.deepEqual(f.store.runtimeState(), before);
    await f.domains.work.authority.withSession(
      localAccess,
      () => {},
      async (actor) => {
        const preparation = await f.domains.content.studio!.readPreparation({
          credential: actor.credential,
          productionId: original.productionId,
          inputId: current.entityId,
        });
        assert.ok(preparation);
        assert.equal(preparation.submissionMode, "current");
      },
    );
  } finally {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await f.close();
  }
});
