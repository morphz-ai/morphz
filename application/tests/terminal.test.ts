import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  terminalApplication,
  parseApplicationViewState,
} from "../packages/core/src/applications.js";
import {
  applicationFor,
  initialWorkspace,
  localAccess,
  type Workspace,
} from "../packages/core/src/model.js";
import { applicationMethods } from "../packages/core/src/application-api.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import {
  workInputRequest,
  terminalInputFormat,
  terminalSessionInputFormat,
} from "../packages/application/src/session-io.js";
import {
  terminalRecordSchema,
  terminalScreenSchema,
} from "../packages/core/src/terminal.js";
import {
  Terminal,
  TerminalCanvas,
} from "../apps/web/src/features/terminal/Terminal.js";
import type { WorkspaceClient } from "../apps/web/src/client.js";
import { createTerminalInteractions } from "../apps/web/src/data/terminal-interactions.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import { readPlatformWorkspace } from "../apps/web/src/platform-workspace-view.js";
import type { PlatformClient } from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import { terminalColor } from "../apps/web/src/features/terminal/terminal-appearance.js";
import { composerTerminalContext } from "../apps/web/src/features/terminal/terminal-context.js";

test("terminal palette preserves truecolor and the 256-color cube", () => {
  assert.equal(terminalColor("#c94343", 1), "var(--terminal-ansi-1)");
  assert.equal(terminalColor("#c94343"), "#c94343");
  assert.equal(terminalColor("#ff0000", 196), "#ff0000");
  assert.equal(terminalColor(), undefined);
  assert.equal(terminalColor("#123456", -1), "#123456");
});

const stamp = "2026-10-16T00:00:00Z";
const record = () =>
  terminalRecordSchema.parse({
    id: "terminal-exact",
    session_id: "session-exact",
    context_id: "context-exact",
    principal_id: "principal-exact",
    root_turn_id: "root-exact",
    source_job_id: "job-exact",
    target_id: "target-default",
    revision: 2,
    status: "open",
    title: "编译与检查",
    shell: "/bin/zsh",
    cwd: "/workspace",
    rows: 24,
    cols: 80,
    sandbox_status: "enforced",
    network_enabled: false,
    exit_code: null,
    created_at: stamp,
    updated_at: stamp,
  });
const screen = () =>
  terminalScreenSchema.parse({
    sequence: 8,
    rows: 24,
    cols: 80,
    lines: [
      [
        {
          text: "中文输出 <script>not executable</script>",
          fg: "#c94343",
          bold: true,
          italic: false,
          underline: false,
          inverse: false,
        },
      ],
    ],
    text: "中文输出 <script>not executable</script>",
    cursor: [1, 0],
    cursor_visible: true,
    alternate_screen: false,
    scrollback: 0,
    previous_available: false,
  });

test("Terminal is a builtin app with navigation-only persisted state", () => {
  assert.equal(
    applicationFor(
      initialWorkspace(stamp),
      terminalApplication.id,
      terminalApplication.version,
    ),
    terminalApplication,
  );
  assert.deepEqual(
    parseApplicationViewState(terminalApplication.id, {
      terminalId: "terminal-exact",
    }),
    { terminalId: "terminal-exact" },
  );
  for (const state of [
    { output: "text" },
    { command: "touch unrequested" },
    { pid: 123 },
    { terminalId: "terminal-exact", content: "do not store here" },
  ])
    assert.throws(() =>
      parseApplicationViewState(terminalApplication.id, state),
    );
  assert.ok(applicationMethods.includes("terminal.catalog"));
  assert.ok(applicationMethods.includes("terminal.read"));
  assert.ok(applicationMethods.includes("terminal.open"));
});

test("composer terminal label is exact to the selected instance and work scope, never stale screen context", () => {
  const instance = {
    id: "instance",
    applicationId: "morphz.terminal",
    state: { terminalId: "terminal-exact" },
  } as any;
  const observed = {
    instanceId: "instance",
    projectId: "project",
    conversationId: "conversation",
    terminalId: "terminal-exact",
    title: "检查与构建",
  };
  assert.deepEqual(
    composerTerminalContext(instance, "project", "conversation", observed),
    { label: "检查与构建", description: "关联终端：terminal-exact" },
  );
  for (const changed of [
    { ...observed, terminalId: "previous" },
    { ...observed, instanceId: "previous" },
    { ...observed, projectId: "previous" },
    { ...observed, conversationId: "previous" },
  ])
    assert.equal(
      composerTerminalContext(instance, "project", "conversation", changed)
        ?.label,
      "终端 · 当前会话",
    );
  assert.equal(
    composerTerminalContext(
      { ...instance, applicationId: "morphz.browser" },
      "project",
      "conversation",
      observed,
    ),
    null,
  );
  assert.equal(
    composerTerminalContext(
      { ...instance, state: {} },
      "project",
      "conversation",
      observed,
    )?.label,
    "终端 · 未选择会话",
  );
});

