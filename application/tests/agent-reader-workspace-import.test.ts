import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { agentDomainFixture } from "./agent-domain-fixture.js";

test("workspace import uses invocation authority, same Reader receipts and awaited final source check", async () => {
  let changed = false,
    reads = 0,
    checked = 0;
  const bytes = Buffer.from(
    "# TEST 工作目录导入\n直接复用 Runtime 的既有读取权限。",
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const f = await agentDomainFixture({
    readWorkspaceFile: async (route, path, expected) => {
      reads++;
      assert.ok(route.job_id && route.target_id && route.tool_call_id);
      assert.equal(path, "书籍.md");
      assert.ok(!expected || expected === sha256);
      return {
        name: "书籍.md",
        bytes,
        sha256,
        assertSource: async () => {
          checked++;
          await Promise.resolve();
          if (changed) throw new Error("source changed before commit");
        },
      };
    },
  });
  const request = {
    action: "operations",
    operations: {
      action: "invoke",
      operationId: "reader.import",
      parameters: { source: { kind: "workspace", path: "书籍.md", sha256 } },
    },
  };
  try {
    const route = f.input(f.projectId, "导入默认工作目录中的书", "");
    const envelope = f.envelope(request, route);
    const imported = (await f.tools.call(envelope)) as {
      entityId: string;
      source: { kind: string; sha256: string };
    };
    assert.ok(imported.entityId);
    assert.equal(imported.source.kind, "workspace");
    assert.equal(imported.source.sha256, sha256);
    assert.ok(checked > 0, "Async validation must finish before commit");
    assert.deepEqual(
      await f.tools.call(envelope),
      imported,
      "Same domain command is idempotent",
    );
    changed = true;
    await assert.rejects(f.call(request), /source changed before commit/);
    const before = reads;
    await assert.rejects(
      f.call({
        ...request,
        operations: {
          ...request.operations,
          parameters: {
            ...request.operations.parameters,
            projectId: "forged-project",
          },
        },
      }),
    );
    assert.equal(reads, before, "Model cannot select project authority");
  } finally {
    await f.close();
  }
});

test("workspace import fails closed without the Runtime byte authority", async () => {
  const f = await agentDomainFixture();
  try {
    await assert.rejects(
      f.call({
        action: "operations",
        operations: {
          action: "invoke",
          operationId: "reader.import",
          parameters: { source: { kind: "workspace", path: "书籍.md" } },
        },
      }),
      /workspace 文件读取/,
    );
  } finally {
    await f.close();
  }
});
