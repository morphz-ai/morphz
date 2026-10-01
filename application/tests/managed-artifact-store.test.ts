import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  ManagedArtifactStore,
  type StoreAuthorizationRequest,
  type StoreAuthorizer,
} from "../packages/managed-artifact-store/src/store.js";
import { managedArtifactStoreSchemaSql } from "../packages/managed-artifact-store/src/schema.js";

const bytes = Buffer.from("一份不会自动进入 Platform 目录的原件", "utf8");
const digest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const authorizer: StoreAuthorizer = {
  async authorize(credential, request) {
    if (request.storeId !== "store-one")
      throw new Error("Store 不在授权范围。");
    if (credential === "alice")
      return { tenantId: "tenant-a", principalId: "alice" };
    if (credential === "bob")
      return { tenantId: "tenant-b", principalId: "bob" };
    throw new Error("Store 凭据无效。");
  },
};

test("受管 Store 生产 schema 与评审 SQL 相同", () => {
  assert.equal(
    managedArtifactStoreSchemaSql.trim(),
    readFileSync(
      new URL(
        "../docs/storage-model-v1/managed-artifact-store.sql",
        import.meta.url,
      ),
      "utf8",
    ).trim(),
  );
});

async function exercise(store: ManagedArtifactStore, root: string) {
  const receiptRequest = {
    operation: "put" as const,
    credential: "alice",
    commandId: "command-one",
    artifactId: "artifact-one",
    baseRevision: 0,
    mime: "text/plain",
    sha256: digest(bytes),
    byteLength: bytes.length,
  };
  assert.equal(await store.inspectCommandReceipt(receiptRequest), null);
  const first = await store.put({
    credential: "alice",
    commandId: "command-one",
    artifactId: "artifact-one",
    baseRevision: 0,
    mime: "text/plain",
    expectedSha256: digest(bytes),
    bytes,
  });
  assert.deepEqual(first, {
    storeId: "store-one",
    artifactId: "artifact-one",
    revision: 1,
    sha256: digest(bytes),
    byteLength: bytes.length,
    mime: "text/plain",
  });
  const firstReceipt = await store.inspectCommandReceipt(receiptRequest);
  assert.equal(firstReceipt?.operation, "put");
  if (firstReceipt?.operation !== "put")
    throw new Error("已提交写入缺少 Store 回执。");
  assert.deepEqual(firstReceipt.version, first);
  assert.equal(
    await store.inspectCommandReceipt({ ...receiptRequest, credential: "bob" }),
    null,
  );
  await assert.rejects(
    store.inspectCommandReceipt({ ...receiptRequest, mime: "image/png" }),
    /不同 Store 请求/,
  );
  assert.deepEqual(
    await store.verifyVersion({
      credential: "alice",
      artifactId: "artifact-one",
      revision: 1,
    }),
    first,
  );
  await assert.rejects(
    store.verifyVersion({ credential: "bob", artifactId: "artifact-one" }),
    /读取权限/,
  );
  const empty = await store.put({
    credential: "alice",
    commandId: "empty-command",
    artifactId: "artifact-empty",
    baseRevision: 0,
    mime: "application/octet-stream",
    bytes: Buffer.alloc(0),
  });
  assert.equal(empty.byteLength, 0);
  assert.deepEqual(
    await store.verifyVersion({
      credential: "alice",
      artifactId: "artifact-empty",
    }),
    empty,
  );
  assert.deepEqual(
    (
      await store.readRange({
        credential: "alice",
        artifactId: "artifact-empty",
      })
    ).bytes,
    Buffer.alloc(0),
  );
  assert.deepEqual(
    (
      await store.readRange({
        credential: "alice",
        artifactId: "artifact-one",
        start: 0,
        endExclusive: bytes.length,
      })
    ).bytes,
    bytes,
  );
  assert.deepEqual(
    (
      await store.readRange({
        credential: "alice",
        artifactId: "artifact-one",
        start: 3,
        endExclusive: 8,
      })
    ).bytes,
    bytes.subarray(3, 8),
  );
  await Promise.all(
    ["artifact-parallel-a", "artifact-parallel-b"].map((artifactId) =>
      store.put({
        credential: "alice",
        commandId: `command-${artifactId}`,
        artifactId,
        baseRevision: 0,
        mime: "text/plain",
        bytes,
      }),
    ),
  );
  const [sameA, sameB] = await Promise.all(
    [1, 2].map(() =>
      store.put({
        credential: "alice",
        commandId: "parallel-same-command",
        artifactId: "artifact-parallel-same",
        baseRevision: 0,
        mime: "text/plain",
        bytes,
      }),
    ),
  );
  assert.deepEqual(sameA, sameB);
  const contenders = await Promise.allSettled(
    ["候选甲", "候选乙"].map((body, index) =>
      store.put({
        credential: "alice",
        commandId: `racing-command-${index}`,
        artifactId: "artifact-parallel-a",
        baseRevision: 1,
        mime: "text/plain",
        bytes: Buffer.from(body),
      }),
    ),
  );
  assert.equal(
    contenders.filter((value) => value.status === "fulfilled").length,
    1,
  );
  assert.equal(
    contenders.filter((value) => value.status === "rejected").length,
    1,
  );
  assert.deepEqual(
    await store.put({
      credential: "alice",
      commandId: "command-one",
      artifactId: "artifact-one",
      baseRevision: 0,
      mime: "text/plain",
      bytes,
    }),
    first,
  );
  await assert.rejects(
    store.put({
      credential: "alice",
      commandId: "command-one",
      artifactId: "artifact-one",
      baseRevision: 0,
      mime: "text/plain",
      bytes: Buffer.from("变了"),
    }),
    /相同命令 ID/,
  );
  await assert.rejects(
    store.put({
      credential: "alice",
      commandId: "stale-command",
      artifactId: "artifact-one",
      baseRevision: 0,
      mime: "text/plain",
      bytes,
    }),
    /基准版本冲突/,
  );
  await assert.rejects(
    store.readRange({
      credential: "bob",
      artifactId: "artifact-one",
    }),
    /读取权限/,
  );
  await assert.rejects(
    store.put({
      credential: "bob",
      commandId: "bob-command",
      artifactId: "artifact-one",
      baseRevision: 1,
      mime: "text/plain",
      bytes,
    }),
    /写入权限/,
  );
  let consumedUnauthorizedBytes = false;
  async function* unauthorizedBytes() {
    consumedUnauthorizedBytes = true;
    yield Buffer.from("不该接收");
  }
  await assert.rejects(
    store.put({
      credential: "bob",
      commandId: "bob-early-reject",
      artifactId: "artifact-one",
      baseRevision: 1,
      mime: "text/plain",
      bytes: unauthorizedBytes(),
    }),
    /写入权限/,
  );
  assert.equal(consumedUnauthorizedBytes, false);
  await assert.rejects(
    store.put({
      credential: "invalid",
      commandId: "invalid-command",
      artifactId: "artifact-two",
      baseRevision: 0,
      mime: "text/plain",
      bytes,
    }),
    /凭据/,
  );
  await assert.rejects(
    store.put({
      credential: "alice",
      commandId: "wrong-digest",
      artifactId: "artifact-two",
      baseRevision: 0,
      mime: "text/plain",
      expectedSha256: "0".repeat(64),
      bytes,
    }),
    /摘要不匹配/,
  );
  async function* brokenStream() {
    yield Buffer.from("half");
    throw new Error("上传中断");
  }
  await assert.rejects(
    store.put({
      credential: "alice",
      commandId: "broken-stream",
      artifactId: "artifact-two",
      baseRevision: 0,
      mime: "text/plain",
      bytes: brokenStream(),
    }),
    /上传中断/,
  );
  assert.deepEqual(readdirSync(join(root, "staging")), []);
  const secondBytes = Buffer.from("不可变的第二版", "utf8");
  const second = await store.put({
    credential: "alice",
    commandId: "command-two",
    artifactId: "artifact-one",
    baseRevision: 1,
    mime: "text/plain",
    bytes: secondBytes,
  });
  assert.equal(second.revision, 2);
  assert.deepEqual(
    (
      await store.readRange({
        credential: "alice",
        artifactId: "artifact-one",
      })
    ).bytes,
    secondBytes,
  );
  assert.deepEqual(
    (
      await store.readRange({
        credential: "alice",
        artifactId: "artifact-one",
        revision: 1,
      })
    ).bytes,
    bytes,
  );
  const largeBytes = Buffer.alloc(1024 * 1024 + 23, 0x61);
  largeBytes.fill(0x62, 1024 * 1024);
  await store.put({
    credential: "alice",
    commandId: "large-command",
    artifactId: "artifact-large",
    baseRevision: 0,
    mime: "application/pdf",
    bytes: largeBytes,
  });
  assert.deepEqual(
    (
      await store.readRange({
        credential: "alice",
        artifactId: "artifact-large",
        start: 1024 * 1024 - 7,
        endExclusive: 1024 * 1024 + 7,
      })
    ).bytes,
    largeBytes.subarray(1024 * 1024 - 7, 1024 * 1024 + 7),
  );
  const healthy = await store.inspectIntegrity();
  assert.deepEqual(healthy.damaged, []);
  assert.deepEqual(healthy.orphans, []);
  assert.deepEqual(healthy.staged, []);
  await assert.rejects(
    store.readRange({
      credential: "alice",
      artifactId: "artifact-one",
      start: 0,
      endExclusive: 10000,
    }),
    /读取范围/,
  );
  const path = join(root, "blobs", digest(bytes).slice(0, 2), digest(bytes));
  writeFileSync(path, Buffer.alloc(bytes.length, 0x62));
  await assert.rejects(
    store.verifyVersion({
      credential: "alice",
      artifactId: "artifact-one",
      revision: 1,
    }),
    /摘要损坏/,
  );
  await assert.rejects(
    store.readRange({
      credential: "alice",
      artifactId: "artifact-one",
      revision: 1,
    }),
    /摘要损坏/,
  );
  await assert.rejects(store.inspectCommandReceipt(receiptRequest), /摘要损坏/);
  assert((await store.inspectIntegrity()).damaged.includes(digest(bytes)));
  await assert.rejects(
    store.delete({
      credential: "bob",
      commandId: "bad-delete",
      artifactId: "artifact-one",
      baseRevision: 2,
    }),
    /删除权限/,
  );
  await assert.rejects(
    store.delete({
      credential: "alice",
      commandId: "stale-delete",
      artifactId: "artifact-one",
      baseRevision: 1,
    }),
    /基准版本冲突/,
  );
  const deleted = await store.delete({
    credential: "alice",
    commandId: "delete-one",
    artifactId: "artifact-one",
    baseRevision: 2,
  });
  assert.deepEqual(
    await store.inspectCommandReceipt({
      operation: "delete",
      credential: "alice",
      commandId: "delete-one",
      artifactId: "artifact-one",
      baseRevision: 2,
    }),
    { operation: "delete", ...deleted },
  );
  assert.deepEqual(
    await store.delete({
      credential: "alice",
      commandId: "delete-one",
      artifactId: "artifact-one",
      baseRevision: 2,
    }),
    deleted,
  );
  await assert.rejects(
    store.readRange({
      credential: "alice",
      artifactId: "artifact-one",
    }),
    /读取权限/,
  );
  await assert.rejects(
    store.put({
      credential: "alice",
      commandId: "write-after-delete",
      artifactId: "artifact-one",
      baseRevision: 2,
      mime: "text/plain",
      bytes: Buffer.from("新内容"),
    }),
    /基准版本冲突/,
  );
}

