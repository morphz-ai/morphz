import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import {
  listenLocalHostTools,
  prepareLocalHostTools,
} from "../packages/application/src/host-tools-ipc.js";

// Real framed IPC, Platform authority and app-private SQLite. Runtime input
// evidence and story text are controlled, not a provider/model acceptance run.
test("历史候选经真实 IPC 读回并创建五个有版本绑定的分场；不采纳、不覆写，重开不重复", async () => {
  const f = await agentDomainFixture();
  const manifest = prepareLocalHostTools(f.directory, `scene-${randomUUID()}`);
  let listener = await listenLocalHostTools(
    manifest.endpoint,
    f.createTools(manifest.token),
  );
  const exchange = (request: unknown, token = manifest.token) =>
    new Promise<any>((resolve, reject) => {
      const socket = createConnection(manifest.endpoint);
      const bytes = Buffer.from(
        JSON.stringify({ protocol: 1, token, request }),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);
      const chunks: Buffer[] = [];
      socket.on("error", reject);
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error("isolated scene IPC timeout"));
      });
      socket.on("connect", () => socket.end(Buffer.concat([header, bytes])));
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => {
        const reply = Buffer.concat(chunks);
        assert.equal(reply.readUInt32BE(), reply.length - 4);
        resolve(JSON.parse(reply.subarray(4).toString("utf8")));
      });
    });
  const invoke = (operationId: string, parameters: unknown, route = f.route) =>
    f.envelope(
      {
        action: "operations",
        operations: { action: "invoke", operationId, parameters },
      },
      route,
    );
  const call = async (
    operationId: string,
    parameters: unknown,
    route = f.route,
  ) => {
    const reply = await exchange(invoke(operationId, parameters, route));
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.value.ok, true, JSON.stringify(reply));
    return reply.value;
  };
  try {
    const created = await call("script.create-production", {
      projectId: f.projectId,
      title: "TEST 历史候选拆分，不调用模型",
    });
    const productionId = created.productionId;
    const episode = await call("script.create-item", {
      productionId,
      expectedActivityRevision: 1,
      kind: "episode",
      draft: emptyScriptDraft("第一集"),
    });
    await call("script.prepare-workflow", {
      productionId,
      targetId: episode.itemId,
      baseRevision: 1,
      contextRevision: 1,
      purpose: "draft",
      maxCandidates: 2,
      maxOutputCharacters: 4000,
      maxReviewPasses: 0,
    });
    const text =
      "TEST 合成第一集。\n\n第一场：整理证件。\n第二场：讨论房款。\n第三场：说出担忧。\n第四场：重新核对。\n第五场：决定继续沟通。";
    const submitted = await call("script.submit-workflow", {
      payload: { ...emptyScriptDraft("第一集"), text },
      explanation: "合成测试，候选未经采纳。",
      checks: Array.from({ length: 2 }, () => ({
        performed: false,
        revise: false,
        blocked: false,
        notes: "未自审",
      })),
    });
    const previousCandidateId = submitted.candidateId;
    const second = await call("script.submit-workflow", {
      payload: {
        ...emptyScriptDraft("第一集"),
        text: text + "\nTEST 第二候选。",
      },
      explanation: "第二份合成候选，只用于验证独立分页。",
      checks: Array.from({ length: 2 }, () => ({
        performed: false,
        revise: false,
        blocked: false,
        notes: "未自审",
      })),
    });
    const original = await f.withHuman((actor) =>
      f.domains.content.studio!.readCandidate({
        credential: actor.credential,
        productionId,
        candidateId: previousCandidateId,
      }),
    );
    const followup = f.input(
      f.projectId,
      "将上次第一集候选拆成五场，不改剧情，不采纳正式稿。",
    );
    for (const operationId of [
      "script.list-candidates",
      "script.read-candidate",
      "script.create-item",
    ]) {
      const reply = await exchange(
        f.envelope(
          {
            action: "operations",
            operations: { action: "describe", operationId },
          },
          followup,
        ),
      );
      assert.equal(reply.ok, true);
      assert.ok(reply.value.operation.parameters);
      if (operationId === "script.create-item")
        assert.match(reply.value.operation.title, /所属集当前版本/);
    }
    const page = await call(
      "script.list-candidates",
      { productionId, itemId: episode.itemId, limit: 1 },
      followup,
    );
    assert.equal(page.total, 2);
    assert.equal(page.candidates[0].id, second.candidateId);
    assert.ok(page.nextCursor);
    assert.equal(
      page.candidates[0].draft,
      undefined,
      "header listing does not return story bytes",
    );
    const earlierPage = await call(
      "script.list-candidates",
      {
        productionId,
        itemId: episode.itemId,
        limit: 1,
        after: page.nextCursor,
        expectedActivityRevision: page.activityRevision,
      },
      followup,
    );
    assert.equal(earlierPage.candidates[0].id, previousCandidateId);
    assert.equal(earlierPage.nextCursor, null);
    const stalePage = await exchange(
      invoke(
        "script.list-candidates",
        {
          productionId,
          itemId: episode.itemId,
          expectedActivityRevision: page.activityRevision - 1,
        },
        followup,
      ),
    );
    assert.equal(stalePage.value.ok, false);
    const tooLarge = await exchange(
      invoke(
        "script.read-candidate",
        {
          productionId,
          candidateId: previousCandidateId,
          limit: 24_001,
        },
        followup,
      ),
    );
    assert.equal(tooLarge.value?.ok ?? tooLarge.ok, false);
    const otherProjectId = `scene_other_${randomUUID().replaceAll("-", "")}`;
    await f.withHuman((actor) =>
      f.domains.work.service.createProject(actor, {
        commandId: randomUUID(),
        projectId: otherProjectId,
        title: "TEST 其他项目",
      }),
    );
    const foreignInput = f.input(otherProjectId, "TEST 不得读取另一项目候选。");
    for (const operationId of [
      "script.list-candidates",
      "script.read-candidate",
    ]) {
      const foreign = await exchange(
        invoke(
          operationId,
          {
            productionId,
            ...(operationId === "script.list-candidates"
              ? { itemId: episode.itemId }
              : { candidateId: previousCandidateId }),
          },
          foreignInput,
        ),
      );
      // Existing Platform membership errors remain opaque at the transport.
      // Rejection must not disclose candidate headers or story bytes.
      assert.equal(foreign.ok, false);
      assert.ok(["forbidden", "unavailable"].includes(foreign.code));
      assert.equal("value" in foreign, false);
    }
    let value = "";
    let hash: string | undefined;
    while (true) {
      const part = await call(
        "script.read-candidate",
        {
          productionId,
          candidateId: previousCandidateId,
          offset: value.length,
          limit: 37,
        },
        followup,
      );
      assert.equal(part.offset, value.length);
      assert.equal(part.targetId, episode.itemId);
      assert.equal(part.status, "pending");
      assert.equal(part.acceptedRevision, null);
      hash ??= part.draftHash;
      assert.equal(part.draftHash, hash);
      value += part.draftJson;
      if (!part.hasMore) {
        assert.equal(value.length, part.totalCharacters);
        break;
      }
    }
    assert.equal(createHash("sha256").update(value).digest("hex"), hash);
    assert.deepEqual(JSON.parse(value), original.draft);
    const scopeError = await exchange(
      invoke("script.read-results", {}, followup),
    );
    assert.equal(scopeError.ok, true);
    assert.equal(
      scopeError.value.code,
      "invalid",
      "current-input reconciliation stays scoped",
    );
    const parent = await call(
      "script.read-item",
      { productionId, itemId: episode.itemId, revision: 1 },
      followup,
    );
    assert.equal(JSON.parse(parent.draftJson).text, "");
    const receipts: Array<{ envelope: unknown; receipt: any }> = [];
    for (let order = 1; order <= 5; order++) {
      const directory = await call(
        "script.read-production",
        { productionId },
        followup,
      );
      const draft = {
        ...emptyScriptDraft(`第${order}场`, order),
        parentId: episode.itemId,
        location: "租住屋餐桌",
        storyTime: "夜",
      };
      if (order === 1) {
        const rejected = await exchange(
          invoke(
            "script.create-item",
            {
              productionId,
              expectedActivityRevision: directory.activityRevision,
              kind: "scene",
              draft,
            },
            followup,
          ),
        );
        assert.deepEqual(
          { transport: rejected.ok, code: rejected.value.code },
          { transport: true, code: "invalid" },
        );
        assert.match(rejected.value.message, /dependencies.*所属集当前修订/);
        for (const [invalidDraft, revision, code] of [
          [
            {
              ...draft,
              dependencies: [{ itemId: episode.itemId, revision: 2 }],
            },
            directory.activityRevision,
            "conflict",
          ],
          [
            {
              ...draft,
              dependencies: [{ itemId: episode.itemId, revision: 1 }],
            },
            directory.activityRevision - 1,
            "conflict",
          ],
          [
            {
              ...draft,
              dependencies: [
                { itemId: episode.itemId, revision: 1 },
                { itemId: episode.itemId, revision: 1 },
              ],
            },
            directory.activityRevision,
            "invalid",
          ],
          [
            {
              ...draft,
              dependencies: [{ itemId: episode.itemId, revision: 1 }],
              characters: ["unknown-character"],
            },
            directory.activityRevision,
            "invalid",
          ],
        ] as const) {
          const invalid = await exchange(
            invoke(
              "script.create-item",
              {
                productionId,
                expectedActivityRevision: revision,
                kind: "scene",
                draft: invalidDraft,
              },
              followup,
            ),
          );
          assert.equal(invalid.ok, true);
          assert.equal(invalid.value.ok, false);
          assert.equal(invalid.value.code, code, JSON.stringify(invalid));
          assert.match(
            invalid.value.message,
            /所属集当前版本|剧本已变化|依赖不能重复|出场角色/,
            "domain failure is actionable, not opaque transport rejection",
          );
        }
        assert.equal(
          (await call("script.read-production", { productionId }, followup))
            .activityRevision,
          directory.activityRevision,
        );
      }
      const envelope = invoke(
        "script.create-item",
        {
          productionId,
          expectedActivityRevision: directory.activityRevision,
          kind: "scene",
          draft: {
            ...draft,
            dependencies: [
              { itemId: episode.itemId, revision: parent.currentRevision },
            ],
          },
        },
        followup,
      );
      const reply = await exchange(envelope);
      assert.equal(reply.ok, true);
      assert.equal(reply.value.ok, true, JSON.stringify(reply));
      receipts.push({ envelope, receipt: reply.value });
      const saved = await call(
        "script.read-item",
        { productionId, itemId: reply.value.itemId, revision: 1 },
        followup,
      );
      assert.deepEqual(JSON.parse(saved.draftJson), {
        ...draft,
        dependencies: [{ itemId: episode.itemId, revision: 1 }],
      });
      assert.deepEqual((await exchange(envelope)).value, reply.value);
    }
    assert.equal(
      (
        await call("script.read-production", { productionId }, followup)
      ).items.filter((item: any) => item.kind === "scene").length,
      5,
    );
    const denied = await exchange(
      invoke(
        "script.read-candidate",
        { productionId, candidateId: previousCandidateId },
        f.route,
      ),
    );
    assert.deepEqual(
      denied,
      { protocol: 1, ok: false, code: "forbidden" },
      "prepared generation cannot expand references",
    );
    assert.deepEqual(
      await exchange(
        invoke(
          "script.read-candidate",
          { productionId, candidateId: previousCandidateId },
          followup,
        ),
        "invalid-test-token",
      ),
      { protocol: 1, ok: false, code: "forbidden" },
    );
    await listener.close();
    await f.reopen();
    listener = await listenLocalHostTools(
      manifest.endpoint,
      f.createTools(manifest.token),
    );
    for (const { envelope, receipt } of receipts)
      assert.deepEqual((await exchange(envelope)).value, receipt);
    const reopened = await call(
      "script.read-production",
      { productionId },
      followup,
    );
    assert.equal(reopened.items.length, 6);
    assert.deepEqual(
      await f.withHuman((actor) =>
        f.domains.content.studio!.readCandidate({
          credential: actor.credential,
          productionId,
          candidateId: previousCandidateId,
        }),
      ),
      original,
    );
    f.setInputExecution("running", true, followup);
    const stopped = await exchange(
      invoke(
        "script.read-candidate",
        { productionId, candidateId: previousCandidateId },
        followup,
      ),
    );
    assert.equal(stopped.value?.ok ?? stopped.ok, false);
    f.assertNoLegacyData();
  } finally {
    await listener.close();
    await f.close();
  }
});
