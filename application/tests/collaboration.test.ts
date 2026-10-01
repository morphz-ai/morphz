import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { Application } from "../packages/application/src/application.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { PlatformTaskRunDispatcher } from "../packages/application/src/platform-task-run-dispatcher.js";
import { localAccess } from "../packages/core/src/model.js";
import type { TaskRunAdmission } from "../packages/platform/src/task-run-admission.js";

test("Human 答复需要负责人身份和当前版本；实际 Agent 不可替人答复，依赖不能成环", async () => {
  const f = await agentDomainFixture();
  const create = async (assigneeId: string, dependsOnIds: string[] = []) => {
    const taskId = randomUUID();
    await f.withHuman((actor) =>
      f.domains.work.service.createTask(actor, {
        commandId: randomUUID(),
        taskId,
        projectId: f.projectId,
        title: "TEST 协作事项",
        assigneeId,
        dependsOnIds,
      }),
    );
    return taskId;
  };
  try {
    const id = await create(localAccess.actantId);
    const op = {
      commandId: randomUUID(),
      taskId: id,
      expectedRevision: 1,
      body: "可以继续",
    };
    await assert.rejects(
      f.withAgent((actor) => f.domains.work.service.respondTask(actor, op)),
      { code: "forbidden" },
    );
    const receipt = await f.withHuman((actor) =>
      f.domains.work.service.respondTask(actor, op),
    );
    assert.deepEqual(
      await f.withHuman((actor) =>
        f.domains.work.service.respondTask(actor, op),
      ),
      receipt,
    );
    assert.equal(
      (
        await f.withHuman((actor) =>
          f.domains.work.service.listTaskResponses(actor, {
            taskId: id,
            limit: 20,
          }),
        )
      ).length,
      1,
    );
    await assert.rejects(
      f.withHuman((actor) =>
        f.domains.work.service.respondTask(actor, {
          ...op,
          commandId: randomUUID(),
        }),
      ),
      { code: "conflict" },
    );
    const a = await create("morphz-agent"),
      b = await create("morphz-agent", [a]);
    await assert.rejects(
      f.withHuman((actor) =>
        f.domains.work.service.reviseTask(actor, {
          commandId: randomUUID(),
          taskId: a,
          expectedRevision: 1,
          title: "循环",
          dependsOnIds: [b],
        }),
      ),
      /循环/,
    );
    assert.equal(
      (
        await f.withHuman((actor) =>
          f.domains.work.service.taskVersion(actor, { taskId: a }),
        )
      ).revision,
      1,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

/** Only HTTP observations are controlled. Platform admission, authorization,
 * durable retry/CAS and RuntimeBridge protocol handling are the actual code. */
async function collaborationFixture(
  options: Parameters<typeof agentDomainFixture>[0] = {},
) {
  const f = await agentDomainFixture(options);
  const namespace = randomUUID();
  const contextId = `mw-context-${namespace}${f.identity ? `-${createHash("sha256").update(f.projectId).digest("hex").slice(0, 24)}` : ""}`;
  type Schedule = {
    id: string;
    revision: number;
    thread_id: string;
    source_turn_id: string;
    status: string;
    not_before: string;
    interval_seconds: number | null;
  };
  const records = new Map<string, Schedule>();
  const schedulePrincipals = new Map<string, string>();
  const requests = new Map<string, TaskRunAdmission["request"]>();
  const posted: TaskRunAdmission["request"][] = [];
  const threads = new Map<string, { revision: number; lifecycle: string }>();
  const sourceEvents = new Map<string, Record<string, unknown>>();
  const sourceThreads = new Map<
    string,
    {
      thread_id: string;
      root_turn_id: string;
      revision: number;
      lifecycle: string;
    }
  >();
  const jobs: Record<string, unknown>[] = [];
  const approvals: Record<string, unknown>[] = [];
  const tagged = (value: unknown): unknown =>
    value === null
      ? { type: "null" }
      : Array.isArray(value)
        ? { type: "array", value: value.map(tagged) }
        : typeof value === "object"
          ? {
              type: "object",
              value: Object.fromEntries(
                Object.entries(value!).map(([key, item]) => [
                  key,
                  tagged(item),
                ]),
              ),
            }
          : {
              type: typeof value,
              value: typeof value === "number" ? String(value) : value,
            };
  let loseAcknowledgement = true;
  let loseSourceAcknowledgement = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : null;
    const path = new URL(req.url!, "http://localhost").pathname;
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path === "/api/approvals") return send(200, { approvals });
    if (path === "/api/execution-jobs") {
      const query = new URL(req.url!, "http://localhost").searchParams;
      const threadId = query.get("thread_id");
      return send(200, {
        jobs: jobs
          .filter((job) => !threadId || job.thread_id === threadId)
          .slice(0, Number(query.get("limit") ?? 100)),
      });
    }
    const jobPath = /^\/api\/execution-jobs\/([^/]+)(\/result)?$/.exec(path);
    if (jobPath) {
      const job = jobs.find((item) => item.id === jobPath[1]);
      if (!job) return send(404, {});
      return send(
        200,
        jobPath[2]
          ? {
              job_id: job.id,
              event: {
                id: job.result_event_id,
                payload: {
                  session_id: job.session_id,
                  context_id: job.context_id,
                  text: `result:${job.id}`,
                },
              },
            }
          : job,
      );
    }
    const sessionEvent =
      /^\/api\/sessions\/collaboration-session\/events\/(.+)$/.exec(path);
    if (sessionEvent) {
      const event = [...sourceEvents.values()].find(
        (item) => item.id === sessionEvent[1],
      );
      return event ? send(200, { event }) : send(404, {});
    }
    const evidenceThread =
      /^\/api\/sessions\/collaboration-session\/threads\/(.+)$/.exec(path);
    if (evidenceThread) {
      const sourceThread = [...sourceThreads.values()].find(
        (item) => item.thread_id === evidenceThread[1],
      );
      if (sourceThread) {
        const event = [...sourceEvents.values()].find(
          (item) => item.id === sourceThread.root_turn_id,
        )!;
        return send(200, {
          snapshot: {
            thread: {
              id: sourceThread.thread_id,
              session_id: "collaboration-session",
              context_id: contextId,
              root_turn_id: sourceThread.root_turn_id,
              initiating_principal_id: (
                event.payload as Record<string, unknown>
              ).principal_id,
              agent_id: "morphz-agent",
              executor_kind: "agent",
              executor_id: null,
            },
          },
        });
      }
      return send(404, {});
    }
    if (path === "/api/sessions/collaboration-session")
      return send(200, {
        id: "collaboration-session",
        context_id: contextId,
      });
    if (
      path === "/api/sessions/collaboration-session/principal" &&
      req.method === "POST"
    )
      return send(200, { principal_id: req.headers["x-morphz-principal"] });
    const sourceLookup =
      /^\/api\/sessions\/collaboration-session\/messages\/by-client-id\/(.+)$/.exec(
        path,
      );
    if (sourceLookup)
      return sourceEvents.has(sourceLookup[1]!)
        ? send(200, { event: sourceEvents.get(sourceLookup[1]!) })
        : send(404, {});
    if (
      path === "/api/sessions/collaboration-session/io/messages" &&
      req.method === "POST"
    ) {
      assert.equal(body.message.format.id, "morphz.data");
      assert.equal(body.message.content.value.sender, "Morphz Application");
      const id = body.client_message_id;
      if (!sourceEvents.has(id)) {
        const destination = body.activation.input_destination;
        const eventId = `source-event-${id}`;
        sourceEvents.set(id, {
          id: eventId,
          actor: "Session-Client",
          type: "session_message",
          topic: destination ? "chat/steering" : "chat/user_message",
          payload: {
            session_id: "collaboration-session",
            context_id: contextId,
            principal_id:
              req.headers["x-morphz-principal"] ?? "runtime-default",
            client_message_id: id,
            root_turn_id: destination
              ? `client-schedule-${destination.thread_id.slice("thread-".length)}`
              : eventId,
            ...(destination
              ? {
                  thread_id: destination.thread_id,
                  thread_generation: destination.generation,
                }
              : {}),
            session_io: {
              request: {
                ...body,
                client_metadata: tagged(body.client_metadata),
                message: {
                  ...body.message,
                  content: {
                    ...body.message.content,
                    value: tagged(body.message.content.value),
                  },
                },
              },
            },
          },
        });
        if (!destination)
          sourceThreads.set(eventId, {
            thread_id: `source-thread-${id}`,
            root_turn_id: eventId,
            revision: 1,
            lifecycle: "open",
          });
      }
      if (loseSourceAcknowledgement) {
        loseSourceAcknowledgement = false;
        res.destroy();
        return;
      }
      return send(200, { accepted: true, event_id: sourceEvents.get(id)!.id });
    }
    if (
      path === "/api/sessions/collaboration-session/schedules" &&
      req.method === "POST"
    ) {
      const request = body as TaskRunAdmission["request"];
      posted.push(structuredClone(request));
      if (records.has(request.id))
        assert.deepEqual(request, requests.get(request.id));
      else {
        requests.set(request.id, structuredClone(request));
        schedulePrincipals.set(
          request.id,
          String(req.headers["x-morphz-principal"] ?? "runtime-default"),
        );
        records.set(request.id, {
          id: request.id,
          revision: 1,
          thread_id: `thread-${request.id}`,
          source_turn_id: `client-schedule-${request.id}`,
          status: "queued",
          not_before: request.not_before,
          interval_seconds: request.interval_seconds,
        });
        threads.set(request.id, { revision: 1, lifecycle: "open" });
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          res.destroy();
          return;
        }
      }
      return send(200, records.get(request.id));
    }
    const turn =
      /^\/api\/sessions\/collaboration-session\/turns\/client-schedule-(.+)\/thread$/.exec(
        path,
      );
    if (turn) {
      const schedule = records.get(turn[1]!);
      if (!schedule) return send(404, {});
      return send(200, {
        thread_id: schedule.thread_id,
        session_id: "collaboration-session",
        root_turn_id: schedule.source_turn_id,
        ...threads.get(turn[1]!),
      });
    }
    const sourceTurn =
      /^\/api\/sessions\/collaboration-session\/turns\/(source-event-.+)\/thread$/.exec(
        path,
      );
    if (sourceTurn)
      return sourceThreads.has(sourceTurn[1]!)
        ? send(200, {
            ...sourceThreads.get(sourceTurn[1]!),
            session_id: "collaboration-session",
          })
        : send(404, {});
    const sourceThread =
      /^\/api\/contexts\/[^/]+\/threads\/(source-thread-.+)$/.exec(path);
    if (sourceThread && req.method === "GET") {
      const thread = [...sourceThreads.values()].find(
        (item) => item.thread_id === sourceThread[1],
      );
      if (!thread) return send(404, {});
      return send(200, {
        snapshot: {
          thread: {
            id: thread.thread_id,
            session_id: "collaboration-session",
            context_id: contextId,
            root_turn_id: thread.root_turn_id,
          },
        },
      });
    }
    if (sourceThread && req.method === "POST") {
      const thread = [...sourceThreads.values()].find(
        (item) => item.thread_id === sourceThread[1],
      );
      if (!thread) return send(404, {});
      assert.equal(body.action, "cancel");
      assert.equal(body.expected_revision, thread.revision);
      thread.revision++;
      thread.lifecycle = "cancelled";
      return send(200, { updated: true });
    }
    const schedulePath =
      /^\/api\/sessions\/collaboration-session\/schedules\/(.+)$/.exec(path);
    if (schedulePath) {
      const record = records.get(schedulePath[1]!);
      if (!record) return send(404, {});
      if (req.method === "POST") {
        assert.equal(body.expected_revision, record.revision);
        record.revision++;
        record.status = (
          { pause: "paused", resume: "queued", cancel: "cancelled" } as Record<
            string,
            string
          >
        )[body.action]!;
      }
      return send(200, record);
    }
    const threadPath = /^\/api\/contexts\/[^/]+\/threads\/thread-(.+)$/.exec(
      path,
    );
    if (threadPath && req.method === "GET") {
      const thread = threads.get(threadPath[1]!)!;
      return send(200, {
        snapshot: {
          thread: {
            id: `thread-${threadPath[1]}`,
            session_id: "collaboration-session",
            context_id: contextId,
            initiating_principal_id: schedulePrincipals.get(threadPath[1]!),
            target_id: "original-target",
            root_turn_id: `client-schedule-${threadPath[1]}`,
            generation: 1,
            control_state: "active",
            ...thread,
          },
        },
      });
    }
    if (threadPath && req.method === "POST") {
      const thread = threads.get(threadPath[1]!)!;
      assert.equal(body.action, "cancel");
      assert.equal(body.expected_revision, thread.revision);
      thread.revision++;
      thread.lifecycle = "cancelled";
      return send(200, { updated: true });
    }
    return send(404, { path });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    namespace,
    token: "isolated-collaboration",
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    ...(f.identity ? { identityMode: "trusted_gateway" as const } : {}),
  };
  let runtime = new RuntimeBridge(f.transport, config, f.identity, false);
  await runtime.stop();
  let errors: unknown[] = [];
  const makeDispatcher = () =>
    new PlatformTaskRunDispatcher(
      f.domains.content.platform,
      f.transport.identity(),
      runtime,
      async () => localAccess,
      async (admission) =>
        f.withHuman((actor) =>
          f.domains.content.platform.prepareTaskRun(
            actor,
            admission.eventId,
            (ref) => runtime.taskRunStatusReader().inspect(ref, localAccess),
          ),
        ),
      (error) => errors.push(error),
      Date.now,
      {
        inspectTaskSourceDestination: (admission, ref, access) =>
          runtime.inspectTaskSourceDestination(admission, ref, access),
        reconcileTaskSourceEvent: (event, access) =>
          runtime.reconcileTaskSourceEvent(event, access),
        deliverTaskSource: (event, admission, access) =>
          runtime.deliverTaskSource(event, admission, access),
        stopTaskSource: (event, access) =>
          runtime.stopTaskSource(event, access),
        prepare: (run, destination) =>
          f.withHuman((actor) =>
            f.domains.content.platform.prepareTaskSourceEvent(
              actor,
              run,
              destination,
              f.domains.work.service.readWatchSource!,
            ),
          ),
        check: (run) =>
          f.withHuman((actor) =>
            f.domains.content.platform.assertTaskSourceDelivery(actor, run),
          ),
        attempt: (run, event) =>
          f.withHuman((actor) =>
            f.domains.content.platform.markTaskSourceDeliveryAttempt(
              actor,
              run,
              event,
            ),
          ),
      },
    );
  let dispatcher = makeDispatcher();
  const session = (access = localAccess) =>
    new Application(f.transport, {
      identity: f.identity,
      platformWork: f.domains.work,
      platformDocuments: f.domains.content,
      platformTaskRuns: {
        authority: f.domains.work.authority,
        store: f.domains.content.platform,
        runtimeStatus: runtime.taskRunStatusReader(),
      },
      runtime,
    }).session(access);
  const create = async (extra: Record<string, unknown> = {}) => {
    const taskId = randomUUID();
    await f.withHuman((actor) =>
      f.domains.work.service.createTask(actor, {
        commandId: randomUUID(),
        taskId,
        projectId: f.projectId,
        title: "TEST 持久协作",
        assigneeId: "morphz-agent",
        ...extra,
      }),
    );
    return taskId;
  };
  const start = (taskId: string, revision: number) =>
    f.withHuman(async (actor) => {
      const task = await f.domains.work.service.taskVersion(actor, {
        taskId,
        revision,
      });
      const priorRuntime =
        task.runRequested > 0
          ? await runtime.taskRunStatusReader().inspect(
              await f.domains.work.service.taskRunRuntimeRef(actor, {
                taskId,
                runNumber: task.runRequested,
              }),
              localAccess,
            )
          : undefined;
      return f.domains.work.service.requestTaskRun(
        actor,
        {
          commandId: randomUUID(),
          taskId,
          expectedRevision: revision,
          sessionId: "collaboration-session",
          intent: "TEST 持久安排",
          modelAlias: task.modelId,
          reasoningEffort: task.reasoningEffort,
          notBefore: "2026-09-26T12:00:00.000Z",
          intervalSeconds: task.everySeconds,
        },
        priorRuntime,
      );
    });
  const runs = (taskId: string) =>
    f.withHuman((actor) =>
      f.domains.work.service.listTaskRuns(actor, { taskId }),
    );
  return {
    f,
    create,
    start,
    session,
    runs,
    records,
    requests,
    posted,
    sourceEvents,
    sourceThreads,
    jobs,
    approvals,
    contextId,
    threads,
    loseNextSourceAcknowledgement() {
      loseSourceAcknowledgement = true;
    },
    get runtime() {
      return runtime;
    },
    get dispatcher() {
      return dispatcher;
    },
    get errors() {
      return errors;
    },
    async reopen() {
      await dispatcher.stop();
      await runtime.stop();
      await f.reopen();
      runtime = new RuntimeBridge(f.transport, config, f.identity, false);
      await runtime.stop();
      errors = [];
      dispatcher = makeDispatcher();
    },
    async close() {
      await dispatcher.stop();
      await runtime.stop();
      await f.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function backendCollaborationFixture(
  backend: "sqlite" | "postgres",
  identity = false,
) {
  const url = process.env.MORPHZ_TEST_POSTGRES_URL;
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const schemas = {
    objects: `o_${suffix}`,
    scriptStudio: `s_${suffix}`,
    reader: `r_${suffix}`,
    browser: `b_${suffix}`,
  };
  const platformSchema = `p_${suffix}`;
  const admin =
    backend === "postgres" ? new Pool({ connectionString: url }) : undefined;
  const storage = admin
    ? {
        platform: {
          kind: "postgres" as const,
          connectionString: url!,
          schema: platformSchema,
        },
        applications: {
          connectionStrings: {
            objects: url!,
            scriptStudio: url!,
            reader: url!,
            browser: url!,
          },
          deploymentId: `source_${suffix}`,
          schemas,
        },
      }
    : undefined;
  if (admin)
    for (const schema of [platformSchema, ...Object.values(schemas)])
      await admin.query(`CREATE SCHEMA "${schema}"`);
  try {
    const c = await collaborationFixture({
      ...(identity
        ? {
            additionalHumans: [
              {
                principalId: "other-source-human",
                actantId: "other-source-actant",
              },
            ],
          }
        : {}),
      ...(storage ? { storage } : {}),
    });
    return {
      ...c,
      get dispatcher() {
        return c.dispatcher;
      },
      get runtime() {
        return c.runtime;
      },
      get errors() {
        return c.errors;
      },
      async openPeer() {
        // Independent Host and PlatformStore pools/gates, same authenticated
        // center and isolated schema. This is not one store's serial queue.
        const transport = new WorkspaceStore(
          join(c.f.directory, "workspace.sqlite"),
          { mode: "transport" },
        );
        const configuration = {
          version: 1,
          members: [
            localAccess,
            {
              principalId: "other-source-human",
              actantId: "other-source-actant",
            },
          ].map((human) => ({
            ...human,
            loginTokenHash: createHash("sha256")
              .update(`synthetic-login-${human.principalId}`)
              .digest("hex"),
            enabled: true,
          })),
        };
        const peerIdentity = identity
          ? new IdentityCenter(transport, configuration)
          : undefined;
        const domains = await openApplicationDomainsHost(
          c.f.directory,
          transport,
          peerIdentity,
          storage,
        );
        return {
          platform: domains.content.platform,
          human: <T>(work: Parameters<typeof c.f.withHuman<T>>[0]) =>
            domains.work.authority.withSession(localAccess, () => {}, work),
          async close() {
            await domains.close();
            transport.close();
          },
        };
      },
      async close() {
        await c.close();
        if (admin) {
          for (const schema of [platformSchema, ...Object.values(schemas)])
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          await admin.end();
        }
      },
    };
  } catch (error) {
    if (admin) {
      for (const schema of [platformSchema, ...Object.values(schemas)])
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
    throw error;
  }
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: 执行详情归属原run的完整来源root，停止和移项目后保留历史且重查两处权限`,
    { skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL },
    async () => {
      const c = await backendCollaborationFixture(backend, true),
        f = c.f;
      try {
        const source = await c.session().createPlatformDocument({
          commandId: randomUUID(),
          objectId: randomUUID(),
          projectId: f.projectId,
          title: "TEST 来源详情归属",
          markdown: "v1",
        });
        const work = await c.create({ watchSourceIds: [source.contentId] });
        const foreign = await c.create({ watchSourceIds: [source.contentId] });
        const original = await c.start(work, 1),
          other = await c.start(foreign, 1);
        await c.dispatcher.drain();
        await c.reopen();
        await c.dispatcher.drain();
        for (const admission of [original, other]) {
          c.records.get(admission.request.id)!.status = "completed";
          c.threads.get(admission.request.id)!.lifecycle = "completed";
        }
        await c.session().revisePlatformDocument({
          commandId: randomUUID(),
          contentId: source.contentId,
          expectedRevision: 1,
          title: "TEST 来源详情归属",
          markdown: "v2",
        });
        await c.dispatcher.drain();
        const platform = f.domains.content.platform;
        const own = (
            await platform.taskRunSourceEvents(f.transport.identity(), work, 1)
          )[0]!,
          elsewhere = (
            await platform.taskRunSourceEvents(
              f.transport.identity(),
              foreign,
              1,
            )
          )[0]!;
        for (const item of [own, elsewhere]) {
          const threadId = item.receipt!.threadId!,
            rootId = item.receipt!.rootId;
          c.jobs.push({
            id: `job-${item.event.taskId}`,
            revision: 1,
            session_id: original.sessionId,
            context_id: c.contextId,
            tool_name: "host_morphz",
            target_id: "original-target",
            thread_id: threadId,
            status: "succeeded",
            created_at: "2026-09-30T12:00:00Z",
            updated_at: "2026-09-30T12:00:00Z",
            request: { action: "read" },
            result_event_id: `result-${item.event.taskId}`,
          });
          c.approvals.push({
            requested_at: "2026-09-30T12:00:00Z",
            request: {
              approval_id: `approval-${item.event.taskId}`,
              session_id: original.sessionId,
              context_id: c.contextId,
              root_turn_id: rootId,
              thread_id: threadId,
              justification: "真实Runtime审批DTO归属",
              action: {},
              requested: {},
            },
          });
        }
        const link = (await c.runs(work))[0]!;
        await assert.rejects(
          f.withHuman((actor) =>
            platform.reviseTask(
              actor,
              {
                commandId: randomUUID(),
                taskId: work,
                expectedRevision: 2,
                assigneeId: localAccess.actantId,
              },
              (ref) =>
                c.runtime.taskRunStatusReader().inspect(ref, localAccess),
            ),
          ),
          /先停止/,
          "原Thread终态不能掩盖仍开放的source follow-up",
        );
        await assert.rejects(
          c.start(work, 2),
          /尚未|先停止/,
          "再次执行不能只依据原Thread终态覆盖仍活跃的source root",
        );
        const scope = {
          projectId: f.projectId,
          artifactId: work,
          threadId: link.runtime.threadId,
          taskRun: true as const,
        };
        const snapshot = await c.session().executionSnapshot(scope);
        assert.deepEqual(
          snapshot.jobs.map((job) => job.id),
          [`job-${work}`],
        );
        assert.deepEqual(
          snapshot.approvals.map((item) => item.request.approval_id),
          [`approval-${work}`],
        );
        const foreignJob = c.jobs.find((job) => job.id === `job-${foreign}`)!;
        c.jobs.unshift(
          ...Array.from({ length: 105 }, (_, index) => ({
            ...foreignJob,
            id: `foreign-newest-${index}`,
            created_at: "2026-10-01T12:00:00Z",
          })),
        );
        assert.deepEqual(
          (await c.session().executionSnapshot(scope)).jobs.map(
            (job) => job.id,
          ),
          [`job-${work}`],
          "其他run 100条较新jobs不能挤掉原run历史",
        );
        assert.equal(
          (await c.session().executionResult({ scope, jobId: `job-${work}` }))
            .text,
          `result:job-${work}`,
        );
        await assert.rejects(
          c.session().executionResult({ scope, jobId: `job-${foreign}` }),
          /不属于/,
        );
        const accepted = c.sourceEvents.get(own.event.eventId)!;
        const pristine = structuredClone(accepted);
        (
          accepted.payload as {
            session_io: { request: { activation: { target_id: string } } };
          }
        ).session_io.request.activation.target_id = "forged-target";
        assert.equal(
          (await c.session().executionSnapshot(scope)).jobs.length,
          0,
          "不能凭metadata让完整请求不匹配的source root入详情",
        );
        c.sourceEvents.set(own.event.eventId, pristine);
        await f.withHuman((actor) =>
          f.domains.work.service.controlTaskRun(actor, {
            taskId: work,
            runNumber: 1,
            controlRevision: link.bridge.controlRevision,
            action: "stop",
          }),
        );
        await c.dispatcher.drain();
        await c.reopen();
        assert.deepEqual(
          (await c.session().executionSnapshot(scope)).jobs.map(
            (job) => job.id,
          ),
          [`job-${work}`],
          "stop后只读不复用新Agent工作的stop-denying授权",
        );
        const rerun = await c.start(work, 2);
        await c.dispatcher.drain();
        const latest = (await c.runs(work))[0]!;
        assert.equal(latest.runNumber, 2);
        assert.equal(
          (
            await c.session().executionSnapshot({
              ...scope,
              threadId: latest.runtime.threadId,
            })
          ).jobs.length,
          0,
          "同事项新run不能吸入旧run source历史",
        );
        await f.withHuman((actor) =>
          f.domains.work.service.controlTaskRun(actor, {
            taskId: work,
            runNumber: 2,
            controlRevision: latest.bridge.controlRevision,
            action: "stop",
          }),
        );
        await c.dispatcher.drain();
        assert.notEqual(rerun.request.id, original.request.id);
        for (const projectId of [
          "source-history-moved",
          "source-history-unrelated",
        ])
          await f.withHuman((actor) =>
            f.domains.work.service.createProject(actor, {
              commandId: randomUUID(),
              projectId,
              title: `TEST ${projectId}`,
            }),
          );
        const viewer = {
          principalId: "other-source-human",
          actantId: "other-source-actant",
        };
        await f.domains.content.platform.reconcileOperatorMembers(
          f.transport.identity(),
          [
            { ...localAccess, projectIds: [], enabled: true },
            {
              ...viewer,
              projectIds: [
                f.projectId,
                "source-history-moved",
                "source-history-unrelated",
              ],
              enabled: true,
            },
          ],
        );
        await c.session().revisePlatformTask({
          commandId: randomUUID(),
          taskId: work,
          expectedRevision: 3,
          watchSourceIds: [],
        });
        await c.session().revisePlatformTask({
          commandId: randomUUID(),
          taskId: work,
          expectedRevision: 4,
          projectId: "source-history-moved",
        });
        for (const projectId of [f.projectId, "source-history-moved"]) {
          const movedScope = { ...scope, projectId };
          assert.deepEqual(
            (await c.session().executionSnapshot(movedScope)).jobs.map(
              (job) => job.id,
            ),
            [`job-${work}`],
            "两个实际UI selector均保持原准入Context",
          );
          const ref = await f.withHuman((actor) =>
            f.domains.content.platform.taskRunExecutionRef(
              actor,
              work,
              projectId,
              link.runtime.threadId,
            ),
          );
          assert.equal(ref.projectId, f.projectId);
          assert.ok(
            await f.withHuman((actor) =>
              f.domains.content.platform.taskRunSourceEventForExecution(
                actor,
                work,
                projectId,
                ref,
                own.event.eventId,
              ),
            ),
          );
          assert.equal(
            await f.withHuman((actor) =>
              f.domains.content.platform.taskRunSourceEventForExecution(
                actor,
                work,
                projectId,
                ref,
                elsewhere.event.eventId,
              ),
            ),
            null,
          );
        }
        await assert.rejects(
          c.session().executionSnapshot({
            ...scope,
            projectId: "source-history-unrelated",
          }),
          /不属于/,
        );
        assert.deepEqual(
          (
            await c.session(viewer).executionSnapshot({
              ...scope,
              projectId: "source-history-moved",
            })
          ).jobs.map((job) => job.id),
          [`job-${work}`],
        );
        await f.domains.content.platform.reconcileOperatorMembers(
          f.transport.identity(),
          [
            {
              ...localAccess,
              projectIds: ["source-history-moved", "source-history-unrelated"],
              enabled: true,
            },
            {
              ...viewer,
              projectIds: ["source-history-moved", "source-history-unrelated"],
              enabled: true,
            },
          ],
        );
        await assert.rejects(
          c
            .session(viewer)
            .executionSnapshot({ ...scope, projectId: "source-history-moved" }),
          /无权/,
          "失去原项目读权不能仅凭当前项目读权取得历史",
        );
      } finally {
        await c.close();
      }
    },
  );

  test(
    `${backend}: 旧run超过100条来源事件不遮盖当前run，停止逐页覆盖每个接续Thread`,
    { skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL },
    async () => {
      const c = await backendCollaborationFixture(backend),
        f = c.f;
      try {
        const source = await c.session().createPlatformDocument({
          commandId: randomUUID(),
          objectId: randomUUID(),
          projectId: f.projectId,
          title: "TEST 来源历史分页",
          markdown: "v1",
        });
        const work = await c.create({ watchSourceIds: [source.contentId] });
        const original = await c.start(work, 1);
        await c.dispatcher.drain();
        await c.reopen();
        await c.dispatcher.drain();
        c.records.get(original.request.id)!.status = "completed";
        c.threads.get(original.request.id)!.lifecycle = "completed";
        for (let revision = 1; revision <= 104; revision++) {
          await c.session().revisePlatformDocument({
            commandId: randomUUID(),
            contentId: source.contentId,
            expectedRevision: revision,
            title: "TEST 来源历史分页",
            markdown: `v${revision + 1}`,
          });
          await c.dispatcher.drain();
        }
        assert.equal(c.sourceEvents.size, 104);
        const oldFirst = await f.domains.content.platform.taskRunSourceEvents(
          f.transport.identity(),
          work,
          1,
        );
        assert.equal(oldFirst.length, 100);
        assert.equal(
          (
            await f.domains.content.platform.taskRunSourceEvents(
              f.transport.identity(),
              work,
              1,
              oldFirst.at(-1)!.event.eventId,
            )
          ).length,
          4,
        );
        const stop = async (runNumber: number) => {
          const link = (await c.runs(work)).find(
            (run) => run.runNumber === runNumber,
          )!;
          await f.withHuman((actor) =>
            f.domains.work.service.controlTaskRun(actor, {
              taskId: work,
              runNumber,
              controlRevision: link.bridge.controlRevision,
              action: "stop",
            }),
          );
          await c.dispatcher.drain();
          assert.equal(
            (await c.runs(work)).find((run) => run.runNumber === runNumber)!
              .bridge.stopRequested,
            false,
          );
        };
        await stop(1);
        assert.equal(
          [...c.sourceThreads.values()].filter(
            (thread) => thread.lifecycle === "cancelled",
          ).length,
          104,
        );
        const prior = await c.runtime
          .taskRunStatusReader()
          .inspect((await c.runs(work))[0]!.runtime, localAccess);
        const next = await f.withHuman((actor) =>
          f.domains.work.service.requestTaskRun(
            actor,
            {
              commandId: randomUUID(),
              taskId: work,
              expectedRevision: 2,
              sessionId: "collaboration-session",
              intent: "TEST 来源历史新run",
              notBefore: original.request.not_before,
            },
            prior,
          ),
        );
        await c.dispatcher.drain();
        c.records.get(next.request.id)!.status = "completed";
        c.threads.get(next.request.id)!.lifecycle = "completed";
        await c.session().revisePlatformDocument({
          commandId: randomUUID(),
          contentId: source.contentId,
          expectedRevision: 105,
          title: "TEST 来源历史分页",
          markdown: "v106",
        });
        await c.dispatcher.drain();
        assert.equal(c.sourceEvents.size, 105);
        // Regardless of UUID ordering, a LIMIT-before-run-filter query either
        // loses the current event or incorrectly shortens the old 100-row page.
        assert.equal(
          (
            await f.domains.content.platform.taskRunSourceEvents(
              f.transport.identity(),
              work,
              1,
            )
          ).length,
          100,
        );
        const current = await f.domains.content.platform.taskRunSourceEvents(
          f.transport.identity(),
          work,
          2,
        );
        assert.equal(current.length, 1);
        assert.equal(current[0]!.event.runNumber, 2);
        await stop(2);
        assert.equal(
          [...c.sourceThreads.values()].filter(
            (thread) => thread.lifecycle === "cancelled",
          ).length,
          105,
        );
        assert.equal(
          c.records.size,
          2,
          "只有Human准入创建Schedule，来源变化不新增Schedule",
        );
        assert.equal(c.errors.length, 0);
      } finally {
        await c.close();
      }
    },
  );

  test(
    `${backend}: 来源使用当前安排、精确版本；暂停合并、终态接续、丢回执恢复、停止全部接续`,
    { skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL },
    async () => {
      const c = await backendCollaborationFixture(backend),
        f = c.f;
      try {
        const source = await c.session().createPlatformDocument({
          commandId: randomUUID(),
          objectId: randomUUID(),
          projectId: f.projectId,
          title: "TEST 来源生命周期",
          markdown: "v1",
        });
        const work = await c.create({ watchSourceIds: [source.contentId] });
        const admission = await c.start(work, 1);
        await c.dispatcher.drain();
        await c.reopen();
        await c.dispatcher.drain();
        const record = c.records.get(admission.request.id)!;
        let revision = 1;
        const revise = async () => {
          const commandId = randomUUID();
          await c.session().revisePlatformDocument({
            commandId,
            contentId: source.contentId,
            expectedRevision: revision++,
            title: "TEST 来源生命周期",
            markdown: `v${revision}`,
          });
          return commandId;
        };
        const command2 = await revise();
        await c.dispatcher.drain();
        assert.equal(
          c.sourceEvents.size,
          0,
          "queued 的真实安排不能被来源触发绕过",
        );
        record.status = "dispatched";
        record.not_before = "2099-01-01T00:00:00.000Z";
        await c.dispatcher.drain();
        assert.equal(
          c.sourceEvents.size,
          0,
          "Runtime 更新后的实际到期时间优先于原准入时间",
        );
        record.not_before = admission.request.not_before;
        await c.dispatcher.drain();
        await c.dispatcher.drain();
        assert.equal(c.sourceEvents.size, 1);
        const first = (
          await f.domains.content.platform.taskRunSourceEvents(
            f.transport.identity(),
            work,
            1,
          )
        )[0]!;
        assert.deepEqual(first.event.sourceCommandIds, [command2]);
        assert.equal(first.event.sources[0]!.versionRef, "2");
        assert.equal(first.event.destination.kind, "thread");
        assert.equal(
          first.receipt!.rootId,
          `client-schedule-${admission.request.id}`,
        );
        c.threads.get(admission.request.id)!.lifecycle = "completed";
        record.status = "completed";
        const control = async (
          action: "pause" | "resume" | "stop",
          drain = true,
        ) => {
          const [run] = await c.runs(work);
          await f.withHuman((actor) =>
            f.domains.work.service.controlTaskRun(actor, {
              taskId: work,
              runNumber: 1,
              controlRevision: run!.bridge.controlRevision,
              action,
            }),
          );
          if (drain) await c.dispatcher.drain();
        };
        await control("pause");
        const beforePause = (await c.runs(work))[0]!.bridge.sourceSignature;
        await revise();
        const command4 = await revise();
        await c.dispatcher.drain();
        await c.reopen();
        await c.dispatcher.drain();
        assert.equal(c.sourceEvents.size, 1);
        assert.equal(
          (await c.runs(work))[0]!.bridge.sourceSignature,
          beforePause,
        );
        await control("resume");
        assert.equal(c.sourceEvents.size, 2, "恢复只合并为最新精确版本一次");
        const followup = (
          await f.domains.content.platform.taskRunSourceEvents(
            f.transport.identity(),
            work,
            1,
          )
        ).find((item) => item.event.sources[0]!.versionRef === "4")!;
        assert.equal(followup.event.destination.kind, "follow-up");
        assert.equal(
          (followup.event.request.activation as { target_id: unknown })
            .target_id,
          "original-target",
        );
        assert.deepEqual(followup.event.sourceCommandIds, [command4]);
        const command5 = await revise();
        c.loseNextSourceAcknowledgement();
        await c.dispatcher.drain();
        assert.equal(c.sourceEvents.size, 3);
        const unknown = (
          await f.domains.content.platform.taskRunSourceEvents(
            f.transport.identity(),
            work,
            1,
          )
        ).find((item) => item.event.sources[0]!.versionRef === "5")!;
        assert.equal(unknown.receipt, null);
        assert.equal(unknown.deliveryAttempted, true);
        await c.reopen();
        await c.dispatcher.drain();
        assert.equal(
          c.sourceEvents.size,
          3,
          "同原client ID核对，不能重建事件或新的Schedule",
        );
        assert.ok(
          (await c.runs(work))[0]!.bridge.sourceCommandIds.includes(command5),
        );
        await control("stop");
        assert.equal((await c.runs(work))[0]!.bridge.stopRequested, false);
        assert.ok(
          [...c.sourceThreads.values()].every(
            (thread) => thread.lifecycle === "cancelled",
          ),
        );
        await revise();
        await c.reopen();
        await c.dispatcher.drain();
        assert.equal(c.sourceEvents.size, 3);
        assert.equal(c.records.size, 1);
        assert.equal(
          f.transport.runtimeState(),
          null,
          "没有伪造Human输入或消息存储",
        );
        assert.equal(c.errors.length, 0);
      } finally {
        await c.close();
      }
    },
  );

  test(
    `${backend}: 未接收冻结事件、控制修订与多Host未知POST不能相互清除；撤权阻断新投递`,
    { skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL },
    async () => {
      const c = await backendCollaborationFixture(backend, true),
        f = c.f;
      try {
        const source = await c.session().createPlatformDocument({
          commandId: randomUUID(),
          objectId: randomUUID(),
          projectId: f.projectId,
          title: "TEST 来源控制边界",
          markdown: "v1",
        });
        const work = await c.create({ watchSourceIds: [source.contentId] });
        const admission = await c.start(work, 1);
        await c.dispatcher.drain();
        await c.reopen();
        await c.dispatcher.drain();
        const record = c.records.get(admission.request.id)!;
        assert.ok(record, c.errors.map(String).join("\n"));
        record.status = "completed";
        c.threads.get(admission.request.id)!.lifecycle = "completed";
        await c.session().revisePlatformDocument({
          commandId: randomUUID(),
          contentId: source.contentId,
          expectedRevision: 1,
          title: "TEST 来源控制边界",
          markdown: "v2",
        });
        const platform = f.domains.content.platform;
        const run = (
          await platform.watchedTaskRuns(f.transport.identity())
        )[0]!;
        const destination = await c.runtime.inspectTaskSourceDestination(
          run.admission,
          run.runtime,
          localAccess,
        );
        const event = await f.withHuman((actor) =>
          platform.prepareTaskSourceEvent(
            actor,
            run,
            destination!,
            f.domains.work.service.readWatchSource!,
          ),
        );
        assert.ok(event);
        await platform.discardUnacceptedTaskSourceEvent(
          f.transport.identity(),
          event,
        );
        for (const action of ["pause", "resume"] as const) {
          const [link] = await c.runs(work);
          await f.withHuman((actor) =>
            f.domains.work.service.controlTaskRun(actor, {
              taskId: work,
              runNumber: 1,
              controlRevision: link!.bridge.controlRevision,
              action,
            }),
          );
          // Actual Runtime control and Platform acknowledgement, without running
          // the source producer in between this boundary test's two controls.
          const [pending] = await platform.pendingTaskRunScheduleControls(
            f.transport.identity(),
          );
          const result = await c.runtime.controlPlatformTaskRunSchedule(
            pending!,
            run.admission,
            localAccess,
          );
          await platform.confirmTaskRunScheduleControl(
            f.transport.identity(),
            pending!,
            result.observation,
            result.error,
          );
        }
        const current = (
          await platform.watchedTaskRuns(f.transport.identity())
        )[0]!;
        const next = await f.withHuman((actor) =>
          platform.prepareTaskSourceEvent(
            actor,
            current,
            destination!,
            f.domains.work.service.readWatchSource!,
          ),
        );
        assert.ok(next);
        assert.notEqual(
          next.eventId,
          event.eventId,
          "不能复用已discard的旧控制修订事件",
        );
        await f.withHuman((actor) =>
          f.domains.work.service.createProject(actor, {
            commandId: randomUUID(),
            projectId: "source-moved-project",
            title: "TEST 来源新归属",
          }),
        );
        await f.withHuman((actor) =>
          platform.moveContent(actor, {
            commandId: randomUUID(),
            contentId: source.contentId,
            expectedRevision: 2,
            targetProjectId: "source-moved-project",
          }),
        );
        await assert.rejects(
          f.withHuman((actor) =>
            platform.markTaskSourceDeliveryAttempt(actor, current, next),
          ),
          /所属项目|归属|来源/,
        );
        await f.withHuman((actor) =>
          platform.moveContent(actor, {
            commandId: randomUUID(),
            contentId: source.contentId,
            expectedRevision: 3,
            targetProjectId: f.projectId,
          }),
        );
        const peer = await c.openPeer();
        let frozenEvent = next;
        let currentRun = current;
        let attempts: string[];
        try {
          const [mark, discard] = await Promise.allSettled([
            f.withHuman((actor) =>
              platform.markTaskSourceDeliveryAttempt(actor, current, next),
            ),
            peer.platform.discardUnacceptedTaskSourceEvent(
              f.transport.identity(),
              next,
            ),
          ]);
          assert.equal(
            [mark, discard].filter((result) => result.status === "fulfilled")
              .length,
            1,
            "mark与discard必须同一精确行互斥，不能同时成功",
          );
          if (mark.status === "fulfilled") {
            assert.equal(
              (
                await peer.platform.taskRunSourceEvents(
                  f.transport.identity(),
                  work,
                  1,
                )
              ).find((item) => item.event.eventId === next.eventId)!
                .deliveryAttempted,
              true,
            );
            await platform.clearRejectedTaskSourceAttempt(
              f.transport.identity(),
              next,
              mark.value,
            );
            await peer.platform.discardUnacceptedTaskSourceEvent(
              f.transport.identity(),
              next,
            );
          }
          for (const action of ["pause", "resume"] as const) {
            const [link] = await c.runs(work);
            await f.withHuman((actor) =>
              f.domains.work.service.controlTaskRun(actor, {
                taskId: work,
                runNumber: 1,
                controlRevision: link!.bridge.controlRevision,
                action,
              }),
            );
            const [pending] = await platform.pendingTaskRunScheduleControls(
              f.transport.identity(),
            );
            const result = await c.runtime.controlPlatformTaskRunSchedule(
              pending!,
              run.admission,
              localAccess,
            );
            await platform.confirmTaskRunScheduleControl(
              f.transport.identity(),
              pending!,
              result.observation,
              result.error,
            );
          }
          currentRun = (
            await platform.watchedTaskRuns(f.transport.identity())
          )[0]!;
          frozenEvent = (await f.withHuman((actor) =>
            platform.prepareTaskSourceEvent(
              actor,
              currentRun,
              destination!,
              f.domains.work.service.readWatchSource!,
            ),
          ))!;
          attempts = await Promise.all([
            f.withHuman((actor) =>
              platform.markTaskSourceDeliveryAttempt(
                actor,
                currentRun,
                frozenEvent,
              ),
            ),
            peer.human((actor) =>
              peer.platform.markTaskSourceDeliveryAttempt(
                actor,
                currentRun,
                frozenEvent,
              ),
            ),
          ]);
          await peer.platform.clearRejectedTaskSourceAttempt(
            f.transport.identity(),
            frozenEvent,
            attempts[1]!,
          );
          assert.equal(
            (
              await platform.taskRunSourceEvents(
                f.transport.identity(),
                work,
                1,
              )
            ).find((item) => item.event.eventId === frozenEvent.eventId)!
              .deliveryAttempted,
            true,
            "重放Host的拒绝不能清掉另一Host的未知请求",
          );
        } finally {
          await peer.close();
        }
        const attempt = attempts[0]!;
        assert.equal(
          attempts[1],
          attempt,
          "另一Host仅能重放同一client ID/token，未知集合不会膨胀",
        );
        await platform.clearRejectedTaskSourceAttempt(
          f.transport.identity(),
          frozenEvent,
          randomUUID(),
        );
        assert.equal(
          (
            await platform.taskRunSourceEvents(f.transport.identity(), work, 1)
          ).find((item) => item.event.eventId === frozenEvent.eventId)!
            .deliveryAttempted,
          true,
        );
        await assert.rejects(
          platform.discardUnacceptedTaskSourceEvent(
            f.transport.identity(),
            frozenEvent,
          ),
          /尚未核对/,
        );
        // Fault injection: commit the send attempt, crash before its POST. A
        // real Runtime 404 after reopen cannot prove this packet never existed.
        await assert.rejects(
          c.start(work, 2),
          /尚未|先停止/,
          "未知来源POST不能被原Thread终态覆盖成下一run",
        );
        await assert.rejects(
          f.withHuman((actor) =>
            platform.reviseTask(
              actor,
              {
                commandId: randomUUID(),
                taskId: work,
                expectedRevision: 2,
                assigneeId: localAccess.actantId,
              },
              (ref) =>
                c.runtime.taskRunStatusReader().inspect(ref, localAccess),
            ),
          ),
          /先停止/,
          "未知来源POST必须停止核对后才可改派",
        );
        const frozen = JSON.stringify(frozenEvent.request);
        await c.reopen();
        const reopened = f.domains.content.platform;
        const [link] = await c.runs(work);
        await f.withHuman((actor) =>
          f.domains.work.service.controlTaskRun(actor, {
            taskId: work,
            runNumber: 1,
            controlRevision: link!.bridge.controlRevision,
            action: "stop",
          }),
        );
        await c.dispatcher.drain();
        assert.equal((await c.runs(work))[0]!.bridge.stopRequested, true);
        assert.equal(c.sourceEvents.size, 0, "停止不能为核对而制造新的root");
        const persisted = (
          await reopened.taskRunSourceEvents(f.transport.identity(), work, 1)
        ).find((item) => item.event.eventId === frozenEvent.eventId)!;
        assert.equal(persisted.deliveryAttempted, true);
        assert.equal(JSON.stringify(persisted.event.request), frozen);
        await assert.rejects(
          c.session().revisePlatformTask({
            commandId: randomUUID(),
            taskId: work,
            expectedRevision: 2,
            assigneeId: localAccess.actantId,
          }),
          /先停止|待确认|结束|在途/,
        );
        // One Host's non-acceptance cannot clear the other unknown POST.
        await reopened.clearRejectedTaskSourceAttempt(
          f.transport.identity(),
          frozenEvent,
          attempt,
        );
        assert.equal(
          (
            await reopened.taskRunSourceEvents(f.transport.identity(), work, 1)
          ).find((item) => item.event.eventId === frozenEvent.eventId)!
            .deliveryAttempted,
          true,
        );
        await assert.rejects(
          reopened.discardUnacceptedTaskSourceEvent(
            f.transport.identity(),
            frozenEvent,
          ),
          /尚未核对/,
        );
        const members = [
          localAccess,
          {
            principalId: "other-source-human",
            actantId: "other-source-actant",
          },
        ].map((human) => ({
          ...human,
          loginTokenHash: createHash("sha256")
            .update(`synthetic-login-${human.principalId}`)
            .digest("hex"),
          enabled: human.principalId !== localAccess.principalId,
        }));
        await f.identity!.replaceConfiguration({ version: 1, members });
        await c.dispatcher.drain();
        assert.equal(c.sourceEvents.size, 0);
        await assert.rejects(
          f.withHuman((actor) =>
            reopened.prepareTaskSourceEvent(
              actor,
              currentRun,
              destination!,
              f.domains.work.service.readWatchSource!,
            ),
          ),
          /身份|授权|权限/,
        );
      } finally {
        await c.close();
      }
    },
  );
}

test("事项实际持久准入：人工前置答复、独立模型、丢回执重启、暂停恢复、停止改派和递增复派", async () => {
  const c = await collaborationFixture(),
    f = c.f;
  try {
    const human = await c.create({ assigneeId: localAccess.actantId });
    const work = await c.create({
      modelId: "exact-model",
      reasoningEffort: "high",
      dependsOnIds: [human],
      everySeconds: 60,
    });
    const admission = await c.start(work, 1);
    await c.dispatcher.drain();
    assert.equal(c.records.size, 0);
    assert.equal(c.errors.length, 0, "未完成的前置事项是等待，不是传输错误");
    const prerequisites = await f.withHuman((actor) =>
      f.domains.content.platform.taskRunPrerequisites(actor, work, 1),
    );
    assert.equal(prerequisites.prepared, false);
    assert.equal(prerequisites.prerequisites[0]!.response, null);
    const responseCommandId = randomUUID();
    await f.withHuman((actor) =>
      f.domains.work.service.respondTask(actor, {
        commandId: responseCommandId,
        taskId: human,
        expectedRevision: 1,
        body: "同意，可以推进",
      }),
    );
    await c.reopen();
    await c.dispatcher.drain();
    assert.equal(c.records.size, 1);
    assert.equal(
      (await f.domains.content.platform.pendingTaskRuns(f.transport.identity()))
        .length,
      1,
    );
    assert.match(String(c.errors[0]), /无法连接 Morphz Runtime/);
    await c.reopen();
    await c.dispatcher.drain();
    assert.equal(c.records.size, 1);
    assert.equal(c.errors.length, 0);
    assert.equal(c.posted.length, 2);
    assert.deepEqual(c.posted[0], c.posted[1]);
    const request = c.posted[0]!;
    assert.equal(request.model_alias, "exact-model");
    assert.equal(request.reasoning_effort, "high");
    assert.ok(request.intent.includes(responseCommandId));
    assert.ok(
      !request.intent.includes("同意，可以推进"),
      "只传精确答复引用，不把答复正文当指令拼接",
    );
    assert.equal(
      (
        await f.withHuman((actor) =>
          f.domains.work.service.listTaskResponses(actor, {
            taskId: human,
            responseId: responseCommandId,
            limit: 1,
          }),
        )
      )[0]!.body,
      "同意，可以推进",
    );
    assert.equal(request.interval_seconds, 60);
    const control = async (action: "pause" | "resume" | "stop") => {
      const [run] = await c.runs(work);
      await f.withHuman((actor) =>
        f.domains.work.service.controlTaskRun(actor, {
          taskId: work,
          runNumber: 1,
          controlRevision: run!.bridge.controlRevision,
          action,
        }),
      );
      await c.dispatcher.drain();
    };
    await control("pause");
    assert.equal(c.records.get(request.id)!.status, "paused");
    await c.reopen();
    assert.equal((await c.runs(work))[0]!.observed.scheduleStatus, "paused");
    await control("resume");
    assert.equal(c.records.get(request.id)!.status, "queued");
    await assert.rejects(
      c.session().revisePlatformTask({
        commandId: randomUUID(),
        taskId: work,
        expectedRevision: 2,
        assigneeId: localAccess.actantId,
      }),
      /先停止|结束/,
    );
    await control("stop");
    assert.equal(c.records.get(request.id)!.status, "cancelled");
    const [stopped] = await c.runs(work);
    assert.equal(stopped!.bridge.stopRequested, false);
    await c.session().revisePlatformTask({
      commandId: randomUUID(),
      taskId: work,
      expectedRevision: 2,
      assigneeId: localAccess.actantId,
    });
    await c.session().revisePlatformTask({
      commandId: randomUUID(),
      taskId: work,
      expectedRevision: 3,
      assigneeId: "morphz-agent",
    });
    await c.reopen();
    const rerun = await c.start(work, 4);
    assert.equal(rerun.runNumber, 2, "复派必须使用新执行编号，不能覆盖原准入");
    assert.notEqual(rerun.request.id, admission.request.id);
    assert.equal(
      (
        await f.withHuman((actor) =>
          f.domains.work.service.taskVersion(actor, {
            taskId: work,
            revision: 2,
          }),
        )
      ).runRequested,
      1,
    );
    f.assertNoLegacyData();
  } finally {
    await c.close();
  }
});

test("关注的真实文档修订应产生持久来源事件，不伪装 Human 消息或另建定时安排", async () => {
  const c = await collaborationFixture(),
    f = c.f;
  try {
    const source = await c.session().createPlatformDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: f.projectId,
      title: "TEST 关注来源",
      markdown: "第一版原文",
    });
    const work = await c.create({ watchSourceIds: [source.contentId] });
    const admission = await c.start(work, 1);
    await c.dispatcher.drain();
    await c.reopen();
    await c.dispatcher.drain();
    assert.equal(c.records.size, 1);
    c.records.get(admission.request.id)!.status = "dispatched";
    const commandId = randomUUID();
    await c.session().revisePlatformDocument({
      commandId,
      contentId: source.contentId,
      expectedRevision: 1,
      title: "TEST 关注来源",
      markdown: "第二版原文",
    });
    await c.dispatcher.drain();
    await c.dispatcher.drain();
    await c.reopen();
    const run = (await c.runs(work))[0]!;
    assert.deepEqual(run.bridge.watchSourceIds, [source.contentId]);
    assert.equal(c.records.size, 1, "来源变化不能变成另一个定时 Schedule");
    assert.equal(
      f.transport.runtimeState(),
      null,
      "来源事件不能伪装 Human record-input",
    );
    assert.deepEqual(
      run.bridge.sourceCommandIds,
      [commandId],
      "来源修订尚未通过真实 Runtime Signal 形成持久触发记录",
    );
  } finally {
    await c.close();
  }
});
