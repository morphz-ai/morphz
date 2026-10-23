import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as portProbe } from "node:net";
import test from "node:test";
import { createAppServer } from "../apps/service/src/http.js";
import { DomainError, localAccess } from "../packages/core/src/model.js";
import { RuntimeConversationHistoryUnavailable } from "../packages/application/src/runtime.js";
import type { ExecutionActivity } from "../packages/core/src/conversation.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import {
  ActualMountedClient,
  mountedClientWebRoot,
} from "./fixtures/actual-mounted-client-test.js";

// Real React Client, HTTP Host, Platform grants and private SQLite. Dispatch is
// paused. Only the Runtime read authority's status/empty Scheduler is controlled;
// no model, original app, user database or tool execution is involved.
async function withClient(
  initiallyAvailable: boolean,
  run: (fixture: {
    client: ActualMountedClient;
    host: Awaited<ReturnType<typeof platformRuntimeHostFixture>>;
    activity(available: boolean): void;
    advanceHistoryAfterNavigation(): () => number;
    record(body: string): Promise<string>;
    schedulerReads: string[];
    historyAvailable(available: boolean): void;
    historyReads(): number;
    historyFailure(error: Error): void;
  }) => Promise<void>,
  options: { historyUnavailable?: boolean } = {},
) {
  const host = await platformRuntimeHostFixture();
  const web = await mountedClientWebRoot();
  let client: ActualMountedClient | undefined;
  let server: ReturnType<typeof createAppServer> | undefined;
  const internal = host.runtime as unknown as {
    state: {
      connected: boolean;
      activity: ExecutionActivity;
      deliveries: { state: string; rootId: string | null }[];
      sessions: Record<string, { cursor: number }>;
    };
    request(path: string, method?: string, body?: unknown): Promise<unknown>;
  };
  const schedulerReads: string[] = [];
  let advanceHistory = false,
    navigationReads = 0;
  let historyAvailable = !options.historyUnavailable;
  let historyReads = 0;
  let historyFailure: Error | undefined;
  const readHistory = host.runtime.platformConversationHistory.bind(
    host.runtime,
  );
  host.runtime.platformConversationHistory = async (...args) => {
    // Keep the real Platform grant and parsed history authority. Only an
    // already-authorized Runtime read's availability is controlled; the HTTP
    // Host serializes the production classified error, not fixture JSON.
    const value = await readHistory(...args);
    historyReads++;
    if (historyFailure) throw historyFailure;
    if (!historyAvailable)
      throw new RuntimeConversationHistoryUnavailable(
        new Error("TEST Runtime read unavailable"),
      );
    return value;
  };
  const readNavigation = host.runtime.platformNavigationSnapshot.bind(
    host.runtime,
  );
  host.runtime.platformNavigationSnapshot = (...args) => {
    const value = readNavigation(...args);
    if (advanceHistory) {
      navigationReads++;
      // The authority's opaque token genuinely changes between reads. No
      // response JSON, grant, body or delivery identity is manufactured.
      const session = Object.values(internal.state.sessions)[0];
      assert.ok(
        session,
        "this immutable input owns a registered Runtime Session",
      );
      session.cursor++;
    }
    return value;
  };
  const originalRequest = internal.request.bind(host.runtime);
  internal.request = async (path, method, body) => {
    assert.equal(
      method ?? "GET",
      "GET",
      "this regression never dispatches an outbox write",
    );
    if (path.includes("/scheduler?")) {
      schedulerReads.push(path);
      return {
        threads: [],
        objectives: [],
        schedules: [],
        detail_bounds: {
          limit: 200,
          has_more_threads: false,
          has_more_objectives: false,
        },
      };
    }
    if (path.startsWith("/api/delegations?"))
      return { delegations: [], has_more: false };
    return originalRequest(path, method, body);
  };
  const activity = (available: boolean) => {
    internal.state.connected = true;
    internal.state.activity = {
      available,
      truncated: false,
      openWorkComplete: available,
      threads: [],
      objectives: [],
      schedules: [],
      schedulesAvailable: available,
    };
  };
  try {
    const { dialogueId } = await host.session().ensurePlatformSpaces();
    const record = async (body: string) => {
      const commandId = randomUUID();
      await host.session().platformMessage({
        commandId,
        operation: {
          type: "record-input",
          projectId: host.projectId,
          conversationId: dialogueId,
          artifactId: null,
          artifactRevision: null,
          selection: "",
          body,
          targetActantId: "morphz-agent",
        },
      });
      return commandId;
    };
    await record("TEST first immutable input");
    activity(initiallyAvailable);
    const probe = portProbe();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    assert.notEqual(port, 65421);
    server = createAppServer(host.store, {
      runtime: host.runtime,
      platformWork: host.domains.work,
      platformDocuments: host.domains.content,
      platformScripts: host.domains.content,
      platformReader: host.domains.reader,
      messageAttachments: host.domains.messageAttachments,
      images: host.domains.images,
      bookmarkDomain: host.domains.browser,
      uiPackages: host.domains.uiPackages,
      notifications: host.domains.notifications,
      platformTaskRuns: host.domains.taskRuns(host.runtime),
      cognitiveApps: host.domains.cognitiveApps,
      port,
      webRoot: web.directory,
    });
    await new Promise<void>((resolve) =>
      server!.listen(port, "127.0.0.1", resolve),
    );
    client = await ActualMountedClient.open(`http://127.0.0.1:${port}`);
    await client.waitReady(localAccess.principalId);
    await client.call("refresh");
    assert.equal(
      (await client.snapshot())!.runtime.activity?.available,
      initiallyAvailable,
    );
    await run({
      client,
      host,
      activity,
      record,
      schedulerReads,
      historyAvailable(available) {
        historyAvailable = available;
      },
      historyReads() {
        return historyReads;
      },
      historyFailure(error) {
        historyFailure = error;
      },
      advanceHistoryAfterNavigation() {
        advanceHistory = true;
        return () => navigationReads;
      },
    });

    assert.ok(
      internal.state.deliveries.every(
        (delivery) => delivery.state === "queued" && delivery.rootId === null,
      ),
      "reads preserve original queued input identities without dispatch",
    );
    host.assertNoLegacyData();
  } finally {
    try {
      await client?.close();
    } finally {
      if (server) {
        server.closeStreams();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      web.close();
      await host.close();
    }
  }
}

for (const failure of ["forbidden", "invalid"] as const) {
  test(
    `actual Client never treats Platform ${failure} as unavailable Runtime history`,
    { timeout: 60_000 },
    async () => {
      await withClient(true, async ({ client, record, historyFailure }) => {
        const previous = (await client.snapshot())!;
        await record("TEST real invalidation before denied history read");
        historyFailure(new DomainError(failure, `TEST Platform ${failure}`));
        assert.equal(await client.call("refresh"), false);
        const report = await client.control("report");
        assert.equal(report.historyError, null);
        assert.match(report.error, new RegExp(`TEST Platform ${failure}`));
        if (failure === "forbidden")
          assert.equal(
            await client.snapshot(),
            null,
            "a denied grant clears protected history/catalog, never retains the old authorized page",
          );
        else
          assert.deepEqual(
            (await client.snapshot())!.workspace.inputs,
            previous.workspace.inputs,
            "invalid schema/arguments cannot certify or replace a fresh history window",
          );
        assert.equal(
          await client.page
            .getByRole("button", { name: "重试读取对话历史" })
            .count(),
          0,
        );
      });
    },
  );
}

test(
  "actual cold Client keeps authorized catalog usable when history is unavailable, visibly retries, and recovers a fresh head",
  { timeout: 60_000 },
  async () => {
    await withClient(
      true,
      async ({ client, historyAvailable, historyReads, record }) => {
        const cold = (await client.snapshot())!;
        assert.ok(
          cold.workspace.projects.length,
          "independently authorized catalog remains usable",
        );
        assert.equal(
          cold.workspace.inputs.length,
          0,
          "local queued inputs are not a certified latest Runtime page",
        );
        assert.equal(
          cold.runtime.connected,
          true,
          "history failure must not overwrite the final healthy status observation",
        );
        assert.match(cold.runtime.error!, /对话历史暂时无法读取/);
        const alert = client.page.getByRole("alert");
        await alert.waitFor({ state: "visible" });
        assert.match(await alert.innerText(), /对话历史暂时无法读取/);
        const readsBefore = historyReads();
        assert.equal(await client.call("refresh"), true);
        assert.ok(
          historyReads() > readsBefore,
          "unavailable history cannot install a successful reuse/version key",
        );
        historyAvailable(true);
        await client.page
          .getByRole("button", { name: "重试读取对话历史" })
          .click();
        await client.page.waitForFunction(
          () =>
            !Reflect.get(window, "actualMountedClient").report().historyError,
        );
        assert.equal(await alert.count(), 0);
        const recovered = (await client.snapshot())!;
        assert.equal(recovered.workspace.inputs.length, 1);
        assert.equal(
          recovered.workspace.inputs[0]!.body,
          "TEST first immutable input",
        );
        assert.equal(recovered.runtime.error, "");
        const localId = randomUUID();
        const input = recovered.workspace.inputs[0]!;
        const prefix = `morphz:${recovered.centerId}:${recovered.principalId}:${recovered.actantId}:saved-input:`;
        const operation = {
          type: "record-input",
          projectId: input.projectId,
          conversationId: input.conversationId,
          artifactId: input.artifactId,
          artifactRevision: input.artifactRevision,
          selection: input.selection,
          body: input.body,
          targetActantId: input.targetActantId,
        };
        const savedKeys = [
          { commandId: input.id, createdAt: input.createdAt, operation },
          {
            commandId: localId,
            createdAt: input.createdAt,
            operation: {
              ...operation,
              body: "TEST unsent original local draft",
            },
          },
        ].map((entry) => ({
          key: prefix + entry.commandId,
          raw: JSON.stringify(entry),
        }));
        // Only bounded string records cross Playwright's serialization boundary;
        // the complete Zod-derived Boot is neither cloned nor type-expanded.
        await client.page.evaluate((entries) => {
          for (const { key, raw } of entries) localStorage.setItem(key, raw);
        }, savedKeys);
        historyAvailable(false);
        await record(
          "TEST new head invalidation while Runtime history is unavailable",
        );
        assert.equal(await client.call("refresh"), true);
        assert.deepEqual(
          (await client.snapshot())!.workspace.inputs.filter(
            (input) => input.id !== localId,
          ),
          recovered.workspace.inputs,
          "same-scope old body survives a later failed head",
        );
        await alert.waitFor({ state: "visible" });
        assert.equal(await client.call("refresh"), true);
        assert.deepEqual(
          (await client.snapshot())!.workspace.inputs.filter(
            (input) => input.id !== localId,
          ),
          recovered.workspace.inputs,
          "repeated failures do not commit an empty cache over the old page",
        );
        assert.equal(
          (await client.snapshot())!.workspace.inputs.find(
            (input) => input.id === localId,
          )?.body,
          "TEST unsent original local draft",
        );
        const retainedStorage = await client.control("storage");
        for (const entry of savedKeys)
          assert.equal(
            retainedStorage[entry.key],
            entry.raw,
            "an unavailable head cannot confirm/delete either matching or still-unsent saved inputs",
          );
        historyAvailable(true);
        assert.equal(await client.call("refresh"), true);
        const confirmedStorage = await client.control("storage");
        assert.equal(
          confirmedStorage[savedKeys[0]!.key],
          undefined,
          "a truly fresh authorized head may confirm its exact saved input",
        );
        assert.equal(
          confirmedStorage[savedKeys[1]!.key],
          savedKeys[1]!.raw,
          "fresh head never consumes another unsent draft or dispatches it",
        );
      },
      { historyUnavailable: true },
    );
  },
);

for (const before of [false, true]) {
  test(
    `actual Client publishes the final same-history Runtime observation: ${before} → ${!before}`,
    { timeout: 60_000 },
    async () => {
      await withClient(!before, async ({ client, activity }) => {
        const originalInputs = (await client.snapshot())!.workspace.inputs;
        activity(before);
        const held = await client.hold("/api/platform/runtime-navigation");
        const pending = client.call("refresh");
        try {
          const response = await held.reached();
          assert.equal(response.value.runtime.activity.available, before);
          activity(!before);
        } finally {
          await held.release();
        }
        assert.equal(await pending, true);
        const snapshot = (await client.snapshot())!;
        assert.equal(
          snapshot.runtime.activity?.available,
          !before,
          "a completed older navigation must not overwrite the final authoritative read",
        );
        assert.deepEqual(
          snapshot.workspace.inputs,
          originalInputs,
          "same-history activity refresh never drops or rewrites inputs",
        );
      });
    },
  );
}

test(
  "actual Client rereads changed history before committing the final Runtime status",
  { timeout: 60_000 },
  async () => {
    await withClient(true, async ({ client, activity, record }) => {
      activity(false);
      const held = await client.hold("/api/platform/runtime-navigation");
      const pending = client.call("refresh");
      let newId = "";
      try {
        await held.reached();
        newId = await record("TEST second immutable input during navigation");
        activity(true);
      } finally {
        await held.release();
      }
      assert.equal(await pending, true);
      const snapshot = (await client.snapshot())!;
      assert.equal(snapshot.runtime.activity?.available, true);
      assert.equal(
        snapshot.workspace.inputs.find((input) => input.id === newId)?.body,
        "TEST second immutable input during navigation",
      );
      assert.equal(
        snapshot.workspace.inputs.filter(
          (input) => input.body === "TEST first immutable input",
        ).length,
        1,
      );
    });
  },
);

test(
  "explicit activity refresh verifies Scheduler once; ordinary workspace refresh does not dispatch or add Scheduler reads",
  { timeout: 60_000 },
  async () => {
    await withClient(false, async ({ client, schedulerReads }) => {
      assert.equal(schedulerReads.length, 0);
      await client.call("refresh");
      assert.equal(schedulerReads.length, 0);
      assert.equal(
        await client.call("refresh", [{ refreshActivity: true }]),
        true,
      );
      assert.equal(
        schedulerReads.length,
        2,
        "one active and one terminal bounded Scheduler read for this Context",
      );
      assert.equal(
        (await client.snapshot())!.runtime.activity?.available,
        true,
      );
      await client.call("refresh");
      assert.equal(
        schedulerReads.length,
        2,
        "ordinary refresh never becomes a forced Runtime polling loop",
      );
    });
  },
);

test(
  "continuously changing Runtime history exhausts only the existing two read retries and retains the previous coherent projection",
  { timeout: 60_000 },
  async () => {
    await withClient(
      true,
      async ({ client, activity, advanceHistoryAfterNavigation }) => {
        const previous = (await client.snapshot())!;
        activity(false);
        const reads = advanceHistoryAfterNavigation();
        assert.equal(await client.call("refresh"), false);
        assert.equal(
          reads(),
          6,
          "initial read and exactly two retries each have first/final observations",
        );
        const report = await client.control("report");
        assert.match(report.error, /会话在读取期间已更新/);
        assert.deepEqual(
          (await client.snapshot())!.workspace.inputs,
          previous.workspace.inputs,
        );
        assert.deepEqual(
          (await client.snapshot())!.runtime,
          previous.runtime,
          "an unproven version never partially replaces the last coherent Runtime/history projection",
        );
      },
    );
  },
);

test(
  "an explicit activity refresh queued during a workspace read is not lost or promoted into repeated forced polling",
  { timeout: 60_000 },
  async () => {
    await withClient(true, async ({ client, activity, schedulerReads }) => {
      activity(false);
      const held = await client.hold("/api/platform/runtime-navigation");
      const ordinary = client.call("refresh");
      let explicit = "";
      try {
        await held.reached();
        // start() confirms the actual method has entered the existing shared
        // drain without waiting for the held earlier native HTTP response.
        explicit = await client.start("refresh", [{ refreshActivity: true }]);
      } finally {
        await held.release();
      }
      assert.equal(await ordinary, true);
      assert.equal(await client.finish(explicit), true);
      assert.equal(schedulerReads.length, 2);
      assert.equal(
        (await client.snapshot())!.runtime.activity?.available,
        true,
      );
      await client.call("refresh");
      assert.equal(schedulerReads.length, 2);
    });
  },
);
