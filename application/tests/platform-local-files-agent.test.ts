import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFiles } from "../packages/application/src/local-files.js";
import { PlatformAgentTools } from "../packages/application/src/platform-agent-tools.js";
import type { PlatformAgentDomain } from "../packages/application/src/platform-agent-tools.js";
import type {
  AgentToolArguments,
  HostInvocation,
  ToolScope,
} from "../packages/application/src/agent-tools.js";

test("Platform Agent reads only the actual input's local grants and revocation fences later calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-platform-local-agent-"));
  try {
    const work = join(root, "original");
    mkdirSync(work);
    writeFileSync(join(work, "note.txt"), "原位文本 v1");
    const files = new LocalFiles(join(root, "grants.json"), randomUUID());
    const human = { principalId: "human", actantId: "human-actant" };
    const directory = files.authorizeDirectory(
      work,
      "project-one",
      "conversation-one",
      human,
    );
    const localFile = files.select(
      join(work, "note.txt"),
      "project-one",
      human,
    );
    let source: Record<string, unknown> = {
      workspace_id: "project-one",
      author_actant_id: human.actantId,
      conversation_id: "conversation-one",
      localFile: localFile.reference,
      directories: [directory],
    };
    let archived = false;
    const tools = new PlatformAgentTools({
      authority: {
        withInvocation: async (
          _route: unknown,
          action: (
            actor: unknown,
            scope: unknown,
            identity: unknown,
          ) => Promise<unknown>,
        ) =>
          action(
            { credential: "verified-agent" },
            { projectId: "project-one", inputId: "input-one" },
            {
              principalId: human.principalId,
              humanActantId: human.actantId,
            },
          ),
      },
      inputForInvocation: async () => source,
      localFiles: files,
      content: {
        platform: {
          getProject: async () => ({
            deleted_at: null,
            archived_at: archived ? new Date().toISOString() : null,
          }),
        },
      },
    } as unknown as PlatformAgentDomain);
    const route = {
      context_id: "context-one",
      job_id: "job-one",
      tool_call_id: "call-one",
    } as HostInvocation;
    const scope = {
      platform: true,
      platformSource: "input",
      projectId: "project-one",
      inputId: "input-one",
    } as ToolScope;
    const invoke = (args: AgentToolArguments) => tools.call(route, scope, args);

    assert.equal(
      (
        (await invoke({ action: "local-file" } as AgentToolArguments)) as {
          text: string;
        }
      ).text,
      "原位文本 v1",
    );
    const read = (await invoke({
      action: "directory",
      directory: {
        grantId: directory.grantId,
        operation: "read",
        path: "note.txt",
      },
    } as AgentToolArguments)) as { reference: { version: string } };
    assert.ok(read.reference.version);
    const written = (await invoke({
      action: "directory",
      directory: {
        grantId: directory.grantId,
        operation: "write",
        path: "note.txt",
        text: "原位文本 v2",
        expectedVersion: read.reference.version,
      },
    } as AgentToolArguments)) as { written: boolean };
    assert.equal(written.written, true);
    await assert.rejects(
      invoke({ action: "local-file" } as AgentToolArguments),
      /已变化/,
      "the exact selected file version must not silently follow later writes",
    );
    archived = true;
    await assert.rejects(
      invoke({
        action: "directory",
        directory: {
          grantId: directory.grantId,
          operation: "write",
          path: "next.txt",
          text: "不应写入",
          expectedVersion: null,
        },
      } as AgentToolArguments),
      /已归档/,
    );
    archived = false;
    source = { ...source, conversation_id: "another-conversation" };
    await assert.rejects(
      invoke({
        action: "directory",
        directory: {
          grantId: directory.grantId,
          operation: "list",
          path: "",
        },
      } as AgentToolArguments),
      /对话/,
    );
    source = { ...source, conversation_id: "conversation-one" };
    files.revoke(directory.grantId, "project-one", human);
    await assert.rejects(
      invoke({
        action: "directory",
        directory: {
          grantId: directory.grantId,
          operation: "list",
          path: "",
        },
      } as AgentToolArguments),
      /未获授权/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