function readRaceAuthorizer() {
  const state: {
    reads: number;
    denyOnSecondRead: boolean;
    onSecondRead?: () => Promise<void>;
    denyWrites: boolean;
  } = { reads: 0, denyOnSecondRead: false, denyWrites: false };
  const authorizer: StoreAuthorizer = {
    async authorize(credential, request) {
      if (credential !== "alice" || request.storeId !== "store-one")
        throw new Error("Store 凭据无效。");
      if (request.operation === "read") {
        state.reads++;
        if (state.reads === 2) {
          await state.onSecondRead?.();
          if (state.denyOnSecondRead) throw new Error("Store 读取授权已撤销。");
        }
      }
      if (request.operation === "write" && state.denyWrites)
        throw new Error("Store 写入授权已撤销。");
      return { tenantId: "tenant-a", principalId: "alice" };
    },
  };
  return { state, authorizer };
}

async function exerciseReadRace(
  store: ManagedArtifactStore,
  state: ReturnType<typeof readRaceAuthorizer>["state"],
) {
  await store.put({
    credential: "alice",
    commandId: "read-race-create",
    artifactId: "read-race-artifact",
    baseRevision: 0,
    mime: "application/pdf",
    bytes,
  });
  state.denyOnSecondRead = true;
  await assert.rejects(
    store.readRange({ credential: "alice", artifactId: "read-race-artifact" }),
    /读取授权已撤销/,
  );
  assert.equal(state.reads, 2);
  state.reads = 0;
  await assert.rejects(
    store.verifyVersion({
      credential: "alice",
      artifactId: "read-race-artifact",
    }),
    /读取授权已撤销/,
  );
  assert.equal(state.reads, 2);
  state.reads = 0;
  state.denyOnSecondRead = false;
  assert.equal(
    (
      await store.verifyVersion({
        credential: "alice",
        artifactId: "read-race-artifact",
      })
    ).sha256,
    digest(bytes),
  );
  state.reads = 0;
  assert.deepEqual(
    (
      await store.readRange({
        credential: "alice",
        artifactId: "read-race-artifact",
      })
    ).bytes,
    bytes,
  );
  state.reads = 0;
  state.onSecondRead = async () => {
    await store.delete({
      credential: "alice",
      commandId: "read-race-delete",
      artifactId: "read-race-artifact",
      baseRevision: 1,
    });
  };
  await assert.rejects(
    store.readRange({ credential: "alice", artifactId: "read-race-artifact" }),
    /读取期间权限或版本已变化/,
  );
  assert.equal(state.reads, 2);

  await store.put({
    credential: "alice",
    commandId: "verify-race-create",
    artifactId: "verify-race-artifact",
    baseRevision: 0,
    mime: "application/pdf",
    bytes,
  });
  state.reads = 0;
  state.onSecondRead = async () => {
    await store.delete({
      credential: "alice",
      commandId: "verify-race-delete",
      artifactId: "verify-race-artifact",
      baseRevision: 1,
    });
  };
  await assert.rejects(
    store.verifyVersion({
      credential: "alice",
      artifactId: "verify-race-artifact",
    }),
    /读取期间权限或版本已变化/,
  );
  assert.equal(state.reads, 2);

  const laterBytes = Buffer.from("上传时撤权", "utf8");
  async function* interruptedUpload() {
    yield laterBytes.subarray(0, 6);
    state.denyWrites = true;
    yield laterBytes.subarray(6);
  }
  const before = await store.inspectIntegrity();
  await assert.rejects(
    store.put({
      credential: "alice",
      commandId: "upload-revoked",
      artifactId: "upload-revoked-artifact",
      baseRevision: 0,
      mime: "application/pdf",
      bytes: interruptedUpload(),
    }),
    /写入授权已撤销/,
  );
  const after = await store.inspectIntegrity();
  assert.equal(after.manifestBlobs, before.manifestBlobs);
  assert.deepEqual(after.orphans, before.orphans);
  assert.deepEqual(after.staged, []);
  state.denyWrites = false;
  assert.equal(
    (
      await store.put({
        credential: "alice",
        commandId: "upload-revoked",
        artifactId: "upload-revoked-artifact",
        baseRevision: 0,
        mime: "application/pdf",
        bytes: laterBytes,
      })
    ).revision,
    1,
  );
}