test("the actual workspace projection retains a launched Terminal without loading process output", async () => {
  const source = {
    boot: {
      centerId: randomUUID(),
      principalId: "human",
      actantId: "human",
      displayName: "我",
    },
    ensurePersonalSpaces: async () => ({
      deskId: "desk",
      inboxId: "inbox",
      dialogueId: "dialogue",
    }),
    allProjects: async () => [
      {
        id: "project",
        kind: "project",
        title: "TEST Terminal",
        ownerPrincipalId: "human",
        memberPrincipalIds: ["human"],
        revision: 1,
        createdAt: stamp,
        updatedAt: stamp,
        archivedAt: null,
        deletedAt: null,
      },
    ],
    allNavigationConversations: async () => [],
    allTasks: async () => [],
    taskCounts: async () => [],
    contentCounts: async () => [],
    content: async () => ({ items: [], nextCursor: null }),
    uiPackages: async () => [],
    cognitiveApps: {
      allCatalog: async () => ({ versions: [], connections: [] }),
    },
    taskOrder: async () => ({ revision: 0 }),
  } as unknown as PlatformClient;
  const instance = {
    id: "terminal-view",
    workspaceId: "project",
    applicationId: terminalApplication.id,
    applicationVersion: terminalApplication.version,
    state: { terminalId: "terminal-exact" },
    revision: 1,
    status: "open" as const,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const result = await readPlatformWorkspace(
    source,
    [instance],
    1,
    disconnectedRuntime,
  );
  assert.deepEqual(result.workspace.applicationInstances, [instance]);
  assert.ok(
    result.workspace.applications.some(
      (app) => app.id === terminalApplication.id,
    ),
  );
  assert.equal(result.workspace.inputs.length, 0);
  assert.equal(result.workspace.artifacts.length, 0);
});

test("new Terminal inputs pin only the navigation reference, not output or file bodies", () => {
  const input = {
    id: "input-exact",
    projectId: "project-exact",
    body: "查看当前目录",
    author: { actantId: "human-exact" },
    application: {
      id: "morphz.terminal",
      version: "1.0.0",
      instanceId: "instance-exact",
      harness: null,
      terminalId: "terminal-exact",
    },
    selection: "",
    attachments: [],
  } as unknown as Workspace["inputs"][number];
  const request = workInputRequest(input);
  assert.equal(
    request.message.format.version,
    terminalSessionInputFormat.version,
  );
  assert.deepEqual(request.message.content.value.terminal, {
    id: "terminal-exact",
  });
  assert.equal(request.activation.harness, undefined);
  assert.match(terminalInputFormat.contract, /not ordinary exec/);
  assert.doesNotMatch(
    JSON.stringify(request),
    /screen|scrollback|command_output/,
  );
  assert.equal(
    workInputRequest({ ...input, application: undefined }).message.format
      .version,
    "1",
  );
});

test("read projections use bounded logical calls and explicit caller cancellation", async () => {
  const calls: any[] = [];
  const controller = new AbortController();
  const commands = createTerminalInteractions(
    async (method, params, options) => {
      calls.push({ method, params, options });
      return method === "terminal.catalog"
        ? { terminals: [record()], limit: 50, has_more: false }
        : {
            terminal: record(),
            connected: true,
            checkpoint: false,
            screen: screen(),
          };
    },
  );
  const scope = { projectId: "project-exact", artifactId: null };
  await commands.terminalCatalog(scope, controller.signal);
  await commands.terminalRead(scope, "terminal-exact", 24, controller.signal);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["terminal.catalog", "terminal.read"],
  );
  assert.deepEqual(calls[1].params, {
    scope,
    terminalId: "terminal-exact",
    scrollback: 24,
  });
  controller.abort();
  assert.equal(calls[1].options.signal.aborted, true);
});

