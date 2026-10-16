import test from "node:test";
import assert from "node:assert/strict";
import { TerminalInput } from "../apps/web/src/features/terminal/terminal-input.js";
import { terminalScreenFrame } from "../apps/web/src/features/terminal/terminal-screen.js";
import {
  terminalScreenSchema,
  type TerminalCommand,
} from "../packages/core/src/terminal.js";
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
test("keyboard batches UTF-8 and serializes immutable revision receipts without replay", async () => {
  const commands: TerminalCommand[] = [],
    errors: string[] = [];
  let active = 0,
    max = 0;
  const input = new TerminalInput(
    4,
    async (command) => {
      commands.push(structuredClone(command));
      max = Math.max(max, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return {
        command_id: command.command_id,
        terminal_id: "terminal",
        revision: command.expected_revision + 1,
        input_status: "submitted",
        command_completion: "not_asserted",
      };
    },
    () => {},
    (text) => errors.push(text),
  );
  const text = "中文😀".repeat(1000) + "\r";
  input.input(text);
  await settle();
  assert.equal(
    commands
      .map((c) => (c.action.type === "input" ? c.action.data : ""))
      .join(""),
    text,
  );
  assert.equal(max, 1);
  assert.deepEqual(errors, []);
  assert.ok(
    commands.every(
      (c, i) =>
        c.expected_revision === 4 + i &&
        c.action.type === "input" &&
        Buffer.byteLength(c.action.data) <= 4096,
    ),
  );
  assert.equal(
    new Set(commands.map((c) => c.command_id)).size,
    commands.length,
  );
  input.dispose();
});
test("unknown input receipts retain pending bytes and stop typing and automatic retries", async () => {
  const sent: TerminalCommand[] = [],
    errors: string[] = [];
  const input = new TerminalInput(
    1,
    async (command) => {
      sent.push(command);
      throw Error("network lost after possible physical write");
    },
    () => {},
    (message) => errors.push(message),
  );
  input.input("printf 'no duplicate'\r");
  await settle();
  input.input("must not execute");
  input.resize(24, 80);
  input.observe(99);
  await settle();
  assert.equal(sent.length, 1);
  assert.match(errors[0]!, /不会自动重发/);
  assert.equal(input.pending(), "printf 'no duplicate'\r");
  input.dispose();
});
test("disposing the original terminal cancels queued input rather than sending to a new selection", async () => {
  let calls = 0;
  const input = new TerminalInput(
    1,
    async () => {
      calls++;
      throw Error("not reached");
    },
    () => {},
    () => {},
  );
  input.input("unsubmitted\r");
  input.dispose();
  await settle();
  assert.equal(calls, 0);
});
test("hiding a terminal preserves unsent text without sending it after reopening", async () => {
  let calls = 0;
  const failures: string[] = [];
  const input = new TerminalInput(
    1,
    async () => {
      calls++;
      throw Error("not reached");
    },
    () => {},
    (text) => failures.push(text),
  );
  input.input("still typing");
  input.setEnabled(false);
  await settle();
  input.setEnabled(true);
  input.input("must not replace original");
  await settle();
  assert.equal(calls, 0);
  assert.equal(input.pending(), "still typing");
  assert.match(failures[0]!, /不会在后台继续发送/);
  input.dispose();
});
test("display frame keeps palette identity and truecolor but strips untrusted control sequences", () => {
  const base = { bold: false, italic: false, underline: false, inverse: false };
  const screen = terminalScreenSchema.parse({
    sequence: 1,
    rows: 4,
    cols: 80,
    lines: [
      [
        { ...base, text: "index", fg: "#c94343", fg_index: 1 },
        { ...base, text: "rgb", fg: "#c94343" },
        { ...base, text: "\x1b]52;c;clipboard\x07<script>literal</script>" },
      ],
    ],
    text: "",
    cursor: [1, 0],
    cursor_visible: true,
    application_cursor: true,
    bracketed_paste: true,
    alternate_screen: false,
    scrollback: 0,
    previous_available: false,
  });
  const frame = terminalScreenFrame(screen);
  assert.ok(frame.includes("\x1b[38;5;1mindex"));
  assert.ok(frame.includes("\x1b[38;2;201;67;67mrgb"));
  assert.ok(!frame.includes("\x1b]52"));
  assert.ok(frame.includes("<script>literal</script>"));
  assert.ok(frame.endsWith("\x1b[?1h\x1b[?2004h\x1b[?25h"));
});
test("repeated layout observations do not resubmit an in-flight or already acknowledged PTY size", async () => {
  const commands: TerminalCommand[] = [];
  let input: TerminalInput;
  input = new TerminalInput(
    1,
    async (command) => {
      commands.push(command);
      input.resize(38, 91);
      return {
        command_id: command.command_id,
        terminal_id: "terminal",
        revision: command.expected_revision + 1,
        input_status: "submitted",
        command_completion: "not_asserted",
      };
    },
    () => {},
    () => {},
  );
  input.observe(1, 24, 80);
  input.resize(38, 91);
  await settle();
  input.resize(38, 91);
  input.observe(1, 24, 80); // A late pre-ack screen must not undo known size.
  input.resize(38, 91);
  await settle();
  assert.equal(commands.length, 1);
  input.dispose();
});
