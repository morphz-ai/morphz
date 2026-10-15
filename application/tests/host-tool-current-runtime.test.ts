import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { profileActualTransportFixture } from "./profile-actual-transport-fixture.js";
import { terminalApplication } from "../packages/core/src/applications.js";

test(
  "actual Runtime installs both exact Terminal descriptors and accepts unselected and selected inputs",
  { skip: process.env.MORPHZ_PROFILE_RUNTIME_E2E !== "1", timeout: 120_000 },
  async () => {
    const f = await profileActualTransportFixture();
    const projectId = "terminal_protocol_" + randomUUID().replaceAll("-", "");
    try {
      await f.client.call(
        "projects.create",
        { commandId: randomUUID(), projectId, title: "TEST Terminal 协议" },
        f.options,
      );
      for (const terminalId of [null, "terminal-reference-only"]) {
        const marker = "TEST_TERMINAL_PROTOCOL_" + randomUUID();
        const inputId = randomUUID();
        f.hold(marker);
        const since = f.requests.length;
        await f.client.call(
          "platform.message",
          {
            commandId: inputId,
            operation: {
              type: "record-input",
              dispatchMode: "parallel",
              projectId,
              artifactId: null,
              artifactRevision: null,
              selection: "",
              body: marker,
              targetActantId: "morphz-agent",
              application: {
                id: terminalApplication.id,
                version: terminalApplication.version,
                terminalId,
              },
            },
          },
          f.options,
        );
        const request = await f.waitRequest(marker, since);
        const tools = (request.tools as { function: { name: string } }[]).map(
          (tool) => tool.function.name,
        );
        assert.ok(tools.includes("terminal"));
        assert.ok(
          tools.includes("exec"),
          "ordinary exec remains a separate capability",
        );
        const inputs = f
          .sql<{ payload: string }>(
            "SELECT payload FROM events WHERE topic='chat/user_message' ORDER BY rowid DESC LIMIT 5",
          )
          .map((row) => JSON.parse(row.payload));
        const accepted = inputs.find(
          (input) => input.client_message_id === inputId,
        )?.session_io.request;
        assert.ok(
          accepted,
          "the real Runtime accepted this exact input, not a text fallback",
        );
        assert.equal(
          accepted.message.format.version,
          terminalId === null ? "13" : "14",
        );
        assert.deepEqual(accepted.message.content.value.value.terminal, {
          type: "object",
          value: {
            id:
              terminalId === null
                ? { type: "null" }
                : { type: "string", value: terminalId },
          },
        });
        f.release(marker);
      }
      assert.equal(
        f.sql("SELECT id FROM terminal_sessions").length,
        0,
        "input references do not create or operate a process",
      );
      assert.equal(f.realCalls, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "实际 Rust 请求只公布唯一 Host 定义，局部片段经真实 Job 保存且历史原文不变",
  { skip: process.env.MORPHZ_PROFILE_RUNTIME_E2E !== "1", timeout: 120_000 },
  async () => {
    const f = await profileActualTransportFixture();
    const projectId = "host_tool_" + randomUUID().replaceAll("-", "");
    const marker = "TEST_CURRENT_HOST_LOCAL_EDIT_" + randomUUID();
    try {
      await f.client.call(
        "projects.create",
        {
          commandId: randomUUID(),
          projectId,
          title: "TEST 唯一 Host 局部修订",
        },
        f.options,
      );
      const markdown =
        "# TEST 原文\r\n\r\n菜贩剥下的老叶落在筐边。\n" +
        "其余正文保持原样。".repeat(1000);
      const created = (await f.client.call(
        "documents.create",
        {
          commandId: randomUUID(),
          objectId: "document_" + randomUUID().replaceAll("-", ""),
          projectId,
          title: "TEST 真实 Runtime 精确修订",
          markdown,
        },
        f.options,
      )) as { contentId: string };
      f.hold(marker);
      const inputId = randomUUID();
      await f.client.call(
        "platform.message",
        {
          commandId: inputId,
          operation: {
            type: "record-input",
            projectId,
            conversationId: "conversation_" + randomUUID().replaceAll("-", ""),
            newConversation: { title: marker },
            artifactId: created.contentId,
            artifactRevision: 1,
            selection: "剥下",
            body: marker,
            targetActantId: "morphz-agent",
          },
        },
        f.options,
      );
      const first = await f.waitRequest(marker);
      const definitions = (
        first.tools as {
          function: {
            name: string;
            parameters: { properties: Record<string, unknown> };
          };
        }[]
      ).map((tool) => tool.function);
      const host = definitions.filter((definition) =>
        definition.name.startsWith("host_morphz"),
      );
      assert.deepEqual(
        host.map((definition) => definition.name),
        ["host_morphz"],
      );
      assert.ok(host[0]!.parameters.properties.edits);
      const args = {
        action: "revise-document",
        artifactId: created.contentId,
        revision: 1,
        edits: [{ old_text: "剥下", new_text: "摘下" }],
      };
      assert.ok(JSON.stringify(args).length < 250);
      const since = f.requests.length;
      f.releaseWithTool(marker, "host_morphz", args);
      const resumed = await f.waitRequest(marker, since);
      assert.deepEqual(
        (resumed.tools as { function: { name: string } }[])
          .filter((tool) => tool.function.name.startsWith("host_morphz"))
          .map((tool) => tool.function.name),
        ["host_morphz"],
      );
      const current = (await f.client.call(
        "documents.read",
        { contentId: created.contentId },
        f.options,
      )) as { markdown: string; revision: number; title: string };
      assert.equal(current.revision, 2);
      assert.equal(current.markdown, markdown.replace("剥下", "摘下"));
      assert.equal(current.title, "TEST 真实 Runtime 精确修订");
      const original = (await f.client.call(
        "documents.read",
        { contentId: created.contentId, revision: 1 },
        f.options,
      )) as { markdown: string };
      assert.equal(original.markdown, markdown);
      const jobs = f.sql<{
        tool_name: string;
        request_json: string;
        status: string;
        result_event_id: string | null;
      }>(
        "SELECT tool_name,request_json,status,result_event_id FROM execution_jobs WHERE tool_name LIKE 'host_morphz%'",
      );
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]!.tool_name, "host_morphz");
      assert.equal(jobs[0]!.status, "succeeded");
      assert.ok(jobs[0]!.result_event_id);
      assert.ok(jobs[0]!.request_json.includes('"old_text":"剥下"'));
      assert.equal(jobs[0]!.request_json.includes(markdown), false);
      assert.equal(f.realCalls, 0);
      console.log(
        JSON.stringify({
          evidence: "current-host-actual-runtime",
          host_definitions: host.length,
          patch_characters: JSON.stringify(args).length,
          original_characters: markdown.length,
          physical_jobs: jobs.length,
          upstream_model_requests: f.realCalls,
        }),
      );
    } finally {
      await f.close();
    }
  },
);
