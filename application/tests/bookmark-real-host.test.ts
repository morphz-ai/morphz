import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import type { RuntimeBridge } from "../packages/application/src/runtime.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { initialWorkspace, localAccess } from "../packages/core/src/model.js";
import { bookmarkSchema } from "../packages/core/src/bookmarks.js";
import { migrateBookmarksOnce } from "../scripts/migrate-bookmarks-once.js";

/** An offline legacy-format migration input, not a production write path.
 * Only test-created directories call this helper. The current Host never
 * needs a workspace snapshot, even when an old table exists alongside it. */
function legacyBookmarkFixture(directory: string, title: string, url: string) {
  const filename = join(directory, "workspace.sqlite");
  const transport = new WorkspaceStore(filename);
  transport.close();
  const now = "2026-09-30T00:00:00.000Z";
  const state = initialWorkspace(now);
  const bookmark = bookmarkSchema.parse({
    id: randomUUID(),
    ownerPrincipalId: localAccess.principalId,
    title,
    url,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: localAccess,
    updatedBy: localAccess,
    deletedAt: null,
  });
  state.bookmarks = [bookmark];
  state.revision = 1;
  const result = {
    state,
    receipt: {
      commandId: bookmark.id,
      workspaceRevision: state.revision,
      entityId: bookmark.id,
    },
  };
  const body = JSON.stringify(result.state);
  const db = new DatabaseSync(filename);
  try {
    db.exec(
      "CREATE TABLE workspace(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO workspace(id,body) VALUES(1,?)").run(body);
  } finally {
    db.close();
  }
  return { ...result, body };
}