test("Web terminal transport is read-only and shares the typed operation with Desktop", async () => {
  const calls: { url: string; method: string }[] = [];
  const client = new HttpApplicationClient(
    "http://terminal.invalid",
    async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    },
  );
  const scope = { projectId: "p", artifactId: null, conversationId: "c" };
  await client.call("terminal.catalog", scope);
  await client.call("terminal.read", {
    scope,
    terminalId: "opaque/id",
    scrollback: 24,
  });
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.match(calls[0]!.url, /\/api\/terminals\?/);
  const url = new URL(calls[1]!.url);
  assert.equal(url.searchParams.get("terminalId"), "opaque/id");
  assert.equal(url.searchParams.get("conversationId"), "c");
  assert.equal(url.searchParams.get("scrollback"), "24");
  const command = {
    command_id: randomUUID(),
    expected_revision: 2,
    action: { type: "input", data: "printf 中文\r" },
  };
  await client.call("terminal.command", {
    scope,
    terminalId: "opaque/id",
    command,
  });
  assert.equal(calls[2]!.method, "POST");
  assert.match(calls[2]!.url, /\/api\/terminals\/commands$/);
  await client.call("terminal.open", { scope, commandId: randomUUID() });
  assert.equal(calls[3]!.method, "POST");
  assert.match(calls[3]!.url, /\/api\/terminals\/open$/);
});

