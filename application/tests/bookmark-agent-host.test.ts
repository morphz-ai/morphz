import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { localAccess } from "../packages/core/src/model.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

test("Agent 收藏工具从 Runtime 持久输入取身份，写 Browser 而不写旧工作区", async () => {
  const other = { principalId: "other-human-owner", actantId: "other-human" };
  const f = await agentDomainFixture({ additionalHumans: [other] });
  const envelope = (bookmarks: unknown) =>
    f.envelope({ action: "bookmarks", bookmarks });
  try {
    const operations = await f.call<{ operations: { id: string }[] }>({
      action: "operations",
      operations: { action: "list", domain: "bookmarks" },
    });
    assert.ok(
      operations.operations.some((entry) => entry.id === "bookmarks.add"),
    );
    const request = f.envelope({
      action: "operations",
      operations: {
        action: "invoke",
        operationId: "bookmarks.add",
        parameters: { title: "Agent 收藏", url: "https://example.com/agent" },
      },
    });
    const added = (await f.tools.call(request)) as {
      bookmark: {
        id: string;
        ownerPrincipalId: string;
        createdBy: { actantId: string };
      };
    };
    assert.equal(added.bookmark.ownerPrincipalId, localAccess.principalId);
    assert.equal(added.bookmark.createdBy.actantId, "morphz-agent");
    assert.deepEqual(await f.tools.call(request), added);
    const list = (await f.tools.call(
      envelope({ action: "list", query: "Agent" }),
    )) as {
      total: number;
      bookmarks: { id: string }[];
    };
    assert.equal(list.total, 1);
    assert.equal(list.bookmarks[0]!.id, added.bookmark.id);
    await assert.rejects(
      f.call(
        { action: "bookmarks", bookmarks: { action: "list" } },
        {
          ...f.route,
          principal_id: "forged",
        },
      ),
      /原始应用输入/,
    );
    const configuration = {
      version: 1,
      members: [localAccess, other].map((human) => ({
        ...human,
        loginTokenHash: createHash("sha256")
          .update(`synthetic-login-${human.principalId}`)
          .digest("hex"),
        enabled: human.principalId !== localAccess.principalId,
      })),
    };
    await f.identity!.replaceConfiguration(configuration);
    await assert.rejects(
      Promise.resolve(f.tools.call(envelope({ action: "list" }))),
      /身份已失效/,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});
