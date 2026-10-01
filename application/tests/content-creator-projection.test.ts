import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { localAccess } from "../packages/core/src/model.js";
import type {
  ApplicationCaller,
  ApplicationMethod,
} from "../packages/core/src/application-api.js";
import {
  PlatformClient,
  type PlatformContent,
} from "../apps/web/src/platform-client.js";
import { readContentArtifact } from "../apps/web/src/platform-workspace-view.js";
import { contentOrigin } from "../apps/web/src/content-catalog.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

type Fixture = Awaited<ReturnType<typeof agentDomainFixture>>;
type ReadCall = { method: ApplicationMethod; params?: unknown };

async function connect(
  f: Fixture,
  calls: ReadCall[],
  afterRead?: (method: ApplicationMethod) => Promise<void>,
  loginToken?: string,
) {
  const connection = new LocalApplicationConnection(
    new Application(f.transport, {
      identity: f.identity,
      platformWork: f.domains.work,
      platformDocuments: f.domains.content,
      platformReader: f.domains.reader,
    }),
  );
  if (f.identity)
    await connection.call("login", {
      token: loginToken,
    });
  // Observe the actual authorized application calls; neither originals nor
  // version metadata are replaced by a fixture response.
  const caller: ApplicationCaller = {
    async call(method, params, options) {
      calls.push({ method, params });
      const value = await connection.call(method, params, options);
      await afterRead?.(method);
      return value;
    },
  };
  return { client: await PlatformClient.connect(caller), connection };
}

test("Agent 原件的创建归属不被 Human 编辑、改名、撤销覆盖；分页、历史、伴读与重启保持", async () => {
  const f = await agentDomainFixture();
  const calls: ReadCall[] = [];
  let connected: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const originalTitle = "A Agent 原件";
    const result = await f.call<{ contentId: string }>({
      action: "create-document",
      title: originalTitle,
      markdown: "Agent 初版正文。",
    });
    connected = await connect(f, calls);
    let { client } = connected;
    const entry = async () => {
      const [value] = await client.contentByIds([result.contentId]);
      assert.ok(value);
      return value;
    };
    calls.length = 0;
    const first = await readContentArtifact(client, await entry());
    assert.ok(first);
    const creator = first.createdBy;
    const createdAt = first.createdAt;
    assert.equal(creator.actantId, f.agentAccess.actantId);
    assert.equal(creator.principalId, localAccess.principalId);
    assert.equal(
      calls.filter((call) => call.method === "objects.read").length,
      1,
    );
    assert.equal(
      calls.some((call) => call.method === "objects.versions"),
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await client.reviseDocument({
      commandId: randomUUID(),
      contentId: result.contentId,
      expectedRevision: 1,
      title: originalTitle,
      markdown: "Human 修改的第二版正文。",
    });
    await client.renameObject({
      commandId: randomUUID(),
      contentId: result.contentId,
      expectedCatalogRevision: (await entry()).revision,
      title: "A Human 改名",
    });
    const undo = {
      commandId: randomUUID(),
      contentId: result.contentId,
      expectedCatalogRevision: (await entry()).revision,
      title: originalTitle,
    };
    const receipt = await client.renameObject(undo);
    assert.deepEqual(await client.renameObject(undo), receipt);
    const headEntry = await entry();
    assert.equal(headEntry.observedVersionRef, "4");
    const read = async (value: PlatformContent, revision?: number) => {
      calls.length = 0;
      const artifact = await readContentArtifact(
        client,
        value,
        undefined,
        revision,
      );
      assert.ok(artifact);
      assert.deepEqual(artifact.createdBy, creator);
      assert.equal(artifact.createdAt, createdAt);
      const history = calls.filter(
        (call) => call.method === "objects.versions",
      );
      assert.equal(history.length, artifact.revision === 1 ? 0 : 1);
      if (history[0])
        assert.deepEqual(history[0].params, {
          contentId: value.id,
          beforeRevision: 2,
          limit: 1,
        });
      assert.equal(
        calls.filter((call) => call.method === "objects.read").length,
        1,
      );
      return artifact;
    };
    const head = await read(headEntry);
    assert.equal(head.revision, 4);
    assert.equal(head.title, originalTitle);
    assert.deepEqual(head.versions[0]!.author, localAccess);
    assert.notEqual(head.versions[0]!.createdAt, createdAt);
    assert.equal(head.content.kind, "document");
    if (head.content.kind === "document")
      assert.equal(head.content.markdown, "Human 修改的第二版正文。");
    assert.equal(
      contentOrigin(head, [
        {
          id: localAccess.actantId,
          principalId: localAccess.principalId,
          name: "我",
          kind: "human",
        },
        {
          id: f.agentAccess.actantId,
          principalId: f.agentAccess.principalId,
          name: "Morphz",
          kind: "agent",
        },
      ]),
      "Morphz生成",
    );
    const edited = await read(headEntry, 2);
    assert.equal(edited.revision, 2);
    assert.deepEqual(edited.versions[0]!.author, localAccess);
    const initial = await read(headEntry, 1);
    assert.deepEqual(initial.versions[0]!.author, creator);
    if (initial.content.kind === "document")
      assert.equal(initial.content.markdown, "Agent 初版正文。");
    await assert.rejects(
      readContentArtifact(client, headEntry, undefined, 99),
      { status: 500, code: "storage_error" },
    );

    for (const title of ["B Human 原件", "C Human 原件"])
      await client.createDocument({
        commandId: randomUUID(),
        objectId: randomUUID(),
        projectId: f.projectId,
        title,
        markdown: title,
      });
    const paginated: PlatformContent[] = [];
    let before: { key: string; contentId: string } | undefined;
    do {
      const page = await client.content({
        projectId: f.projectId,
        sort: "title",
        limit: 1,
        ...(before ? { before } : {}),
      });
      paginated.push(...page.items);
      before = page.nextCursor ?? undefined;
    } while (before);
    assert.equal(paginated.length, 3);
    const pageOriginal = paginated.find(
      (value) => value.id === result.contentId,
    )!;
    await read(pageOriginal);

    // The Reader borrows the same Objects original and exact revision. Reading
    // does not turn the last editor into its creator or copy it into a book.
    const readerHead = await f.withHuman((actor) =>
      f.domains.reader.service.read(actor, result.contentId, 4, "section-1"),
    );
    assert.match(readerHead.text, /Human 修改的第二版正文/);
    const readerFirst = await f.withHuman((actor) =>
      f.domains.reader.service.read(actor, result.contentId, 1, "section-1"),
    );
    assert.match(readerFirst.text, /Agent 初版正文/);
    await read(await entry());
    connected.connection.close();
    connected = undefined;
    await f.reopen();
    connected = await connect(f, calls);
    client = connected.client;
    const reopened = await read(await entry());
    assert.equal(reopened.revision, 4);
    await read(await entry(), 2);
    assert.deepEqual(
      await f.withHuman((actor) =>
        f.domains.reader.service.read(actor, result.contentId, 4, "section-1"),
      ),
      readerHead,
    );
    assert.equal(
      (await client.content({ projectId: f.projectId })).items.length,
      3,
    );
    f.assertNoLegacyData();
  } finally {
    connected?.connection.close();
    await f.close();
  }
});

