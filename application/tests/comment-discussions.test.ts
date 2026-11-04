import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  CommentDiscussionController,
  type DiscussionCommand,
  type DiscussionTransport,
} from "../packages/core/src/comment-discussion-controller.js";
import { discussionTimelinePage } from "../packages/core/src/native-comment-discussions.js";
import type {
  CommentDiscussionMessage,
  CommentDiscussionPage,
} from "../packages/core/src/comment-discussions.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const message = (
  id: string,
  kind: CommentDiscussionMessage["kind"] = "reply",
  text = id,
): CommentDiscussionMessage => ({
  id,
  eventId: id,
  rootId: "root",
  createdAt: `2026-11-04T00:00:${id.replace(/\D/g, "").padStart(2, "0").slice(-2) || "00"}.000001Z`,
  kind,
  text,
});
function fixture(overrides: Partial<DiscussionTransport<string>> = {}) {
  const calls: { kind: string; id: string; before?: unknown }[] = [];
  let sequence = 0;
  const controller = new CommentDiscussionController<string>(
    {
      list: async (quote, before) => {
        calls.push({ kind: "list", id: quote, before });
        return { items: [], nextCursor: null };
      },
      read: async (id) => ({ quote: id, publish: false }),
      history: async (id, before) => {
        calls.push({ kind: "history", id, before });
        return { id, messages: [], nextCursor: null };
      },
      send: async (command) => {
        calls.push({ kind: "send", id: command.commandId });
      },
      ...overrides,
    },
    () => `command-${++sequence}`,
  );
  return { controller, calls };
}
test("opening is immediate, idle is silent, close retires reads and keeps the submitted message", async () => {
  const receipt = deferred<void>();
  const { controller, calls } = fixture({ send: () => receipt.promise });
  const id = controller.open("selected A");
  controller.draft("Question A");
  const sending = controller.send();
  assert.equal(controller.active?.messages[0]?.text, "Question A");
  assert.equal(controller.active?.messages[0]?.id, id);
  controller.close();
  receipt.resolve();
  await sending;
  await setImmediate();
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["list"],
  );
  assert.equal(controller.views.get(id)?.submitted, true);
  controller.reopen(id);
  await setImmediate();
  assert.equal(calls.filter((call) => call.kind === "history").length, 1);
  assert.equal(
    controller.active?.messages[0]?.text,
    "Question A",
    "an older empty page must not erase the optimistic input",
  );
  const count = calls.length;
  await setImmediate();
  await setImmediate();
  assert.equal(calls.length, count, "healthy idle must not read");
  controller.dispose();
});
test("two passages send independently with frozen publication and separate drafts", async () => {
  const a = deferred<void>(),
    commands: DiscussionCommand<string>[] = [];
  const { controller } = fixture({
    send: (command) => {
      commands.push(command);
      return commands.length === 1 ? a.promise : Promise.resolve();
    },
  });
  const first = controller.open("A");
  controller.publish(true);
  controller.draft("question A");
  const sendingA = controller.send();
  const second = controller.open("B");
  controller.draft("question B");
  await controller.send();
  assert.equal(commands.length, 2);
  assert.notEqual(first, second);
  assert.deepEqual(
    commands.map(({ quote, publish, first }) => ({ quote, publish, first })),
    [
      { quote: "A", publish: true, first: true },
      { quote: "B", publish: false, first: true },
    ],
  );
  assert.equal(controller.views.get(first)?.sending, true);
  assert.equal(controller.active?.draft, "");
  a.resolve();
  await sendingA;
  controller.reopen(first);
  controller.draft("follow up A");
  await controller.send();
  assert.equal(commands[2]?.discussionId, first);
  assert.equal(commands[2]?.first, false);
  assert.notEqual(commands[2]?.commandId, first);
  controller.dispose();
});
test("unknown outcomes preserve the exact command, then native acceptance wins over a late failure", async () => {
  const commands: DiscussionCommand<string>[] = [],
    send = deferred<void>();
  const { controller } = fixture({
    send: async (command) => {
      commands.push(command);
      if (commands.length === 1) throw new Error("transport lost");
      await send.promise;
    },
  });
  const id = controller.open("A");
  controller.draft("original");
  await controller.send();
  assert.equal(controller.active?.pending?.commandId, id);
  controller.draft("a newer draft");
  const retry = controller.send();
  assert.equal(commands[1], commands[0]);
  assert.equal(commands[1]?.body, "original");
  controller.receive(id, [message(id, "input", "original")]);
  send.reject(new Error("late transport failure"));
  await retry;
  assert.equal(controller.active?.pending, undefined);
  assert.equal(controller.active?.error, "");
  assert.equal(controller.active?.draft, "a newer draft");
  controller.dispose();
});
test("late invalidations are coalesced while busy and a closed owner cannot publish", async () => {
  const first = deferred<CommentDiscussionPage>(),
    second = deferred<CommentDiscussionPage>();
  let reads = 0;
  const { controller } = fixture({
    history: async (id) => {
      reads++;
      return reads === 1
        ? first.promise
        : reads === 2
          ? second.promise
          : { id, messages: [], nextCursor: null };
    },
  });
  const id = controller.open("A");
  controller.draft("q");
  await controller.send();
  controller.invalidate(id);
  controller.invalidate(id);
  assert.equal(reads, 1);
  first.resolve({ id, messages: [message("1")], nextCursor: null });
  await setImmediate();
  assert.equal(reads, 2);
  controller.close();
  second.resolve({ id, messages: [message("2")], nextCursor: null });
  await setImmediate();
  assert(!controller.views.get(id)?.messages.some((item) => item.id === "2"));
  controller.dispose();
});
test("permission/source failure does not turn an existing discussion into a new command", async () => {
  let sends = 0;
  const read = deferred<{ quote: string; publish: boolean }>();
  const { controller } = fixture({
    read: () => read.promise,
    send: async () => {
      sends++;
    },
  });
  controller.open("source");
  const opening = controller.select("existing");
  controller.draft("draft retained");
  await controller.send();
  assert.equal(sends, 0);
  read.reject(new Error("source grant revoked"));
  await opening;
  await controller.send();
  assert.equal(sends, 0);
  assert.equal(controller.active?.draft, "draft retained");
  assert.match(controller.active?.error ?? "", /grant revoked/);
  controller.dispose();
});
test("older cursor stays accepted while a reconnect gap gets its own requested page", async () => {
  const head = { createdAt: "2026-11-04T00:00:10.000001Z", id: "10" };
  const gap = { createdAt: "2026-11-04T00:00:30.000001Z", id: "30" };
  let reads = 0;
  const requested: unknown[] = [];
  const { controller } = fixture({
    history: async (id, before) => {
      requested.push(before);
      reads++;
      if (reads === 1)
        return {
          id,
          messages: [message("10"), message("11")],
          nextCursor: head,
        };
      if (reads === 2)
        return { id, messages: [message("1"), message("2")], nextCursor: null };
      if (reads === 3)
        return {
          id,
          messages: [message("30"), message("31")],
          nextCursor: gap,
        };
      return { id, messages: [message("11"), message("12")], nextCursor: head };
    },
  });
  const id = controller.open("A");
  controller.draft("q");
  await controller.send();
  await setImmediate();
  await controller.older();
  assert.equal(controller.active?.nextCursor, null);
  controller.invalidate(id);
  await setImmediate();
  assert.deepEqual(controller.active?.nextCursor, gap);
  await controller.older();
  assert.equal(
    controller.active?.nextCursor,
    null,
    "bridge to retained messages must not reset the exhausted older cursor",
  );
  assert.deepEqual(requested, [null, head, null, gap]);
  assert.equal(
    new Set(controller.active?.messages.map((item) => item.id)).size,
    controller.active?.messages.length,
  );
  controller.dispose();
});
test("native display keeps authored input separate from the quote wrapper and excludes private inference", () => {
  const event = {
    id: "event",
    timestamp: "2026-11-04T00:00:00Z",
    topic: "chat/user_message",
    payload: {
      text: "quoted wrapper",
      session_io: {
        request: {
          client_metadata: {
            type: "object",
            value: {
              kind: { type: "string", value: "morphz.dashboard-discussion" },
              body: { type: "string", value: "authored question" },
            },
          },
        },
      },
    },
  };
  const page = discussionTimelinePage(
    "discussion",
    [
      {
        entry_id: "input",
        root_turn_id: "root",
        visible_at: event.timestamp,
        display_kind: "input",
        event,
        root_event: null,
        input_event: null,
      },
      {
        entry_id: "private",
        root_turn_id: "root",
        visible_at: event.timestamp,
        display_kind: "reply",
        event: {
          ...event,
          topic: "chat/reply",
          payload: { text: "private", model_output_visibility: "internal" },
        },
        root_event: null,
        input_event: null,
      },
    ],
    null,
  );
  assert.deepEqual(
    page.messages.map((item) => item.text),
    ["authored question"],
  );
});

