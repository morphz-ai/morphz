import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
      request: (path: string, method?: string) => Promise<unknown>;
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
      revokeAfterRead = false;
    const authority = internal.authorizePlatformRead.bind(f.runtime);
    f.runtime.bindPlatformReadAuthority(async (...args) => {
      assert.equal(revoked, false, "terminal read authority revoked");
      return authority(...args);
    });
    const calls: string[] = [];
    internal.request = async (path, method) => {
      calls.push(path);
      assert.ok(
        !method || method === "GET",
        "terminal view never writes Runtime state",
      );
      const url = new URL(path, "http://runtime.invalid");
      const candidate = {
        ...value,
        ...(foreignRoot ? { root_turn_id: "another-project-root" } : {}),
      };
      if (url.pathname.endsWith("/terminals")) {
        assert.deepEqual(JSON.parse(url.searchParams.get("root_ids")!), [
          "root-exact",
        ]);
        return { terminals: [candidate], limit: 50, has_more: false };
      }
      if (url.searchParams.has("metadata_only")) return { terminal: candidate };
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
    foreignRoot = true;
    await assert.rejects(f.session().terminalCatalog(scope), /来源/);
    await assert.rejects(
      f.session().terminalRead({ scope, terminalId: "terminal-exact" }),
      /获授权/,
    );
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
