import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  embeddedApplicationInstanceIds,
  openApplicationDomainsHost,
} from "../packages/application/src/application-domains-host.js";
import { readEmbeddedApplicationInstanceIds } from "../packages/application/src/embedded-application-identity.js";
import { backupCenterStorage } from "../packages/application/src/center-backup.js";
import { createDocument } from "../packages/application/src/document-service.js";
import { searchContent } from "../packages/application/src/content-search-service.js";
import {
  createScriptItem,
  createScriptProduction,
} from "../packages/application/src/script-production-service.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import {
  identityConfiguration,
  loadIdentity,
  readCenterMembers,
} from "../packages/application/src/identity-config.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import type { RuntimeBridge } from "../packages/application/src/runtime.js";
import {
  runtimeAgentTools,
  type HostInvocation,
} from "../packages/application/src/agent-tools.js";
import { localAccess } from "../packages/core/src/model.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import { emptyInteractive } from "../packages/core/src/interactive.js";
import {
  assertNoLegacyBusinessTables,
  forbidLegacySnapshot,
} from "./host-transport-invariant.js";

function assertNoLegacyParticipants(directory: string) {
  assertNoLegacyBusinessTables(join(directory, "workspace.sqlite"));
}

test("团队成员加载与授权更新不再改写旧 workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-team-cutover-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    assertNoLegacyParticipants(directory);
    const file = join(directory, "members.json");
    const config = {
      version: 1 as const,
      members: [
        {
          ...localAccess,
          name: "我",
          projectIds: [] as string[],
          enabled: true,
          loginTokenHash: createHash("sha256")
            .update("a".repeat(64))
            .digest("hex"),
        },
        {
          principalId: "team-bob",
          actantId: "team-bob-human",
          name: "同伴",
          projectIds: [] as string[],
          enabled: true,
          loginTokenHash: createHash("sha256")
            .update("b".repeat(64))
            .digest("hex"),
        },
      ],
    };
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    const identity = (await loadIdentity(workspace, directory))!;
    domains = await openApplicationDomainsHost(directory, workspace, identity);
    const { authority, service } = domains.work;
    await authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        service.createProject(actor, {
          commandId: "team-cutover-project-command",
          projectId: "team-cutover-project",
          title: "共同项目",
        }),
    );
    config.members[1]!.projectIds = ["team-cutover-project"];
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    const reloaded = readCenterMembers(directory)!;
    await identity.replaceConfiguration(
      identityConfiguration(reloaded),
      reloaded.members,
    );
    const bob = { principalId: "team-bob", actantId: "team-bob-human" };
    const visible = await authority.withSession(
      bob,
      () => {},
      (actor) => service.listProjects(actor, {}),
    );
    assert.ok(visible.some((project) => project.id === "team-cutover-project"));
    assertNoLegacyParticipants(directory);
  } finally {
    await domains?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Platform 启动与项目读取不反序列化旧工作区快照", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-boot-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    domains = await openApplicationDomainsHost(directory, workspace);
    const connection = new LocalApplicationConnection(
      new Application(workspace, { platformWork: domains.work }),
    );
    const snapshot = forbidLegacySnapshot(workspace);
    try {
      const boot = (await connection.call("platform.bootstrap")) as {
        centerId: string;
        csrfToken: string;
        principalId: string;
      };
      assert.equal(boot.centerId, workspace.identity());
      assert.equal(boot.principalId, localAccess.principalId);
      assert.deepEqual(
        await connection.call(
          "projects.list",
          {},
          {
            identityGeneration: boot.csrfToken,
          },
        ),
        [],
      );
    } finally {
      snapshot.restore();
      connection.close();
    }
  } finally {
    await domains?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("多人身份下 Platform 项目和事项不从旧工作区参与者列表取权威", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-team-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  const configuration = {
    version: 1,
    members: [
      {
        ...localAccess,
        loginTokenHash: createHash("sha256")
          .update("a".repeat(64))
          .digest("hex"),
        enabled: true,
      },
    ],
  } as const;
  const identity = new IdentityCenter(workspace, configuration);
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    domains = await openApplicationDomainsHost(directory, workspace, identity);
    assertNoLegacyParticipants(directory);
    await identity.replaceConfiguration(configuration);
    const token = await identity.login("a".repeat(64), "team-test");
    assert.deepEqual(
      identity.authenticate(`${identity.cookieName}=${token}`)?.access,
      localAccess,
    );
    const { authority, platform } = domains.content;
    await authority.withSession(
      localAccess,
      () => {},
      async (actor) => {
        await platform.createProject(actor, {
          commandId: "team-project-command",
          projectId: "team-project",
          title: "团队项目",
        });
        await platform.createTask(actor, {
          commandId: "team-task-command",
          taskId: "team-task",
          projectId: "team-project",
          title: "团队事项",
          assigneeId: localAccess.actantId,
        });
        assert.deepEqual(
          (await platform.listTasks(actor, "team-project")).map(
            (task) => task.task_id,
          ),
          ["team-task"],
        );
      },
    );
    await identity.replaceConfiguration({
      version: 1,
      members: [{ ...configuration.members[0], enabled: false }],
    });
    assert.equal(
      identity.authenticate(`${identity.cookieName}=${token}`),
      null,
    );
    await assert.rejects(
      authority.withSession(
        localAccess,
        () => {},
        (actor) => platform.listProjects(actor),
      ),
      /当前用户身份已失效/,
    );
  } finally {
    await domains?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("正式 Host 从 Platform 目录打开、创建和修订文档原件，不写旧工作区", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "morphz-platform-document-host-"),
  );
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    domains = await openApplicationDomainsHost(directory, workspace);
    await domains.content.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        domains!.content.platform.createProject(actor, {
          commandId: "document-project-command",
          projectId: "document-project",
          title: "文档项目",
        }),
    );
    const connection = new LocalApplicationConnection(
      new Application(workspace, {
        platformWork: domains.work,
        platformDocuments: domains.content,
      }),
    );
    try {
      const boot = (await connection.call("platform.bootstrap")) as {
        csrfToken: string;
      };
      const call = (
        method: Parameters<typeof connection.call>[0],
        input: unknown,
      ) =>
        connection.call(method, input, {
          identityGeneration: boot.csrfToken,
        });
      const create = {
        commandId: randomUUID(),
        objectId: "document-original",
        projectId: "document-project",
        title: "初稿",
        markdown: "第一版正文",
      };
      const original = (await call("documents.create", create)) as {
        contentId: string;
        versionRef: string;
      };
      assert.equal(original.versionRef, "1");
      assert.deepEqual(await call("documents.create", create), original);
      const directoryItems = (await call("content.list", {
        projectId: "document-project",
      })) as Array<{ id: string; appObjectId: string }>;
      assert.deepEqual(
        directoryItems.map((item) => item.id),
        [original.contentId],
      );
      assert.equal(directoryItems[0]!.appObjectId, create.objectId);
      const imported = {
        commandId: randomUUID(),
        objectId: "imported-document",
        projectId: "document-project",
        relativePath: "史料/第二章.md",
        text: "导入正文",
      };
      const importReceipt = (await call("documents.import", imported)) as {
        contentId: string;
        versionRef: string;
      };
      assert.equal(importReceipt.versionRef, "1");
      assert.deepEqual(await call("documents.import", imported), importReceipt);
      const importedObject = (await call("objects.read", {
        contentId: importReceipt.contentId,
      })) as {
        content: { kind: string; markdown: string };
        source: {
          mode: string;
          relativePath: string;
          importedRevision: number;
        };
      };
      assert.equal(importedObject.content.markdown, imported.text);
      assert.equal(importedObject.source.mode, "copy");
      assert.equal(importedObject.source.relativePath, imported.relativePath);
      assert.equal(importedObject.source.importedRevision, 1);
      await assert.rejects(
        call("documents.import", {
          ...imported,
          relativePath: "史料/不同来源.md",
        }),
        /相同命令 ID 对应不同内容请求/,
      );
      await assert.rejects(
        call("documents.import", {
          ...imported,
          commandId: randomUUID(),
          relativePath: ".hidden.md",
        }),
        /隐藏文件/,
      );
      const revision = (await call("documents.revise", {
        commandId: randomUUID(),
        contentId: original.contentId,
        expectedRevision: 1,
        title: "定稿",
        markdown: "第二版正文",
      })) as { versionRef: string };
      assert.equal(revision.versionRef, "2");
      const current = (await call("documents.read", {
        contentId: original.contentId,
      })) as { title: string; markdown: string; headRevision: number };
      assert.equal(current.title, "定稿");
      assert.equal(current.markdown, "第二版正文");
      assert.equal(current.headRevision, 2);
      const legacySnapshot = forbidLegacySnapshot(workspace);
      try {
        const titles = (await call("search", {
          query: "定稿",
          projectId: "document-project",
        })) as {
          total: number;
          hits: Array<{
            artifactId: string;
            revision: number;
            matchedIn: string;
            quote: string;
          }>;
        };
        assert.equal(titles.total, 1);
        assert.equal(titles.hits[0]?.artifactId, original.contentId);
        assert.equal(titles.hits[0]?.revision, 2);
        assert.equal(titles.hits[0]?.matchedIn, "title");
        assert.equal(titles.hits[0]?.quote, "");
        assert.equal(
          (
            (await call("search", {
              query: "第二版正文",
            })) as { total: number }
          ).total,
          0,
        );
      } finally {
        legacySnapshot.restore();
      }
      const object = (await call("objects.read", {
        contentId: original.contentId,
        revision: 1,
      })) as {
        contentId: string;
        revision: number;
        content: { kind: string; markdown: string };
      };
      assert.equal(object.contentId, original.contentId);
      assert.equal(object.revision, 1);
      assert.deepEqual(object.content, {
        kind: "document",
        markdown: "第一版正文",
      });
      const previous = (await call("documents.read", {
        contentId: original.contentId,
        revision: 1,
      })) as { title: string; markdown: string; revision: number };
      assert.equal(previous.title, "初稿");
      assert.equal(previous.markdown, "第一版正文");
      assert.equal(previous.revision, 1);
      const annotationCommand = {
        commandId: randomUUID(),
        contentId: original.contentId,
        revision: 1,
        quote: "第一版正文",
        body: "保留旧稿的这句话",
      };
      const annotation = (await call(
        "objects.annotate",
        annotationCommand,
      )) as {
        id: string;
        artifactRevision: number;
      };
      assert.equal(annotation.id, annotationCommand.commandId);
      assert.equal(annotation.artifactRevision, 1);
      assert.deepEqual(
        await call("objects.annotate", annotationCommand),
        annotation,
      );
      const notes = (await call("objects.annotations", {
        contentId: original.contentId,
        limit: 1,
      })) as Array<{ ordinal: number; annotation: { id: string } }>;
      assert.deepEqual(
        notes.map((note) => note.annotation.id),
        [annotation.id],
      );
      assert.deepEqual(
        await call("objects.annotations", {
          contentId: original.contentId,
          afterOrdinal: notes[0]!.ordinal,
        }),
        [],
      );
      const history = (await call("objects.versions", {
        contentId: original.contentId,
        limit: 1,
      })) as { versions: Array<{ revision: number }>; nextCursor: number };
      assert.deepEqual(
        history.versions.map((item) => item.revision),
        [2],
      );
      assert.equal(history.nextCursor, 2);
      await assert.rejects(
        call("documents.revise", {
          commandId: randomUUID(),
          contentId: original.contentId,
          expectedRevision: 1,
          title: "过期覆盖",
          markdown: "错误正文",
        }),
        /冲突|已变化|版本/,
      );
      const renameCommand = {
        commandId: randomUUID(),
        contentId: original.contentId,
        expectedCatalogRevision: 2,
        title: "仅重命名",
      };
      const renamed = (await call("objects.rename", renameCommand)) as {
        original: { versionRef: string };
      };
      assert.equal(renamed.original.versionRef, "3");
      assert.deepEqual(await call("objects.rename", renameCommand), renamed);
      const renamedDocument = (await call("documents.read", {
        contentId: original.contentId,
      })) as { title: string; markdown: string };
      assert.equal(renamedDocument.title, "仅重命名");
      assert.equal(renamedDocument.markdown, "第二版正文");
      const catalog = (await call("content.get", {
        contentId: original.contentId,
      })) as {
        title: string;
        revision: number;
        observedVersionRef: string;
      };
      assert.equal(catalog.title, "仅重命名");
      assert.equal(catalog.revision, 3);
      assert.equal(catalog.observedVersionRef, "3");
      await assert.rejects(
        call("objects.rename", {
          ...renameCommand,
          commandId: randomUUID(),
          title: "过期改名",
        }),
        /目录已变化/,
      );
      assertNoLegacyParticipants(directory);
    } finally {
      connection.close();
    }
  } finally {
    await domains?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("正式 Host 从 Platform 目录打开剧本和精确条目版本，不写旧工作区", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-script-host-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    domains = await openApplicationDomainsHost(directory, workspace);
    await domains.content.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        domains!.content.platform.createProject(actor, {
          commandId: randomUUID(),
          projectId: "script-project",
          title: "剧本项目",
        }),
    );
    const connection = new LocalApplicationConnection(
      new Application(workspace, {
        platformWork: domains.work,
        platformScripts: domains.content,
      }),
    );
    try {
      const boot = (await connection.call("platform.bootstrap")) as {
        csrfToken: string;
      };
      const call = (
        method: Parameters<typeof connection.call>[0],
        input: unknown,
      ) =>
        connection.call(method, input, { identityGeneration: boot.csrfToken });
      const request = {
        commandId: randomUUID(),
        productionId: "script-original",
        projectId: "script-project",
        title: "第一部剧本",
      };
      const created = (await call("scripts.create", request)) as {
        contentId: string;
        versionRef: string;
      };
      assert.equal(created.versionRef, "1");
      assert.deepEqual(await call("scripts.create", request), created);
      const initialOverview = (await call("scripts.read", {
        contentId: created.contentId,
      })) as {
        title: string;
        progress: {
          episodes: number;
          scenes: number;
          pendingCandidates: number;
        };
      };
      assert.equal(initialOverview.title, "第一部剧本");
      assert.deepEqual(initialOverview.progress, {
        episodes: 0,
        scenes: 0,
        pendingCandidates: 0,
      });
      const { sources: _sources, ...draft } = emptyScriptDraft("第一集");
      const itemRequest = {
        commandId: randomUUID(),
        contentId: created.contentId,
        itemId: "episode-one",
        expectedActivityRevision: 1,
        kind: "episode",
        draft: { ...draft, sources: [] },
      };
      const itemCreated = (await call("scripts.item.create", itemRequest)) as {
        itemId: string;
        activityRevision: number;
      };
      assert.equal(itemCreated.itemId, "episode-one");
      assert.equal(itemCreated.activityRevision, 2);
      assert.deepEqual(
        (
          (await call("scripts.read", { contentId: created.contentId })) as {
            progress: {
              episodes: number;
              scenes: number;
              pendingCandidates: number;
            };
          }
        ).progress,
        { episodes: 1, scenes: 0, pendingCandidates: 0 },
      );
      assert.deepEqual(
        await call("scripts.item.create", itemRequest),
        itemCreated,
      );
      const page = (await call("scripts.items", {
        contentId: created.contentId,
        parentId: null,
      })) as { activityRevision: number; items: Array<{ itemId: string }> };
      assert.equal(page.activityRevision, 2);
      assert.deepEqual(
        page.items.map((item) => item.itemId),
        ["episode-one"],
      );
      const item = (await call("scripts.item", {
        contentId: created.contentId,
        itemId: "episode-one",
        revision: 1,
      })) as { draft: { title: string }; revision: number };
      assert.equal(item.revision, 1);
      assert.equal(item.draft.title, "第一集");
      const renameCommand = {
        commandId: randomUUID(),
        contentId: created.contentId,
        expectedCatalogRevision: 2,
        title: "剧本新标题",
      };
      const renamed = (await call("scripts.rename", renameCommand)) as {
        original: { versionRef: string };
      };
      assert.equal(renamed.original.versionRef, "3");
      assert.deepEqual(await call("scripts.rename", renameCommand), renamed);
      assert.equal(
        (
          (await call("scripts.read", { contentId: created.contentId })) as {
            title: string;
          }
        ).title,
        "剧本新标题",
      );
      assert.equal(
        (
          (await call("scripts.item", {
            contentId: created.contentId,
            itemId: "episode-one",
            revision: 1,
          })) as { draft: { title: string } }
        ).draft.title,
        "第一集",
      );
      assert.equal(
        (
          (await call("content.get", { contentId: created.contentId })) as {
            title: string;
          }
        ).title,
        "剧本新标题",
      );
      assertNoLegacyParticipants(directory);
      await assert.rejects(
        call("scripts.read", { contentId: "unknown-script" }),
        /不存在|无权|未找到/,
      );
    } finally {
      connection.close();
    }
  } finally {
    await domains?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("普通聊天的 Agent 凭 Runtime 原始输入和 Platform 成员资格访问新项目，不回查旧 workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-chat-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    domains = await openApplicationDomainsHost(directory, workspace);
    const { authority, platform, objects, instanceIds } = domains.content;
    await authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        platform.createProject(actor, {
          commandId: "chat-project-command",
          projectId: "platform-only-project",
          title: "仅存于 Platform 的项目",
        }),
    );
    assertNoLegacyParticipants(directory);

    const route: HostInvocation = {
      job_id: "chat-job",
      tool_call_id: "chat-tool",
      session_id: "chat-session",
      context_id: "chat-context",
      principal_id: "runtime-local-human",
      agent_id: "runtime-agent",
      thread_id: "chat-thread",
      target_id: "local-target",
    };
    let claimedProjectId = "platform-only-project";
    let claimedHumanActantId = localAccess.actantId;
    let platformAgentScope:
      ((route: HostInvocation) => Promise<unknown>) | undefined;
    const runtime = {
      teamIdentity: false,
      bindPlatformInputAuthority: () => {},
      bindPlatformReadAuthority: () => {},
      bindMessageAttachments: () => {},
      bindPlatformAgentScope: (resolve: typeof platformAgentScope) => {
        platformAgentScope = resolve;
      },
      preparePlatformTaskSession: async () => "chat-task-session",
      taskRunStatusReader: () => undefined,
      toolScope: async () => ({
        platform: true,
        projectId: "platform-only-project",
        inputId: "chat-input",
        access: { principalId: "morphz-service", actantId: "morphz-agent" },
      }),
      platformToolInput: async () => ({
        text: "来自 Runtime 的原始请求",
        input_id: "chat-input",
      }),
      inputEvidenceReader: () => ({
        readThread: async () => ({
          snapshot: {
            thread: {
              id: route.thread_id,
              session_id: route.session_id,
              context_id: route.context_id,
              root_turn_id: "chat-event",
              initiating_principal_id: route.principal_id,
              agent_id: route.agent_id,
              executor_kind: "self",
              executor_id: null,
            },
          },
        }),
        readSessionEvent: async () => ({
          id: "chat-event",
          actor: "Session-Client",
          type: "session_message",
          topic: "chat/user_message",
          payload: {
            session_id: route.session_id,
            context_id: route.context_id,
            principal_id: route.principal_id,
            client_message_id: "chat-input",
            session_io: {
              request: {
                io_version: "1",
                client_message_id: "chat-input",
                message: {
                  format: { id: "morphz.application.input", version: "1" },
                  content: {
                    encoding: "json",
                    value: {
                      type: "object",
                      value: {
                        input_id: { type: "string", value: "chat-input" },
                        workspace_id: {
                          type: "string",
                          value: claimedProjectId,
                        },
                        author_actant_id: {
                          type: "string",
                          value: claimedHumanActantId,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      }),
    } as unknown as RuntimeBridge;
    const bound = domains.bindRuntime(runtime);
    try {
      assert.deepEqual(await platformAgentScope!(route), {
        projectId: "platform-only-project",
        platform: true,
        platformSource: "input",
        inputId: "chat-input",
        access: { principalId: "morphz-service", actantId: "morphz-agent" },
      });
      const document = await bound.authority.withInvocation(
        route,
        async (actor, source) => {
          assert.deepEqual(source, {
            projectId: "platform-only-project",
            inputId: "chat-input",
          });
          return createDocument({
            platform,
            objects,
            actor,
            instanceId: instanceIds.objects,
            commandId: "chat-document-command",
            objectId: "chat-document",
            projectId: source.projectId,
            title: "对话创建的文档",
            markdown: "# 真正保存",
          });
        },
      );
      assert.equal(document.original.versionRef, "1");
      assertNoLegacyParticipants(directory);
      const tools = runtimeAgentTools(
        runtime,
        "host-token",
        {
          authority: bound.authority,
          work: domains.work.service,
          content: domains.content,
          reader: domains.reader.service,
        },
        {
          bookmarkDomain: {
            authority: bound.authority,
            service: bound.service,
          },
        },
      );
      const authoredRoute = { ...route, tool_call_id: "platform-document" };
      const operations = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-discover" },
        arguments: {
          action: "operations",
          operations: { action: "list", offset: 0, limit: 50, query: "" },
        },
      })) as { operations: { id: string }[] };
      assert.ok(
        operations.operations.some(
          (operation) => operation.id === "content.create-document",
        ),
      );
      assert.ok(
        operations.operations.some(
          (operation) => operation.id === "content.organize",
        ),
      );
      const organizeOperation = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-organize-describe" },
        arguments: {
          action: "operations",
          operations: { action: "describe", operationId: "content.organize" },
        },
      })) as {
        operation: { parameters: { properties: Record<string, unknown> } };
      };
      assert.ok(
        Object.hasOwn(
          organizeOperation.operation.parameters.properties,
          "metadata",
        ),
      );
      const readerOperations = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-reader-discover" },
        arguments: {
          action: "operations",
          operations: { action: "list", domain: "reader" },
        },
      })) as { operations: { id: string }[] };
      assert.ok(
        readerOperations.operations.some(
          (operation) => operation.id === "reader.catalog",
        ),
      );
      assert.ok(
        readerOperations.operations.every(
          (operation) => operation.id !== "reader.ocr",
        ),
        "本 Host 未提供 OCR 引擎时不展示 OCR 操作",
      );
      assert.ok(
        operations.operations.some(
          (operation) => operation.id === "work-tasks.create",
        ),
      );
      assert.ok(
        operations.operations.every(
          (operation) => operation.id !== "work-tasks.run-status",
        ),
        "Runtime status is not advertised without a live status reader",
      );
      assert.ok(
        operations.operations.every(
          (operation) => !operation.id.startsWith("tasks."),
        ),
        "legacy task commands must not be advertised",
      );
      await assert.rejects(
        async () =>
          await tools.call({
            protocol: 1,
            tool: "host_morphz",
            invocation: { ...route, tool_call_id: "platform-unsupported" },
            arguments: {
              action: "operations",
              operations: {
                action: "invoke",
                operationId: "tasks.create",
                parameters: {},
              },
            },
          }),
        /本次执行不可使用此操作/,
      );
      const readOperation = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-read-schema" },
        arguments: {
          action: "operations",
          operations: { action: "describe", operationId: "content.read" },
        },
      })) as {
        operation: { parameters: { properties: Record<string, unknown> } };
      };
      assert.deepEqual(
        readOperation.operation.parameters.properties.page,
        { type: "integer", minimum: 1, maximum: 300 },
        "stored PDF page reads expose the bounded integer page contract",
      );
      assert.equal(
        Object.hasOwn(readOperation.operation.parameters.properties, "offset"),
        true,
      );
      const authored = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: authoredRoute,
        arguments: {
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "content.create-document",
            parameters: {
              title: "Agent 的新文档",
              markdown: "# 新存储里的正文",
            },
          },
        },
      })) as { contentId: string; versionRef: string };
      assert.equal(authored.versionRef, "1");
      assertNoLegacyParticipants(directory);
      const titleSearch = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-title-search" },
        arguments: {
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "content.search",
            parameters: { query: "Agent 的新文档" },
          },
        },
      })) as {
        hits: Array<{ artifactId: string; quote: string }>;
        total: number;
        note: string;
      };
      assert.equal(titleSearch.total, 1);
      assert.equal(titleSearch.hits[0]?.artifactId, authored.contentId);
      assert.equal(titleSearch.hits[0]?.quote, "# 新存储里的正文");
      assert.match(titleSearch.note, /原件索引/);
      const bodySearch = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-body-search" },
        arguments: {
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "content.search",
            parameters: { query: "新存储里的正文" },
          },
        },
      })) as {
        hits: Array<{ artifactId: string; quote: string }>;
        total: number;
      };
      assert.equal(bodySearch.total, 1);
      assert.equal(bodySearch.hits[0]?.artifactId, authored.contentId);
      assert.equal(bodySearch.hits[0]?.quote, "# 新存储里的正文");
      const readerCatalog = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-reader-catalog" },
        arguments: {
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "reader.catalog",
            parameters: {},
          },
        },
      })) as { books: { artifactId: string }[] };
      assert.ok(
        readerCatalog.books.some(
          (book) => book.artifactId === authored.contentId,
        ),
      );
      const humanSearch = await authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          searchContent(
            {
              platform,
              objects,
              work: domains!.work.service,
              objectsInstanceId: instanceIds.objects,
              provider: domains!.content.provider,
            },
            actor,
            { query: "新存储里的正文", projectId: "platform-only-project" },
          ),
      );
      assert.equal(humanSearch.total, 1);
      assert.equal(humanSearch.hits[0]?.artifactId, authored.contentId);
      assert.equal(humanSearch.hits[0]?.quote, "# 新存储里的正文");
      await authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          createDocument({
            platform,
            objects,
            actor,
            instanceId: instanceIds.objects,
            commandId: "chat-human-document-command",
            objectId: "chat-human-document",
            projectId: "platform-only-project",
            title: "人工文档",
            markdown: "新存储里的正文只在人工原件中",
          }),
      );
      const humanOriginSearch = await authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          searchContent(
            {
              platform,
              objects,
              work: domains!.work.service,
              objectsInstanceId: instanceIds.objects,
              provider: domains!.content.provider,
            },
            actor,
            { query: "只在人工原件中", projectId: "platform-only-project" },
          ),
      );
      assert.equal(humanOriginSearch.total, 0);
      const tableInput = {
        ...emptyInteractive,
        rows: [{ id: "first", cells: { name: "待办", value: 2 } }],
      };
      const createdTable = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-table-create" },
        arguments: {
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "table.create",
            parameters: { title: "Agent 表格", interactive: tableInput },
          },
        },
      })) as { contentId: string; versionRef: string };
      assert.equal(createdTable.versionRef, "1");
      const revisedTable = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-table-revise" },
        arguments: {
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "table.revise",
            parameters: {
              artifactId: createdTable.contentId,
              revision: 1,
              title: "Agent 表格第二版",
              interactive: { ...tableInput, description: "已调整" },
            },
          },
        },
      })) as { contentId: string; versionRef: string };
      assert.equal(revisedTable.contentId, createdTable.contentId);
      assert.equal(revisedTable.versionRef, "2");
      const readTable = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-table-read" },
        arguments: {
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "content.read",
            parameters: { artifactId: createdTable.contentId, rowOffset: 0 },
          },
        },
      })) as {
        kind: string;
        interactive: { description: string; rows: unknown[] };
      };
      assert.equal(readTable.kind, "interactive");
      assert.equal(readTable.interactive.description, "已调整");
      assert.equal(readTable.interactive.rows.length, 1);
      assertNoLegacyParticipants(directory);
      assert.ok(
        operations.operations.some(
          (operation) => operation.id === "content.annotate",
        ),
      );
      const annotationRoute = { ...route, tool_call_id: "platform-annotation" };
      const annotate = () =>
        tools.call({
          protocol: 1,
          tool: "host_morphz",
          invocation: annotationRoute,
          arguments: {
            action: "operations",
            operations: {
              action: "invoke",
              operationId: "content.annotate",
              parameters: {
                artifactId: authored.contentId,
                revision: 1,
                quote: "新存储里的正文",
                body: "Agent 对确切版本的批注",
              },
            },
          },
        });
      const agentNote = (await annotate()) as { annotation: { id: string } };
      assert.deepEqual(await annotate(), agentNote);
      const agentNotes = await bound.authority.withInvocation(
        route,
        async (actor) =>
          objects.listObjectAnnotations({
            credential: actor.credential,
            objectId: (await platform.content(actor, authored.contentId))
              .app_object_id,
          }),
      );
      assert.deepEqual(
        agentNotes.map((note) => note.annotation.id),
        [agentNote.annotation.id],
      );
      const newTask = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-task-create" },
        arguments: {
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "work-tasks.create",
            parameters: {
              title: "由 Agent 创建的事项",
              description: "交付真实文档",
              assignee: "agent",
            },
          },
        },
      })) as { task: { taskId: string; revision: number; assigneeId: string } };
      assert.equal(newTask.task.revision, 1);
      assert.equal(newTask.task.assigneeId, "morphz-agent");
      assert.deepEqual(
        await tools.call({
          protocol: 1,
          tool: "host_morphz",
          invocation: { ...route, tool_call_id: "platform-task-create" },
          arguments: {
            action: "operations",
            operations: {
              action: "invoke",
              operationId: "work-tasks.create",
              parameters: {
                title: "由 Agent 创建的事项",
                description: "交付真实文档",
                assignee: "agent",
              },
            },
          },
        }),
        newTask,
      );
      const humanTask = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-human-task" },
        arguments: {
          action: "work-task",
          workTask: {
            action: "create",
            title: "交给我的事项",
            description: "由本人处理",
            assignee: "me",
            dependsOnIds: [newTask.task.taskId],
            watchSourceIds: [newTask.task.taskId],
          },
        },
      })) as {
        task: {
          taskId: string;
          assigneeId: string;
          dependsOnIds: string[];
          watchSourceIds: string[];
        };
      };
      assert.equal(humanTask.task.assigneeId, localAccess.actantId);
      assert.deepEqual(humanTask.task.dependsOnIds, [newTask.task.taskId]);
      assert.deepEqual(humanTask.task.watchSourceIds, [newTask.task.taskId]);
      const revisedHumanTask = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-human-task-result" },
        arguments: {
          action: "work-task",
          workTask: {
            action: "revise",
            taskId: humanTask.task.taskId,
            revision: 1,
            resultIds: [newTask.task.taskId],
          },
        },
      })) as { task: { resultIds: string[]; dependsOnIds: string[] } };
      assert.deepEqual(revisedHumanTask.task.resultIds, [newTask.task.taskId]);
      assert.deepEqual(revisedHumanTask.task.dependsOnIds, [
        newTask.task.taskId,
      ]);
      assertNoLegacyParticipants(directory);
      const taskPage = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-task-list" },
        arguments: {
          action: "work-task",
          workTask: { action: "list", owner: "agent" },
        },
      })) as { items: { id: string }[] };
      assert.deepEqual(
        taskPage.items.map((item) => item.id),
        [newTask.task.taskId],
      );
      const humanTaskPage = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-human-task-list" },
        arguments: {
          action: "work-task",
          workTask: { action: "list", owner: "human" },
        },
      })) as { items: { id: string }[] };
      assert.deepEqual(
        humanTaskPage.items.map((item) => item.id),
        [humanTask.task.taskId],
      );
      const requestedRun = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-task-start" },
        arguments: {
          action: "work-task",
          workTask: {
            action: "start",
            taskId: newTask.task.taskId,
            revision: 1,
          },
        },
      })) as { eventId: string; runNumber: number; state: string };
      assert.equal(requestedRun.runNumber, 1);
      assert.equal(requestedRun.state, "queued");
      assert.deepEqual(
        await tools.call({
          protocol: 1,
          tool: "host_morphz",
          invocation: { ...route, tool_call_id: "platform-task-start" },
          arguments: {
            action: "work-task",
            workTask: {
              action: "start",
              taskId: newTask.task.taskId,
              revision: 1,
            },
          },
        }),
        requestedRun,
      );
      await assert.rejects(
        async () =>
          await tools.call({
            protocol: 1,
            tool: "host_morphz",
            invocation: { ...route, tool_call_id: "platform-stale-task-start" },
            arguments: {
              action: "work-task",
              workTask: {
                action: "start",
                taskId: newTask.task.taskId,
                revision: 1,
              },
            },
          }),
        /事项已变化/,
      );
      assert.equal(
        (await platform.pendingTaskRuns(workspace.identity(), 10)).some(
          (event) => event.eventId === requestedRun.eventId,
        ),
        true,
      );
      const admitted = (
        await platform.pendingTaskRuns(workspace.identity(), 10)
      ).find((event) => event.eventId === requestedRun.eventId)!;
      await platform.confirmTaskRun(workspace.identity(), admitted.eventId, {
        schedule: {
          id: admitted.request.id,
          thread_id: "platform-chat-task-thread",
          revision: 1,
          status: "queued",
          not_before: admitted.request.not_before,
          interval_seconds: null,
        },
        thread: {
          thread_id: "platform-chat-task-thread",
          session_id: admitted.sessionId,
          root_turn_id: `client-schedule-${admitted.request.id}`,
          lifecycle: "open",
        },
      });
      const stopRequest = {
        protocol: 1 as const,
        tool: "host_morphz" as const,
        invocation: { ...route, tool_call_id: "platform-task-stop" },
        arguments: {
          action: "work-task" as const,
          workTask: {
            action: "stop" as const,
            taskId: newTask.task.taskId,
            runNumber: 1,
            controlRevision: 1,
          },
        },
      };
      assert.equal(
        ((await tools.call(stopRequest)) as { state: string }).state,
        "stopping",
      );
      assert.equal(
        (await platform.pendingTaskRunStops(workspace.identity())).length,
        1,
      );
      assert.equal(
        ((await tools.call(stopRequest)) as { state: string }).state,
        "stopping",
      );
      assert.equal(
        (await platform.pendingTaskRunStops(workspace.identity())).length,
        1,
      );
      const exact = await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-read" },
        arguments: {
          action: "read",
          artifactId: authored.contentId,
          revision: 1,
        },
      });
      assert.match(JSON.stringify(exact), /新存储里的正文/);
      assert.deepEqual(
        await tools.call({
          protocol: 1,
          tool: "host_morphz",
          invocation: { ...route, tool_call_id: "platform-read-part" },
          arguments: {
            action: "read",
            artifactId: authored.contentId,
            offset: 2,
            limit: 3,
          },
        }),
        {
          ok: true,
          contentId: authored.contentId,
          objectId: (exact as { objectId: string }).objectId,
          revision: 1,
          headRevision: 1,
          title: "Agent 的新文档",
          totalCharacters: 9,
          offset: 2,
          text: "新存储",
          hasMore: true,
        },
      );
      assert.deepEqual(
        await tools.call({
          protocol: 1,
          tool: "host_morphz",
          invocation: authoredRoute,
          arguments: {
            action: "create-document",
            title: "Agent 的新文档",
            markdown: "# 新存储里的正文",
          },
        }),
        authored,
        "a lost tool receipt reuses the same app original and catalog entry",
      );
      const bookmarked = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: route,
        arguments: {
          action: "bookmarks",
          bookmarks: {
            action: "add",
            title: "Platform 项目中的收藏",
            url: "https://example.com/platform",
          },
        },
      })) as { bookmark: { ownerPrincipalId: string } };
      assert.equal(
        bookmarked.bookmark.ownerPrincipalId,
        localAccess.principalId,
      );
      assertNoLegacyParticipants(directory);

      const organized = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-organize-source" },
        arguments: {
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "content.create-document",
            parameters: { title: "待整理原件", markdown: "独立版本" },
          },
        },
      })) as { contentId: string };
      const organizeResult = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: { ...route, tool_call_id: "platform-organize-rename" },
        arguments: {
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "content.organize",
            parameters: {
              content: { kind: "artifact", id: organized.contentId },
              revision: 1,
              metadata: { title: "已整理原件" },
            },
          },
        },
      })) as { contentId: string; catalogRevision: number };
      assert.equal(organizeResult.contentId, organized.contentId);
      assert.equal(organizeResult.catalogRevision, 2);
      const updatedTitle = await bound.authority.withInvocation(
        route,
        (actor) => platform.content(actor, organized.contentId),
      );
      assert.equal(updatedTitle.title, "已整理原件");
      assertNoLegacyParticipants(directory);

      const scheduled = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: {
          ...route,
          tool_call_id: "platform-scheduled-task-create",
        },
        arguments: {
          action: "work-task",
          workTask: {
            action: "create",
            title: "创建时安排执行",
            description: "首版即包含模型和时间",
            assignee: "agent",
            modelId: "selected-model",
            reasoningEffort: "high",
            notBefore: "2026-10-02T12:00:00.000Z",
            everySeconds: 3600,
          },
        },
      })) as {
        task: {
          revision: number;
          modelId: string | null;
          reasoningEffort: string | null;
          notBefore: string | null;
          everySeconds: number | null;
        };
      };
      assert.deepEqual(
        [
          scheduled.task.revision,
          scheduled.task.modelId,
          scheduled.task.reasoningEffort,
          scheduled.task.notBefore,
          scheduled.task.everySeconds,
        ],
        [1, "selected-model", "high", "2026-10-02T12:00:00.000Z", 3600],
      );

      claimedProjectId = "not-a-member-project";
      await assert.rejects(
        bound.authority.withInvocation(route, async () => "unexpected"),
        /Human 身份已失效或与 Runtime 身份不符/,
      );
      claimedProjectId = "platform-only-project";
      claimedHumanActantId = "forged-human";
      await assert.rejects(
        bound.authority.withInvocation(route, async () => "unexpected"),
        /Human 身份已失效或与 Runtime 身份不符/,
      );
    } finally {
      await domains.unbindRuntime(bound.authority);
    }
  } finally {
    await domains?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("正式领域 Host 将 Platform 事项执行历史接给本机业务入口", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-task-run-entry-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    domains = await openApplicationDomainsHost(directory, workspace);
    assertNoLegacyParticipants(directory);
    const platform = domains.content.platform;
    const admission = await domains.content.authority.withSession(
      localAccess,
      () => {},
      async (actor) => {
        await platform.createProject(actor, {
          commandId: "project-command",
          projectId: "project-one",
          title: "事项项目",
        });
        await platform.createTask(actor, {
          commandId: "task-command",
          taskId: "task-one",
          projectId: "project-one",
          title: "需要执行",
          assigneeId: "morphz-agent",
        });
        return platform.requestTaskRun(actor, {
          commandId: "run-command",
          taskId: "task-one",
          expectedRevision: 1,
          sessionId: "session-one",
          intent: "执行事项",
          notBefore: "2026-09-26T12:00:00.000Z",
        });
      },
    );
    await platform.confirmTaskRun(workspace.identity(), admission.eventId, {
      schedule: {
        id: admission.request.id,
        thread_id: "thread-one",
        revision: 1,
        status: "queued",
        not_before: admission.request.not_before,
        interval_seconds: null,
      },
      thread: {
        thread_id: "thread-one",
        session_id: admission.sessionId,
        root_turn_id: `client-schedule-${admission.request.id}`,
        lifecycle: "open",
      },
    });
    const connection = new LocalApplicationConnection(
      new Application(workspace, {
        platformTaskRuns: domains.taskRuns(),
      }),
    );
    try {
      const boot = (await connection.call("platform.bootstrap")) as {
        csrfToken: string;
      };
      const result = (await connection.call(
        "task.run-history",
        { taskId: "task-one" },
        { identityGeneration: boot.csrfToken },
      )) as Array<{ runtime: { scheduleId: string; threadId: string } }>;
      assert.equal(result.length, 1);
      assert.equal(result[0]!.runtime.scheduleId, admission.request.id);
      assert.equal(result[0]!.runtime.threadId, "thread-one");
    } finally {
      connection.close();
    }
  } finally {
    await domains?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Host 用 Platform 事项准入验证后台 Agent，不从旧 workspace 猜项目或输入", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-task-agent-host-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    domains = await openApplicationDomainsHost(directory, workspace);
    const { authority, platform } = domains.content;
    const admission = await authority.withSession(
      localAccess,
      () => {},
      async (actor) => {
        await platform.createProject(actor, {
          commandId: "create-task-agent-project",
          projectId: "task-agent-project",
          title: "事项项目",
        });
        await platform.createTask(actor, {
          commandId: "create-task-agent-task",
          taskId: "task-agent-task",
          projectId: "task-agent-project",
          title: "需要执行",
          assigneeId: "morphz-agent",
        });
        return platform.requestTaskRun(actor, {
          commandId: "start-task-agent-task",
          taskId: "task-agent-task",
          expectedRevision: 1,
          sessionId: "task-agent-session",
          intent: "处理这件事项",
          notBefore: "2026-09-26T00:00:00.000Z",
        });
      },
    );
    assertNoLegacyParticipants(directory);
    const route: HostInvocation = {
      job_id: "job-one",
      tool_call_id: "tool-one",
      session_id: admission.sessionId,
      context_id: "task-agent-context",
      principal_id: "runtime-local-human",
      agent_id: "runtime-agent",
      thread_id: "task-agent-thread",
      target_id: "local-target",
    };
    const rootId = `client-schedule-${admission.request.id}`;
    let platformAgentScope:
      ((route: HostInvocation) => Promise<unknown>) | undefined;
    const runtime = {
      teamIdentity: false,
      bindPlatformInputAuthority: () => {},
      bindPlatformReadAuthority: () => {},
      bindMessageAttachments: () => {},
      bindPlatformAgentScope: (resolve: typeof platformAgentScope) => {
        platformAgentScope = resolve;
      },
      inputEvidenceReader: () => ({
        readThread: async () => ({
          snapshot: {
            thread: {
              id: route.thread_id,
              session_id: route.session_id,
              context_id: route.context_id,
              root_turn_id: rootId,
              initiating_principal_id: route.principal_id,
              agent_id: route.agent_id,
              executor_kind: "self",
              executor_id: null,
            },
          },
        }),
        readSessionEvent: async () => {
          throw new Error("后台执行不应读取普通聊天输入");
        },
        readSessionSchedule: async () => ({
          id: admission.request.id,
          thread_id: route.thread_id,
          source_turn_id: rootId,
        }),
      }),
    } as unknown as RuntimeBridge;
    const bound = domains.bindRuntime(runtime);
    assert.deepEqual(await platformAgentScope!(route), {
      projectId: "task-agent-project",
      platform: true,
      platformSource: "task-run",
      access: { principalId: "morphz-service", actantId: "morphz-agent" },
    });
    await bound.authority.withInvocation(route, async (actor, scope) => {
      assert.deepEqual(scope, {
        projectId: "task-agent-project",
        inputId: null,
      });
      assert.deepEqual(
        (await platform.listTasks(actor, scope.projectId)).map(
          (task) => task.task_id,
        ),
        ["task-agent-task"],
      );
      const document = await createDocument({
        platform,
        objects: domains!.content.objects,
        actor,
        instanceId: domains!.content.instanceIds.objects,
        commandId: "task-agent-document-command",
        objectId: "task-agent-document",
        projectId: scope.projectId,
        title: "后台事项文档",
        markdown: "# 已提交的内容",
      });
      const script = await createScriptProduction({
        platform,
        studio: domains!.content.studio,
        actor,
        instanceId: domains!.content.instanceIds.scriptStudio,
        commandId: "task-agent-script-command",
        productionId: "task-agent-script",
        projectId: scope.projectId,
        title: "后台事项剧本",
      });
      const { sources: _sources, ...draft } = emptyScriptDraft("第一集");
      await createScriptItem({
        platform,
        studio: domains!.content.studio,
        actor,
        instanceId: domains!.content.instanceIds.scriptStudio,
        commandId: "task-agent-item-command",
        productionId: "task-agent-script",
        itemId: "task-agent-episode",
        expectedActivityRevision: 1,
        kind: "episode",
        draft: { ...draft, sources: [] },
      });
      assert.equal(document.original.versionRef, "1");
      assert.equal(script.original.versionRef, "1");
      assert.equal(
        (
          await domains!.content.objects.readDocument({
            credential: actor.credential,
            objectId: "task-agent-document",
          })
        ).content.markdown,
        "# 已提交的内容",
      );
    });
    assertNoLegacyParticipants(directory);
    const catalog = await authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        platform.listContent(actor, { projectId: "task-agent-project" }),
    );
    assert.deepEqual(catalog.map((item) => item.kind).sort(), [
      "document",
      "script",
    ]);
    const publicCatalog = await domains.work.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        domains!.work.service.listContent(actor, {
          projectId: "task-agent-project",
        }),
    );
    assert.deepEqual(
      publicCatalog.map(({ id, projectId, kind, appObjectId }) => ({
        id,
        projectId,
        kind,
        appObjectId,
      })),
      catalog.map((item) => ({
        id: item.content_id,
        projectId: item.project_id,
        kind: item.kind,
        appObjectId: item.app_object_id,
      })),
    );
    assert.ok(
      publicCatalog.every((item) => !Object.hasOwn(item, "content_id")),
    );
    await assert.rejects(
      authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          platform.recordContent(
            actor,
            {
              instanceId: domains!.content.instanceIds.objects,
              proof: "task-agent-document-command",
            },
            {
              commandId: "wrong-source-document",
              appReceiptId: "task-agent-document-command",
              contentId: "wrong-source-content",
              objectId: "task-agent-document",
              projectId: "task-agent-project",
              kind: "document",
              title: "后台事项文档",
              observedVersionRef: "1",
            },
          ),
      ),
      /应用未确认/,
    );
    await domains.unbindRuntime(bound.authority);
  } finally {
    await domains?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("实际 Host 通过应用回执登记目录，应用原件与 Platform 独立持久化", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-content-host-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  const tenantId = workspace.identity();
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    domains = await openApplicationDomainsHost(directory, workspace);
    const { authority, platform, objects, studio, instanceIds } =
      domains.content;
    assert.deepEqual(
      instanceIds,
      embeddedApplicationInstanceIds(directory, tenantId),
    );
    const independent = mkdtempSync(join(tmpdir(), "morphz-other-app-host-"));
    try {
      assert.notDeepEqual(
        embeddedApplicationInstanceIds(independent, tenantId),
        instanceIds,
      );
    } finally {
      rmSync(independent, { recursive: true, force: true });
    }
    await authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        platform.createProject(actor, {
          commandId: randomUUID(),
          projectId: "project-one",
          title: "同一项目",
        }),
    );

    const { document, script } = await authority.withSession(
      localAccess,
      () => {},
      async (actor) => ({
        document: await createDocument({
          platform,
          objects,
          actor,
          instanceId: instanceIds.objects,
          commandId: "create-document",
          objectId: "document-one",
          projectId: "project-one",
          title: "第一份文档",
          markdown: "# 正文",
        }),
        script: await createScriptProduction({
          platform,
          studio,
          actor,
          instanceId: instanceIds.scriptStudio,
          commandId: "create-script",
          productionId: "script-one",
          projectId: "project-one",
          title: "第一部剧本",
        }),
      }),
    );
    assert.equal(document.original.versionRef, "1");
    assert.equal(script.original.versionRef, "1");
    const { sources: _oldSources, ...draft } = emptyScriptDraft("第一集");
    await authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        createScriptItem({
          platform,
          studio,
          actor,
          instanceId: instanceIds.scriptStudio,
          commandId: "create-script-item",
          productionId: "script-one",
          itemId: "episode-one",
          expectedActivityRevision: 1,
          kind: "episode",
          draft: { ...draft, sources: [] },
        }),
    );
    assertNoLegacyParticipants(directory);

    await assert.rejects(
      authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          platform.recordContent(
            actor,
            { instanceId: instanceIds.objects, proof: "create-document" },
            {
              commandId: "forged-catalog",
              appReceiptId: "create-document",
              contentId: "forged-content",
              objectId: "document-one",
              projectId: "project-one",
              kind: "document",
              title: "伪造标题",
              observedVersionRef: "1",
            },
          ),
      ),
      /应用未确认/,
    );
    assert.deepEqual(await objects.pendingDirectoryEvents(tenantId), []);
    assert.deepEqual(await studio.pendingDirectoryEvents(tenantId), []);
    await domains.close();
    domains = undefined;

    domains = await openApplicationDomainsHost(directory, workspace);
    const reopened = domains.content;
    assert.deepEqual(reopened.instanceIds, instanceIds);
    const catalog = await reopened.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        reopened.platform.listContent(actor, { projectId: "project-one" }),
    );
    assert.deepEqual(
      catalog
        .map((item) => [item.content_id, item.kind, item.instance_id])
        .sort(),
      [
        [document.contentId, "document", instanceIds.objects],
        [script.contentId, "script", instanceIds.scriptStudio],
      ].sort(),
    );
    assert.equal(
      catalog.find((item) => item.kind === "script")?.observed_version_ref,
      "2",
    );
    const restored = await reopened.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        reopened.objects.readDocument({
          credential: actor.credential,
          objectId: "document-one",
        }),
    );
    assert.equal(restored.content.markdown, "# 正文");
  } finally {
    await domains?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Host 重启只投影已提交应用回执，不重建文档或剧本原件", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-directory-recovery-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let host: Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    host = await openApplicationDomainsHost(directory, workspace);
    const { authority, platform, objects, studio } = host.content;
    await authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        platform.createProject(actor, {
          commandId: "project-for-recovery",
          projectId: "recovery-project",
          title: "恢复项目",
        }),
    );
    await authority.withSession(
      localAccess,
      () => {},
      async (actor) => {
        await objects.createDocument({
          credential: actor.credential,
          commandId: "committed-document",
          objectId: "recovery-document",
          requestedProjectId: "recovery-project",
          title: "恢复文档",
          markdown: "# 已提交的正文",
        });
        await studio.createProduction({
          credential: actor.credential,
          commandId: "committed-script",
          productionId: "recovery-script",
          requestedProjectId: "recovery-project",
          title: "恢复剧本",
        });
      },
    );
    assert.equal(
      (await objects.pendingDirectoryEvents(workspace.identity())).length,
      1,
    );
    assert.equal(
      (await studio.pendingDirectoryEvents(workspace.identity())).length,
      1,
    );
    assert.deepEqual(
      await authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          platform.listContent(actor, { projectId: "recovery-project" }),
      ),
      [],
    );
    await host.close();
    host = await openApplicationDomainsHost(directory, workspace);
    const recovered = host.content;
    const catalog = await recovered.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        recovered.platform.listContent(actor, {
          projectId: "recovery-project",
        }),
    );
    assert.deepEqual(
      catalog
        .map((row) => [row.app_object_id, row.observed_version_ref])
        .sort(),
      [
        ["recovery-document", "1"],
        ["recovery-script", "1"],
      ],
    );
    assert.deepEqual(
      await recovered.objects.pendingDirectoryEvents(workspace.identity()),
      [],
    );
    assert.deepEqual(
      await recovered.studio.pendingDirectoryEvents(workspace.identity()),
      [],
    );
    const original = await recovered.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        recovered.objects.readDocument({
          credential: actor.credential,
          objectId: "recovery-document",
        }),
    );
    assert.equal(original.content.markdown, "# 已提交的正文");
  } finally {
    await host?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("目录已提交但应用确认标记未写入时，Host 重启幂等补标记", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-directory-marker-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let host: Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    host = await openApplicationDomainsHost(directory, workspace);
    const { authority, platform, objects, instanceIds } = host.content;
    await authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        platform.createProject(actor, {
          commandId: "project-for-marker",
          projectId: "marker-project",
          title: "标记项目",
        }),
    );
    await authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        createDocument({
          platform,
          objects,
          actor,
          instanceId: instanceIds.objects,
          commandId: "document-for-marker",
          objectId: "marker-document",
          projectId: "marker-project",
          title: "标记文档",
          markdown: "一次提交",
        }),
    );
    await host.close();
    host = undefined;
    // Reproduce a crash after Platform committed, before the App marked its
    // outbox event delivered. This alters only the isolated test database.
    const database = new DatabaseSync(join(directory, "objects.sqlite"));
    try {
      database
        .prepare("UPDATE object_outbox SET delivered_at=NULL WHERE event_id=?")
        .run("document-for-marker");
    } finally {
      database.close();
    }
    host = await openApplicationDomainsHost(directory, workspace);
    const reopened = host.content;
    const catalog = await reopened.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        reopened.platform.listContent(actor, { projectId: "marker-project" }),
    );
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0]!.revision, 1);
    assert.deepEqual(
      await reopened.objects.pendingDirectoryEvents(workspace.identity()),
      [],
    );
  } finally {
    await host?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("应用私库丢失实例身份时拒绝以新实例重新登记", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-app-identity-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  try {
    const host = await openApplicationDomainsHost(directory, workspace);
    await host.close();
    unlinkSync(join(directory, "application-instances.json"));
    await assert.rejects(
      openApplicationDomainsHost(directory, workspace),
      /私库缺少实例身份/,
    );
  } finally {
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("应用实例身份尚在但私库缺失时不创建空库代替原件", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-app-missing-db-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  try {
    const host = await openApplicationDomainsHost(directory, workspace);
    await host.close();
    unlinkSync(join(directory, "script-studio.sqlite"));
    await assert.rejects(
      openApplicationDomainsHost(directory, workspace),
      /身份对应的私库缺失/,
    );
  } finally {
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const name of ["reader.sqlite", "browser.sqlite"] as const) {
  test(`${name} 缺失或被空库替换时不恢复为原实例`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "morphz-app-missing-domain-"));
    const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
    try {
      const host = await openApplicationDomainsHost(directory, workspace);
      await host.close();
      const path = join(directory, name);
      unlinkSync(path);
      await assert.rejects(
        openApplicationDomainsHost(directory, workspace),
        /身份对应的私库缺失/,
      );
      assert.equal(existsSync(path), false);
      writeFileSync(path, "", { mode: 0o600 });
      await assert.rejects(
        openApplicationDomainsHost(directory, workspace),
        /私库缺少原应用结构/,
      );
    } finally {
      workspace.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("实例身份对应的私库不能由符号链接替代", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-app-linked-domain-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  try {
    const host = await openApplicationDomainsHost(directory, workspace);
    await host.close();
    const path = join(directory, "browser.sqlite");
    unlinkSync(path);
    symlinkSync(join(directory, "reader.sqlite"), path);
    await assert.rejects(
      openApplicationDomainsHost(directory, workspace),
      /私库不是受管的私有真实文件/,
    );
  } finally {
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("完整但属于另一实例的应用私库不能替换原件或进入备份", async () => {
  const first = mkdtempSync(join(tmpdir(), "morphz-app-original-"));
  const second = mkdtempSync(join(tmpdir(), "morphz-app-other-"));
  const firstWorkspace = new WorkspaceStore(join(first, "workspace.sqlite"));
  const secondWorkspace = new WorkspaceStore(join(second, "workspace.sqlite"));
  try {
    const firstHost = await openApplicationDomainsHost(first, firstWorkspace);
    await firstHost.close();
    const secondHost = await openApplicationDomainsHost(
      second,
      secondWorkspace,
    );
    await secondHost.close();
    copyFileSync(join(second, "browser.sqlite"), join(first, "browser.sqlite"));
    await assert.rejects(
      openApplicationDomainsHost(first, firstWorkspace),
      /私库不属于当前实例/,
    );
    await assert.rejects(
      backupCenterStorage({
        sourceDirectory: first,
        backupDirectory: join(first, "backups"),
        writersStopped: true,
      }),
      /私库不属于当前实例/,
    );
  } finally {
    firstWorkspace.close();
    secondWorkspace.close();
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("结构完整但没有实例绑定的替换库不能冒充已有应用原件", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-app-unbound-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  try {
    const host = await openApplicationDomainsHost(directory, workspace);
    await host.close();
    const database = new DatabaseSync(join(directory, "browser.sqlite"));
    try {
      database.exec("DROP TABLE morphz_app_binding");
    } finally {
      database.close();
    }
    await assert.rejects(
      openApplicationDomainsHost(directory, workspace),
      /私库缺少实例绑定/,
    );
  } finally {
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("首次启动中断后可完成同一实例，旧身份文件可封存而不丢原件", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-app-seal-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let host: Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    const instanceIds = embeddedApplicationInstanceIds(
      directory,
      workspace.identity(),
    );
    assert.equal(
      JSON.parse(
        readFileSync(join(directory, "application-instances.json"), "utf8"),
      ).phase,
      "initializing",
    );
    host = await openApplicationDomainsHost(directory, workspace);
    assert.deepEqual(host.content.instanceIds, instanceIds);
    await host.content.authority.withSession(
      localAccess,
      () => {},
      async (actor) => {
        await host!.content.platform.createProject(actor, {
          commandId: "sealed-project-command",
          projectId: "sealed-project",
          title: "保留原件",
        });
        await createDocument({
          platform: host!.content.platform,
          objects: host!.content.objects,
          actor,
          instanceId: instanceIds.objects,
          commandId: "sealed-document-command",
          objectId: "sealed-document",
          projectId: "sealed-project",
          title: "原件",
          markdown: "封存前的正文",
        });
      },
    );
    await host.close();
    host = undefined;
    const identityPath = join(directory, "application-instances.json");
    writeFileSync(
      identityPath,
      JSON.stringify({
        version: 1,
        tenantId: workspace.identity(),
        objects: instanceIds.objects,
        scriptStudio: instanceIds.scriptStudio,
      }),
      { mode: 0o600 },
    );
    for (const name of [
      "objects.sqlite",
      "script-studio.sqlite",
      "reader.sqlite",
      "browser.sqlite",
    ]) {
      const database = new DatabaseSync(join(directory, name));
      try {
        database.exec("DROP TABLE morphz_app_binding");
      } finally {
        database.close();
      }
    }
    host = await openApplicationDomainsHost(directory, workspace);
    assert.deepEqual(host.content.instanceIds, instanceIds);
    assert.deepEqual(
      readEmbeddedApplicationInstanceIds(directory, workspace.identity()),
      instanceIds,
    );
    assert.equal(
      JSON.parse(readFileSync(identityPath, "utf8")).phase,
      "active",
    );
    const document = await host.content.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        host!.content.objects.readDocument({
          credential: actor.credential,
          objectId: "sealed-document",
        }),
    );
    assert.equal(document.content.markdown, "封存前的正文");
  } finally {
    await host?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("封存中断后保留已写入的私库绑定并完成其余私库", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-app-partial-seal-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  try {
    const host = await openApplicationDomainsHost(directory, workspace);
    const instanceIds = host.content.instanceIds;
    await host.close();
    const identityPath = join(directory, "application-instances.json");
    const binding = JSON.parse(readFileSync(identityPath, "utf8"));
    writeFileSync(
      identityPath,
      JSON.stringify({ ...binding, phase: "initializing" }),
      { mode: 0o600 },
    );
    for (const name of ["reader.sqlite", "browser.sqlite"]) {
      const database = new DatabaseSync(join(directory, name));
      try {
        database.exec("DROP TABLE morphz_app_binding");
      } finally {
        database.close();
      }
    }
    const reopened = await openApplicationDomainsHost(directory, workspace);
    try {
      assert.deepEqual(reopened.content.instanceIds, instanceIds);
      assert.deepEqual(
        readEmbeddedApplicationInstanceIds(directory, workspace.identity()),
        instanceIds,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("正式图片链路上传字节、登记原件、精确修订与授权读取", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-image-host-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let host: Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    host = await openApplicationDomainsHost(directory, workspace);
    await host.content.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        host!.content.platform.createProject(actor, {
          commandId: randomUUID(),
          projectId: "image-project",
          title: "图片项目",
        }),
    );
    const application = new Application(workspace, {
      platformWork: host.work,
      platformDocuments: host.content,
      images: host.images,
    });
    const connection = new LocalApplicationConnection(application);
    try {
      const boot = (await connection.call("platform.bootstrap")) as {
        csrfToken: string;
      };
      const call = (
        method: Parameters<typeof connection.call>[0],
        value: unknown,
      ) =>
        connection.call(method, value, { identityGeneration: boot.csrfToken });
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==",
        "base64",
      );
      const uploaded = (await call("asset.add", png)) as {
        assetId: string;
        mime: string;
      };
      assert.equal(uploaded.mime, "image/png");
      assert.equal(
        uploaded.assetId,
        createHash("sha256").update(png).digest("hex"),
      );
      await assert.rejects(
        application.session(localAccess).asset(uploaded.assetId),
        /图片不存在或无权访问/,
      );
      const command = {
        commandId: randomUUID(),
        objectId: "image-original",
        projectId: "image-project",
        title: "图片",
        assetId: uploaded.assetId,
        alt: "初始描述",
      };
      const created = (await call("images.create", command)) as {
        contentId: string;
        versionRef: string;
      };
      assert.equal(created.versionRef, "1");
      assert.deepEqual(await call("images.create", command), created);
      assert.deepEqual(
        Buffer.from(
          (await application.session(localAccess).asset(uploaded.assetId))
            .bytes,
        ),
        png,
      );
      const original = (await call("objects.read", {
        contentId: created.contentId,
      })) as {
        content: { kind: string; alt: string };
        revision: number;
      };
      assert.equal(original.content.kind, "image");
      assert.equal(original.content.alt, "初始描述");
      assert.equal(original.revision, 1);
      const revision = (await call("images.revise", {
        commandId: randomUUID(),
        contentId: created.contentId,
        expectedRevision: 1,
        title: "图片修订",
        assetId: uploaded.assetId,
        alt: "新的说明",
      })) as { versionRef: string };
      assert.equal(revision.versionRef, "2");
      const imageHistory = (await call("objects.versions", {
        contentId: created.contentId,
        limit: 1,
        beforeRevision: 2,
      })) as {
        versions: Array<{ revision: number; title: string; content?: unknown }>;
      };
      assert.deepEqual(
        imageHistory.versions.map(({ revision, title }) => ({
          revision,
          title,
        })),
        [{ revision: 1, title: "图片" }],
      );
      assert.equal("content" in imageHistory.versions[0]!, false);
      const revised = (await call("objects.read", {
        contentId: created.contentId,
      })) as {
        content: { alt: string };
      };
      assert.equal(revised.content.alt, "新的说明");
      const replacement = Buffer.concat([png, Buffer.from([0])]);
      const secondUpload = (await call("asset.add", replacement)) as {
        assetId: string;
      };
      const replaced = (await call("images.revise", {
        commandId: randomUUID(),
        contentId: created.contentId,
        expectedRevision: 2,
        title: "换图",
        assetId: secondUpload.assetId,
        alt: "替换后的图片",
      })) as { versionRef: string };
      assert.equal(replaced.versionRef, "3");
      assert.deepEqual(
        Buffer.from(
          (await application.session(localAccess).asset(secondUpload.assetId))
            .bytes,
        ),
        replacement,
      );
      assert.deepEqual(
        Buffer.from(
          (await application.session(localAccess).asset(uploaded.assetId))
            .bytes,
        ),
        png,
      );
      await assert.rejects(
        call("images.create", {
          ...command,
          commandId: randomUUID(),
          objectId: "forged-image",
          assetId: "0".repeat(64),
        }),
        /请先上传这张图片/,
      );
      assert.deepEqual(
        await call("content.list", { projectId: "image-project" }),
        [await call("content.get", { contentId: created.contentId })],
      );
      await host.content.authority.withSession(
        localAccess,
        () => {},
        async (actor) =>
          host!.content.objects.createImage({
            credential: actor.credential,
            commandId: "image-after-app-commit",
            objectId: "image-recovery-original",
            requestedProjectId: "image-project",
            title: "待恢复图片",
            assetId: uploaded.assetId,
            alt: "原件已提交，目录尚未写入",
            reference: await host!.images.service.uploadedReference(
              actor,
              uploaded.assetId,
            ),
          }),
      );
    } finally {
      connection.close();
    }
    await host.close();
    host = await openApplicationDomainsHost(directory, workspace);
    const recovered = await host.content.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        host!.content.platform.listContent(actor, {
          projectId: "image-project",
        }),
    );
    assert.equal(recovered.length, 2);
    await host.close();
    host = undefined;
    rmSync(join(directory, "objects-images"), { recursive: true, force: true });
    await assert.rejects(
      openApplicationDomainsHost(directory, workspace),
      /图片原件 Store 缺失/,
    );
  } finally {
    await host?.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