test("受管 Store SQLite：读取期间撤权或删除不得返回已读取字节", async () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-node-store-read-race-"));
  const { state, authorizer } = readRaceAuthorizer();
  try {
    const store = await ManagedArtifactStore.sqlite({
      root,
      storeId: "store-one",
      authorizer,
    });
    try {
      await exerciseReadRace(store, state);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function exactScopeAuthorizer() {
  let allowed: StoreAuthorizationRequest | null = null;
  const calls: StoreAuthorizationRequest[] = [];
  const scoped: StoreAuthorizer = {
    async authorize(credential, request) {
      if (credential !== "opaque-invocation" || !allowed)
        throw new Error("Store 调用授权无效。");
      assert.deepEqual(request, allowed);
      calls.push(request);
      return { tenantId: "tenant-a", principalId: "alice" };
    },
  };
  return {
    scoped,
    calls,
    allow(request: StoreAuthorizationRequest) {
      allowed = request;
    },
  };
}

async function exerciseExactAuthorizationScope(
  store: ManagedArtifactStore,
  grant: ReturnType<typeof exactScopeAuthorizer>,
) {
  const create = {
    storeId: "store-one",
    operation: "write" as const,
    artifactId: "scoped-artifact",
    baseRevision: 0,
    commandId: "scoped-create",
  };
  grant.allow(create);
  const first = await store.put({
    credential: "opaque-invocation",
    commandId: create.commandId,
    artifactId: create.artifactId,
    baseRevision: create.baseRevision,
    mime: "text/plain",
    bytes,
  });
  assert.equal(first.revision, 1);
  assert.ok(grant.calls.length >= 2);
  grant.allow({
    storeId: "store-one",
    operation: "read",
    artifactId: "scoped-artifact",
    revision: 1,
  });
  assert.deepEqual(
    (
      await store.readRange({
        credential: "opaque-invocation",
        artifactId: "scoped-artifact",
        revision: 1,
      })
    ).bytes,
    bytes,
  );
  assert.equal(
    (
      await store.verifyVersion({
        credential: "opaque-invocation",
        artifactId: "scoped-artifact",
        revision: 1,
      })
    ).sha256,
    digest(bytes),
  );
  await assert.rejects(
    store.readRange({
      credential: "opaque-invocation",
      artifactId: "scoped-artifact",
    }),
    /revision/,
  );
  await assert.rejects(
    store.verifyVersion({
      credential: "opaque-invocation",
      artifactId: "scoped-artifact",
    }),
    /revision/,
  );
  grant.allow({
    storeId: "store-one",
    operation: "delete",
    artifactId: "scoped-artifact",
    baseRevision: 1,
    commandId: "scoped-delete",
  });
  await assert.rejects(
    store.delete({
      credential: "opaque-invocation",
      artifactId: "scoped-artifact",
      baseRevision: 1,
      commandId: "different-delete",
    }),
    /commandId/,
  );
  await store.delete({
    credential: "opaque-invocation",
    artifactId: "scoped-artifact",
    baseRevision: 1,
    commandId: "scoped-delete",
  });
}

test("受管 Store SQLite：授权精确绑定版本与命令", async () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-store-scope-sqlite-"));
  const grant = exactScopeAuthorizer();
  const store = await ManagedArtifactStore.sqlite({
    root,
    storeId: "store-one",
    authorizer: grant.scoped,
  });
  try {
    await exerciseExactAuthorizationScope(store, grant);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("受管 Store SQLite：持久身份、字节校验、CAS、幂等及租户隔离", async () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-node-store-"));
  try {
    const store = await ManagedArtifactStore.sqlite({
      root,
      storeId: "store-one",
      authorizer,
    });
    try {
      await exercise(store, root);
    } finally {
      await store.close();
    }
    await assert.rejects(
      ManagedArtifactStore.sqlite({
        root,
        storeId: "store-other",
        authorizer,
      }),
      /身份不匹配/,
    );
    const reopened = await ManagedArtifactStore.sqlite({
      root,
      storeId: "store-one",
      authorizer,
    });
    try {
      assert.equal(
        (
          await reopened.readRange({
            credential: "alice",
            artifactId: "artifact-large",
            start: 0,
            endExclusive: 5,
          })
        ).version.revision,
        1,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("受管 Store 拒绝符号链接根目录", async () => {
  const parent = mkdtempSync(join(tmpdir(), "morphz-node-store-link-"));
  try {
    symlinkSync(parent, join(parent, "alias"));
    await assert.rejects(
      ManagedArtifactStore.sqlite({
        root: join(parent, "alias"),
        storeId: "store-one",
        authorizer,
      }),
      /私有的真实目录/,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("受管 Store 超额上传与中断都不留下暂存字节", async () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-node-store-limit-"));
  try {
    const store = await ManagedArtifactStore.sqlite({
      root,
      storeId: "store-one",
      authorizer,
      maxBytes: 2,
    });
    try {
      await assert.rejects(
        store.put({
          credential: "alice",
          commandId: "too-large",
          artifactId: "large",
          baseRevision: 0,
          mime: "text/plain",
          bytes: Buffer.from("123"),
        }),
        /容量限制/,
      );
      assert.deepEqual(readdirSync(join(root, "staging")), []);
      assert.equal((await store.inspectIntegrity()).manifestBlobs, 0);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function exerciseCommittedCapacity(
  primary: ManagedArtifactStore,
  secondary: ManagedArtifactStore,
  root: string,
) {
  const firstBytes = Buffer.from("abcd");
  const first = await primary.put({
    credential: "alice",
    commandId: "quota-first",
    artifactId: "quota-first-artifact",
    baseRevision: 0,
    mime: "text/plain",
    bytes: firstBytes,
  });
  await secondary.put({
    credential: "alice",
    commandId: "quota-deduplicated",
    artifactId: "quota-second-artifact",
    baseRevision: 0,
    mime: "text/plain",
    bytes: firstBytes,
  });
  assert.equal((await primary.inspectIntegrity()).committedBytes, 4);
  const contenders = [Buffer.from("123"), Buffer.from("456")];
  const competing = await Promise.allSettled(
    contenders.map((value, index) =>
      (index === 0 ? primary : secondary).put({
        credential: "alice",
        commandId: `quota-contender-${index}`,
        artifactId: `quota-contender-artifact-${index}`,
        baseRevision: 0,
        mime: "text/plain",
        bytes: value,
      }),
    ),
  );
  assert.equal(
    competing.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    competing.filter((result) => result.status === "rejected").length,
    1,
  );
  const rejectedIndex = competing.findIndex(
    (result) => result.status === "rejected",
  );
  assert.match(
    String((competing[rejectedIndex] as PromiseRejectedResult).reason),
    /已提交字节容量不足/,
  );
  const rejectedSha = digest(contenders[rejectedIndex]!);
  assert.equal(
    existsSync(join(root, "blobs", rejectedSha.slice(0, 2), rejectedSha)),
    false,
  );
  assert.deepEqual(readdirSync(join(root, "staging")), []);
  assert.deepEqual(
    await primary.put({
      credential: "alice",
      commandId: "quota-first",
      artifactId: "quota-first-artifact",
      baseRevision: 0,
      mime: "text/plain",
      bytes: firstBytes,
    }),
    first,
  );
  await primary.delete({
    credential: "alice",
    commandId: "quota-delete",
    artifactId: "quota-first-artifact",
    baseRevision: 1,
  });
  await assert.rejects(
    secondary.put({
      credential: "alice",
      commandId: "quota-after-delete",
      artifactId: "quota-after-delete-artifact",
      baseRevision: 0,
      mime: "text/plain",
      bytes: Buffer.from("z"),
    }),
    /已提交字节容量不足/,
  );
  const audit = await secondary.inspectIntegrity();
  assert.equal(audit.manifestBlobs, 2);
  assert.equal(audit.committedBytes, 7);
  assert.equal(audit.usageMismatch, false);
  assert.deepEqual(audit.orphans, []);
}

test("受管 Store SQLite：跨实例总容量按去重后的已提交字节串行计算", async () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-store-quota-sqlite-"));
  let primary: ManagedArtifactStore | undefined;
  let secondary: ManagedArtifactStore | undefined;
  try {
    await assert.rejects(
      ManagedArtifactStore.sqlite({
        root,
        storeId: "store-one",
        authorizer,
        maxCommittedBytes: -1,
      }),
      /已提交字节容量限制无效/,
    );
    primary = await ManagedArtifactStore.sqlite({
      root,
      storeId: "store-one",
      authorizer,
      maxCommittedBytes: 7,
    });
    await assert.rejects(
      ManagedArtifactStore.sqlite({
        root,
        storeId: "store-one",
        authorizer,
        maxCommittedBytes: 8,
      }),
      /容量策略与已登记 manifest 不一致/,
    );
    secondary = await ManagedArtifactStore.sqlite({
      root,
      storeId: "store-one",
      authorizer,
      maxCommittedBytes: 7,
    });
    await exerciseCommittedCapacity(primary, secondary, root);
  } finally {
    await secondary?.close();
    await primary?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("受管 Store 恢复先核对总容量，失败时目标仍为空", async () => {
  const parent = mkdtempSync(join(tmpdir(), "morphz-store-quota-restore-"));
  const sourceRoot = join(parent, "source");
  const backup = join(parent, "backup");
  const destination = join(parent, "destination");
  let source: ManagedArtifactStore | undefined;
  let reopened: ManagedArtifactStore | undefined;
  try {
    source = await ManagedArtifactStore.sqlite({
      root: sourceRoot,
      storeId: "store-one",
      authorizer,
    });
    await source.put({
      credential: "alice",
      commandId: "restore-quota-seed",
      artifactId: "restore-quota-artifact",
      baseRevision: 0,
      mime: "text/plain",
      bytes: Buffer.from("1234"),
    });
    await source.backupTo(backup);
    await assert.rejects(
      ManagedArtifactStore.restoreSqlite({
        root: destination,
        storeId: "store-one",
        authorizer,
        maxCommittedBytes: 3,
        backupDirectory: backup,
      }),
      /备份超过已提交字节容量限制/,
    );
    reopened = await ManagedArtifactStore.sqlite({
      root: destination,
      storeId: "store-one",
      authorizer,
      maxCommittedBytes: 3,
    });
    const audit = await reopened.inspectIntegrity();
    assert.equal(audit.manifestBlobs, 0);
    assert.equal(audit.committedBytes, 0);
    assert.deepEqual(audit.orphans, []);
  } finally {
    await reopened?.close();
    await source?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("受管 Store 字节计数漂移时拒绝发布备份", async () => {
  const parent = mkdtempSync(join(tmpdir(), "morphz-store-usage-drift-"));
  const root = join(parent, "store");
  const store = await ManagedArtifactStore.sqlite({
    root,
    storeId: "store-one",
    authorizer,
    maxCommittedBytes: 100,
  });
  try {
    await store.put({
      credential: "alice",
      commandId: "usage-drift-seed",
      artifactId: "usage-drift-artifact",
      baseRevision: 0,
      mime: "text/plain",
      bytes: Buffer.from("1234"),
    });
    const database = new DatabaseSync(join(root, "manifest.sqlite"));
    try {
      database.exec("UPDATE store_usage SET committed_bytes=1 WHERE id=1");
    } finally {
      database.close();
    }
    assert.equal((await store.inspectIntegrity()).usageMismatch, true);
    const backup = join(parent, "backup");
    await assert.rejects(
      store.backupTo(backup),
      /字节计数与 Blob manifest 不一致/,
    );
    assert.equal(existsSync(join(backup, "backup-info.json")), false);
  } finally {
    await store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

async function exerciseOrphanQuarantine(
  store: ManagedArtifactStore,
  root: string,
) {
  const active = await store.put({
    credential: "alice",
    commandId: "gc-active-one",
    artifactId: "gc-active",
    baseRevision: 0,
    mime: "text/plain",
    bytes,
  });
  const historical = await store.put({
    credential: "alice",
    commandId: "gc-active-two",
    artifactId: "gc-active",
    baseRevision: 1,
    mime: "text/plain",
    bytes: Buffer.from("历史版本不能回收"),
  });
  const tombstoned = await store.put({
    credential: "alice",
    commandId: "gc-tombstone-create",
    artifactId: "gc-tombstone",
    baseRevision: 0,
    mime: "text/plain",
    bytes: Buffer.from("已删除对象的历史字节"),
  });
  await store.delete({
    credential: "alice",
    commandId: "gc-tombstone-delete",
    artifactId: "gc-tombstone",
    baseRevision: 1,
  });
  const orphanBytes = [Buffer.from("孤立字节一"), Buffer.from("孤立字节二")];
  const orphanShas = orphanBytes.map(digest);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const value of orphanBytes) {
    const sha = digest(value);
    const directory = join(root, "blobs", sha.slice(0, 2));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, sha);
    writeFileSync(path, value);
    utimesSync(path, old, old);
  }
  const freshBytes = Buffer.from("刚发布的孤立字节");
  const freshSha = digest(freshBytes);
  const freshDirectory = join(root, "blobs", freshSha.slice(0, 2));
  mkdirSync(freshDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(freshDirectory, freshSha), freshBytes);
  const symlinkSha = digest(Buffer.from("不跟随符号链接"));
  const symlinkDirectory = join(root, "blobs", symlinkSha.slice(0, 2));
  mkdirSync(symlinkDirectory, { recursive: true, mode: 0o700 });
  symlinkSync(
    join(freshDirectory, freshSha),
    join(symlinkDirectory, symlinkSha),
  );

  const moved: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await store.quarantineOrphanBlobs({
      minAgeMs: 60_000,
      afterSha256: cursor,
      limit: 2,
    });
    moved.push(...page.quarantined);
    if (!page.nextAfterSha256) break;
    cursor = page.nextAfterSha256;
  }
  assert.deepEqual(moved.sort(), orphanShas.sort());
  assert.equal(readdirSync(join(root, "quarantine")).length, 2);
  assert.equal((await store.inspectIntegrity()).quarantined.length, 2);
  for (const sha of orphanShas)
    assert.equal(existsSync(join(root, "blobs", sha.slice(0, 2), sha)), false);
  assert(existsSync(join(freshDirectory, freshSha)));
  assert(existsSync(join(symlinkDirectory, symlinkSha)));
  for (const sha of [active.sha256, historical.sha256, tombstoned.sha256])
    assert(existsSync(join(root, "blobs", sha.slice(0, 2), sha)));
  assert.deepEqual(
    (
      await store.readRange({
        credential: "alice",
        artifactId: "gc-active",
        revision: 1,
      })
    ).bytes,
    bytes,
  );
  const audit = await store.inspectIntegrity();
  assert.deepEqual(audit.damaged, []);
  assert.deepEqual(audit.orphans, [freshSha]);
  assert(audit.unexpected.includes(`${symlinkSha.slice(0, 2)}/${symlinkSha}`));
  assert.deepEqual(
    (await store.quarantineOrphanBlobs({ minAgeMs: 0 })).quarantined,
    [freshSha],
  );
  assert.deepEqual((await store.inspectIntegrity()).orphans, []);
  assert.deepEqual(
    (await store.purgeQuarantinedOrphans({ minAgeMs: 60_000 })).removed,
    [],
    "刚隔离的字节必须经过保留期",
  );
  const reintroduced = await store.put({
    credential: "alice",
    commandId: "gc-reintroduced",
    artifactId: "gc-reintroduced",
    baseRevision: 0,
    mime: "text/plain",
    bytes: freshBytes,
  });
  assert.equal(reintroduced.sha256, freshSha);
  writeFileSync(join(root, "quarantine", "not-an-orphan"), "保留未知文件");
  const quarantineSymlink = `${Date.now()}-${active.sha256}-${randomUUID()}`;
  symlinkSync(
    join(root, "blobs", active.sha256.slice(0, 2), active.sha256),
    join(root, "quarantine", quarantineSymlink),
  );
  const removed: string[] = [];
  const retained: string[] = [];
  let afterName: string | undefined;
  for (;;) {
    const page = await store.purgeQuarantinedOrphans({
      minAgeMs: 0,
      afterName,
      limit: 1,
    });
    removed.push(...page.removed);
    retained.push(...page.retained);
    if (!page.nextAfterName) break;
    afterName = page.nextAfterName;
  }
  assert.deepEqual(removed.sort(), orphanShas.sort());
  assert.deepEqual(retained, [freshSha]);
  assert.equal(existsSync(join(root, "quarantine", "not-an-orphan")), true);
  assert.equal(existsSync(join(root, "quarantine", quarantineSymlink)), true);
  assert.deepEqual(
    (
      await store.readRange({
        credential: "alice",
        artifactId: "gc-reintroduced",
      })
    ).bytes,
    freshBytes,
  );
  for (const sha of [active.sha256, historical.sha256, tombstoned.sha256])
    assert(existsSync(join(root, "blobs", sha.slice(0, 2), sha)));
}

function delayedPublishAuthorizer() {
  let writes = 0;
  let release!: () => void;
  let entered!: () => void;
  const atPublish = new Promise<void>((resolve) => (entered = resolve));
  const continuePublish = new Promise<void>((resolve) => (release = resolve));
  const delayed: StoreAuthorizer = {
    async authorize(credential, request) {
      if (credential !== "alice" || request.storeId !== "store-one")
        throw new Error("Store 凭据无效。");
      if (request.operation === "write" && ++writes === 4) {
        entered();
        await continuePublish;
      }
      return { tenantId: "tenant-a", principalId: "alice" };
    },
  };
  return { delayed, atPublish, release: () => release() };
}

async function exercisePublishQuarantineRace(
  writer: ManagedArtifactStore,
  maintenance: ManagedArtifactStore,
  signal: ReturnType<typeof delayedPublishAuthorizer>,
  root: string,
) {
  const value = Buffer.from("发布后尚未提交 manifest");
  const sha = digest(value);
  const directory = join(root, "blobs", sha.slice(0, 2));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const orphan = join(directory, sha);
  writeFileSync(orphan, value);
  const old = new Date(Date.now() - 60_000);
  utimesSync(orphan, old, old);
  assert.deepEqual(
    (await maintenance.quarantineOrphanBlobs({ minAgeMs: 0 })).quarantined,
    [sha],
  );
  const pending = writer.put({
    credential: "alice",
    commandId: "gc-race-command",
    artifactId: "gc-race-artifact",
    baseRevision: 0,
    mime: "text/plain",
    bytes: value,
  });
  await signal.atPublish;
  let finished = false;
  const sweep = maintenance
    .quarantineOrphanBlobs({ minAgeMs: 0 })
    .then((result) => {
      finished = true;
      return result;
    });
  let purgeFinished = false;
  const purge = maintenance
    .purgeQuarantinedOrphans({ minAgeMs: 0 })
    .then((result) => {
      purgeFinished = true;
      return result;
    });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(finished, false, "回收不能越过未提交的字节发布");
    assert.equal(purgeFinished, false, "永久清理不能越过未提交的字节发布");
  } finally {
    signal.release();
  }
  await pending;
  assert.deepEqual((await sweep).quarantined, []);
  const purged = await purge;
  assert(purged.retained.includes(sha));
  assert.deepEqual(purged.removed, []);
  assert.deepEqual(
    (
      await writer.readRange({
        credential: "alice",
        artifactId: "gc-race-artifact",
      })
    ).bytes,
    value,
  );
}

async function exercisePublishFailureRecovery(
  store: ManagedArtifactStore,
  value: Buffer,
) {
  const request = {
    credential: "alice",
    commandId: "gc-failed-commit",
    artifactId: "gc-failed-artifact",
    baseRevision: 0,
    mime: "text/plain",
    bytes: value,
  };
  await assert.rejects(store.put(request), /发布后授权已撤销/);
  const receiptRequest = {
    operation: "put" as const,
    credential: request.credential,
    commandId: request.commandId,
    artifactId: request.artifactId,
    baseRevision: request.baseRevision,
    mime: request.mime,
    sha256: digest(value),
    byteLength: value.length,
  };
  assert.equal(await store.inspectCommandReceipt(receiptRequest), null);
  const before = await store.inspectIntegrity();
  assert.equal(before.manifestBlobs, 0);
  assert.deepEqual(before.orphans, [digest(value)]);
  assert.deepEqual(
    (await store.quarantineOrphanBlobs({ minAgeMs: 0 })).quarantined,
    [digest(value)],
  );
  assert.deepEqual((await store.inspectIntegrity()).orphans, []);
  const committed = await store.put(request);
  assert.equal(committed.revision, 1);
  const receipt = await store.inspectCommandReceipt(receiptRequest);
  assert.equal(receipt?.operation, "put");
  if (receipt?.operation !== "put") throw new Error("缺少已提交回执。");
  assert.deepEqual(receipt.version, committed);
  assert.deepEqual(await store.put(request), committed);
  assert.deepEqual(
    (
      await store.readRange({
        credential: "alice",
        artifactId: "gc-failed-artifact",
      })
    ).bytes,
    value,
  );
}

function failOnceAfterPublishAuthorizer(): StoreAuthorizer {
  let writes = 0;
  return {
    async authorize(credential, request) {
      if (credential !== "alice" || request.storeId !== "store-one")
        throw new Error("Store 凭据无效。");
      if (request.operation === "write" && ++writes === 4)
        throw new Error("发布后授权已撤销。");
      return { tenantId: "tenant-a", principalId: "alice" };
    },
  };
}

test("受管 Store SQLite：孤立字节仅隔离回收，历史和新文件保留", async () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-store-gc-sqlite-"));
  const store = await ManagedArtifactStore.sqlite({
    root,
    storeId: "store-one",
    authorizer,
  });
  try {
    await exerciseOrphanQuarantine(store, root);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "受管 Store SQLite：同目录双实例发布期间不能误回收",
  { timeout: 10_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "morphz-store-gc-race-sqlite-"));
    const signal = delayedPublishAuthorizer();
    let writer: ManagedArtifactStore | undefined;
    let maintenance: ManagedArtifactStore | undefined;
    try {
      writer = await ManagedArtifactStore.sqlite({
        root,
        storeId: "store-one",
        authorizer: signal.delayed,
      });
      maintenance = await ManagedArtifactStore.sqlite({
        root,
        storeId: "store-one",
        authorizer: signal.delayed,
      });
      await exercisePublishQuarantineRace(writer, maintenance, signal, root);
    } finally {
      signal.release();
      await maintenance?.close();
      await writer?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("受管 Store SQLite：字节发布后提交失败，回收与同命令重试安全", async () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-store-gc-failure-sqlite-"));
  const store = await ManagedArtifactStore.sqlite({
    root,
    storeId: "store-one",
    authorizer: failOnceAfterPublishAuthorizer(),
  });
  try {
    await exercisePublishFailureRecovery(
      store,
      Buffer.from("发布后失败的原件"),
    );
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("受管 Store 备份必须同时保留 manifest 和 Blob；缺字节时明确失败", async () => {
  const parent = mkdtempSync(join(tmpdir(), "morphz-node-store-restore-"));
  const source = join(parent, "source");
  const restored = join(parent, "restored");
  try {
    const original = await ManagedArtifactStore.sqlite({
      root: source,
      storeId: "store-one",
      authorizer,
    });
    try {
      await original.put({
        credential: "alice",
        commandId: "backup-command",
        artifactId: "backup-artifact",
        baseRevision: 0,
        mime: "text/plain",
        bytes,
      });
    } finally {
      await original.close();
    }
    cpSync(source, restored, { recursive: true });
    for (const directory of [
      restored,
      join(restored, "blobs"),
      join(restored, "blobs", digest(bytes).slice(0, 2)),
      join(restored, "staging"),
      join(restored, "quarantine"),
    ])
      chmodSync(directory, 0o700);
    const replica = await ManagedArtifactStore.sqlite({
      root: restored,
      storeId: "store-one",
      authorizer,
    });
    try {
      assert.deepEqual(
        (
          await replica.readRange({
            credential: "alice",
            artifactId: "backup-artifact",
          })
        ).bytes,
        bytes,
      );
      unlinkSync(
        join(restored, "blobs", digest(bytes).slice(0, 2), digest(bytes)),
      );
      assert.deepEqual((await replica.inspectIntegrity()).damaged, [
        digest(bytes),
      ]);
      await assert.rejects(
        replica.readRange({
          credential: "alice",
          artifactId: "backup-artifact",
        }),
        /ENOENT/,
      );
    } finally {
      await replica.close();
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("受管 Store SQLite 在线快照可恢复版本、删除和命令回执，损坏备份不入库", async () => {
  const parent = mkdtempSync(join(tmpdir(), "morphz-store-backup-api-"));
  const sourceRoot = join(parent, "source");
  const backup = join(parent, "backup");
  const restoredRoot = join(parent, "restored");
  let source: ManagedArtifactStore | undefined;
  let restored: ManagedArtifactStore | undefined;
  try {
    source = await ManagedArtifactStore.sqlite({
      root: sourceRoot,
      storeId: "store-one",
      authorizer,
    });
    const first = await source.put({
      credential: "alice",
      commandId: "snapshot-first",
      artifactId: "snapshot-artifact",
      baseRevision: 0,
      mime: "text/plain",
      bytes,
    });
    const secondBytes = Buffer.from("备份中的第二版", "utf8");
    const second = await source.put({
      credential: "alice",
      commandId: "snapshot-second",
      artifactId: "snapshot-artifact",
      baseRevision: 1,
      mime: "text/plain",
      bytes: secondBytes,
    });
    await source.put({
      credential: "alice",
      commandId: "snapshot-deleted-create",
      artifactId: "snapshot-deleted",
      baseRevision: 0,
      mime: "text/plain",
      bytes: Buffer.from("保留历史"),
    });
    const deletion = await source.delete({
      credential: "alice",
      commandId: "snapshot-delete",
      artifactId: "snapshot-deleted",
      baseRevision: 1,
    });
    const largeBytes = Buffer.alloc(1024 * 1024 + 13, 0x61);
    largeBytes.fill(0x62, 1024 * 1024);
    await source.put({
      credential: "alice",
      commandId: "snapshot-large",
      artifactId: "snapshot-large-artifact",
      baseRevision: 0,
      mime: "application/pdf",
      bytes: largeBytes,
    });
    const info = await source.backupTo(backup);
    assert.equal(info.storeId, "store-one");
    assert.equal(info.blobs, 4);
    assert(existsSync(join(backup, "backup-info.json")));
    await source.put({
      credential: "alice",
      commandId: "after-backup",
      artifactId: "not-in-backup",
      baseRevision: 0,
      mime: "text/plain",
      bytes: Buffer.from("晚于快照"),
    });

    restored = await ManagedArtifactStore.restoreSqlite({
      root: restoredRoot,
      storeId: "store-one",
      authorizer,
      backupDirectory: backup,
    });
    const restoredReceipt = await restored.inspectCommandReceipt({
      operation: "put",
      credential: "alice",
      commandId: "snapshot-second",
      artifactId: "snapshot-artifact",
      baseRevision: 1,
      mime: "text/plain",
      sha256: digest(secondBytes),
      byteLength: secondBytes.length,
    });
    assert.equal(restoredReceipt?.operation, "put");
    if (restoredReceipt?.operation !== "put")
      throw new Error("恢复后缺少写入回执。");
    assert.deepEqual(restoredReceipt.version, second);
    assert.equal(
      await restored.inspectCommandReceipt({
        operation: "put",
        credential: "alice",
        commandId: "after-backup",
        artifactId: "not-in-backup",
        baseRevision: 0,
        mime: "text/plain",
        sha256: digest(Buffer.from("晚于快照")),
        byteLength: Buffer.byteLength("晚于快照"),
      }),
      null,
    );
    assert.deepEqual(
      (
        await restored.readRange({
          credential: "alice",
          artifactId: "snapshot-artifact",
        })
      ).bytes,
      secondBytes,
    );
    assert.deepEqual(
      (
        await restored.readRange({
          credential: "alice",
          artifactId: "snapshot-artifact",
          revision: 1,
        })
      ).bytes,
      bytes,
    );
    assert.deepEqual(
      (
        await restored.readRange({
          credential: "alice",
          artifactId: "snapshot-large-artifact",
          start: 1024 * 1024 - 5,
          endExclusive: 1024 * 1024 + 5,
        })
      ).bytes,
      largeBytes.subarray(1024 * 1024 - 5, 1024 * 1024 + 5),
    );
    assert.deepEqual(
      await restored.put({
        credential: "alice",
        commandId: "snapshot-first",
        artifactId: "snapshot-artifact",
        baseRevision: 0,
        mime: "text/plain",
        bytes,
      }),
      first,
    );
    assert.deepEqual(
      await restored.put({
        credential: "alice",
        commandId: "snapshot-second",
        artifactId: "snapshot-artifact",
        baseRevision: 1,
        mime: "text/plain",
        bytes: secondBytes,
      }),
      second,
    );
    assert.deepEqual(
      await restored.delete({
        credential: "alice",
        commandId: "snapshot-delete",
        artifactId: "snapshot-deleted",
        baseRevision: 1,
      }),
      deletion,
    );
    assert.deepEqual(
      await restored.inspectCommandReceipt({
        operation: "delete",
        credential: "alice",
        commandId: "snapshot-delete",
        artifactId: "snapshot-deleted",
        baseRevision: 1,
      }),
      { operation: "delete", ...deletion },
    );
    await restored.put({
      credential: "alice",
      commandId: "after-restore",
      artifactId: "restored-new-artifact",
      baseRevision: 0,
      mime: "text/plain",
      bytes: Buffer.from("恢复后的新版本"),
    });
    await assert.rejects(
      restored.readRange({ credential: "alice", artifactId: "not-in-backup" }),
      /不存在/,
    );
    assert.deepEqual((await restored.inspectIntegrity()).damaged, []);
    await restored.close();
    restored = undefined;

    await assert.rejects(
      ManagedArtifactStore.restoreSqlite({
        root: restoredRoot,
        storeId: "store-one",
        authorizer,
        backupDirectory: backup,
      }),
      /已有业务数据/,
    );
    const damagedRoot = join(parent, "damaged-target");
    unlinkSync(join(backup, "blobs", first.sha256.slice(0, 2), first.sha256));
    await assert.rejects(
      ManagedArtifactStore.restoreSqlite({
        root: damagedRoot,
        storeId: "store-one",
        authorizer,
        backupDirectory: backup,
      }),
      /ENOENT/,
    );
    const afterFailure = await ManagedArtifactStore.sqlite({
      root: damagedRoot,
      storeId: "store-one",
      authorizer,
    });
    try {
      assert.equal((await afterFailure.inspectIntegrity()).manifestBlobs, 0);
    } finally {
      await afterFailure.close();
    }
  } finally {
    await restored?.close();
    await source?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("受管 Store 完整性失败不会发布可恢复备份", async () => {
  const parent = mkdtempSync(join(tmpdir(), "morphz-store-backup-damaged-"));
  const sourceRoot = join(parent, "source");
  const backup = join(parent, "backup");
  let store: ManagedArtifactStore | undefined;
  try {
    store = await ManagedArtifactStore.sqlite({
      root: sourceRoot,
      storeId: "store-one",
      authorizer,
    });
    const version = await store.put({
      credential: "alice",
      commandId: "damaged-command",
      artifactId: "damaged-artifact",
      baseRevision: 0,
      mime: "text/plain",
      bytes,
    });
    writeFileSync(
      join(sourceRoot, "blobs", version.sha256.slice(0, 2), version.sha256),
      Buffer.alloc(bytes.length, 0x5a),
    );
    await assert.rejects(store.backupTo(backup), /摘要损坏/);
    assert.equal(existsSync(join(backup, "backup-info.json")), false);
  } finally {
    await store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("受管 Store 分块 manifest 与字节不符时拒绝发布备份", async () => {
  const parent = mkdtempSync(join(tmpdir(), "morphz-store-backup-chunk-"));
  const sourceRoot = join(parent, "source");
  const backup = join(parent, "backup");
  let store: ManagedArtifactStore | undefined;
  try {
    store = await ManagedArtifactStore.sqlite({
      root: sourceRoot,
      storeId: "store-one",
      authorizer,
    });
    const version = await store.put({
      credential: "alice",
      commandId: "chunk-command",
      artifactId: "chunk-artifact",
      baseRevision: 0,
      mime: "text/plain",
      bytes,
    });
    const database = new DatabaseSync(join(sourceRoot, "manifest.sqlite"));
    try {
      database
        .prepare("UPDATE blob_chunks SET chunk_sha256=? WHERE sha256=?")
        .run("0".repeat(64), version.sha256);
    } finally {
      database.close();
    }
    await assert.rejects(
      store.verifyVersion({
        credential: "alice",
        artifactId: "chunk-artifact",
      }),
      /分块摘要损坏/,
    );
    await assert.rejects(store.backupTo(backup), /分块 manifest/);
    assert.equal(existsSync(join(backup, "backup-info.json")), false);
  } finally {
    await store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("受管 Store 备份按主键跨 500 行分页，不漏掉尾部原件与回执", async () => {
  const parent = mkdtempSync(join(tmpdir(), "morphz-store-backup-pages-"));
  let source: ManagedArtifactStore | undefined;
  let restored: ManagedArtifactStore | undefined;
  try {
    source = await ManagedArtifactStore.sqlite({
      root: join(parent, "source"),
      storeId: "store-one",
      authorizer,
    });
    for (let index = 0; index < 503; index++)
      await source.put({
        credential: "alice",
        commandId: `page-command-${String(index).padStart(4, "0")}`,
        artifactId: `page-artifact-${String(index).padStart(4, "0")}`,
        baseRevision: 0,
        mime: "text/plain",
        bytes,
      });
    const backupDirectory = join(parent, "backup");
    const info = await source.backupTo(backupDirectory);
    assert.equal(info.blobs, 1);
    assert.equal(info.rows, 1 + 1 + 503 * 3);
    restored = await ManagedArtifactStore.restoreSqlite({
      root: join(parent, "restored"),
      storeId: "store-one",
      authorizer,
      backupDirectory,
    });
    for (const index of [0, 499, 500, 502])
      assert.deepEqual(
        (
          await restored.readRange({
            credential: "alice",
            artifactId: `page-artifact-${String(index).padStart(4, "0")}`,
          })
        ).bytes,
        bytes,
      );
    assert.equal((await restored.inspectIntegrity()).manifestBlobs, 1);
  } finally {
    await restored?.close();
    await source?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test(
  "受管 Store PostgreSQL：同一 manifest 合同与独立字节目录",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "morphz-node-store-pg-"));
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
    });
    const client = await pool.connect();
    try {
      await assert.rejects(
        ManagedArtifactStore.postgres({
          root,
          storeId: "store-one",
          authorizer,
          connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
          schema,
        }),
        /schema 不存在/,
      );
      await client.query(`CREATE SCHEMA "${schema}"`);
      const store = await ManagedArtifactStore.postgres({
        root,
        storeId: "store-one",
        authorizer,
        connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
        schema,
      });
      try {
        await exercise(store, root);
      } finally {
        await store.close();
      }
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "受管 Store PostgreSQL：一个字节目录只能绑定一个 manifest 实例",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const parent = mkdtempSync(join(tmpdir(), "morphz-store-root-binding-"));
    const root = join(parent, "bound");
    const otherRoot = join(parent, "sqlite-bound");
    const schemaA = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const schemaB = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const admin = new Pool({ connectionString });
    let first: ManagedArtifactStore | undefined;
    await admin.query(`CREATE SCHEMA "${schemaA}"`);
    await admin.query(`CREATE SCHEMA "${schemaB}"`);
    try {
      const options = {
        root,
        storeId: "store-one",
        authorizer,
        connectionString,
        schema: schemaA,
      };
      first = await ManagedArtifactStore.postgres(options);
      const stored = await first.put({
        credential: "alice",
        commandId: "root-binding-original",
        artifactId: "root-binding-artifact",
        baseRevision: 0,
        mime: "text/plain",
        bytes,
      });
      await assert.rejects(
        ManagedArtifactStore.postgres({ ...options, schema: schemaB }),
        /字节目录已绑定其他 manifest 实例/,
      );
      await assert.rejects(
        ManagedArtifactStore.sqlite({ root, storeId: "store-one", authorizer }),
        /已绑定 PostgreSQL manifest/,
      );
      assert.deepEqual(
        (
          await first.readRange({
            credential: "alice",
            artifactId: "root-binding-artifact",
          })
        ).bytes,
        bytes,
      );
      assert.equal((await first.inspectIntegrity()).usageMismatch, false);
      await first.close();
      first = undefined;
      unlinkSync(join(root, "store-root.json"));
      await assert.rejects(
        ManagedArtifactStore.postgres(options),
        /已有其他 manifest 的文件/,
      );
      await assert.rejects(
        ManagedArtifactStore.sqlite({ root, storeId: "store-one", authorizer }),
        /已有其他 manifest 的文件/,
      );
      assert.equal(
        existsSync(
          join(root, "blobs", stored.sha256.slice(0, 2), stored.sha256),
        ),
        true,
      );

      const sqlite = await ManagedArtifactStore.sqlite({
        root: otherRoot,
        storeId: "store-one",
        authorizer,
      });
      await sqlite.close();
      await assert.rejects(
        ManagedArtifactStore.postgres({
          ...options,
          root: otherRoot,
          schema: schemaB,
        }),
        /已包含 SQLite manifest/,
      );
    } finally {
      await first?.close();
      await admin.query(`DROP SCHEMA "${schemaB}" CASCADE`);
      await admin.query(`DROP SCHEMA "${schemaA}" CASCADE`);
      await admin.end();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "受管 Store PostgreSQL：空 Store 可修复中断的目录绑定发布",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "morphz-store-root-repair-"));
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const options = {
        root,
        storeId: "store-one",
        authorizer,
        connectionString,
        schema,
      };
      const first = await ManagedArtifactStore.postgres(options);
      await first.close();
      unlinkSync(join(root, "store-root.json"));
      const reopened = await ManagedArtifactStore.postgres(options);
      try {
        assert.equal(existsSync(join(root, "store-root.json")), true);
        assert.equal((await reopened.inspectIntegrity()).manifestBlobs, 0);
      } finally {
        await reopened.close();
      }
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "受管 Store PostgreSQL：两个 schema 并发争用同一空目录只能有一个成功",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "morphz-store-root-race-"));
    const schemas = [
      `morphz_test_${randomUUID().replaceAll("-", "")}`,
      `morphz_test_${randomUUID().replaceAll("-", "")}`,
    ];
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const admin = new Pool({ connectionString });
    for (const schema of schemas)
      await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const results = await Promise.allSettled(
        schemas.map((schema) =>
          ManagedArtifactStore.postgres({
            root,
            storeId: "store-one",
            authorizer,
            connectionString,
            schema,
          }),
        ),
      );
      const winners = results.filter(
        (result): result is PromiseFulfilledResult<ManagedArtifactStore> =>
          result.status === "fulfilled",
      );
      try {
        assert.equal(winners.length, 1);
        assert.equal(
          results.filter((result) => result.status === "rejected").length,
          1,
        );
        await winners[0]!.value.put({
          credential: "alice",
          commandId: "root-race-winner",
          artifactId: "root-race-artifact",
          baseRevision: 0,
          mime: "text/plain",
          bytes,
        });
        assert.equal(
          (await winners[0]!.value.inspectIntegrity()).manifestBlobs,
          1,
        );
      } finally {
        for (const winner of winners) await winner.value.close();
      }
    } finally {
      for (const schema of schemas)
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "受管 Store PostgreSQL：授权精确绑定版本与命令",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "morphz-store-scope-pg-"));
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
    });
    const grant = exactScopeAuthorizer();
    await pool.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await ManagedArtifactStore.postgres({
        root,
        storeId: "store-one",
        connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
        schema,
        authorizer: grant.scoped,
      });
      try {
        await exerciseExactAuthorizationScope(store, grant);
      } finally {
        await store.close();
      }
    } finally {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "受管 Store PostgreSQL：跨连接总容量按去重后的已提交字节串行计算",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "morphz-store-quota-pg-"));
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const admin = new Pool({ connectionString });
    let primary: ManagedArtifactStore | undefined;
    let secondary: ManagedArtifactStore | undefined;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    try {
      const options = {
        root,
        storeId: "store-one",
        authorizer,
        connectionString,
        schema,
        maxCommittedBytes: 7,
      };
      primary = await ManagedArtifactStore.postgres(options);
      await assert.rejects(
        ManagedArtifactStore.postgres({ ...options, maxCommittedBytes: 8 }),
        /容量策略与已登记 manifest 不一致/,
      );
      secondary = await ManagedArtifactStore.postgres(options);
      await exerciseCommittedCapacity(primary, secondary, root);
    } finally {
      await secondary?.close();
      await primary?.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "受管 Store PostgreSQL：孤立字节隔离与双实例发布排斥",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL, timeout: 15_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "morphz-store-gc-pg-"));
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
    });
    const client = await pool.connect();
    let store: ManagedArtifactStore | undefined;
    let writer: ManagedArtifactStore | undefined;
    let maintenance: ManagedArtifactStore | undefined;
    const signal = delayedPublishAuthorizer();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      store = await ManagedArtifactStore.postgres({
        root,
        storeId: "store-one",
        connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
        schema,
        authorizer,
      });
      await exerciseOrphanQuarantine(store, root);
      await store.close();
      store = undefined;
      writer = await ManagedArtifactStore.postgres({
        root,
        storeId: "store-one",
        connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
        schema,
        authorizer: signal.delayed,
      });
      maintenance = await ManagedArtifactStore.postgres({
        root,
        storeId: "store-one",
        connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
        schema,
        authorizer: signal.delayed,
      });
      await exercisePublishQuarantineRace(writer, maintenance, signal, root);
    } finally {
      signal.release();
      await maintenance?.close();
      await writer?.close();
      await store?.close();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "受管 Store PostgreSQL：字节发布后提交失败，回收与同命令重试安全",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "morphz-store-gc-failure-pg-"));
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
    });
    const client = await pool.connect();
    let store: ManagedArtifactStore | undefined;
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      store = await ManagedArtifactStore.postgres({
        root,
        storeId: "store-one",
        connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
        schema,
        authorizer: failOnceAfterPublishAuthorizer(),
      });
      await exercisePublishFailureRecovery(
        store,
        Buffer.from("发布后失败的原件"),
      );
    } finally {
      await store?.close();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "受管 Store PostgreSQL：读取期间撤权或删除不得返回已读取字节",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "morphz-node-store-read-race-pg-"));
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const { state, authorizer } = readRaceAuthorizer();
    const pool = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
    });
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      const store = await ManagedArtifactStore.postgres({
        root,
        storeId: "store-one",
        connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
        schema,
        authorizer,
      });
      try {
        await exerciseReadRace(store, state);
      } finally {
        await store.close();
      }
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "受管 Store PostgreSQL manifest 与私有 Blob 共同备份，恢复至独立 schema",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const parent = mkdtempSync(join(tmpdir(), "morphz-store-pg-backup-"));
    const suffix = randomUUID().replaceAll("-", "");
    const sourceSchema = `store_source_${suffix}`;
    const targetSchema = `store_restored_${suffix}`;
    const pool = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
    });
    const client = await pool.connect();
    let source: ManagedArtifactStore | undefined;
    let restored: ManagedArtifactStore | undefined;
    try {
      await client.query(`CREATE SCHEMA "${sourceSchema}"`);
      await client.query(`CREATE SCHEMA "${targetSchema}"`);
      source = await ManagedArtifactStore.postgres({
        root: join(parent, "source"),
        storeId: "store-one",
        authorizer,
        connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
        schema: sourceSchema,
      });
      const saved = await source.put({
        credential: "alice",
        commandId: "pg-backup-command",
        artifactId: "pg-backup-artifact",
        baseRevision: 0,
        mime: "application/pdf",
        bytes,
      });
      const backupDirectory = join(parent, "backup");
      await source.backupTo(backupDirectory);
      restored = await ManagedArtifactStore.restorePostgres({
        root: join(parent, "restored"),
        storeId: "store-one",
        authorizer,
        connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
        schema: targetSchema,
        backupDirectory,
      });
      assert.deepEqual(
        (
          await restored.readRange({
            credential: "alice",
            artifactId: "pg-backup-artifact",
          })
        ).bytes,
        bytes,
      );
      assert.deepEqual(
        await restored.put({
          credential: "alice",
          commandId: "pg-backup-command",
          artifactId: "pg-backup-artifact",
          baseRevision: 0,
          mime: "application/pdf",
          bytes,
        }),
        saved,
      );
      assert.deepEqual((await restored.inspectIntegrity()).damaged, []);
    } finally {
      await restored?.close();
      await source?.close();
      await client.query(`DROP SCHEMA IF EXISTS "${targetSchema}" CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`);
      client.release();
      await pool.end();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "受管 Store 备份可在 SQLite 与 PostgreSQL 间双向恢复同一原件和回执",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const parent = mkdtempSync(join(tmpdir(), "morphz-store-cross-backend-"));
    const suffix = randomUUID().replaceAll("-", "");
    const sourceSchema = `store_cross_source_${suffix}`;
    const targetSchema = `store_cross_target_${suffix}`;
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const pool = new Pool({ connectionString });
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${sourceSchema}"`);
      await client.query(`CREATE SCHEMA "${targetSchema}"`);
      for (const sourceBackend of ["sqlite", "postgres"] as const) {
        const direction = sourceBackend === "sqlite" ? "to-pg" : "to-sqlite";
        const sourceRoot = join(parent, direction, "source");
        const restoredRoot = join(parent, direction, "restored");
        const backupDirectory = join(parent, direction, "backup");
        let source: ManagedArtifactStore | undefined;
        let restored: ManagedArtifactStore | undefined;
        try {
          source =
            sourceBackend === "sqlite"
              ? await ManagedArtifactStore.sqlite({
                  root: sourceRoot,
                  storeId: "store-one",
                  authorizer,
                })
              : await ManagedArtifactStore.postgres({
                  root: sourceRoot,
                  storeId: "store-one",
                  authorizer,
                  connectionString,
                  schema: sourceSchema,
                });
          const first = await source.put({
            credential: "alice",
            commandId: `${direction}-first`,
            artifactId: "migrated-artifact",
            baseRevision: 0,
            mime: "text/plain",
            bytes,
          });
          const newerBytes = Buffer.alloc(1024 * 1024 + 17, 0x61);
          newerBytes.fill(0x62, 1024 * 1024);
          const newer = await source.put({
            credential: "alice",
            commandId: `${direction}-second`,
            artifactId: "migrated-artifact",
            baseRevision: 1,
            mime: "application/pdf",
            bytes: newerBytes,
          });
          await source.backupTo(backupDirectory);
          restored =
            sourceBackend === "sqlite"
              ? await ManagedArtifactStore.restorePostgres({
                  root: restoredRoot,
                  storeId: "store-one",
                  authorizer,
                  connectionString,
                  schema: targetSchema,
                  backupDirectory,
                })
              : await ManagedArtifactStore.restoreSqlite({
                  root: restoredRoot,
                  storeId: "store-one",
                  authorizer,
                  backupDirectory,
                });
          assert.deepEqual(
            (
              await restored.readRange({
                credential: "alice",
                artifactId: "migrated-artifact",
                revision: 1,
              })
            ).bytes,
            bytes,
          );
          assert.deepEqual(
            (
              await restored.readRange({
                credential: "alice",
                artifactId: "migrated-artifact",
                start: 1024 * 1024 - 4,
                endExclusive: 1024 * 1024 + 8,
              })
            ).bytes,
            newerBytes.subarray(1024 * 1024 - 4, 1024 * 1024 + 8),
          );
          assert.deepEqual(
            await restored.verifyVersion({
              credential: "alice",
              artifactId: "migrated-artifact",
            }),
            newer,
          );
          assert.deepEqual(
            await restored.put({
              credential: "alice",
              commandId: `${direction}-first`,
              artifactId: "migrated-artifact",
              baseRevision: 0,
              mime: "text/plain",
              bytes,
            }),
            first,
          );
          await assert.rejects(
            restored.readRange({
              credential: "bob",
              artifactId: "migrated-artifact",
            }),
            /读取权限/,
          );
          assert.deepEqual((await restored.inspectIntegrity()).damaged, []);
        } finally {
          await restored?.close();
          await source?.close();
        }
      }
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${targetSchema}" CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`);
      client.release();
      await pool.end();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