test("a requested source restores an unknown command across reload without changing its model or touching other drafts", async () => {
  const { discussionDraftStore, parseDiscussionDraft } =
    await import("../packages/core/src/comment-discussion-drafts.js");
  const storage = new Map<string, string>();
  const reads: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => {
        reads.push(key);
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  try {
    const journal = discussionDraftStore<string>(
      "actor:window:session",
      (quote) => quote,
      (raw) =>
        parseDiscussionDraft<string>(
          raw,
          (value) => {
            assert.equal(typeof value, "string");
            return value as string;
          },
          (envelope, draft) => {
            assert.deepEqual(envelope, {
              model: "model-at-first-click",
              body: draft.pending?.body,
            });
          },
        ),
    );
    let model = "model-at-first-click";
    const commands: DiscussionCommand<string>[] = [];
    const transport: DiscussionTransport<string> = {
      list: async () => ({ items: [], nextCursor: null }),
      read: async () => ({ quote: "A", publish: false }),
      history: async (id) => ({ id, messages: [], nextCursor: null }),
      prepare: (command) => ({ model, body: command.body }),
      send: async (command) => {
        commands.push(command);
        if (commands.length === 1) throw new Error("lost receipt");
      },
    };
    const first = new CommentDiscussionController(
      transport,
      undefined,
      journal,
    );
    first.open("A");
    first.draft("my question");
    await first.send();
    const commandId = first.active!.id;
    first.open("B");
    first.draft("do not overwrite me");
    first.dispose();
    model = "changed-later";
    const before = reads.length;
    const next = new CommentDiscussionController(transport, undefined, journal);
    assert.equal(reads.length, before, "no startup registry read");
    next.open("A");
    assert.equal(next.active?.id, commandId);
    assert.equal(next.active?.draft, "my question");
    await next.send();
    assert.deepEqual(commands[1], commands[0]);
    next.open("B");
    assert.equal(next.active?.draft, "do not overwrite me");
    assert.equal(
      storage.size,
      1,
      "accepted A clears only its own journal entry",
    );
    next.dispose();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("storage failure blocks the network mutation, retaining the same retry identity", async () => {
  let sends = 0,
    available = false;
  const transport: DiscussionTransport<string> = {
    list: async () => ({ items: [], nextCursor: null }),
    read: async () => ({ quote: "A", publish: false }),
    history: async (id) => ({ id, messages: [], nextCursor: null }),
    prepare: () => ({ model: "frozen" }),
    send: async () => {
      sends++;
    },
  };
  const controller = new CommentDiscussionController(
    transport,
    () => "fixed-command",
    {
      load: () => null,
      save: () => {
        if (!available) throw new Error("storage unavailable");
      },
    },
  );
  controller.open("A");
  controller.draft("q");
  await controller.send();
  assert.equal(sends, 0);
  assert.equal(controller.active?.pending?.commandId, "fixed-command");
  available = true;
  await controller.send();
  assert.equal(sends, 1);
  assert.equal(controller.active?.pending, undefined);
  controller.dispose();
});

test("oversized messages advance older history and load content only on explicit request with a version fence", async () => {
  let reads = 0;
  const boundary = {
    ...message("large"),
    entryId: "entry",
    contentOmitted: true,
    nextOffset: 0,
  };
  const olderCursor = { createdAt: boundary.createdAt, id: "entry" };
  const { controller } = fixture({
    history: async (id) => ({
      id,
      messages: [boundary],
      nextCursor: olderCursor,
    }),
    readMessage: async (_id, message, offset) => {
      reads++;
      return {
        eventId: message.eventId,
        text: offset ? " tail" : "first",
        nextOffset: offset ? null : 5,
      };
    },
  });
  controller.open("A");
  controller.draft("q");
  await controller.send();
  await setImmediate();
  assert.equal(reads, 0);
  assert.deepEqual(controller.active?.nextCursor, olderCursor);
  await controller.openMessage("large");
  assert.equal(
    controller.active?.messages.find((m) => m.id === "large")?.text,
    "first",
  );
  await controller.openMessage("large");
  assert.equal(
    controller.active?.messages.find((m) => m.id === "large")?.text,
    "first tail",
  );
  controller.invalidate(controller.activeId!);
  await setImmediate();
  assert.equal(
    controller.active?.messages.find((m) => m.id === "large")?.text,
    "first tail",
    "head refresh cannot erase explicitly loaded content",
  );
  controller.dispose();
});

test("typing during an exact discussion read is retained under the accepted source, never a placeholder source", async () => {
  const read = deferred<{ quote: string; publish: boolean }>(),
    saved: { quote: string; draft: string }[] = [];
  const { controller: unused } = fixture();
  unused.dispose();
  const controller = new CommentDiscussionController<string>(
    {
      list: async () => ({ items: [], nextCursor: null }),
      read: () => read.promise,
      history: async (id) => ({ id, messages: [], nextCursor: null }),
      send: async () => {},
    },
    () => "draft",
    { load: () => null, save: (value) => saved.push(value) },
  );
  controller.open("placeholder source");
  const selecting = controller.select("accepted-discussion");
  controller.draft("typed immediately");
  assert.equal(saved.length, 0);
  read.resolve({ quote: "accepted source", publish: false });
  await selecting;
  assert.equal(controller.active?.draft, "typed immediately");
  assert.equal(saved.at(-1)?.quote, "accepted source");
  controller.dispose();
});

test("a reused input identity with a different body cannot erase an unknown draft", async () => {
  const { controller } = fixture({
    send: async () => {
      throw new Error("conflict");
    },
  });
  const id = controller.open("A");
  controller.draft("original question");
  await controller.send();
  controller.receive(id, [message(id, "input", "different accepted body")]);
  assert.equal(controller.active?.pending?.body, "original question");
  assert.equal(controller.active?.draft, "original question");
  controller.dispose();
});