function legacyBody(directory: string) {
  const db = new DatabaseSync(join(directory, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    return (
      db.prepare("SELECT body FROM workspace WHERE id=1").get() as {
        body: string;
      }
    ).body;
  } finally {
    db.close();
  }
}

test("真实 Desktop Host 用独立 Browser 库保存收藏，重启后仍可读取", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-bookmark-host-"));
  const profile = join(directory, "profile");
  mkdirSync(profile);
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  try {
    host = await openEmbeddedApplication(directory, profile);
    const boot = (await host.connection.call("platform.bootstrap")) as {
      csrfToken: string;
      capabilities: { browserBookmarks: boolean };
    };
    assert.equal(boot.capabilities.browserBookmarks, true);
    const command = {
      commandId: randomUUID(),
      operation: {
        type: "bookmark-add",
        title: "新域收藏",
        url: "https://example.com/real-host",
      },
    };
    const receipt = await host.connection.call("bookmarks.command", command, {
      identityGeneration: boot.csrfToken,
    });
    assert.deepEqual(
      await host.connection.call("bookmarks.command", command, {
        identityGeneration: boot.csrfToken,
      }),
      receipt,
    );
    await host.close();
    host = undefined;

    const transport = new DatabaseSync(join(directory, "workspace.sqlite"), {
      readOnly: true,
    });
    try {
      assert.deepEqual(
        transport
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace','commands','assets')",
          )
          .all(),
        [],
      );
    } finally {
      transport.close();
    }
    host = await openEmbeddedApplication(directory, profile);
    const reopened = (await host.connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const saved = (await host.connection.call(
      "bookmarks.list",
      {},
      {
        identityGeneration: reopened.csrfToken,
      },
    )) as Array<{
      title: string;
    }>;
    assert.deepEqual(
      saved.map((bookmark) => bookmark.title),
      ["新域收藏"],
    );
  } finally {
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("正式 Host 不读取旧收藏作为启动条件，也不改写旧记录", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-bookmark-guard-"));
  const profile = join(directory, "profile");
  mkdirSync(profile);
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  try {
    const old = legacyBookmarkFixture(
      directory,
      "原收藏",
      "https://example.com/old",
    );
    host = await openEmbeddedApplication(directory, profile);
    const boot = (await host.connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    assert.deepEqual(
      await host.connection.call(
        "bookmarks.list",
        {},
        {
          identityGeneration: boot.csrfToken,
        },
      ),
      [],
    );
    await host.close();
    host = undefined;
    assert.equal(legacyBody(directory), old.body);
  } finally {
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("一次性冷迁入保留收藏身份与修订，旧工作区不再作为收藏写入权威", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-bookmark-cutover-"));
  const profile = join(directory, "profile");
  mkdirSync(profile);
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  try {
    const old = legacyBookmarkFixture(
      directory,
      "待迁入收藏",
      "https://example.com/cutover",
    );
    const receipt = old.receipt;
    const before = old.state.bookmarks[0]!;
    const moved = await migrateBookmarksOnce(directory);
    assert.equal(moved.migrated, 1);
    assert.ok(moved.backupFile && existsSync(moved.backupFile));
    assert.deepEqual(await migrateBookmarksOnce(directory), {
      migrated: 0,
      backupFile: null,
    });
    assert.deepEqual(
      (JSON.parse(legacyBody(directory)) as { bookmarks: unknown[] }).bookmarks,
      [],
    );

    host = await openEmbeddedApplication(directory, profile);
    const boot = (await host.connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const saved = (await host.connection.call(
      "bookmarks.list",
      {},
      {
        identityGeneration: boot.csrfToken,
      },
    )) as Array<{ id: string; revision: number; title: string }>;
    assert.deepEqual(
      saved.map(({ id, revision, title }) => ({ id, revision, title })),
      [
        {
          id: receipt.entityId,
          revision: before.revision,
          title: before.title,
        },
      ],
    );
  } finally {
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("真实收藏 Host 每次核验 Agent 原始输入与当前 Human 权限", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-bookmark-agent-host-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  const inputId = "runtime-bookmark-input";
  const route = {
    job_id: "job-one",
    tool_call_id: "call-one",
    session_id: "session-one",
    context_id: "context-one",
    principal_id: "runtime-owner",
    agent_id: "runtime-agent",
    thread_id: "thread-one",
    target_id: "target-one",
  };
  const member = {
    ...localAccess,
    loginTokenHash: createHash("sha256").update("a".repeat(64)).digest("hex"),
    enabled: true,
  };
  const identity = new IdentityCenter(workspace, {
    version: 1,
    members: [member],
  });
  const runtime = {
    teamIdentity: false,
    bindPlatformInputAuthority: () => {},
    bindPlatformReadAuthority: () => {},
    bindMessageAttachments: () => {},
    bindPlatformAgentScope: () => {},
    inputEvidenceReader: () => ({
      async readThread() {
        return {
          snapshot: {
            thread: {
              id: route.thread_id,
              session_id: route.session_id,
              context_id: route.context_id,
              root_turn_id: "root-one",
              initiating_principal_id: route.principal_id,
              agent_id: route.agent_id,
              executor_kind: "agent",
              executor_id: null,
            },
          },
        };
      },
      async readSessionEvent() {
        return {
          id: "root-one",
          actor: "Session-Client",
          type: "session_message",
          topic: "chat/user_message",
          payload: {
            session_id: route.session_id,
            context_id: route.context_id,
            principal_id: route.principal_id,
            client_message_id: inputId,
            session_io: {
              request: {
                io_version: "1",
                client_message_id: inputId,
                message: {
                  format: { id: "morphz.application.input", version: "1" },
                  content: {
                    encoding: "json",
                    value: {
                      type: "object",
                      value: {
                        input_id: { type: "string", value: inputId },
                        workspace_id: {
                          type: "string",
                          value: "first-project",
                        },
                        author_actant_id: {
                          type: "string",
                          value: localAccess.actantId,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        };
      },
    }),
  } as unknown as RuntimeBridge;
  const domain = await openApplicationDomainsHost(
    directory,
    workspace,
    identity,
  );
  try {
    await domain.content.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        domain.content.platform.createProject(actor, {
          commandId: "bookmark-project-command",
          projectId: "first-project",
          title: "收藏所在项目",
        }),
    );
    assert.equal(workspace.runtimeState(), null);
    const agent = domain.bindRuntime(runtime);
    await agent.authority.withInvocation(route, (actor) =>
      agent.service.command(actor, {
        commandId: randomUUID(),
        operation: {
          type: "bookmark-add",
          title: "Agent 收藏",
          url: "https://example.com/agent-host",
        },
      }),
    );
    assert.equal(
      (
        await domain.browser.authority.withSession(
          localAccess,
          () => {},
          (actor) => domain.browser.service.list(actor),
        )
      ).length,
      1,
    );
    await identity.replaceConfiguration({
      version: 1,
      members: [{ ...member, enabled: false }],
    });
    await assert.rejects(
      agent.authority.withInvocation(route, (actor) =>
        agent.service.list(actor),
      ),
      /身份已失效/,
    );
    await identity.replaceConfiguration({ version: 1, members: [member] });
    await assert.rejects(
      agent.authority.withInvocation(
        { ...route, principal_id: "forged" },
        (actor) => agent.service.list(actor),
      ),
      /原始应用输入/,
    );
  } finally {
    await domain.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
