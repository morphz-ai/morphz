import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { execFileSync } from "node:child_process";

// Read-only acceptance of the exact original databases against the pre-cutover
// backup. Never reset, repair, replay, or print user contents/credentials.
const [root, backup, previousBinary] = process.argv.slice(2);
assert.ok(
  [root, backup, previousBinary].every((value) => value && isAbsolute(value)),
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const quote = (name) => {
  assert.match(name, /^[a-zA-Z_][a-zA-Z0-9_]*$/);
  return `"${name}"`;
};
const serialized = (value) =>
  JSON.stringify(value, (_, item) =>
    item instanceof Uint8Array
      ? { bytes: item.length, sha256: hash(item) }
      : item,
  );
function open(file) {
  assert.ok(existsSync(file), `Missing existing database: ${file}`);
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("BEGIN");
  assert.equal(
    Object.values(db.prepare("PRAGMA integrity_check").get())[0],
    "ok",
  );
  return db;
}
function close(db) {
  db.exec("ROLLBACK");
  db.close();
}
function rows(db, table) {
  return db.prepare(`SELECT * FROM ${quote(table)}`).all();
}
function compareTable(before, after, table, normalize = (row) => row) {
  const oldRows = rows(before, table),
    newRows = rows(after, table);
  const fields = before
    .prepare(`PRAGMA table_info(${quote(table)})`)
    .all()
    .filter((field) => field.pk)
    .sort((a, b) => a.pk - b.pk)
    .map((field) => field.name);
  const key = (row) =>
    serialized(fields.length ? fields.map((name) => row[name]) : row);
  const current = new Map(
    newRows.map((row) => [key(row), serialized(normalize(row, false))]),
  );
  const missing = oldRows.filter((row) => !current.has(key(row))).length;
  const originalKeys = new Set(oldRows.map(key));
  const additions = newRows.filter((row) => !originalKeys.has(key(row)));
  const changed = oldRows.filter(
    (row) =>
      current.has(key(row)) &&
      current.get(key(row)) !== serialized(normalize(row, true)),
  ).length;
  return {
    table,
    before: oldRows.length,
    after: newRows.length,
    missing,
    changed,
    additions,
  };
}
function differences(before, after, path = "") {
  if (isDeepStrictEqual(before, after)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object"
  ) {
    return [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].flatMap((key) => differences(before[key], after[key], `${path}/${key}`));
  }
  return [path];
}
const oldApp = open(join(backup, "workspace.sqlite"));
const app = open(join(root, "center/workspace.sqlite"));
const oldRuntime = open(join(backup, "runtime.sqlite"));
const runtime = open(join(root, "runtime/runtime.sqlite"));
try {
  // Reproduce the Runtime policy hash from its verified permission controls and
  // protected-file order (main.rs protect_runtime_files + RuntimeBuilder). A
  // binary/manifest path changes the digest, not the configured privileges.
  const currentBinary = JSON.parse(
    readFileSync(join(root, "embedded-runtime.json"), "utf8"),
  ).binary;
  const controls = [];
  const policyDigests = [previousBinary, currentBinary].map((binary, index) => {
    assert.ok(isAbsolute(binary) && existsSync(binary));
    const args = [
      "--cwd",
      join(root, "workspace"),
      "--config-file",
      join(root, "runtime/morphz.toml"),
    ];
    const options = {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MORPHZ_HOME: join(root, "runtime"),
        MORPHZ_STORAGE_SQLITE_PATH: join(root, "runtime/runtime.sqlite"),
      },
    };
    const config = execFileSync(binary, ["config", "show", ...args], options);
    const permissions = config.match(
      /permissions: PermissionConfig \{([\s\S]*?)\n    \},/,
    )?.[1];
    assert.ok(
      permissions,
      "Read-only configuration must expose permission controls",
    );
    controls.push(permissions);
    const loaded = execFileSync(binary, ["config", "path", ...args], options)
      .trim()
      .split("\n")
      .map((line) => line.split("\t")[1]);
    assert.ok(loaded.every((path) => path && isAbsolute(path)));
    const defaults = [
      ...permissions
        .match(/protected_paths: \[([\s\S]*?)\]/)[1]
        .matchAll(/"([^"]+)"/g),
    ].map((match) => match[1]);
    const protectedPaths = [
      ...new Set([
        ...defaults,
        ...loaded,
        join(
          root,
          "center",
          index ? "host-tools-desktop.json" : "host-tools.json",
        ),
        join(root, "center"),
        binary,
        ...[
          ".env",
          "morphz.toml",
          "models.toml",
          "active-profile",
          "managed-secrets.json",
          "managed-secret-usage.jsonl",
          "profiles",
          "edge",
        ].map((path) => join(root, "runtime", path)),
        ...[
          ".ssh",
          ".env",
          ".env.local",
          ".env.development",
          ".env.development.local",
          ".env.test",
          ".env.test.local",
          ".env.production",
          ".env.production.local",
        ].map((path) => join(process.env.HOME, path)),
        ...["", "-wal", "-shm"].map(
          (suffix) => join(root, "runtime/runtime.sqlite") + suffix,
        ),
      ]),
    ];
    const policy = {
      mode: "auto_review",
      sandbox_mode: "workspace-write",
      approval_policy: "on_request",
      reviewer: "auto_review",
      auto_review_model: null,
      workspace_root: join(root, "workspace"),
      read_roots: [join(root, "workspace"), "/"],
      write_roots: [join(root, "workspace")],
      protected_paths: protectedPaths,
      network: true,
      shell_environment_policy: "remove_sensitive",
    };
    const digest =
      "policy_" +
      hash(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(policy).sort(([a], [b]) => a.localeCompare(b)),
          ),
        ),
      );
    const db = index ? runtime : oldRuntime;
    assert.equal(
      db
        .prepare("SELECT policy_digest FROM execution_targets WHERE id=?")
        .get("target-default").policy_digest,
      digest,
      "Target policy must exactly match the reconstructed controls and protected paths",
    );
    return digest;
  });
  assert.equal(
    controls[0],
    controls[1],
    "Configured permissions differ between original and current Runtime",
  );
  const timestamps = (before, after, fields) => {
    for (const field of fields) {
      assert.ok(
        Number.isFinite(Date.parse(after[field])) &&
          Date.parse(after[field]) >= Date.parse(before[field]),
        `Invalid operational timestamp: ${field}`,
      );
    }
  };
  const normalizeRuntime = (table) => (row, originalRow) => {
    if (table === "principals") {
      const before = oldRuntime
        .prepare("SELECT * FROM principals WHERE id=?")
        .get(row.id);
      if (!originalRow) timestamps(before, row, ["updated_at"]);
      return { ...row, updated_at: before.updated_at };
    }
    if (table === "execution_targets" && row.id === "target-default") {
      const before = oldRuntime
        .prepare("SELECT * FROM execution_targets WHERE id=?")
        .get(row.id);
      if (!originalRow) {
        timestamps(before, row, ["updated_at", "last_seen_at"]);
        assert.equal(
          row.revision,
          before.revision + 2,
          "Only the two verified startup registrations are expected",
        );
        assert.equal(row.policy_digest, policyDigests[1]);
      }
      return {
        ...row,
        revision: before.revision,
        updated_at: before.updated_at,
        last_seen_at: before.last_seen_at,
        policy_digest: policyDigests[0],
      };
    }
    return row;
  };
  const appTables = [
    "commands",
    "artifact_outputs",
    "assets",
    "asset_owners",
    "pdf_metadata",
    "center_metadata",
    "service_state",
  ].map((table) => compareTable(oldApp, app, table));
  for (const result of appTables) {
    assert.equal(
      result.missing,
      0,
      `Missing original application rows: ${result.table}`,
    );
    assert.equal(
      result.changed,
      0,
      `Changed original application rows: ${result.table}`,
    );
  }
  const original = JSON.parse(
    oldApp.prepare("SELECT body FROM workspace WHERE id=1").get().body,
  );
  const current = JSON.parse(
    app.prepare("SELECT body FROM workspace WHERE id=1").get().body,
  );
  const workspaceDifferences = differences(original, current);
  // Exact, observed original-window acceptance actions on 2026-09-12:
  // reopen the existing PDF reader, then open TEST's browser at example.com.
  // Compare these complete records, rather than exempting application state
  // from preservation checks. Any later user action requires a fresh audit.
  const auditedWorkspace = structuredClone(current);
  const readerId = "271b33fe-dd96-4af1-bd3d-9c3e334f03ff";
  const oldReader = original.applicationInstances.find(
    (instance) => instance.id === readerId,
  );
  assert.ok(oldReader, "Expected original reader must exist in the baseline");
  const readerIndex = current.applicationInstances.findIndex(
    (instance) => instance.id === readerId,
  );
  const observedReader = {
    ...oldReader,
    revision: 51,
    state: { artifactId: "268db9f5-23a6-4e38-8a1c-1b068409fd4c" },
    status: "open",
    updatedAt: "2026-09-12T04:59:19.159Z",
  };
  const manualAcceptance = [];
  // Real inputs were submitted through the original desktop on 2026-09-12.
  // These are observed identities, not a blanket exception for new work. Keep
  // every pre-cutover row immutable and verify the complete test records before
  // excluding them from the original-workspace comparison (in memory only).
  const acceptance = {
    inputId: "364fc4b0-e12f-4816-bc30-2b50121ac531",
    conversationId: "c3443373-3735-4438-b0dd-67ef07485c57",
    projectId: "81e56595-713f-40a3-a150-29f192b057bb",
    artifactId: "74dee1d3-935f-5bb7-bb93-28a42f93aaf4",
    sessionId: "mw-eb708435-7cd660f4e3e6de70c9679077",
    rootId: "msg_1789193486248571000_77065_0",
    threadId: "thread_6eb235b98d9606ccda6a519d",
    title: "内嵌宿主验收 20260912",
    markdown:
      "这是一份用于验证真实模型、Runtime API 与本地 IPC 对象交付的测试文档。",
    createdAt: "2026-09-12T06:11:25.950Z",
    deliveredAt: "2026-09-12T06:12:09.227Z",
    activationIds: [
      "work_6eb235b98d9606ccda6a519d",
      "work_35b0842b0b0a30732acb7616",
      "work_41a7b43ab8d2436111ccd50d",
      "work_0bc25d3b540d97fd6d50dbd1",
    ],
  };
  const hasLiveAcceptance = current.inputs.some(
    (input) => input.id === acceptance.inputId,
  );
  const concurrent = {
    conversationId: "9dc28492-4f8a-4119-aae9-82657d818e6f",
    sessionId: "mw-eb708435-ef723c01d7382ad1f0095388",
    readerId: "acfdc551-4d13-4a20-ab4c-31193bfa4043",
    runs: [
      {
        inputId: "f9d43e25-530a-4508-8293-b95c846ac189",
        rootId: "msg_1789202950606101000_77065_1",
        threadId: "thread_4da193509b109f0ad1fad884",
        activationIds: ["work_4da193509b109f0ad1fad884"],
        createdAt: "2026-09-12T08:49:09.951Z",
        body: "[并发流式验收 A 20260912] 请只输出 A01 至 A40 共四十行，每行格式为“A01：这是 Morphz 原桌面的流式显示验收。”并递增编号。不要调用工具，不要创建、修改或删除任何对象。",
        reply: Array.from(
          { length: 40 },
          (_, index) =>
            `A${String(index + 1).padStart(2, "0")}：这是 Morphz 原桌面的流式显示验收。`,
        ).join("\n"),
      },
      {
        inputId: "25ee7eb2-f4c0-4e55-961b-8382d70688f6",
        rootId: "msg_1789202968556982000_77065_2",
        threadId: "thread_a0468629dcd8b855440745a9",
        activationIds: ["work_a0468629dcd8b855440745a9"],
        createdAt: "2026-09-12T08:49:28.140Z",
        body: "[并发流式验收 B 20260912] 这是与 A 独立的一次输入。只回复“B 已独立完成”。不要调用工具，不要创建、修改或删除任何对象。",
        reply: "B 已独立完成",
      },
    ],
  };
  const hasConcurrentAcceptance = current.inputs.some(
    (input) => input.id === concurrent.runs[0].inputId,
  );
  const removeObserved = (collection, expected) => {
    assert.equal(
      original[collection].some((record) => record.id === expected.id),
      false,
    );
    const index = auditedWorkspace[collection].findIndex(
      (record) => record.id === expected.id,
    );
    assert.ok(index >= 0, `Missing observed ${collection} record`);
    assert.deepEqual(auditedWorkspace[collection][index], expected);
    auditedWorkspace[collection].splice(index, 1);
  };
  if (hasLiveAcceptance) {
    removeObserved("conversations", {
      id: acceptance.conversationId,
      projectId: acceptance.projectId,
      title: "对话 1",
      revision: 1,
      archivedAt: null,
      createdAt: acceptance.createdAt,
      updatedAt: acceptance.createdAt,
    });
    removeObserved("inputs", {
      id: acceptance.inputId,
      projectId: acceptance.projectId,
      conversationId: acceptance.conversationId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: `这是 Morphz 内嵌宿主验收测试（2026-09-12）。请在当前 TEST 项目中，用可用的宿主对象工具创建一份新文档，标题为“${acceptance.title}”，正文严格为“${acceptance.markdown}”创建成功后简短回复并附交付链接。不要修改或删除已有内容，不要访问网站或执行其他任务。`,
      author: { principalId: "local-owner", actantId: "local-human" },
      targetActantId: "morphz-agent",
      status: "recorded",
      createdAt: acceptance.createdAt,
    });
    const author = { principalId: "morphz-service", actantId: "morphz-agent" };
    const content = { kind: "document", markdown: acceptance.markdown };
    removeObserved("artifacts", {
      id: acceptance.artifactId,
      projectId: acceptance.projectId,
      originConversationId: acceptance.conversationId,
      title: acceptance.title,
      content,
      revision: 1,
      createdBy: author,
      createdAt: acceptance.deliveredAt,
      updatedAt: acceptance.deliveredAt,
      versions: [
        {
          revision: 1,
          title: acceptance.title,
          content,
          author,
          createdAt: acceptance.deliveredAt,
        },
      ],
      source: null,
    });
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          app
            .prepare("SELECT * FROM artifact_outputs WHERE input_id=?")
            .all(acceptance.inputId),
        ),
      ),
      [
        {
          command_id: acceptance.artifactId,
          input_id: acceptance.inputId,
          project_id: acceptance.projectId,
          artifact_id: acceptance.artifactId,
          revision: 1,
          created_at: acceptance.deliveredAt,
        },
      ],
    );
    const runtimeState = JSON.parse(
      app.prepare("SELECT body FROM runtime_state WHERE id=1").get().body,
    );
    const delivery = runtimeState.deliveries.find(
      (entry) => entry.inputId === acceptance.inputId,
    );
    assert.ok(delivery);
    assert.equal(delivery.state, "completed");
    assert.equal(delivery.sessionId, acceptance.sessionId);
    assert.equal(delivery.rootId, acceptance.rootId);
    assert.equal(delivery.error, null);
    manualAcceptance.push({
      inputId: acceptance.inputId,
      artifactId: acceptance.artifactId,
      action:
        "Original desktop real Provider input and Agent document delivery",
    });
  }
  if (
    current.applicationInstances.some(
      (instance) => instance.id === concurrent.readerId,
    )
  ) {
    assert.ok(hasLiveAcceptance);
    removeObserved("applicationInstances", {
      id: concurrent.readerId,
      workspaceId: acceptance.projectId,
      applicationId: "morphz.objects",
      applicationVersion: "1.0.0",
      revision: 1,
      state: { artifactId: acceptance.artifactId },
      status: "open",
      createdAt: "2026-09-12T08:44:06.494Z",
      updatedAt: "2026-09-12T08:44:06.494Z",
    });
    manualAcceptance.push({
      instanceId: concurrent.readerId,
      action: "Open actual delivered document from its original-window card",
    });
  }
  if (hasConcurrentAcceptance) {
    assert.ok(hasLiveAcceptance);
    removeObserved("conversations", {
      id: concurrent.conversationId,
      projectId: acceptance.projectId,
      title: "对话 2",
      revision: 1,
      archivedAt: null,
      createdAt: concurrent.runs[0].createdAt,
      updatedAt: concurrent.runs[0].createdAt,
    });
    for (const run of concurrent.runs) {
      removeObserved("inputs", {
        id: run.inputId,
        projectId: acceptance.projectId,
        conversationId: concurrent.conversationId,
        artifactId: acceptance.artifactId,
        artifactRevision: 1,
        selection: "",
        body: run.body,
        author: { principalId: "local-owner", actantId: "local-human" },
        targetActantId: "morphz-agent",
        status: "recorded",
        application: {
          instanceId: concurrent.readerId,
          id: "morphz.objects",
          version: "1.0.0",
          harness: null,
        },
        createdAt: run.createdAt,
      });
      assert.equal(
        runtime
          .prepare("SELECT result_text FROM threads WHERE id=?")
          .get(run.threadId).result_text,
        run.reply,
      );
    }
    const [first, second] = concurrent.runs.map((run) =>
      runtime.prepare("SELECT * FROM threads WHERE id=?").get(run.threadId),
    );
    assert.ok(Date.parse(first.created_at) < Date.parse(second.created_at));
    assert.ok(Date.parse(second.created_at) < Date.parse(first.updated_at));
    assert.ok(Date.parse(second.updated_at) < Date.parse(first.updated_at));
    assert.equal(
      runtime
        .prepare(
          "SELECT count(*) AS count FROM execution_jobs WHERE session_id=?",
        )
        .get(concurrent.sessionId).count,
      0,
      "The text-only concurrency checks must not run tools",
    );
    manualAcceptance.push({
      inputIds: concurrent.runs.map((run) => run.inputId),
      action:
        "Two overlapping original-window inputs; B completed before A; exact independent replies",
    });
  }
  if (
    !isDeepStrictEqual(oldReader, current.applicationInstances[readerIndex])
  ) {
    assert.deepEqual(current.applicationInstances[readerIndex], observedReader);
    auditedWorkspace.applicationInstances[readerIndex] = oldReader;
    manualAcceptance.push({
      instanceId: readerId,
      action: "Open existing PDF",
    });
  }
  const browserId = "b5f481f8-a53e-4044-8035-589e025186c2";
  const browserIndex = current.applicationInstances.findIndex(
    (instance) => instance.id === browserId,
  );
  if (browserIndex !== -1) {
    assert.equal(original.applicationInstances.length, browserIndex);
    assert.deepEqual(current.applicationInstances[browserIndex], {
      id: browserId,
      workspaceId: "81e56595-713f-40a3-a150-29f192b057bb",
      applicationId: "morphz.browser",
      applicationVersion: "1.0.0",
      revision: 2,
      state: { url: "https://example.com/" },
      status: "open",
      createdAt: "2026-09-12T05:10:20.331Z",
      updatedAt: "2026-09-12T05:10:42.466Z",
    });
    auditedWorkspace.applicationInstances.splice(browserIndex, 1);
    manualAcceptance.push({
      instanceId: browserId,
      action: "Open TEST browser at public example.com without Agent consent",
    });
  }
  const operational =
    /^\/(?:revision|artifacts\/\d+\/source\/connection\/(?:status|checkedAt))$/;
  assert.deepEqual(
    differences(original, auditedWorkspace).filter(
      (path) => !operational.test(path),
    ),
    [],
    "Original workspace data changed beyond source bookkeeping and the exact observed UI acceptance actions",
  );
  const runtimeTables = [
    "agents",
    "principals",
    "cognitive_contexts",
    "sessions",
    "session_mounts",
    "session_message_requests",
    "session_principal_bindings",
    "threads",
    "thread_groups",
    "thread_group_members",
    "thread_activations",
    "thread_signals",
    "activation_signals",
    "execution_jobs",
    "execution_targets",
    "schedules",
    "schedule_dependencies",
    "scheduler_dependencies",
    "runtime_timers",
    "thread_outcomes",
    "experimental_contextdb_nodes",
    "experimental_contextdb_receipts",
    "approval_requests",
    "capability_leases",
    "work_assignments",
    "objectives",
    "agent_provider_bindings",
    "agent_provider_binding_scopes",
  ].map((table) =>
    compareTable(oldRuntime, runtime, table, normalizeRuntime(table)),
  );
  const acceptedRuns = [
    ...(hasLiveAcceptance ? [acceptance] : []),
    ...(hasConcurrentAcceptance
      ? concurrent.runs.map((run) => ({
          ...run,
          sessionId: concurrent.sessionId,
        }))
      : []),
  ];
  const acceptedSessions = new Set(acceptedRuns.map((run) => run.sessionId));
  const acceptedThreads = new Set(acceptedRuns.map((run) => run.threadId));
  const acceptedActivations = new Set(
    acceptedRuns.flatMap((run) => run.activationIds),
  );
  const runtimeState = JSON.parse(
    app.prepare("SELECT body FROM runtime_state WHERE id=1").get().body,
  );
  for (const run of acceptedRuns) {
    const delivery = runtimeState.deliveries.find(
      (entry) => entry.inputId === run.inputId,
    );
    assert.ok(delivery);
    assert.equal(delivery.state, "completed");
    assert.equal(delivery.sessionId, run.sessionId);
    assert.equal(delivery.rootId, run.rootId);
    assert.equal(delivery.error, null);
  }
  for (const result of runtimeTables) {
    assert.equal(
      result.missing,
      0,
      `Missing original Runtime rows: ${result.table}`,
    );
    assert.equal(
      result.changed,
      0,
      `Changed original Runtime rows: ${result.table}`,
    );
    const expectedAdditions = hasLiveAcceptance
      ? {
          sessions: acceptedSessions.size,
          session_mounts: acceptedSessions.size,
          session_message_requests: acceptedRuns.length,
          session_principal_bindings: acceptedSessions.size,
          threads: acceptedRuns.length,
          thread_activations: acceptedActivations.size,
          thread_signals: acceptedActivations.size,
          activation_signals: acceptedActivations.size,
          execution_jobs: 2,
          runtime_timers: acceptedActivations.size,
          thread_outcomes: acceptedRuns.length,
        }
      : {};
    assert.equal(
      result.additions.length,
      expectedAdditions[result.table] ?? 0,
      `Unexpected new Runtime rows/replay: ${result.table}`,
    );
    for (const row of result.additions) {
      if (result.table === "sessions") assert.ok(acceptedSessions.has(row.id));
      else if (result.table === "runtime_timers") {
        assert.equal(row.kind, "activation_lease");
        assert.equal(row.status, "cancelled");
        assert.ok(acceptedActivations.has(row.owner_id));
        assert.equal(row.id, `activation-lease:${row.owner_id}`);
      } else if (result.table === "activation_signals") {
        assert.ok(acceptedActivations.has(row.activation_id));
        assert.equal(
          row.signal_id,
          row.activation_id.replace("work_", "signal_"),
        );
      } else if (result.table === "thread_signals") {
        assert.ok(acceptedThreads.has(row.thread_id));
        assert.equal(row.status, "acknowledged");
        assert.ok(acceptedActivations.has(row.id.replace("signal_", "work_")));
      } else assert.ok(acceptedSessions.has(row.session_id));
      if (result.table === "session_message_requests") {
        const run = acceptedRuns.find(
          (run) => run.inputId === row.client_message_id,
        );
        assert.ok(run);
        assert.equal(row.event_id, run.rootId);
        assert.equal(row.session_id, run.sessionId);
      }
      if (result.table === "thread_activations") {
        const run = acceptedRuns.find((run) =>
          run.activationIds.includes(row.id),
        );
        assert.ok(run);
        assert.equal(row.root_turn_id, run.rootId);
        assert.equal(row.session_id, run.sessionId);
        assert.equal(row.status, "completed");
      }
      if (result.table === "threads") {
        const run = acceptedRuns.find((run) => run.threadId === row.id);
        assert.ok(run);
        assert.equal(row.root_turn_id, run.rootId);
        assert.equal(row.session_id, run.sessionId);
        assert.equal(row.status, "completed");
      }
      if (result.table === "thread_outcomes") {
        assert.ok(acceptedThreads.has(row.thread_id));
        assert.equal(row.terminal_kind, "completed");
      }
      if (result.table === "execution_jobs") {
        assert.equal(row.thread_id, acceptance.threadId);
        // The 2026-09-12 cutover used this name; its receipts are immutable.
        assert.equal(row.tool_name, "host_morphz_work");
        assert.equal(row.status, "succeeded");
        const request = JSON.parse(row.request_json);
        assert.ok(["list", "create-document"].includes(request.action));
        if (request.action === "create-document") {
          assert.equal(request.title, acceptance.title);
          assert.equal(request.markdown, acceptance.markdown);
        }
      }
    }
  }
  const events = compareTable(oldRuntime, runtime, "events");
  assert.equal(events.missing, 0);
  assert.equal(
    events.changed,
    0,
    "Persisted historical Runtime events changed",
  );
  const configurations = [
    "center/runtime.json",
    "center/host-tools.json",
    "runtime/morphz.toml",
    "runtime/models.toml",
  ]
    .filter((path) => existsSync(join(backup, "configuration", path)))
    .map((path) => {
      const before = readFileSync(join(backup, "configuration", path));
      const after = readFileSync(join(root, path));
      const same = hash(after) === hash(before);
      const trailingNewlineOnly =
        path === "center/host-tools.json" &&
        after.toString().trimEnd() === before.toString().trimEnd();
      assert.ok(
        same || trailingNewlineOnly,
        `Original configuration changed: ${path}`,
      );
      return { path, unchanged: true, bytesIdentical: same };
    });
  console.log(
    JSON.stringify(
      {
        passed: true,
        centerIdentity: app
          .prepare("SELECT identity FROM center_metadata WHERE id=1")
          .get().identity,
        originalWorkspace: Object.fromEntries(
          ["projects", "conversations", "inputs", "artifacts"].map((key) => [
            key,
            original[key].length,
          ]),
        ),
        appTables: appTables.map(({ additions, ...result }) => ({
          ...result,
          added: additions.length,
        })),
        workspaceDifferences,
        verifiedOriginalWindowActions: manualAcceptance,
        runtimeTables: runtimeTables.map(({ additions, ...result }) => ({
          ...result,
          added: additions.length,
        })),
        immutableHistoricalEvents: {
          ...events,
          additions: events.additions.length,
        },
        configurations,
        permissions: {
          identicalConfiguredControls: true,
          exactPolicyDigestsVerified: policyDigests,
          difference: "Protected executable and host manifest paths only",
        },
      },
      null,
      2,
    ),
  );
} finally {
  for (const db of [oldApp, app, oldRuntime, runtime]) close(db);
}
