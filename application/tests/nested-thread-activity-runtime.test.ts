import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { objectToolName } from "../packages/core/src/application-names.js";
import { executionSnapshotSchema } from "../packages/core/src/execution.js";
import type { ExecutionActivity } from "../packages/core/src/conversation.js";
import { profileActualTransportFixture } from "./profile-actual-transport-fixture.js";

/** Actual isolated Rust admission, schedule_tx, parent/child records, physical
 * Host tools, Jobs, receipt annotations, private queries and Platform RPC. Only
 * normal provider responses are deterministic; no paid model/user data. */
test(
  "真实Rust父Thread派生两个child及孙Thread，主活动归组且子root可独立打开，四份步骤注解不串线",
  {
    skip: process.env.MORPHZ_NESTED_ACTIVITY_RUNTIME_E2E !== "1",
    timeout: 120_000,
  },
  async (t) => {
    let f!: Awaited<ReturnType<typeof profileActualTransportFixture>>;
    let mainId: string | undefined;
    const rounds = new Map<string, number>();
    const titles = new Map<string, string>();
    const choices: Array<{ threadId: string; name: string }> = [];
    const errors: string[] = [];
    f = await profileActualTransportFixture({
      deterministicTool: (request) => {
        try {
          const text = request.messages
            .map((m) =>
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content),
            )
            .join("\n");
          const start = text.indexOf("(current-activation");
          assert.ok(
            start >= 0,
            "Actual request lacks current activation focus",
          );
          const match =
            /\(root-turn\s+\(id\s+("(?:[^"\\]|\\.)*"|[^\s)]+)\)/.exec(
              text.slice(start),
            );
          assert.ok(match, "Actual request lacks exact root-turn ID");
          const rootId = match[1]!.startsWith('"')
            ? JSON.parse(match[1]!)
            : match[1]!;
          const current = f.sql<{
            id: string;
            parent_thread_id: string | null;
          }>(
            "SELECT id, parent_thread_id FROM threads WHERE root_turn_id = ?",
            rootId,
          )[0];
          assert.ok(
            current,
            "Actual current Thread must exist before provider selection",
          );
          mainId ??= current.id;
          const title =
            current.id === mainId
              ? "TEST 导出文档并准备封面"
              : f.sql<{ intent: string }>(
                  "SELECT intent FROM schedules WHERE thread_id = ? ORDER BY rowid LIMIT 1",
                  current.id,
                )[0]?.intent;
          assert.ok(title);
          titles.set(current.id, title);
          const round = rounds.get(current.id) ?? 0;
          rounds.set(current.id, round + 1);
          assert.ok(
            round < 8,
            "Normal execution must not add unbounded annotation/repair rounds",
          );
          const annotation = { title, progress: "TEST 正在读取实际资料" };
          const choose = (name: string, args: unknown) => {
            choices.push({ threadId: current.id, name });
            return { name, arguments: args };
          };
          if (round === 0)
            return choose(objectToolName, {
              action: "profile",
              profile: { action: "read" },
              _annotations: {
                execution: annotation,
                intent: title + "：读取资料",
              },
            });
          if (
            round === 1 &&
            (current.id === mainId || title.includes("TEST 子任务一"))
          )
            return choose("schedule_tx", {
              operations:
                current.id === mainId
                  ? [
                      {
                        op: "spawn",
                        client_id: "one",
                        intent: "TEST 子任务一：整理正文",
                        lifetime: "attached",
                      },
                      {
                        op: "spawn",
                        client_id: "two",
                        intent: "TEST 子任务二：准备封面",
                        lifetime: "attached",
                      },
                    ]
                  : [
                      {
                        op: "spawn",
                        client_id: "grand",
                        intent: "TEST 孙任务：核对正文",
                        lifetime: "attached",
                      },
                    ],
              group: { policy: "all" },
              _annotations: {
                execution: { title, progress: "TEST 已分派子任务" },
                intent: "TEST 分派真实子Thread",
              },
            });
          const children = f.sql<{ status: string }>(
            "SELECT status FROM threads WHERE parent_thread_id = ?",
            current.id,
          );
          if (children.some((child) => child.status === "open"))
            return choose("no_reply", { mode: "wait", wait_secs: 3600 });
          const refs = request.messages.flatMap((message) => {
            if (message.role !== "tool" || typeof message.content !== "string")
              return [];
            try {
              const receipt = JSON.parse(message.content);
              return typeof receipt.observation_ref === "string"
                ? [receipt.observation_ref]
                : [];
            } catch {
              return [];
            }
          });
          return choose("reply", {
            content: title + "已完成",
            annotations: {
              execution: { title, result: title + "：已读取资料并完成" },
              ...(refs.length
                ? {
                    observations: [
                      { ref: refs.at(-1), result: title + "：资料读取完成" },
                    ],
                  }
                : {}),
            },
          });
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
          return {
            name: "reply",
            arguments: {
              content: "TEST fixture failed",
              annotations: {
                execution: {
                  title: "TEST fixture failed",
                  result: "TEST fixture failed",
                },
              },
            },
          };
        }
      },
    });
    const projectId = "nested_" + randomUUID().replaceAll("-", ""),
      conversationId = "conversation_" + randomUUID().replaceAll("-", "");
    const scope = { projectId, conversationId, artifactId: null };
    const activity = async () => {
      const response = (await f.client.call(
        "runtime.navigation",
        { projectId, conversationId, refreshActivity: true },
        f.options,
      )) as { runtime: { activity: ExecutionActivity } };
      return response.runtime.activity.threads.filter(
        (thread) =>
          thread.projectId === projectId && thread.kind === "execution",
      );
    };
    try {
      await f.client.call(
        "projects.create",
        {
          commandId: randomUUID(),
          projectId,
          title: "TEST 嵌套活动实际Rust验收",
        },
        f.options,
      );
      await f.client.call(
        "platform.message",
        {
          commandId: randomUUID(),
          operation: {
            type: "record-input",
            ...scope,
            artifactRevision: null,
            selection: "",
            body: "TEST_NESTED 实际多子Thread只读活动",
            targetActantId: "morphz-agent",
            newConversation: { title: "TEST 嵌套活动" },
          },
        },
        f.options,
      );
      let threads: ExecutionActivity["threads"] = [];
      for (let attempt = 0; attempt < 500; attempt++) {
        threads = await activity();
        if (
          errors.length ||
          (threads.length === 4 &&
            threads.every((thread) => thread.lifecycle === "completed"))
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.deepEqual(
        errors,
        [],
        "Provider fixture must classify actual current Thread focus",
      );
      assert.equal(
        threads.length,
        4,
        JSON.stringify({ threads, rounds: [...rounds] }),
      );
      assert.ok(
        threads.every((thread) => thread.lifecycle === "completed"),
        JSON.stringify(threads),
      );
      const parent = threads.find((thread) => thread.id === mainId)!;
      assert.ok(parent);
      assert.equal(
        threads.filter((thread) => thread.parentThreadId === parent.id).length,
        2,
      );
      const childOne = threads.find((thread) =>
        thread.title.includes("TEST 子任务一"),
      )!;
      const grand = threads.find(
        (thread) => thread.parentThreadId === childOne.id,
      )!;
      assert.ok(grand);
      assert.equal(new Set(threads.map((thread) => thread.rootId)).size, 4);
      assert.equal(new Set(threads.map((thread) => thread.sessionId)).size, 1);
      assert.equal(new Set(threads.map((thread) => thread.contextId)).size, 1);
      assert.ok(threads.every((thread) => thread.inputId === parent.inputId));
      const detail = executionSnapshotSchema.parse(
        await f.client.call(
          "execution.snapshot",
          { ...scope, inputId: parent.inputId, threadId: parent.id },
          f.options,
        ),
      );
      assert.equal(detail.threads?.length, 4);
      assert.equal(detail.threadsTruncated, false);
      assert.equal(
        detail.jobs.length,
        4,
        "Logical spawn/no_reply/reply must not become fake physical Job cards",
      );
      for (const thread of threads) {
        const selected = executionSnapshotSchema.parse(
          await f.client.call(
            "execution.snapshot",
            { ...scope, inputId: parent.inputId, threadId: thread.id },
            f.options,
          ),
        );
        assert.ok(selected.jobs.some((job) => job.thread_id === thread.id));
        assert.equal(
          selected.threads?.[0]?.rootId,
          thread.rootId,
          "Selected child uses its real distinct root",
        );
        const own = detail.jobs.filter((job) => job.thread_id === thread.id);
        assert.equal(own.length, 1);
        assert.equal(
          own[0]!.status,
          "succeeded",
          JSON.stringify({
            job: own[0],
            snapshot: await f.runtime
              .inputEvidenceReader()
              .readThread(thread.sessionId, thread.id),
          }),
        );
        assert.equal(
          own[0]!.annotation?.intent,
          titles.get(thread.id) + "：读取资料",
        );
        assert.ok(thread.summary?.includes(titles.get(thread.id)!));
        assert.equal(thread.annotationProtocol, "v2");
        assert.ok(own[0]!.result_event_id);
      }
      const sibling = threads.find(
        (thread) =>
          thread.parentThreadId === parent.id && thread.id !== childOne.id,
      )!;
      const childView = executionSnapshotSchema.parse(
        await f.client.call(
          "execution.snapshot",
          { ...scope, inputId: parent.inputId, threadId: childOne.id },
          f.options,
        ),
      );
      assert.deepEqual(
        new Set(childView.threads?.map((thread) => thread.id)),
        new Set([childOne.id, grand.id]),
      );
      assert.ok(childView.jobs.every((job) => job.thread_id !== sibling.id));
      assert.equal(f.realCalls, 0);
      // Every actual provider request is one ordinary work/resume turn, with
      // annotations carried on that turn's existing tool, never a separate
      // annotation evaluation. Child completion wakes can interleave, so the
      // mechanical bound is 8 turns per spawning Thread plus 2 per leaf.
      assert.equal(f.requests.length, choices.length);
      assert.equal(
        choices.filter((choice) => choice.name === objectToolName).length,
        4,
      );
      assert.equal(
        choices.filter((choice) => choice.name === "schedule_tx").length,
        2,
      );
      assert.equal(
        choices.filter((choice) => choice.name === "reply").length,
        4,
      );
      assert.ok(
        choices.every((choice) =>
          [objectToolName, "schedule_tx", "no_reply", "reply"].includes(
            choice.name,
          ),
        ),
      );
      assert.ok(
        f.requests.length <= 20,
        JSON.stringify({
          requests: f.requests.length,
          rounds: [...rounds],
          choices,
        }),
      );
      assert.equal(
        (await f.read()).agent.revision,
        0,
        "Only real read-only Host tools were used",
      );
      t.diagnostic(
        JSON.stringify({
          validation: "actual-isolated-rust-nested-threads",
          realProviderCalls: f.realCalls,
          requests: f.requests.length,
          normalTools: Object.fromEntries(
            [objectToolName, "schedule_tx", "no_reply", "reply"].map((name) => [
              name,
              choices.filter((choice) => choice.name === name).length,
            ]),
          ),
          threadCount: detail.threads!.length,
          distinctRoots: new Set(detail.threads!.map((thread) => thread.rootId))
            .size,
          physicalJobCount: detail.jobs.length,
          physicalJobStatuses: detail.jobs.map((job) => job.status),
          threadRounds: [...rounds.values()].sort(),
        }),
      );
    } finally {
      await f.close();
    }
  },
);