test("terminal rendering escapes process output and never executes on SSR mount", () => {
  const markup = renderToStaticMarkup(
    createElement(TerminalCanvas, { screen: screen(), connected: true }),
  );
  assert.match(markup, /&lt;script&gt;not executable&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>|iframe|dangerouslySetInnerHTML/);
  assert.match(markup, /color:#c94343/);
  const events: unknown[] = [];
  const client = {
    boot: null,
    online: true,
    workspaceChangeRevision: 0,
    execute: () => events.push("execute"),
    terminalCatalog: () => events.push("catalog"),
    terminalRead: () => events.push("read"),
  } as unknown as WorkspaceClient;
  renderToStaticMarkup(
    createElement(Terminal, {
      client,
      instance: {
        id: "instance-exact",
        workspaceId: "p",
        applicationId: "morphz.terminal",
        applicationVersion: "1.0.0",
        state: {},
        revision: 1,
        status: "open",
        createdAt: stamp,
        updatedAt: stamp,
      },
      projectId: "p",
      active: true,
      onCompose: () => ({ ok: true }),
      onNotice: () => {},
    }),
  );
  assert.deepEqual(events, []);
});

test("real Platform input and scoped terminal reads keep original roots and recheck revoked grants", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const { dialogueId } = await f.session().ensurePlatformSpaces();
    await f.session().platformMessage({
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId: f.projectId,
        conversationId: dialogueId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "Terminal source test",
        targetActantId: "morphz-agent",
        application: {
          id: terminalApplication.id,
          version: terminalApplication.version,
          terminalId: "terminal-exact",
        },
      },
    });
    const internal = f.runtime as unknown as {
      state: any;
      request: (path: string, method?: string, body?: any) => Promise<unknown>;
      authorizePlatformRead: (...args: any[]) => Promise<any>;
    };
    const delivery = internal.state.deliveries[0];
    delivery.rootId = "root-exact";
    assert.equal(delivery.request.message.format.version, "14");
    assert.deepEqual(delivery.request.message.content.value.terminal, {
      id: "terminal-exact",
    });
    const source = delivery.platformSource;
    const contextId = `mw-context-${(f.store.runtimeState() as { namespace: string }).namespace}`;
    const value = {
      ...record(),
      session_id: delivery.sessionId,
      context_id: contextId,
    };
    let revoked = false,
      foreignRoot = false,
      mismatchedScreen = false,
      revokeAfterRead = false,
      revokeAfterMetadata = false;
    const authority = internal.authorizePlatformRead.bind(f.runtime);
    f.runtime.bindPlatformReadAuthority(async (...args) => {
      assert.equal(revoked, false, "terminal read authority revoked");
      return authority(...args);
    });
    const calls: string[] = [];
    const writes: unknown[] = [];
    internal.request = async (path, method, body) => {
      calls.push(path);
      if (method === "POST") {
        assert.match(path, /\/terminals\/terminal-exact\/commands$/);
        writes.push(body);
        return {
          command_id: body.command_id,
          terminal_id: "terminal-exact",
          revision: 3,
          input_status: "submitted",
          command_completion: "not_asserted",
        };
      }
      const url = new URL(path, "http://runtime.invalid");
      const candidate = {
        ...value,
        ...(foreignRoot ? { root_turn_id: "another-project-root" } : {}),
      };
      if (url.pathname.endsWith("/terminals")) {
        if (url.searchParams.has("scope_ref")) {
          assert.deepEqual(JSON.parse(url.searchParams.get("root_ids")!), []);
          return { terminals: [], limit: 50, has_more: false };
        }
        assert.deepEqual(JSON.parse(url.searchParams.get("root_ids")!), [
          "root-exact",
        ]);
        return { terminals: [candidate], limit: 50, has_more: false };
      }
      if (url.searchParams.has("metadata_only")) {
        if (revokeAfterMetadata) revoked = true;
        return { terminal: candidate };
      }
      if (revokeAfterRead) revoked = true;
      return {
        terminal: {
          ...candidate,
          ...(mismatchedScreen ? { source_job_id: "other-job" } : {}),
        },
        screen: screen(),
        checkpoint: false,
        connected: true,
      };
    };
    const scope = {
      projectId: source.projectId,
      conversationId: source.conversationId,
      artifactId: null,
    };
    assert.equal(
      (await f.session().terminalCatalog(scope)).terminals[0]!.id,
      "terminal-exact",
    );
    assert.equal(
      (await f.session().terminalRead({ scope, terminalId: "terminal-exact" }))
        .screen!.sequence,
      8,
    );
    assert.ok(
      calls.every(
        (path) =>
          !path.includes("/threads/") && !path.includes("/execution-jobs"),
      ),
      "no complete Thread or Job history is fetched",
    );
    const command = {
      command_id: randomUUID(),
      expected_revision: 2,
      action: { type: "input" as const, data: "printf 中文\r" },
    };
    const result = await f
      .session()
      .terminalCommand({ scope, terminalId: "terminal-exact", command });
    assert.equal(result.command_id, command.command_id);
    assert.deepEqual(writes, [command]);
    revokeAfterMetadata = true;
    await assert.rejects(
      f.session().terminalCommand({
        scope,
        terminalId: "terminal-exact",
        command: { ...command, command_id: randomUUID() },
      }),
      /revoked/,
    );
    assert.equal(
      writes.length,
      1,
      "a revoked Human cannot write after reading metadata",
    );
    revoked = false;
    revokeAfterMetadata = false;
    foreignRoot = true;
    await assert.rejects(f.session().terminalCatalog(scope), /来源/);
    await assert.rejects(
      f.session().terminalRead({ scope, terminalId: "terminal-exact" }),
      /获授权/,
    );
    await assert.rejects(
      f
        .session()
        .terminalCommand({ scope, terminalId: "terminal-exact", command }),
      /获授权/,
    );
    assert.equal(writes.length, 1);
    foreignRoot = false;
    mismatchedScreen = true;
    await assert.rejects(
      f.session().terminalRead({ scope, terminalId: "terminal-exact" }),
      /来源已变化/,
    );
    mismatchedScreen = false;
    revokeAfterRead = true;
    await assert.rejects(
      f.session().terminalRead({ scope, terminalId: "terminal-exact" }),
      /revoked/,
    );
    revoked = false;
    await assert.rejects(
      f.application
        .session({ ...localAccess, principalId: "foreign" })
        .terminalCatalog(scope),
      /权限|读取|身份|不属于/,
    );
  } finally {
    await f.close();
  }
});

