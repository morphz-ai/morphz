import assert from "node:assert/strict";
import test from "node:test";
import { jobSchema } from "../packages/core/src/execution.js";
import { executionCommand } from "../apps/web/src/features/execution/execution-command.js";

const job = (request: unknown, tool_name = "exec") =>
  jobSchema.parse({
    id: "TEST-job",
    revision: 1,
    session_id: "TEST-session",
    context_id: "TEST-context",
    thread_id: "TEST-thread",
    target_id: "local",
    tool_name,
    request,
    status: "succeeded",
    created_at: "2026-10-14T00:00:00Z",
    updated_at: "2026-10-14T00:00:00Z",
  });

test("command preview uses only the exact command parameter without inferring intent or outcomes", () => {
  const value = job({
    command: "opencli browser inspect --tab 4",
    _morphz_execution_route: { token: "not displayed" },
  });
  const before = structuredClone(value);
  assert.equal(
    executionCommand(value)?.value,
    "opencli browser inspect --tab 4",
  );
  assert.deepEqual(value, before);
  assert.equal(
    executionCommand(job({ command: "wrong carrier" }, "read")),
    null,
  );
  assert.equal(
    executionCommand(
      job({ explanation: "not the command", command: ["not a string"] }),
    ),
    null,
  );
  assert.equal(
    executionCommand(job({ cmd: "git status" }, "exec_command"))?.value,
    "git status",
  );
});

test("known credential forms are masked in previews without modifying execution or exposing route metadata", () => {
  const command = `API_KEY='fixture-private-one' curl --token "fixture-private-two" https://user:fixture-private-three@example.test\n-H 'Authorization: Bearer fixture-private-four'\n-H 'Cookie: fixture-private-five'`;
  const value = job({ command });
  const shown = executionCommand(value)!.value;
  for (const secret of ["one", "two", "three", "four", "five"])
    assert.equal(shown.includes(`fixture-private-${secret}`), false);
  assert.ok(shown.includes("curl"));
  assert.equal((value.request as { command: string }).command, command);
});

test("large and multiline commands remain bounded with explicit truncation and preserve Unicode", () => {
  const value = executionCommand(
    job({ command: "echo " + "🙂".repeat(20_000) }),
  )!;
  assert.ok(value.value.length <= 12_000);
  assert.ok(value.preview.length <= 600);
  assert.equal(value.truncated, true);
  assert.equal(value.expandable, true);
  assert.equal(/[\uD800-\uDBFF]$/.test(value.preview), false);
  assert.equal(
    executionCommand(job({ command: "echo first\necho second" }))?.expandable,
    true,
  );
});
