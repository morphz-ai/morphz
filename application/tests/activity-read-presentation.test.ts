import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  activitySchema,
  disconnectedRuntime,
  type ConversationRuntime,
} from "../packages/core/src/conversation.js";
import { initialWorkspace } from "../packages/core/src/model.js";
import type { WorkspaceClient } from "../apps/web/src/client.js";
import { executionActivityIsDeferred } from "../apps/web/src/execution-activity.js";

// Static component output checks truthful status semantics, not CSS or native
// behavior. Browser and original-app acceptance remain separate requirements.
const styles = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith(".css")
      ? { format: "module", source: "export {};", shortCircuit: true }
      : nextLoad(url, context);
  },
});
let sidebar: typeof import("../apps/web/src/ExecutionSidebar.js");
try {
  sidebar = await import("../apps/web/src/ExecutionSidebar.js");
} finally {
  styles.deregister();
}

const stamp = "2026-10-24T03:25:00Z";
const threads = ["current", "unavailable"].map((id) => ({
  id,
  kind: "execution",
  projectId: "TEST-project",
  conversationId: "TEST-project",
  inputId: `TEST-input-${id}`,
  rootId: `TEST-root-${id}`,
  sessionId: `TEST-session-${id}`,
  contextId: `TEST-context-${id}`,
  title: `TEST ${id}`,
  summary: `TEST progress ${id}`,
  phase: "running",
  lifecycle: "open",
  revision: 1,
  updatedAt: stamp,
}));
function runtime(connected = true): ConversationRuntime {
  return {
    ...disconnectedRuntime,
    configured: true,
    connected,
    activity: {
      available: false,
      truncated: true,
      openWorkComplete: false,
      threads,
      readScopes: [
        {
          contextId: "TEST-context-current",
          currentAvailable: true,
          historyAvailable: false,
        },
        {
          contextId: "TEST-context-unavailable",
          currentAvailable: false,
          historyAvailable: false,
        },
      ],
    },
  } as ConversationRuntime;
}
function markup(value: ConversationRuntime, online = true) {
  const client = {
    online,
    boot: {
      workspace: initialWorkspace(stamp),
      runtime: value,
      capabilities: { teamAuthentication: false },
      outputs: [],
      scriptOutputs: [],
    },
    contentCatalog: [],
  } as unknown as WorkspaceClient;
  return renderToStaticMarkup(
    createElement(sidebar.ExecutionSidebar, {
      client,
      scope: { projectId: "TEST-project", artifactId: null },
      layout: { mode: "docked", width: 340, maxWidth: 520 },
      onResize: () => {},
      onClose: () => {},
      onSelect: () => {},
      onOpen: () => {},
    }),
  );
}
function row(html: string, id: string) {
  const result = html.match(
    new RegExp(`<button[^>]*data-thread-id="${id}"[^>]*>[\\s\\S]*?</button>`),
  );
  assert.ok(result, `actual row ${id} remains visible`);
  return result[0];
}

test("activity transport retains exact per-Context read facts without changing global completeness", () => {
  const source = runtime().activity!;
  const parsed = activitySchema.parse(source);
  assert.deepEqual(
    (parsed as typeof source & { readScopes?: unknown }).readScopes,
    (source as typeof source & { readScopes?: unknown }).readScopes,
  );
  assert.equal(parsed.available, false);
  assert.equal(parsed.openWorkComplete, false);
});

test("actual activity rows keep a successfully read Context current, not an unrelated failed Context", () => {
  const html = markup(runtime());
  assert.match(row(html, "current"), /data-status="running"/);
  assert.match(row(html, "current"), /TEST progress current/);
  assert.match(row(html, "unavailable"), /data-status="unknown"/);
  assert.doesNotMatch(row(html, "unavailable"), /TEST progress unavailable/);
  assert.match(html, /工作状态待核对/);
});

test("disconnection and conflicting or missing Context observations never animate cached open work", () => {
  assert.match(row(markup(runtime(false)), "current"), /data-status="unknown"/);
  assert.match(
    row(markup(runtime(), false), "current"),
    /data-status="unknown"/,
  );
  assert.doesNotMatch(
    row(markup(runtime(), false), "current"),
    /TEST progress current/,
  );
  const duplicate = runtime();
  const activity = duplicate.activity! as NonNullable<
    ConversationRuntime["activity"]
  > & {
    readScopes: {
      contextId: string;
      currentAvailable: boolean;
      historyAvailable: boolean;
    }[];
  };
  activity.readScopes.push({
    ...activity.readScopes[0]!,
    currentAvailable: false,
  });
  assert.match(row(markup(duplicate), "current"), /data-status="unknown"/);
  const missing = runtime();
  missing.activity!.threads = threads.map(
    ({ contextId: _contextId, ...thread }) => thread,
  );
  assert.match(row(markup(missing), "current"), /data-status="unknown"/);
});

test("a successful current Context read is not proof that schedule inventory is available", () => {
  const value = runtime();
  const thread = { ...threads[0]!, phase: "waiting" };
  value.activity!.schedulesAvailable = false;
  value.activity!.schedules = [
    {
      scheduleId: "TEST-schedule",
      status: "queued",
      threadId: thread.id,
      inputId: thread.inputId,
      projectId: thread.projectId,
      conversationId: thread.conversationId,
      sessionId: thread.sessionId,
      rootId: thread.rootId,
      contextId: thread.contextId,
      sourceTurnId: "TEST-source-turn",
      sourceRootId: "TEST-source-root",
      revision: 1,
      notBefore: stamp,
      intervalSeconds: null,
      dependencyThreadIds: [],
      intent: "TEST queued schedule",
      updatedAt: stamp,
    },
  ];
  // Keep it discoverable in activity rather than falsely claiming the timer
  // inventory was checked. Deferred classification still requires its proof.
  assert.equal(executionActivityIsDeferred(thread, value), false);
});