test("direct creation prepares only the canonical execution Session, with no accepted input, model call or fake Job", async () => {
  let session: any,
    created: any,
    scopeRef: string | undefined,
    opens = 0,
    ioCalls = 0;
  const calls: { path: string; method: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    const url = new URL(req.url!, "http://runtime.invalid"),
      path = url.pathname;
    calls.push({ path, method: req.method!, body });
    res.setHeader("Content-Type", "application/json");
    const answer = (value: any, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    if (path === "/api/status") return answer({ model: "test-model" });
    if (path === "/api/runtime/inference" && req.method === "GET")
      return answer({ model: "test-model", models: ["test-model"] });
    if (path.includes("/io/messages")) {
      ioCalls++;
      return answer({ error: "unexpected model input" }, 500);
    }
    if (path === "/api/sessions" && req.method === "POST") {
      if (body.mount.type === "existing_context") return answer({}, 404);
      session = {
        id: body.id,
        context_id: body.mount.context_id,
        permission_mode: null,
        sandbox_mode: null,
      };
      return answer(session);
    }
    if (path === `/api/sessions/${session?.id}`) {
      if (req.method === "PATCH") Object.assign(session, body);
      return answer(session);
    }
    if (path.endsWith("/principal"))
      return answer({
        principal_id: "principal-default",
        session_id: session.id,
        context_id: session.context_id,
        capabilities: ["session_turn_control"],
      });
    if (path.endsWith("/terminals")) {
      if (req.method === "POST") {
        opens++;
        scopeRef = body.scope_ref;
        created ??= {
          ...record(),
          id: "terminal-human-exact",
          session_id: session.id,
          context_id: session.context_id,
          principal_id: "principal-default",
          root_turn_id: null,
          source_job_id: null,
          scope_ref: scopeRef,
          creation_command_id: body.command_id,
        };
        return answer({
          command_id: body.command_id,
          terminal: created,
          connected: true,
        });
      }
      return answer({
        terminals:
          created && url.searchParams.get("scope_ref") === scopeRef
            ? [created]
            : [],
        limit: 50,
        has_more: false,
      });
    }
    if (path.endsWith("/terminals/terminal-human-exact/commands"))
      return answer({
        command_id: body.command_id,
        terminal_id: created.id,
        revision: 3,
        input_status: "submitted",
        command_completion: "not_asserted",
      });
    if (path.endsWith("/terminals/terminal-human-exact"))
      return url.searchParams.has("metadata_only")
        ? answer({ terminal: created })
        : answer({
            terminal: created,
            connected: true,
            checkpoint: false,
            screen: screen(),
          });
    return answer({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await platformRuntimeHostFixture({
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    token: "isolated-terminal-test",
    namespace: randomUUID(),
  });
  try {
    const { dialogueId } = await f.session().ensurePlatformSpaces();
    const scope = {
      projectId: f.projectId,
      conversationId: dialogueId,
      artifactId: null,
    };
    const before = (f.runtime as any).state.deliveries.length;
    assert.deepEqual((await f.session().terminalCatalog(scope)).terminals, []);
    assert.equal(
      session,
      undefined,
      "read-only empty catalog does not create a Session",
    );
    const commandId = randomUUID();
    const receipt = await f.session().terminalOpen({ scope, commandId });
    assert.equal(receipt.terminal.root_turn_id, null);
    assert.equal(receipt.terminal.source_job_id, null);
    assert.equal(receipt.terminal.creation_command_id, commandId);
    assert.equal(
      (session as any).permission_mode,
      "request_approval",
      "fresh resource Session keeps safe default policy",
    );
    assert.equal(opens, 1);
    assert.equal((f.runtime as any).state.deliveries.length, before);
    assert.equal(ioCalls, 0);
    assert.ok(
      calls.every(
        (c) =>
          !c.path.includes("execution-jobs") && !c.path.includes("/threads/"),
      ),
    );
    assert.equal(
      (await f.session().terminalCatalog(scope)).terminals[0]?.id,
      receipt.terminal.id,
    );
    assert.equal(
      (
        await f
          .session()
          .terminalRead({ scope, terminalId: receipt.terminal.id })
      ).screen?.sequence,
      8,
    );
    await f
      .session()
      .terminalCommand({
        scope,
        terminalId: receipt.terminal.id,
        command: {
          command_id: randomUUID(),
          expected_revision: 2,
          action: { type: "input", data: "printf real\r" },
        },
      });
    const unchanged = opens;
    await f.reopen();
    assert.equal(
      (await f.session().terminalCatalog(scope)).terminals[0]?.id,
      receipt.terminal.id,
    );
    assert.equal(
      opens,
      unchanged,
      "Host reopen never repeats process creation",
    );
    await assert.rejects(
      f
        .session()
        .terminalOpen({
          scope: { ...scope, threadId: "made-up" },
          commandId: randomUUID(),
        }),
      /范围/,
    );
    await assert.rejects(
      f.application
        .session({ ...localAccess, principalId: "foreign" })
        .terminalOpen({ scope, commandId: randomUUID() }),
      /权限|身份|读取|不属于/,
    );
    assert.equal(
      opens,
      unchanged,
      "invalid scope and identity never reach physical creation",
    );
    assert.equal(ioCalls, 0);
    assert.equal((f.runtime as any).state.deliveries.length, before);
    f.assertNoLegacyData();
  } finally {
    await f.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