test("创建信息读取复核实际项目授权；撤权后不返回旧作者或正文投影", async () => {
  const alice = { principalId: "alice", actantId: "alice-human" };
  const f = await agentDomainFixture({ additionalHumans: [alice] });
  const connections: LocalApplicationConnection[] = [];
  try {
    const ownerToken = "a".repeat(64),
      aliceToken = "b".repeat(64);
    await f.identity!.replaceConfiguration({
      version: 1,
      members: [
        { ...localAccess, token: ownerToken },
        { ...alice, token: aliceToken },
      ].map(({ token, ...access }) => ({
        ...access,
        loginTokenHash: createHash("sha256").update(token).digest("hex"),
        enabled: true,
      })),
    });
    const owner = await connect(f, [], undefined, ownerToken);
    connections.push(owner.connection);
    const result = await f.call<{ contentId: string }>({
      action: "create-document",
      title: "有权限的原件",
      markdown: "私人内容。",
    });
    await owner.client.reviseDocument({
      commandId: randomUUID(),
      contentId: result.contentId,
      expectedRevision: 1,
      title: "第二版",
      markdown: "私人修改。",
    });
    const members = (allow: boolean) =>
      f.domains.content.platform.reconcileOperatorMembers(
        f.transport.identity(),
        [
          { ...localAccess, projectIds: [f.projectId], enabled: true },
          { ...alice, projectIds: allow ? [f.projectId] : [], enabled: true },
        ],
      );
    const calls: ReadCall[] = [];
    let revokeOnRead = false;
    const visitor = await connect(
      f,
      calls,
      async (method) => {
        if (revokeOnRead && method === "objects.read") await members(false);
      },
      aliceToken,
    );
    connections.push(visitor.connection);
    await members(true);
    const [entry] = await visitor.client.contentByIds([result.contentId]);
    assert.ok(entry);
    const allowed = await readContentArtifact(visitor.client, entry);
    assert.equal(allowed!.createdBy.actantId, f.agentAccess.actantId);
    calls.length = 0;
    revokeOnRead = true;
    await assert.rejects(readContentArtifact(visitor.client, entry), {
      status: 404,
      code: "not_found",
    });
    assert.deepEqual(
      calls.map((call) => call.method),
      ["objects.read", "objects.versions"],
    );
    assert.deepEqual(await visitor.client.contentByIds([entry.id]), []);
    await assert.rejects(
      visitor.client.objectVersions(entry.id, {
        beforeRevision: 2,
        limit: 1,
      }),
      { status: 404, code: "not_found" },
    );
    f.assertNoLegacyData();
  } finally {
    for (const connection of connections) connection.close();
    await f.close();
  }
});

test("创建元数据的原件 ID、内容 ID 和 v1 缺失不被相邻版本冒充", async () => {
  const entry = {
    id: "content-one",
    appId: "morphz.objects",
    appObjectId: "original-one",
    projectId: "project-one",
    revision: 2,
    providerRevision: 1,
  } as PlatformContent;
  const author = { principalId: "human", actantId: "human-actant" };
  const createdAt = "2026-09-30T00:00:00.000Z";
  const version = {
    objectId: entry.appObjectId,
    contentId: entry.id,
    projectId: entry.projectId,
    revision: 2,
    headRevision: 2,
    title: "第二版",
    content: { kind: "document", markdown: "正文" },
    author,
    createdAt,
  };
  for (const page of [
    {
      objectId: "wrong-original",
      contentId: entry.id,
      versions: [{ revision: 1, author, createdAt }],
    },
    {
      objectId: entry.appObjectId,
      contentId: "wrong-content",
      versions: [{ revision: 1, author, createdAt }],
    },
    {
      objectId: entry.appObjectId,
      contentId: entry.id,
      versions: [{ revision: 2, author, createdAt }],
    },
    { objectId: entry.appObjectId, contentId: entry.id, versions: [] },
  ])
    await assert.rejects(
      readContentArtifact(
        {
          readObject: async () => version,
          objectVersions: async () => page,
        } as unknown as PlatformClient,
        entry,
      ),
      /创建信息与应用原件不一致/,
    );
});
